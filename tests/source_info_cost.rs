//! Source-info collection must cost in proportion to the source, not to the
//! source times its declarations.
//!
//! Issue #252: collecting provenance lowered every record, variant, func and
//! service type through `candid_parser`'s `ast_to_type`, which clones the
//! whole `TypeEnv` on every call. The work was (those types) x (declarations):
//! 8,000 one-record declarations took 35 s to compile with source info and
//! 0.6 s without, and an input over `source_string_bytes` paid all of it
//! before being refused.
//!
//! Wall-clock is not a gate here (#39), so this suite measures what the
//! clones cost and nothing else perturbs: the bytes the compiler allocates in
//! total. Doubling the declarations of a flat bundle doubles that total when
//! the collection is linear, and quadruples it when every type clones the
//! environment. The assertion is a ratio, not a magic number.

use meant::{compile_did_with_options, CompileOptions};
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

/// `declarations` independent one-record types: every one of them is a type
/// the collection lowers, and every one is a declaration in the environment.
fn flat_records(declarations: usize) -> String {
    (0..declarations)
        .map(|index| format!("type R{index} = record {{ a{index} : nat; b : text }};\n"))
        .collect()
}

fn allocated_bytes(source: &str, include_source_info: bool) -> usize {
    let options = CompileOptions {
        include_source_info,
    };
    ALLOCATED_BYTES.store(0, Ordering::Relaxed);
    ENABLED.store(true, Ordering::Relaxed);
    let compilation = compile_did_with_options(source, options);
    ENABLED.store(false, Ordering::Relaxed);
    let compilation = compilation.unwrap();
    assert_eq!(compilation.source_info().is_some(), include_source_info);
    ALLOCATED_BYTES.load(Ordering::Relaxed)
}

#[test]
fn source_info_collection_allocates_in_proportion_to_the_source() {
    let _guard = measuring();
    let small = flat_records(500);
    let large = flat_records(1_000);

    let with_small = allocated_bytes(&small, true);
    let with_large = allocated_bytes(&large, true);
    let without_small = allocated_bytes(&small, false);
    let without_large = allocated_bytes(&large, false);

    // Linear work doubles; one environment clone per type quadruples. Three is
    // the midpoint, far from both.
    let ratio = with_large as f64 / with_small as f64;
    assert!(
        ratio < 3.0,
        "doubling 500 declarations multiplied source-info allocation by {ratio:.2} \
         ({with_small} -> {with_large} bytes): the collection is superlinear"
    );

    // Provenance is a sidecar on the same graph, so it may cost a bounded
    // multiple of the compilation without it, never a multiple that grows
    // with the bundle.
    let overhead_small = with_small as f64 / without_small as f64;
    let overhead_large = with_large as f64 / without_large as f64;
    assert!(
        overhead_large < overhead_small * 1.5,
        "source info cost {overhead_small:.2}x the plain compile at 500 declarations \
         and {overhead_large:.2}x at 1,000: its overhead grows with the bundle"
    );
}
