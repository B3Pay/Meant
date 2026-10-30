// A pin (`fixed`, spec section 15.4, D-058): a profile describes a call or an EIP-712 message only with one address at
// a position, as x402's Permit2 payment holds x402's proxy as its spender (docs/proposals/w0-x402.md §2). Where a pin
// may sit, what a pin that does not hold takes with it, and pins across profiles and a changed ABI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LEDGER_DID, canisterProfile, interfaceIdOf, readJson, validateSchema } from "./helpers.mjs";
import { resolveService, validateProfile } from "../src/index.mjs";

const PROXY = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001";
const OTHER = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const ABI = ["function pay(address via, address to, uint256 amount) returns (bool)", "function router() view returns (address)"];
const TYPES = {
  Payment: [
    { name: "via", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "until", type: "uint256" },
    { name: "legs", type: "Leg[]" },
  ],
  Leg: [
    { name: "via", type: "address" },
    { name: "amount", type: "uint256" },
  ],
};
const contract = (annotations, { name = "router", origin = "author", abi = ABI } = {}) => ({
  format: "candid-profile",
  format_version: 0,
  kind: "contract",
  name,
  origin,
  binds: { abi, eip712: { domain: { name: "Router" }, types: TYPES }, deployments: [{ chain_id: 1, address: OTHER }] },
  annotations,
});
const WORDS = [
  { at: "Payment", tag: "intent", args: { title: "Pay", template: "Pay {amount} to {to} through {via}" } },
  { at: "Payment", tag: "effect", args: { kind: "transfer", irreversible: true, grant: { to: "to", amount: "amount", ends: ["until"] } } },
  { at: "Payment(0).amount", tag: "amount", args: { decimals: 6, symbol: "USDC" } },
  { at: "Payment(0).until", tag: "timestamp", args: { unit: "s", epoch: "unix" } },
  { at: "Payment(0).via", tag: "describe", args: { label: "Payment contract" } },
];
const pin = (at, value = PROXY) => ({ at, tag: "fixed", args: { value } });
const LOST = "; this profile keeps only its effects (without grants) and its pins that hold, since its words were written for the pinned value (spec section 15.4)";
const errorsOf = (r) => r.diagnostics.filter((d) => d.severity === "error").map((d) => [d.code, d.at, d.message]);

test("x402's Permit2 payment pins its spender to x402's proxy, and the resolved form carries the pin", async () => {
  const fixture = await readJson("fixtures/x402-exact-permit2.resolved.json");
  const m = fixture.messages.PermitWitnessTransferFrom;
  assert.equal(m.type_hash, "0xebc156cd23678a74c94df13d772ef5478420637f0c94bd10d509e1dc98f521c7");
  assert.deepEqual(m.args[0].fields.spender.tags.fixed, { args: { value: PROXY }, origin: "third_party", profile: "x402-exact-permit2" });
  assert.deepEqual(m.tags.effect.args, { kind: "transfer", irreversible: true, grant: { to: "witness.to", amount: "permitted.amount", ends: ["deadline"] } });
  assert.deepEqual(fixture.diagnostics, []);
});

test("a pin sits on an address in the arguments of a function or a message, and its value is an address", async () => {
  // where it holds: a message's member, every element of an array, a function's argument
  for (const at of ["Payment(0).via", "Payment(0).legs[].via", "pay(0).via"]) {
    const v = await validateProfile(contract([...WORDS, pin(at)]), { validateSchema, resolved: true });
    assert.equal(v.ok, true, `${at}: ${JSON.stringify(v.diagnostics)}`);
  }
  for (const [a, code, why] of [
    [pin("router->(0)"), "E_TAG_TARGET", /^fixed pins a value in the arguments of a function or a message/],
    [pin("Payment(0).amount"), "E_TAG_NOT_APPLICABLE", /^fixed needs an address, found uint256/],
    [pin("Payment(0).via", "0x402085C248EeA27D92E8b30b2C58ed07f9E20001"), "E_ADDRESS_CHECKSUM", /^fixed: 0x402085C248EeA27D92E8b30b2C58ed07f9E20001 is in mixed case but its EIP-55 checksum does not match/],
    [pin("Payment(0).nope"), "E_ADDR_UNRESOLVED", /no field "nope"/],
  ]) {
    const v = await validateProfile(contract([...WORDS, a]), { validateSchema });
    const found = errorsOf(v);
    assert.deepEqual(found.map(([c, at]) => [c, at]), [[code, a.at]], JSON.stringify(v.diagnostics));
    assert.match(found[0][2], why);
    assert.ok(found[0][2].endsWith(LOST), found[0][2]);
  }
  // the schema: one address, nothing else, at a value's address
  for (const [at, args] of [["Payment(0).via", { value: "x402" }], ["Payment(0).via", {}], ["Payment(0).via", { value: PROXY, also: PROXY }], ["Payment(0).via", { value: [PROXY] }], ["Payment", { value: PROXY }]]) {
    const v = await validateProfile(contract([...WORDS, { at, tag: "fixed", args }]), { validateSchema });
    assert.equal(v.ok, false);
    assert.ok(v.diagnostics.every((d) => d.code === "E_SCHEMA"), JSON.stringify(v.diagnostics));
  }
  // not on a Candid service: an ICRC account is not an EVM address
  const did = LEDGER_DID;
  const canister = canisterProfile({ interfaceId: await interfaceIdOf(did), annotations: [pin("icrc1_transfer(0).to.owner")] });
  const v = await validateProfile(canister, { validateSchema, did });
  assert.deepEqual(errorsOf(v).map(([c, , m]) => [c, m.replace(LOST, "")]), [["E_TAG_NOT_APPLICABLE", "fixed pins an EVM address; a Candid position cannot carry it yet (spec section 15.4)"]]);
});

