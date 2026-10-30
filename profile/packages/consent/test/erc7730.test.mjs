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
    [[{ at: "lock", tag: "intent", args: { title: "Lock", template: "Lock for {nope}" } }], /lock: intent template: \{nope\}: /],
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

test("what has no ERC-7730 form but changes no value is left out, with a note: an interpolation, a timestamp's words", async () => {
  const leftOut = async (annotations) => {
    const { descriptor, notes } = erc7730Descriptor(await resolveLocker(annotations), { token: { name: "Token" } });
    assertValid(descriptor);
    return { entry: descriptor.display.formats["lock(uint256 amount,uint64 until,(address to,uint32 period)[] legs,bytes memo)"], notes };
  };
  for (const [template, why] of [
    ["Lock for {legs[].to}", "{legs[].to} reads every element of an array; an ERC-7730 interpolation shows one value"],
    ["Lock {legs}", "{legs} is a whole array; an ERC-7730 interpolation shows one formatted field"],
    ["Lock {amount}[ until {until}]", "an optional [ ] segment has no ERC-7730 form"],
  ]) {
    const { entry, notes } = await leftOut([{ at: "lock", tag: "intent", args: { title: "Lock", template } }]);
    assert.equal(entry.intent, "Lock");
    assert.equal(Object.hasOwn(entry, "interpolatedIntent"), false);
    assert.deepEqual(notes, [`lock: intent template: ${why}; interpolatedIntent is left out`]);
  }
  const { entry, notes } = await leftOut([{ at: "lock(0).until", tag: "timestamp", args: { unit: "s", threshold: "18446744073709551615", message: "Never", labels: { 0: "Now" } } }]);
  assert.deepEqual(entry.fields[1], { path: "until", label: "until", format: "date", params: { encoding: "timestamp" } });
  assert.deepEqual(notes, ["lock(0).until: the timestamp's threshold and labels have no ERC-7730 date form and are left out; the file shows the date"]);
  // the contract-bound files above have no notes
  assert.deepEqual(erc7730Descriptor(await resolveLocker(LOCK), { token: { name: "Token" } }).notes, []);
});

const pack = (name) => JSON.parse(readFileSync(new URL(`../../../packs/${name}.profile.json`, import.meta.url), "utf8"));
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

