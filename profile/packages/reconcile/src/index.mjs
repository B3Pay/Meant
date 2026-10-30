// Consumer rule 1 (docs/profile-v0.md section 5.3, outcome handling rules for consumers) without a transport. After
// an unknown outcome, before any new attempt, look for the original in the ledger's history: the ICRC-3 blocks since
// the first send, matched on the operation, the stamp, the amount, the fee, the accounts (the caller's included), the
// memo and, for an approval, its expiry and expected allowance.
//
// The caller reads the blocks (certified, and from archives when it needs them) and passes them in; this module
// only maps a call to the block it leaves and judges the blocks. It imports no Node built-in and needs no codec:
// arguments are candid-core values (bigint, Uint8Array, principal text) and blocks are ICRC-3 values in the
// `{ tag, value }` shape (`Map`, `Array`, `Nat`, `Int`, `Text`, `Blob`).
//
// Rules, each one in the safe direction:
// - An absent field is part of the match: an empty memo is not no memo (a ledger keeps an empty memo and
//   deduplicates it apart from none), and a block with a `spender` the call has not is another call.
// - The operation is the block's `btype` when it has one (ICRC-3 makes it authoritative), else its legacy `tx.op`.
// - A block in the range whose operation or amount (or stamp, when it has one) cannot be read is `unreadable`,
//   never "no match".
// - A call whose accounts cannot be read (a subaccount that is not bytes) maps to no block, so it is never
//   matched with a side left out.
// - A block that carries the call's stamp and amount from the call's account, in a shape the mapping does not know,
//   is a lookalike: the answer is `unreadable` with that block, never `absent`. An amount above u64::MAX counts as
//   u64::MAX here, because the DFINITY ledger's u64 build caps an approval there and writes the capped amount.
// - A block of the call's own operation that names another recipient or spender is another call, not a lookalike.
// - No block settles nothing while a send of the call may still land: `absent` only when no send is unknown, a send
//   was answered TooOld, or the ledger's clock is past the stamp's window; otherwise `not_yet`.
// - Blocks that do not cover every index from the first send to the tip are `unreadable`, never `absent`.
//
// Ledger knowledge the profile does not carry yet (no pack says it): the call-to-block mapping per method, the
// minting account turning a transfer into a mint or a burn, and the window (ICRC-1 TX_WINDOW plus PERMITTED_DRIFT,
// the DFINITY ledger's 24 hours and 2 minutes). The window is an option.
import { principalFromText } from "@meantjs/format";

/** ICRC-1 TX_WINDOW plus PERMITTED_DRIFT of the DFINITY ledger: how long after its stamp a call can still execute. */
export const DEDUP_WINDOW_NS = (24n * 60n + 2n) * 60n * 1_000_000_000n;
/** u64::MAX: where the DFINITY ledger's u64 build caps an approval above it. */
export const U64_MAX = 2n ** 64n - 1n;
/** The methods this module maps to a block. */
export const METHODS = Object.freeze(["icrc1_transfer", "icrc2_approve", "icrc2_transfer_from"]);

const ZERO = "0".repeat(64);
const TypedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayTag = Object.getOwnPropertyDescriptor(TypedArrayPrototype, Symbol.toStringTag).get;
const typedArrayValues = TypedArrayPrototype.values;
/**
 * Whether a view's memory can be read now: not detached, and not out of bounds after its resizable buffer shrank.
 * The intrinsic `values` validates the view the way reading it does (ValidateTypedArray) and throws otherwise.
 */
