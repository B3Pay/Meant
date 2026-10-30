// Terms the user confirms for one task, and the check of a request's grant against them (spec section 5.3, "Confirmed
// terms", D-056). The rules come from surface D2 of the everyday-wording test of Meant's signing guard (2026-10-29),
// whose length table is repeated here, written out by hand. The eight requests that the terms cover in this version
// are checked end to end, through the consent functions that read their grants. Last, the seven planted faults of that
// test that live in the guard are planted here, and the checks must catch each one; the other five belong to its
// surface and scoring, and stay there. No chain, no network, nothing signed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSchemaValidator, resolveService, validateProfile } from "@meantjs/profile";
import { jcs, toChecksumAddress } from "@meantjs/profile/evm";
import { displayAccount } from "@meantjs/format";
import { eip712Consent, evmConsent } from "../src/evm.mjs";
import { generateConsent, CODES } from "../src/index.mjs";
import { sha256Hex } from "../src/sha256.mjs";
import { TERMS_CODES, TermsError, checkGrant, confirmTerms, readTerms, termsGate, termsText } from "../src/terms.mjs";
import { BOB as BOB_ICP, SPENDER as SPENDER_ICP, encodeCall, icrc1, icrc2, refsFor, subaccountText } from "./helpers.mjs";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const UNISWAP = "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af";
const ONEINCH = "0x111111125421cA6dc452d289314280a0f8842A65";
const ODOS = "0xCf5540fFFCdC3d510B18bFcA6d2b9987b0772559";
const ALICE = "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826";
const BOB = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
const LEDGER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const MAX48 = (2n ** 48n - 1n).toString();
const MAX160 = (2n ** 160n - 1n).toString();
const MAX256 = (2n ** 256n - 1n).toString();
const S = 1_000_000_000n;
const DAY = 86_400n * S;
/** The everyday test's clock: Monday 2 November 2026, noon UTC, in nanoseconds. */
const NOW = BigInt(Date.parse("2026-11-02T12:00:00Z")) * 1_000_000n;
const secondsAt = (iso) => String(Date.parse(iso) / 1000);
const WALLET = {
  tokens: { USDC: { address: USDC, decimals: 6 }, DAI: { address: DAI, decimals: 18 }, ICP: { canister: LEDGER, decimals: 8 } },
  apps: { Uniswap: UNISWAP, "1inch": ONEINCH, Odos: ODOS, Bob: BOB_ICP },
  now: NOW,
};
const ASK = { token: "USDC", spender: "Uniswap", max_amount: "500", expires_by: "2026-11-30" };

/** The TermsError a call throws, or the result. */
const attempt = (fn) => {
  try {
    return fn();
  } catch (e) {
    if (e instanceof TermsError) return e;
    throw e;
  }
};
const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
  return null;
};
const refused = (fields, code, message, wallet = WALLET) => {
  const e = attempt(() => readTerms(fields, wallet));
  assert.ok(e instanceof TermsError, `${JSON.stringify(fields)} was read: ${JSON.stringify(e)}`);
  assert.equal(e.code, code, e.message);
  if (typeof message === "string") assert.equal(e.message, message);
  else assert.match(e.message, message);
};

test("sha256 is SHA-256: the digests of node:crypto, across block boundaries and in UTF-8", () => {
  for (let n = 0; n < 200; n++) {
    const text = "terms ü 🗝 ".repeat(n).slice(0, n);
    assert.equal(sha256Hex(text), createHash("sha256").update(text).digest("hex"), `length ${n}`);
  }
});

// ------------------------------------------------------------------------------------------------ readTerms

test("readTerms: the token by its symbol and the app by its name, in the wallet's values", () => {
  assert.deepEqual(readTerms({ token: "usdc", spender: "uniswap", max_amount: "500", expires_by: "2026-11-30" }, WALLET), {
    token: USDC,
    symbol: "USDC",
    decimals: 6,
    spender: UNISWAP,
    name: "Uniswap",
    amount: { units: "500000000", unlimited: false },
    ends: { at: "1796083199.999999999", day: "2026-11-30" }, // the last nanosecond of the day: the whole day counts
    utcOffsetMinutes: 0,
    written: { token: "usdc", spender: "uniswap", max_amount: "500", expires_by: "2026-11-30" },
  });
  for (const name of ["Uniswap", " UNISWAP ", "Uni-swap", "uni swap"]) assert.equal(readTerms({ ...ASK, spender: name }, WALLET).spender, UNISWAP, name);
  assert.deepEqual(readTerms({ ...ASK, spender: "1 inch" }, WALLET).name, "1inch");
});

