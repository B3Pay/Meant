//! A minimal SNS validator canister built on this crate, for the hypothetical dapp of `test/fixtures/sns-dapp.did`.
//!
//! Each `validate_<method>` takes the payload of an `ExecuteGenericNervousSystemFunction` proposal that targets
//! `<method>` and replies `variant { Ok : text; Err : text }`, the text rendered from the dapp's profile. To use it, a
//! DAO registers a generic nervous system function whose validator is this canister and `validate_<method>`.
//!
//! It talks to the system API directly (no canister SDK), so the crate's own dependencies are all it needs:
//!
//!   cargo build --release --target wasm32-unknown-unknown --example sns_validator
//!   node check-canister.mjs        # runs the SNS goldens through the wasm, with the system API stubbed in Node
//!
//! The methods are queries, so that anyone can also preview a rendering for free. SNS governance calls them as the
//! validator all the same (an inter-canister call runs a query in replicated mode): observed on PocketIC with the SNS
//! governance wasm (`../pocketic/`). Each call writes one line with `debug_print`: the method, the payload size and the
//! instructions spent so far, parsing the resolved form included (a query keeps no state, so it parses it every time).

#[cfg(target_arch = "wasm32")]
mod canister {
    use std::cell::OnceCell;

    use candid_profile_consent::handle_sns_validator_call;
    use serde_json::{Map, Value};

    #[link(wasm_import_module = "ic0")]
    extern "C" {
        fn msg_arg_data_size() -> usize;
        fn msg_arg_data_copy(dst: usize, offset: usize, size: usize);
        fn msg_reply_data_append(src: usize, size: usize);
        fn msg_reply();
        fn performance_counter(counter_type: u32) -> u64;
        fn debug_print(src: usize, size: usize);
    }

    thread_local! {
        /// The resolved form of the dapp with its profile, parsed once.
        static RESOLVED: OnceCell<Value> = const { OnceCell::new() };
    }

    fn validate(method: &str) {
        // SAFETY: the system API copies at most `size` bytes into a buffer of that size, and reads `reply` in place.
        unsafe {
            let size = msg_arg_data_size();
            let mut payload = vec![0u8; size];
            msg_arg_data_copy(payload.as_mut_ptr() as usize, 0, size);
            let reply = RESOLVED.with(|r| {
                let resolved = r.get_or_init(|| {
                    serde_json::from_str(include_str!("../../test/sns-golden/resolved/dapp.resolved.json")).unwrap_or(Value::Null)
                });
                // The dapp's profile has no dynamic refs; a ledger-backed one would fill these at install time.
                handle_sns_validator_call(resolved, method, &payload, &Map::new())
            });
            let line = format!("{method}: payload {size} bytes, {} instructions", performance_counter(0));
            debug_print(line.as_ptr() as usize, line.len());
            msg_reply_data_append(reply.as_ptr() as usize, reply.len());
            msg_reply();
        }
    }

    #[export_name = "canister_query validate_pay_grant"]
    extern "C" fn validate_pay_grant() {
        validate("pay_grant")
    }

    #[export_name = "canister_query validate_set_ledger"]
    extern "C" fn validate_set_ledger() {
        validate("set_ledger")
    }

    #[export_name = "canister_query validate_set_claim_window"]
    extern "C" fn validate_set_claim_window() {
        validate("set_claim_window")
    }

    #[export_name = "canister_query validate_set_fee_bps"]
    extern "C" fn validate_set_fee_bps() {
        validate("set_fee_bps")
    }

    #[export_name = "canister_query validate_pause"]
    extern "C" fn validate_pause() {
        validate("pause")
    }

    /// A method the dapp's interface does not have: every payload is `Err` (`E_METHOD_UNKNOWN`).
    #[export_name = "canister_query validate_upgrade_protocol"]
    extern "C" fn validate_upgrade_protocol() {
        validate("upgrade_protocol")
    }
}
