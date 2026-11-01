// Types for @meantjs/consent/guard: the terms guard in front of an EVM signer (D-062). Hand-written; the source is
// src/guard.mjs. scripts/types.test.mjs keeps the declared names equal to the runtime exports.
import type { ResolvedForm } from "./index.mjs";
import type { eip712Consent } from "./evm.mjs";
import type { TermsGate, Wallet } from "./terms.mjs";

/** An EIP-712 signer: a viem LocalAccount, or x402's ClientEvmSigner (`@x402/evm`), has this shape. */
export interface EvmSigner {
  readonly address: `0x${string}`;
  signTypedData(params: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }): Promise<`0x${string}`>;
  readContract?(args: { address: `0x${string}`; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
}

export interface GuardOptions {
  /** The task's termsGate, with terms the user confirmed on the wallet's own screen. */
  gate: TermsGate;
  /** The terms' wallet. Its `now` is not used: the guard reads the clock (`now`) when a request comes. */
  wallet: Omit<Wallet, "now">;
  /** The chain the signer signs for: a request whose domain names another is refused. */
  chainId: number | bigint | string;
  /** The resolved forms of the contracts and messages the signer may sign for, such as the x402 and USDC profiles. */
  forms: ResolvedForm[];
  /** Nanoseconds since the Unix epoch. Default: the system clock. */
  now?: () => bigint;
}

/** A request the guard did not sign. `reasons` are in words, for the agent; `consent` is the request read, when one was. */
export declare class GuardError extends Error {
  constructor(code: string, message: string, details: { reasons: string[]; consent?: ReturnType<typeof eip712Consent> | null });
  readonly code: GuardCode;
  readonly reasons: string[];
  readonly consent: ReturnType<typeof eip712Consent> | null;
}
export declare const GUARD_CODES: {
  /** No profile given reads the request, or the profiles that read it disagree on what it grants. */
  readonly UNKNOWN: "E_GUARD_UNKNOWN";
  /** The request's grant does not fit the confirmed terms. */
  readonly REFUSED: "E_GUARD_REFUSED";
};
export type GuardCode = (typeof GUARD_CODES)[keyof typeof GUARD_CODES];

/**
 * The signer behind the terms guard. `signTypedData` signs only a request that one of `forms` reads and whose grant
 * fits the gate's confirmed terms; the gate's rules hold, so the terms cover one request (the same one may be signed
 * again) and a second is `E_TERMS_ORDER`. Otherwise it throws `GuardError`, or `TermsError` from the gate, and signs
 * nothing. Only `address`, `signTypedData` and the read-only `readContract` are kept: every other way to sign is withheld.
 */
export function guardSigner(signer: EvmSigner, options: GuardOptions): EvmSigner;
