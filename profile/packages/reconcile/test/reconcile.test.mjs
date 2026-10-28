// The reconciler on ICRC-3 blocks in the shapes W2 recorded from the pinned DFINITY ledger wasm on PocketIC
// (eval/harness/test/icrc3-blocks.integration.test.mjs, docs/status/W2.md 2026-10-09): legacy `tx.op` form, no
// `btype`; block keys ts, tx, phash, fee (fee only when the call named none); tx keys op, amt, from, to, spender,
// memo, ts, expires_at, expected_allowance, each absent when the call set none; accounts `[owner]` or
// `[owner, subaccount]`. The blocks here are built in those shapes (not byte recordings); mint is as recorded, burn
// and a spender's own transfer_from were not observed there and follow ICRC-1/2/3.
import { test } from "node:test";
import assert from "node:assert/strict";
import { principalFromText } from "@meantjs/format";
import { DEDUP_WINDOW_NS, U64_MAX, blockMatches, expectedTransaction, matchBlocks } from "../src/index.mjs";

const ME = "ryjl3-tyaaa-aaaaa-aaaba-cai";
const ALICE = "r7inp-6aaaa-aaaaa-aaabq-cai";
const SHOP = "rrkah-fqaaa-aaaaa-aaaaq-cai";
const MINTER = "renrk-eyaaa-aaaaa-aaada-cai";
const sub = (n) => Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? n : 0));
const STAMP = 1_760_000_000_000_000_000n;
const utf8 = (s) => new TextEncoder().encode(s);

// ---- ICRC-3 value builders, in the recorded shapes ----
const Nat = (value) => ({ tag: "Nat", value });
const Text = (value) => ({ tag: "Text", value });
const Blob = (value) => ({ tag: "Blob", value });
const Map_ = (entries) => ({ tag: "Map", value: entries.filter(([, v]) => v !== undefined) });
const acct = (owner, subaccount) => ({ tag: "Array", value: [Blob(principalFromText(owner)), ...(subaccount ? [Blob(subaccount)] : [])] });
function block({ ts = STAMP + 1_000n, fee, ...tx }) {
  const t = Map_([
    ["op", Text(tx.op)],
    ["amt", Nat(tx.amt)],
    ["from", tx.from],
    ["to", tx.to],
    ["spender", tx.spender],
    ["memo", tx.memo === undefined ? undefined : Blob(tx.memo)],
    ["ts", tx.created === undefined ? undefined : Nat(tx.created)],
    ["fee", tx.txFee === undefined ? undefined : Nat(tx.txFee)],
    ["expires_at", tx.expires_at === undefined ? undefined : Nat(tx.expires_at)],
    ["expected_allowance", tx.expected_allowance === undefined ? undefined : Nat(tx.expected_allowance)],
  ]);
  return Map_([["ts", Nat(ts)], ["tx", t], ["phash", Blob(new Uint8Array(32))], ["fee", fee === undefined ? undefined : Nat(fee)]]);
}
const log = (...bs) => bs.map((b, i) => ({ id: BigInt(i), block: b }));
const settled = { inFlight: false };

const transfer = (over = {}) => ({ to: { owner: ALICE, subaccount: sub(7) }, amount: 1234n, memo: utf8("m1"), from_subaccount: sub(1), fee: null, created_at_time: STAMP, ...over });
const transferBlock = (over = {}) => ({ op: "xfer", amt: 1234n, from: acct(ME, sub(1)), to: acct(ALICE, sub(7)), memo: utf8("m1"), created: STAMP, fee: 10_000n, ...over });

test("a transfer is found in its block (recorded shape: from and to with subaccounts, memo, ts)", () => {
  const exp = expectedTransaction("icrc1_transfer", transfer(), ME);
  const blocks = log(block({ op: "mint", amt: 10n ** 12n, to: acct(ME, sub(1)) }), block(transferBlock()));
  assert.deepEqual(matchBlocks(blocks, exp, { logLength: 2n, ...settled }), { status: "found", block: 1n });
});

