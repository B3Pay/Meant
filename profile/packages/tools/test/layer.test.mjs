import { test } from "node:test";
import assert from "node:assert/strict";
import { createToolLayer } from "../src/index.mjs";
import { ICRC1, ICRC2, LEDGERS, PACKS, encodeArgsFor } from "./helpers.mjs";

const TKA = LEDGERS[0].id;
const BOB = "mxzaz-hqaaa-aaaar-qaada-cai";
const NOW = 1791547200123456789n;
const transfer = { canister_id: TKA, to: BOB, amount: "1.5 TKA" };

/**
 * A layer over a scripted ledger. `answers` are what successive update calls get; queries answer `query`.
 * Every send is recorded with its bytes, which must be candid-core's encoding of the value it carries.
 */
function setup({ resolved = PACKS, answers = [], confirm = async () => true, reconcile, query = () => ({ status: "replied", reply: 150000000n }), clock, asyncEncode = false } = {}) {
  const sent = [];
  const asked = [];
  const clocks = [];
  let t = NOW;
  const layer = createToolLayer({
    resolved,
    canisters: LEDGERS,
    encode: asyncEncode ? async (method, value) => (await new Promise((r) => setTimeout(r, 5)), encodeArgsFor(method, value)) : (method, value) => encodeArgsFor(method, value),
    now: async (o) => (clocks.push(o), clock ? clock() : (t += 1_000_000_000n)),
    confirm: async (preview) => {
      asked.push(preview);
      return confirm(preview);
    },
    call: async (req) => {
      assert.deepEqual(req.arg, encodeArgsFor(req.method, req.value), "the bytes sent are candid-core's encodeArgs of the value");
      sent.push(req);
      if (req.mode === "query") return query(req);
      const a = answers.shift();
      assert.ok(a, `no scripted answer for send ${sent.length}`);
      if (a instanceof Error) throw a;
      return a;
    },
    ...(reconcile ? { reconcile } : {}),
  });
  return { layer, sent, asked, clocks, updates: () => sent.filter((r) => r.mode === "update") };
}

const ok = (n) => ({ status: "replied", reply: { tag: "Ok", value: BigInt(n) } });
const err = (tag, value = null) => ({ status: "replied", reply: { tag: "Err", value: { tag, value } } });
const prepare = async (layer, input = transfer, tool = "prepare_icrc1_transfer") => (await layer.callTool(tool, input)).structuredContent;
const commit = async (layer, preview_id) => (await layer.callTool("commit", { preview_id })).structuredContent;

test("a declining confirm sends nothing and answers declined", async () => {
  const { layer, sent, asked } = setup({ confirm: async () => false });
  const p = await prepare(layer);
  assert.equal(p.status, "prepared");
  const r = await layer.callTool("commit", { preview_id: p.preview.preview_id });
  assert.equal(r.structuredContent.outcome, "declined");
  assert.equal(r.structuredContent.sent, false);
  assert.equal(sent.length, 0);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].preview_id, p.preview.preview_id);
  // a prepared intent with no attempt is settled by the decline: preparing it again makes a new preview
  const again = await prepare(layer);
  assert.equal(again.status, "prepared");
  assert.notEqual(again.preview.preview_id, p.preview.preview_id);
  // and the declined preview cannot be committed any more
  assert.equal(await commit(layer, p.preview.preview_id).then((s) => s.status), "error");
});

test("confirm sees the preview: title, effect, the arguments formatted, the exact bytes", async () => {
  const { layer, asked } = setup({ answers: [ok(3)] });
  const p = await prepare(layer);
  await commit(layer, p.preview.preview_id);
  assert.equal(asked[0].title, p.preview.title);
  assert.equal(asked[0].effect.kind, "transfer");
  assert.deepEqual(asked[0].arguments.amount, { text: "1.5 TKA", raw: "150000000" });
  assert.equal(asked[0].arg_hex, p.preview.arg_hex);
});