test("readTerms: a token or an app the wallet does not know is refused, never guessed, and the agent is told to ask", () => {
  refused({ ...ASK, token: "USDT" }, TERMS_CODES.TOKEN, 'the wallet knows no token named "USDT"; it knows USDC, DAI and ICP. If the user named another token, or did not say which, ask the user');
  refused({ ...ASK, token: "stablecoins" }, TERMS_CODES.TOKEN, /knows no token named "stablecoins"/);
  // Only the apps on the token's chain are offered: Bob is an Internet Computer account.
  refused({ ...ASK, spender: "SushiSwap" }, TERMS_CODES.PARTY, 'the wallet knows no app named "SushiSwap"; it knows Uniswap, 1inch and Odos. If the user named another app, or none, ask the user which app they mean, or for its address');
  refused({ ...ASK, spender: "Uniswap Router" }, TERMS_CODES.PARTY, /knows no app named "Uniswap Router"/);
  refused({ ...ASK, spender: "Bob" }, TERMS_CODES.PARTY, "the wallet has an Internet Computer account for Bob, and USDC is a token on an EVM chain; ask the user for a 0x address");
  refused({ token: "ICP", to: "Uniswap", max_amount: "1", expires_by: "never" }, TERMS_CODES.PARTY, /an EVM address for Uniswap, and ICP is a token on the Internet Computer/);
  // With no apps, a name is not an address.
  const bare = { ...WALLET, apps: {} };
  refused({ ...ASK, spender: "the router" }, TERMS_CODES.PARTY, 'spender must be a 0x address; got "the router"', bare);
  refused({ token: "ICP", to: "Bob", max_amount: "1", expires_by: "never" }, TERMS_CODES.PARTY, 'to must be an account: a principal, or its ICRC-1 text with a subaccount; got "Bob"', bare);
});

test("readTerms: an address or an account the user gave, checked, and named when the wallet knows it", () => {
  assert.deepEqual(readTerms({ ...ASK, spender: UNISWAP.toLowerCase() }, WALLET).name, "Uniswap");
  const stranger = readTerms({ ...ASK, spender: BOB.toLowerCase() }, WALLET);
  assert.deepEqual([stranger.spender, stranger.name], [BOB, null]);
  refused({ ...ASK, spender: "0x123" }, TERMS_CODES.PARTY, 'spender "0x123" is not a 0x address with 40 hex digits');
  // A mistyped character breaks the EIP-55 checksum. The message must not offer the checksum of the mistyped address,
  // which an agent could copy to get past the check.
  const typo = UNISWAP.replace("66a9893cC07D", "66a9893cC07E");
  const e = attempt(() => readTerms({ ...ASK, spender: typo }, WALLET));
  assert.equal(e.code, TERMS_CODES.PARTY);
  assert.match(e.message, /EIP-55 checksum does not match: a character may be mistyped/);
  assert.equal(e.message.includes(toChecksumAddress(typo)), false);
  // An account in its ICRC-1 text: a principal is its default subaccount, and a subaccount is kept.
  const sub = displayAccount({ owner: SPENDER_ICP, subaccount: Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 7 : 0)) });
  assert.equal(readTerms({ token: "ICP", spender: sub, max_amount: "1", expires_by: "never" }, WALLET).spender, sub);
  const bob = readTerms({ token: "icp", to: BOB_ICP, max_amount: "2.5", expires_by: "never" }, WALLET);
  assert.deepEqual([bob.to, bob.name, bob.amount.units], [BOB_ICP, "Bob", "250000000"]);
});

