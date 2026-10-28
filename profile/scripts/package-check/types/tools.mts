// @meantjs/tools as a TypeScript consumer uses it: tools over a resolved form, with a scripted ledger.
import { createSchemaValidator, loadPacks, resolveService } from "@meantjs/profile";
import { createToolLayer, readToolInput, buildToolPlans, toolDefinitions, type CallResult, type JsonSchemaInput, type Preview, type ResolvedForm, type ToolDefinition } from "@meantjs/tools";
import { LEDGER_DID, check } from "./check.mts";

const r = await resolveService({ did: LEDGER_DID, validateSchema: await createSchemaValidator(), packs: (await loadPacks()).map(({ doc }) => ({ doc })) });
check(r.resolved !== null, "resolved");
const refs = { "query:icrc1_decimals": 8, "query:icrc1_symbol": "TKA" };
const canisters = [{ id: "ryjl3-tyaaa-aaaaa-aaaba-cai", label: "TKA", refs }];
const tools: ToolDefinition[] = toolDefinitions([r.resolved], { canisters });
check(tools.some((t) => t.name === "prepare_icrc1_transfer"), "a prepare tool");

const plan = buildToolPlans([r.resolved]).plans.get("prepare_icrc1_transfer");
check(plan !== undefined, "the plan");
const replicated: boolean = plan.replicated; // a read sent as an update call (D-038)
check(!replicated && plan.argNodes.length === 1, "an update with one argument");
const read = readToolInput(plan, { to: canisters[0].id, amount: "0.29 TKA" }, { refs });
check("value" in read, "read");

const seen: Preview[] = [];
const tuples: unknown[][] = [];
const layer = createToolLayer({
  resolved: [r.resolved],
  canisters,
  // `args` is the whole argument tuple, what candid-core's encodeArgs takes
  encode: (_method: string, _value: unknown, args: unknown[]) => (tuples.push(args), new Uint8Array([0x44, 0x49, 0x44, 0x4c])),
  // The reply is the decoded first result in candid-core's domain shape: a variant is { tag, value }.
  call: async ({ mode, args }): Promise<CallResult> => (check(mode === "update" && args.length === 1, "an update call with the tuple"), { status: "replied", reply: { tag: "Ok", value: 7n } }),
  now: async () => 1791547200000000000n,
  confirm: async (preview) => (seen.push(preview), true),
});
const prepared = await layer.callTool("prepare_icrc1_transfer", { canister_id: canisters[0].id, to: canisters[0].id, amount: "0.29 TKA" });
check(prepared.structuredContent.status === "prepared" && prepared.structuredContent.preview !== undefined, "prepared");
const previewId: string = prepared.structuredContent.preview.preview_id;
const committed = await layer.callTool("commit", { preview_id: previewId });
check(committed.structuredContent.outcome === "success" && seen.length === 1, "committed after one confirmation");
check(tuples.length === 1 && tuples[0].length === 1, "encoded once, as a one-argument tuple");

// A record, variant or vec input is one JSON input (D-050), and its schema is typed as such, not as a string.
const tag = (args: unknown) => ({ args, origin: "author", profile: "test" });
const settings: ResolvedForm = {
  format: "candid-profile-resolved",
  format_version: 0,
  methods: {
    set: {
      mode: "update",
      args: [{ candid: "record", fields: { mode: { candid: "variant", cases: { Off: { candid: "null" }, On: { candid: "text" } } }, ids: { candid: "vec", element: { candid: "text", optional: true } } } }],
      results: [{ candid: "variant", cases: { Ok: { candid: "null" }, Err: { candid: "text" } } }],
      tags: { intent: tag({ title: "Change settings", template: "Change settings" }), effect: tag({ kind: "write", irreversible: false }), outcome: tag({ classes: { Ok: "success" }, default: "fail" }) },
    },
  },
};
const shape = (s: JsonSchemaInput): string => {
  if ("oneOf" in s) return `variant(${s.oneOf.map((c) => c.properties.tag.const + (c.properties.value ? `:${shape(c.properties.value)}` : "")).join("|")})`;
  if (s.type === "object") return `record(${Object.entries(s.properties).map(([k, v]) => `${k}:${shape(v)}`).join(",")})`;
  if (s.type === "array") {
    const items = s.items;
    if ("anyOf" in items) return `vec opt ${shape(items.anyOf[0])}`;
    return `vec ${"oneOf" in items || items.type !== "null" ? shape(items) : "null"}`;
  }
  return s.type;
};
const set = toolDefinitions([settings], { canisters }).find((t) => t.name === "prepare_set");
check(set !== undefined, "a prepare tool for a method with JSON inputs");
const { canister_id, ...inputs } = set.inputSchema.properties;
// a property of a tool's input schema may itself be a record's schema (this line fails to compile if it is typed as a string)
const asRecord: ToolDefinition["inputSchema"]["properties"][string] = { type: "object", description: "", properties: inputs, required: [], additionalProperties: false };
check("type" in canister_id && canister_id.type === "string" && shape(asRecord) === "record(mode:variant(Off|On:string),ids:vec opt string)", "JSON inputs are typed by shape");