test("encode is injected: the bytes are candid-core's encodeArgs of the argument with the stamp", async () => {
  const { layer, updates } = setup({ answers: [ok(3)] });
  const p = await prepare(layer);
  const r = await commit(layer, p.preview.preview_id);
  assert.equal(r.outcome, "success");
  const [send] = updates();
  const expected = encodeArgsFor("icrc1_transfer", {
    to: { owner: BOB, subaccount: null },
    fee: null,
    memo: null,
    from_subaccount: null,
    created_at_time: NOW + 1_000_000_000n,
    amount: 150000000n,
  });
  assert.deepEqual(send.arg, expected);
  assert.equal(p.preview.arg_hex, Buffer.from(expected).toString("hex"));
});

test("one intent, one stamp: preparing it again returns the same preview; a done intent is not sent again", async () => {
  const { layer, updates } = setup({ answers: [ok(3)] });
  const a = await prepare(layer);
  const b = await prepare(layer, { ...transfer, amount: "1.50" });
  assert.equal(b.status, "repeated");
  assert.equal(b.preview.preview_id, a.preview.preview_id);
  assert.equal((await commit(layer, a.preview.preview_id)).outcome, "success");
  const again = await commit(layer, a.preview.preview_id);
  assert.deepEqual([again.outcome, again.sent], ["already_done", false]);
  assert.equal(updates().length, 1);
  // a settled intent prepared again gets a later stamp
  const c = await prepare(layer);
  assert.notEqual(c.preview.preview_id, a.preview.preview_id);
});

test("retry_same is handed back, not slept on; committing again sends the same bytes", async () => {
  const { layer, updates } = setup({ answers: [err("TemporarilyUnavailable"), ok(4)] });
  const p = await prepare(layer);
  const first = await layer.callTool("commit", { preview_id: p.preview.preview_id });
  assert.equal(first.structuredContent.outcome, "retry_same");
  assert.equal(first.isError, true);
  assert.equal(updates().length, 1);
  assert.equal((await commit(layer, p.preview.preview_id)).outcome, "success");
  assert.deepEqual(updates()[0].arg, updates()[1].arg);
});

test("retry_new: a new preview to confirm, the old one retired, a later stamp", async () => {
  const { layer, updates, asked } = setup({ answers: [err("TooOld"), ok(5)] });
  const p = await prepare(layer);
  const r = await commit(layer, p.preview.preview_id);
  assert.equal(r.outcome, "retry_new");
  assert.equal(r.case, "Err.TooOld");
  const next = r.next.preview_id;
  assert.notEqual(next, p.preview.preview_id);
  const old = await commit(layer, p.preview.preview_id);
  assert.deepEqual([old.status, old.successor], ["error", next]);
  assert.equal((await commit(layer, next)).outcome, "success");
  assert.equal(asked.length, 2, "the re-stamped call is confirmed again");
  const [a, b] = updates();
  assert.ok(b.value.created_at_time > a.value.created_at_time);
});

test("retry_new after CreatedInFuture: the new stamp never exceeds the ledger_time the error reports", async () => {
  const ledgerTime = NOW - 60_000_000_000n;
  const { layer } = setup({ answers: [err("CreatedInFuture", { ledger_time: ledgerTime })] });
  const p = await prepare(layer);
  const r = await commit(layer, p.preview.preview_id);
  assert.equal(r.outcome, "retry_new");
  assert.equal(r.next.arguments.created_at_time.raw, String(ledgerTime));
});

test("the ledger_time cap applies after the high-water mark: a clock at the cap behind an earlier stamp", async () => {
  const times = [1000n, 500n]; // prepared at 1000; the re-stamp reads 500, which is also the reported ledger_time
  const { layer } = setup({ answers: [err("CreatedInFuture", { ledger_time: 500n })], clock: () => times.shift() ?? 500n });
  const p = await prepare(layer);
  const r = await commit(layer, p.preview.preview_id);
  assert.equal(r.outcome, "retry_new");
  assert.equal(r.next.arguments.created_at_time.raw, "500", "never 1001, which is ahead of the ledger again");
});

