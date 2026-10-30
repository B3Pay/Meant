// EIP-712 typed messages (spec section 15.9, D-055): the types a profile binds, the messages it describes, an amount in
// a token another field names, and the standard files (EIP-2612, Permit2, DAI). The type hashes pinned below were
// computed by an independent Python EIP-712 from the EIP's text, and the DAI one is the constant in dai.sol. Unit
// tests only: no chain, no network, nothing signed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readJson, validateSchema } from "./helpers.mjs";
import { resolveService, validateProfile } from "../src/index.mjs";
import { abiInterfaceId, eip712TypeHash, encodeType, parseAbi, parseEip712Types } from "../src/evm.mjs";

const erc20 = await readJson("packs/erc20.profile.json");
const erc2612 = await readJson("packs/erc2612.profile.json");
const permit2 = await readJson("packs/permit2.profile.json");
const daiPermit = await readJson("packs/dai-permit.profile.json");
const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return null;
};
const errors = (r) => r.diagnostics.filter((d) => d.severity === "error").map((d) => [d.code, d.at]);

const MAIL = {
  Mail: [
    { name: "from", type: "Person" },
    { name: "to", type: "Person" },
    { name: "contents", type: "string" },
  ],
  Person: [
    { name: "name", type: "string" },
    { name: "wallet", type: "address" },
  ],
};

test("encodeType and the type hash: the EIP's Mail example, dependencies sorted by name", () => {
  assert.equal(encodeType(MAIL, "Mail"), "Mail(Person from,Person to,string contents)Person(string name,address wallet)");
  assert.equal(eip712TypeHash(MAIL, "Mail"), "0xa0cedeb2dc280ba39b857546d74f5549c3a1d7bdc2dd96bf881f76108e23dac2");
  assert.equal(encodeType({ B: [{ name: "c", type: "C[2]" }, { name: "a", type: "A[]" }], A: [{ name: "x", type: "uint8" }], C: [{ name: "a", type: "A" }] }, "B"), "B(C[2] c,A[] a)A(uint8 x)C(A a)");
  assert.equal(codeOf(() => encodeType(MAIL, "Letter")), "E_EIP712");
  assert.deepEqual(parseEip712Types(MAIL), { types: MAIL, errors: [] });
});

test("EIP-712 types that are refused, each with its place; a struct that refers to a refused one goes too", () => {
  const { types, errors: found } = parseEip712Types(
    {
      "Bad-Name": [{ name: "x", type: "uint8" }],
      uint256: [{ name: "x", type: "uint8" }],
      EIP712Domain: [{ name: "name", type: "string" }],
      Empty: [],
      Twice: [{ name: "x", type: "uint8" }, { name: "x", type: "uint16" }],
      Short: [{ name: "x", type: "uint" }],
      Unknown: [{ name: "x", type: "Nope" }],
      Zero: [{ name: "xs", type: "uint8[0]" }],
      Odd: [{ name: "x", type: "uint8 []" }],
      Loop: [{ name: "next", type: "Loop[]" }],
      Uses: [{ name: "s", type: "Short" }],
      Fine: [{ name: "x", type: "bytes32" }, { name: "ys", type: "address[2][]" }],
    },
    "binds.eip712.types",
  );
  assert.deepEqual(Object.keys(types), ["Fine"]);
  assert.deepEqual(
    found.map((e) => [e.at, e.message]),
    [
      ["binds.eip712.types.Bad-Name", 'the struct name "Bad-Name" is not an identifier (letters, digits and _)'],
      ["binds.eip712.types.uint256", "a struct cannot be named uint256: the name reads as an ABI type or the domain's type"],
      ["binds.eip712.types.EIP712Domain", "a struct cannot be named EIP712Domain: the name reads as an ABI type or the domain's type"],
      ["binds.eip712.types.Empty", "a struct has at least one member, each { name, type }"],
      ["binds.eip712.types.Twice[1]", "two members are named x"],
      ["binds.eip712.types.Short[0]", "write uint256, not uint: the type hash hashes the type as written"],
      ["binds.eip712.types.Unknown[0]", "Nope is neither an ABI type nor a struct of these types"],
      ["binds.eip712.types.Zero[0]", "array length [0] must be a positive integer"],
      ["binds.eip712.types.Odd[0]", '"uint8 []" is not a type'],
      ["binds.eip712.types.Loop", "Loop -> Loop: a struct cannot contain itself"],
      ["binds.eip712.types.Uses", "refers to Short, which is refused above"],
    ],
  );
  const mutual = parseEip712Types({ A: [{ name: "b", type: "B" }], B: [{ name: "a", type: "A[2]" }], C: [{ name: "a", type: "A" }] });
  assert.deepEqual(Object.keys(mutual.types), []);
  assert.deepEqual(mutual.errors.map((e) => e.message), ["A -> B -> A: a struct cannot contain itself", "refers to A, which is refused above"]);
  assert.equal(parseEip712Types([]).errors.length, 1);
});

