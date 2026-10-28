// The consent text of an EVM call (spec section 15, D-054): calldata decoded strictly against the resolved form of the
// ERC-20 pack on a WETH-shaped ABI, the same model and layouts as ICRC-21, and the contract's address at the end.
// Calldata is written out word by word here, not produced by the codec under test. No chain, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createSchemaValidator, resolveService } from "@meantjs/profile";
import { decodeCalldata, evmConsent } from "../src/evm.mjs";
import { generateConsent, icrc21ConsentMessage, CODES } from "../src/index.mjs";
import { icrc1 } from "./helpers.mjs";

const validateSchema = await createSchemaValidator();
const erc20 = JSON.parse(readFileSync(new URL("../../../packs/erc20.profile.json", import.meta.url), "utf8"));

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
const resolveAbi = async (abi, opts) => {
  const r = await resolveService({ abi, validateSchema, ...opts });
  assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
  return r.resolved;
};
const weth = await resolveAbi(WETH, { packs: [{ doc: erc20 }] });

const CONTRACT = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; // EIP-55 form of the address WETH has on chain 1
const BOB = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359"; // an EIP-55 example
const word = (hex) => hex.padStart(64, "0");
const addressWord = (a) => word(a.slice(2).toLowerCase());
const amountWord = (n) => word(BigInt(n).toString(16));
const transfer = (to, n) => `0xa9059cbb${addressWord(to)}${amountWord(n)}`;
const approve = (spender, n) => `0x095ea7b3${addressWord(spender)}${amountWord(n)}`;
const refs = { "query:decimals": 18, "query:symbol": "WETH" };
const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return null;
};

test("an ERC-20 transfer: the pack's sentence in the contract's names, amounts in tokens, the contract last", () => {
  const data = transfer(BOB, 15n * 10n ** 17n);
  assert.deepEqual(decodeCalldata(weth, data), { method: "transfer", selector: "0xa9059cbb", values: { dst: BOB, wad: "1500000000000000000" } });
  const generic = evmConsent({ resolved: weth, calldata: data, to: CONTRACT, refs });
  assert.equal(generic.message, `# Send tokens\n\nSend \`1.5 WETH\` to \`${BOB}\`\n\n- **Amount:** \`1.5 WETH\`\n- **Recipient:** \`${BOB}\`\n\n**Contract:** \`${CONTRACT}\``);
  assert.deepEqual([generic.method, generic.selector, generic.to, generic.chainId], ["transfer", "0xa9059cbb", CONTRACT, null]);
  assert.deepEqual(generic.provenance.intent, { origin: "pack", profile: "erc20" });
  const fields = evmConsent({ resolved: weth, calldata: Buffer.from(data.slice(2), "hex"), to: CONTRACT.toLowerCase(), chainId: 1, refs, form: "fields", rawArguments: true });
  assert.deepEqual(fields.message, {
    intent: `Send tokens: Send 1.5 WETH to ${BOB}`,
    fields: [
      ["Amount", "1.5 WETH"],
      ["Recipient", BOB],
      ["Raw arguments", `(dst: ${BOB}, wad: 1.5 WETH)`],
      ["Contract", `${CONTRACT} on chain 1`],
    ],
  });
  // decimals and symbol are the caller's to read, as for an ICRC ledger: without them there is no message
  assert.equal(codeOf(() => evmConsent({ resolved: weth, calldata: data, to: CONTRACT })), CODES.REF_UNRESOLVED);
});

