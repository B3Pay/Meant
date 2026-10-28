import { test } from "node:test";
import assert from "node:assert/strict";
import { CODES, FormatError, VALUE_TAGS, formatterFor } from "../src/index.mjs";
import { firstWithTag, loadFixture, nodeAt, positions } from "./helpers/fixtures.mjs";

const hex = (b) => Buffer.from(b).toString("hex");
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof FormatError, `expected FormatError, got ${e}`);
    return e.code;
  }
  assert.fail("expected a FormatError, but nothing was thrown");
};

const LEDGERS = [
  { decimals: 8, symbol: "TKA" },
  { decimals: 6, symbol: "TKB" },
  { decimals: 18, symbol: "TKC" },
];
const refsFor = (l) => ({ "query:icrc1_decimals": l.decimals, "query:icrc1_symbol": l.symbol });
const OWNER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const NOW = 1791547200123456789n; // 2026-10-09T12:00:00.123456789Z

test("formatterFor: every value tag in the fixtures gets a formatter that works", () => {
  const seen = new Set();
  for (const name of ["icrc1", "icrc2", "tokens-example"]) {
    const fixture = loadFixture(name);
    for (const { path, node } of positions(fixture)) {
      const tagged = VALUE_TAGS.filter((t) => node.tags?.[t]);
      for (const ledger of LEDGERS) {
        const f = formatterFor(node, { refs: refsFor(ledger) });
        if (tagged.length === 0) {
          assert.equal(f, null, `${name} ${path}: no value tag, no formatter`);
          continue;
        }
        assert.ok(f, `${name} ${path}`);
        assert.equal(f.tag, tagged[0]);
        seen.add(f.tag);
        switch (f.tag) {
          case "amount": {
            const v = f.parse(`1.5 ${f.args.symbol ?? ""}`.trim());
            assert.equal(v, (15n * 10n ** BigInt(f.args.decimals - 1)).toString(), `${name} ${path}`);
            assert.equal(f.display(v), `1.5${f.args.symbol ? ` ${f.args.symbol}` : ""}`);
            break;
          }
          case "timestamp": {
            const v = f.parse("2026-10-09T12:00:00Z");
            assert.equal(f.display(v), "2026-10-09T12:00:00Z");
            assert.equal(f.parse("+PT24H", { now: 1791547200000000000n }), f.parse("2026-10-10T12:00:00Z"));
            break;
          }
          case "account": {
            const a = f.parse(OWNER);
            assert.deepEqual(a, { owner: OWNER, subaccount: null });
            assert.equal(f.display(a), OWNER);
            break;
          }
          case "subaccount":
            assert.equal(f.display(f.parse("#7")), "#7");
            break;
          case "bytes":
            assert.equal(f.display(f.parse("memo")), "memo");
            break;
        }
      }
    }
  }
  assert.deepEqual([...seen].sort(), ["account", "amount", "bytes", "subaccount", "timestamp"], "duration does not occur in the fixtures; it is covered below");
});

test("formatterFor: the ICRC-1 transfer arguments, end to end, on three ledgers", () => {
  const fx = loadFixture("icrc1");
  for (const l of LEDGERS) {
    const refs = refsFor(l);
    const amount = formatterFor(nodeAt(fx, "icrc1_transfer.arg0.amount"), { refs });
    const fee = formatterFor(nodeAt(fx, "icrc1_transfer.arg0.fee"), { refs });
    assert.equal(amount.tag, "amount");
    assert.equal(amount.candid, "nat");
    assert.deepEqual({ ...amount.args }, { decimals: l.decimals, symbol: l.symbol });
    assert.equal(amount.parse(`7.5 ${l.symbol.toLowerCase()}`), (75n * 10n ** BigInt(l.decimals - 1)).toString());
    assert.equal(fee.parse("0.0001"), (10n ** BigInt(l.decimals - 4)).toString());
    // the wrong ledger's symbol is a unit error caught at the boundary
    const other = LEDGERS.find((x) => x !== l).symbol;
    assert.deepEqual(amount.safeParse(`1 ${other}`).error.code, CODES.SYMBOL_MISMATCH);
  }
  const to = formatterFor(nodeAt(fx, "icrc1_transfer.arg0.to"));
  assert.deepEqual({ ...to.args }, { encoding: "icrc1" });
  const created = formatterFor(nodeAt(fx, "icrc1_transfer.arg0.created_at_time"), { now: NOW });
  assert.deepEqual({ ...created.args }, { unit: "ns", epoch: "unix" });
  assert.equal(created.parse("+PT24H"), (NOW + 86_400_000_000_000n).toString(), "default now from the options");
  assert.equal(created.parse("+PT24H", { now: 0n }), "86400000000000", "per-call now wins");
  const memo = formatterFor(nodeAt(fx, "icrc1_transfer.arg0.memo"));
  assert.equal(hex(memo.parse("hi")), "6869");
  const sub = formatterFor(nodeAt(fx, "icrc1_transfer.arg0.from_subaccount"));
  assert.equal(hex(sub.parse("#1")), "00".repeat(31) + "01");
});