test("an approve is found (recorded shape: expires_at, expected_allowance, spender, no subaccount on from)", () => {
  const arg = { spender: { owner: SHOP, subaccount: null }, amount: 50_000n, memo: utf8("ap"), from_subaccount: null, fee: null, expires_at: STAMP + 99n, expected_allowance: 0n, created_at_time: STAMP };
  const exp = expectedTransaction("icrc2_approve", arg, ME);
  const b = block({ op: "approve", amt: 50_000n, from: acct(ME), spender: acct(SHOP), memo: utf8("ap"), created: STAMP, expires_at: STAMP + 99n, expected_allowance: 0n });
  assert.deepEqual(matchBlocks(log(b), exp, { logLength: 1n, ...settled }), { status: "found", block: 0n });
  // a block without expected_allowance is another call
  const other = block({ op: "approve", amt: 50_000n, from: acct(ME), spender: acct(SHOP), memo: utf8("ap"), created: STAMP, expires_at: STAMP + 99n });
  assert.equal(blockMatches(other, exp), false);
});

test("a spender's transfer_from is found: the caller is the spender (recorded shape)", () => {
  const arg = { from: { owner: ME, subaccount: null }, to: { owner: ALICE, subaccount: null }, amount: 100n, memo: utf8("tf"), spender_subaccount: null, fee: null, created_at_time: STAMP };
  const exp = expectedTransaction("icrc2_transfer_from", arg, SHOP);
  const b = block({ op: "xfer", amt: 100n, from: acct(ME), to: acct(ALICE), spender: acct(SHOP), memo: utf8("tf"), created: STAMP });
  assert.deepEqual(matchBlocks(log(b), exp, { logLength: 1n, ...settled }), { status: "found", block: 0n });
});

test("a transfer from the minting account is a mint: found, where an xfer mapping would say absent", () => {
  const exp = expectedTransaction("icrc1_transfer", transfer({ from_subaccount: null }), MINTER, { minting: { owner: MINTER, subaccount: null } });
  assert.equal(exp.op, "mint");
  const b = block({ op: "mint", amt: 1234n, to: acct(ALICE, sub(7)), memo: utf8("m1"), created: STAMP });
  assert.deepEqual(matchBlocks(log(b), exp, { logLength: 1n, ...settled }), { status: "found", block: 0n });
  const asXfer = expectedTransaction("icrc1_transfer", transfer({ from_subaccount: null }), MINTER);
  assert.notEqual(matchBlocks(log(b), asXfer, { logLength: 1n, ...settled }).status, "absent", "an unmapped mint is at worst a lookalike");
});

test("a transfer to the minting account is a burn (no `to`); so is a transfer_from to it", () => {
  const minting = { minting: { owner: MINTER, subaccount: null } };
  const exp = expectedTransaction("icrc1_transfer", transfer({ to: { owner: MINTER, subaccount: null } }), ME, minting);
  assert.equal(exp.op, "burn");
  const b = block({ op: "burn", amt: 1234n, from: acct(ME, sub(1)), memo: utf8("m1"), created: STAMP });
  assert.deepEqual(matchBlocks(log(b), exp, { logLength: 1n, ...settled }), { status: "found", block: 0n });
  const tf = expectedTransaction("icrc2_transfer_from", { from: { owner: ALICE, subaccount: null }, to: { owner: MINTER, subaccount: null }, amount: 5n, memo: null, spender_subaccount: null, created_at_time: STAMP }, ME, minting);
  const tb = block({ op: "burn", amt: 5n, from: acct(ALICE), spender: acct(ME), created: STAMP });
  assert.equal(blockMatches(tb, tf), true);
});

test("a spender's own transfer_from matches only under a 2xfer btype, with or without `spender` in the block", () => {
  const arg = { from: { owner: ME, subaccount: null }, to: { owner: ALICE, subaccount: null }, amount: 7n, memo: null, spender_subaccount: null, created_at_time: STAMP };
  const exp = expectedTransaction("icrc2_transfer_from", arg, ME);
  assert.equal(exp.spenderOptional, true);
  const bare = block({ op: "xfer", amt: 7n, from: acct(ME), to: acct(ALICE), created: STAMP });
  assert.equal(blockMatches({ tag: "Map", value: [["btype", Text("2xfer")], ...bare.value] }, exp), true);
  assert.equal(blockMatches(bare, exp), false, "without a btype it reads like an icrc1_transfer");
  const withSpender = block({ op: "xfer", amt: 7n, from: acct(ME), to: acct(ALICE), spender: acct(ME), created: STAMP });
  assert.equal(blockMatches({ tag: "Map", value: [["btype", Text("2xfer")], ...withSpender.value] }, exp), true);
  // ICRC-3 lets an icrc1_transfer block carry `tx.spender` too, so a legacy block with it is a lookalike, never found
  assert.equal(blockMatches(withSpender, exp), false, "a present spender does not tell a legacy block apart");
  const r = matchBlocks(log(withSpender), exp, { logLength: 1n, ...settled });
  assert.equal(r.status, "unreadable");
  assert.equal(r.lookalike.block, 0n);
});

