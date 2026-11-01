// The terms guard in front of an EVM signer (D-062): a signer such as a viem account or x402's ClientEvmSigner, whose
// signTypedData signs only a request that a profile reads (eip712Consent) and whose grant fits the terms the user
// confirmed (termsGate, D-056). Every other way the signer can sign (signTransaction, signMessage, signAuthorization)
// is withheld, so nothing is signed around the guard.

import { jcs } from "@meantjs/profile/evm";
import { CODES, ConsentError, fail } from "./errors.mjs";
import { eip712Consent } from "./evm.mjs";

/** A request the guard did not sign. `reasons` are in words, for the agent; `consent` is the request read, when one was. */
export class GuardError extends Error {
  /**
   * @param {string} code  one of GUARD_CODES
   * @param {string} message
   * @param {{ reasons: string[], consent?: object | null }} details
   */
  constructor(code, message, { reasons, consent = null }) {
    super(message);
    this.name = "GuardError";
    this.code = code;
    this.reasons = reasons;
    this.consent = consent;
  }
}

export const GUARD_CODES = Object.freeze({
  /** No profile given reads the request, or the profiles that read it disagree on what it grants. */
  UNKNOWN: "E_GUARD_UNKNOWN",
  /** The request's grant does not fit the confirmed terms. */
  REFUSED: "E_GUARD_REFUSED",
});

const systemNow = () => BigInt(Date.now()) * 1_000_000n;

/**
 * @param {{ address: string, signTypedData: Function, readContract?: Function }} signer
 * @param {{ gate: ReturnType<typeof import("./terms.mjs").termsGate>, wallet: object, chainId: number | bigint | string, forms: object[], now?: () => bigint }} options
 */
export function guardSigner(signer, { gate, wallet, chainId, forms, now = systemNow } = {}) {
  if (typeof signer?.address !== "string" || typeof signer.signTypedData !== "function") fail(CODES.REQUEST, "signer must have an address and signTypedData, as a viem account or x402's ClientEvmSigner has");
  if (typeof gate?.read !== "function" || typeof gate.check !== "function") fail(CODES.REQUEST, "gate must be a termsGate()");
  if (typeof wallet?.tokens !== "object" || wallet.tokens === null) fail(CODES.REQUEST, "wallet must be the terms' wallet, with its tokens");
  if (!Array.isArray(forms) || forms.length === 0) fail(CODES.REQUEST, "forms must list the resolved forms of the contracts and messages the signer may sign for");
  if (typeof now !== "function") fail(CODES.REQUEST, "now must be a function returning nanoseconds since the Unix epoch as a bigint");
  // The wallet's tokens are the ones an amount may be in: eip712Consent's `tokens`, keyed by address.
  const tokens = {};
  for (const [symbol, t] of Object.entries(wallet.tokens)) if (typeof t?.address === "string") tokens[t.address] = { decimals: t.decimals, symbol };

  async function signTypedData(params) {
    const { domain, types, primaryType, message } = params ?? {};
    const typedData = structuredClone({ domain, types, primaryType, message }); // the request checked is the one signed
    gate.read();
    // A token's own message (EIP-2612, EIP-3009) reads its decimals and symbol as `query:` refs of the verifying contract.
    const own = Object.entries(tokens).find(([address]) => address.toLowerCase() === String(typedData.domain?.verifyingContract).toLowerCase())?.[1];
    const refs = own ? { "query:decimals": own.decimals, "query:symbol": own.symbol } : {};
    const read = [];
    const refusals = [];
    forms.forEach((resolved, i) => {
      try {
        read.push({ i, consent: eip712Consent({ resolved, typedData, chainId, refs, tokens }) });
      } catch (e) {
        if (!(e instanceof ConsentError)) throw e;
        refusals.push(`forms[${i}]: ${e.code}: ${e.message}`);
      }
    });
    if (read.length === 0) throw new GuardError(GUARD_CODES.UNKNOWN, `no profile reads this request: ${refusals.join("; ")}`, { reasons: refusals });
    // A profile that does not read the request never vetoes one that does: the terms check its grant either way.
    const grants = read.map(({ i, consent }) => [i, jcs(consent.grant ?? null)]);
    if (grants.some(([, g]) => g !== grants[0][1])) {
      const reasons = grants.map(([i, g]) => `forms[${i}] reads its grant as ${g}`);
      throw new GuardError(GUARD_CODES.UNKNOWN, "the profiles that read this request disagree on what it grants", { reasons });
    }
    const { consent } = read[0];
    const { fits, reasons } = gate.check(consent.grant, { ...wallet, now: now() }, consent.digest);
    if (!fits) throw new GuardError(GUARD_CODES.REFUSED, `the request does not fit the confirmed terms: ${reasons.join("; ")}`, { reasons, consent });
    return signer.signTypedData(typedData);
  }

  const guarded = { address: signer.address, signTypedData };
  if (typeof signer.readContract === "function") guarded.readContract = (args) => signer.readContract(args);
  return Object.freeze(guarded);
}