test("the standard files: their messages' type hashes are the standards' own", async () => {
  const expected = {
    erc2612: { Permit: "0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9" },
    "dai-permit": { Permit: "0xea2aa0a1be11a07ed86d755c93467f4f82362b452371d1ba94d1715123511acb" },
    permit2: {
      PermitBatch: "0xaf1b0d30d2cab0380e68f0689007e3254993c596f2fdd0aaa7f4d04f79440863",
      PermitBatchTransferFrom: "0xfcf35f5ac6a2c28868dc44c302166470266239195f02b0ee408334829333b766",
      PermitSingle: "0xf3841cd1ff0085026a6327b620b67997ce40f282c88a8e905a7a5626e310f3d0",
      PermitTransferFrom: "0x939c21a48a8dbe3a9a2404a1d46691e4d39f6583d6ec6b35714604c986d80106",
    },
  };
  for (const doc of [erc2612, daiPermit, permit2]) {
    const v = await validateProfile(doc, { validateSchema, resolved: true });
    assert.equal(v.ok, true, JSON.stringify(v.diagnostics));
    assert.deepEqual(v.diagnostics.filter((d) => d.severity !== "info"), [], doc.name);
    const { messages } = v.resolved;
    assert.deepEqual(Object.fromEntries(Object.entries(messages).map(([k, m]) => [k, m.type_hash])), expected[doc.name], doc.name);
    for (const [name, m] of Object.entries(messages)) {
      assert.equal(m.encode_type, encodeType(doc.binds.eip712.types, name));
      assert.equal(v.resolved.methods[name], undefined, `${name} is a message, not a method`);
    }
  }
  const p2 = (await validateProfile(permit2, { validateSchema, resolved: true })).resolved;
  assert.deepEqual(p2.methods, {});
  assert.deepEqual(p2.profiles[0].eip712_domain, { name: "Permit2" });
  assert.deepEqual(p2.messages.PermitBatch.tags.effect.args, { kind: "approve", irreversible: false });
  assert.deepEqual(p2.messages.PermitTransferFrom.tags.effect.args, { kind: "transfer", irreversible: true, grant: { spender: "spender", amount: "permitted.amount", ends: ["deadline"] } });
  const details = p2.messages.PermitBatch.args[0].fields.details;
  assert.deepEqual([details.abi, details.element.abi, details.element.fields.amount.abi], ["array", "tuple", "uint160"]);
  assert.deepEqual(details.element.fields.amount.tags.amount.args, { token: "details[].token", threshold: "1461501637330902918203684832716283019655932542975" });
  assert.deepEqual(details.element.fields.expiration.tags.timestamp.args, { unit: "s", epoch: "unix", threshold: "281474976710655", message: "Never", labels: { 0: "Only in the block it is used" } });
  const dai = (await validateProfile(daiPermit, { validateSchema, resolved: true })).resolved;
  assert.deepEqual(dai.profiles[0].eip712_domain, { name: "Dai Stablecoin", version: "1" });
  // a message with no intent is a type, not a message: PermitDetails is described inside PermitSingle and PermitBatch
  assert.equal(p2.messages.PermitDetails, undefined);
});

const USDC = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "function nonces(address owner) view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
];

