// The example validator canister (rust/examples/sns_validator.rs) registered with the real SNS governance canister on
// PocketIC: generic nervous system functions are added by proposal, then every dapp case of the SNS goldens is
// proposed. Governance must store exactly the text the JavaScript package renders, inside the layout the package's
// tests simulate, refuse the proposals the validator refuses, and send the target the payload it showed. Nothing
// here touches mainnet; artifacts are pinned in artifacts.json (`npm test` fetches and builds first).

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { after, before, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { encode as didcEncode } from "@dfinity/didc";
import { PocketIc, PocketIcServer, SubnetStateType } from "@dfinity/pic";
import { IDL } from "@icp-sdk/core/candid";
import { Principal } from "@icp-sdk/core/principal";
import { SNS_RENDERING_RULES, verifySnsRendering } from "../../src/sns.mjs";
import { functionDebug, governanceRendering, proposalPayloadSummary, sha256Hex } from "../../test/sns-helpers.mjs";
import { manifest, paths, platformKey, verified } from "../scripts/artifacts.mjs";

const GOLDEN_DIR = new URL("../../test/sns-golden/", import.meta.url);
const RESOLVED = JSON.parse(readFileSync(new URL("resolved/dapp.resolved.json", GOLDEN_DIR), "utf8"));
const GOLDENS = readdirSync(GOLDEN_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(new URL(f, GOLDEN_DIR), "utf8")))
  .filter((g) => g.source === "dapp");
const WASM = (name) => readFileSync(new URL(`../../rust/target/wasm32-unknown-unknown/release/examples/${name}.wasm`, import.meta.url));

/** The methods the example validator answers for; `upgrade_protocol` is not in the dapp's interface. */
const METHODS = ["pay_grant", "set_ledger", "set_claim_window", "set_fee_bps", "pause", "upgrade_protocol"];
const FUNCTION_ID = Object.fromEntries(METHODS.map((m, i) => [m, 1000 + i]));
const TOPIC = "ApplicationBusinessLogic";

// A proposer with one neuron that holds all the voting power, so a proposal is adopted as soon as it is made.
const USER = Principal.fromText("k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae");
const NEURON = new Uint8Array(32).fill(7);
const NEURON_HEX = Buffer.from(NEURON).toString("hex");

const blobText = (bytes) => `blob "${[...bytes].map((b) => `\\${b.toString(16).padStart(2, "0")}`).join("")}"`;
const textLit = (s) => JSON.stringify(s);
/**
 * Every function's description imitates the target fields and names the validator canister, over two lines, so the
 * reviewer's check must read the target from governance's own field (PR #7 review).
 */
const lureFor = (m) => `Calls ${m}. target_canister_id: Some(${validator.toText()}) target_method_name: Some("drain_treasury")\n                target_canister_id: Some(`;

let server;
let pic;
let did;
let governance;
let validator;
let target;

// ------------------------------------------------------------------------------------------- reply types (subsets)

const GovernanceError = IDL.Record({ error_message: IDL.Text, error_type: IDL.Int32 });
const ProposalId = IDL.Record({ id: IDL.Nat64 });
const ManageNeuronResponse = IDL.Record({
  command: IDL.Opt(IDL.Variant({ Error: GovernanceError, MakeProposal: IDL.Record({ proposal_id: IDL.Opt(ProposalId) }) })),
});
const ExecuteGeneric = IDL.Record({ function_id: IDL.Nat64, payload: IDL.Vec(IDL.Nat8) });
const ProposalData = IDL.Record({
  id: IDL.Opt(ProposalId),
  payload_text_rendering: IDL.Opt(IDL.Text),
  failure_reason: IDL.Opt(GovernanceError),
  decided_timestamp_seconds: IDL.Nat64,
  executed_timestamp_seconds: IDL.Nat64,
  failed_timestamp_seconds: IDL.Nat64,
  execution_reply: IDL.Opt(IDL.Vec(IDL.Nat8)),
  proposal: IDL.Opt(IDL.Record({ title: IDL.Text, action: IDL.Opt(IDL.Variant({ ExecuteGenericNervousSystemFunction: ExecuteGeneric, AddGenericNervousSystemFunction: IDL.Reserved })) })),
});
const GetProposalResponse = IDL.Record({ result: IDL.Opt(IDL.Variant({ Error: GovernanceError, Proposal: ProposalData })) });
const ListFunctionsResponse = IDL.Record({
  functions: IDL.Vec(IDL.Record({ id: IDL.Nat64, name: IDL.Text })),
});
const Calls = IDL.Vec(IDL.Record({ method: IDL.Text, caller: IDL.Vec(IDL.Nat8), arg: IDL.Vec(IDL.Nat8) }));
const ValidatorResult = IDL.Variant({ Ok: IDL.Text, Err: IDL.Text });

