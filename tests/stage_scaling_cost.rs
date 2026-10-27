//! Every stage after parsing must allocate in proportion to its input.
//!
//! Issue #252 was a quadratic stage nobody had measured: source-info
//! collection cloned the type environment once per type, and 8,000
//! declarations took 35 s. The timing suite never saw it, because no corpus
//! case was big enough, and no timing on a shared runner could have gated it
//! anyway (#39). `tests/source_info_cost.rs` pins that one stage; this suite
//! pins the others, as issue #256 asks.
//!
//! The measurement is the one #39 allows to fail CI: the bytes a counting
//! global allocator sees, which are deterministic for given code and
//! dependencies. Each test runs one stage on an input of `N` and of `2 N` and
//! asserts the ratio. Linear work doubles the bytes; work that repeats a
//! linear step per item quadruples them. The bound sits at three, far from
//! both, so a constant overhead or an `N log N` sort cannot trip it and a
//! per-item clone of a growing collection cannot pass it.
//!
//! What this bounds is allocation, not work. A stage that turned quadratic
//! without allocating more, through a nested scan or repeated lookups, would
//! pass. Copying per item, which is how #252 went quadratic, cannot.
//!
//! Two input shapes, because a stage can be linear in one and quadratic in the
//! other: `many` is `N` one-record declarations used by `N` service methods,
//! and `wide` is one record of `N` fields beside one variant of `N` arms.

use meant::{
    compile_did, compile_did_with_options, Compilation, CompileOptions, Contract, ContractEnvelope,
    Limits, RawSourceInfo, RuntimeContext, SourceInfo,
};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard};

/// The counters are process globals and the harness runs tests in parallel,
/// so only one test may measure at a time.
static MEASURING: Mutex<()> = Mutex::new(());

fn measuring() -> MutexGuard<'static, ()> {
    MEASURING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct CountingAllocator;

static ENABLED: AtomicBool = AtomicBool::new(false);
static ALLOCATED_BYTES: AtomicUsize = AtomicUsize::new(0);

#[global_allocator]
static GLOBAL_ALLOCATOR: CountingAllocator = CountingAllocator;

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() && ENABLED.load(Ordering::Relaxed) {
            ALLOCATED_BYTES.fetch_add(layout.size(), Ordering::Relaxed);
        }
        pointer
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() && ENABLED.load(Ordering::Relaxed) {
            ALLOCATED_BYTES.fetch_add(layout.size(), Ordering::Relaxed);
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) };
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let new_pointer = unsafe { System.realloc(pointer, layout, new_size) };
        if !new_pointer.is_null() && ENABLED.load(Ordering::Relaxed) {
            ALLOCATED_BYTES.fetch_add(new_size, Ordering::Relaxed);
        }
        new_pointer
    }
}

/// The bytes `stage` allocates. Its result is dropped after counting stops,
/// so only the work is measured, not the release of what it built.
fn allocated_bytes<T>(stage: impl FnOnce() -> T) -> usize {
    ALLOCATED_BYTES.store(0, Ordering::Relaxed);
    ENABLED.store(true, Ordering::Relaxed);
    let output = stage();
    ENABLED.store(false, Ordering::Relaxed);
    drop(output);
    ALLOCATED_BYTES.load(Ordering::Relaxed)
}

const SMALL: usize = 500;
const LARGE: usize = 2 * SMALL;

/// Linear work doubles; one repeated linear step per item quadruples. Three is
/// the midpoint, far from both.
const BOUND: f64 = 3.0;

/// `n` independent one-record declarations, each the argument of its own
/// service method.
fn many(n: usize) -> String {
    let mut source: String = (0..n)
        .map(|index| format!("type R{index} = record {{ a{index} : nat; b : text }};\n"))
        .collect();
    source.push_str("service : {\n");
    for index in 0..n {
        source.push_str(&format!("  m{index} : (R{index}) -> ();\n"));
    }
    source.push_str("}\n");
    source
}

/// One record of `n` fields and one variant of `n` arms.
fn wide(n: usize) -> String {
    let fields: String = (0..n).map(|index| format!("f{index} : nat; ")).collect();
    let arms: String = (0..n).map(|index| format!("v{index}; ")).collect();
    format!(
        "type Wide = record {{ {fields}}};\ntype Arms = variant {{ {arms}}};\n\
         service : {{ m : (Wide, Arms) -> () }}\n"
    )
}