test("retry_new re-resolves a relative time against the new clock reading", async () => {
  const { layer, updates } = setup({ answers: [err("TooOld"), ok(1)] });
  const approve = { canister_id: TKA, spender: BOB, amount: "1", expires_at: "+PT1H" };
  const p = await prepare(layer, approve, "prepare_icrc2_approve");
  const r = await commit(layer, p.preview.preview_id);
  await commit(layer, r.next.preview_id);
  const [a, b] = updates();
  assert.equal(a.value.expires_at - a.value.created_at_time, 3_600_000_000_000n);
  assert.equal(b.value.expires_at - b.value.created_at_time, 3_600_000_000_000n);
  assert.ok(b.value.expires_at > a.value.expires_at);
});

test("an unknown outcome: commit again sends the same bytes; already_done then settles it", async () => {
  const { layer, updates } = setup({ answers: [{ status: "unknown", message: "timeout" }, err("Duplicate", { duplicate_of: 7n })] });
  const p = await prepare(layer);
  assert.equal((await commit(layer, p.preview.preview_id)).outcome, "unknown");
  assert.equal((await prepare(layer)).status, "repeated", "an unknown intent is not stamped again");
  const r = await commit(layer, p.preview.preview_id);
  assert.equal(r.outcome, "already_done");
  assert.deepEqual(r.details, { duplicate_of: "7" });
  assert.deepEqual(updates()[0].arg, updates()[1].arg);
});

test("unknown, then retry_same: committing again resends the same bytes, so the ledger's dedup settles it (#37 review)", async () => {
  const { layer, updates } = setup({ answers: [{ status: "unknown", message: "timeout" }, err("TemporarilyUnavailable"), err("Duplicate", { duplicate_of: 7n }), err("TooOld")] });
  const p = await prepare(layer);
  await commit(layer, p.preview.preview_id);
  assert.equal((await commit(layer, p.preview.preview_id)).outcome, "retry_same");
  assert.equal((await prepare(layer)).status, "repeated", "still unsettled: no new stamp");
  assert.equal((await commit(layer, p.preview.preview_id)).outcome, "already_done");
  const [a, b, c] = updates();
  assert.deepEqual(b.arg, a.arg);
  assert.deepEqual(c.arg, a.arg);
});

