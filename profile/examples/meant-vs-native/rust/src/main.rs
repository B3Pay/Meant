//! Reads one case per line from stdin, `<decimals>\t<symbol>\t<input>`, and prints one line per case:
//! `ok\t<base units>` or `err\t<code>\t<message>`. The units table compares these with @meantjs/format.
use std::io::{self, BufRead, Write};

use meant_format::{AmountFormat, IntType};

fn main() {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    for line in io::stdin().lock().lines() {
        let line = line.expect("stdin");
        let mut parts = line.splitn(3, '\t');
        let (decimals, symbol, input) = (parts.next().unwrap(), parts.next().unwrap(), parts.next().unwrap_or(""));
        let format = AmountFormat::new(decimals.parse().expect("decimals"))
            .with_symbol(symbol)
            .expect("symbol")
            .with_candid(IntType::Nat);
        match format.parse(input) {
            Ok(units) => writeln!(out, "ok\t{units}"),
            Err(e) => writeln!(out, "err\t{}\t{}", e.code().as_str(), e.message()),
        }
        .expect("stdout");
    }
}