test("an empty memo is not no memo, in both directions", () => {
  const none = expectedTransaction("icrc1_transfer", transfer({ memo: null }), ME);
  const empty = expectedTransaction("icrc1_transfer", transfer({ memo: new Uint8Array(0) }), ME);
  const emptyBlock = block(transferBlock({ memo: new Uint8Array(0) }));
  const noneBlock = block(transferBlock({ memo: undefined }));
  assert.equal(blockMatches(emptyBlock, none), false);
  assert.equal(blockMatches(noneBlock, empty), false);
  assert.equal(blockMatches(emptyBlock, empty), true);
  assert.equal(blockMatches(noneBlock, none), true);
  // The twin's block is a lookalike for the no-memo call, never found and never absent.
  const r = matchBlocks(log(emptyBlock), none, { logLength: 1n, inFlight: true, ledgerTime: STAMP });
  assert.equal(r.status, "unreadable");
  assert.equal(r.lookalike.block, 0n);
});

test("an approval capped at u64::MAX is a lookalike, never absent", () => {
  const amount = 19n * 10n ** 18n;
  assert.ok(amount > U64_MAX);
  const exp = expectedTransaction("icrc2_approve", { spender: { owner: SHOP, subaccount: null }, amount, memo: null, from_subaccount: null, expires_at: null, expected_allowance: null, created_at_time: STAMP }, ME);
  const b = block({ op: "approve", amt: U64_MAX, from: acct(ME), spender: acct(SHOP), created: STAMP });
  const r = matchBlocks(log(b), exp, { logLength: 1n, ...settled });
  assert.equal(r.status, "unreadable");
  assert.deepEqual(r.lookalike, { block: 0n, op: "approve", capped: true });
});

test("a block of the same operation to another recipient is another call, not a lookalike", () => {
  const exp = expectedTransaction("icrc1_transfer", transfer(), ME);
  const b = block(transferBlock({ to: acct(SHOP) }));
  assert.deepEqual(matchBlocks(log(b), exp, { logLength: 1n, ...settled }), { status: "absent", closedBy: "answered" });
});

test("a person's 'not the original' takes a lookalike out of the next read", () => {
  const exp = expectedTransaction("icrc1_transfer", transfer({ memo: null }), ME);
  const b = block(transferBlock({ memo: new Uint8Array(0) }));
  assert.equal(matchBlocks(log(b), exp, { logLength: 1n, ...settled, notOriginal: [0n] }).status, "absent");
});

test("not_yet while a send may still land; absent once it cannot (#9)", () => {
  const exp = expectedTransaction("icrc1_transfer", transfer(), ME);
  const other = log(block(transferBlock({ amt: 1n, created: STAMP + 5n, ts: STAMP + 10n })));
  const o = { logLength: 1n, inFlight: true, windowNs: DEDUP_WINDOW_NS };
  assert.deepEqual(matchBlocks(other, exp, o), { status: "not_yet", openUntil: STAMP + DEDUP_WINDOW_NS, clock: { at: STAMP + 10n, by: "block" } });
  assert.deepEqual(matchBlocks(other, exp, { ...o, stampExpired: true }), { status: "absent", closedBy: "too_old" });
  assert.deepEqual(matchBlocks(other, exp, { ...o, ledgerTime: STAMP + DEDUP_WINDOW_NS + 1n }), { status: "absent", closedBy: "window_passed", clock: { at: STAMP + DEDUP_WINDOW_NS + 1n, by: "ledger" } });
  assert.equal(matchBlocks(other, exp, { ...o, ledgerTime: STAMP + DEDUP_WINDOW_NS }).status, "not_yet", "the window's last instant is still open");
  assert.deepEqual(matchBlocks(other, exp, { ...o, ledgerTimeAtLeast: STAMP + DEDUP_WINDOW_NS + 1n }).clock, { at: STAMP + DEDUP_WINDOW_NS + 1n, by: "host" });
  assert.deepEqual(matchBlocks([], exp, { logLength: 0n, inFlight: true, windowNs: DEDUP_WINDOW_NS }), { status: "not_yet", openUntil: STAMP + DEDUP_WINDOW_NS });
});

