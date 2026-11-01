// examples/icp-mcp on PocketIC (D-061): the example canister ready for ICP MCP. What an agent reads from it must be
// what the profile says: the served sections are the .did and the profile, get_api_doc is the generated guide, and
// every ICRC-21 reply is what this package's JavaScript answers for the same request (the generic form; the Rust
// crate refuses the fields form with E_FORM). Its sends must behave as the profile's outcome classes say. Nothing here
// touches mainnet; PocketIC is pinned in artifacts.json (`npm test` fetches and builds first).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { PocketIc, PocketIcServer, SubnetStateType } from "@dfinity/pic";
import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import { createSchemaValidator, readServedProfile, resolveService } from "@meantjs/profile";
import { decodeConsentResponse, encodeConsentRequest, icrc21ConsentMessage, toJson } from "../../src/index.mjs";
import { manifest, paths, platformKey, verified } from "../scripts/artifacts.mjs";

const EXAMPLE = new URL("../../../../examples/icp-mcp/", import.meta.url);
const read = (f) => readFileSync(new URL(f, EXAMPLE));
const WASM = readFileSync(new URL("canister/target/wasm32-unknown-unknown/release/icp_mcp_example.wasm", EXAMPLE));
const RESOLVED = JSON.parse(read("icp-mcp.resolved.json"));

const USER = Principal.fromText("k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae");
const BOB = Principal.fromText("ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6");

const Tokens = IDL.Record({ e8s: IDL.Nat64 });
const SendArgs = IDL.Record({ to: IDL.Principal, amount: Tokens, memo: IDL.Opt(IDL.Vec(IDL.Nat8)), created_at: IDL.Opt(IDL.Nat64) });
const SendError = IDL.Variant({
  Insufficient: IDL.Record({ balance: Tokens }),
  Duplicate: IDL.Record({ block: IDL.Nat }),
  TooOld: IDL.Null,
  CreatedInFuture: IDL.Record({ canister_time: IDL.Nat64 }),
  Other: IDL.Text,
});
const SendResult = IDL.Variant({ Ok: IDL.Nat, Err: SendError });
const Standards = IDL.Vec(IDL.Record({ name: IDL.Text, url: IDL.Text }));

const NO_ARGS = new Uint8Array(IDL.encode([], []));
const decode = (type, bytes) => IDL.decode([type], bytes)[0];
const sendArg = (a) => new Uint8Array(IDL.encode([SendArgs], [a]));
const show = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));

let server;
let pic;
let canister;

before(async () => {
  assert.ok(manifest.pocket_ic.platforms[platformKey()]?.sha256, `no PocketIC pinned for ${platformKey()}`);
  const binPath = await verified(paths.pocketIc, manifest.pocket_ic.platforms[platformKey()].sha256);
  server = await PocketIcServer.start({ binPath });
  pic = await PocketIc.create(server.getUrl(), { application: [{ state: { type: SubnetStateType.New } }] });
  const app = (await pic.getApplicationSubnets())[0].id;
  // USER installs it, so USER holds the 1,000 TOK canister_init gives the installer
  canister = await pic.createCanister({ targetSubnetId: app, cycles: 100_000_000_000_000n, sender: USER });
  await pic.installCode({ canisterId: canister, wasm: WASM, arg: NO_ARGS, targetSubnetId: app, sender: USER });
});

after(async () => {
  await pic?.tearDown();
  await server?.stop();
});

const nowNs = async () => BigInt(await pic.getTime()) * 1_000_000n;
const query = (method, arg = NO_ARGS, sender = USER) => pic.queryCall({ canisterId: canister, method, arg, sender });
const update = (method, arg = NO_ARGS, sender = USER) => pic.updateCall({ canisterId: canister, method, arg, sender });
const balance = async (p) => decode(Tokens, await query("balance", new Uint8Array(IDL.encode([IDL.Principal], [p])))).e8s;

test("the module serves the .did and the profile as public custom sections, and the profile binds that .did", async () => {
  const module = new WebAssembly.Module(WASM);
  const section = (name) => {
    const found = WebAssembly.Module.customSections(module, name);
    assert.equal(found.length, 1, `one section ${name}`);
    return new Uint8Array(found[0]);
  };
  const service = section("icp:public candid:service");
  const profile = section("icp:public candid:profile");
  assert.deepEqual(service, new Uint8Array(read("icp-mcp.did")));
  assert.deepEqual(profile, new Uint8Array(read("icp-mcp.profile.json")));
  const served = readServedProfile(profile, { canisterId: canister.toText() });
  assert.ok(served.ok, show(served.diagnostics));
  const r = await resolveService({ did: new TextDecoder().decode(service), validateSchema: await createSchemaValidator(), profiles: [{ doc: served.doc }], packs: [] });
  assert.ok(r.ok, show(r.diagnostics));
  assert.equal(r.profiles[0].status, "applied");
  assert.deepEqual(r.resolved, RESOLVED, "what the canister embeds is what its sections resolve to");
});

test("get_api_doc answers the generated guide", async () => {
  assert.equal(decode(IDL.Text, await query("get_api_doc")), read("api-doc.md").toString("utf8"));
});

