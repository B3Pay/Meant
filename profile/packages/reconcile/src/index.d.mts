// Types for @meantjs/reconcile. Hand-written; the source is src/index.mjs.
// test/types.test.mjs keeps the declared names equal to the runtime exports, and `npm run types` compiles a consumer
// against these declarations under strict TypeScript.

/** ICRC-1 TX_WINDOW plus PERMITTED_DRIFT of the DFINITY ledger (24 h 2 min, in ns). */
export const DEDUP_WINDOW_NS: bigint;
/** u64::MAX: where the DFINITY ledger's u64 build caps an approval above it. */
export const U64_MAX: bigint;
/** The methods this module maps to a block. */
export const METHODS: readonly ["icrc1_transfer", "icrc2_approve", "icrc2_transfer_from"];
export type ReconciledMethod = (typeof METHODS)[number];

/** An account as ICRC-3 compares it: owner bytes and a 64-hex subaccount (all zero for the default). */
export interface AccountKey {
  owner: string;
  subaccount: string;
}
/** An ICRC-1 account in candid-core's domain shape. */
export interface Account {
  owner: string;
  subaccount?: Uint8Array | null;
}

/** The ICRC-3 transaction a call leaves in the log, as `expectedTransaction` maps it. */
export interface ExpectedTransaction {
  op: "xfer" | "mint" | "burn" | "approve";
  /** `1xfer` or `2xfer` for a transfer (ICRC-3 makes `btype` authoritative when a block has one). */
  btype?: "1xfer" | "2xfer";
  ts: bigint;
  amt: bigint;
  /** Hex, or null for no memo (an empty memo is not no memo). */
  memo: string | null;
  fee: bigint | null;
  from?: AccountKey;
  to?: AccountKey;
  spender?: AccountKey;
  /** A mint by `transfer_from` whose spender is the minting account may leave `spender` out. */
  spenderOptional?: true;
  expires_at?: bigint | null;
  expected_allowance?: bigint | null;
}

/**
 * The ICRC-3 transaction a call leaves. `arg` is the call's argument record as candid-core values (`amount` and
 * `created_at_time` bigint, accounts `{ owner: <principal text>, subaccount: Uint8Array | null }`, `memo` Uint8Array
 * or null). Undefined for a method this module does not map, a call without a stamp, or an unreadable caller.
 *
 * @param options.minting the ledger's `icrc1_minting_account`: a transfer from it is a mint, to it a burn
 */
export function expectedTransaction(
  method: string,
  arg: Record<string, unknown>,
  caller: string,
  options?: { minting?: Account | null },
): ExpectedTransaction | undefined;

/** An ICRC-3 value in the `{ tag, value }` shape. */
export type Icrc3Value =
  | { tag: "Map"; value: [string, Icrc3Value][] }
  | { tag: "Array"; value: Icrc3Value[] }
  | { tag: "Nat"; value: bigint }
  | { tag: "Int"; value: bigint }
  | { tag: "Text"; value: string }
  | { tag: "Blob"; value: Uint8Array };

/** Whether an ICRC-3 block carries exactly this transaction. */
export function blockMatches(block: Icrc3Value, expected: ExpectedTransaction | undefined): boolean;

export interface MatchOptions {
  /** The log length when the blocks were read (`icrc3_get_blocks` `log_length`). */
  logLength: bigint;
  /** The log length before the first send (default 0). */
  floor?: bigint;
  /** A send of the call had an unknown outcome, so it may still execute until refused. */
  inFlight: boolean;
  /** A send was answered TooOld (sound only for blocks read after that answer). */
  stampExpired?: boolean;
  /** The ledger's clock (ns), where the caller has it. */
  ledgerTime?: bigint;
  /** A time the ledger's clock is at least. */
  ledgerTimeAtLeast?: bigint;
  /** How long after its stamp a call can still execute (`DEDUP_WINDOW_NS` for the DFINITY ledger). */
  windowNs?: bigint;
  /** Blocks the person said are not the original. */
  notOriginal?: bigint[];
}

export type ClockReading = { at: bigint; by: string };
export type MatchResult =
  | { status: "found"; block: bigint }
  | { status: "absent"; closedBy: "answered" | "too_old" | "window_passed"; clock?: ClockReading }
  | { status: "not_yet"; openUntil?: bigint; reason?: string; clock?: ClockReading }
  | { status: "unreadable"; reason: string; lookalike?: { block: bigint; op: string; capped: boolean } };

/**
 * Judge the blocks a caller read since the call's first send: found, absent, not yet, or unreadable (never
 * "absent" while a send may still land or a block in the range could not be read).
 *
 * @param blocks ICRC-3 blocks with their indices, together holding every index from `floor` to `logLength - 1`
 */
export function matchBlocks(blocks: { id: bigint; block: Icrc3Value }[], expected: ExpectedTransaction | undefined, options: MatchOptions): MatchResult;