test("readTerms: the most exactly, never rounded; unlimited only as that word", () => {
  const units = (max, token = "USDC") => readTerms({ ...ASK, token, max_amount: max }, WALLET).amount;
  assert.deepEqual(units("100"), { units: "100000000", unlimited: false });
  assert.deepEqual(units("100 USDC"), { units: "100000000", unlimited: false });
  assert.deepEqual(units("0.000001"), { units: "1", unlimited: false });
  assert.deepEqual(units("0.000000000000000001", "DAI"), { units: "1", unlimited: false });
  assert.deepEqual(units("Unlimited"), { units: null, unlimited: true });
  refused({ ...ASK, max_amount: "100.0000001" }, TERMS_CODES.AMOUNT, /never rounded/);
  refused({ ...ASK, max_amount: "1k" }, TERMS_CODES.AMOUNT, /^max_amount: cannot read "1k"/);
  refused({ ...ASK, max_amount: "any amount" }, TERMS_CODES.AMOUNT, /cannot read/);
  refused({ ...ASK, max_amount: "-5" }, TERMS_CODES.AMOUNT, /negative/);
  refused({ ...ASK, max_amount: "100 DAI" }, TERMS_CODES.AMOUNT, /symbol "DAI" is not this token's symbol "USDC"/);
});

// Lengths of time from Monday 2026-11-02, and from other days for month ends and leap years, worked out by hand (the
// everyday-wording test's table). null: not an end readTerms takes.
const LENGTHS = [
  ["1 day", "2026-11-03"], ["3 days", "2026-11-05"], ["10 days", "2026-11-12"], ["30 days", "2026-12-02"], ["60 days", "2027-01-01"], ["90 days", "2027-01-31"],
  ["1 week", "2026-11-09"], ["2 weeks", "2026-11-16"], ["3 weeks", "2026-11-23"],
  ["1 month", "2026-12-02"], ["2 months", "2027-01-02"], ["6 months", "2027-05-02"], ["1 year", "2027-11-02"],
  ["2 Weeks", "2026-11-16"], ["30days", "2026-12-02"], [" 1 month ", "2026-12-02"], ["0 days", "2026-11-02"],
  ["a month", null], ["one week", null], ["1.5 months", null], ["month", null], ["-1 day", null], ["90 minutes", null], ["1.5 hours", null], ["2027-02-30", null], ["next Friday", null],
];
const FROM_OTHER_DAYS = [["2027-01-31", "1 month", "2027-02-28"], ["2028-01-31", "1 month", "2028-02-29"], ["2026-10-31", "1 month", "2026-11-30"], ["2028-02-29", "1 year", "2029-02-28"], ["2026-12-25", "10 days", "2027-01-04"], ["2026-12-31", "1 week", "2027-01-07"]];
const noonOf = (date) => BigInt(Date.parse(`${date}T12:00:00Z`)) * 1_000_000n;
/** The local date a length or a date ends on, or null when readTerms refuses the end (E_TERMS_END). */
const dayOf = (lib, expires_by, wallet = WALLET) => {
  const t = attempt(() => lib.readTerms({ ...ASK, expires_by }, wallet));
  if (t instanceof TermsError) {
    if (t.code !== TERMS_CODES.END) throw t;
    return null;
  }
  return t.ends.day ?? null;
};

test("readTerms: a length of time is a date by the wallet's clock, and the whole day counts", () => {
  for (const [text, want] of LENGTHS) assert.equal(dayOf({ readTerms }, text), want, text);
  for (const [from, text, want] of FROM_OTHER_DAYS) assert.equal(dayOf({ readTerms }, text, { ...WALLET, now: noonOf(from) }), want, `${text} from ${from}`);
  refused({ ...ASK, expires_by: "9999 years" }, TERMS_CODES.END, /ends after the year 9999/);
  refused({ ...ASK, expires_by: "a month" }, TERMS_CODES.END, /^expires_by must be a date as YYYY-MM-DD, a length of time from now/);
});

test("readTerms: hours are an exact time from now, in whole seconds; never only as that word", () => {
  assert.deepEqual(readTerms({ ...ASK, expires_by: "2 hours" }, WALLET).ends, { at: secondsAt("2026-11-02T14:00:00Z") });
  assert.deepEqual(readTerms({ ...ASK, expires_by: "24 hours" }, WALLET).ends, { at: secondsAt("2026-11-03T12:00:00Z") });
  // The clock reading is taken in whole seconds; the hours are added exactly.
  assert.deepEqual(readTerms({ ...ASK, expires_by: "1 hour" }, { ...WALLET, now: NOW + 30n * S + 999_999_999n }).ends, { at: secondsAt("2026-11-02T13:00:30Z") });
  assert.deepEqual(readTerms({ ...ASK, expires_by: "Never" }, WALLET).ends, { never: true });
  assert.deepEqual(readTerms({ ...ASK, expires_by: "never" }, WALLET).amount, { units: "500000000", unlimited: false }); // each term is read alone
});

test("readTerms: a date allows its whole day in the user's zone, and a date before today there is refused", () => {
  assert.deepEqual(readTerms({ ...ASK, expires_by: "2026-11-02" }, WALLET).ends, { at: "1793663999.999999999", day: "2026-11-02" });
  refused({ ...ASK, expires_by: "2026-11-01" }, TERMS_CODES.END, "expires_by 2026-11-01 is before today, 2026-11-02");
  refused({ ...ASK, expires_by: "2027-02-30" }, TERMS_CODES.END, /must be a date as YYYY-MM-DD/);
  // UTC+03:30: the day ends at 20:29:59.999999999 UTC.
  assert.deepEqual(readTerms({ ...ASK, expires_by: "2026-11-30" }, { ...WALLET, utcOffsetMinutes: 210 }).ends, { at: "1796070599.999999999", day: "2026-11-30" });
  // Noon UTC is 23:00 on 1 November at UTC-13:00, and 02:00 on 3 November at UTC+14:00.
  assert.equal(dayOf({ readTerms }, "2026-11-01", { ...WALLET, utcOffsetMinutes: -780 }), "2026-11-01");
  assert.equal(dayOf({ readTerms }, "2026-11-02", { ...WALLET, utcOffsetMinutes: 840 }), null);
  assert.equal(dayOf({ readTerms }, "1 day", { ...WALLET, utcOffsetMinutes: 840 }), "2026-11-04");
});

test("readTerms: a missing term is named; spender and to are one or the other", () => {
  refused({ ...ASK, expires_by: undefined }, TERMS_CODES.MISSING, "missing parameter: expires_by");
  refused({ ...ASK, token: "  " }, TERMS_CODES.MISSING, "missing parameter: token");
  refused({ ...ASK, spender: undefined }, TERMS_CODES.MISSING, "missing parameter: spender or to");
  refused({ ...ASK, to: BOB }, TERMS_CODES.MISSING, /give spender or to, not both/);
  refused(null, TERMS_CODES.MISSING, "missing parameter: token");
  const paid = readTerms({ token: "USDC", to: BOB, max_amount: "15", expires_by: "never" }, WALLET);
  assert.deepEqual([paid.to, paid.spender], [BOB, undefined]);
});

test("a wallet that is not one is the caller's error (E_REQUEST), not the agent's", () => {
  for (const [wallet, why] of [
    [{ ...WALLET, now: Date.now() }, /now must be nanoseconds/],
    [{ ...WALLET, utcOffsetMinutes: 1441 }, /utcOffsetMinutes/],
    [{ ...WALLET, tokens: {} }, /tokens must name its tokens/],
    [{ ...WALLET, apps: { Uniswap: UNISWAP, "uni swap": ODOS } }, /apps "Uniswap" and "uni swap" are one name/],
    [{ ...WALLET, tokens: { USDC: { address: USDC, canister: LEDGER, decimals: 6 } } }, /its address or its canister, not both/],
    [{ ...WALLET, tokens: { USDC: { address: "0x123", decimals: 6 } } }, /is not an address/],
    [{ ...WALLET, tokens: { USDC: { address: USDC, decimals: 6 }, USDC2: { address: USDC.toLowerCase(), decimals: 6 } } }, /USDC and USDC2 are the same token/],
    [{ ...WALLET, tokens: { USDC: { address: USDC, decimals: 256 } } }, /decimals/],
    [{ ...WALLET, apps: { Nobody: "nobody" } }, /neither an address/],
  ]) {
    assert.throws(() => readTerms(ASK, wallet), (e) => e.code === CODES.REQUEST && why.test(e.message), String(why));
  }
});

// ------------------------------------------------------------------------------------------------ termsText, confirmTerms

test("termsText: exact, with the full address, and unlimited and never ends written out", () => {
  const text = (fields, wallet = WALLET) => termsText(readTerms(fields, wallet));
  assert.equal(text(ASK), `Uniswap (${UNISWAP}) may spend at most 500 USDC, until the end of 30 November 2026 (UTC).`);
  assert.equal(text({ token: "DAI", spender: ONEINCH, max_amount: "unlimited", expires_by: "never" }), `1inch (${ONEINCH}) may spend any amount of DAI (unlimited), and this permission never ends.`);
  assert.equal(text({ ...ASK, spender: BOB, max_amount: "0.000001" }), `${BOB} may spend at most 0.000001 USDC, until the end of 30 November 2026 (UTC).`);
  assert.equal(text({ token: "ICP", to: "Bob", max_amount: "2.5", expires_by: "2 hours" }, { ...WALLET, utcOffsetMinutes: 210 }), `Bob (${BOB_ICP}) may be sent at most 2.5 ICP, until 2 November 2026 at 17:30 (UTC+03:30).`);
  assert.equal(text({ ...ASK, expires_by: "1 hour" }, { ...WALLET, now: NOW + 30n * S }), `Uniswap (${UNISWAP}) may spend at most 500 USDC, until 2 November 2026 at 13:00:30 (UTC).`);
  assert.equal(text({ ...ASK, expires_by: "1 month" }, { ...WALLET, utcOffsetMinutes: -300 }), `Uniswap (${UNISWAP}) may spend at most 500 USDC, until the end of 2 December 2026 (UTC-05:00).`);
});

test("confirmTerms: the id is the SHA-256 of the canonical JSON; the terms are frozen, and changed ones are refused", () => {
  const terms = readTerms(ASK, WALLET);
  const confirmed = confirmTerms(terms);
  assert.equal(confirmed.id, createHash("sha256").update(jcs(terms)).digest("hex"));
  assert.deepEqual({ ...confirmed, id: undefined }, { ...terms, id: undefined });
  assert.equal(termsText(confirmed), termsText(terms));
  assert.throws(() => {
    confirmed.amount.units = "1";
  }, TypeError);
  // A copy that says less than it allows, or that changed after the user confirmed it, is refused everywhere.
  const changed = { ...confirmed, amount: { units: "500000001", unlimited: false } };
  assert.equal(codeOf(() => checkGrant(changed, null, WALLET)), CODES.REQUEST);
  assert.equal(codeOf(() => termsText(changed)), CODES.REQUEST);
  assert.equal(codeOf(() => checkGrant(terms, null, WALLET)), CODES.REQUEST); // never confirmed
  for (const bad of [{ ...terms, ends: { at: terms.ends.at, day: "2026-12-30" } }, { ...terms, extra: 1 }, { ...terms, token: USDC.toLowerCase() }, { ...terms, amount: { units: null, unlimited: false } }, { ...terms, to: BOB }]) {
    assert.equal(codeOf(() => confirmTerms(bad)), CODES.REQUEST, JSON.stringify(bad));
  }
});

// ------------------------------------------------------------------------------------------------ checkGrant, end to end

const validateSchema = await createSchemaValidator();
const doc = (name) => JSON.parse(readFileSync(new URL(`../../../packs/${name}.profile.json`, import.meta.url), "utf8"));
const resolvedOf = async (name) => (await validateProfile(doc(name), { validateSchema, resolved: true })).resolved;
const permit2 = await resolvedOf("permit2");
const daiForm = await resolvedOf("dai-permit");
const USDC_ABI = [
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
const usdc = (await resolveService({ abi: USDC_ABI, validateSchema, packs: [{ doc: doc("erc20") }, { doc: doc("erc2612") }] })).resolved;
const usdcRefs = { "query:decimals": 6, "query:symbol": "USDC" };
const TOKENS = { [USDC]: { decimals: 6, symbol: "USDC" } };
const SIG_DEADLINE = secondsAt("2026-11-02T12:30:00Z"); // 30 minutes, as apps set it

const permitRequest = (details, sigDeadline = SIG_DEADLINE) =>
  eip712Consent({
    resolved: permit2,
    typedData: {
      types: {
        PermitSingle: [{ name: "details", type: "PermitDetails" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }],
        PermitDetails: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }],
      },
      primaryType: "PermitSingle",
      domain: { name: "Permit2", chainId: 1, verifyingContract: PERMIT2 },
      message: { details: { token: USDC, amount: "500000000", expiration: secondsAt("2026-11-16T12:00:00Z"), nonce: 0, ...details }, spender: UNISWAP, sigDeadline },
    },
    chainId: 1,
    tokens: TOKENS,
  });