test("without the ledger's window nothing closes by the clock (#13 review)", () => {
  const exp = expectedTransaction("icrc1_transfer", transfer(), ME);
  const other = log(block(transferBlock({ amt: 1n, created: STAMP + 5n, ts: STAMP + 10n })));
  const far = STAMP + 1000n * DEDUP_WINDOW_NS;
  const r = matchBlocks(other, exp, { logLength: 1n, inFlight: true, ledgerTime: far });
  assert.equal(r.status, "not_yet");
  assert.match(r.reason, /windowNs/);
  assert.equal(r.openUntil, undefined);
  // the other ways to close still close
  assert.deepEqual(matchBlocks(other, exp, { logLength: 1n, inFlight: true, stampExpired: true }), { status: "absent", closedBy: "too_old" });
  assert.equal(matchBlocks(other, exp, { logLength: 1n, ...settled }).status, "absent");
});

test("a malformed optional Nat in a block matches nothing, not even an absent field (#13 review)", () => {
  const setTx = (b, key, value) => ({ tag: "Map", value: b.value.map(([k, v]) => (k === "tx" ? [k, { tag: "Map", value: [...v.value.filter(([kk]) => kk !== key), [key, value]] }] : [k, v])) });
  const exp = expectedTransaction("icrc1_transfer", transfer(), ME);
  assert.equal(blockMatches(block(transferBlock()), exp), true);
  const badFee = setTx(block(transferBlock()), "fee", Text("10000"));
  assert.equal(blockMatches(badFee, exp), false);
  assert.notEqual(matchBlocks(log(badFee), exp, { logLength: 1n, ...settled }).status, "found");
  const arg = { spender: { owner: SHOP, subaccount: null }, amount: 50_000n, memo: null, from_subaccount: null, fee: null, expires_at: null, expected_allowance: null, created_at_time: STAMP };
  const ap = expectedTransaction("icrc2_approve", arg, ME);
  const b = block({ op: "approve", amt: 50_000n, from: acct(ME), spender: acct(SHOP), created: STAMP });
  assert.equal(blockMatches(b, ap), true);
  for (const key of ["expires_at", "expected_allowance"]) {
    const bad = setTx(b, key, Text("0"));
    assert.equal(blockMatches(bad, ap), false, key);
    assert.notEqual(matchBlocks(log(bad), ap, { logLength: 1n, ...settled }).status, "found", key);
  }
});

test("blocks that do not cover the range since the first send are unreadable, never absent", () => {
  const exp = expectedTransaction("icrc1_transfer", transfer(), ME);
  const blocks = [{ id: 5n, block: block(transferBlock({ amt: 1n })) }, { id: 7n, block: block(transferBlock({ amt: 2n })) }];
  const r = matchBlocks(blocks, exp, { logLength: 8n, floor: 5n, ...settled });
  assert.equal(r.status, "unreadable");
  assert.match(r.reason, /block 6/);
  assert.equal(matchBlocks([], exp, { logLength: 1n, floor: 2n, ...settled }).status, "unreadable");
  // blocks before the floor are not searched
  assert.deepEqual(matchBlocks(log(block(transferBlock())), exp, { logLength: 1n, floor: 1n, ...settled }), { status: "absent", closedBy: "answered" });
});

test("a fee the call named is part of the match", () => {
  const exp = expectedTransaction("icrc1_transfer", transfer({ fee: 10_000n }), ME);
  assert.equal(blockMatches(block(transferBlock({ txFee: 10_000n, fee: undefined })), exp), true);
  assert.equal(blockMatches(block(transferBlock()), exp), false, "no tx.fee: the call named none");
});