function isReadable(view) {
  try {
    typedArrayValues.call(view);
    return true;
  } catch {
    return false;
  }
}
/** A Uint8Array from any realm whose memory can be read (not detached, not out of bounds). */
const isBytes = (v) => ArrayBuffer.isView(v) && typedArrayTag.call(v) === "Uint8Array" && isReadable(v);
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** An account as owner bytes and a 64-hex subaccount (zero for none): how ICRC-3 compares accounts. */
function keyOf(owner, subaccount) {
  let bytes;
  try {
    bytes = principalFromText(owner);
  } catch {
    return undefined;
  }
  if (subaccount !== null && subaccount !== undefined && !isBytes(subaccount)) return undefined;
  return { owner: hex(bytes), subaccount: subaccount === null || subaccount === undefined ? ZERO : hex(subaccount) };
}
const accountKey = (account) => (account === null || account === undefined || typeof account !== "object" ? undefined : keyOf(account.owner, account.subaccount));
const sameKey = (a, b) => a !== undefined && b !== undefined && a.owner === b.owner && a.subaccount === b.subaccount;
const natOrNull = (v) => (typeof v === "bigint" ? v : null);
const present = (key, value) => (value === undefined ? {} : { [key]: value });

/**
 * The ICRC-3 transaction a call leaves in the log.
 *
 * @param {string} method  `icrc1_transfer`, `icrc2_approve` or `icrc2_transfer_from`
 * @param {Record<string, unknown>} arg  the call's argument record as candid-core values (`amount` and
 *        `created_at_time` bigint, accounts `{ owner: <principal text>, subaccount: Uint8Array | null }`, `memo`
 *        Uint8Array or null)
 * @param {string} caller  the caller's principal text
 * @param {{ minting?: { owner: string, subaccount?: Uint8Array | null } | null }} [options]  the ledger's
 *        `icrc1_minting_account`: a transfer from it is a `mint` (no `from`), one to it a `burn` (no `to`)
 * @returns the expected transaction (a transfer also carries the `btype` it leaves, `1xfer` or `2xfer`), or
 *          `undefined` for a method this module does not map, a call without a stamp
 *          (nothing makes its block specific) or an unreadable caller
 */
export function expectedTransaction(method, arg, caller, { minting = null } = {}) {
  if (arg === null || typeof arg !== "object") return undefined;
  const ts = arg.created_at_time;
  if (typeof ts !== "bigint" || typeof arg.amount !== "bigint") return undefined;
  if (arg.memo !== null && arg.memo !== undefined && !isBytes(arg.memo)) return undefined;
  const callerKey = (sub) => keyOf(caller, sub);
  if (callerKey(null) === undefined) return undefined;
  for (const key of ["from_subaccount", "spender_subaccount"]) if (arg[key] !== null && arg[key] !== undefined && !isBytes(arg[key])) return undefined;
  const common = { ts, amt: arg.amount, memo: isBytes(arg.memo) ? hex(arg.memo) : null, fee: natOrNull(arg.fee) };
  const mint = accountKey(minting);
  switch (method) {
    case "icrc1_transfer": {
      const from = callerKey(arg.from_subaccount);
      const to = accountKey(arg.to);
      if (from === undefined || to === undefined) return undefined;
      if (sameKey(from, mint)) return { ...common, op: "mint", to };
      if (sameKey(to, mint)) return { ...common, op: "burn", from };
      return { ...common, op: "xfer", btype: "1xfer", from, to };
    }
    case "icrc2_approve": {
      const spender = accountKey(arg.spender);
      const from = callerKey(arg.from_subaccount);
      if (spender === undefined || from === undefined) return undefined;
      return {
        ...common,
        op: "approve",
        from,
        spender,
        expires_at: natOrNull(arg.expires_at),
        expected_allowance: natOrNull(arg.expected_allowance),
      };
    }
    case "icrc2_transfer_from": {
      const from = accountKey(arg.from);
      const to = accountKey(arg.to);
      if (from === undefined || to === undefined) return undefined;
      const spender = callerKey(arg.spender_subaccount);
      if (spender === undefined) return undefined;
      // From the minting account it is a mint (no `from`), as the reference ledger classes it; to it, a burn (no `to`).
      // A mint block may leave `spender` out; then it cannot tell which spender made the call, so that is optional
      // only when the spender is the minting account itself.
      if (sameKey(from, mint)) return { ...common, op: "mint", to, spender, ...(sameKey(spender, from) ? { spenderOptional: true } : {}) };
      const burning = sameKey(to, mint);
      return {
        ...common,
        op: burning ? "burn" : "xfer",
        ...(burning ? {} : { btype: "2xfer" }),
        from,
        ...present("to", burning ? undefined : to),
        spender,
        // A spender spending its own account: a ledger may leave `spender` out of the block.
        ...(sameKey(spender, from) ? { spenderOptional: true } : {}),
      };
    }
    default:
      return undefined;
  }
}