test("EIP-712 messages: Permit2 as ERC-7730 writes it, a field group per array, formats keyed by encodeType", async () => {
  const resolved = (await validateProfile(pack("permit2"), { validateSchema, resolved: true })).resolved;
  const { descriptor, descriptorHash: hash, notes } = erc7730Descriptor(resolved, { context: "eip712" });
  assertValid(descriptor);
  assert.deepEqual(descriptor.context, { eip712: { domain: { name: "Permit2" }, deployments: [1, 8453, 42161, 84532].map((chainId) => ({ chainId, address: PERMIT2 })) } });
  const formats = descriptor.display.formats;
  assert.deepEqual(Object.keys(formats), [
    "PermitBatch(PermitDetails[] details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)",
    "PermitBatchTransferFrom(TokenPermissions[] permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)",
    "PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)",
    "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)",
  ]);
  for (const [key, m] of Object.entries(resolved.messages)) assert.ok(Object.hasOwn(formats, m.encode_type), key);
  const date = (path, label) => ({ path, label, format: "date", params: { encoding: "timestamp" } });
  const unlimited = { threshold: "0xffffffffffffffffffffffffffffffffffffffff", message: "Unlimited" };
  // the shape of ERC-7730's own PermitBatch example: the token path relative to the group
  assert.deepEqual(formats[Object.keys(formats)[0]], {
    intent: "Permit2: allow spending of several tokens",
    fields: [
      {
        path: "details.[]",
        fields: [
          { path: "token", label: "Token", format: "addressName" },
          { path: "amount", label: "Amount", format: "tokenAmount", params: { tokenPath: "token", ...unlimited } },
          date("expiration", "Allowance expires"),
          { path: "nonce", label: "Nonce", format: "raw" },
        ],
      },
      { path: "spender", label: "Spender", format: "addressName" },
      date("sigDeadline", "Signature expires"),
    ],
  });
  assert.deepEqual(formats[Object.keys(formats)[2]], {
    intent: "Permit2: allow token spending",
    interpolatedIntent: "Let {spender} spend up to {details.amount}. Allowance expires: {details.expiration}. Signature expires: {sigDeadline}.",
    fields: [
      { path: "details.token", label: "Token", format: "addressName" },
      { path: "details.amount", label: "Amount", format: "tokenAmount", params: { tokenPath: "details.token", ...unlimited } },
      date("details.expiration", "Allowance expires"),
      { path: "details.nonce", label: "Nonce", format: "raw" },
      { path: "spender", label: "Spender", format: "addressName" },
      date("sigDeadline", "Signature expires"),
    ],
  });
  // what the file cannot say but changes no value: two interpolations of arrays, six timestamps' words
  assert.equal(notes.length, 8);
  assert.deepEqual(notes.filter((n) => n.includes("interpolatedIntent")), [
    "PermitBatch: intent template: {details[].amount} reads every element of an array; an ERC-7730 interpolation shows one value; interpolatedIntent is left out",
    "PermitBatchTransferFrom: intent template: {permitted[].amount} reads every element of an array; an ERC-7730 interpolation shows one value; interpolatedIntent is left out",
  ]);
  assert.equal(hash, "0x0a1226d12d94b5e92526ea67f5cae15bee9f621b028fdecf60b9ec8cfb8faf4e");
  // a resolved form whose encode_type does not hash to its type_hash is not trusted
  const forged = structuredClone(resolved);
  forged.messages.PermitSingle.encode_type = forged.messages.PermitSingle.encode_type.replace("uint160 amount", "uint256 amount");
  assert.match(codeOf(() => erc7730Descriptor(forged, { context: "eip712" })), /^E_RESOLVED_FORM: messages\.PermitSingle/);
  // the contract context of a profile with messages only has nothing to describe
  assert.match(codeOf(() => erc7730Descriptor(resolved)), /^E_EXPORT: no ERC-7730 file: functions: the contract has no function a transaction calls/);
});

test("EIP-712 messages: DAI's domain with its version; EIP-2612 on a token, whose amounts are in the verifying contract", async () => {
  const dai = (await validateProfile(pack("dai-permit"), { validateSchema, resolved: true })).resolved;
  const d = erc7730Descriptor(dai, { context: "eip712" });
  assertValid(d.descriptor);
  assert.deepEqual(d.descriptor.context.eip712.domain, { name: "Dai Stablecoin", version: "1" });
  assert.equal(d.descriptorHash, "0xe44ae7e666128fa37dd8480cdf594112575481145fbb92a51af90dc1170daac1");
  const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const abi = [...WETH.filter((f) => !/deposit|withdraw/.test(f)), "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)", "function nonces(address owner) view returns (uint256)", "function DOMAIN_SEPARATOR() view returns (bytes32)"].map((f) => f.replace("dst", "to").replace("guy", "spender").replace("src", "from").replaceAll("wad", "value").replace("uint value", "uint256 value"));
  const usdc = await resolveAbi(abi, { packs: [{ doc: erc20 }, { doc: pack("erc2612") }] });
  const e = erc7730Descriptor(usdc, { context: "eip712", deployments: [{ chainId: 1, address: USDC }] });
  assertValid(e.descriptor);
  assert.deepEqual(e.descriptor.context, { eip712: { deployments: [{ chainId: 1, address: USDC }] } }); // the domain is each token's own
  const permit = e.descriptor.display.formats["Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"];
  // for a message, ERC-7730's @.to is the verifying contract: here the token itself
  assert.deepEqual(permit.fields.find((f) => f.path === "value"), { path: "value", label: "Amount", format: "tokenAmount", params: { tokenPath: "@.to", threshold: MAX, message: "Unlimited" } });
  assert.equal(e.descriptorHash, "0x69ea623b5fe133c5f656cde05da8e6f90e381f5bb9655682c6d8a0db54661223");
  // the same resolved form's functions are a file of their own, with permit() among them
  const c = erc7730Descriptor(usdc, { deployments: [{ chainId: 1, address: USDC }] });
  assertValid(c.descriptor);
  assert.ok(Object.hasOwn(c.descriptor.display.formats, "permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)"));
  const weth = await resolveAbi(WETH, { packs: [{ doc: erc20 }] });
  assert.match(codeOf(() => erc7730Descriptor(weth, { context: "eip712", deployments: [{ chainId: 1, address: CONTRACT }] })), /^E_EXPORT: no ERC-7730 file: messages: the resolved form describes no EIP-712 message/);
  assert.match(codeOf(() => erc7730Descriptor(dai, { context: "both" })), /^E_REQUEST: options\.context must be "contract" or "eip712"/);
});

