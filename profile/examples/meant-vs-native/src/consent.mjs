// Section 2: what a person is shown before they approve a call. Three ways for the same argument bytes: the raw
// Candid value (what a signer can show without ICRC-21), the DFINITY ledger's own ICRC-21 consent message (hand-written
// in Rust inside the ledger, asked of the real ledger on PocketIC) and Meant's, generated from a profile.
import { readFileSync } from "node:fs";
import path from "node:path";
import { IDL } from "@icp-sdk/core/candid";
import { createSchemaValidator, resolveService } from "@meantjs/profile";
import { icrc21ConsentMessage } from "@meantjs/consent";
import { idlFactory } from "../node_modules/@icp-sdk/canisters/declarations/ledger-icrc/icrc_ledger.idl.js";
import { ALICE, BOB } from "./world.mjs";
import { nativeLedger, refsFromCanister } from "./ledger.mjs";
import { exactDecimal } from "./exact.mjs";

const SERVICE = idlFactory({ IDL });
const argTypes = (method) => SERVICE._fields.find(([name]) => name === method)[1].argTypes;
const EXPIRES = 1_798_761_600_000_000_000n; // 2027-01-01T00:00:00Z in ns
const PREFS = { language: "en", utcOffsetMinutes: 120 };

const CALLS = [
  { id: "transfer", label: "Send 0.29 TKA with memo `rent`", token: "TKA", method: "icrc1_transfer", amount: 29_000_000n, memo: "rent" },
  { id: "big8", label: "Send 1234567890.12345678 TKA", token: "TKA", method: "icrc1_transfer", amount: 123_456_789_012_345_678n },
  { id: "eth18", label: "Send 1.000000000000000001 TKC (18 decimals, like ckETH)", token: "TKC", method: "icrc1_transfer", amount: 1_000_000_000_000_000_001n },
  { id: "eth18b", label: "Send 123456.123456789012345678 TKC", token: "TKC", method: "icrc1_transfer", amount: 123_456_123_456_789_012_345_678n },
  { id: "approve", label: "Approve the largest allowance (2^128 - 1 base units), until 2027-01-01", token: "TKA", method: "icrc2_approve", amount: 2n ** 128n - 1n },
];

/** The call's argument as agent-js values: its bytes go to all three, and its decoded value is the raw view. */
function nativeArg(call) {
  const memo = call.memo ? [new TextEncoder().encode(call.memo)] : [];
  if (call.method === "icrc1_transfer") return { to: { owner: BOB, subaccount: [] }, amount: call.amount, fee: [], memo, from_subaccount: [], created_at_time: [] };
  return { spender: { owner: BOB, subaccount: [] }, amount: call.amount, fee: [], memo, from_subaccount: [], created_at_time: [], expected_allowance: [], expires_at: [EXPIRES] };
}

/** The amount a consent text shows, for the check against the exact value. */
const shownAmount = (text) => /`([0-9.,]+) TK[ABC]`/.exec(text)?.[1] ?? null;

export async function runConsent(world, iface) {
  const rows = [];
  for (const call of CALLS) {
    const token = world.tokens.find((t) => t.symbol === call.token);
    const arg = new Uint8Array(IDL.encode(argTypes(call.method), [nativeArg(call)]));
    const raw = argTypes(call.method)[0].valueToString(IDL.decode(argTypes(call.method), arg)[0]);
    const ledger = nativeLedger(world.pic, token.ledger, ALICE);
    let native;
    try {
      const info = await ledger.consentMessage({ method: call.method, arg, userPreferences: { metadata: PREFS, deriveSpec: { GenericDisplay: null } } });
      native = { ok: true, text: info.consent_message.GenericDisplayMessage };
    } catch (e) {
      native = { ok: false, text: `${e.constructor.name}: ${e.message}` };
    }
    let nativeFields;
    try {
      await ledger.consentMessage({ method: call.method, arg, userPreferences: { metadata: PREFS, deriveSpec: { FieldsDisplay: null } } });
      nativeFields = { ok: true };
    } catch (e) {
      nativeFields = { ok: false, text: e.message };
    }
    const refs = await refsFromCanister(iface, world.pic, token.ledger, ALICE);
    const response = icrc21ConsentMessage(
      { method: call.method, arg, user_preferences: { metadata: { language: "en", utc_offset_minutes: 120 }, device_spec: { GenericDisplay: null } } },
      { resolved: iface.resolved, refs },
    );
    if (!response.Ok) throw new Error(`Meant: ${JSON.stringify(response)}`);
    const meant = response.Ok.consent_message.GenericDisplayMessage;
    const fields = icrc21ConsentMessage(
      { method: call.method, arg, user_preferences: { metadata: { language: "en", utc_offset_minutes: null }, device_spec: { FieldsDisplay: null } } },
      { resolved: iface.resolved, refs },
    );
    const exact = exactDecimal(call.amount, token.decimals);
    const row = {
      ...call, exact, raw, rawAmount: `amount=${call.amount}`, native, nativeFields, meant, meantFields: Boolean(fields.Ok),
      nativeAmount: native.ok ? shownAmount(native.text) : null, meantAmount: shownAmount(meant),
    };
    if (row.meantAmount !== exact) throw new Error(`${call.id}: Meant shows ${row.meantAmount}, the call carries ${exact}`);
    rows.push(row);
  }
  rows.push(await customCanister());
  return rows;
}

/**
 * A canister with no ICRC-21 endpoint at all (the repository's examples/tokens.did): the native answer is nothing
 * until its team writes one into the canister. Meant's comes from a profile of ten annotations (../tokens.profile.json), without touching the canister.
 */
async function customCanister() {
  const dir = path.join(import.meta.dirname, "..", "..");
  const did = readFileSync(path.join(dir, "tokens.did"), "utf8");
  const doc = JSON.parse(readFileSync(path.join(dir, "tokens.profile.json"), "utf8"));
  const r = await resolveService({ did, validateSchema: await createSchemaValidator(), profiles: [{ doc }] });
  if (!r.ok) throw new Error(`tokens example: ${JSON.stringify(r.diagnostics)}`);
  const Tokens = IDL.Record({ e8s: IDL.Nat64 });
  const SendArgs = IDL.Record({ to: IDL.Principal, amount: Tokens, memo: IDL.Opt(IDL.Vec(IDL.Nat8)), created_at: IDL.Opt(IDL.Nat64) });
  const value = { to: BOB, amount: { e8s: 150_000_000n }, memo: [new TextEncoder().encode("invoice 7")], created_at: [1_791_547_200_000_000_000n] };
  const arg = new Uint8Array(IDL.encode([SendArgs], [value]));
  const response = icrc21ConsentMessage(
    { method: "send", arg, user_preferences: { metadata: { language: "en", utc_offset_minutes: null }, device_spec: { GenericDisplay: null } } },
    { resolved: r.resolved, refs: {} },
  );
  if (!response.Ok) throw new Error(`Meant: ${JSON.stringify(response)}`);
  const meant = response.Ok.consent_message.GenericDisplayMessage;
  return {
    id: "custom", label: "Send 1.5 TOK on a canister with no ICRC-21 (examples/tokens.did)", exact: "1.5", raw: SendArgs.valueToString(value), rawAmount: "amount=record {e8s=150000000}",
    native: { ok: false, text: "no consent message: the canister has no icrc21_canister_call_consent_message" }, nativeFields: { ok: false },
    meant, meantFields: true, nativeAmount: null, meantAmount: /`([0-9.]+) TOK`/.exec(meant)?.[1] ?? null,
  };
}
