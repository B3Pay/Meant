// Backs docs/oisy-comparison.md. Two jobs:
//   1. the transcription of OISY's fallback (test/oisy-fallback.mjs) must reproduce the expectations in OISY's own
//      tests, otherwise the comparison compares against a strawman;
//   2. every claim the document makes about the two messages is asserted here, and every message in the document is
//      the one computed now.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ALICE, BOB, inspectMarkdown as inspect } from "./helpers.mjs";
import { formatAmount, decodeMemo, oisyIcrc1TransferMessage } from "./oisy-fallback.mjs";
import { SCENARIOS, compare } from "./oisy-scenarios.mjs";

const doc = readFileSync(new URL("../docs/oisy-comparison.md", import.meta.url), "utf8");
const byId = Object.fromEntries(SCENARIOS.map((s) => [s.id, compare(s)]));
const visible = (s) => s.replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" ? "\n" : `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}>`));

test("transcription: formatAmount gives the values in OISY's own src/utils/format.utils.spec.ts", () => {
  const theirs = [
    [123456n, 2, "1,234.56"], [1000000n, 6, "1.0"], [123456n, 1, "12,345.6"], [123456n, 0, "123,456"], [0n, 2, "0.0"], [0n, 6, "0.0"],
    [123456789012345n, 8, "1,234,567.89012345"], [1n, 8, "0.00000001"], [10n, 8, "0.0000001"], [100n, 8, "0.000001"], [100_000_000n, 8, "1.0"],
    [1_000_000_000n, 8, "10.0"], [1_010_000_000n, 8, "10.1"], [1_012_300_000n, 8, "10.123"], [20_000_000_000n, 8, "200.0"],
    [20_000_000_001n, 8, "200.00000001"], [200_000_000_000n, 8, "2,000.0"], [200_000_000_000_000n, 8, "2,000,000.0"],
  ];
  for (const [amount, decimals, shown] of theirs) assert.equal(formatAmount({ amount, decimals }), shown, `${amount} / 10^${decimals}`);
});

test("transcription: decodeMemo as in OISY's builders.utils.spec.ts, and its hex branch is unreachable", () => {
  assert.equal(decodeMemo(new TextEncoder().encode("PUPT")), "PUPT");
  assert.equal(decodeMemo(Uint8Array.from([0xff, 0xfe])), "��", "TextDecoder without `fatal` replaces bad bytes; it never throws");
  assert.throws(() => new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from([0xff])), "only a fatal decoder would reach the catch");
});

test("transcription: the message has the layout of OISY's src/builders/signer.builders.spec.ts expectations", () => {
  const args = { amount: "320000000001", from_subaccount: null, to: { owner: BOB, subaccount: null }, fee: "100330", memo: new TextEncoder().encode("PUPT") };
  const message = oisyIcrc1TransferMessage({ args, owner: ALICE, token: { symbol: "TKN", decimals: 8, fee: 10_000n } });
  assert.equal(message, `# Approve the transfer of funds\n\n**Amount:**\n3,200.00000001 TKN\n\n**From:**\n${ALICE}\n\n**To:**\n${BOB}\n\n**Fee:**\n0.0010033 TKN\n\n**Memo:**\nPUPT`);
  const noFee = oisyIcrc1TransferMessage({ args: { ...args, fee: null, memo: null }, owner: ALICE, token: { symbol: "TKN", decimals: 8, fee: 10_000n } });
  assert.equal(noFee, `# Approve the transfer of funds\n\n**Amount:**\n3,200.00000001 TKN\n\n**From:**\n${ALICE}\n\n**To:**\n${BOB}\n\n**Fee:**\n0.0001 TKN`, "no fee argument: the token's current default fee is shown");
});

test("claims: OISY rounds through a double above 2^53 and with 18 decimals; the profile message is exact", () => {
  assert.match(byId["above-2-53"].oisy, /\*\*Amount:\*\*\n90,071,992\.54740992 TKA\n/);
  assert.match(byId["above-2-53"].generic, /`90071992\.54740993 TKA`/);
  assert.match(byId["eighteen-decimals"].oisy, /\*\*Amount:\*\*\n0\.12345678901234568 TKC\n/);
  assert.match(byId["eighteen-decimals"].generic, /`0\.123456789012345678 TKC`/);
  assert.equal(9007199254740993n.toString(), "9007199254740993");
  assert.equal(Number(9007199254740993n), 9007199254740992, "the double that OISY divides is already off by one base unit");
});

