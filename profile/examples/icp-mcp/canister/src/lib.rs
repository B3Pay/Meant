//! An example canister ready for ICP MCP (D-061): a small token, TOK, whose sends are exactly-once, with every answer
//! an agent reads generated from one Candid Profile (`../icp-mcp.profile.json`):
//!
//!   - `get_api_doc`: the guide ICP MCP reads before a call, `../api-doc.md` (written by `candid-profile api-doc`);
//!   - `icrc21_canister_call_consent_message`: the ICRC-21 consent message for any call, from the resolved form
//!     (`../icp-mcp.resolved.json`) through `candid-profile-consent`;
//!   - the custom sections `icp:public candid:service` and `icp:public candid:profile`: the interface and the profile
//!     itself, which a consumer reads in one certified `read_state` (spec section 8.1).
//!
//! `node ../build.mjs` regenerates the two generated files; scripts/icp-mcp-example.test.mjs checks they are in step,
//! and packages/consent/pocketic/test/icp-mcp.test.mjs runs the canister on PocketIC.
//!
//! It talks to the system API directly (no canister SDK), as `packages/consent/rust/examples/sns_validator.rs` does,
//! so it needs nothing beyond the consent crate's own pinned dependencies. State is kept in memory only: an example,
//! not a ledger (an upgrade starts it again). The token itself is `token.rs`, which `cargo test` runs on the host.

// On the host only the unit tests use the token; the canister that does is wasm32 only.
#[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
mod token;

#[cfg(target_arch = "wasm32")]
mod canister {
    use std::cell::{OnceCell, RefCell};

    use candid::{CandidType, Deserialize, Principal};
    use candid_profile_consent::{handle_consent_request, ConsentContext};
    use serde_json::{Map, Value};

    use crate::token::{SendArgs, State, Tokens, INITIAL_E8S};

    // ---------------------------------------------------------------------------------------- what it serves

    #[used]
    #[link_section = "icp:public candid:service"]
    static CANDID_SERVICE: [u8; include_bytes!("../../icp-mcp.did").len()] = *include_bytes!("../../icp-mcp.did");

    #[used]
    #[link_section = "icp:public candid:profile"]
    static CANDID_PROFILE: [u8; include_bytes!("../../icp-mcp.profile.json").len()] = *include_bytes!("../../icp-mcp.profile.json");

    const API_DOC: &str = include_str!("../../api-doc.md");
    const RESOLVED: &str = include_str!("../../icp-mcp.resolved.json");

    #[derive(CandidType)]
    struct Standard {
        name: &'static str,
        url: &'static str,
    }

    thread_local! {
        static STATE: RefCell<State> = RefCell::new(State::default());
        static RESOLVED_FORM: OnceCell<Value> = const { OnceCell::new() };
    }

    // ------------------------------------------------------------------------------------------ system API

    #[link(wasm_import_module = "ic0")]
    extern "C" {
        fn msg_arg_data_size() -> usize;
        fn msg_arg_data_copy(dst: usize, offset: usize, size: usize);
        fn msg_caller_size() -> usize;
        fn msg_caller_copy(dst: usize, offset: usize, size: usize);
        fn msg_reply_data_append(src: usize, size: usize);
        fn msg_reply();
        fn time() -> u64;
        fn trap(src: usize, size: usize) -> !;
    }

    fn arg() -> Vec<u8> {
        // SAFETY: the system API copies exactly `size` bytes into a buffer of that size.
        unsafe {
            let size = msg_arg_data_size();
            let mut bytes = vec![0u8; size];
            msg_arg_data_copy(bytes.as_mut_ptr() as usize, 0, size);
            bytes
        }
    }

    fn caller() -> Principal {
        // SAFETY: as for `arg`.
        unsafe {
            let size = msg_caller_size();
            let mut bytes = vec![0u8; size];
            msg_caller_copy(bytes.as_mut_ptr() as usize, 0, size);
            Principal::from_slice(&bytes)
        }
    }

    fn reply(bytes: &[u8]) {
        // SAFETY: the system API reads `bytes` in place.
        unsafe {
            msg_reply_data_append(bytes.as_ptr() as usize, bytes.len());
            msg_reply();
        }
    }

    fn fail(message: &str) -> ! {
        // SAFETY: the system API reads `message` in place and does not return.
        unsafe { trap(message.as_ptr() as usize, message.len()) }
    }

    fn decode<T: for<'de> Deserialize<'de> + CandidType>(bytes: &[u8]) -> T {
        candid::decode_one(bytes).unwrap_or_else(|e| fail(&format!("the argument does not decode: {e}")))
    }

    fn encode<T: CandidType>(value: &T) -> Vec<u8> {
        candid::encode_one(value).unwrap_or_else(|e| fail(&format!("the reply does not encode: {e}")))
    }

    // ------------------------------------------------------------------------------------------- the methods

    #[export_name = "canister_init"]
    extern "C" fn init() {
        let installer = caller();
        STATE.with(|s| s.borrow_mut().mint(installer, INITIAL_E8S));
    }

    #[export_name = "canister_query balance"]
    extern "C" fn balance() {
        let owner: Principal = decode(&arg());
        let e8s = STATE.with(|s| s.borrow().balance(&owner));
        reply(&encode(&Tokens { e8s }));
    }

    #[export_name = "canister_update send"]
    extern "C" fn send() {
        let args: SendArgs = decode(&arg());
        let from = caller();
        // SAFETY: `time` has no preconditions.
        let now = unsafe { time() };
        let result = STATE.with(|s| s.borrow_mut().send(from, &args, now));
        reply(&encode(&result));
    }

    #[export_name = "canister_query get_api_doc"]
    extern "C" fn get_api_doc() {
        reply(&encode(&API_DOC));
    }

    #[export_name = "canister_update icrc21_canister_call_consent_message"]
    extern "C" fn icrc21_canister_call_consent_message() {
        let request = arg();
        let response = RESOLVED_FORM.with(|r| {
            let resolved = r.get_or_init(|| serde_json::from_str(RESOLVED).unwrap_or_else(|e| fail(&format!("the resolved form: {e}"))));
            // TOK's decimals and symbol are literals in its profile, so there are no dynamic refs to fill.
            handle_consent_request(&request, &ConsentContext::new(resolved, &Map::new()))
        });
        reply(&response);
    }

    #[export_name = "canister_query icrc10_supported_standards"]
    extern "C" fn icrc10_supported_standards() {
        let standards = [
            Standard { name: "ICRC-10", url: "https://github.com/dfinity/ICRC/blob/main/ICRCs/ICRC-10/ICRC-10.md" },
            Standard {
                name: "ICRC-21",
                url: "https://github.com/dfinity/wg-identity-authentication/blob/main/topics/ICRC-21/icrc_21_consent_msg.md",
            },
        ];
        reply(&encode(&standards.as_slice()));
    }
}
