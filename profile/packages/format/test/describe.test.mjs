import { test } from "node:test";
import assert from "node:assert/strict";
import { CODES, VALUE_TAGS, describeInput, formatterFor } from "../src/index.mjs";
import { loadFixture, positions } from "./helpers/fixtures.mjs";

const NOW = 1791547200123456789n; // 2026-10-09T12:00:00.123456789Z
const LEDGERS = [
  { decimals: 8, symbol: "TKA" },
  { decimals: 6, symbol: "TKB" },
  { decimals: 18, symbol: "TKC" },
  { decimals: 0, symbol: "W" },
  { decimals: 1, symbol: "ckBTC" },
  { decimals: 18, symbol: "ckETH-S" },
  { decimals: 2, symbol: "a.b[x]|$" },
];
const refsFor = (l) => ({ "query:icrc1_decimals": l.decimals, "query:icrc1_symbol": l.symbol });

/** One node per tag, Candid type and argument shape the format library accepts. */
function* nodes() {
  for (const candid of ["nat", "int", "nat8", "nat64", "int64"]) {
    for (const l of LEDGERS) yield { candid, tags: { amount: { args: { decimals: l.decimals, symbol: l.symbol } } } };
    yield { candid, tags: { amount: { args: { decimals: 2 } } } };
  }
  for (const candid of ["nat", "int", "nat32", "nat64", "int64"]) {
    for (const unit of ["ns", "us", "ms", "s"]) {
      yield { candid, tags: { timestamp: { args: { unit } } } };
      yield { candid, tags: { duration: { args: { unit } } } };
    }
  }
  yield { candid: "record", tags: { account: { args: {} } } };
  yield { candid: "blob", tags: { subaccount: { args: {} } } };
  for (const encoding of ["utf8", "hex", "base64"]) {
    yield { candid: "blob", tags: { bytes: { args: { encoding } } } };
    yield { candid: "blob", tags: { bytes: { args: { encoding, max_len: 32 } } } };
  }
}

test("describe: every value tag has a summary, and every example parses", () => {
  const tags = new Set();
  for (const node of nodes()) {
    const f = formatterFor(node);
    const d = f.describe();
    tags.add(f.tag);
    assert.equal(typeof d.summary, "string");
    assert.ok(d.summary.length > 20, `${f.tag} ${node.candid}: summary`);
    for (const x of d.examples) assert.ok(f.safeParse(x, { now: NOW }).ok, `${f.tag} ${node.candid} ${JSON.stringify(f.args)}: example ${x}`);
    if (d.pattern !== undefined) {
      // JSON Schema validators (Ajv) compile patterns with the `u` flag, which refuses needless escapes
      const re = new RegExp(d.pattern, "u");
      for (const x of d.examples) assert.match(x, re, `${f.tag}: ${x} matches the pattern`);
    }
    // the summary quotes exactly the examples kept
    const quoted = d.summary.match(/ For example (.*)\.$/)?.[1];
    assert.equal(quoted, d.examples.length ? d.examples.map((x) => JSON.stringify(x)).join(", ") : undefined, `${f.tag} ${node.candid}: ${d.summary}`);
  }
  assert.deepEqual([...tags].sort(), [...VALUE_TAGS].sort());
});

test("describe: the packs' positions get examples, with the ledger's decimals and symbol filled in", () => {
  let n = 0;
  for (const name of ["icrc1", "icrc2", "tokens-example"]) {
    for (const { path, node } of positions(loadFixture(name))) {
      for (const l of LEDGERS.slice(0, 3)) {
        const f = formatterFor(node, { refs: refsFor(l) });
        if (f === null) continue;
        const d = f.describe();
        assert.ok(d.examples.length > 0, `${name} ${path}: no example`);
        for (const x of d.examples) assert.ok(f.safeParse(x, { now: NOW }).ok, `${name} ${path}: ${x}`);
        if (f.tag === "amount") {
          // the tag's own arguments: the ledger's from refs in the packs, literals in the example profile
          const { decimals, symbol } = f.args;
          if (name !== "tokens-example") assert.deepEqual({ decimals, symbol }, l);
          assert.ok(d.summary.includes(`at most ${decimals} digits`), d.summary);
          assert.ok(d.summary.includes(symbol), d.summary);
          assert.ok(d.examples.includes(`1.25 ${symbol}`), d.examples.join());
        }
        n++;
      }
    }
  }
  assert.ok(n > 10);
});

