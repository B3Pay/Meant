// Types for @meantjs/consent/sns (Node only: it hashes with node:crypto). Hand-written; the source is
// src/sns.mjs. test/types.test.mjs keeps the declared names equal to the runtime exports.
import type { Bytes, ConsentDiagnostic, DecodeLimits, Provenance, ResolvedForm } from "./index.mjs";

export type ValidatorResult = { Ok: string } | { Err: string };

/** The name and version of the rules a rendering follows; part of every rendering. */
export const SNS_RENDERING_RULES: "candid-profile-sns/v0";

/** An SNS generic-function validator as a function, with non-enumerable `diagnostics` and `provenance`. */
export function snsValidatorRendering(input: {
  /** The target method's Candid argument bytes, as governance passes them. */
  payload: Bytes;
  resolved: ResolvedForm;
  /** The target method this validator is registered for. */
  method: string;
  refs?: Record<string, unknown>;
  limits?: DecodeLimits;
}): ValidatorResult & { readonly diagnostics: ConsentDiagnostic[]; readonly provenance: Provenance };
/** The canister-side wrapper: payload bytes in, the Candid-encoded `variant { Ok : text; Err : text }` out. */
export function handleSnsValidatorCall(payload: Uint8Array, context: { resolved: ResolvedForm; method: string; refs?: Record<string, unknown>; limits?: DecodeLimits }): Uint8Array;
export function encodeValidatorResult(result: ValidatorResult): Uint8Array;
export function decodeValidatorResult(bytes: Uint8Array): ValidatorResult;

export interface GovernanceRendering {
  functionText: string;
  payloadSha256: string;
  payloadRendering: string;
  targetMethod: string | null;
  targetCanisterId: string | null;
  validatorMethod: string | null;
  validatorCanisterId: string | null;
}
/** A stored `payload_text_rendering` split into governance's parts, or null when it is not governance's layout. */
export function parseGovernanceRendering(text: string): GovernanceRendering | null;

export interface SnsCheck {
  name: string;
  ok: boolean;
  expected?: string;
  found?: string | null;
  note?: string;
}
/** The reviewer's check of a stored proposal rendering against what the profile renders for the payload. */
export function verifySnsRendering(input: {
  payloadTextRendering: string;
  payload: Bytes;
  resolved: ResolvedForm;
  /** The canister the reviewer expects governance to call, as text. */
  targetCanisterId: string;
  method: string;
  refs?: Record<string, unknown>;
  limits?: DecodeLimits;
}): { ok: boolean; checks: SnsCheck[]; expectedRendering: string | null; parsed: GovernanceRendering | null };
