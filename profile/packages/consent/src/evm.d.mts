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
