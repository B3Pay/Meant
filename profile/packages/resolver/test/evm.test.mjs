// EVM contracts (spec section 15, D-054): Keccak-256, ABI fragments and calldata, EIP-55, EIP-712, contract profiles
// and packs matched by selector. Unit tests only: no chain, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { HERE, LEDGER_DID, readJson, validateSchema } from "./helpers.mjs";
import { resolveService, validateProfile } from "../src/index.mjs";
import * as evm from "../src/evm.mjs";

const { keccak256Hex, parseAbi, abiInterfaceId, decodeParams, encodeParams, encodeCall, toChecksumAddress, readAddress, typedDataDigest, parseSignature } = evm;
const erc20 = await readJson("packs/erc20.profile.json");
const hex = (b) => Buffer.from(b).toString("hex");
const fromHex = (h) => Uint8Array.from(Buffer.from(h, "hex"));
const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return null;
};

test("Keccak-256: the empty string, the ERC-20 selectors, the ERC-8176 schema UID, and inputs at the block boundary", () => {
  assert.equal(keccak256Hex(""), "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  for (const [sig, sel] of [
    ["transfer(address,uint256)", "a9059cbb"],
    ["approve(address,uint256)", "095ea7b3"],
    ["transferFrom(address,address,uint256)", "23b872dd"],
    ["decimals()", "313ce567"],
    ["symbol()", "95d89b41"],
    ["balanceOf(address)", "70a08231"],
    ["allowance(address,address)", "dd62ed3e"],
  ]) assert.equal(keccak256Hex(sig).slice(0, 8), sel, sig);
  // ERC-8176: keccak256(abi.encodePacked("bytes32 descriptorHash", address(0), true))
  const packed = new Uint8Array([...new TextEncoder().encode("bytes32 descriptorHash"), ...new Uint8Array(20), 1]);
  assert.equal(keccak256Hex(packed), "e023eef113c1670774801c34b377fdf612dd8a4d2fa92fe382e15bd91fafb5c2");
  // 135 bytes puts both padding bits in one byte; 136 needs a second block. Values from an independent Python
  // implementation of the Keccak reference description.
  assert.equal(keccak256Hex(new Uint8Array(135)), "29e3704feeca7fb9ba229f0fa04d9b36449cf3ad6e1d85d9cfff3a10df9abc3e");
  assert.equal(keccak256Hex(new Uint8Array(136)), "3a5912a7c5faa06ee4fe906253e339467a9ce87d533c65be3c15cb231cdb25f9");
  assert.equal(keccak256Hex("a".repeat(200)), "96ea54061def936c4be90b518992fdc6f12f535068a256229aca54267b4d084d");
});