const permitSingle = (details, sigDeadline) => permitRequest(details, sigDeadline).grant;
const transferRequest = (message) =>
  eip712Consent({
    resolved: permit2,
    typedData: {
      types: {
        PermitTransferFrom: [{ name: "permitted", type: "TokenPermissions" }, { name: "spender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }],
        TokenPermissions: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }],
      },
      primaryType: "PermitTransferFrom",
      domain: { name: "Permit2", chainId: 1, verifyingContract: PERMIT2 },
      message: { permitted: { token: USDC, amount: "25000000" }, spender: UNISWAP, nonce: "7", deadline: SIG_DEADLINE, ...message },
    },
    chainId: 1,
    tokens: TOKENS,
  });
const transferFrom = (message) => transferRequest(message).grant;
const confirm = (fields, wallet = WALLET) => confirmTerms(readTerms(fields, wallet));
const fits = (terms, grant, wallet = WALLET) => checkGrant(terms, grant, wallet);
const YES = { fits: true, reasons: [] };
const no = (...reasons) => ({ fits: false, reasons });

test("checkGrant, Permit2 PermitSingle: fits the user's terms; unlimited or never ending does not; an expiration of 0 ends at sigDeadline", () => {
  const terms = confirm(ASK);
  assert.deepEqual(fits(terms, permitSingle({})), YES);
  assert.deepEqual(fits(terms, permitSingle({ amount: MAX160 })), no("the request is unlimited, the terms say at most 500 USDC"));
  assert.deepEqual(fits(terms, permitSingle({ amount: "500000001" })), no("the request allows 500.000001 USDC, the terms say at most 500 USDC"));
  assert.deepEqual(fits(terms, permitSingle({ expiration: MAX48 })), no("the permission never ends, the terms say until the end of 30 November 2026 (UTC)"));
  assert.deepEqual(fits(terms, permitSingle({ expiration: secondsAt("2026-12-01T00:00:00Z") })), no("the permission lasts until 1 December 2026 at 00:00 (UTC), the terms say until the end of 30 November 2026 (UTC)"));
  assert.deepEqual(fits(terms, permitSingle({ expiration: secondsAt("2026-11-30T23:59:59Z") })), YES); // the whole last day counts
  // The trap: 0 is not 1970 and not never; it is spendable until sigDeadline, 30 minutes from now.
  assert.deepEqual(fits(terms, permitSingle({ expiration: 0 })), YES);
  assert.deepEqual(fits(terms, permitSingle({ expiration: 0 }, MAX256)), no("the permission never ends, the terms say until the end of 30 November 2026 (UTC)"));
  // Another app, named as the wallet knows it, and another token: the amount of another token is not compared.
  assert.deepEqual(fits(terms, { ...permitSingle({}), spender: ONEINCH }), no(`the spender is 1inch (${ONEINCH}), the terms say Uniswap (${UNISWAP})`));
  assert.deepEqual(fits(terms, { ...permitSingle({ amount: MAX160 }), token: DAI }), no("the request is for DAI, the terms say USDC"));
});