// ---- ICRC-3 values -------------------------------------------------------------------------------------------

const get = (value, key) => (value?.tag === "Map" && Array.isArray(value.value) ? value.value.find((e) => Array.isArray(e) && e[0] === key)?.[1] : undefined);
const natOf = (v) => (v?.tag === "Nat" && typeof v.value === "bigint" ? v.value : undefined);
/** An optional Nat field: null when absent, its value when a Nat, undefined when present but not a Nat (equal to nothing). */
const optNat = (map, key) => {
  const v = get(map, key);
  return v === undefined ? null : natOf(v);
};
const textOf = (v) => (v?.tag === "Text" && typeof v.value === "string" ? v.value : undefined);
const blobOf = (v) => (v?.tag === "Blob" && isBytes(v.value) ? v.value : undefined);
/** ICRC-3 block types (the ICRC-1/2 block schema) as the legacy `tx.op` names. */
const BTYPES = { "1xfer": "xfer", "2xfer": "xfer", "1mint": "mint", "1burn": "burn", "2approve": "approve" };
/**
 * A block's operation: its `btype` when it has one (authoritative), else `tx.op`. An unknown btype matches nothing; a
 * `btype` that is present but not Text is unreadable (undefined), never a reason to fall back to `tx.op`.
 */
function opOf(block) {
  const raw = get(block, "btype");
  if (raw !== undefined) {
    const btype = textOf(raw);
    if (btype === undefined) return undefined;
    return Object.hasOwn(BTYPES, btype) ? BTYPES[btype] : `btype:${btype}`;
  }
  return textOf(get(get(block, "tx"), "op"));
}
/** Whether a block's operation and amount can be read, and its stamp when it has one (a call without one leaves none). */
function readable(block) {
  const tx = get(block, "tx");
  const ts = get(tx, "ts");
  return opOf(block) !== undefined && natOf(get(tx, "amt")) !== undefined && (ts === undefined || natOf(ts) !== undefined);
}

/** An ICRC-3 account: `Array [Blob owner]` or `Array [Blob owner, Blob subaccount]`. */
function keyOfValue(v) {
  if (v?.tag !== "Array" || !Array.isArray(v.value) || v.value.length < 1 || v.value.length > 2) return undefined;
  const owner = blobOf(v.value[0]);
  const sub = v.value.length === 2 ? blobOf(v.value[1]) : undefined;
  if (owner === undefined || (v.value.length === 2 && sub === undefined)) return undefined;
  return { owner: hex(owner), subaccount: sub === undefined ? ZERO : hex(sub) };
}

/** Whether an ICRC-3 block carries exactly this transaction. */
export function blockMatches(block, expected) {
  const tx = get(block, "tx");
  if (tx === undefined || expected === undefined) return false;
  if (opOf(block) !== expected.op) return false;
  // `1xfer` and `2xfer` both read as `xfer`, but the btype tells an icrc1_transfer from an icrc2_transfer_from.
  const btype = textOf(get(block, "btype"));
  if (btype !== undefined && expected.btype !== undefined && btype !== expected.btype) return false;
  // A spender's own transfer_from moves the same funds as an icrc1_transfer from that account, and ICRC-3 lets either
  // block carry `tx.spender` ("it CAN contain"), so only a `2xfer` btype tells them apart; a legacy block is a lookalike.
  if (expected.op === "xfer" && expected.spenderOptional === true && btype !== "2xfer") return false;
  if (natOf(get(tx, "ts")) !== expected.ts) return false;
  if (natOf(get(tx, "amt")) !== expected.amt) return false;
  if (optNat(tx, "fee") !== expected.fee) return false;
  const memo = get(tx, "memo");
  if (memo !== undefined && blobOf(memo) === undefined) return false;
  if ((memo === undefined ? null : hex(blobOf(memo))) !== expected.memo) return false;
  for (const side of ["from", "to", "spender"]) {
    const want = expected[side];
    const have = get(tx, side);
    // Without `spender`, only a `2xfer` btype tells a spender's own transfer_from from an icrc1_transfer (or a mint or
    // burn) with the same fields; a mint or burn stays a lookalike.
    if (side === "spender" && expected.spenderOptional === true && have === undefined && btype === "2xfer") continue;
    if (want === undefined) {
      if (have !== undefined) return false;
      continue;
    }
    if (!sameKey(keyOfValue(have), want)) return false;
  }
  if (expected.op === "approve") {
    if (optNat(tx, "expires_at") !== (expected.expires_at ?? null)) return false;
    if (optNat(tx, "expected_allowance") !== (expected.expected_allowance ?? null)) return false;
  }
  return true;
}