test("an unlimited approval shows the pack's message and the symbol, one below it the amount", () => {
  const max = 2n ** 256n - 1n;
  const at = (n) => evmConsent({ resolved: weth, calldata: approve(BOB, n), to: CONTRACT, refs, form: "fields" }).message.fields[1];
  assert.deepEqual(at(max), ["Allowance", "Unlimited WETH"]);
  assert.deepEqual(at(max - 1n), ["Allowance", `${(max - 1n).toString().slice(0, -18)}.${(max - 1n).toString().slice(-18)} WETH`]);
  const text = evmConsent({ resolved: weth, calldata: approve(BOB, max), to: CONTRACT, refs }).message;
  assert.match(text, /Set `0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359`'s allowance to `Unlimited WETH`, replacing any existing allowance/);
});

test("a function without an intent gets the generic intent; a payable one is refused", () => {
  const generic = evmConsent({ resolved: weth, calldata: `0x2e1a7d4d${amountWord(42)}`, to: CONTRACT, rawArguments: true });
  assert.equal(generic.message, `# Call withdraw\n\n- **wad:** \`42\`\n\n**Raw arguments:**\n\n\`\`\`\n(wad: 42)\n\`\`\`\n\n**Contract:** \`${CONTRACT}\``);
  assert.equal(codeOf(() => evmConsent({ resolved: weth, calldata: "0xd0e30db0", to: CONTRACT })), CODES.UNSUPPORTED_TYPE); // deposit()
});

test("calldata is decoded strictly: unknown selectors, short data, dirty padding and extra bytes are refused", () => {
  const good = transfer(BOB, 1);
  assert.equal(codeOf(() => decodeCalldata(weth, good)), null);
  assert.equal(codeOf(() => decodeCalldata(weth, "0xdeadbeef")), CODES.METHOD_UNKNOWN);
  assert.equal(codeOf(() => decodeCalldata(weth, "0xa9059c")), CODES.DECODE);
  assert.equal(codeOf(() => decodeCalldata(weth, good.slice(0, -2))), CODES.DECODE); // not whole words
  assert.equal(codeOf(() => decodeCalldata(weth, `${good}00`)), CODES.DECODE); // a byte past the arguments
  assert.equal(codeOf(() => decodeCalldata(weth, `0xa9059cbb${"01" + addressWord(BOB).slice(2)}${amountWord(1)}`)), CODES.DECODE); // an address with a high byte set
  assert.equal(codeOf(() => decodeCalldata(weth, "0xa9059cbbzz")), CODES.REQUEST); // not hex
  assert.equal(codeOf(() => evmConsent({ resolved: weth, calldata: good, to: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cC2", refs })), CODES.REQUEST); // bad checksum
});

test("a profile that lists deployments describes those contracts only", async () => {
  const VAULT = ["function deposit(uint256 assets, address receiver) returns (uint256 shares)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"];
  const doc = {
    format: "candid-profile",
    format_version: 0,
    kind: "contract",
    name: "vault",
    origin: "author",
    binds: { abi: VAULT, deployments: [{ chain_id: 1, address: CONTRACT }] },
    annotations: [
      { at: "deposit", tag: "intent", args: { title: "Deposit", template: "Deposit {assets} for {receiver}" } },
      { at: "deposit", tag: "effect", args: { kind: "transfer", irreversible: true } },
      { at: "deposit(0).assets", tag: "amount", args: { decimals: 6, symbol: "USDC" } },
    ],
  };
  const vault = await resolveAbi(VAULT, { profiles: [{ doc }] });
  const data = `0x6e553f65${amountWord(2_500_000)}${addressWord(BOB)}`;
  const ok = evmConsent({ resolved: vault, calldata: data, to: CONTRACT, chainId: "1", form: "fields" });
  assert.equal(ok.message.intent, `Deposit: Deposit 2.5 USDC for ${BOB}`);
  assert.equal(codeOf(() => evmConsent({ resolved: vault, calldata: data, to: CONTRACT })), CODES.REQUEST); // no chainId
  assert.equal(codeOf(() => evmConsent({ resolved: vault, calldata: data, to: CONTRACT, chainId: 10 })), CODES.DEPLOYMENT);
  assert.equal(codeOf(() => evmConsent({ resolved: vault, calldata: data, to: BOB, chainId: 1 })), CODES.DEPLOYMENT);
  assert.equal(codeOf(() => evmConsent({ resolved: vault, calldata: data, to: CONTRACT, chainId: 1.5 })), CODES.REQUEST);
});

test("the two kinds of resolved form do not mix: Candid entry points refuse an EVM one, evmConsent a Candid one", () => {
  const arg = new Uint8Array([0x44, 0x49, 0x44, 0x4c, 0, 0]); // DIDL with no types and no values
  assert.equal(codeOf(() => generateConsent({ resolved: weth, method: "transfer", arg })), CODES.RESOLVED_FORM);
  const r = icrc21ConsentMessage({ method: "transfer", arg, user_preferences: { metadata: { language: "en", utc_offset_minutes: null }, device_spec: null } }, { resolved: weth });
  assert.equal(r.Err.GenericError.error_code, 1000n);
  assert.match(r.Err.GenericError.description, /use evmConsent/);
  assert.equal(codeOf(() => evmConsent({ resolved: icrc1, calldata: transfer(BOB, 1), to: CONTRACT })), CODES.RESOLVED_FORM);
  assert.equal(codeOf(() => decodeCalldata({ ...weth, format: "other" }, transfer(BOB, 1))), CODES.RESOLVED_FORM);
});