test("a profile with a pin that does not hold keeps only its effects, without grants, and its pins that hold", async () => {
  const good = (await validateProfile(contract([...WORDS, pin("Payment(0).via"), pin("Payment(0).legs[].via")]), { validateSchema, resolved: true })).resolved;
  const bad = await validateProfile(contract([...WORDS, pin("Payment(0).via"), pin("Payment(0).legs[].via"), pin("Payment(0).nope")]), { validateSchema, resolved: true });
  assert.deepEqual(errorsOf(bad), [["E_ADDR_UNRESOLVED", "Payment(0).nope", `no field "nope" in record${LOST}`]]);
  // with every pin holding: the words, the grant, the value tags and the pins
  const g = good.messages.Payment;
  assert.deepEqual(Object.keys(g.tags).sort(), ["effect", "intent"]);
  assert.deepEqual(g.tags.effect.args.grant, { to: "to", amount: "amount", ends: ["until"] });
  assert.deepEqual(Object.keys(g.args[0].fields.via.tags).sort(), ["describe", "fixed"]);
  // with one that does not: the effect without its grant, so a request still needs a person's yes, and the two pins
  const b = bad.resolved.messages.Payment;
  assert.deepEqual(b.tags, { effect: { args: { kind: "transfer", irreversible: true }, origin: "author", profile: "router" } });
  const f = b.args[0].fields;
  assert.deepEqual(f.via.tags, { fixed: { args: { value: PROXY }, origin: "author", profile: "router" } });
  assert.deepEqual(f.legs.element.fields.via.tags, { fixed: { args: { value: PROXY }, origin: "author", profile: "router" } });
  for (const k of ["to", "amount", "until"]) assert.equal(f[k].tags, undefined, k);
  // a pin that is not an address is left out too: its profile keeps only its effects
  const wrong = await validateProfile(contract([...WORDS, pin("Payment(0).amount")]), { validateSchema, resolved: true });
  assert.deepEqual(wrong.resolved.messages.Payment.args[0].fields.amount.tags, undefined);
  assert.deepEqual(Object.keys(wrong.resolved.messages.Payment.tags), ["effect"]);
});

test("every profile pins a position to one value, in any layer: the profile below loses its words", async () => {
  // the author pins the position and says nothing else; a third party writes the words and pins it too
  const author = contract([pin("Payment(0).via")]);
  const words = (value) => contract([...WORDS, pin("Payment(0).via", value)], { name: "words", origin: "third_party" });
  const same = await resolveService({ abi: ABI, validateSchema, profiles: [{ doc: author }, { doc: words(PROXY) }] });
  assert.equal(same.ok, true, JSON.stringify(same.diagnostics));
  assert.deepEqual(Object.keys(same.resolved.messages.Payment.tags).sort(), ["effect", "intent"]);
  assert.deepEqual(same.resolved.messages.Payment.tags.effect.args.grant, { to: "to", amount: "amount", ends: ["until"] });
  const other = await resolveService({ abi: ABI, validateSchema, profiles: [{ doc: author }, { doc: words(OTHER) }] });
  assert.deepEqual(errorsOf(other), [["E_CONFLICT", "Payment(0).via", `fixed pins this position to ${OTHER}, where profile "router" "Payment(0).via" pins it to another value${LOST}`]]);
  const m = other.resolved.messages.Payment;
  assert.deepEqual(m.tags, { effect: { args: { kind: "transfer", irreversible: true }, origin: "third_party", profile: "words" } });
  assert.deepEqual(m.args[0].fields.via.tags, { fixed: { args: { value: PROXY }, origin: "author", profile: "router" } });
  // two pins in one profile, at one position, with two values
  const twice = await validateProfile(contract([...WORDS, pin("Payment(0).via"), pin("Payment(0).via", OTHER)]), { validateSchema, resolved: true });
  assert.deepEqual(errorsOf(twice).map(([c, at]) => [c, at]), [["E_CONFLICT", "Payment(0).via"]]);
  assert.deepEqual(Object.keys(twice.resolved.messages.Payment.tags), ["effect"]);
});

test("a pin on a function's argument, resolved against an ABI that no longer has it, takes the words with it", async () => {
  const doc = contract([
    { at: "pay", tag: "intent", args: { title: "Pay", template: "Pay {amount} to {to}" } },
    { at: "pay", tag: "effect", args: { kind: "transfer", irreversible: true, grant: { to: "to", amount: "amount" } } },
    { at: "pay(0).amount", tag: "amount", args: { decimals: 6, symbol: "USDC" } },
    pin("pay(0).via"),
  ]);
  const ok = await resolveService({ abi: ABI, validateSchema, profiles: [{ doc }] });
  assert.equal(ok.ok, true, JSON.stringify(ok.diagnostics));
  assert.deepEqual(ok.resolved.methods.pay.args[0].fields.via.tags.fixed.args, { value: PROXY });
  const renamed = ABI.map((f) => f.replace("address via", "address router"));
  const r = await resolveService({ abi: renamed, validateSchema, profiles: [{ doc }] });
  assert.deepEqual(r.profiles.map((p) => p.status), ["stale"]);
  assert.deepEqual(errorsOf(r).map(([c, at]) => [c, at]), [["E_ADDR_UNRESOLVED", "pay(0).via"], ["E_STALE", "binds.abi"]]);
  assert.deepEqual(r.resolved.methods.pay.tags, { effect: { args: { kind: "transfer", irreversible: true }, origin: "author", profile: "router" } });
  assert.equal(r.resolved.methods.pay.args[0].fields.router.tags, undefined);
});