/**
 * A block with the call's stamp and amount from the call's account (or from none), whatever else it says: it may
 * be the original in a shape the mapping does not know. An amount above u64::MAX counts as u64::MAX too.
 */
function looksLikeIt(block, expected) {
  const tx = get(block, "tx");
  const amt = natOf(get(tx, "amt"));
  const sameAmount = amt === expected.amt || (expected.amt > U64_MAX && amt === U64_MAX);
  if (natOf(get(tx, "ts")) !== expected.ts || !sameAmount) return false;
  // only a source that reads as another account rules the block out; one in a shape this cannot read may be the call's
  const from = keyOfValue(get(tx, "from"));
  if (from !== undefined && expected.from !== undefined && !sameKey(from, expected.from)) return false;
  return !namesAnother(block, tx, expected);
}

/** A block of the call's own operation that names another recipient or spender than the call: another call. */
function namesAnother(block, tx, expected) {
  if (opOf(block) !== expected.op) return false;
  // `1xfer` and `2xfer` both read as `xfer`, but the btype tells an icrc1_transfer from an icrc2_transfer_from.
  const btype = textOf(get(block, "btype"));
  if (btype !== undefined && expected.btype !== undefined && btype !== expected.btype) return false;
  // A spender's own transfer_from moves the same funds as an icrc1_transfer from that account, and ICRC-3 lets either
  // block carry `tx.spender` ("it CAN contain"), so only a `2xfer` btype tells them apart; a legacy block is a lookalike.
  if (expected.op === "xfer" && expected.spenderOptional === true && btype !== "2xfer") return false;
  return ["to", "spender"].some((side) => {
    const want = expected[side];
    const have = keyOfValue(get(tx, side));
    return want !== undefined && have !== undefined && !sameKey(have, want);
  });
}

/**
 * Judge the blocks a caller read since the call's first send.
 *
 * @param {{ id: bigint, block: object }[]} blocks  ICRC-3 blocks with their indices, in any order; together they
 *        must hold every index from `floor` to `logLength - 1`
 * @param expected  from {@link expectedTransaction}
 * @param {object} o
 * @param {bigint} o.logLength  the log length when the blocks were read (`icrc3_get_blocks` `log_length`)
 * @param {bigint} [o.floor]  the log length before the first send: the original is at this index or later (default 0)
 * @param {boolean} o.inFlight  a send of the call had an unknown outcome, so it may still execute until refused
 * @param {boolean} [o.stampExpired]  a send was answered TooOld: the ledger refuses the stamp from then on. Sound
 *        only when `blocks` were read after that answer arrived: a block written before it is in them then.
 * @param {bigint} [o.ledgerTime]  the ledger's clock (ns), where the caller has it; otherwise the later of
 *        `ledgerTimeAtLeast` and the tip block's time stands in (both lower bounds on a clock that only moves forward)
 * @param {bigint} [o.ledgerTimeAtLeast]  a time the ledger's clock is at least (this machine's clock less the
 *        permitted drift, for a ledger that took this machine's stamps)
 * @param {bigint} [o.windowNs]  how long after its stamp a call can still execute: the ledger's TX_WINDOW plus
 *        PERMITTED_DRIFT ({@link DEDUP_WINDOW_NS} for the DFINITY ledger's defaults). Without it an in-flight call
 *        stays `not_yet`: nothing closes by the clock.
 * @param {bigint[]} [o.notOriginal]  blocks the person said are not the original: never a lookalike again
 * @returns {{ status: "found", block: bigint }
 *   | { status: "absent", closedBy: "answered" | "too_old" | "window_passed", clock?: { at: bigint, by: string } }
 *   | { status: "not_yet", openUntil?: bigint, reason?: string, clock?: { at: bigint, by: string } }
 *   | { status: "unreadable", reason: string, lookalike?: { block: bigint, op: string, capped: boolean } }}
 */