test("checkGrant, Permit2 PermitTransferFrom and PermitBatch: a transfer taken once by its deadline; a batch is not covered", () => {
  const terms = confirm({ ...ASK, max_amount: "25" });
  assert.deepEqual(fits(terms, transferFrom({})), YES);
  assert.deepEqual(fits(terms, transferFrom({ spender: ODOS })), no(`the spender is Odos (${ODOS}), the terms say Uniswap (${UNISWAP})`));
  assert.deepEqual(fits(terms, transferFrom({ deadline: MAX256 })), no("the permission never ends, the terms say until the end of 30 November 2026 (UTC)"));
  const batch = eip712Consent({
    resolved: permit2,
    typedData: {
      types: {
        PermitBatch: [{ name: "details", type: "PermitDetails[]" }, { name: "spender", type: "address" }, { name: "sigDeadline", type: "uint256" }],
        PermitDetails: [{ name: "token", type: "address" }, { name: "amount", type: "uint160" }, { name: "expiration", type: "uint48" }, { name: "nonce", type: "uint48" }],
      },
      primaryType: "PermitBatch",
      domain: { name: "Permit2", chainId: 1, verifyingContract: PERMIT2 },
      message: { details: [{ token: USDC, amount: "1", expiration: 0, nonce: 1 }], spender: UNISWAP, sigDeadline: SIG_DEADLINE },
    },
    chainId: 1,
    tokens: TOKENS,
  });
  assert.equal(batch.grant, null);
  assert.deepEqual(fits(terms, batch.grant), no("the request has no grant a profile describes, so no terms cover it: it needs the user's confirmation"));
});

