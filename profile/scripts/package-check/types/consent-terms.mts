// @meantjs/consent/terms as a TypeScript consumer uses it: the agent's terms read and shown, the user's confirmation,
// and the grant of a Permit2 signing request and of an ICRC-2 approve checked against them.
import { createSchemaValidator, loadPacks, resolveService, validateProfile } from "@meantjs/profile";
import permit2Doc from "@meantjs/profile/packs/permit2.profile.json" with { type: "json" };
import { generateConsent, type Grant } from "@meantjs/consent";
import { eip712Consent, type TypedData } from "@meantjs/consent/evm";
import { TERMS_CODES, TermsError, checkGrant, confirmTerms, readTerms, termsGate, termsText, type ConfirmedTerms, type Wallet } from "@meantjs/consent/terms";
import { LEDGER_DID, bytesFromHex, check } from "./check.mts";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const UNISWAP = "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af";
const LEDGER = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const wallet: Wallet = {
  tokens: { USDC: { address: USDC, decimals: 6 }, ICP: { canister: LEDGER, decimals: 8 } },
  apps: { Uniswap: UNISWAP },
  now: BigInt(Date.parse("2026-11-02T12:00:00Z")) * 1_000_000n,
};

const gate = termsGate();
const shown = gate.propose(readTerms({ token: "USDC", spender: "Uniswap", max_amount: "500", expires_by: "2026-11-30" }, wallet));
check(shown === `Uniswap (${UNISWAP}) may spend at most 500 USDC, until the end of 30 November 2026 (UTC).`, "the terms in words");
const confirmed: ConfirmedTerms = gate.confirm(shown);
check(/^[0-9a-f]{64}$/.test(confirmed.id) && gate.state === "confirmed", "confirmed, with an id");
gate.read();

const p2 = await validateProfile(permit2Doc, { validateSchema: await createSchemaValidator(), resolved: true });
check(p2.ok && p2.resolved !== undefined && p2.resolved !== null, "the Permit2 profile");
const typedData: TypedData = {
  types: {
    PermitSingle: [
      { name: "details", type: "PermitDetails" },
      { name: "spender", type: "address" },
      { name: "sigDeadline", type: "uint256" },
    ],
    PermitDetails: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
  primaryType: "PermitSingle",
  domain: { name: "Permit2", chainId: 1, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
  message: { details: { token: USDC, amount: "500000000", expiration: 0, nonce: 0 }, spender: UNISWAP, sigDeadline: "1793638800" },
};
const request = eip712Consent({ resolved: p2.resolved!, typedData, chainId: 1, tokens: { [USDC]: { decimals: 6, symbol: "USDC" } } });
const grant: Grant | null = request.grant;
check(grant !== null && grant.kind === "approve" && "at" in grant.ends && grant.ends.at === "1793638800", "Permit2's expiration 0 ends at sigDeadline");
check(request.values["spender"] === UNISWAP, "the decoded values");
const verdict = gate.check(grant, wallet, request.digest);
check(verdict.fits && verdict.reasons.length === 0, "the request fits the terms");

// An ICRC-2 approve of 5 tokens until 2026-10-09 12:00 UTC (packages/consent/test/golden/approve-tka-expiry-utc.json);
// its token is the ledger the wallet names. Terms that never end cover an allowance that ends.
const r = await resolveService({ did: LEDGER_DID, validateSchema: await createSchemaValidator(), packs: (await loadPacks()).map(({ doc }) => ({ doc })) });
check(r.ok && r.resolved !== null, "resolved");
const arg = bytesFromHex(
  "4449444c086c08c6fcb60201ba89e5c20402a2de94eb060282f3f3910c04d8a38ca80d7d919c9cbf0d01dea7f7da0d04cb96dcb40e056e7d6e036d7b6e786c02b3b0dac30368ad86ca8305066e076d7b010000000001008058b6afdadc1880cab5ee010001008058b6afdadc18010a00000000003000d3010100",
);
const approve = generateConsent({ resolved: r.resolved, method: "icrc2_approve", arg, refs: { "query:icrc1_decimals": 8, "query:icrc1_symbol": "ICP" }, canisterId: LEDGER });
const allowance: Grant | null = approve.grant;
check(allowance !== null && allowance.spender === "un4fu-tqaaa-aaaab-qadjq-cai" && allowance.token === LEDGER && "at" in allowance.ends && allowance.ends.at === "1791547200", "the approve's grant");
const icp: ConfirmedTerms = confirmTerms(readTerms({ token: "ICP", spender: "un4fu-tqaaa-aaaab-qadjq-cai", max_amount: "5", expires_by: "never" }, wallet));
check(checkGrant(icp, allowance, wallet).fits, "an allowance that ends fits terms that never end");
check(termsText(icp).endsWith("and this permission never ends."), "never ends, written out");
check(!checkGrant(confirmTerms(readTerms({ token: "ICP", spender: "un4fu-tqaaa-aaaab-qadjq-cai", max_amount: "4.99999999", expires_by: "never" }, wallet)), allowance, wallet).fits, "more than the most does not fit");

try {
  readTerms({ token: "USDT", spender: "Uniswap", max_amount: "1", expires_by: "never" }, wallet);
  check(false, "an unknown token must throw");
} catch (e) {
  check(e instanceof TermsError && e.code === TERMS_CODES.TOKEN, "E_TERMS_TOKEN");
}

export function refusedTypes(): void {
  // @ts-expect-error now is a bigint in nanoseconds
  readTerms({ token: "USDC", spender: "Uniswap", max_amount: "1", expires_by: "never" }, { ...wallet, now: Date.now() });
  // @ts-expect-error the gate checks one request, named by its id
  gate.check(grant, wallet);
}