test("calls it cannot map are unreadable, and bad input never throws from the matcher", () => {
  assert.equal(expectedTransaction("icrc1_transfer", transfer({ created_at_time: null }), ME), undefined);
  assert.equal(expectedTransaction("icrc7_transfer", transfer(), ME), undefined);
  assert.equal(expectedTransaction("icrc1_transfer", transfer(), "not a principal"), undefined);
  assert.equal(matchBlocks([], undefined, { logLength: 0n, inFlight: true }).status, "unreadable");
  const exp = expectedTransaction("icrc1_transfer", transfer(), ME);
  const junk = [{ id: 0n, block: null }, { id: 1n, block: { tag: "Map", value: [["tx", { tag: "Text", value: "x" }]] } }, { id: 2n, block: Map_([["tx", Map_([["memo", Text("m1")]])]]) }];
  // blocks it cannot read are not "no match": the answer is unreadable, never absent
  assert.equal(matchBlocks(junk, exp, { logLength: 3n, ...settled }).status, "unreadable");
  for (const j of junk) assert.equal(matchBlocks([{ id: 0n, block: j.block }], exp, { logLength: 1n, ...settled }).status, "unreadable");
  assert.throws(() => matchBlocks([], exp, { inFlight: true }), TypeError);
});

test("a block whose Nat values are not bigints is unreadable, never absent", () => {
  const exp = expectedTransaction("icrc1_transfer", transfer(), ME);
  const numbers = Map_([["ts", { tag: "Nat", value: 1 }], ["tx", Map_([["op", Text("xfer")], ["amt", { tag: "Nat", value: 1234 }]])]]);
  assert.equal(matchBlocks(log(numbers), exp, { logLength: 1n, ...settled }).status, "unreadable");
  const badStamp = Map_([["ts", Nat(1n)], ["tx", Map_([["op", Text("xfer")], ["amt", Nat(1n)], ["ts", { tag: "Nat", value: 5 }]])]]);
  assert.equal(matchBlocks(log(badStamp), exp, { logLength: 1n, ...settled }).status, "unreadable");
});

test("1xfer and 2xfer tell a transfer from a spender's own transfer_from with the same fields", () => {
  const withBtype = (btype, b) => ({ tag: "Map", value: [["btype", Text(btype)], ...b.value] });
  const tfArg = { from: { owner: ME, subaccount: null }, to: { owner: ALICE, subaccount: null }, amount: 7n, memo: null, spender_subaccount: null, created_at_time: STAMP };
  const tArg = { from_subaccount: null, to: { owner: ALICE, subaccount: null }, amount: 7n, fee: null, memo: null, created_at_time: STAMP };
  const tf = expectedTransaction("icrc2_transfer_from", tfArg, ME);
  const t = expectedTransaction("icrc1_transfer", tArg, ME);
  assert.equal(t.btype, "1xfer");
  assert.equal(tf.btype, "2xfer");
  // the self-spent transfer_from left out `spender`, so only the btype differs
  const b = block({ op: "xfer", amt: 7n, from: acct(ME), to: acct(ALICE), created: STAMP });
  assert.equal(blockMatches(withBtype("2xfer", b), tf), true);
  assert.equal(blockMatches(withBtype("2xfer", b), t), false);
  assert.equal(blockMatches(withBtype("1xfer", b), t), true);
  assert.equal(blockMatches(withBtype("1xfer", b), tf), false);
  // a legacy block without a btype cannot tell them apart: it is the transfer's, and only a lookalike of the transfer_from
  assert.equal(blockMatches(b, t), true);
  assert.equal(blockMatches(b, tf), false);
  const r = matchBlocks(log(b), tf, { logLength: 1n, ...settled });
  assert.notEqual(r.status, "found");
  assert.notEqual(r.status, "absent");
});

test("a bare legacy xfer settles the icrc1_transfer (owner's decision, #29 review)", () => {
  // Another spender's identical transfer_from could leave this block too; the README says why it still counts.
  const exp = expectedTransaction("icrc1_transfer", transfer(), ME);
  const bare = block(transferBlock());
  assert.deepEqual(matchBlocks(log(bare), exp, { logLength: 1n, ...settled }), { status: "found", block: 0n });
});