test("checkGrant, EIP-2612 and DAI permits: their deadlines are the signature's, so the allowance never ends", () => {
  const permit = (message) =>
    eip712Consent({
      resolved: usdc,
      typedData: {
        types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
        primaryType: "Permit",
        domain: { name: "USD Coin", version: "2", chainId: 1, verifyingContract: USDC },
        message: { owner: ALICE, spender: UNISWAP, value: "100000000", nonce: "0", deadline: SIG_DEADLINE, ...message },
      },
      chainId: 1,
      refs: usdcRefs,
    }).grant;
  assert.deepEqual(fits(confirm({ ...ASK, max_amount: "100" }), permit({})), no("the permission never ends, the terms say until the end of 30 November 2026 (UTC)"));
  assert.deepEqual(fits(confirm({ ...ASK, max_amount: "100", expires_by: "never" }), permit({})), YES);
  assert.deepEqual(fits(confirm({ ...ASK, max_amount: "100", expires_by: "never" }), permit({ value: MAX256 })), no("the request is unlimited, the terms say at most 100 USDC"));

  const daiPermit = (allowed) =>
    eip712Consent({
      resolved: daiForm,
      typedData: {
        types: { Permit: [{ name: "holder", type: "address" }, { name: "spender", type: "address" }, { name: "nonce", type: "uint256" }, { name: "expiry", type: "uint256" }, { name: "allowed", type: "bool" }] },
        primaryType: "Permit",
        domain: { name: "Dai Stablecoin", version: "1", chainId: 1, verifyingContract: DAI },
        message: { holder: ALICE, spender: UNISWAP, nonce: "0", expiry: SIG_DEADLINE, allowed },
      },
      chainId: 1,
    }).grant;
  const daiTerms = (max) => confirm({ token: "DAI", spender: "Uniswap", max_amount: max, expires_by: "never" });
  assert.deepEqual(fits(daiTerms("unlimited"), daiPermit(true)), YES);
  assert.deepEqual(fits(daiTerms("1000"), daiPermit(true)), no("the request is unlimited, the terms say at most 1000 DAI"));
  assert.deepEqual(fits(daiTerms("0"), daiPermit(false)), YES); // a grant of nothing fits any most
});

test("checkGrant, ERC-20: an approve never ends; a transfer pays its recipient at once, while the terms have not ended", () => {
  const word = (hex) => hex.padStart(64, "0");
  const call = (selector, address, n, to = USDC) => evmConsent({ resolved: usdc, calldata: `${selector}${word(address.slice(2).toLowerCase())}${word(BigInt(n).toString(16))}`, to, chainId: 1, refs: usdcRefs }).grant;
  assert.deepEqual(fits(confirm({ ...ASK, expires_by: "never" }), call("0x095ea7b3", UNISWAP, "500000000")), YES);
  assert.deepEqual(fits(confirm(ASK), call("0x095ea7b3", UNISWAP, "500000000")), no("the permission never ends, the terms say until the end of 30 November 2026 (UTC)"));
  const pay = confirm({ token: "USDC", to: BOB, max_amount: "15", expires_by: "2 hours" });
  assert.deepEqual(fits(pay, call("0xa9059cbb", BOB, "15000000")), YES);
  assert.deepEqual(fits(pay, call("0xa9059cbb", BOB, "15000000"), { ...WALLET, now: NOW + 2n * 3600n * S }), YES); // the last moment still counts
  assert.deepEqual(fits(pay, call("0xa9059cbb", BOB, "15000000"), { ...WALLET, now: NOW + 2n * 3600n * S + 1n }), no("the terms have ended: they said until 2 November 2026 at 14:00 (UTC)"));
  // The same address, in another role: paying it is not letting it spend, and the other way round.
  assert.deepEqual(fits(pay, call("0x095ea7b3", BOB, "15000000")), no(`the request lets ${BOB} spend, the terms pay ${BOB} directly`, "the permission never ends, the terms say until 2 November 2026 at 14:00 (UTC)"));
  assert.deepEqual(fits(confirm({ ...ASK, expires_by: "never" }), call("0xa9059cbb", UNISWAP, "1")), no(`the request pays Uniswap (${UNISWAP}) directly, the terms let Uniswap (${UNISWAP}) spend`));
  // A transfer of the token the terms name, on another contract: another token.
  assert.deepEqual(fits(pay, call("0xa9059cbb", BOB, "15000000", DAI)), no(`the request is for DAI, the terms say USDC`));
});