/// A named input shape: builds the `.did` source for `n` items.
type Shape = (&'static str, fn(usize) -> String);

const SHAPES: [Shape; 2] = [("many", many), ("wide", wide)];

/// Run `stage` on each shape at `SMALL` and `LARGE` and assert the ratio of
/// the bytes it allocates. `prepare` builds the stage's input outside the
/// measurement.
fn assert_linear<I, T>(name: &str, prepare: impl Fn(&str) -> I, stage: impl Fn(&I) -> T) {
    let _guard = measuring();
    for (shape, source) in SHAPES {
        let small = prepare(&source(SMALL));
        let large = prepare(&source(LARGE));
        let small_bytes = allocated_bytes(|| stage(&small));
        let large_bytes = allocated_bytes(|| stage(&large));
        assert!(
            small_bytes > 0,
            "{name}/{shape}: the stage allocated nothing"
        );
        let ratio = large_bytes as f64 / small_bytes as f64;
        assert!(
            ratio < BOUND,
            "{name}/{shape}: doubling the input from {SMALL} to {LARGE} multiplied the bytes \
             allocated by {ratio:.2} ({small_bytes} -> {large_bytes}); the stage is superlinear"
        );
    }
}

fn contract(source: &str) -> Contract {
    compile_did(source)
        .unwrap_or_else(|error| panic!("{error:#?}"))
        .contract()
        .clone()
}

#[test]
fn compiling_without_source_info_is_linear() {
    // Parsing, type checking, lowering and canonicalization, end to end.
    assert_linear(
        "compile",
        |source| source.to_string(),
        |source| {
            compile_did_with_options(
                source,
                CompileOptions {
                    include_source_info: false,
                },
            )
            .unwrap()
        },
    );
}

#[test]
fn canonicalization_is_linear() {
    assert_linear("canonicalize", contract, |contract| {
        contract.canonicalize().unwrap()
    });
}

#[test]
fn structural_validation_is_linear() {
    assert_linear("validate", contract, |contract| {
        contract.validate().unwrap()
    });
}

#[test]
fn loading_a_contract_document_is_linear() {
    // Bounded decode, structural validation and the identity recomputation.
    assert_linear(
        "Contract::from_json_with_limits",
        |source| contract(source).to_json_pretty().unwrap(),
        |json| Contract::from_json_with_limits(json, &Limits::default()).unwrap(),
    );
}

#[test]
fn building_and_loading_an_envelope_is_linear() {
    assert_linear(
        "ContractEnvelope::to_json_pretty_with_limits",
        contract,
        |contract| {
            ContractEnvelope::new(contract.clone())
                .to_json_pretty_with_limits(&Limits::default())
                .unwrap()
        },
    );
    assert_linear(
        "ContractEnvelope::from_json_with_limits",
        |source| {
            ContractEnvelope::new(contract(source))
                .to_json_pretty_with_limits(&Limits::default())
                .unwrap()
        },
        |json| ContractEnvelope::from_json_with_limits(json, &Limits::default()).unwrap(),
    );
}

#[test]
fn validating_source_info_is_linear() {
    assert_linear(
        "SourceInfo::try_from_raw_with_context",
        |source| {
            let compilation = compile_did(source).unwrap();
            let raw: RawSourceInfo = serde_json::from_value(
                serde_json::to_value(compilation.source_info().unwrap()).unwrap(),
            )
            .unwrap();
            (raw, compilation.contract().clone())
        },
        |(raw, contract)| {
            SourceInfo::try_from_raw_with_context(raw.clone(), contract, &RuntimeContext::default())
                .unwrap()
        },
    );
}

#[test]
fn loading_a_compilation_rederives_its_source_info_linearly() {
    // The loader recompiles the embedded bundle to authenticate the sidecar.
    assert_linear(
        "Compilation::from_json_with_limits",
        |source| {
            compile_did(source)
                .unwrap()
                .to_json_pretty_with_limits(&Limits::default())
                .unwrap()
        },
        |json| Compilation::from_json_with_limits(json, &Limits::default()).unwrap(),
    );
}