test("btype is the operation when a block has it (ICRC-3), over a legacy tx.op", () => {
  const exp = expectedTransaction("icrc1_transfer", transfer(), ME);
  const withBtype = (btype, b) => ({ tag: "Map", value: [["btype", Text(btype)], ...b.value] });
  const noOp = (b) => ({ tag: "Map", value: b.value.map(([k, v]) => (k === "tx" ? [k, { tag: "Map", value: v.value.filter(([kk]) => kk !== "op") }] : [k, v])) });
  assert.deepEqual(matchBlocks(log(withBtype("1xfer", noOp(block(transferBlock())))), exp, { logLength: 1n, ...settled }), { status: "found", block: 0n });
  // btype wins over a contradicting op
  assert.notEqual(matchBlocks(log(withBtype("2approve", block(transferBlock()))), exp, { logLength: 1n, ...settled }).status, "found");
  // an unknown btype matches nothing, and is at worst a lookalike
  const r = matchBlocks(log(withBtype("9future", noOp(block(transferBlock())))), exp, { logLength: 1n, ...settled });
  assert.equal(r.status, "unreadable");
  assert.equal(r.lookalike.op, "btype:9future");
});

test("a transfer_from out of the minting account is a mint (no `from`)", () => {
  const minting = { minting: { owner: MINTER, subaccount: null } };
  const arg = { from: { owner: MINTER, subaccount: null }, to: { owner: ALICE, subaccount: null }, amount: 9n, memo: null, spender_subaccount: null, created_at_time: STAMP };
  const exp = expectedTransaction("icrc2_transfer_from", arg, SHOP, minting);
  assert.equal(exp.op, "mint");
  assert.deepEqual(matchBlocks(log(block({ op: "mint", amt: 9n, to: acct(ALICE), spender: acct(SHOP), created: STAMP })), exp, { logLength: 1n, ...settled }), { status: "found", block: 0n });
  assert.equal(blockMatches(block({ op: "mint", amt: 9n, to: acct(ALICE), spender: acct(ALICE), created: STAMP }), exp), false);
  // without `spender`, another spender's identical call reads the same: not found, only a lookalike
  const bare = matchBlocks(log(block({ op: "mint", amt: 9n, to: acct(ALICE), created: STAMP })), exp, { logLength: 1n, ...settled });
  assert.notEqual(bare.status, "found");
  assert.notEqual(bare.status, "absent");
  // the minting account spending as itself: a mint without `spender` still reads like an icrc1_transfer from it
  const self = expectedTransaction("icrc2_transfer_from", arg, MINTER, minting);
  assert.equal(matchBlocks(log(block({ op: "mint", amt: 9n, to: acct(ALICE), spender: acct(MINTER), created: STAMP })), self, { logLength: 1n, ...settled }).status, "found");
  assert.notEqual(matchBlocks(log(block({ op: "mint", amt: 9n, to: acct(ALICE), created: STAMP })), self, { logLength: 1n, ...settled }).status, "found");
});

test("a block with a spender the call does not have is another call", () => {
  const exp = expectedTransaction("icrc1_transfer", transfer(), ME);
  assert.equal(blockMatches(block(transferBlock({ spender: acct(SHOP) })), exp), false);
  assert.equal(blockMatches(block(transferBlock()), exp), true);
});

test("a subaccount that is not bytes maps to no block, so no side is left out of the match", () => {
  assert.equal(expectedTransaction("icrc1_transfer", transfer({ from_subaccount: "x" }), ME), undefined);
  assert.equal(expectedTransaction("icrc2_approve", { spender: { owner: SHOP, subaccount: null }, amount: 1n, from_subaccount: [1], created_at_time: STAMP }, ME), undefined);
  const tf = { from: { owner: ME, subaccount: null }, to: { owner: ALICE, subaccount: null }, amount: 1n, memo: null, spender_subaccount: "x", created_at_time: STAMP };
  assert.equal(expectedTransaction("icrc2_transfer_from", tf, SHOP), undefined);
});

test("a Uint8Array from another realm is bytes too", async () => {
  const vm = await import("node:vm");
  const foreign = vm.runInContext("new Uint8Array([109, 49])", vm.createContext({}));
  const exp = expectedTransaction("icrc1_transfer", transfer({ memo: foreign }), ME);
  assert.equal(exp.memo, "6d31");
});

