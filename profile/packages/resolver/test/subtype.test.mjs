// Step 4: the Candid subtype checker (src/subtype.mjs). The rules are those of the Candid specification,
// "Upgrading and Subtyping > Rules"; each test names the rule it pins.
//
// The table of service pairs below was also run through the Rust `didc check` (candid_parser 0.5.4, candid 0.10):
// `rust` is what that tool answered, `spec` what this checker answers with the spec's rules. They differ only where
// Rust applies the "special opt rule" (it prints a warning and accepts), which the spec rules, and this checker by
// default, do not accept for pack matching. With `lossyOpt: true` the checker answers like Rust on every row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileInterface, matchService, typeSubtype } from "../src/index.mjs";

const svc = (m) => `service : { ${m} }`;
const iface = async (src, label) => {
  const c = await compileInterface(src, label);
  assert.ok(c.iface, JSON.stringify(c.failure));
  return c.iface;
};
/** newDid <: oldDid at service level. */
const sub = async (newDid, oldDid, opts) => matchService(await iface(newDid, "new"), await iface(oldDid, "old"), { resultVariants: "strict", ...opts });

// [new, old, rust, spec, rule]
const TABLE = [
  ["type L = opt record { head : nat; tail : L }; service : { m : () -> (L) }", "type L = opt record { head : int; tail : L }; service : { m : () -> (L) }", true, true, "recursion is coinductive; nat <: int"],
  ["type L = opt record { head : nat; tail : L; extra : text }; service : { m : () -> (L) }", "type L = opt record { head : nat; tail : L }; service : { m : () -> (L) }", true, true, "records: extra fields in the subtype"],
  ["type L = opt record { head : int; tail : L }; service : { m : () -> (L) }", "type L = opt record { head : nat; tail : L }; service : { m : () -> (L) }", true, false, "unusual opt rule (int is not a subtype of nat)"],
  ["type A = record { b : opt B }; type B = record { a : opt A; x : nat }; service : { m : () -> (A) }", "type A = record { b : opt B }; type B = record { a : opt A }; service : { m : () -> (A) }", true, true, "mutual recursion"],
  ["type T = variant { Leaf; Node : record { l : T; r : T; w : opt nat } }; service : { m : (T) -> () }", "type T = variant { Leaf; Node : record { l : T; r : T } }; service : { m : (T) -> () }", true, true, "argument: contravariant, extra optional field"],
  ["type T = variant { Leaf; Node : record { l : T; r : T } }; service : { m : (T) -> () }", "type T = variant { Leaf; Node : record { l : T; r : T; w : opt nat } }; service : { m : (T) -> () }", true, true, "argument: the fragment has the extra field"],
  ["type S = record { n : opt S; v : nat }; service : { m : () -> (S) }", "type S = record { n : opt S; v : text }; service : { m : () -> (S) }", false, false, "recursive types with unrelated payloads"],
  ["type S = record { n : opt S; v : nat }; service : { m : (S) -> () }", "type S = record { n : opt S; v : nat; k : opt text }; service : { m : (S) -> () }", true, true, "argument: new service drops an optional field"],
  ["type S = record { n : opt S; v : nat }; service : { m : (S) -> () }", "type S = record { n : opt S; v : nat; k : text }; service : { m : (S) -> () }", true, true, "argument: new service drops a required field it no longer reads"],
  ["type F = func (F) -> (F) query; service : { m : () -> (F) }", "type F = func (F) -> (F) query; service : { m : () -> (F) }", true, true, "recursive func types"],
  ["service : { m : (func (nat) -> (nat) query) -> () }", "service : { m : (func (int) -> (nat) query) -> () }", true, true, "function values: arguments flip again"],
  ["service : { m : (func (int) -> (nat) query) -> () }", "service : { m : (func (nat) -> (nat) query) -> () }", false, false, "function values: arguments flip again"],
  ["service : { m : (func (nat) -> (nat)) -> () }", "service : { m : (func (nat) -> (nat) query) -> () }", false, false, "function annotations must be equal"],
  ["service : { m : (service { f : () -> (nat) query; g : () -> () }) -> () }", "service : { m : (service { f : () -> (nat) query }) -> () }", false, false, "service references flip in argument position"],
  ["service : { m : (service { f : () -> (nat) query }) -> () }", "service : { m : (service { f : () -> (nat) query; g : () -> () }) -> () }", true, true, "service references flip in argument position"],
  ["service : { m : (nat, text) -> () }", "service : { m : (nat) -> () }", false, false, "functions: the new service requires a second argument"],
  ["service : { m : (nat) -> () }", "service : { m : (nat, text) -> () }", true, true, "functions: arguments can be dropped"],
  ["service : { m : (nat, opt text) -> () }", "service : { m : (nat) -> () }", true, true, "functions: an added argument must be optional"],
  ["service : { m : () -> (nat, text) }", "service : { m : () -> (nat) }", true, true, "functions: results can be added"],
  ["service : { m : () -> (nat) }", "service : { m : () -> (nat, text) }", false, false, "functions: results cannot be dropped"],
  ["service : { m : () -> (nat) }", "service : { m : () -> (nat, opt text) }", true, true, "functions: a dropped result must be optional"],
  ["service : { m : () -> (vec nat8) }", "service : { m : () -> (blob) }", true, true, "blob is vec nat8"],
  ["service : { m : () -> (variant { A; B }) }", "service : { m : () -> (variant { A; B; C }) }", true, true, "variants: fewer cases is a subtype"],
  ["service : { m : () -> (variant { A; B; C }) }", "service : { m : () -> (variant { A; B }) }", false, false, "variants: more cases is a supertype (strict)"],
  ["service : { m : (variant { A; B; C }) -> () }", "service : { m : (variant { A; B }) -> () }", true, true, "variants in arguments: contravariant"],
  ["service : { m : (variant { A; B }) -> () }", "service : { m : (variant { A; B; C }) -> () }", false, false, "variants in arguments: contravariant"],
  ["service : { m : (record { owner : principal; sub : opt blob }) -> () query }", "service : { m : (record { owner : principal }) -> () query }", true, true, "argument: optional extra field"],
  ["service : { m : (opt opt nat) -> () }", "service : { m : (opt nat) -> () }", true, true, "S <: opt T where S is opt: argument flips it"],
  ["service : { m : (nat) -> () }", "service : { m : (opt nat) -> () }", false, false, "opt nat is not a subtype of nat"],
  ["service : { m : (opt nat) -> () }", "service : { m : (nat) -> () }", true, true, "nat <: opt nat (constituent rule), in argument position"],
  ["service : { m : (opt nat) -> () }", "service : { m : (opt opt nat) -> () }", true, false, "unusual opt rule (the constituent rule needs T not to be opt)"],
  ["service : { m : () -> (opt opt nat) }", "service : { m : () -> (opt nat) }", true, false, "unusual opt rule"],
  ["service : { m : () -> (null) }", "service : { m : () -> (opt nat) }", true, true, "null <: opt T"],
  ["service : { m : () -> (empty) }", "service : { m : () -> (nat) }", true, true, "empty <: T"],
  ["service : { m : () -> (nat) }", "service : { m : () -> (reserved) }", true, true, "T <: reserved"],
  ["service : { m : (reserved) -> () }", "service : { m : (nat) -> () }", true, true, "T <: reserved, in argument position"],
  ["service : { m : (nat) -> () }", "service : { m : (reserved) -> () }", false, false, "reserved is not a subtype of nat"],
  ["service : { m : (int) -> () }", "service : { m : (nat) -> () }", true, true, "nat <: int, in argument position"],
  ["service : { m : () -> (int) }", "service : { m : () -> (nat) }", false, false, "int is not a subtype of nat"],
  ["service : { m : (nat) -> () oneway }", "service : { m : (nat) -> () }", false, false, "function annotations must be equal"],
  ["service : { m : (nat) -> () composite_query }", "service : { m : (nat) -> () query }", false, false, "function annotations must be equal"],
];