test("describe: a fresh copy each call", () => {
  const f = formatterFor({ candid: "nat", tags: { amount: { args: { decimals: 8 } } } });
  f.describe().examples.push("mutated");
  assert.ok(!f.describe().examples.includes("mutated"));
});

test("describe: examples a position refuses are left out (range, max_len)", () => {
  assert.deepEqual(formatterFor({ candid: "nat8", tags: { amount: { args: { decimals: 3 } } } }).describe().examples, []);
  assert.deepEqual(formatterFor({ candid: "nat32", tags: { timestamp: { args: { unit: "ns" } } } }).describe().examples, []);
  assert.deepEqual(formatterFor({ candid: "blob", tags: { bytes: { args: { encoding: "utf8", max_len: 4 } } } }).describe().examples, ["0x1a2b"]);
});

// The pattern is a necessary condition: everything parse accepts matches it, and what it lets through parse refuses
// only for a reason a regular expression cannot see (a range).
const AMOUNT_CORPUS = [
  "", " ", "0", "1", "01", "1.", ".5", "1.5", "1.50", "1.25", "1.123456789", "-1", "-1.5", "+1", "1e3", "1,5", "1 000",
  " 1.5 ", "1.5 TKA", "1.5 tka", "1.5 TkA", "1.5TKA", "1.5  TKA", "1.5 TKB", "1.5 TKA ", "TKA", "1.5 TKA x", "1.5\tTKA",
  "1.5\nTKA", "99999999999999999999999", "1.5 ckBTC", "1.5 CKBTC", "5 W", "5.0 W", "5.0", "0.00000001", "0.000000001",
  "١", "1.5 ＴＫＡ", "1.5 \u212AA", "1.5 ckETH-S", "1.5 CKETH-s", "1.5 ckETH", "1.5 ckETHxS", "1.5 a.b[x]|$", "1.5 aXb[x]|$",
];
const SUB_CORPUS = [
  "", "#", "#0", "0", "#00", "00", "7", "#7", "#18446744073709551615", "#18446744073709551616", "-1", "#-1", "0x", "0x1",
  "a".repeat(64), "A".repeat(64), "0x" + "a".repeat(64), "0X" + "a".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64),
  " #7 ", "# 7", "1".repeat(64), "1".repeat(20), "1".repeat(21),
];

test("describe: amount pattern ⇔ parse, up to a range", () => {
  for (const candid of ["nat", "int", "nat8"]) {
    for (const l of [...LEDGERS, { decimals: 2 }]) {
      const f = formatterFor({ candid, tags: { amount: { args: l } } });
      const re = new RegExp(f.describe().pattern, "u");
      for (const x of AMOUNT_CORPUS) {
        const r = f.safeParse(x);
        if (r.ok) assert.match(x, re, `${candid} ${JSON.stringify(l)}: ${JSON.stringify(x)} parses but does not match`);
        else if (r.error.code !== CODES.RANGE) assert.doesNotMatch(x, re, `${candid} ${JSON.stringify(l)}: ${JSON.stringify(x)} matches but parse says ${r.error.code}`);
      }
    }
  }
});

test("describe: subaccount pattern ⇔ parse, up to a range", () => {
  const f = formatterFor({ candid: "blob", tags: { subaccount: { args: {} } } });
  const re = new RegExp(f.describe().pattern, "u");
  for (const x of SUB_CORPUS) {
    const r = f.safeParse(x);
    if (r.ok) assert.match(x, re, JSON.stringify(x));
    else if (r.error.code !== CODES.RANGE) assert.doesNotMatch(x, re, `${JSON.stringify(x)}: ${r.error.code}`);
  }
});

