// @meantjs/consent/guard as a TypeScript consumer uses it: a signer behind the terms guard, signing an x402 Permit2
// payment that fits the confirmed terms and refusing one that does not.
import { createSchemaValidator, validateProfile } from "@meantjs/profile";
import x402Doc from "@meantjs/profile/packs/x402-exact-permit2.profile.json" with { type: "json" };
import { GUARD_CODES, GuardError, guardSigner, type EvmSigner } from "@meantjs/consent/guard";
import { readTerms, termsGate, type Wallet } from "@meantjs/consent/terms";
import { check } from "./check.mts";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYEE = "0x5037546753d64F77A6fA95B6f85659B6a4A7F6FD";
const now = BigInt(Date.parse("2026-10-29T23:00:00Z")) * 1_000_000n;
const wallet: Wallet = { tokens: { USDC: { address: USDC, decimals: 6 } }, apps: { "Weather API": PAYEE }, now };

const x402 = await validateProfile(x402Doc, { validateSchema: await createSchemaValidator(), resolved: true });
const form = x402.resolved;
check(x402.ok && form !== undefined && form !== null, "the x402 profile");
/** One task's gate, with terms the user confirmed: 0.02 USDC to the Weather API. */
function confirmedGate() {
  const gate = termsGate();
  gate.confirm(gate.propose(readTerms({ token: "USDC", to: "Weather API", max_amount: "0.02", expires_by: "2026-10-30" }, wallet)));
  return gate;
}

const signed: unknown[] = [];
const signer: EvmSigner = {
  address: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826",
  signTypedData: async (params) => (signed.push(params), "0x00"),
};
const guard = () => guardSigner(signer, { gate: confirmedGate(), wallet, chainId: 84532, forms: [form], now: () => now });
const payment = (amount: bigint) => ({
  domain: { name: "Permit2", chainId: 84532, verifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
  types: {
    PermitWitnessTransferFrom: [
      { name: "permitted", type: "TokenPermissions" },
      { name: "spender", type: "address" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "witness", type: "Witness" },
    ],
    TokenPermissions: [
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    Witness: [
      { name: "to", type: "address" },
      { name: "validAfter", type: "uint256" },
    ],
  },
  primaryType: "PermitWitnessTransferFrom",
  message: { permitted: { token: USDC, amount }, spender: "0x402085c248EeA27D92E8b30b2C58ed07f9E20001", nonce: 3844945942549819n, deadline: 1793318289n, witness: { to: PAYEE, validAfter: 0n } },
});

const guarded: EvmSigner = guard();
check((await guarded.signTypedData(payment(11000n))) === "0x00" && signed.length === 1, "a payment within the terms is signed");
let refused: GuardError | null = null;
try {
  await guard().signTypedData(payment(30000n));
} catch (e) {
  if (e instanceof GuardError) refused = e;
}
check(refused !== null && refused.code === GUARD_CODES.REFUSED && refused.reasons.length > 0 && signed.length === 1, "a payment over the terms is refused and not signed");