test("claims: OISY adds trailing .0 and thousands separators; the profile message keeps the format of section 5.3", () => {
  assert.match(byId.plain.oisy, /\*\*Amount:\*\*\n0\.29 TKA/);
  assert.match(byId["memo-structure"].oisy, /\*\*Amount:\*\*\n100\.0 TKA/);
  assert.match(byId["memo-structure"].generic, /Send `100 TKA`/);
});

test("claims: OISY shows the ledger's current default fee when the call names none; the profile message says nothing about it", () => {
  assert.match(byId.plain.oisy, /\*\*Fee:\*\*\n0\.0001 TKA/);
  assert.doesNotMatch(byId.plain.generic, /fee/i);
  assert.match(byId.everything.generic, /paying fee `0\.0001 TKA`/, "an explicit fee in the call is shown");
});

test("claims: OISY shows the caller as From; the profile message cannot, because the call does not carry it", () => {
  assert.match(byId.plain.oisy, new RegExp(`\\*\\*From:\\*\\*\\n${ALICE}`));
  assert.doesNotMatch(byId.plain.generic, new RegExp(ALICE));
});

test("claims: a memo can forge a section in OISY's message; in the profile message it stays inside one code span", () => {
  const oisy = inspect(byId["memo-structure"].oisy);
  const strongAmount = byId["memo-structure"].oisy.match(/\*\*Amount:\*\*/g);
  assert.equal(strongAmount.length, 2, "two Amount sections, the second one written by the memo");
  assert.ok(oisy.types.has("strong"));
  const mine = inspect(byId["memo-structure"].generic);
  assert.deepEqual([...mine.types].sort(), ["code", "document", "heading", "item", "list", "paragraph", "strong", "text"]);
  assert.equal(byId["memo-structure"].generic.match(/\*\*Amount:\*\*/g).length, 1, "the only Amount label is the profile's own");
  assert.match(byId["memo-structure"].generic, /memo `0x72656e74/, "a memo with line breaks is shown as hex");
});

test("claims: a memo link is a link in OISY's message and plain code in the profile message", () => {
  assert.ok(inspect(byId["memo-link"].oisy).types.has("link"));
  const mine = inspect(byId["memo-link"].generic);
  assert.ok(!mine.types.has("link") && !mine.types.has("emph"));
  assert.ok(mine.codes.includes("[Claim your refund](https://evil.example/refund) **now**"));
});

test("claims: a memo that is not UTF-8 reaches OISY's message as replacement and control characters; the profile shows hex", () => {
  assert.match(byId["memo-binary"].oisy, /\*\*Memo:\*\*\n��\u0000\u0001$/);
  assert.match(byId["memo-binary"].generic, /`0xfffe0001`/);
});

test("claims: the ledger's own template for the memo is closed early by a backtick (string built from the template read in responses.rs)", () => {
  const ledgerMemoSection = (memo) => `\n\n**Memo:**\n\`${memo}\``; // add_memo, GenericDisplayMessage
  const message = `**Amount:** \`1 TKA\`${ledgerMemoSection("a` [x](https://evil.example) `b")}`;
  assert.ok(inspect(message).types.has("link"), "the memo became a link");
  assert.ok(!inspect(`**Amount:** \`1 TKA\`${ledgerMemoSection("plain")}`).types.has("link"));
});

test("document: every message in docs/oisy-comparison.md is the one computed now", () => {
  for (const s of SCENARIOS) {
    const r = byId[s.id];
    assert.ok(doc.includes(`~~~markdown\n${visible(r.oisy)}\n~~~`), `${s.id}: OISY block`);
    assert.ok(doc.includes(`~~~markdown\n${r.generic}\n~~~`), `${s.id}: generic block`);
  }
  assert.ok(doc.includes(`intent: ${byId.plain.fields.intent}`), "plain: fields intent");
  assert.ok(doc.includes("c4eb38920a1c110bb6c908a18d7336d4d306638c") && doc.includes("89c42a33189c2be04bdd004441f36fb36ded95c7"), "both commits are recorded");
});