test("a pack's messages join the contract it matches; the contract's own interface id ignores them", async () => {
  const plain = await resolveService({ abi: USDC, validateSchema, packs: [{ doc: erc20 }] });
  const r = await resolveService({ abi: USDC, validateSchema, packs: [{ doc: erc20 }, { doc: erc2612 }] });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.deepEqual(r.profiles.map((p) => [p.name, p.status]), [["erc20", "applied"], ["erc2612", "applied"]]);
  assert.equal(plain.resolved.messages, undefined);
  assert.deepEqual(Object.keys(r.resolved.messages), ["Permit"]);
  assert.equal(r.resolved.messages.Permit.args[0].fields.value.tags.amount.args.decimals.from, "query:decimals");
  assert.equal(r.resolved.methods.permit.args[0].fields.deadline.tags.timestamp.args.message, "Never");
  // the pack's types are part of the merged interface's identity, never of the contract's own
  assert.notEqual(r.resolved.interface_id, plain.resolved.interface_id);
  assert.equal(abiInterfaceId(parseAbi(erc20.binds.abi).functions), abiInterfaceId(parseAbi(erc20.binds.abi).functions, {}));
  // the ERC-20 pack's form is the one before EIP-712: its fixture's interface id is unchanged
  const fixture = await readJson("fixtures/erc20.resolved.json");
  assert.equal((await validateProfile(erc20, { validateSchema, resolved: true })).resolved.interface_id, fixture.interface_id);
});

test("two profiles that give one type name two meanings: the later one is refused, never merged", async () => {
  const other = structuredClone(erc2612);
  other.name = "erc2612-variant";
  other.binds.eip712.types.Permit = other.binds.eip712.types.Permit.filter((m) => m.name !== "nonce");
  const r = await resolveService({ abi: USDC, validateSchema, packs: [{ doc: erc2612 }, { doc: other }] });
  assert.deepEqual(r.profiles.map((p) => [p.name, p.status]), [["erc2612", "applied"], ["erc2612-variant", "invalid"]]);
  assert.match(r.diagnostics.find((d) => d.code === "E_EIP712").message, /Permit/);
  assert.equal(r.resolved.messages.Permit.type_hash, "0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9");
});

const ORDERS = {
  Order: [
    { name: "maker", type: "address" },
    { name: "legs", type: "Leg[]" },
    { name: "pay", type: "Leg" },
    { name: "deadline", type: "uint256" },
  ],
  Leg: [
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
  ],
};
const orders = (annotations, binds = {}) => ({
  format: "candid-profile",
  format_version: 0,
  kind: "contract",
  name: "orders",
  origin: "author",
  binds: { eip712: { domain: { name: "Orders" }, types: ORDERS }, deployments: [{ chain_id: 1, address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }], ...binds },
  annotations: [{ at: "Order", tag: "intent", args: { title: "Sign an order", template: "Order by {maker}" } }, { at: "Order", tag: "effect", args: { kind: "transfer", irreversible: true } }, ...annotations],
});

test("an amount in the token a field names: the field is an address in the same argument and the same array element", async () => {
  const ok = await validateProfile(
    orders([
      { at: "Order(0).legs[].amount", tag: "amount", args: { token: "legs[].token" } },
      { at: "Order(0).pay.amount", tag: "amount", args: { token: "pay.token", threshold: "100", message: "Everything" } },
      { at: "Order(0).deadline", tag: "timestamp", args: { unit: "s", epoch: "unix", threshold: "100", message: "Never", labels: { 0: "Now" } } },
    ]),
    { validateSchema, resolved: true },
  );
  assert.equal(ok.ok, true, JSON.stringify(ok.diagnostics));
  assert.deepEqual(Object.keys(ok.resolved.messages), ["Order"]);
  for (const [at, token, why] of [
    ["Order(0).legs[].amount", "maker", null], // outside the array: the same token for every element
    ["Order(0).legs[].amount", "pay.token", null],
    ["Order(0).pay.amount", "legs[].token", /must be in the same array element as the amount/],
    ["Order(0).legs[].amount", "legs[].nope", /legs\[\]\.nope/],
    ["Order(0).legs[].amount", "deadline", /is uint256, not an address/],
  ]) {
    const v = await validateProfile(orders([{ at, tag: "amount", args: { token } }]), { validateSchema });
    if (why === null) {
      assert.deepEqual(errors(v), [], token);
      continue;
    }
    assert.deepEqual(errors(v), [["E_TOKEN_PATH", at]], token);
    assert.match(v.diagnostics.find((d) => d.code === "E_TOKEN_PATH").message, why);
  }
  // decimals and symbol come from the token, so neither may be given with it; the schema says so
  const both = await validateProfile(orders([{ at: "Order(0).pay.amount", tag: "amount", args: { token: "pay.token", decimals: 6 } }]), { validateSchema });
  assert.deepEqual([...new Set(errors(both).map(([c]) => c))], ["E_SCHEMA"]);
  // a Candid amount's ledger cannot be named by a field yet (OQ-6)
  const canister = { format: "candid-profile", format_version: 0, kind: "canister", name: "c", origin: "author", binds: { interface_id: `candid-core:interface:v1:sha256:${"0".repeat(64)}` }, annotations: [{ at: "f(0).amount", tag: "amount", args: { token: "ledger" } }] };
  const r = await resolveService({ did: "service : { f : (record { amount : nat; ledger : principal }) -> () }", validateSchema, profiles: [{ doc: canister }] });
  assert.ok(r.diagnostics.some((d) => d.code === "E_TOKEN_PATH" && /OQ-6/.test(d.message)), JSON.stringify(r.diagnostics));
});

