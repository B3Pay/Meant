//! A stand-in for the hypothetical dapp of `test/fixtures/sns-dapp.did`, for the PocketIC test (`../pocketic/`) only:
//! the methods a DAO calls through a generic nervous system function record the call and reply with no value, and
//! `calls` returns what was recorded, so the test can check that governance sent the exact payload it showed voters.
//!
//!   cargo build --release --target wasm32-unknown-unknown --example sns_target

#[cfg(target_arch = "wasm32")]
mod canister {
    use std::cell::RefCell;

    #[link(wasm_import_module = "ic0")]
    extern "C" {
        fn msg_arg_data_size() -> usize;
        fn msg_arg_data_copy(dst: usize, offset: usize, size: usize);
        fn msg_caller_size() -> usize;
        fn msg_caller_copy(dst: usize, offset: usize, size: usize);
        fn msg_reply_data_append(src: usize, size: usize);
        fn msg_reply();
    }

    /// One call, as `calls` returns it: `record { method : text; caller : blob; arg : blob }`.
    #[derive(candid::CandidType)]
    struct Call {
        method: String,
        caller: Vec<u8>,
        arg: Vec<u8>,
    }

    thread_local! {
        /// In call order.
        static CALLS: RefCell<Vec<Call>> = const { RefCell::new(Vec::new()) };
    }

    fn reply(bytes: &[u8]) {
        // SAFETY: the system API reads `bytes` in place.
        unsafe {
            msg_reply_data_append(bytes.as_ptr() as usize, bytes.len());
            msg_reply();
        }
    }

    fn record(method: &str) {
        // SAFETY: the system API copies at most `size` bytes into buffers of that size.
        let (caller, arg) = unsafe {
            let mut caller = vec![0u8; msg_caller_size()];
            msg_caller_copy(caller.as_mut_ptr() as usize, 0, caller.len());
            let mut arg = vec![0u8; msg_arg_data_size()];
            msg_arg_data_copy(arg.as_mut_ptr() as usize, 0, arg.len());
            (caller, arg)
        };
        CALLS.with(|c| c.borrow_mut().push(Call { method: method.to_string(), caller, arg }));
        reply(b"DIDL\x00\x00");
    }

    #[export_name = "canister_update pay_grant"]
    extern "C" fn pay_grant() {
        record("pay_grant")
    }

    #[export_name = "canister_update set_ledger"]
    extern "C" fn set_ledger() {
        record("set_ledger")
    }

    #[export_name = "canister_update set_claim_window"]
    extern "C" fn set_claim_window() {
        record("set_claim_window")
    }

    #[export_name = "canister_update set_fee_bps"]
    extern "C" fn set_fee_bps() {
        record("set_fee_bps")
    }

    #[export_name = "canister_update pause"]
    extern "C" fn pause() {
        record("pause")
    }

    /// `() -> (vec record { method : text; caller : blob; arg : blob }) query`
    #[export_name = "canister_query calls"]
    extern "C" fn calls() {
        let bytes = CALLS.with(|c| candid::encode_one(&*c.borrow()).unwrap_or_default());
        reply(&bytes);
    }
}