test("EIP-55: the EIP's examples check, mixed case must match, one case carries no checksum", () => {
  for (const a of ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359", "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB", "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb"]) {
    assert.equal(toChecksumAddress(a.toLowerCase()), a);
    assert.equal(readAddress(a), a);
    assert.equal(readAddress(a.toLowerCase()), a);
    assert.equal(readAddress(`0x${a.slice(2).toUpperCase()}`), a);
  }
  assert.equal(codeOf(() => readAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD")), "E_ADDRESS_CHECKSUM");
  assert.equal(codeOf(() => readAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beae")), "E_ADDRESS");
});

test("EIP-712: the digest of the EIP's Mail example", () => {
  const typed = {
    types: { Person: [{ name: "name", type: "string" }, { name: "wallet", type: "address" }], Mail: [{ name: "from", type: "Person" }, { name: "to", type: "Person" }, { name: "contents", type: "string" }] },
    primaryType: "Mail",
    domain: { name: "Ether Mail", version: "1", chainId: 1, verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC" },
    message: { from: { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" }, to: { name: "Bob", wallet: "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB" }, contents: "Hello, Bob!" },
  };
  assert.equal(typedDataDigest(typed), "0xbe609aee343fb3c4b28e1df9e632fca64fcfaede20f02e86244efddf30957bd2");
  assert.equal(codeOf(() => typedDataDigest({ ...typed, message: { ...typed.message, extra: 1 } })), "E_ABI_ENCODE");
});

test("fragments: human-readable and JSON entries read to one canonical form; only functions are read", () => {
  const text = parseAbi([
    "function transfer(address to, uint value) external returns (bool ok)",
    "function submit((address token, uint256 amount)[] memory orders, bytes32 salt) payable",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "error Nope(uint256 code)",
  ]);
  const json = parseAbi([
    { type: "event", name: "Transfer", inputs: [] },
    { type: "function", name: "submit", stateMutability: "payable", inputs: [{ name: "orders", type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }] }, { name: "salt", type: "bytes32" }], outputs: [] },
    { name: "transfer", constant: false, inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "ok", type: "bool" }] },
  ]);
  assert.deepEqual(text.errors, []);
  assert.deepEqual(json.errors, []);
  assert.deepEqual(text.functions.map((f) => f.canonical), ["function submit((address token,uint256 amount)[] orders,bytes32 salt) payable", "function transfer(address to,uint256 value) returns (bool ok)"]);
  assert.deepEqual(json.functions.map((f) => f.canonical), text.functions.map((f) => f.canonical));
  assert.equal(text.functions[0].signature, "submit((address token,uint256 amount)[] orders,bytes32 salt)");
  assert.equal(text.functions[0].typeSignature, "submit((address,uint256)[],bytes32)");
  assert.equal(abiInterfaceId(text.functions), abiInterfaceId([...json.functions].reverse()));
  assert.match(abiInterfaceId(text.functions), /^candid-profile:evm-abi:v0:sha256:[0-9a-f]{64}$/);
  assert.equal(parseSignature("submit((address token,uint256 amount)[] orders,bytes32 salt)").selector, text.functions[0].selector);
});

test("fragments that are refused, each with its place", () => {
  const { errors } = parseAbi([
    "function a(uint7 x)",
    "function b(fixed128x18 x)",
    "function c(function f)",
    "function d(uint256 $x)",
    "function e(uint256 x, uint256 x)",
    "function f(uint256[0] xs)",
    "function g(uint256 x)",
    "function g(address x)",
    "function h(uint256 x) view pure",
    "transfer(address,uint256)",
  ]);
  assert.deepEqual(errors.map((e) => e.at), ["abi[0]", "abi[1]", "abi[2]", "abi[3]", "abi[4]", "abi[5]", "abi[8]", "abi[9]", "abi[7]"]);
  assert.match(errors.at(-1).message, /overloaded .* \(spec section 15, O1\)/);
});

test("the codec round-trips nested values and refuses every non-canonical encoding", () => {
  const [f] = parseAbi(["function m(uint256[] xs, (address a, string s)[2] ps, bytes b, int8 i, bool ok, bytes4 tag)"]).functions;
  const values = { xs: ["1", "2"], ps: [{ a: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", s: "hé" }, { a: "0x0000000000000000000000000000000000000001", s: "" }], b: fromHex("010203"), i: "-5", ok: true, tag: fromHex("deadbeef") };
  const data = encodeParams(f.inputs, values);
  assert.deepEqual(decodeParams(f.inputs, data), values);
  const flip = (at, byte) => {
    const d = data.slice();
    d[at] = byte;
    return d;
  };
  for (const [what, bad] of [
    ["a non-canonical offset", flip(31, 0xe0)],
    ["a trailing byte", new Uint8Array([...data, 0])],
    ["a truncated value", data.slice(0, data.length - 1)],
    ["bool 2", flip(4 * 32 + 31, 2)],
    ["int8 outside its range", flip(3 * 32 + 30, 0x00)],
  ]) assert.equal(codeOf(() => decodeParams(f.inputs, bad)), "E_ABI_DECODE", what);
  const [t] = parseAbi(["function transfer(address to, uint256 value)"]).functions;
  const call = encodeCall(t, { to: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", value: 1000n });
  assert.equal(hex(call), "a9059cbb0000000000000000000000005aaeb6053f3e94c9b9a09f33669435e7ef1beaed00000000000000000000000000000000000000000000000000000000000003e8");
  const dirty = call.slice(4);
  dirty[0] = 1; // a byte above the 20 of the address
  assert.equal(codeOf(() => decodeParams(t.inputs, dirty)), "E_ABI_DECODE");
  // a JavaScript number is never an integer value (D-006); a length beyond the data is refused before anything is read
  assert.equal(codeOf(() => encodeParams(t.inputs, { to: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", value: 5 })), "E_ABI_ENCODE");
  const [g] = parseAbi(["function g(uint256[] xs)"]).functions;
  const huge = fromHex(`${"20".padStart(64, "0")}${"ff".repeat(32)}`);
  assert.equal(codeOf(() => decodeParams(g.inputs, huge)), "E_ABI_DECODE");
});

const WETH = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address, address) view returns (uint256)",
  "function transfer(address dst, uint wad) returns (bool)",
  "function approve(address guy, uint wad) returns (bool)",
  "function transferFrom(address src, address dst, uint wad) returns (bool)",
  "function deposit() payable",
  "function withdraw(uint wad)",
  "event Transfer(address indexed src, address indexed dst, uint wad)",
];

test("the ERC-20 pack applies by selector, and its addresses and templates take the contract's parameter names", async () => {
  const r = await resolveService({ abi: WETH, validateSchema, packs: [{ doc: erc20 }] });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.deepEqual(r.profiles.map((p) => [p.name, p.status]), [["erc20", "applied"]]);
  const { methods } = r.resolved;
  assert.equal(r.resolved.chain, "evm");
  assert.equal(methods.transfer.selector, "0xa9059cbb");
  assert.equal(methods.transfer.signature, "transfer(address dst,uint256 wad)");
  assert.equal(methods.transfer.tags.intent.args.template, "Send {wad} to {dst}");
  assert.equal(methods.transferFrom.tags.intent.args.template, "Move {wad} from {src} to {dst} using an allowance");
  assert.equal(methods.transfer.args[0].fields.dst.tags.describe.args.label, "Recipient");
  assert.deepEqual(methods.transfer.args[0].fields.wad.tags.amount.args, { decimals: { from: "query:decimals" }, symbol: { from: "query:symbol" } });
  assert.equal(methods.approve.args[0].fields.wad.tags.amount.args.message, "Unlimited");
  assert.deepEqual(Object.keys(methods.balanceOf.args[0].fields), ["#0"]);
  assert.equal(methods.balanceOf.args[0].fields["#0"].tags.describe.args.label, "Owner");
  assert.deepEqual(methods.deposit.tags.effect.args, { kind: "write", irreversible: true }); // the default; payable has no position yet (O2)
  assert.deepEqual(methods.decimals.args, []);
  assert.deepEqual(methods.decimals.results, [{ abi: "uint8" }]);
  // The pack's own names give the same resolved form, but for the names.
  const own = await validateProfile(erc20, { validateSchema, resolved: true });
  assert.equal(own.ok, true, JSON.stringify(own.diagnostics));
  assert.equal(own.resolved.methods.transfer.tags.intent.args.template, "Send {value} to {to}");
});

test("a contract the pack does not fit is not matched: a missing function, other outputs, another kind of call", async () => {
  const cases = [
    [WETH.filter((f) => !f.includes("symbol")), /no function symbol\(\) \(selector 0x95d89b41\)/],
    [WETH.map((f) => f.replace("function symbol() view returns (string)", "function symbol() view returns (bytes32)")), /symbol: returns \(bytes32\), the pack's \(string\)/],
    [WETH.map((f) => f.replace("function transfer(address dst, uint wad) returns (bool)", "function transfer(address dst, uint wad) payable returns (bool)")), /transfer: is payable, the pack's not payable/],
  ];
  for (const [abi, why] of cases) {
    const r = await resolveService({ abi, validateSchema, packs: [{ doc: erc20 }] });
    assert.deepEqual(r.profiles.map((p) => p.status), ["not_matched"]);
    assert.match(r.diagnostics.find((d) => d.code === "I_PACK_NOT_MATCHED").message, why);
    const explicit = await resolveService({ abi, validateSchema, profiles: [{ doc: erc20 }] });
    assert.equal(explicit.ok, false);
    assert.equal(explicit.diagnostics.filter((d) => d.code === "E_PACK_NOT_MATCHED").length, 1);
  }
});

const VAULT = ["function deposit(uint256 assets, address receiver) returns (uint256 shares)", "function asset() view returns (address)", "function decimals() view returns (uint8)", "function batch((address to, uint64 deadline)[3] legs, bytes data)", "function label() view returns (bytes32)"];
const contract = (annotations, binds = {}) => ({ format: "candid-profile", format_version: 0, kind: "contract", name: "vault", origin: "author", binds: { abi: VAULT, ...binds }, annotations });
const effect = { at: "deposit", tag: "effect", args: { kind: "transfer", irreversible: true } };

test("a contract profile carries its ABI and its deployments, and checks against them", async () => {
  const doc = contract(
    [
      effect,
      { at: "deposit", tag: "intent", args: { title: "Deposit", template: "Deposit {assets} for {receiver}" } },
      { at: "deposit(0).assets", tag: "amount", args: { decimals: { from: "query:decimals" }, symbol: "USDC" } },
      { at: "batch(0).legs[].deadline", tag: "timestamp", args: { unit: "s", epoch: "unix" } },
      { at: "batch(0).data", tag: "bytes", args: { encoding: "hex" } },
    ],
    { deployments: [{ chain_id: 1, address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }] },
  );
  const v = await validateProfile(doc, { validateSchema, resolved: true });
  assert.equal(v.ok, true, JSON.stringify(v.diagnostics));
  const batch = v.resolved.methods.batch.args[0].fields.legs;
  assert.deepEqual([batch.abi, batch.length, batch.element.abi, batch.element.fields.deadline.abi], ["array", 3, "tuple", "uint64"]);
  assert.deepEqual(v.resolved.profiles[0].deployments, [{ chain_id: 1, address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }]);
  // the same profile through resolveService, against the same ABI given as the interface
  const r = await resolveService({ abi: VAULT, validateSchema, profiles: [{ doc }] });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  assert.deepEqual(r.profiles.map((p) => p.status), ["applied"]);
  // a mixed-case address must match its checksum
  const bad = contract([effect], { deployments: [{ chain_id: 1, address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD" }] });
  const b = await validateProfile(bad, { validateSchema });
  assert.deepEqual(b.diagnostics.filter((d) => d.severity !== "info").map((d) => [d.code, d.at]), [["E_ADDRESS_CHECKSUM", "binds.deployments[0].address"]]);
});

test("on a contract: idempotency, outcome and names wait for a later phase, ICRC tags and [ ] segments do not apply", async () => {
  for (const [a, code, why] of [
    [{ at: "deposit", tag: "outcome", args: { default: "success" } }, "E_TAG_TARGET", /not defined for EVM contracts yet/],
    [{ at: "deposit", tag: "idempotency", args: { mode: "replay_same_payload", stamp: "receiver" } }, "E_TAG_TARGET", /not defined for EVM contracts yet/],
    [{ at: "deposit(0).receiver", tag: "account", args: { encoding: "icrc1" } }, "E_TAG_NOT_APPLICABLE", /ICRC type/],
    [{ at: "label->(0)", tag: "subaccount", args: {} }, "E_TAG_NOT_APPLICABLE", /ICRC type/],
    [{ at: "deposit(0).receiver", tag: "amount", args: { decimals: 6 } }, "E_TAG_NOT_APPLICABLE", /found address/],
    [{ at: "deposit", tag: "intent", args: { title: "Deposit", template: "Deposit {assets}[ for {receiver}]" } }, "E_TEMPLATE", /no \[ \] segments/],
    [{ at: "deposit(0).assets", tag: "amount", args: { decimals: { from: "query:label" } } }, "E_REF_TYPE", /returns bytes32, expected a number/],
    [{ at: "type:Order.to", tag: "describe", args: { label: "To" } }, "E_ADDR_UNRESOLVED", /no declaration/],
  ]) {
    const v = await validateProfile(contract([effect, a]), { validateSchema });
    assert.deepEqual(v.diagnostics.filter((d) => d.severity === "error").map((d) => d.code), [code], `${a.tag} at ${a.at}: ${JSON.stringify(v.diagnostics)}`);
    assert.match(v.diagnostics.find((d) => d.code === code).message, why);
  }
});

test("a contract profile whose ABI differs from the contract's is rebound, and stale when an address breaks", async () => {
  const doc = contract([effect, { at: "deposit(0).assets", tag: "amount", args: { decimals: 6 } }]);
  const renamed = VAULT.map((f) => f.replace("uint256 assets", "uint256 amount"));
  const r = await resolveService({ abi: renamed, validateSchema, profiles: [{ doc }] });
  assert.deepEqual(r.profiles.map((p) => p.status), ["stale"]);
  assert.ok(r.diagnostics.some((d) => d.code === "W_REBOUND"));
  const added = [...VAULT, "function pause()"];
  const ok = await resolveService({ abi: added, validateSchema, profiles: [{ doc }] });
  assert.deepEqual(ok.profiles.map((p) => p.status), ["rebound"]);
});

test("profiles and packs of the other chain: an error when given, skipped in a pack search", async () => {
  const canister = { format: "candid-profile", format_version: 0, kind: "canister", name: "c", origin: "author", binds: { interface_id: `candid-core:interface:v1:sha256:${"0".repeat(64)}` }, annotations: [{ at: "x", tag: "describe", args: { label: "X" } }] };
  let r = await resolveService({ abi: VAULT, validateSchema, profiles: [{ doc: canister }] });
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code), ["E_CHAIN"]);
  r = await resolveService({ did: LEDGER_DID, validateSchema, profiles: [{ doc: contract([effect]) }] });
  assert.deepEqual(r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code), ["E_CHAIN"]);
  r = await resolveService({ did: LEDGER_DID, validateSchema, packs: [{ doc: erc20 }] });
  assert.deepEqual(r.profiles, []);
  assert.deepEqual(r.diagnostics.filter((d) => d.profile === "erc20"), []);
  r = await resolveService({ abi: ["function nope(uint7 x)"], validateSchema });
  assert.equal(r.resolved, null);
  assert.deepEqual(r.diagnostics.map((d) => [d.code, d.at]), [["E_ABI", "abi[0]"]]);
});

test("candid-profile resolve --abi", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cp-evm-"));
  const file = path.join(dir, "weth.json");
  await writeFile(file, JSON.stringify(WETH));
  const { stdout, stderr } = await promisify(execFile)("node", [path.join(HERE, "../bin/candid-profile.mjs"), "resolve", "--abi", file, "--packs"]);
  const resolved = JSON.parse(stdout);
  assert.equal(resolved.chain, "evm");
  assert.equal(resolved.methods.approve.tags.intent.args.template, "Set {guy}'s allowance to {wad}, replacing any existing allowance");
  assert.match(stderr, /applied\s+erc20/);
  assert.doesNotMatch(stderr, /icrc1/);
});