test("x402's Permit2 payment (D-058): the pinned spender is a hidden field that must match, and no interpolation names it", async () => {
  const PROXY = "0x402085c248EeA27D92E8b30b2C58ed07f9E20001";
  const resolved = (await validateProfile(pack("x402-exact-permit2"), { validateSchema, resolved: true })).resolved;
  const { descriptor, descriptorHash: hash, notes } = erc7730Descriptor(resolved, { context: "eip712" });
  assertValid(descriptor);
  assert.deepEqual(descriptor.context, { eip712: { domain: { name: "Permit2" }, deployments: [1, 8453, 42161, 84532].map((chainId) => ({ chainId, address: PERMIT2 })) } });
  const date = (path, label) => ({ path, label, format: "date", params: { encoding: "timestamp" } });
  assert.deepEqual(descriptor.display.formats, {
    "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter)": {
      intent: "Pay by x402 through Permit2",
      interpolatedIntent: "Send {permitted.amount} to {witness.to}, once, through x402's payment contract. Usable from {witness.validAfter}. Signature expires: {deadline}.",
      fields: [
        { path: "permitted.token", label: "Token", format: "addressName" },
        { path: "permitted.amount", label: "Amount", format: "tokenAmount", params: { tokenPath: "permitted.token" } },
        // ERC-7730: "Always skip display, but value MUST match one of these values"
        { path: "spender", label: "x402's payment contract", visible: { mustMatch: [PROXY] }, format: "addressName" },
        { path: "nonce", label: "Nonce", format: "raw" },
        date("deadline", "Signature expires"),
        { path: "witness.to", label: "To", format: "addressName" },
        date("witness.validAfter", "Usable from"),
      ],
    },
  });
  assert.deepEqual(notes, [
    "PermitWitnessTransferFrom(0).deadline: the timestamp's threshold has no ERC-7730 date form and is left out; the file shows the date",
    "PermitWitnessTransferFrom(0).witness.validAfter: the timestamp's labels has no ERC-7730 date form and is left out; the file shows the date",
  ]);
  assert.equal(hash, "0xdef7129dc352fc0a6b84b6d970e7bbe1437207cead85d43bf06afdf4e81832fe");
  // ERC-7730: an interpolation names only fields that are always shown, so a template that names the pin gets none
  const named = structuredClone(resolved);
  named.messages.PermitWitnessTransferFrom.tags.intent.args.template = "Send {permitted.amount} to {witness.to} through {spender}.";
  const n = erc7730Descriptor(named, { context: "eip712" });
  assertValid(n.descriptor);
  assert.equal(Object.values(n.descriptor.display.formats)[0].interpolatedIntent, undefined);
  assert.equal(n.notes[0], "PermitWitnessTransferFrom: intent template: {spender} is pinned (fixed), so its field is hidden (mustMatch); an ERC-7730 interpolation names only fields that are always shown; interpolatedIntent is left out");
  // a pin that is not an address is not written as something near it
  const forged = structuredClone(resolved);
  forged.messages.PermitWitnessTransferFrom.args[0].fields.spender.tags.fixed.args.value = "x402";
  assert.match(codeOf(() => erc7730Descriptor(forged, { context: "eip712" })), /^E_RESOLVED_FORM: PermitWitnessTransferFrom\(0\)\.spender: fixed: /);
});

