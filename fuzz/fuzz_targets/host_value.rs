#![no_main]

use libfuzzer_sys::fuzz_target;
use meant::{HostValue, Limits};

fuzz_target!(|data: &[u8]| {
    if let Ok(json) = std::str::from_utf8(data) {
        let _ = HostValue::from_json_with_limits(json, &Limits::default());
    }
});
