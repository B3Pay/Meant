// The ERC-7730 export and the ERC-8176 attestation (spec section 15, D-054). Every exported file is checked against the
// vendored ERC-7730 2.1.0 JSON Schema (test/upstream/erc7730/, CC0), the one its `$schema` names. The descriptor hashes
// and attestation digests pinned below were computed by an independent Python implementation (Keccak-256 from the
// reference description, JCS as json.dumps with sorted keys and no spaces, EIP-712 from the EIP's text), not by this
// package. No chain, no network, nothing signed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { createSchemaValidator, resolveService, validateProfile } from "@meantjs/profile";
import { readAddress, toChecksumAddress } from "@meantjs/profile/evm";
import { EAS_ADDRESS, ERC7730_SCHEMA_URL, ERC8176_SCHEMA_UID, descriptorHash, erc7730Descriptor, erc8176Attestation } from "../src/erc7730.mjs";
import { CODES } from "../src/index.mjs";
import { icrc1, sha256 } from "./helpers.mjs";

const validateSchema = await createSchemaValidator();
const erc20 = JSON.parse(readFileSync(new URL("../../../packs/erc20.profile.json", import.meta.url), "utf8"));
const upstream = (name) => readFileSync(new URL(`./upstream/erc7730/${name}`, import.meta.url), "utf8");

const schemaText = upstream("erc7730-v2.1.0.schema.json");
const source = JSON.parse(upstream("SOURCE.json"));
const ajv = new Ajv2020({
  strict: false, // the schema keeps its definitions under non-keyword roots ($context, $display, ...)
  allErrors: true,
  formats: {
    "uri-reference": true,
    uri: true,
    "date-time": true,
    eip55: (s) => {
      try {
        return readAddress(s) === s;
      } catch {
        return false;
      }
    },
    eip155: { type: "number", validate: (n) => Number.isSafeInteger(n) && n > 0 },
  },
});
const validateErc7730 = ajv.compile(JSON.parse(schemaText));
const assertValid = (descriptor) => assert.equal(validateErc7730(descriptor), true, JSON.stringify(validateErc7730.errors, null, 1));

const resolveAbi = async (abi, opts) => {
  const r = await resolveService({ abi, validateSchema, ...opts });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  return r.resolved;
};
const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return `${e.code}: ${e.message}`;
  }
  return null;
};

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
];
const CONTRACT = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const MAX = "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

test("the vendored schema is the one SOURCE.json records, and the constants are what the ERCs say", () => {
  assert.equal(sha256(schemaText), source.files["erc7730-v2.1.0.schema.json"].sha256);
  assert.equal(sha256(upstream("LICENSE.md")), source.files["LICENSE.md"].sha256);
  assert.equal(JSON.parse(schemaText).version, "2.1.0");
  assert.equal(source.files["erc7730-v2.1.0.schema.json"].published_at, ERC7730_SCHEMA_URL);
  assert.equal(toChecksumAddress(EAS_ADDRESS.toLowerCase()), EAS_ADDRESS);
  assert.equal(ERC8176_SCHEMA_UID, "0xe023eef113c1670774801c34b377fdf612dd8a4d2fa92fe382e15bd91fafb5c2");
});

test("the ERC-20 pack on WETH: one entry per function a transaction calls, in the contract's names", async () => {
  const weth = await resolveAbi(WETH, { packs: [{ doc: erc20 }] });
  const { descriptor, descriptorHash: hash } = erc7730Descriptor(weth, { deployments: [{ chainId: 1, address: CONTRACT.toLowerCase() }], owner: "WETH" });
  const amount = (label, extra = {}) => ({ path: "wad", label, format: "tokenAmount", params: { tokenPath: "@.to", ...extra } });
  assert.deepEqual(descriptor, {
    $schema: ERC7730_SCHEMA_URL,
    context: { contract: { deployments: [{ chainId: 1, address: CONTRACT }] } },
    metadata: { owner: "WETH" },
    display: {
      formats: {
        "approve(address guy,uint256 wad)": {
          intent: "Approve spending",
          interpolatedIntent: "Set {guy}'s allowance to {wad}, replacing any existing allowance",
          fields: [{ path: "guy", label: "Spender", format: "addressName" }, amount("Allowance", { threshold: MAX, message: "Unlimited" })],
        },
        "deposit()": { intent: "Call deposit", fields: [{ path: "@.value", label: "Value sent", format: "amount" }] },
        "transfer(address dst,uint256 wad)": {
          intent: "Send tokens",
          interpolatedIntent: "Send {wad} to {dst}",
          fields: [{ path: "dst", label: "Recipient", format: "addressName" }, amount("Amount")],
        },
        "transferFrom(address src,address dst,uint256 wad)": {
          intent: "Transfer using allowance",
          interpolatedIntent: "Move {wad} from {src} to {dst} using an allowance",
          fields: [{ path: "src", label: "From", format: "addressName" }, { path: "dst", label: "Recipient", format: "addressName" }, amount("Amount")],
        },
        "withdraw(uint256 wad)": { intent: "Call withdraw", fields: [{ path: "wad", label: "wad", format: "raw" }] },
      },
    },
  });
  assertValid(descriptor);
  const broken = structuredClone(descriptor); // the schema check is not vacuous: an entry without an intent fails it
  delete broken.display.formats["deposit()"].intent;
  assert.equal(validateErc7730(broken), false);
  assert.equal(hash, "0x337fe0837182953afc999685ef158cb02dd5a5625eb404e15e38dbd6ec7edcb6");
  assert.equal(descriptorHash(descriptor), hash);
  // the same input, the same bytes; and the hash covers every byte
  assert.equal(erc7730Descriptor(weth, { deployments: [{ chainId: 1, address: CONTRACT }], owner: "WETH" }).descriptorHash, hash);
  assert.notEqual(erc7730Descriptor(weth, { deployments: [{ chainId: 1, address: CONTRACT }], owner: "WETH9" }).descriptorHash, hash);
});