for (const [n, o, rust, spec, rule] of TABLE) {
  test(`subtype: ${rule}: ${n.slice(n.indexOf("service"), 70)} <: ${o.slice(o.indexOf("service"), 70)}`.replace(/\s+/g, " "), async () => {
    const strict = await sub(n, o);
    assert.equal(strict.ok, spec, JSON.stringify(strict.reasons));
    const lossy = await sub(n, o, { lossyOpt: true });
    assert.equal(lossy.ok, rust, "with the unusual opt rules the answer is the Rust crate's");
  });
}

test("every reason carries a path into the type", async () => {
  const r = await sub(
    "type T = record { a : record { b : text } }; service : { m : () -> (T) }",
    "type T = record { a : record { b : nat } }; service : { m : () -> (T) }",
  );
  assert.equal(r.ok, false);
  assert.equal(r.reasons[0].at, "m->(0).a.b");
  assert.match(r.reasons[0].message, /text \(new\) is not a subtype of nat \(old\)/);
});

test("a field the other side requires is reported by name", async () => {
  const r = await sub(
    "service : { m : () -> (record { a : nat }) }",
    "service : { m : () -> (record { a : nat; b : text }) }",
  );
  assert.equal(r.ok, false);
  assert.match(r.reasons[0].message, /field "b" \(text\) is required by the old but missing from the new/);
});