test("checkGrant, ICRC-1 and ICRC-2: accounts compared by owner and subaccount, the default subaccount the same as none", () => {
  const sub = (n) => displayAccount({ owner: SPENDER_ICP, subaccount: Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0)) });
  const approve = (subaccount, expires) =>
    generateConsent({
      resolved: icrc2,
      method: "icrc2_approve",
      arg: encodeCall("icrc2_approve", `(record { spender = record { owner = principal "${SPENDER_ICP}"; subaccount = ${subaccount} }; amount = 150_000_000 : nat; expires_at = ${expires} })`),
      refs: refsFor({ symbol: "ICP", decimals: 8 }),
      canisterId: LEDGER,
    }).grant;
  const terms = confirm({ token: "ICP", spender: sub(1), max_amount: "1.5", expires_by: "2026-12-31" });
  const end = `opt ${BigInt(Date.parse("2026-12-31T23:59:59Z")) * 1_000_000n + 999_999_999n} : opt nat64`;
  assert.deepEqual(fits(terms, approve(`opt ${subaccountText(1)}`, end)), YES); // the last nanosecond of the day
  assert.deepEqual(fits(terms, approve(`opt ${subaccountText(2)}`, end)), no(`the spender is ${sub(2)}, the terms say ${sub(1)}`));
  assert.deepEqual(fits(terms, approve(`opt ${subaccountText(1)}`, "null")), no("the permission never ends, the terms say until the end of 31 December 2026 (UTC)"));
  const plain = confirm({ token: "ICP", spender: SPENDER_ICP, max_amount: "1.5", expires_by: "never" });
  assert.deepEqual(fits(plain, approve(`opt ${subaccountText(0)}`, "null")), YES); // 32 zero bytes are the default subaccount
  assert.deepEqual(fits(plain, approve("null", "null")), YES);

  const transfer = generateConsent({
    resolved: icrc1,
    method: "icrc1_transfer",
    arg: encodeCall("icrc1_transfer", `(record { to = record { owner = principal "${BOB_ICP}"; subaccount = null }; amount = 250_000_000 : nat })`),
    refs: refsFor({ symbol: "ICP", decimals: 8 }),
    canisterId: LEDGER,
  }).grant;
  assert.deepEqual(fits(confirm({ token: "ICP", to: "Bob", max_amount: "2.5", expires_by: "1 day" }), transfer), YES);
  assert.deepEqual(fits(confirm({ token: "ICP", to: "Bob", max_amount: "2.49999999", expires_by: "1 day" }), transfer), no("the request allows 2.5 ICP, the terms say at most 2.49999999 ICP"));
  // Another ledger is another token, even with the same symbol in the message.
  assert.deepEqual(fits(confirm({ token: "ICP", to: "Bob", max_amount: "2.5", expires_by: "1 day" }), { ...transfer, token: "mxzaz-hqaaa-aaaar-qaada-cai" }), no("the request is for mxzaz-hqaaa-aaaar-qaada-cai, the terms say ICP"));
});

test("checkGrant: a grant that is not one is the caller's error (E_REQUEST)", () => {
  const terms = confirm(ASK);
  const good = permitSingle({});
  for (const bad of [{}, { ...good, kind: "write" }, { ...good, to: BOB }, { ...good, token: "USDC" }, { ...good, amount: { units: "1.5", unlimited: false } }, { ...good, ends: { at: "soon" } }, { ...good, spender: SPENDER_ICP }]) {
    assert.equal(codeOf(() => checkGrant(terms, bad, WALLET)), CODES.REQUEST, JSON.stringify(bad));
  }
  assert.equal(codeOf(() => checkGrant(terms, good, { ...WALLET, now: undefined })), CODES.REQUEST);
});

// ------------------------------------------------------------------------------------------------ termsGate

/** `fn` throws TermsError E_TERMS_ORDER, with a message that matches `message`. */
const order = (fn, message) => {
  const e = attempt(fn);
  assert.ok(e instanceof TermsError && e.code === TERMS_CODES.ORDER, String(e?.message ?? e));
  assert.match(e.message, message);
};

test("termsGate: terms are confirmed before the request is read, exactly as shown, and fixed once it is read", () => {
  const terms = readTerms(ASK, WALLET);
  const request = permitRequest({});
  const gate = termsGate();
  assert.equal(gate.state, "open");
  order(() => gate.read(), /there are no terms yet/);
  order(() => gate.confirm(termsText(terms)), /no terms to confirm/);
  order(() => gate.check(request.grant, WALLET, request.digest), /read the request first/);
  assert.equal(gate.propose(terms), termsText(terms));
  assert.equal(gate.state, "proposed");
  order(() => gate.read(), /has not confirmed the terms yet/);
  order(() => gate.confirm(termsText(readTerms({ ...ASK, max_amount: "5000" }, WALLET))), /not the text of the terms proposed/);
  gate.reject();
  assert.equal(gate.state, "open");
  // A new draft drops the confirmation of the old one.
  gate.propose(readTerms({ ...ASK, max_amount: "50" }, WALLET));
  gate.confirm(termsText(gate.proposed));
  gate.propose(terms);
  assert.deepEqual([gate.state, gate.confirmed], ["proposed", null]);
  const confirmed = gate.confirm(termsText(terms));
  assert.deepEqual(confirmed, confirmTerms(terms));
  gate.read();
  assert.equal(gate.state, "read");
  order(() => gate.propose(readTerms({ ...ASK, max_amount: "unlimited" }, WALLET)), /cannot be changed now/);
  order(() => gate.reject(), /cannot be changed now/);
  assert.equal(gate.confirmed.amount.units, "500000000");
  // One request: the first checked, again as often as needed; another is a new task.
  assert.deepEqual(gate.check(request.grant, WALLET, request.digest), YES);
  assert.deepEqual(gate.check(request.grant, WALLET, request.digest), YES);
  const other = permitRequest({ amount: "1" });
  order(() => gate.check(other.grant, WALLET, other.digest), /cover one request/);
});