test("a timestamp's words: a threshold and its message come together, labels name exact values", async () => {
  for (const args of [
    { unit: "s", threshold: "100" },
    { unit: "s", message: "Never" },
    { unit: "s", threshold: "01", message: "Never" },
    { unit: "s", labels: {} },
    { unit: "s", labels: { "-1": "Before" } },
    { unit: "s", labels: { 0: "" } },
  ]) {
    const v = await validateProfile(orders([{ at: "Order(0).deadline", tag: "timestamp", args }]), { validateSchema });
    assert.deepEqual([...new Set(errors(v).map(([c]) => c))], ["E_SCHEMA"], JSON.stringify(args));
  }
});

test("a message is a type the same document gives an intent; it shares no name with a function and runs nothing", async () => {
  // a contract may bind messages only, functions only, or both
  const both = await validateProfile(orders([], { abi: ["function cancel(uint256 nonce)"] }), { validateSchema, resolved: true });
  assert.equal(both.ok, true, JSON.stringify(both.diagnostics));
  assert.deepEqual([Object.keys(both.resolved.methods), Object.keys(both.resolved.messages)], [["cancel"], ["Order"]]);
  const clash = await validateProfile(orders([], { abi: ["function Order(uint256 nonce)"] }), { validateSchema });
  assert.deepEqual(errors(clash), [["E_EIP712", "binds.eip712.types.Order"]]);
  const neither = await validateProfile({ ...orders([]), binds: { deployments: [] } }, { validateSchema });
  assert.deepEqual([...new Set(errors(neither).map(([c]) => c))], ["E_SCHEMA"]);
  const doc = orders([]);
  doc.annotations[1].args.replicated = true;
  const replicated = await validateProfile(doc, { validateSchema });
  assert.ok(errors(replicated).some(([c]) => c === "E_EFFECT_MODE"), JSON.stringify(replicated.diagnostics));
  // a type without an intent is no message: other tags may describe it only inside a message
  const untagged = await validateProfile(orders([{ at: "Leg", tag: "describe", args: { label: "Leg" } }]), { validateSchema });
  assert.deepEqual(errors(untagged), [["E_ADDR_UNRESOLVED", "Leg"]]);
  // and types with no message and no function describe nothing
  const none = await validateProfile({ ...orders([]), annotations: [{ at: "Leg", tag: "describe", args: { label: "Leg" } }] }, { validateSchema });
  assert.deepEqual(errors(none), [["E_EIP712", "binds.eip712.types"]]);
  assert.match(untagged.diagnostics.find((d) => d.code === "E_ADDR_UNRESOLVED").message, /EIP-712 type but not a message/);
  // the types a profile gives must parse; the errors carry the schema-valid but refused types' places
  const bad = await validateProfile(orders([], { eip712: { types: { ...ORDERS, Leg: [{ name: "token", type: "address" }, { name: "amount", type: "uint" }] } } }), { validateSchema });
  assert.deepEqual(errors(bad).filter(([c]) => c === "E_EIP712"), [["E_EIP712", "binds.eip712.types.Leg[1]"], ["E_EIP712", "binds.eip712.types.Order"]]);
});