test("formatterFor: the tokens example has literal decimals and a nat64 amount", () => {
  const fx = loadFixture("tokens-example");
  const node = firstWithTag(fx, "amount", "nat64");
  const f = formatterFor(node);
  assert.deepEqual({ ...f.args }, { decimals: 8, symbol: "TOK" });
  assert.equal(f.parse("184467440737.09551615 TOK"), "18446744073709551615");
  assert.equal(code(() => f.parse("184467440737.09551616")), CODES.RANGE, "nat64 bound, not silently wrapped");
  assert.equal(f.display("18446744073709551615"), "184467440737.09551615 TOK");
});

test("formatterFor: 18-decimal amounts above 2^64 base units survive (ckETH-class tokens)", () => {
  const f = formatterFor(nodeAt(loadFixture("icrc1"), "icrc1_transfer.arg0.amount"), { refs: { "query:icrc1_decimals": 18, "query:icrc1_symbol": "ckETH" } });
  assert.equal(f.parse("123.456789012345678901 ckETH"), "123456789012345678901");
  assert.equal(f.display("123456789012345678901"), "123.456789012345678901 ckETH");
  assert.equal(f.display(f.parse("0.000000000000000001")), "0.000000000000000001 ckETH");
});

test("formatterFor: a position without a value tag has no formatter", () => {
  const fx = loadFixture("icrc1");
  assert.equal(formatterFor({ candid: "nat" }), null);
  assert.equal(formatterFor({ candid: "nat", tags: {} }), null);
  assert.equal(formatterFor({ candid: "text", tags: { describe: { args: { label: "x" } }, ui: { args: {} } } }), null);
  assert.equal(formatterFor(nodeAt(fx, "icrc1_transfer.arg0")), null, "the record itself");
});

test("formatterFor: dynamic values must be supplied by the caller", () => {
  const node = nodeAt(loadFixture("icrc1"), "icrc1_transfer.arg0.amount");
  assert.equal(code(() => formatterFor(node)), CODES.REF_UNRESOLVED);
  assert.equal(code(() => formatterFor(node, { refs: { "query:icrc1_decimals": 8 } })), CODES.REF_UNRESOLVED, "symbol is still missing");
  assert.equal(code(() => formatterFor(node, { refs: { "query:icrc1_symbol": "X" } })), CODES.REF_UNRESOLVED, "decimals is missing");
  // a ref value is validated like a literal
  assert.equal(code(() => formatterFor(node, { refs: { "query:icrc1_decimals": 300, "query:icrc1_symbol": "X" } })), CODES.ARG);
  assert.equal(code(() => formatterFor(node, { refs: { "query:icrc1_decimals": "eight", "query:icrc1_symbol": "X" } })), CODES.ARG);
  assert.equal(code(() => formatterFor(node, { refs: { "query:icrc1_decimals": 8, "query:icrc1_symbol": "ICP\n" } })), CODES.ARG);
  // decimals as a bigint or decimal string (how a decoded nat8 may arrive)
  assert.equal(formatterFor(node, { refs: { "query:icrc1_decimals": 8n, "query:icrc1_symbol": "X" } }).args.decimals, 8);
  assert.equal(formatterFor(node, { refs: { "query:icrc1_decimals": "8", "query:icrc1_symbol": "X" } }).args.decimals, 8);
  // refs are looked up by key, not inherited from Object.prototype
  assert.equal(code(() => formatterFor(node, { refs: Object.create({ "query:icrc1_decimals": 8, "query:icrc1_symbol": "X" }) })), CODES.REF_UNRESOLVED);
  // an amount without a symbol shows the number alone
  const noSymbol = formatterFor({ candid: "nat", tags: { amount: { args: { decimals: 2 } } } });
  assert.equal(noSymbol.display("150"), "1.5");
  assert.equal(code(() => noSymbol.parse("1.5 USD")), CODES.SYMBOL_MISMATCH);
});

test("formatterFor: `now` and `caller` are not valid in a formatting tag", () => {
  const node = { candid: "nat", tags: { amount: { args: { decimals: { from: "now" } } } } };
  assert.equal(code(() => formatterFor(node)), CODES.ARG);
  assert.equal(code(() => formatterFor({ candid: "nat", tags: { amount: { args: { decimals: { from: "caller" } } } } })), CODES.ARG);
  assert.equal(code(() => formatterFor({ candid: "nat", tags: { amount: { args: { decimals: { nope: 1 } } } } })), CODES.ARG);
});

