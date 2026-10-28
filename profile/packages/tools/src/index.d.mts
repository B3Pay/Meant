// Types for @meantjs/tools. Hand-written; the source is plain ES modules (src/*.mjs).

import type { NameEntry } from "@meantjs/format";

/** A candid-profile-resolved v0 document (docs/profile-v0.md section 10). */
export interface ResolvedForm {
  format: "candid-profile-resolved";
  format_version: 0;
  methods: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Canister {
  /** Principal text of the canister. */
  id: string;
  /** A short name for people and models, such as the token's symbol. */
  label?: string;
  /** The canister's dynamic tag values, keyed by their `from`: `{ "query:icrc1_decimals": 8 }`. */
  refs?: Record<string, unknown>;
}

export interface JsonSchemaString {
  type: "string";
  description: string;
  enum?: string[];
  pattern?: string;
}

/** The schema of one input: text read by its own rules, or the JSON shape of a record, variant or vec (D-050). */
export type JsonSchemaInput = JsonSchemaString | JsonSchemaObject | JsonSchemaVariant | JsonSchemaArray;

/** A record: one property per field that is an input. */
export interface JsonSchemaObject {
  type: "object";
  description: string;
  properties: Record<string, JsonSchemaInput>;
  required: string[];
  additionalProperties: false;
}

/** A variant: one `{ tag, value }` object per case; a case without a value has `tag` alone. */
export interface JsonSchemaVariant {
  oneOf: JsonSchemaCase[];
  description: string;
}

export interface JsonSchemaCase {
  type: "object";
  properties: { tag: { const: string }; value?: JsonSchemaInput };
  required: ["tag"] | ["tag", "value"];
  additionalProperties: false;
}

export interface JsonSchemaNull {
  type: "null";
}

/** A vec: an element that is none is a JSON null, so an opt element is its schema or null. */
export interface JsonSchemaArray {
  type: "array";
  description: string;
  items: JsonSchemaInput | JsonSchemaNull | { anyOf: [JsonSchemaInput, JsonSchemaNull] };
  maxItems: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    $schema: string;
    type: "object";
    properties: Record<string, JsonSchemaInput>;
    required: string[];
    additionalProperties: false;
  };
  annotations: { destructiveHint: boolean; openWorldHint: boolean; readOnlyHint: boolean; title: string };
}

export interface ToolParam {
  name: string;
  node: unknown;
  optional: boolean;
  /** `$args[0].amount`, or `$args[0]` for a whole argument (`$args[1]` for the second of several). */
  path: string;
}
// A param whose node is a record, variant or vec with no value tag is one JSON input (D-050): an object, a
// `{ tag, value }` object, or an array, whose leaves are text read by their own rules.

export interface ToolPlan {
  name: string;
  kind: "read" | "prepare";
  method: string;
  /** The method's mode in the resolved form; a read-only update is `"update"` with `kind: "read"`. */
  mode: string;
  /** A read sent as an update call, so that its answer is certified (`effect.replicated`, D-038). */
  replicated: boolean;
  title: string;
  effect: { kind: string; irreversible: boolean; replicated?: boolean };
  /** For a tool per case of the method's variant argument (D-053): the case it sends. */
  case?: string;
  /** The method's arguments, in order. */
  argNodes: unknown[];
  params: ToolParam[];
  /** The argument record's fields, or with more than one argument the arguments (`arg0`, `arg1`, ...). */
  /** `none`: a `null` or `reserved` position, filled with null and never asked for. */
  fields: { name: string; node: unknown; role: "param" | "auto" | "stamp" | "hidden" | "none"; optional: boolean }[];
  [key: string]: unknown;
}

export interface InputIssue {
  param: string;
  path: string;
  /** The format library's codes, plus E_INPUT, E_UNKNOWN_PARAM, E_MISSING and E_TYPE. Inside a JSON input, `path`
   *  names the place (`$args[0].command.Follow.followees[1].id`). */
  code: string;
  message: string;
}