test("rule 1: unknown, then TooOld, asks the reconcile hook; found is already_done", async () => {
  const calls = [];
  const { layer } = setup({
    answers: [{ status: "unknown", message: "timeout" }, err("TooOld")],
    reconcile: async (o) => (calls.push(o), { status: "found", block: 9n }),
  });
  const p = await prepare(layer);
  await commit(layer, p.preview.preview_id);
  const r = await commit(layer, p.preview.preview_id);
  assert.deepEqual([r.outcome, r.reconciled.block, r.reconciled.after], ["already_done", "9", "Err.TooOld"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "icrc1_transfer");
  assert.equal(calls[0].stamp, calls[0].value.created_at_time);
});

test("rule 1 without a hook: reconcile, and the intent is held (no new stamp, no send)", async () => {
  const { layer, updates } = setup({ answers: [{ status: "unknown", message: "timeout" }, err("BadFee", { expected_fee: 10000n })] });
  const p = await prepare(layer);
  await commit(layer, p.preview.preview_id);
  const r = await commit(layer, p.preview.preview_id);
  assert.deepEqual([r.outcome, r.finding.status, r.finding.after], ["reconcile", "unreadable", "Err.BadFee"], "fix_input after an unknown outcome is not final (#9)");
  assert.equal((await prepare(layer)).outcome, "reconcile");
  assert.equal((await commit(layer, p.preview.preview_id)).outcome, "reconcile");
  assert.equal(updates().length, 2);
});

test("reconcile absent settles the intent; a new preparation is a new stamp", async () => {
  const { layer } = setup({ answers: [{ status: "unknown", message: "timeout" }, err("TooOld")], reconcile: async () => ({ status: "absent" }) });
  const p = await prepare(layer);
  await commit(layer, p.preview.preview_id);
  assert.equal((await commit(layer, p.preview.preview_id)).finding.status, "absent");
  const again = await prepare(layer);
  assert.equal(again.status, "prepared");
});

test("rejects: 1 to 3 did not execute; 4 and 5 are unknown; the third answered unknown needs a reconciliation", async () => {
  const reject = (code) => ({ status: "rejected", reject_code: code, message: `code ${code}` });
  const { layer, updates } = setup({ answers: [reject(2), reject(4), reject(5), reject(4)] });
  const p = await prepare(layer);
  assert.equal((await commit(layer, p.preview.preview_id)).outcome, "not_executed");
  assert.equal((await commit(layer, p.preview.preview_id)).outcome, "unknown");
  assert.equal((await commit(layer, p.preview.preview_id)).outcome, "unknown");
  const r = await commit(layer, p.preview.preview_id);
  assert.deepEqual([r.outcome, r.finding.after], ["reconcile", "reject 4"]);
  assert.equal(updates().length, 4);
});

test("fix_input and fail settle an intent with no unknown attempt", async () => {
  const { layer } = setup({ answers: [err("InsufficientFunds", { balance: 0n })] });
  const p = await prepare(layer);
  const r = await commit(layer, p.preview.preview_id);
  assert.deepEqual([r.outcome, r.details.balance.text], ["fail", "0 TKA"]);
  assert.equal((await commit(layer, p.preview.preview_id)).status, "error");
});

test("a commit already waiting on the person is not sent twice", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { layer, updates } = setup({ answers: [ok(1)], confirm: () => gate.then(() => true) });
  const p = await prepare(layer);
  const first = commit(layer, p.preview.preview_id);
  const second = await commit(layer, p.preview.preview_id);
  assert.equal(second.status, "error");
  release();
  assert.equal((await first).outcome, "success");
  assert.equal(updates().length, 1);
});

test("queries: the answer formatted and raw", async () => {
  const { layer, sent } = setup();
  const r = await layer.callTool("icrc1_balance_of", { canister_id: TKA, account: BOB });
  assert.deepEqual(r.structuredContent.value, { text: "1.5 TKA", raw: "150000000" });
  assert.equal(sent[0].mode, "query");
  assert.match(r.content[0].text, /1\.5 TKA/);
});

test("input errors send nothing and name each input", async () => {
  const { layer, sent } = setup();
  const r = await layer.callTool("prepare_icrc1_transfer", { canister_id: TKA, to: BOB, amount: "1.123456789" });
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.issues[0].code, "E_EXCESS_PRECISION");
  assert.equal((await layer.callTool("prepare_icrc1_transfer", { to: BOB, amount: "1" })).isError, true);
  assert.equal((await layer.callTool("nope", {})).isError, true);
  assert.equal((await layer.callTool("commit", { preview_id: "p1", extra: 1 })).isError, true);
  assert.equal(sent.length, 0);
});

test("createToolLayer: no auto-approve default, and the host functions are checked", () => {
  const base = { resolved: PACKS, canisters: LEDGERS, encode: () => new Uint8Array(), call: async () => ({}), now: async () => 0n };
  assert.throws(() => createToolLayer(base), /`confirm` must be a function/);
  assert.throws(() => createToolLayer({ ...base, confirm: async () => true, canisters: [] }), /at least one canister/);
  assert.throws(() => createToolLayer({ ...base, confirm: async () => true, encode: undefined }), /`encode`/);
  // a read-only form needs no confirm
  const reads = structuredClone(PACKS[0]);
  delete reads.methods.icrc1_transfer;
  assert.ok(createToolLayer({ ...base, resolved: reads }));
});