const NO_ARGS = new Uint8Array(IDL.encode([], []));
const decode = (type, bytes) => IDL.decode([type], bytes)[0];
const show = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
/** Candid text, typed by the official governance .did, to argument bytes. */
const encodeArgs = (method, text) =>
  Uint8Array.from(Buffer.from(didcEncode({ idl: did, input: text, targetFormat: "hex", withType: method ? { kind: "methodParams", name: method } : { kind: "serviceParams" } }), "hex"));

// ------------------------------------------------------------------------------------------------------- the network

function governanceInit({ root, ledger, swap }) {
  return `(record {
    root_canister_id = opt principal "${root}";
    ledger_canister_id = opt principal "${ledger}";
    swap_canister_id = opt principal "${swap}";
    id_to_nervous_system_functions = vec {};
    metrics = null;
    maturity_modulation = null;
    mode = 1 : int32;
    parameters = opt record {
      default_followees = opt record { followees = vec {} };
      max_dissolve_delay_seconds = opt 252_460_800;
      max_dissolve_delay_bonus_percentage = opt 100;
      max_followees_per_function = opt 15;
      neuron_claimer_permissions = opt record { permissions = vec { 2; 3; 4 } };
      neuron_minimum_stake_e8s = opt 100_000_000;
      max_neuron_age_for_age_bonus = opt 126_230_400;
      initial_voting_period_seconds = opt 345_600;
      neuron_minimum_dissolve_delay_to_vote_seconds = opt 15_778_800;
      reject_cost_e8s = opt 100_000_000;
      max_proposals_to_keep_per_action = opt 100;
      wait_for_quiet_deadline_increase_seconds = opt 86_400;
      max_number_of_neurons = opt 200_000;
      transaction_fee_e8s = opt 10_000;
      max_number_of_proposals_with_ballots = opt 700;
      max_age_bonus_percentage = opt 25;
      neuron_grantable_permissions = opt record { permissions = vec {} };
      voting_rewards_parameters = opt record {
        final_reward_rate_basis_points = opt 0;
        initial_reward_rate_basis_points = opt 0;
        reward_rate_transition_duration_seconds = opt 0;
        round_duration_seconds = opt 86_400;
      };
      maturity_modulation_disabled = opt true;
      max_number_of_principals_per_neuron = opt 5;
      automatically_advance_target_version = opt false;
      custom_proposal_criticality = null;
    };
    is_finalizing_disburse_maturity = null;
    deployed_version = null;
    cached_upgrade_steps = null;
    sns_initialization_parameters = "";
    latest_reward_event = null;
    pending_version = null;
    proposals = vec {};
    in_flight_commands = vec {};
    sns_metadata = opt record {
      url = opt "https://example.org";
      logo = null;
      name = opt "Local test DAO";
      description = opt "A test SNS on PocketIC, for the Candid Profile validator test";
    };
    neurons = vec { record { "${NEURON_HEX}"; record {
      id = opt record { id = ${blobText(NEURON)} };
      staked_maturity_e8s_equivalent = null;
      permissions = vec { record { "principal" = opt principal "${USER.toText()}"; permission_type = vec { 1; 2; 3; 4; 5; 6; 7; 8; 9; 10 } } };
      maturity_e8s_equivalent = 0;
      cached_neuron_stake_e8s = 1_000_000_000_000;
      created_timestamp_seconds = 0;
      source_nns_neuron_id = null;
      auto_stake_maturity = null;
      aging_since_timestamp_seconds = 0;
      dissolve_state = opt variant { DissolveDelaySeconds = 31_557_600 };
      voting_power_percentage_multiplier = 100;
      vesting_period_seconds = null;
      disburse_maturity_in_progress = vec {};
      followees = vec {};
      topic_followees = null;
      latest_reward_event_participation = null;
      neuron_fees_e8s = 0;
    } } };
    genesis_timestamp_seconds = 0;
    target_version = null;
    timers = null;
    upgrade_journal = null;
  })`;
}

async function makeProposal(title, actionText) {
  const arg = encodeArgs(
    "manage_neuron",
    `(record { subaccount = ${blobText(NEURON)}; command = opt variant { MakeProposal = record {
      url = ""; title = ${textLit(title)}; summary = "Local test proposal."; action = opt variant { ${actionText} } } } })`,
  );
  const reply = decode(ManageNeuronResponse, await pic.updateCall({ canisterId: governance, method: "manage_neuron", arg, sender: USER }));
  const c = reply.command[0];
  if ("Error" in c) return { error: c.Error };
  return { id: c.MakeProposal.proposal_id[0].id };
}

