// Section 4: a transfer whose reply is lost. The ledger runs the call, the caller never hears back, and tries again,
// as any app or agent does after a network error. Measured on real DFINITY ledgers on PocketIC: who got paid how often,
// and what the caller was told. Also section 5: the token's decimals assumed by the app, or read from the ledger.
import { convertStringToE8s } from "@dfinity/utils";
import { Principal } from "@icp-sdk/core/principal";
import { createToolLayer } from "@meantjs/tools";
import { DEDUP_WINDOW_NS, expectedTransaction, matchBlocks } from "@meantjs/reconcile";
import { ALICE, BOB } from "./world.mjs";
import { balanceOf, nativeLedger, refsFromCanister, transferBlocks } from "./ledger.mjs";
import { exactDecimal } from "./exact.mjs";

const RETRY_AFTER_MS = 2_000; // the caller waits a little before it tries again
const LOST = "the connection dropped before the reply arrived";

const nowNs = async (pic) => BigInt(await pic.getTime()) * 1_000_000n;
// The bundled library's class names are minified; an error with an errorType is its IcrcTransferError.
const errorText = (e) => (e?.errorType ? `IcrcTransferError ${Object.keys(e.errorType)[0]} ${JSON.stringify(Object.values(e.errorType)[0], (k, v) => (typeof v === "bigint" ? `${v}` : v))}` : e.message);
/** PocketIC's clock only moves when told to; a retry happens a little later, and so does the next scenario. */
const wait = async (pic, ms) => {
  await pic.advanceTime(ms);
  await pic.tick();
};

/** Runs `scenario` and measures what it did to the ledger: Bob's balance change and the transfer blocks it left. */
async function measured(world, iface, token, scenario) {
  await wait(world.pic, 60_000);
  const before = await balanceOf(iface, world.pic, token.ledger, BOB);
  const { logLength: floor } = await transferBlocks(iface, world.pic, token.ledger, ALICE);
  const result = await scenario();
  const after = await balanceOf(iface, world.pic, token.ledger, BOB);
  const { logLength } = await transferBlocks(iface, world.pic, token.ledger, ALICE);
  return { ...result, received: exactDecimal(after - before, token.decimals), transfers: Number(logLength - floor), floor };
}

/** The native way: IcrcLedgerCanister.transfer, and one retry when it throws. `stamp` is how the app sets created_at_time. */
async function nativeRetry(world, iface, token, stamp) {
  return measured(world, iface, token, async () => {
    const ledger = nativeLedger(world.pic, token.ledger, ALICE, { loseReplies: ["icrc1_transfer"] });
    const kept = await nowNs(world.pic);
    const attempt = async () => ledger.transfer({
      to: { owner: BOB, subaccount: [] },
      amount: 29_000_000n,
      ...(stamp === "fresh" ? { created_at_time: await nowNs(world.pic) } : stamp === "kept" ? { created_at_time: kept } : {}),
    });
    const told = [];
    try {
      told.push(`block ${await attempt()}`);
    } catch (first) {
      told.push(`error: ${errorText(first)}`);
      await wait(world.pic, RETRY_AFTER_MS);
      try {
        told.push(`retry: block ${await attempt()}`);
      } catch (second) {
        told.push(`retry: error: ${errorText(second)}`);
      }
    }
    return { told };
  });
}

/** The Meant way: @meantjs/tools, the tools an agent gets. The agent prepares, the person confirms, the agent commits. */
async function meantRetry(world, iface, token) {
  const refs = await refsFromCanister(iface, world.pic, token.ledger, ALICE);
  const canister = token.ledger.toText();
  const previews = [];
  let lostOnce = false;
  let sentValue;
  const sends = [];
  const layer = createToolLayer({
    resolved: [iface.resolved],
    canisters: [{ id: canister, label: token.symbol, refs }],
    encode: (method, value, args) => iface.encode(method, args),
    now: async () => nowNs(world.pic),
    confirm: async (preview) => {
      previews.push(preview);
      return true; // the person said yes; a real host shows the preview and waits
    },
    call: async ({ method, mode, arg, value }) => {
      const canisterId = Principal.fromText(canister);
      if (mode === "query") return { status: "replied", reply: iface.decode(method, await world.pic.queryCall({ canisterId, method, arg, sender: ALICE })) };
      sends.push(Buffer.from(arg).toString("hex"));
      sentValue = value;
      const reply = iface.decode(method, await world.pic.updateCall({ canisterId, method, arg, sender: ALICE }));
      if (method === "icrc1_transfer" && !lostOnce) {
        lostOnce = true;
        return { status: "unknown", message: LOST }; // the ledger ran it; the reply never arrived
      }
      return { status: "replied", reply };
    },
  });
  return measured(world, iface, token, async () => {
    const told = [];
    const input = { canister_id: canister, to: BOB.toText(), amount: `0.29 ${token.symbol}` };
    const p = await layer.callTool("prepare_icrc1_transfer", input);
    const id = p.structuredContent.preview.preview_id;
    const c1 = await layer.callTool("commit", { preview_id: id });
    told.push(`commit: ${c1.structuredContent.outcome}`);
    await wait(world.pic, RETRY_AFTER_MS);
    // An agent that starts over prepares the same call again: it gets the same preview back, not a new stamp.
    const again = await layer.callTool("prepare_icrc1_transfer", input);
    told.push(`prepare again: ${again.structuredContent.preview.preview_id === id ? "same preview" : "a new preview"} (${again.structuredContent.outcome ?? again.structuredContent.status})`);
    const c2 = await layer.callTool("commit", { preview_id: id });
    told.push(`commit again: ${c2.structuredContent.outcome}`);
    return { told, previews, sends, sentValue };
  });
}