test("two preparations of one intent at once give one preview and one stamp (async encode)", async () => {
  const { layer, updates } = setup({ answers: [ok(1), ok(2)], asyncEncode: true });
  const [a, b] = await Promise.all([prepare(layer), prepare(layer)]);
  assert.deepEqual([a.status, b.status], ["prepared", "repeated"]);
  assert.equal(a.preview.preview_id, b.preview.preview_id);
  assert.equal((await commit(layer, a.preview.preview_id)).outcome, "success");
  assert.equal((await commit(layer, b.preview.preview_id)).outcome, "already_done");
  assert.equal(updates().length, 1);
});

test("a call that throws is an unknown outcome: a later TooOld needs a reconciliation, not a new stamp", async () => {
  const { layer, updates } = setup({ answers: [new Error("fetch timeout"), err("TooOld")] });
  const p = await prepare(layer);
  const u = await commit(layer, p.preview.preview_id);
  assert.deepEqual([u.outcome, u.preview_id, u.message], ["unknown", p.preview.preview_id, "fetch timeout"], "answered as unknown, not thrown");
  assert.equal((await prepare(layer)).status, "repeated", "not stamped again after a throw");
  const r = await commit(layer, p.preview.preview_id);
  assert.deepEqual([r.outcome, r.finding.after], ["reconcile", "Err.TooOld"]);
  assert.equal(updates().length, 2);
});

test("a capped CreatedInFuture re-stamp does not lower the stamps later intents get", async () => {
  const times = [1000n, 2000n, 3000n, 1500n]; // the last reading behind an earlier stamp (a host clock, #9 G-6)
  const { layer, updates } = setup({ answers: [ok(1), err("CreatedInFuture", { ledger_time: 500n }), ok(2), ok(3)], clock: () => times.shift() ?? 1500n });
  const a = await prepare(layer);
  await commit(layer, a.preview.preview_id); // stamp 1000, done
  const b = await prepare(layer); // stamp 2000
  const r = await commit(layer, b.preview.preview_id); // capped to 500
  assert.equal(r.next.arguments.created_at_time.raw, "500");
  await commit(layer, r.next.preview_id);
  const c = await prepare(layer);
  await commit(layer, c.preview.preview_id);
  const stamps = updates().map((u) => u.value.created_at_time);
  assert.ok(stamps.at(-1) > 2000n, `the next intent's stamp ${stamps.at(-1)} is above every earlier one`);
});

test("answered unknowns count across not-executed rejects: 4, 1, 4, 1, 4 needs a reconciliation", async () => {
  const reject = (code) => ({ status: "rejected", reject_code: code, message: `code ${code}` });
  const { layer } = setup({ answers: [reject(4), reject(1), reject(4), reject(1), reject(4)] });
  const p = await prepare(layer);
  const outcomes = [];
  for (let i = 0; i < 5; i++) outcomes.push((await commit(layer, p.preview.preview_id)).outcome);
  assert.deepEqual(outcomes, ["unknown", "not_executed", "unknown", "not_executed", "reconcile"]);
});