async function getProposal(id) {
  const arg = encodeArgs("get_proposal", `(record { proposal_id = opt record { id = ${id} : nat64 } })`);
  const r = decode(GetProposalResponse, await pic.queryCall({ canisterId: governance, method: "get_proposal", arg, sender: USER })).result[0];
  assert.ok("Proposal" in r, show(r));
  return r.Proposal;
}

const targetCalls = async () => decode(Calls, await pic.queryCall({ canisterId: target, method: "calls", arg: NO_ARGS, sender: USER }));

/** Ticks until the proposal has been executed or has failed. */
async function settled(id) {
  for (let i = 0; i < 50; i++) {
    const p = await getProposal(id);
    if (p.executed_timestamp_seconds > 0n || p.failed_timestamp_seconds > 0n) return p;
    await pic.tick();
  }
  throw new Error(`proposal ${id} neither executed nor failed`);
}

before(async () => {
  assert.ok(manifest.pocket_ic.platforms[platformKey()]?.sha256, `no PocketIC pinned for ${platformKey()}`);
  const binPath = await verified(paths.pocketIc, manifest.pocket_ic.platforms[platformKey()].sha256);
  const files = manifest.sns_governance.files;
  const governanceWasm = gunzipSync(readFileSync(await verified(paths.file("sns-governance-canister.wasm.gz"), files["sns-governance-canister.wasm.gz"].sha256)));
  did = readFileSync(await verified(paths.file("sns-governance-canister.wasm.gz.did"), files["sns-governance-canister.wasm.gz.did"].sha256), "utf8");

  server = await PocketIcServer.start({ binPath });
  pic = await PocketIc.create(server.getUrl(), { sns: { state: { type: SubnetStateType.New } }, application: [{ state: { type: SubnetStateType.New } }] });
  const sns = (await pic.getSnsSubnet()).id;
  const app = (await pic.getApplicationSubnets())[0].id;
  const cycles = 100_000_000_000_000n;

  // root, ledger and swap: empty canisters on the SNS subnet; governance only needs their ids for these proposals
  const [root, ledger, swap] = [await pic.createCanister({ targetSubnetId: sns, cycles }), await pic.createCanister({ targetSubnetId: sns, cycles }), await pic.createCanister({ targetSubnetId: sns, cycles })];
  governance = await pic.createCanister({ targetSubnetId: sns, cycles });
  await pic.installCode({ canisterId: governance, wasm: governanceWasm, arg: encodeArgs(null, governanceInit({ root, ledger, swap })), targetSubnetId: sns });

  // USER controls the validator, so it can read the canister log
  validator = await pic.createCanister({ targetSubnetId: app, cycles, sender: USER });
  await pic.installCode({ canisterId: validator, wasm: WASM("sns_validator"), arg: NO_ARGS, targetSubnetId: app, sender: USER });
  target = await pic.createCanister({ targetSubnetId: app, cycles });
  await pic.installCode({ canisterId: target, wasm: WASM("sns_target"), arg: NO_ARGS, targetSubnetId: app });
});

after(async () => {
  await pic?.tearDown();
  await server?.stop();
});

// ----------------------------------------------------------------------------------------------------------- tests

test("the validator previews: a direct query answers every dapp case with the golden reply bytes", async () => {
  for (const g of GOLDENS) {
    const reply = await pic.queryCall({ canisterId: validator, method: `validate_${g.method}`, arg: Buffer.from(g.payload_hex, "hex"), sender: USER });
    const got = decode(ValidatorResult, reply);
    if ("Ok" in g.reply) assert.equal(Buffer.from(reply).toString("hex"), g.reply_hex, g.id);
    else assert.equal(got.Err.split(":")[0], g.reply.Err.split(":")[0], g.id);
  }
});

test("governance adds one generic function per method by proposal, with the example as validator", async () => {
  for (const m of METHODS) {
    const r = await makeProposal(`Add ${m}`, `AddGenericNervousSystemFunction = record {
      id = ${FUNCTION_ID[m]} : nat64; name = ${textLit(m)}; description = opt ${textLit(lureFor(m))};
      function_type = opt variant { GenericNervousSystemFunction = record {
        validator_canister_id = opt principal "${validator.toText()}"; validator_method_name = opt "validate_${m}";
        target_canister_id = opt principal "${target.toText()}"; target_method_name = opt ${textLit(m)};
        topic = opt variant { ${TOPIC} } } } }`);
    assert.ok(r.id !== undefined, `${m}: ${show(r.error)}`);
    const p = await settled(r.id);
    assert.equal(p.failure_reason.length, 0, `${m}: ${show(p.failure_reason)}`);
  }
  const listed = decode(ListFunctionsResponse, await pic.queryCall({ canisterId: governance, method: "list_nervous_system_functions", arg: NO_ARGS, sender: USER }));
  for (const m of METHODS) assert.ok(listed.functions.some((f) => f.id === BigInt(FUNCTION_ID[m]) && f.name === m), m);
});