test("USDC's EIP-3009 messages (D-058): amounts in the verifying contract, USDC by name; Base Sepolia's file is its own", async () => {
  const usdc = (await validateProfile(pack("usdc"), { validateSchema, resolved: true })).resolved;
  const u = erc7730Descriptor(usdc, { context: "eip712", token: { name: "USD Coin" } });
  assertValid(u.descriptor);
  assert.deepEqual(u.descriptor.context.eip712.domain, { name: "USD Coin", version: "2" });
  assert.deepEqual(u.descriptor.context.eip712.deployments.map((d) => d.chainId), [1, 8453, 42161]);
  assert.deepEqual(u.descriptor.metadata, { token: { name: "USD Coin", ticker: "USDC", decimals: 6 } });
  const transfer = u.descriptor.display.formats["TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"];
  assert.equal(transfer.interpolatedIntent, "Send {value} from {from} to {to}, once. Valid after {validAfter}. Expires: {validBefore}.");
  assert.deepEqual(transfer.fields.find((f) => f.path === "value"), { path: "value", label: "Amount", format: "tokenAmount", params: { tokenPath: "@.to" } });
  assert.deepEqual(Object.keys(u.descriptor.display.formats), [
    "CancelAuthorization(address authorizer,bytes32 nonce)",
    "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
    "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
  ]);
  assert.equal(u.descriptorHash, "0xbc15fc80f5bb9057472df1cef52cb0f85cd27fc5dbd96d8682d6d976724be49b");
  const sepolia = (await validateProfile(pack("usdc-base-sepolia"), { validateSchema, resolved: true })).resolved;
  const s = erc7730Descriptor(sepolia, { context: "eip712", token: { name: "USDC" } });
  assertValid(s.descriptor);
  assert.deepEqual(s.descriptor.context.eip712, { domain: { name: "USDC", version: "2" }, deployments: [{ chainId: 84532, address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" }] });
  assert.equal(s.descriptorHash, "0x237a0464f4385456cad1690c04a7bbcdc5ab5469618ff0b99134f9d0cf42dc1e");
  // a literal amount is the contract's own token only when the caller says so
  assert.match(codeOf(() => erc7730Descriptor(usdc, { context: "eip712" })), /^E_EXPORT: no ERC-7730 file: ReceiveWithAuthorization\(0\)\.value: amount with literal decimals and symbol: .*; TransferWithAuthorization\(0\)\.value: amount with literal decimals and symbol: /);
});

test("EIP-712 messages: an amount in a group whose token is outside it has no path ERC-7730 can write", async () => {
  const doc = {
    format: "candid-profile",
    format_version: 0,
    kind: "contract",
    name: "orders",
    origin: "author",
    binds: {
      eip712: {
        types: {
          Order: [{ name: "fee", type: "address" }, { name: "legs", type: "Leg[]" }],
          Leg: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "cut", type: "uint256" }],
        },
      },
      deployments: [{ chain_id: 1, address: CONTRACT }],
    },
    annotations: [
      { at: "Order", tag: "intent", args: { title: "Order", template: "An order" } },
      { at: "Order(0).legs[].amount", tag: "amount", args: { token: "legs[].token" } },
      { at: "Order(0).legs[].cut", tag: "amount", args: { token: "fee" } },
    ],
  };
  const resolved = (await validateProfile(doc, { validateSchema, resolved: true })).resolved;
  assert.match(codeOf(() => erc7730Descriptor(resolved, { context: "eip712" })), /^E_EXPORT: no ERC-7730 file: Order\(0\)\.legs\[\]\.cut: the amount is in an array group and its token is outside it/);
  // without the in-element amount there is no group, and the path from the root is fine
  doc.annotations.splice(1, 1);
  const flat = erc7730Descriptor((await validateProfile(doc, { validateSchema, resolved: true })).resolved, { context: "eip712" });
  assertValid(flat.descriptor);
  assert.deepEqual(flat.descriptor.display.formats["Order(address fee,Leg[] legs)Leg(address token,uint256 amount,uint256 cut)"].fields.at(-1), { path: "legs.[].cut", label: "cut", format: "tokenAmount", params: { tokenPath: "fee" } });
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