test("labels are compared by id: #n spellings and hashed names agree", async () => {
  const r = await sub(
    "service : { m : () -> (record { 0 : nat; 1 : text }) }",
    "service : { m : () -> (record { nat; text }) }",
  );
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------- the special opt rules

test("the special opt rules are off by default and make opt T <: opt U hold for unrelated T and U when asked for", async () => {
  const fee = (t) => svc(`m : (record { fee : opt ${t} }) -> ()`);
  // The pack says `fee : opt nat`; the canister says `fee : opt text`: a pack match must refuse, not drop the fee.
  const strict = await sub(fee("text"), fee("nat"));
  assert.equal(strict.ok, false);
  const lossy = await sub(fee("text"), fee("nat"), { lossyOpt: true });
  assert.equal(lossy.ok, true);
  // A plain value is never a subtype of an unrelated opt (the Rust crate accepts that too, with a warning; the spec has no such rule).
  assert.equal((await sub(svc("m : () -> (text)"), svc("m : () -> (opt nat)"), { lossyOpt: true })).ok, false);
});

// ---------------------------------------------------------------- D-019

const RES = {
  fragment: "type E = variant { A; B : record { x : nat } }; service : { m : () -> (variant { Ok : nat; Err : E }) }",
  wider: "type E = variant { A; B : record { x : nat }; C : text; D }; service : { m : () -> (variant { Ok : nat; Err : E }) }",
};

test("D-019: a result variant may have cases the fragment lacks, and the extra cases are reported", async () => {
  assert.equal((await sub(RES.wider, RES.fragment)).ok, false, "plain Candid subtyping refuses");
  const r = await sub(RES.wider, RES.fragment, { resultVariants: "relaxed" });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.deepEqual(r.relaxed, [{ at: "m->(0).Err", cases: ["C", "D"] }]);
});

test("D-019: the cases both sides have are still checked, relaxed or not", async () => {
  const bad = "type E = variant { A; B : record { x : text }; C : text }; service : { m : () -> (variant { Ok : nat; Err : E }) }";
  const r = await sub(bad, RES.fragment, { resultVariants: "relaxed" });
  assert.equal(r.ok, false);
  assert.equal(r.reasons[0].at, "m->(0).Err.B.x");
  assert.deepEqual(r.relaxed, [], "a failed position reports no relaxation");
});

test("D-019 reaches variants nested in records, opts and vecs of a result", async () => {
  const frag = "service : { m : () -> (record { r : opt vec variant { A } }) }";
  const wide = "service : { m : () -> (record { r : opt vec variant { A; B } }) }";
  const r = await sub(wide, frag, { resultVariants: "relaxed" });
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.relaxed[0].at, "m->(0).r[]");
});

test("D-019 does not apply to argument positions: a variant the canister accepts fewer cases of is strict", async () => {
  // Argument: the canister must accept every case the fragment may send, so it cannot have fewer cases.
  const frag = "service : { m : (variant { A; B }) -> () }";
  const canisterFewer = "service : { m : (variant { A }) -> () }";
  const canisterMore = "service : { m : (variant { A; B; C }) -> () }";
  assert.equal((await sub(canisterFewer, frag, { resultVariants: "relaxed" })).ok, false);
  assert.equal((await sub(canisterMore, frag, { resultVariants: "relaxed" })).ok, true);
});

test("D-019 does not leak into function values: a func in a result has strict variants", async () => {
  const frag = "service : { m : () -> (func () -> (variant { A }) query) }";
  const wide = "service : { m : () -> (func () -> (variant { A; B }) query) }";
  assert.equal((await sub(wide, frag, { resultVariants: "relaxed" })).ok, false);
});

test("matchService applies D-019 only to method results, per fragment method", async () => {
  const canister = await iface(RES.wider, "canister");
  const fragment = await iface(RES.fragment, "pack fragment");
  assert.equal(matchService(canister, fragment).ok, true, "relaxed is the default for matching");
  assert.equal(matchService(canister, fragment, { resultVariants: "strict" }).ok, false);
});

// ---------------------------------------------------------------- bounds

test("depth and step limits fail closed", async () => {
  const deep = (d, leaf) => `${"vec ".repeat(d)}${leaf}`;
  const a = await iface(svc(`m : () -> (${deep(40, "nat")})`), "new");
  const b = await iface(svc(`m : () -> (${deep(40, "int")})`), "old");
  assert.equal(matchService(a, b).ok, true);
  const limited = matchService(a, b, { maxDepth: 10 });
  assert.equal(limited.ok, false);
  assert.match(limited.reasons[0].message, /depth limit/);
  assert.equal(matchService(a, b, { maxSteps: 5 }).ok, false);
});

test("typeSubtype compares two declarations across interfaces", async () => {
  const a = await iface("type T = record { a : nat; b : text }; service : {}", "new");
  const b = await iface("type T = record { a : int }; service : {}", "old");
  const r = typeSubtype(a, a.decls.get("T"), b, b.decls.get("T"));
  assert.equal(r.ok, true);
  assert.equal(typeSubtype(b, b.decls.get("T"), a, a.decls.get("T")).ok, false);
});

// ---------------------------------------------------------------- live differential run against the Rust crate (optional)

const haveDidc = spawnSync("didc", ["--version"]).status === 0;

test("differential: 250 seeded random service pairs agree with `didc check` (skipped without didc)", { skip: !haveDidc && "didc is not installed" }, async () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const prims = ["nat", "int", "text", "bool", "null", "reserved", "empty"];
  const gen = (d) => {
    if (d <= 0 || rnd() < 0.3) return pick(prims);
    const k = pick(["opt", "opt", "vec", "record", "record", "variant", "variant", "func"]);
    if (k === "opt" || k === "vec") return `${k} ${gen(d - 1)}`;
    if (k === "func") return `func (${gen(d - 1)}) -> (${gen(d - 1)}) ${pick(["", "query"])}`;
    const labels = ["a", "b", "c"].filter(() => rnd() < 0.6);
    if (k === "record") return `record { ${labels.map((l) => `${l} : ${gen(d - 1)}`).join("; ")} }`;
    return `variant { ${(labels.length ? labels : ["a"]).map((l) => (rnd() < 0.3 ? l.toUpperCase() : `${l.toUpperCase()} : ${gen(d - 1)}`)).join("; ")} }`;
  };
  const mutate = (t) => {
    const r = rnd();
    if (r < 0.35) return t;
    if (r < 0.5) return `opt ${t}`;
    if (r < 0.6) return pick(prims);
    return t.replace(/\b(nat|int|text|bool|null|reserved|empty)\b/, () => pick(prims)).replace(/record \{ /, () => (rnd() < 0.5 ? "record { z : opt nat; " : "record { ")).replace(/variant \{ /, () => (rnd() < 0.5 ? "variant { Z; " : "variant { "));
  };
  const dir = await mkdtemp(path.join(tmpdir(), "didc-"));
  let compared = 0;
  let positives = 0;
  for (let i = 0; i < 250; i++) {
    const a = gen(3);
    const r = gen(3);
    const n = svc(`m : (${mutate(a)}) -> (${mutate(r)})`);
    const o = svc(`m : (${a}) -> (${r})`);
    const cn = await compileInterface(n, "new");
    const co = await compileInterface(o, "old");
    if (cn.failure || co.failure) continue;
    await writeFile(path.join(dir, "n.did"), n);
    await writeFile(path.join(dir, "o.did"), o);
    const rust = spawnSync("didc", ["check", path.join(dir, "n.did"), path.join(dir, "o.did")], { encoding: "utf8" });
    const usedSpecialRule = /special subtyping rules/.test(rust.stderr);
    const strict = matchService(cn.iface, co.iface, { resultVariants: "strict" }).ok;
    const lossy = matchService(cn.iface, co.iface, { resultVariants: "strict", lossyOpt: true }).ok;
    compared++;
    if (rust.status !== 0) {
      // Never more permissive than the Rust crate, with or without the unusual opt rules.
      assert.ok(!strict && !lossy, `accepted what didc rejects: ${n}  <:  ${o}`);
    } else if (!usedSpecialRule) {
      assert.ok(strict && lossy, `rejected what didc accepts: ${n}  <:  ${o}`);
      positives++;
    } else {
      // didc accepted through its special opt rule (it warns). The spec rules are a subset of what it accepts.
      assert.ok(!strict || lossy, `${n}  <:  ${o}`);
    }
  }
  assert.ok(compared > 150 && positives > 40, `compared ${compared}, positives ${positives}`);
});