export const COMMIT_TOOL: "commit";
export function prepareToolName(method: string): string;
/** The tool of one case of a method's variant argument (D-053): `<method>_<Case>` for a read, else `prepare_<method>_<Case>`. */
export function caseToolName(method: string, label: string, read: boolean): string;
export function resolvedMethods(resolved: ResolvedForm | ResolvedForm[]): [string, unknown][];
export function buildToolPlans(resolved: ResolvedForm | ResolvedForm[]): { plans: Map<string, ToolPlan>; skipped: { method: string; reason: string }[] };
export function toolDefinitions(resolved: ResolvedForm | ResolvedForm[], options?: { canisters?: Canister[] }): ToolDefinition[];

export function readToolInput(
  plan: ToolPlan,
  input: unknown,
  context?: { refs?: Record<string, unknown>; now?: bigint; names?: Record<string, NameEntry[]> },
): { value: unknown; identity: [string, unknown][] } | { issues: InputIssue[] };
export function toCandid(node: unknown, value: unknown): unknown;
export function displayValue(node: unknown, value: unknown, refs?: Record<string, unknown>, names?: Record<string, NameEntry[]>): unknown;
/** The entries of a names set (spec 5.3, D-045) in a reply of the method that lists it; undefined without the set or a list. */
export function nameEntries(resolved: unknown, set: string, reply: unknown): NameEntry[] | undefined;
export function classifyReply(plan: ToolPlan, reply: unknown): { cls: string; path: string[]; node: unknown; value: unknown };

export type CallResult =
  | { status: "replied"; reply: unknown }
  | { status: "rejected"; reject_code: number; message: string }
  | { status: "unknown"; message: string };

export interface Preview {
  preview_id: string;
  method: string;
  canister: string;
  title: string;
  effect: { kind: string; irreversible: boolean; replicated?: boolean };
  /** The arguments as `displayValue` shows them; an array for a method with more than one. */
  arguments: unknown;
  arg_hex: string;
}

export type ReconcileFinding =
  | { status: "found"; block?: bigint | string }
  | { status: "absent" | "not_yet" }
  | { status: "unreadable"; reason?: string };

export type Outcome =
  | "declined"
  | "success"
  | "already_done"
  | "retry_same"
  | "retry_new"
  | "fix_input"
  | "fail"
  | "not_executed"
  | "unknown"
  | "reconcile";

export interface ToolResult {
  content: { type: "text"; text: string }[];
  /** `preview` is there when a prepare tool answers `prepared` (and when an intent is handed back). */
  structuredContent: { status?: string; outcome?: Outcome; earlier_outcome?: "unknown"; preview?: Preview; [key: string]: unknown };
  isError?: true;
}

export interface ToolLayerConfig {
  resolved: ResolvedForm | ResolvedForm[];
  canisters: Canister[];
  /**
   * The method's arguments, in candid-core domain shapes, to the bytes sent: candid-core's `encodeArgs` of `args`, the
   * whole argument tuple. `value` is the single argument (for a method with more than one, the tuple again).
   */
  encode(method: string, value: unknown, args: unknown[]): Uint8Array | Promise<Uint8Array>;
  /**
   * Sends `arg` exactly, as a query or an update call (`mode`; a read-only update is `"update"`); `reply` is the
   * decoded first result value in candid-core's domain shape (a variant is `{ tag, value }`).
   */
  call(req: { canister: string; method: string; mode: string; arg: Uint8Array; value: unknown; args: unknown[] }): Promise<CallResult>;
  /** The clock of the canister named, ns since the Unix epoch (canisters on different subnets keep different times). */
  now(o: { canister: string }): Promise<bigint>;
  /** Awaited before every send. Required when the form has an update method. */
  confirm?(preview: Preview): Promise<boolean | { approved: boolean }>;
  /** Consumer rule 1: look for the original in the canister's history. */
  reconcile?(o: { canister: string; method: string; value: unknown; stamp: bigint; preview: Preview }): Promise<ReconcileFinding>;
}

export interface ToolLayer {
  listTools(): ToolDefinition[];
  skipped: { method: string; reason: string }[];
  callTool(name: string, input: unknown): Promise<ToolResult>;
}

export function createToolLayer(config: ToolLayerConfig): ToolLayer;