/** Consumer rule 1 with @meantjs/reconcile: after the unknown outcome, is the original in the ledger's ICRC-3 log? */
async function reconcileOriginal(world, iface, token, meant) {
  const { blocks, logLength } = await transferBlocks(iface, world.pic, token.ledger, ALICE);
  const expected = expectedTransaction("icrc1_transfer", meant.sentValue, ALICE.toText(), { minting: null });
  const found = matchBlocks(blocks.filter((b) => b.id >= meant.floor), expected, { logLength, floor: meant.floor, inFlight: true, ledgerTime: await nowNs(world.pic), windowNs: DEDUP_WINDOW_NS });
  return found;
}

/** Section 5: "send 1.5" on the 6-decimal ledger (like ckUSDC), with decimals assumed by the app or read from the ledger. */
async function decimals(world, iface) {
  const token = world.tokens.find((t) => t.symbol === "TKB");
  const native = await measured(world, iface, token, async () => {
    // An app that reuses ICP's helper (8 decimals) for every ICRC token: an illustration of a known kind of bug.
    const amount = convertStringToE8s("1.5");
    const block = await nativeLedger(world.pic, token.ledger, ALICE).transfer({ to: { owner: BOB, subaccount: [] }, amount });
    return { told: [`block ${block}`], amount };
  });
  const refs = await refsFromCanister(iface, world.pic, token.ledger, ALICE);
  const canister = token.ledger.toText();
  const layer = createToolLayer({
    resolved: [iface.resolved],
    canisters: [{ id: canister, label: token.symbol, refs }],
    encode: (method, value, args) => iface.encode(method, args),
    now: async () => nowNs(world.pic),
    confirm: async () => true,
    call: async ({ method, mode, arg }) => {
      const canisterId = Principal.fromText(canister);
      const bytes = mode === "query" ? await world.pic.queryCall({ canisterId, method, arg, sender: ALICE }) : await world.pic.updateCall({ canisterId, method, arg, sender: ALICE });
      return { status: "replied", reply: iface.decode(method, bytes) };
    },
  });
  const meant = await measured(world, iface, token, async () => {
    const p = await layer.callTool("prepare_icrc1_transfer", { canister_id: canister, to: BOB.toText(), amount: "1.5" });
    const c = await layer.callTool("commit", { preview_id: p.structuredContent.preview.preview_id });
    return { told: [`commit: ${c.structuredContent.outcome}`], refs };
  });
  const wrongToken = await layer.callTool("prepare_icrc1_transfer", { canister_id: canister, to: BOB.toText(), amount: "1.5 TKA" });
  return { token: token.symbol, native, meant, wrongToken: wrongToken.content[0].text, wrongTokenIssues: wrongToken.structuredContent.issues };
}

export async function runRetry(world, iface) {
  const token = world.tokens.find((t) => t.symbol === "TKA");
  const rows = [
    { id: "none", label: "@icp-sdk/canisters `transfer({ to, amount })` (no created_at_time, the library's default)", ...(await nativeRetry(world, iface, token, "none")) },
    { id: "fresh", label: "the same, with `created_at_time: now` set on each attempt", ...(await nativeRetry(world, iface, token, "fresh")) },
    { id: "kept", label: "the same, with one `created_at_time` kept for the retry", ...(await nativeRetry(world, iface, token, "kept")) },
  ];
  const meant = await meantRetry(world, iface, token);
  rows.push({ id: "meant", label: "@meantjs/tools: `prepare_icrc1_transfer`, confirm, `commit`, and `commit` again", ...meant, reconcile: await reconcileOriginal(world, iface, token, meant) });
  // The claims the write-up makes; a run where they do not hold fails.
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  if (by.none.transfers !== 2 || by.fresh.transfers !== 2) throw new Error("expected the native retries without a kept stamp to pay twice");
  if (by.kept.transfers !== 1 || by.meant.transfers !== 1) throw new Error("expected one transfer with a kept stamp");
  if (by.meant.sends.length !== 2 || by.meant.sends[0] !== by.meant.sends[1]) throw new Error("expected Meant to resend the same bytes");
  if (by.meant.reconcile.status !== "found") throw new Error(`reconcile: ${JSON.stringify(by.meant.reconcile)}`);
  return { token: token.symbol, rows, decimals: await decimals(world, iface) };
}
