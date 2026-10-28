// The golden cases: every ICRC-1 / ICRC-2 update method on the three eval ledgers (8, 6 and 18 decimals).
// Shared by scripts/generate-golden.mjs (which writes test/golden/*.json and REVIEW.md) and test/golden.test.mjs.
//
// Each case also carries `expect`: what the message must say, worked out by hand here and not read from the
// generator's output, so a golden file cannot just record a bug. `amount()` is an independent oracle for the
// decimal text (plain string slicing, no library).

import { ALICE, BOB, LEDGERS, SPENDER, subaccountText } from "../helpers.mjs";

/** base units + decimals -> "1.5 SYM", by string arithmetic only. */
export function amount(base, decimals, symbol) {
  const digits = BigInt(base).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} ${symbol}`;
}

const U64 = 2n ** 64n - 1n;
const STAMP = "opt (1_791_547_200_000_000_000 : nat64)"; // created_at_time: the idempotency stamp, never part of a message
const acct = (owner, sub) => `record { owner = principal "${owner}"; subaccount = ${sub === undefined ? "null" : `opt ${subaccountText(sub)}`} }`;
const blobText = (s) => `blob "${[...Buffer.from(s, "utf8")].map((b) => `\\${b.toString(16).padStart(2, "0")}`).join("")}"`;
const HOSTILE_MEMO = "[Approve now](https://evil.example/drain) **URGENT** <b>x</b> `y` &amp;";
// The memo contains one backtick, so its code span is fenced with two.
const HOSTILE_SPAN = `\`\`${HOSTILE_MEMO}\`\``;
const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const transfer = ({ to, amount: a, memo = "null", fee = "null", from = "null" }) =>
  `(record { to = ${to}; amount = ${a} : nat; memo = ${memo}; fee = ${fee}; from_subaccount = ${from}; created_at_time = ${STAMP} })`;
const approve = ({ spender, amount: a, expires = "null", expected = "null", memo = "null", from = "null", fee = "null" }) =>
  `(record { spender = ${spender}; amount = ${a} : nat; expires_at = ${expires}; expected_allowance = ${expected}; memo = ${memo}; fee = ${fee}; from_subaccount = ${from}; created_at_time = ${STAMP} })`;
const transferFrom = ({ from, to, amount: a, spender = "null", memo = "null", fee = "null" }) =>
  `(record { from = ${from}; to = ${to}; amount = ${a} : nat; spender_subaccount = ${spender}; memo = ${memo}; fee = ${fee}; created_at_time = ${STAMP} })`;

const L = LEDGERS;
const tka = (base) => amount(base, 8, "TKA");
const tkb = (base) => amount(base, 6, "TKB");
const tkc = (base) => amount(base, 18, "TKC");
const tokenAmount = (ledger, base) => ({ TokenAmount: { decimals: ledger.decimals, amount: String(base), symbol: ledger.symbol } });
const text = (content) => ({ Text: { content } });

/**
 * @typedef {object} Case
 * @property {string} id
 * @property {string} why  what the case is for
 * @property {"icrc1" | "icrc2"} pack  which committed resolved form (fixtures/*.resolved.json) is used
 * @property {string} method
 * @property {keyof typeof LEDGERS} ledger
 * @property {string} args  textual Candid; the bytes are produced by @dfinity/didc
 * @property {number | null} [utcOffsetMinutes]  for the generic form
 * @property {object} expect  worked out by hand: rows (label -> ICRC-21 Value JSON, amounts as decimal strings), `sentence` (the generic paragraph), `intent` (fields form)
 */