test("outcome keys and the stamp are matched by the position they resolve to, not by their spelling", async () => {
  const icrc1 = structuredClone(ICRC1);
  const tags = icrc1.methods.icrc1_transfer.tags;
  const respell = (k, i) => (i % 3 === 0 ? `(0).${k}` : i % 3 === 1 ? `.${k}` : k);
  tags.outcome.args.classes = Object.fromEntries(Object.entries(tags.outcome.args.classes).map(([k, v], i) => [respell(k, i), v]));
  assert.ok(Object.hasOwn(tags.outcome.args.classes, "(0).Ok") && Object.hasOwn(tags.outcome.args.classes, ".Err.Duplicate"));
  tags.idempotency.args.stamp = "(0).created_at_time";
  const { layer, updates } = setup({ resolved: [icrc1, ICRC2], answers: [ok(7), err("Duplicate", { duplicate_of: 3n })] });
  const first = await prepare(layer);
  assert.equal(first.status, "prepared");
  assert.equal((await commit(layer, first.preview.preview_id)).outcome, "success", "(0).Ok is the Ok case");
  assert.equal(typeof updates()[0].value.created_at_time, "bigint", "the stamp fills created_at_time");
  assert.equal(Object.hasOwn(updates()[0].value, "(0).created_at_time"), false);
  const second = await prepare(layer, { ...transfer, amount: "2 TKA" });
  assert.equal((await commit(layer, second.preview.preview_id)).outcome, "already_done", ".Err.Duplicate is Err.Duplicate");
});

test("rule 1: a reconcile hook that throws holds the intent; the next commit reads again and does not send", async () => {
  let fail = true;
  const { layer, updates } = setup({
    answers: [{ status: "unknown", message: "timeout" }, err("TooOld")],
    reconcile: async () => {
      if (fail) throw new Error("history query timed out");
      return { status: "found", block: 4n };
    },
  });
  const p = await prepare(layer);
  await commit(layer, p.preview.preview_id);
  const r = await commit(layer, p.preview.preview_id);
  assert.deepEqual([r.outcome, r.finding.status], ["reconcile", "unreadable"]);
  assert.match(r.finding.reason, /timed out/);
  fail = false;
  const again = await commit(layer, p.preview.preview_id);
  assert.deepEqual([again.outcome, again.reconciled.block], ["already_done", "4"]);
  assert.equal(updates().length, 2, "no third send");
});

test("the clock hook is told which canister it is for (#37 review)", async () => {
  const { layer, clocks } = setup({ answers: [err("TooOld"), ok(1)] });
  const p = await layer.callTool("prepare_icrc1_transfer", { ...transfer, canister_id: LEDGERS[1].id, amount: "1.5 TKB" });
  await commit(layer, p.structuredContent.preview.preview_id);
  assert.ok(clocks.length >= 2, "the preparation and the re-stamp both read a clock");
  for (const o of clocks) assert.deepEqual(o, { canister: LEDGERS[1].id });
});

test("retry_same stops after three: settled as fail, or a reconciliation after an unknown outcome (#37 review)", async () => {
  const busy = () => err("TemporarilyUnavailable");
  const a = setup({ answers: [busy(), busy(), busy()] });
  const p = await prepare(a.layer);
  assert.equal((await commit(a.layer, p.preview.preview_id)).outcome, "retry_same");
  assert.equal((await commit(a.layer, p.preview.preview_id)).outcome, "retry_same");
  const third = await commit(a.layer, p.preview.preview_id);
  assert.deepEqual([third.outcome, third.retries_spent], ["fail", 3]);
  assert.equal((await a.layer.callTool("commit", { preview_id: p.preview.preview_id })).structuredContent.status, "error", "settled: no fourth send");
  assert.equal(a.updates().length, 3);

  const b = setup({ answers: [{ status: "unknown", message: "timeout" }, busy(), busy(), busy()] });
  const q = await prepare(b.layer);
  await commit(b.layer, q.preview.preview_id);
  await commit(b.layer, q.preview.preview_id);
  await commit(b.layer, q.preview.preview_id);
  const r = await commit(b.layer, q.preview.preview_id);
  assert.deepEqual([r.outcome, r.finding.status, r.finding.after], ["reconcile", "unreadable", "Err.TemporarilyUnavailable"]);
  assert.equal(b.updates().length, 4);
});