test("formatterFor: duration, hex and base64 positions", () => {
  const dur = formatterFor({ candid: "nat64", tags: { duration: { args: { unit: "s" } } } });
  assert.equal(dur.parse("PT24H"), "86400");
  assert.equal(dur.parse("P1D"), "86400");
  assert.equal(dur.display("86400"), "P1D");
  assert.equal(dur.safeParse("P1Y").error.code, CODES.CALENDAR_UNIT);
  const h = formatterFor({ candid: "blob", tags: { bytes: { args: { encoding: "hex", max_len: 4 } } } });
  assert.deepEqual({ ...h.args }, { encoding: "hex", max_len: 4 });
  assert.equal(hex(h.parse("0xdeadbeef")), "deadbeef");
  assert.equal(h.display(Uint8Array.from([1, 2])), "0x0102");
  assert.equal(h.safeParse("0xdeadbeef00").error.code, CODES.MAX_LEN);
  const b = formatterFor({ candid: "blob", tags: { bytes: { args: { encoding: "base64" } } } });
  assert.equal(b.display(Uint8Array.from([102, 111, 111])), "Zm9v");
});

test("formatterFor: safeParse and safeDisplay return results instead of throwing", () => {
  const f = formatterFor({ candid: "nat", tags: { amount: { args: { decimals: 8, symbol: "ICP" } } } });
  assert.deepEqual(f.safeParse("1.5"), { ok: true, value: "150000000" });
  assert.deepEqual(f.safeDisplay("150000000"), { ok: true, value: "1.5 ICP" });
  const bad = f.safeParse("1.123456789");
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, CODES.EXCESS_PRECISION);
  assert.equal(typeof bad.error.message, "string");
  assert.equal(f.safeDisplay(1).ok, false, "a JavaScript number is not a valid integer value");
  assert.throws(() => f.parse("x"), FormatError);
});

test("formatterFor: input of the wrong JavaScript type is a result, not a crash", () => {
  const f = formatterFor({ candid: "nat", tags: { amount: { args: { decimals: 8 } } } });
  for (const bad of [Symbol("x"), {}, [], undefined, null, 1.5, 15n]) {
    const r = f.safeParse(bad);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, CODES.TYPE);
  }
});

test("formatterFor: the formatter and its args are immutable", () => {
  const f = formatterFor({ candid: "nat", tags: { amount: { args: { decimals: 8, symbol: "ICP" } } } });
  assert.throws(() => {
    f.tag = "bytes"; // ES modules are strict, so writing to a frozen object throws
  }, TypeError);
  assert.throws(() => {
    f.args.decimals = 0;
  }, TypeError);
});

test("formatterFor: configuration errors are reported when the formatter is built", () => {
  assert.equal(code(() => formatterFor(null)), CODES.TYPE);
  assert.equal(code(() => formatterFor({})), CODES.TYPE);
  assert.equal(code(() => formatterFor({ candid: "text", tags: { amount: { args: { decimals: 8 } } } })), CODES.TAG_TYPE);
  assert.equal(code(() => formatterFor({ candid: "nat", tags: { account: { args: { encoding: "icrc1" } } } })), CODES.TAG_TYPE);
  assert.equal(code(() => formatterFor({ candid: "record", tags: { subaccount: { args: {} } } })), CODES.TAG_TYPE);
  assert.equal(code(() => formatterFor({ candid: "nat8", tags: { timestamp: { args: { unit: "s" } } } })), CODES.TAG_TYPE);
  assert.equal(code(() => formatterFor({ candid: "nat", tags: { amount: { args: {} } } })), CODES.ARG, "decimals is required");
  assert.equal(code(() => formatterFor({ candid: "nat64", tags: { timestamp: { args: {} } } })), CODES.ARG, "unit is required");
  assert.equal(code(() => formatterFor({ candid: "nat64", tags: { timestamp: { args: { unit: "minutes" } } } })), CODES.ARG);
  assert.equal(code(() => formatterFor({ candid: "nat64", tags: { timestamp: { args: { unit: "s", epoch: "gps" } } } })), CODES.ARG);
  assert.equal(code(() => formatterFor({ candid: "blob", tags: { bytes: { args: {} } } })), CODES.ARG);
  assert.equal(code(() => formatterFor({ candid: "blob", tags: { bytes: { args: { encoding: "ascii" } } } })), CODES.ARG);
  assert.equal(code(() => formatterFor({ candid: "record", tags: { account: { args: { encoding: "bitcoin" } } } })), CODES.ARG);
  assert.equal(
    code(() => formatterFor({ candid: "nat64", tags: { amount: { args: { decimals: 8 } }, timestamp: { args: { unit: "ns" } } } })),
    CODES.TAG_CONFLICT,
  );
});

test("formatterFor: signed Candid types allow negative amounts and timestamps before 1970", () => {
  const amount = formatterFor({ candid: "int", tags: { amount: { args: { decimals: 2, symbol: "X" } } } });
  assert.equal(amount.parse("-1.25 X"), "-125");
  assert.equal(amount.display("-125"), "-1.25 X");
  const ts = formatterFor({ candid: "int64", tags: { timestamp: { args: { unit: "s" } } } });
  assert.equal(ts.parse("1969-12-31T23:59:59Z"), "-1");
});