const LOCKER = [
  "function lock(uint256 amount, uint64 until, (address to, uint32 period)[] legs, bytes memo) payable",
  "function release(bytes32 id)",
  "function locked(address owner) view returns (uint256)",
];
const DEPLOYMENTS = [
  { chain_id: 1, address: CONTRACT },
  { chain_id: 10, address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
];
const locker = (annotations, binds = {}) => ({ format: "candid-profile", format_version: 0, kind: "contract", name: "locker", origin: "author", binds: { abi: LOCKER, deployments: DEPLOYMENTS, ...binds }, annotations });
const LOCK = [
  { at: "lock", tag: "intent", args: { title: "Lock tokens", template: "Lock {amount} until {(0).until} ([[beta]] {{v1}})" } },
  { at: "lock", tag: "effect", args: { kind: "transfer", irreversible: true } },
  { at: "lock(0).amount", tag: "amount", args: { decimals: 6, symbol: "TKN" } },
  { at: "lock(0).until", tag: "timestamp", args: { unit: "s", epoch: "unix" } },
  { at: "lock(0).legs[].period", tag: "duration", args: { unit: "s" } },
  { at: "lock(0).legs[].to", tag: "describe", args: { label: "Leg recipient" } },
  { at: "lock(0).memo", tag: "bytes", args: { encoding: "hex" } },
  { at: "release", tag: "describe", args: { label: "Release a lock" } },
];
const resolveLocker = async (annotations, binds) => (await validateProfile(locker(annotations, binds), { validateSchema, resolved: true })).resolved;

test("a contract profile: literal token, dates, durations, arrays, hex bytes, escapes, the payable value", async () => {
  const resolved = await resolveLocker(LOCK);
  const options = { token: { name: "Token" }, contractName: "Locker", info: { url: "https://example.org/" } };
  const { descriptor, descriptorHash: hash } = erc7730Descriptor(resolved, options);
  assert.deepEqual(descriptor, {
    $schema: ERC7730_SCHEMA_URL,
    context: {
      contract: {
        deployments: [
          { chainId: 1, address: CONTRACT },
          { chainId: 10, address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
        ],
      },
    },
    metadata: { contractName: "Locker", info: { url: "https://example.org/" }, token: { name: "Token", ticker: "TKN", decimals: 6 } },
    display: {
      formats: {
        "lock(uint256 amount,uint64 until,(address to,uint32 period)[] legs,bytes memo)": {
          intent: "Lock tokens",
          interpolatedIntent: "Lock {amount} until {until} ([beta] {{v1}})",
          fields: [
            { path: "amount", label: "amount", format: "tokenAmount", params: { tokenPath: "@.to" } },
            { path: "until", label: "until", format: "date", params: { encoding: "timestamp" } },
            { path: "legs.[].to", label: "Leg recipient", format: "addressName" },
            { path: "legs.[].period", label: "period", format: "duration" },
            { path: "memo", label: "memo", format: "raw" },
            { path: "@.value", label: "Value sent", format: "amount" },
          ],
        },
        "release(bytes32 id)": { intent: "Release a lock", fields: [{ path: "id", label: "id", format: "raw" }] },
      },
    },
  });
  assertValid(descriptor);
  assert.equal(hash, "0x0b6d4fc641320015462ef1a218a60ec8780f0ddfee8ebe8e31aa2aff8faa9e2d");
  // a subset of the listed deployments may be asked for; one the profile does not list may not
  assert.deepEqual(erc7730Descriptor(resolved, { ...options, deployments: [{ chainId: 10, address: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed" }] }).descriptor.context.contract.deployments, [{ chainId: 10, address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" }]);
  assert.match(codeOf(() => erc7730Descriptor(resolved, { ...options, deployments: [{ chainId: 10, address: CONTRACT }] })), /^E_DEPLOYMENT: profile locker does not list 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 on chain 10/);
});

test("what an ERC-7730 file cannot say is refused, every reason at once, never written as something near it", async () => {
  const refusal = async (annotations, options = { token: { name: "Token" } }) => {
    const resolved = await resolveLocker(annotations);
    return codeOf(() => erc7730Descriptor(resolved, options)) ?? "";
  };
  for (const [annotations, why] of [
    [[{ at: "lock(0).until", tag: "timestamp", args: { unit: "ms" } }], /^E_EXPORT: no ERC-7730 file: lock\(0\)\.until: timestamp in ms: ERC-7730 dates are in seconds$/],
    [[{ at: "lock(0).legs[].period", tag: "duration", args: { unit: "ns" } }], /lock\(0\)\.legs\[\]\.period: duration in ns: ERC-7730 durations are in seconds/],
    [[{ at: "lock(0).memo", tag: "bytes", args: { encoding: "utf8" } }], /lock\(0\)\.memo: bytes as utf8: ERC-7730 shows bytes as hex only/],
    [[{ at: "lock", tag: "intent", args: { title: "Lock", template: "Lock for {legs[].to}" } }], /lock: intent template: \{legs\[\]\.to\} reads every element of an array/],
    [[{ at: "lock", tag: "intent", args: { title: "Lock", template: "Lock {legs}" } }], /\{legs\} is a whole array; an ERC-7730 interpolation shows one formatted field/],
    [[{ at: "lock(0).amount", tag: "amount", args: { decimals: 6 } }], /lock\(0\)\.amount: amount without the contract's own decimals and symbol/],
    [[LOCK[2], { at: "lock(0).until", tag: "amount", args: { decimals: 8, symbol: "TKN" } }], /lock\(0\)\.until: amount in TKN with 8 decimals, where another is in TKN with 6: an ERC-7730 file has one metadata.token/],
    [[{ at: "lock(0).until", tag: "timestamp", args: { unit: "ms" } }, { at: "lock(0).memo", tag: "bytes", args: { encoding: "base64" } }], /^E_EXPORT: no ERC-7730 file: lock\(0\)\.until: timestamp in ms[^;]*; lock\(0\)\.memo: bytes as base64/],
  ]) assert.match(await refusal(annotations), why);
  // a literal token needs the caller to say the contract is that token
  assert.match(await refusal(LOCK, {}), /pass options\.token = \{ name \} if this contract is that token/);
  // decimals read from a function an ERC-7730 wallet does not read
  const ODD = ["function send(address to, uint256 value)", "function scale() view returns (uint8)", "function symbol() view returns (string)"];
  const odd = { format: "candid-profile", format_version: 0, kind: "contract", name: "odd", origin: "author", binds: { abi: ODD, deployments: [{ chain_id: 1, address: CONTRACT }] }, annotations: [{ at: "send(0).value", tag: "amount", args: { decimals: { from: "query:scale" }, symbol: { from: "query:symbol" } } }] };
  const oddResolved = (await validateProfile(odd, { validateSchema, resolved: true })).resolved;
  assert.match(codeOf(() => erc7730Descriptor(oddResolved)), /amount without the contract's own decimals and symbol/);
  // an unnamed parameter: the key and the paths need names
  const unnamed = await resolveAbi(["function f(uint256, address to)"], {});
  assert.match(codeOf(() => erc7730Descriptor(unnamed, { deployments: [{ chainId: 1, address: CONTRACT }] })), /f: parameter #0 has no name/);
  const nested = await resolveAbi(["function g((uint256, address) pair)"], {});
  assert.match(codeOf(() => erc7730Descriptor(nested, { deployments: [{ chainId: 1, address: CONTRACT }] })), /g: parameter pair\.#0 has no name/);
});

test("the export needs an EVM form, deployments and a function to describe; options are checked", async () => {
  const weth = await resolveAbi(WETH, { packs: [{ doc: erc20 }] });
  const deployments = [{ chainId: 1, address: CONTRACT }];
  assert.match(codeOf(() => erc7730Descriptor(icrc1, { deployments })), /^E_RESOLVED_FORM: expected the resolved form of an EVM contract/);
  assert.match(codeOf(() => erc7730Descriptor(weth)), /^E_DEPLOYMENT: an ERC-7730 file binds to deployments/);
  assert.match(codeOf(() => erc7730Descriptor(weth, { deployments: [] })), /^E_REQUEST/);
  assert.match(codeOf(() => erc7730Descriptor(weth, { deployments: [{ chainId: 0, address: CONTRACT }] })), /^E_REQUEST/);
  assert.match(codeOf(() => erc7730Descriptor(weth, { deployments: [{ chainId: 1, address: "0xc02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" }] })), /^E_REQUEST.*EIP-55/);
  assert.match(codeOf(() => erc7730Descriptor(weth, { deployments, owners: "x" })), /^E_REQUEST: unknown option "owners"/);
  assert.match(codeOf(() => erc7730Descriptor(weth, { deployments, info: { url: "" } })), /^E_REQUEST: options.info/);
  assert.match(codeOf(() => erc7730Descriptor(weth, { deployments, token: { name: "W", ticker: "W" } })), /^E_REQUEST: options.token/);
  const views = await resolveAbi(["function a() view returns (uint8)"], {});
  assert.match(codeOf(() => erc7730Descriptor(views, { deployments })), /^E_EXPORT: .*every function is view or pure/);
  assert.match(codeOf(() => descriptorHash({ includes: "base.json" })), /^E_REQUEST: resolve the descriptor's includes first/);
  assert.match(codeOf(() => descriptorHash({ display: { formats: { "f()": { intent: "\ud800" } } } })), /lone surrogate/);
});

test("ERC-8176: the unsigned offchain attestation of a descriptor hash, and its EIP-712 digest", () => {
  // the message of ERC-8176's own example (its descriptorHash and signature are illustrative; the digest is computed)
  const example = {
    descriptorHash: "0x0d7fadf23cc3d0bcfd1b5e3aa6b3da2a7f7e8f3f5f8b7eacd8b4f5fcf3e3d8a0",
    time: 1777630591,
    expirationTime: "1785406591",
    salt: "0x6f489a5fc25fdcd2cd647d8d3ce01e2a7353514db4cd2f19829ede0c2347b3dc",
  };
  const { typedData, digest } = erc8176Attestation(example);
  assert.deepEqual(typedData, {
    domain: { name: "EAS Attestation", version: "0.26", chainId: 1, verifyingContract: EAS_ADDRESS },
    primaryType: "Attest",
    types: {
      Attest: [
        { name: "version", type: "uint16" },
        { name: "schema", type: "bytes32" },
        { name: "recipient", type: "address" },
        { name: "time", type: "uint64" },
        { name: "expirationTime", type: "uint64" },
        { name: "revocable", type: "bool" },
        { name: "refUID", type: "bytes32" },
        { name: "data", type: "bytes" },
        { name: "salt", type: "bytes32" },
      ],
    },
    message: {
      version: 2,
      schema: ERC8176_SCHEMA_UID,
      recipient: "0x0000000000000000000000000000000000000000",
      time: "1777630591",
      expirationTime: "1785406591",
      revocable: true,
      refUID: `0x${"0".repeat(64)}`,
      data: example.descriptorHash,
      salt: example.salt,
    },
  });
  assert.equal(digest, "0x3ae23be5023142e8e3be6cfd6f5c7f7e4ad5133dd3bfa2792c9f79ce06069a63");
  const never = erc8176Attestation({ ...example, time: 1777630591n, expirationTime: 0, salt: `0x${"11".repeat(32)}`, refUID: `0x${"AB".repeat(32)}` });
  assert.equal(never.typedData.message.refUID, `0x${"ab".repeat(32)}`);
  assert.equal(never.digest, "0x3aff87b1ee91de8127e8356d9bdd0ae59ffb0775ea9302da2e0ef8dc5bf122d2");
  for (const [input, why] of [
    [{ ...example, salt: undefined }, /salt must be 0x and 64 hex digits/],
    [{ ...example, descriptorHash: "0x1234" }, /descriptorHash must be/],
    [{ ...example, time: -1 }, /time must be a uint64/],
    [{ ...example, expirationTime: "18446744073709551616" }, /expirationTime must be a uint64/],
    [{ ...example, expirationTime: example.time }, /expirationTime must be 0 or after time/],
    [{ ...example, time: 1.5 }, /time must be a uint64/],
  ]) assert.match(codeOf(() => erc8176Attestation(input)), why);
});