test("describeInput: an unknown tag throws", () => {
  assert.throws(() => describeInput("colour", {}, "text"), /no description/);
});

test("describeInput normalises decimals given as text or bigint, as formatterFor does", () => {
  for (const decimals of [0, "0", 0n]) {
    const d = describeInput("amount", { decimals }, "nat");
    assert.deepEqual(d.examples, ["1", "250"], String(decimals));
    assert.doesNotThrow(() => new RegExp(d.pattern, "u"), String(decimals));
  }
  assert.deepEqual(describeInput("amount", { decimals: "8" }, "nat"), describeInput("amount", { decimals: 8 }, "nat"));
  assert.throws(() => describeInput("amount", { decimals: "x" }, "nat"), /decimals/);
});

test("the timestamp hint names the duration units a relative time may use", () => {
  const f = formatterFor({ candid: "nat64", tags: { timestamp: { args: { unit: "ns" } } } }, { now: 0n });
  const d = f.describe();
  assert.match(d.summary, /no years or months/);
  for (const bad of ["+P1M", "+P1Y"]) assert.throws(() => f.parse(bad));
});

test("describe: the base64 summary states the dialect the parser accepts (#36 review)", () => {
  const f = formatterFor({ candid: "blob", tags: { bytes: { args: { encoding: "base64" } } } });
  const { summary } = f.describe();
  for (const words of ["standard base64", "not the URL-safe", "padding or none", "no spaces or line breaks", "unused bits"]) assert.ok(summary.includes(words), words);
  // each restriction it names is one the parser enforces
  for (const x of ["aGk", "aGk="]) assert.ok(f.safeParse(x).ok, x);
  for (const x of ["-_8=", "aG k=", "aGk=\n", "aGl="]) assert.equal(f.safeParse(x).ok, false, JSON.stringify(x));
});

test("describeInput refuses the arguments formatterFor refuses, never describing another grammar (#36 review)", () => {
  const bad = [
    ["bytes", { encoding: "bogus" }, "blob", CODES.ARG],
    ["bytes", {}, "blob", CODES.ARG],
    ["bytes", { encoding: "hex", max_len: -1 }, "blob", CODES.ARG],
    ["timestamp", { unit: "fortnights" }, "nat64", undefined],
    ["timestamp", {}, "nat64", CODES.ARG],
    ["timestamp", { unit: "ns", epoch: "gps" }, "nat64", CODES.ARG],
    ["duration", { unit: "eons" }, "nat64", undefined],
    ["account", { encoding: "legacy" }, "record", CODES.ARG],
    ["subaccount", {}, "text", CODES.TAG_TYPE],
    ["amount", { decimals: 8 }, "text", CODES.TAG_TYPE],
  ];
  for (const [tag, args, candid, code] of bad) {
    const node = { candid, tags: { [tag]: { args } } };
    let viaFormatter;
    try {
      formatterFor(node);
    } catch (e) {
      viaFormatter = e.code;
    }
    assert.ok(viaFormatter !== undefined, `${tag} ${JSON.stringify(args)}: formatterFor refuses it`);
    assert.throws(() => describeInput(tag, args, candid), (e) => e.code === viaFormatter && (code === undefined || e.code === code), `${tag} ${JSON.stringify(args)} ${candid}`);
  }
  assert.match(describeInput("bytes", { encoding: "hex", max_len: 4 }, "blob").summary, /At most 4 bytes/);
});

test("describe keeps only relative examples the formatter's own clock accepts (#36 review)", () => {
  const node = { candid: "nat32", tags: { timestamp: { args: { unit: "s" } } } };
  const now = 4294967295n * 1_000_000_000n;
  const f = formatterFor(node, { now });
  for (const x of f.describe().examples) assert.ok(f.safeParse(x).ok, x);
  assert.ok(!f.describe().examples.some((x) => x.startsWith("+")), "no relative time fits after the last nat32 second");
  // without a bound clock the fixed instant still decides
  assert.ok(formatterFor(node).describe().examples.some((x) => x.startsWith("+")));
});