test("icrc10_supported_standards lists ICRC-10 and ICRC-21", async () => {
  assert.deepEqual(decode(Standards, await query("icrc10_supported_standards")).map((s) => s.name), ["ICRC-10", "ICRC-21"]);
});

test("every ICRC-21 reply is what the JavaScript package answers for the same request", async () => {
  const send = sendArg({ to: BOB, amount: { e8s: 150_000_000n }, memo: [new TextEncoder().encode("lunch")], created_at: [await nowNs()] });
  const prefs = (language, device_spec = { GenericDisplay: null }, utc_offset_minutes = null) => ({ metadata: { language, utc_offset_minutes }, device_spec });
  const cases = [
    ["send, en", { method: "send", arg: send, user_preferences: prefs("en") }],
    ["send, en-GB at +01:30", { method: "send", arg: send, user_preferences: prefs("en-GB", { GenericDisplay: null }, 90) }],
    ["send, de (English answer)", { method: "send", arg: send, user_preferences: prefs("de") }],
    ["send, no device spec", { method: "send", arg: send, user_preferences: prefs("en", null) }],
    ["balance", { method: "balance", arg: new Uint8Array(IDL.encode([IDL.Principal], [BOB])), user_preferences: prefs("en") }],
    ["unknown method", { method: "drain", arg: send, user_preferences: prefs("en") }],
    ["arguments that do not decode", { method: "send", arg: send.slice(0, -2), user_preferences: prefs("en") }],
  ];
  for (const [name, request] of cases) {
    const got = toJson(decodeConsentResponse(await update("icrc21_canister_call_consent_message", encodeConsentRequest(request))));
    const want = toJson(icrc21ConsentMessage(request, { resolved: RESOLVED }));
    if ("Ok" in want) assert.deepEqual(got, want, name);
    else {
      const [tag, info] = Object.entries(want.Err)[0];
      assert.equal(Object.keys(got.Err ?? {})[0], tag, `${name}: ${show(got)}`);
      assert.equal(Object.values(got.Err)[0].description.split(":")[0], info.description.split(":")[0], name);
    }
  }
  const ok = toJson(decodeConsentResponse(await update("icrc21_canister_call_consent_message", encodeConsentRequest(cases[0][1]))));
  assert.match(ok.Ok.consent_message.GenericDisplayMessage, /1\.5 TOK/, "the amount in human units");

  const fields = decodeConsentResponse(await update("icrc21_canister_call_consent_message", encodeConsentRequest({ method: "send", arg: send, user_preferences: prefs("en", { FieldsDisplay: null }) })));
  assert.match(fields.Err?.ConsentMessageUnavailable?.description ?? "", /^E_FORM: /, "the crate writes the generic form only");
  const garbage = decodeConsentResponse(await update("icrc21_canister_call_consent_message", new Uint8Array([0x44, 0x49, 0x44, 0x4c, 0xff])));
  assert.match(garbage.Err?.UnsupportedCanisterCall?.description ?? "", /^E_REQUEST: /);
});

test("sends behave as the profile's outcome classes say: exactly once, and refused when the stamp is out of the window", async () => {
  const start = await balance(USER);
  assert.equal(start, 100_000_000_000n, "1,000 TOK for the installer");
  const arg = sendArg({ to: BOB, amount: { e8s: 150_000_000n }, memo: [], created_at: [await nowNs()] });

  const first = decode(SendResult, await update("send", arg));
  assert.ok("Ok" in first, show(first));
  // the agent timed out and sends exactly the same bytes again: already_done, nothing moves twice
  const again = decode(SendResult, await update("send", arg));
  assert.deepEqual(again, { Err: { Duplicate: { block: first.Ok } } });
  assert.equal(await balance(USER), start - 150_000_000n);
  assert.equal(await balance(BOB), 150_000_000n);

  const hourNs = 3_600_000_000_000n;
  const old = decode(SendResult, await update("send", sendArg({ to: BOB, amount: { e8s: 1n }, memo: [], created_at: [(await nowNs()) - 25n * hourNs] })));
  assert.deepEqual(old, { Err: { TooOld: null } }, "retry_new");
  const future = decode(SendResult, await update("send", sendArg({ to: BOB, amount: { e8s: 1n }, memo: [], created_at: [(await nowNs()) + hourNs] })));
  assert.ok("CreatedInFuture" in (future.Err ?? {}), `retry_new: ${show(future)}`);
  const poor = decode(SendResult, await update("send", sendArg({ to: USER, amount: { e8s: 150_000_001n }, memo: [], created_at: [] }), BOB));
  assert.deepEqual(poor, { Err: { Insufficient: { balance: { e8s: 150_000_000n } } } }, "fail");
  // a send of nothing is refused, so it cannot fill the deduplication state for free (review on B3Pay/Meant#321)
  const nothing = decode(SendResult, await update("send", sendArg({ to: BOB, amount: { e8s: 0n }, memo: [], created_at: [await nowNs()] })));
  assert.deepEqual(nothing, { Err: { Other: "the amount is zero" } }, "fail");
  assert.equal(await balance(USER), start - 150_000_000n, "no refused send moved anything");
});