test("termsGate: the request is named by its id, not its grant: two Permit2 transfers that differ only in their nonce are two", () => {
  const gate = termsGate();
  gate.confirm(gate.propose(readTerms({ ...ASK, max_amount: "25" }, WALLET)));
  gate.read();
  const first = transferRequest({ nonce: "7" });
  const second = transferRequest({ nonce: "8" });
  // Both grant the same, and each signature can be spent on its own: the digest names the request, the grant does not.
  assert.deepEqual(second.grant, first.grant);
  assert.notEqual(second.digest, first.digest);
  assert.deepEqual(gate.check(first.grant, WALLET, first.digest), YES);
  assert.deepEqual(gate.check(first.grant, WALLET, first.digest), YES);
  order(() => gate.check(second.grant, WALLET, second.digest), /cover one request/);
  // An id comes with its request's grant: the same id with another grant is another request.
  order(() => gate.check(transferFrom({ permitted: { token: USDC, amount: "1" } }), WALLET, first.digest), /cover one request/);
  // A check without the request's id is the wallet's mistake, not the agent's (E_REQUEST).
  for (const id of [undefined, null, "", 7]) assert.equal(codeOf(() => gate.check(first.grant, WALLET, id)), CODES.REQUEST, String(id));
});

// ------------------------------------------------------------------------------------------------ planted faults

/**
 * The checks a planted fault must fail: lengths of time, an unknown app, the four comparisons and the order. `lib` is
 * the terms functions, or a copy with one fault planted.
 */
function battery(lib) {
  const failures = [];
  const expect = (ok, what) => ok || failures.push(what);
  for (const [text, want] of LENGTHS) expect(dayOf(lib, text) === want, `${JSON.stringify(text)} ends on ${want}`);
  for (const [from, text, want] of FROM_OTHER_DAYS) expect(dayOf(lib, text, { ...WALLET, now: noonOf(from) }) === want, `${text} from ${from} ends on ${want}`);
  expect(attempt(() => lib.readTerms({ ...ASK, spender: "SushiSwap" }, WALLET)) instanceof TermsError, "an app the wallet does not know is refused");
  const terms = lib.readTerms(ASK, WALLET);
  const confirmed = confirmTerms(terms);
  const good = permitSingle({});
  const verdict = (grant) => lib.checkGrant(confirmed, grant, WALLET).fits;
  expect(verdict(good), "the request the user asked for fits");
  expect(!verdict({ ...good, spender: ONEINCH }), "another spender does not fit");
  expect(!verdict({ ...good, token: DAI }), "another token does not fit");
  expect(!verdict({ ...good, amount: { units: "500000001", unlimited: false } }), "more than the most does not fit");
  expect(!verdict({ ...good, amount: { units: MAX160, unlimited: true } }), "unlimited does not fit a most");
  expect(!verdict({ ...good, ends: { at: secondsAt("2026-12-01T00:00:00Z") } }), "a later end does not fit");
  expect(!verdict({ ...good, ends: { never: true } }), "never does not fit an end");
  const gate = lib.termsGate();
  gate.propose(terms);
  gate.confirm(termsText(terms));
  gate.read();
  const changed = !(attempt(() => gate.propose(lib.readTerms({ ...ASK, max_amount: "unlimited" }, WALLET))) instanceof TermsError);
  expect(!changed && gate.confirmed.amount.units === "500000000", "the terms cannot change once the request was read");
  return failures;
}

const LIB = { readTerms, checkGrant, termsGate };
const LENGTH = /^\s*\d{1,4}\s*(day|week|month|year)s?\s*$/i;
/** Each fault as the everyday-wording test names it, planted by wrapping the library: the library itself has no switches. */
const FAULTS = {
  guard_ignores_spender: { ...LIB, checkGrant: (c, g, w) => checkGrant(c, g && { ...g, ...(g.spender !== undefined ? { spender: c.spender ?? c.to } : { to: c.to ?? c.spender }) }, w) },
  guard_ignores_token: { ...LIB, checkGrant: (c, g, w) => checkGrant(c, g && { ...g, token: c.token }, w) },
  guard_ignores_amount: { ...LIB, checkGrant: (c, g, w) => checkGrant(c, g && { ...g, amount: { units: "0", unlimited: false } }, w) },
  guard_ignores_expiry: { ...LIB, checkGrant: (c, g, w) => checkGrant(c, g && { ...g, ends: c.ends.never ? { never: true } : { at: c.ends.at } }, w) },
  length_off_by_one: { ...LIB, readTerms: (f, w) => readTerms(f, LENGTH.test(f.expires_by) ? { ...w, now: w.now + DAY } : w) },
  unknown_app_guessed: {
    ...LIB,
    readTerms: (f, w) => {
      const t = attempt(() => readTerms(f, w));
      if (t instanceof TermsError && /knows no app/.test(t.message)) return readTerms({ ...f, spender: Object.keys(w.apps)[0] }, w);
      if (t instanceof TermsError) throw t;
      return t;
    },
  },
  terms_change_after_read: {
    ...LIB,
    termsGate: () => {
      let gate = termsGate();
      return {
        propose: (t) => {
          if (gate.state === "read") (gate = termsGate()), gate.propose(t), gate.confirm(termsText(t)), gate.read();
          else gate.propose(t);
        },
        confirm: (shown) => gate.confirm(shown),
        read: () => gate.read(),
        get confirmed() {
          return gate.confirmed;
        },
      };
    },
  },
};

test("the seven planted faults of the everyday test that live in the guard are each caught; without them the checks pass", () => {
  assert.deepEqual(battery(LIB), []);
  for (const [fault, lib] of Object.entries(FAULTS)) {
    const failures = battery(lib);
    assert.ok(failures.length > 0, `fault ${fault} is not caught`);
  }
});