test("an exact original is found beside a block of another standard this module cannot read", () => {
  const exp = expectedTransaction("icrc1_transfer", transfer(), ME);
  const other = Map_([["btype", Text("7mint")], ["ts", Nat(1n)], ["tx", Map_([["tid", Nat(5n)]])]]);
  const blocks = [{ id: 0n, block: other }, { id: 1n, block: block(transferBlock()) }];
  assert.deepEqual(matchBlocks(blocks, exp, { logLength: 2n, ...settled }), { status: "found", block: 1n });
  // without the original, that block still makes the answer unreadable, never absent
  assert.equal(matchBlocks([{ id: 0n, block: other }], exp, { logLength: 1n, ...settled }).status, "unreadable");
});

test("a detached byte view is not bytes: no throw, no match", () => {
  const detach = (u8) => (structuredClone(u8.buffer, { transfer: [u8.buffer] }), u8);
  assert.equal(expectedTransaction("icrc1_transfer", transfer({ memo: detach(utf8("m1")) }), ME), undefined);
  assert.equal(expectedTransaction("icrc1_transfer", transfer({ from_subaccount: detach(sub(1)) }), ME), undefined);
  const exp = expectedTransaction("icrc1_transfer", transfer(), ME);
  const b = block(transferBlock());
  const tx = b.value.find(([k]) => k === "tx")[1];
  const memo = tx.value.find(([k]) => k === "memo");
  memo[1] = { tag: "Blob", value: detach(new Uint8Array(memo[1].value)) };
  assert.doesNotThrow(() => matchBlocks(log(b), exp, { logLength: 1n, ...settled }));
  assert.notEqual(matchBlocks(log(b), exp, { logLength: 1n, ...settled }).status, "found");
});

test("a byte view out of bounds of its shrunk resizable buffer is not bytes: no throw, no match", () => {
  const shrunk = (u8) => {
    const buffer = new ArrayBuffer(u8.length, { maxByteLength: 64 });
    const view = new Uint8Array(buffer, 0, u8.length);
    view.set(u8);
    buffer.resize(0);
    return view;
  };
  assert.throws(() => Array.from(shrunk(utf8("m1"))), TypeError, "reading it throws");
  assert.equal(expectedTransaction("icrc1_transfer", transfer({ memo: shrunk(utf8("m1")) }), ME), undefined);
  assert.equal(expectedTransaction("icrc1_transfer", transfer({ from_subaccount: shrunk(sub(1)) }), ME), undefined);
  const exp = expectedTransaction("icrc1_transfer", transfer(), ME);
  const b = block(transferBlock());
  const tx = b.value.find(([k]) => k === "tx")[1];
  const memo = tx.value.find(([k]) => k === "memo");
  memo[1] = { tag: "Blob", value: shrunk(new Uint8Array(memo[1].value)) };
  assert.doesNotThrow(() => matchBlocks(log(b), exp, { logLength: 1n, ...settled }));
  assert.notEqual(matchBlocks(log(b), exp, { logLength: 1n, ...settled }).status, "found");
});

test("a btype that is present but not Text is unreadable, never a fallback to tx.op (#13 review)", () => {
  const exp = expectedTransaction("icrc1_transfer", transfer(), ME);
  const b = block(transferBlock());
  for (const bad of [Nat(1n), Blob(utf8("1xfer")), { tag: "Text", value: 7 }]) {
    const odd = { tag: "Map", value: [["btype", bad], ...b.value] };
    assert.equal(blockMatches(odd, exp), false);
    assert.equal(matchBlocks(log(odd), exp, { logLength: 1n, ...settled }).status, "unreadable");
  }
});

test("a lookalike whose source account cannot be read stays a lookalike, never another sender (#13 review)", () => {
  const exp = expectedTransaction("icrc1_transfer", transfer(), ME);
  for (const from of [{ tag: "Array", value: [Text(ME)] }, Text(ME), { tag: "Array", value: [] }]) {
    const odd = block(transferBlock({ from }));
    const r = matchBlocks(log(odd), exp, { logLength: 1n, ...settled });
    assert.equal(r.status, "unreadable", JSON.stringify(from));
    assert.equal(r.lookalike?.block, 0n);
  }
  // a source that reads as another account is another sender
  assert.equal(matchBlocks(log(block(transferBlock({ from: acct(ALICE) }))), exp, { logLength: 1n, ...settled }).status, "absent");
});