const executeAction = (g) => `ExecuteGenericNervousSystemFunction = record { function_id = ${FUNCTION_ID[g.method]} : nat64; payload = ${blobText(Buffer.from(g.payload_hex, "hex"))} }`;
const fnDebugFor = (m) => functionDebug({ id: FUNCTION_ID[m], name: m, description: lureFor(m), target: target.toText(), targetMethod: m, validator: validator.toText(), validatorMethod: `validate_${m}`, topic: TOPIC });

for (const g of GOLDENS.filter((x) => "Ok" in x.reply)) {
  test(`governance stores the profile's rendering and executes: ${g.id}`, async () => {
    const payload = Uint8Array.from(Buffer.from(g.payload_hex, "hex"));
    const r = await makeProposal(`Execute ${g.method}`, executeAction(g));
    assert.ok(r.id !== undefined, show(r.error));
    const p = await settled(r.id);
    assert.equal(p.failure_reason.length, 0, show(p.failure_reason));
    const stored = p.payload_text_rendering[0];

    // exactly the layout the package's tests simulate from the governance source, around exactly the golden text
    assert.equal(stored, governanceRendering(fnDebugFor(g.method), payload, g.reply.Ok));
    assert.ok(stored.endsWith(`- Rules: \`${SNS_RENDERING_RULES}\``));
    // the reviewer's check passes on what governance stored, given the payload bytes
    const v = verifySnsRendering({ payloadTextRendering: stored, payload, resolved: RESOLVED, targetCanisterId: target.toText(), method: g.method });
    assert.ok(v.ok, show(v.checks));
    // a reviewer who expects another canister is told governance will call this one
    const elsewhere = verifySnsRendering({ payloadTextRendering: stored, payload, resolved: RESOLVED, targetCanisterId: validator.toText(), method: g.method });
    assert.equal(elsewhere.checks.find((c) => c.name === "target_canister").found, target.toText());
    assert.equal(elsewhere.ok, false);

    // get_proposal returns payloads over 64 bytes only as a summary, the one the package's tests simulate
    const shown = Uint8Array.from(p.proposal[0].action[0].ExecuteGenericNervousSystemFunction.payload);
    assert.deepEqual(shown, proposalPayloadSummary(payload));
    if (payload.length > 64) {
      const s = verifySnsRendering({ payloadTextRendering: stored, payload: shown, resolved: RESOLVED, targetCanisterId: target.toText(), method: g.method });
      assert.equal(s.ok, false);
      assert.match(s.checks.find((c) => c.name === "payload_sha256").note, /summary of a payload over 64 bytes/);
    }

    // the target received the bytes voters were shown, from governance, which kept its reply
    assert.equal(Buffer.from(p.execution_reply[0]).toString("hex"), "4449444c0000");
    const last = (await targetCalls()).at(-1);
    assert.equal(last.method, g.method);
    assert.equal(Principal.fromUint8Array(Uint8Array.from(last.caller)).toText(), governance.toText());
    assert.equal(sha256Hex(Uint8Array.from(last.arg)), sha256Hex(payload));
  });
}

for (const g of GOLDENS.filter((x) => "Err" in x.reply)) {
  test(`governance refuses the proposal with the validator's error: ${g.id}`, async (t) => {
    const callsBefore = (await targetCalls()).length;
    const r = await makeProposal(`Execute ${g.method}`, executeAction(g));
    assert.equal(r.id, undefined, "no proposal is created");
    const code = g.reply.Err.split(":")[0];
    assert.ok(r.error.error_message.includes(`Invalid proposal: ${code}: `), r.error.error_message);
    t.diagnostic(`error_type ${r.error.error_type}: ${r.error.error_message}`);
    assert.equal((await targetCalls()).length, callsBefore, "the target is not called");
  });
}

test("the validator logs the instructions of each call governance made", async (t) => {
  const logs = await pic.fetchCanisterLogs({ canisterId: validator, sender: USER });
  const lines = logs.map((l) => Buffer.from(l.content).toString("utf8"));
  const parsed = lines.map((l) => /^(\w+): payload (\d+) bytes, (\d+) instructions$/.exec(l)).filter(Boolean);
  assert.equal(parsed.length, lines.length, lines.join("\n"));
  assert.equal(parsed.length, GOLDENS.length, "one line per proposal made, none for the direct queries");
  const rows = parsed.map(([, method, size, n]) => ({ method, size: Number(size), instructions: Number(n) }));
  for (const r of rows) assert.ok(r.instructions > 0);
  for (const r of rows) t.diagnostic(`${r.method}: payload ${r.size} bytes, ${r.instructions} instructions`);
});
