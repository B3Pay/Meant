// Types for @meantjs/consent/terms: terms the user confirms for one task, and the check of a request's grant against
// them (spec section 5.3, "Confirmed terms", D-056). Hand-written; the source is src/terms.mjs. scripts/types.test.mjs
// keeps the declared names equal to the runtime exports.
import type { Grant } from "./index.mjs";

/** A term the agent wrote that cannot be read, or a step out of order: `message` is written for the agent. */
export declare class TermsError extends Error {
  constructor(code: string, message: string);
  readonly code: TermsCode;
}
export declare const TERMS_CODES: {
  /** A field is missing or empty, or both spender and to are given. */
  readonly MISSING: "E_TERMS_MISSING";
  /** A token the wallet does not know. */
  readonly TOKEN: "E_TERMS_TOKEN";
  /** An app the wallet does not know, or an address or account that is not one. */
  readonly PARTY: "E_TERMS_PARTY";
  /** An amount that cannot be read, or has more decimals than its token: never rounded. */
  readonly AMOUNT: "E_TERMS_AMOUNT";
  /** An end that cannot be read, or a date before today. */
  readonly END: "E_TERMS_END";
  /** termsGate: a step out of order. */
  readonly ORDER: "E_TERMS_ORDER";
};
export type TermsCode = (typeof TERMS_CODES)[keyof typeof TERMS_CODES];

/** What the terms functions read from the wallet. Pure: the wallet's clock and zone come in here. */
export interface Wallet {
  /** The tokens it knows, by symbol: an EVM token's address or a ledger's canister id, and its decimals. */
  tokens: Record<string, { address: string; decimals: number } | { canister: string; decimals: number }>;
  /** The apps and people it knows by name: an address, or an account in its ICRC-1 text. */
  apps?: Record<string, string>;
  /** Nanoseconds since the Unix epoch. */
  now: bigint;
  /** The user's zone (default 0, UTC): a date allows its whole day there. */
  utcOffsetMinutes?: number;
}

/** The terms as the agent writes them, a tool's arguments: `spender` or `to`, exactly one. */
export interface TermsFields {
  /** The token, by the symbol the wallet knows. */
  token: string;
  /** Who may spend the tokens: an app's name as the wallet knows it, or an address or account the user gave. */
  spender?: string;
  /** Who is paid directly: a name the wallet knows, or an address or account the user gave. */
  to?: string;
  /** The most, in tokens ("100", "0.5", "100 USDC"), or "unlimited". */
  max_amount: string;
  /** YYYY-MM-DD (the whole day counts), a length from today ("30 days", "2 weeks", "1 month", "1 year"), hours from now ("2 hours", an exact time), or "never". */
  expires_by: string;
}

/** What the user allows for one task, in the wallet's own values: `spender` or `to`, exactly one. */
export interface Terms {
  /** The token: an EIP-55 address, or a canister id in its canonical text. */
  token: string;
  symbol: string;
  decimals: number;
  spender?: string;
  to?: string;
  /** The app's name in the wallet's list, or null. */
  name: string | null;
  /** The most, in base units as a decimal string; `null` when unlimited. */
  amount: { units: string; unlimited: false } | { units: null; unlimited: true };
  /** `at`: the latest end, exact seconds since the Unix epoch as a decimal string; `day`: the local date whose whole day counts. */
  ends: { at: string; day?: string } | { never: true };
  utcOffsetMinutes: number;
  /** The fields as the agent wrote them, trimmed. */
  written: Record<string, string>;
}
/** Terms the user confirmed: `id` is the SHA-256 of their canonical JSON (RFC 8785), lowercase hex. */
export type ConfirmedTerms = Readonly<Terms & { id: string }>;

/** Reads the agent's terms. Throws TermsError when a term cannot be read; it never guesses a token, an app, decimals or a date. */
export function readTerms(fields: TermsFields | Record<string, unknown>, wallet: Wallet): Terms;
/** The terms in words, exactly, for the user to confirm on the wallet's own screen. */
export function termsText(terms: Terms | ConfirmedTerms): string;
/** The terms once the user has confirmed exactly `termsText(terms)`: frozen, with their `id`. */
export function confirmTerms(terms: Terms): ConfirmedTerms;
/** Whether a request's grant fits confirmed terms, and if not, why, in words. A null grant is not covered by terms. */
export function checkGrant(confirmed: ConfirmedTerms, grant: Grant | null, wallet: Wallet): { fits: boolean; reasons: string[] };

/** The order of one task: propose, confirm on the wallet's screen, read, check. Steps out of order throw TermsError E_TERMS_ORDER. */
export interface TermsGate {
  readonly state: "open" | "proposed" | "confirmed" | "read";
  readonly proposed: Readonly<Terms> | null;
  readonly confirmed: ConfirmedTerms | null;
  /** The agent's draft; replaces an earlier one and its confirmation. Returns the text to show the user. Refused once the request was read. */
  propose(terms: Terms): string;
  /** The user confirmed `shown`, which must be exactly the draft's text. */
  confirm(shown: string): ConfirmedTerms;
  /** The user said no: the draft is dropped. */
  reject(): void;
  /** Before the agent reads the request: refused until the user has confirmed terms. */
  read(): void;
  /**
   * The grant of the request read. `requestId` names the request the wallet will sign or send: eip712Consent's `digest`,
   * or for a call the wallet's own id of it. The terms cover one request, the first checked: another is refused, even
   * one that grants the same.
   */
  check(grant: Grant | null, wallet: Wallet, requestId: string): { fits: boolean; reasons: string[] };
}
export function termsGate(): TermsGate;
