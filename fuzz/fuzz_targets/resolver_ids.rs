#![no_main]

use libfuzzer_sys::fuzz_target;
use meant::SourceId;

fuzz_target!(|data: &[u8]| {
    if let Ok(id) = std::str::from_utf8(data) {
        let _ = SourceId::parse(id);
    }
});