test("preparing an intent again after an unknown outcome keeps the warning: it may have executed (#37 review)", async () => {
  const { layer } = setup({ answers: [{ status: "unknown", message: "timeout" }, err("TemporarilyUnavailable")] });
  const p = await prepare(layer);
  const fresh = await layer.callTool("prepare_icrc1_transfer", transfer);
  assert.equal(fresh.structuredContent.outcome, undefined, "a never-sent preparation has no outcome");
  await commit(layer, p.preview.preview_id);
  const r = await layer.callTool("prepare_icrc1_transfer", transfer);
  assert.equal(r.structuredContent.status, "repeated");
  assert.equal(r.structuredContent.outcome, "unknown");
  assert.equal(r.structuredContent.preview.preview_id, p.preview.preview_id);
  assert.match(r.content[0].text, /may have executed/);
  assert.doesNotMatch(r.content[0].text, /not executed|Nothing has been sent/);
  // a retry_same after it leaves the intent prepared, and the earlier unknown still holds
  await commit(layer, p.preview.preview_id);
  assert.equal((await prepare(layer)).outcome, "unknown");
});

test("declining a commit after an unknown outcome keeps the warning: the earlier attempt may have executed (#37 review)", async () => {
  let approve = true;
  const { layer, updates } = setup({ answers: [{ status: "unknown", message: "timeout" }], confirm: async () => approve });
  const p = await prepare(layer);
  await commit(layer, p.preview.preview_id);
  approve = false;
  const r = await layer.callTool("commit", { preview_id: p.preview.preview_id });
  assert.equal(r.structuredContent.outcome, "declined");
  assert.equal(r.structuredContent.sent, false);
  assert.equal(r.structuredContent.earlier_outcome, "unknown");
  assert.match(r.content[0].text, /may have executed/);
  assert.doesNotMatch(r.content[0].text, /so nothing was sent/);
  assert.equal(updates().length, 1);
  assert.equal((await prepare(layer)).outcome, "unknown", "still unknown: no new stamp");
});

test("a stamp declined before any send sets no floor, and is never handed out again (#32 review, G-31)", async () => {
  const times = [2000n, 1000n, 1000n, 500n]; // a clock ahead, then reset behind it, then behind the sent stamp
  let approve = false;
  const { layer, updates } = setup({ clock: () => times.shift() ?? 500n, confirm: async () => approve, answers: [ok(1)] });
  const stampOf = (r) => r.preview.arguments.created_at_time.raw;
  const ahead = await prepare(layer);
  assert.equal(stampOf(ahead), "2000");
  assert.equal((await commit(layer, ahead.preview.preview_id)).outcome, "declined");
  const reset = await prepare(layer);
  assert.equal(stampOf(reset), "1000", "follows the clock, not one past the declined stamp");
  assert.equal((await commit(layer, reset.preview.preview_id)).outcome, "declined");
  const same = await prepare(layer); // the clock reads 1000 again: that stamp is taken
  assert.equal(stampOf(same), "1001", "a declined stamp is never handed out again");
  approve = true;
  assert.equal((await commit(layer, same.preview.preview_id)).outcome, "success");
  assert.equal(updates().length, 1);
  const next = await prepare(layer); // a sent stamp is a floor: the clock reads 500
  assert.equal(stampOf(next), "1002");
});

test("only a CreatedInFuture re-stamp is capped by ledger_time, not another retry_new case with that field (#37 review)", async () => {
  const icrc1 = structuredClone(ICRC1);
  const m = icrc1.methods.icrc1_transfer;
  m.results[0].cases.Err.cases.Throttled = { candid: "record", fields: { ledger_time: { candid: "nat64" } } };
  m.tags.outcome.args.classes["Err.Throttled"] = "retry_new";
  const times = [1000n, 2000n];
  const { layer } = setup({ resolved: [icrc1, ICRC2], clock: () => times.shift() ?? 2000n, answers: [err("Throttled", { ledger_time: 500n })] });
  const p = await prepare(layer);
  const r = await commit(layer, p.preview.preview_id);
  assert.equal(r.outcome, "retry_new");
  assert.equal(r.next.arguments.created_at_time.raw, "2000", "not capped at 500");
});