export function matchBlocks(blocks, expected, o) {
  if (expected === undefined) return { status: "unreadable", reason: "no rule maps this call to a block (no stamp, or an unknown method)" };
  if (typeof o?.logLength !== "bigint") throw new TypeError("matchBlocks: logLength (bigint) is required");
  if (typeof o.inFlight !== "boolean") throw new TypeError("matchBlocks: inFlight (boolean) is required");
  const floor = o.floor ?? 0n;
  if (floor > o.logLength) return { status: "unreadable", reason: `the log has ${o.logLength} blocks, fewer than the ${floor} it had before the first send` };

  const byId = new Map();
  for (const b of blocks) if (typeof b?.id === "bigint") byId.set(b.id, b.block);
  for (let id = floor; id < o.logLength; id++) {
    if (!byId.has(id)) return { status: "unreadable", reason: `block ${id} since the first send was not read (an archive, or a short page)` };
  }
  // An exact original wins over blocks this module cannot read: another standard's blocks share the log (ICRC-3).
  for (let id = o.logLength - 1n; id >= floor; id--) if (blockMatches(byId.get(id), expected)) return { status: "found", block: id };
  for (let id = floor; id < o.logLength; id++) {
    if (!readable(byId.get(id))) return { status: "unreadable", reason: `block ${id} has no operation or amount this module can read, or a stamp that is not a Nat` };
  }

  let lookalike;
  for (let id = o.logLength - 1n; id >= floor; id--) {
    const block = byId.get(id);
    if (lookalike === undefined && !(o.notOriginal ?? []).includes(id) && looksLikeIt(block, expected)) {
      const tx = get(block, "tx");
      lookalike = { block: id, op: opOf(block) ?? "?", capped: natOf(get(tx, "amt")) !== expected.amt };
    }
  }
  if (lookalike !== undefined) {
    return {
      status: "unreadable",
      reason: lookalike.capped
        ? `block ${lookalike.block} (op ${lookalike.op}) carries this call's stamp from its account with the amount capped at u64::MAX: it may be the original`
        : `block ${lookalike.block} (op ${lookalike.op}) carries this call's stamp and amount from its account in another shape: it may be the original`,
      lookalike,
    };
  }

  if (!o.inFlight) return { status: "absent", closedBy: "answered" };
  if (o.stampExpired === true) return { status: "absent", closedBy: "too_old" };
  let clock;
  if (typeof o.ledgerTime === "bigint") clock = { at: o.ledgerTime, by: "ledger" };
  else {
    const tipTime = o.logLength > 0n ? natOf(get(byId.get(o.logLength - 1n), "ts")) : undefined;
    const host = typeof o.ledgerTimeAtLeast === "bigint" ? o.ledgerTimeAtLeast : undefined;
    if (host !== undefined && (tipTime === undefined || host >= tipTime)) clock = { at: host, by: "host" };
    else if (tipTime !== undefined) clock = { at: tipTime, by: "block" };
  }
  // The window is the ledger's (TX_WINDOW plus PERMITTED_DRIFT, spec 4.3): without it nothing closes by the clock.
  if (typeof o.windowNs !== "bigint") return { status: "not_yet", reason: "no windowNs: the ledger's deduplication window is not known, so a send may still land", ...present("clock", clock) };
  const openUntil = expected.ts + o.windowNs;
  if (clock !== undefined && clock.at > openUntil) return { status: "absent", closedBy: "window_passed", clock };
  return { status: "not_yet", openUntil, ...present("clock", clock) };
}