/** @type {Case[]} */
export const CASES = [
  // ------------------------------------------------------------------------------------------ icrc1_transfer
  {
    id: "transfer-tka-basic",
    why: "0.29 TKA to Alice. Every optional absent: nothing about subaccounts, memo or fee appears.",
    pack: "icrc1", method: "icrc1_transfer", ledger: "TKA",
    args: transfer({ to: acct(ALICE), amount: 29_000_000 }),
    expect: {
      intent: `Send tokens: Send 0.29 TKA to ${ALICE}`,
      sentence: `Send \`0.29 TKA\` to \`${ALICE}\``,
      rows: { Amount: tokenAmount(L.TKA, 29_000_000), Recipient: text(ALICE) },
    },
  },
  {
    id: "transfer-tka-full",
    why: "Every optional present: recipient subaccount 7, sender subaccount 1, memo, explicit fee. Rows follow the template, not the record order.",
    pack: "icrc1", method: "icrc1_transfer", ledger: "TKA",
    args: transfer({ to: acct(BOB, 7), amount: 150_000_000, memo: `opt ${blobText("lunch")}`, fee: "opt (10_000 : nat)", from: `opt ${subaccountText(1)}` }),
    expect: {
      intent: /^Send tokens: Send 1\.5 TKA to \S+\.7 from subaccount #1 with memo lunch paying fee 0\.0001 TKA$/,
      sentence: /^Send `1\.5 TKA` to `\S+\.7` from subaccount `#1` with memo `lunch` paying fee `0\.0001 TKA`$/,
      rows: { Amount: tokenAmount(L.TKA, 150_000_000), "From subaccount": text("#1"), Memo: text("lunch"), Fee: tokenAmount(L.TKA, 10_000) },
      labels: ["Amount", "Recipient", "From subaccount", "Memo", "Fee"],
    },
  },
  {
    id: "transfer-tkb-subaccount",
    why: "2.75 TKB (6 decimals) to Bob's account with subaccount 7; the recipient is the ICRC-1 textual account.",
    pack: "icrc1", method: "icrc1_transfer", ledger: "TKB",
    args: transfer({ to: acct(BOB, 7), amount: 2_750_000 }),
    expect: {
      intent: /^Send tokens: Send 2\.75 TKB to \S+-\w+\.7$/,
      sentence: /^Send `2\.75 TKB` to `\S+-\w+\.7`$/,
      rows: { Amount: tokenAmount(L.TKB, 2_750_000) },
    },
  },
  {
    id: "transfer-tkc-full-precision",
    why: "0.123456789012345678 TKC (18 decimals) fits nat64, so it is a TokenAmount, and every digit is kept.",
    pack: "icrc1", method: "icrc1_transfer", ledger: "TKC",
    args: transfer({ to: acct(ALICE), amount: 123_456_789_012_345_678n }),
    expect: {
      intent: `Send tokens: Send 0.123456789012345678 TKC to ${ALICE}`,
      sentence: `Send \`0.123456789012345678 TKC\` to \`${ALICE}\``,
      rows: { Amount: tokenAmount(L.TKC, 123_456_789_012_345_678n) },
    },
  },
  {
    id: "transfer-tkc-last-nat64",
    why: "Boundary: 2^64 - 1 base units is the largest amount a TokenAmount can carry.",
    pack: "icrc1", method: "icrc1_transfer", ledger: "TKC",
    args: transfer({ to: acct(ALICE), amount: U64 }),
    expect: {
      intent: `Send tokens: Send ${tkc(U64)} to ${ALICE}`,
      sentence: `Send \`${tkc(U64)}\` to \`${ALICE}\``,
      rows: { Amount: tokenAmount(L.TKC, U64) },
    },
  },
  {
    id: "transfer-tkc-above-nat64",
    why: "25 TKC = 25 * 10^18 base units > 2^64 - 1: TokenAmount.amount is a nat64, so the Amount row falls back to Text, with every digit.",
    pack: "icrc1", method: "icrc1_transfer", ledger: "TKC",
    args: transfer({ to: acct(ALICE), amount: 25_000_000_000_000_000_000n }),
    expect: {
      intent: `Send tokens: Send 25 TKC to ${ALICE}`,
      sentence: `Send \`25 TKC\` to \`${ALICE}\``,
      rows: { Amount: text("25 TKC") },
    },
  },
  {
    id: "transfer-tka-above-nat64",
    why: "Boundary on 8 decimals: 2^64 base units is 184467440737.09551616 TKA; Text, not a rounded TokenAmount.",
    pack: "icrc1", method: "icrc1_transfer", ledger: "TKA",
    args: transfer({ to: acct(ALICE), amount: U64 + 1n }),
    expect: {
      intent: `Send tokens: Send 184467440737.09551616 TKA to ${ALICE}`,
      sentence: `Send \`184467440737.09551616 TKA\` to \`${ALICE}\``,
      rows: { Amount: text("184467440737.09551616 TKA") },
    },
  },
  {
    id: "transfer-tkb-hostile-memo",
    why: "A Markdown-hostile memo (link, bold, HTML, backticks, entity): a code span in the generic form, plain text in the fields form.",
    pack: "icrc1", method: "icrc1_transfer", ledger: "TKB",
    args: transfer({ to: acct(ALICE), amount: 1_000_000, memo: `opt ${blobText(HOSTILE_MEMO)}` }),
    expect: {
      intent: `Send tokens: Send 1 TKB to ${ALICE} with memo ${HOSTILE_MEMO}`,
      sentence: `Send \`1 TKB\` to \`${ALICE}\` with memo ${HOSTILE_SPAN}`,
      rows: { Amount: tokenAmount(L.TKB, 1_000_000), Memo: text(HOSTILE_MEMO) },
      memo: HOSTILE_MEMO,
    },
  },
  {
    id: "transfer-tka-binary-memo",
    why: "A memo that is not UTF-8 is shown as lowercase hex, never decoded lossily.",
    pack: "icrc1", method: "icrc1_transfer", ledger: "TKA",
    args: transfer({ to: acct(ALICE), amount: 1, memo: `opt blob "\\ff\\fe\\00\\01"` }),
    expect: {
      intent: `Send tokens: Send 0.00000001 TKA to ${ALICE} with memo 0xfffe0001`,
      sentence: `Send \`0.00000001 TKA\` to \`${ALICE}\` with memo \`0xfffe0001\``,
      rows: { Amount: tokenAmount(L.TKA, 1), Memo: text("0xfffe0001") },
    },
  },
  // ------------------------------------------------------------------------------------------ icrc2_approve
  {
    id: "approve-tka-basic",
    why: "Approval without expiry, memo or expected allowance: the sentence says it replaces any existing allowance and says nothing else.",
    pack: "icrc2", method: "icrc2_approve", ledger: "TKA",
    args: approve({ spender: acct(SPENDER), amount: 500_000_000 }),
    expect: {
      intent: `Approve spending: Set ${SPENDER}'s allowance to 5 TKA, replacing any existing allowance`,
      sentence: `Set \`${SPENDER}\`'s allowance to \`5 TKA\`, replacing any existing allowance`,
      rows: { Spender: text(SPENDER), Allowance: tokenAmount(L.TKA, 500_000_000) },
    },
  },
  {
    id: "approve-tka-expiry-utc",
    why: "An expiry in exact seconds: a TimestampSeconds row; the generic form shows it in UTC when no offset is requested.",
    pack: "icrc2", method: "icrc2_approve", ledger: "TKA",
    args: approve({ spender: acct(SPENDER), amount: 500_000_000, expires: "opt (1_791_547_200_000_000_000 : nat64)" }),
    expect: {
      intent: `Approve spending: Set ${SPENDER}'s allowance to 5 TKA, replacing any existing allowance until 2026-10-09T12:00:00Z`,
      sentence: `Set \`${SPENDER}\`'s allowance to \`5 TKA\`, replacing any existing allowance until \`2026-10-09 12:00:00 UTC\``,
      rows: { Allowance: tokenAmount(L.TKA, 500_000_000), "Expires at": { TimestampSeconds: { amount: "1791547200" } } },
      offset: 0,
    },
  },
  {
    id: "approve-tka-expiry-plus-2h",
    why: "The same instant for a user at UTC+02:00: the generic form localizes it and the response says so; the fields form is unchanged (UTC seconds).",
    pack: "icrc2", method: "icrc2_approve", ledger: "TKA", utcOffsetMinutes: 120,
    args: approve({ spender: acct(SPENDER), amount: 500_000_000, expires: "opt (1_791_547_200_000_000_000 : nat64)" }),
    expect: {
      intent: `Approve spending: Set ${SPENDER}'s allowance to 5 TKA, replacing any existing allowance until 2026-10-09T12:00:00Z`,
      sentence: `Set \`${SPENDER}\`'s allowance to \`5 TKA\`, replacing any existing allowance until \`2026-10-09 14:00:00 UTC+02:00\``,
      rows: { "Expires at": { TimestampSeconds: { amount: "1791547200" } } },
      offset: 120,
    },
  },
  {
    id: "approve-tkb-everything",
    why: "6 decimals, every optional present: expected allowance, expiry with half a second (not a whole number of seconds, so Text in UTC), memo, sender subaccount, spender subaccount. The row labels come from the icrc2 pack (D-029).",
    pack: "icrc2", method: "icrc2_approve", ledger: "TKB", utcOffsetMinutes: -330,
    args: approve({ spender: acct(BOB, 9), amount: 12_500_000, expected: "opt (3_000_000 : nat)", expires: "opt (1_791_547_200_500_000_000 : nat64)", memo: `opt ${blobText("monthly")}`, from: `opt ${subaccountText(2)}` }),
    expect: {
      intent: /^Approve spending: Set \S+\.9's allowance to 12\.5 TKB, replacing any existing allowance \(only if the current allowance is 3 TKB\) until 2026-10-09T12:00:00\.5Z from subaccount #2 with memo monthly$/,
      sentence: /^Set `\S+\.9`'s allowance to `12\.5 TKB`, replacing any existing allowance \(only if the current allowance is `3 TKB`\) until `2026-10-09 06:30:00\.5 UTC-05:30` from subaccount `#2` with memo `monthly`$/,
      rows: { Allowance: tokenAmount(L.TKB, 12_500_000), "Expected current allowance": tokenAmount(L.TKB, 3_000_000), "Expires at": text("2026-10-09T12:00:00.5Z"), Memo: text("monthly") },
      labels: ["Spender", "Allowance", "Expected current allowance", "Expires at", "From subaccount", "Memo"],
      offset: -330,
    },
  },
  {
    id: "approve-tkc-above-nat64",
    why: "18 decimals: the allowance and the expected allowance both exceed nat64, so both rows are Text.",
    pack: "icrc2", method: "icrc2_approve", ledger: "TKC",
    args: approve({ spender: acct(SPENDER), amount: 100_000_000_000_000_000_000n, expected: "opt (30_000_000_000_000_000_000 : nat)" }),
    expect: {
      intent: `Approve spending: Set ${SPENDER}'s allowance to 100 TKC, replacing any existing allowance (only if the current allowance is 30 TKC)`,
      sentence: `Set \`${SPENDER}\`'s allowance to \`100 TKC\`, replacing any existing allowance (only if the current allowance is \`30 TKC\`)`,
      rows: { Allowance: text("100 TKC"), "Expected current allowance": text("30 TKC") },
    },
  },
  {
    id: "approve-tka-unlimited",
    why: "The common 'unlimited' approval, 2^256 - 1 base units: shown in full as Text, not as a rounded or scientific number.",
    pack: "icrc2", method: "icrc2_approve", ledger: "TKA",
    args: approve({ spender: acct(SPENDER), amount: 2n ** 256n - 1n }),
    expect: {
      intent: `Approve spending: Set ${SPENDER}'s allowance to ${tka(2n ** 256n - 1n)}, replacing any existing allowance`,
      sentence: `Set \`${SPENDER}\`'s allowance to \`${tka(2n ** 256n - 1n)}\`, replacing any existing allowance`,
      rows: { Allowance: text(tka(2n ** 256n - 1n)) },
    },
  },
  {
    id: "approve-tka-hostile-memo",
    why: "Hostile memo on an approval, with a spender subaccount.",
    pack: "icrc2", method: "icrc2_approve", ledger: "TKA",
    args: approve({ spender: acct(BOB, 1), amount: 100_000_000, memo: `opt ${blobText(HOSTILE_MEMO)}` }),
    expect: {
      intent: new RegExp(`^Approve spending: Set \\S+\\.1's allowance to 1 TKA, replacing any existing allowance with memo ${escapeRe(HOSTILE_MEMO)}$`),
      sentence: new RegExp(`^Set \`\\S+\\.1\`'s allowance to \`1 TKA\`, replacing any existing allowance with memo ${escapeRe(HOSTILE_SPAN)}$`),
      rows: { Memo: text(HOSTILE_MEMO) },
      memo: HOSTILE_MEMO,
    },
  },
  // ------------------------------------------------------------------------------------------ icrc2_transfer_from
  {
    id: "transfer-from-tka-basic",
    why: "A spender moves 2 TKA from Alice to Bob using an allowance.",
    pack: "icrc2", method: "icrc2_transfer_from", ledger: "TKA",
    args: transferFrom({ from: acct(ALICE), to: acct(BOB), amount: 200_000_000 }),
    expect: {
      intent: `Transfer using allowance: Move 2 TKA from ${ALICE} to ${BOB} using an allowance`,
      sentence: `Move \`2 TKA\` from \`${ALICE}\` to \`${BOB}\` using an allowance`,
      rows: { Amount: tokenAmount(L.TKA, 200_000_000), From: text(ALICE), Recipient: text(BOB) },
      labels: ["Amount", "From", "Recipient"],
    },
  },
  {
    id: "transfer-from-tkb-full",
    why: "6 decimals, subaccounts on both accounts, spender subaccount, memo.",
    pack: "icrc2", method: "icrc2_transfer_from", ledger: "TKB",
    args: transferFrom({ from: acct(ALICE, 4), to: acct(BOB, 7), amount: 3_141_592, spender: `opt ${subaccountText(5)}`, memo: `opt ${blobText("invoice 42")}` }),
    expect: {
      intent: /^Transfer using allowance: Move 3\.141592 TKB from \S+\.4 to \S+\.7 using an allowance \(spender subaccount #5\) with memo invoice 42$/,
      sentence: /^Move `3\.141592 TKB` from `\S+\.4` to `\S+\.7` using an allowance \(spender subaccount `#5`\) with memo `invoice 42`$/,
      rows: { Amount: tokenAmount(L.TKB, 3_141_592), "Spender subaccount": text("#5"), Memo: text("invoice 42") },
      labels: ["Amount", "From", "Recipient", "Spender subaccount", "Memo"],
    },
  },
  {
    id: "transfer-from-tkc-above-nat64",
    why: "18 decimals, 40 TKC: above nat64, Text.",
    pack: "icrc2", method: "icrc2_transfer_from", ledger: "TKC",
    args: transferFrom({ from: acct(ALICE), to: acct(BOB), amount: 40_000_000_000_000_000_000n }),
    expect: {
      intent: /^Transfer using allowance: Move 40 TKC from \S+ to \S+ using an allowance$/,
      sentence: /^Move `40 TKC` from `\S+` to `\S+` using an allowance$/,
      rows: { Amount: text("40 TKC") },
    },
  },
  {
    id: "transfer-from-tka-hostile-memo",
    why: "Hostile memo on a transfer-from.",
    pack: "icrc2", method: "icrc2_transfer_from", ledger: "TKA",
    args: transferFrom({ from: acct(ALICE), to: acct(BOB), amount: 100_000_000, memo: `opt ${blobText(HOSTILE_MEMO)}` }),
    expect: {
      intent: new RegExp(`using an allowance with memo ${escapeRe(HOSTILE_MEMO)}$`),
      sentence: new RegExp(`using an allowance with memo ${escapeRe(HOSTILE_SPAN)}$`),
      rows: { Memo: text(HOSTILE_MEMO) },
      memo: HOSTILE_MEMO,
    },
  },
];
