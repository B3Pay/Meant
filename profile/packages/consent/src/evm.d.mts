// Types for @meantjs/consent/evm: the consent text of an EVM call (spec section 15, D-054). Hand-written; the source is
// src/evm.mjs. scripts/types.test.mjs keeps the declared names equal to the runtime exports.
import type { AbiLimits, AbiValue } from "@meantjs/profile/evm";
import type { ConsentDiagnostic, Model, Provenance, ResolvedForm } from "./index.mjs";

/** An EVM contract's resolved form: `chain: "evm"`, and each method with its selector and named signature. */
export type EvmResolvedForm = ResolvedForm & { chain: "evm" };

/**
 * One call decoded against a resolved form: the function its selector names, and its arguments keyed by parameter
 * name (`#i` for an unnamed one). Strict: anything but the canonical encoding of the values read is E_DECODE.
 * Throws E_RESOLVED_FORM (not an EVM resolved form), E_METHOD_UNKNOWN (no such selector) or E_DECODE.
 */
export function decodeCalldata(resolved: ResolvedForm, calldata: Uint8Array | string, limits?: AbiLimits): { method: string; selector: string; values: Record<string, AbiValue> };

export interface EvmConsentInput {
  resolved: ResolvedForm;
  /** The selector and the ABI-encoded arguments, as bytes or 0x hex. */
  calldata: Uint8Array | string;
  /** The contract called: shown in the message, and checked against the deployments its profiles list (E_DEPLOYMENT). */
  to: string;
  /** Needed when a profile lists deployments. */
  chainId?: number | bigint | string;
  /** Resolved dynamic refs, keyed by `from`: `{ "query:decimals": 6, "query:symbol": "USDC" }`. */
  refs?: Record<string, unknown>;
  /**
   * For an amount whose token a field names (spec section 15.9): each such token's `decimals()` and `symbol()`, keyed by
   * its address. An amount in a token not listed is E_REF_UNRESOLVED; it is shown beside its token's address.
   */
  tokens?: Record<string, { decimals: number | bigint | string; symbol?: string }>;
  /** Default "generic" (Markdown). */
  form?: "generic" | "fields";
  /** Generic form only: show timestamps in this zone (default UTC). */
  utcOffsetMinutes?: number | null;
  /** Append the decoded raw arguments (spec section 11 item 1). */
  rawArguments?: boolean;
  limits?: AbiLimits;
}
/**
 * The consent text of an EVM call: the same model and the same two layouts as an ICRC-21 message, without its envelope,
 * ending with the contract's address and chain. A payable function is refused (E_UNSUPPORTED_TYPE): its native value
 * has no position in a profile yet.
 */
export function evmConsent(input: EvmConsentInput): {
  form: "generic" | "fields";
  /** Markdown for "generic"; the intent line and `[label, text]` rows for "fields". */
  message: string | { intent: string; fields: [string, string][] };
  method: string;
  selector: string;
  /** The contract, in its EIP-55 form. */
  to: string;
  chainId: string | null;
  diagnostics: ConsentDiagnostic[];
  provenance: Provenance;
  model: Model;
};

/** An EIP-712 signing request, as `eth_signTypedData_v4` takes it. `types.EIP712Domain` may be left out. */
export interface TypedData {
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  domain: { name?: string; version?: string; chainId?: number | bigint | string; verifyingContract?: string; salt?: string };
  message: Record<string, unknown>;
}
export interface Eip712ConsentInput {
  /** An EVM contract's resolved form with `messages` (spec section 15.9). */
  resolved: ResolvedForm;
  typedData: TypedData;
  /** The wallet's active chain: a domain for another chain is refused (E_DOMAIN). */
  chainId: number | bigint | string;
  /** Resolved dynamic refs; `query:` refs are calls to the verifying contract. */
  refs?: Record<string, unknown>;
  /** For an amount whose token a member names: each token's `decimals()` and `symbol()`, keyed by its address. */
  tokens?: Record<string, { decimals: number | bigint | string; symbol?: string }>;
  /** Default "generic" (Markdown). */
  form?: "generic" | "fields";
  /** Generic form only: show timestamps in this zone (default UTC). */
  utcOffsetMinutes?: number | null;
  /** Append the message's values (spec section 11 item 1). */
  rawArguments?: boolean;
  limits?: { maxBytes?: number; maxElements?: number };
}
/**
 * The consent text of an EIP-712 signing request (spec section 15.9): the message a profile describes, matched by its
 * type hash, in words, ending with the verifying contract, the digest and what a signature is. Refused before anything
 * is shown: a domain for another chain, without a chainId or verifyingContract, with a salt, or whose name or version
 * is not its profiles' (E_DOMAIN); a contract its profiles do not list (E_DEPLOYMENT); no message with the request's
 * type hash (E_TYPE_HASH); values that are not exactly the members, canonically written (E_DECODE); an amount in a
 * token not in `tokens` (E_REF_UNRESOLVED).
 */
export function eip712Consent(input: Eip712ConsentInput): {
  form: "generic" | "fields";
  /** Markdown for "generic"; the intent line and `[label, text]` rows for "fields". */
  message: string | { intent: string; fields: [string, string][] };
  primaryType: string;
  /** `0x` and 64 hex digits. */
  typeHash: string;
  /** The EIP-712 digest the signature signs: `0x` and 64 hex digits. */
  digest: string;
  /** The verifying contract, in its EIP-55 form. */
  verifyingContract: string;
  chainId: string;
  diagnostics: ConsentDiagnostic[];
  provenance: Provenance;
  model: Model;
};
