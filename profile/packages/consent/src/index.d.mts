// Types for @meantjs/consent. Hand-written; the source is plain ES modules (src/*.mjs).
// test/types.test.mjs keeps the declared names equal to the runtime exports, and `npm run types` compiles a consumer
// against these declarations under strict TypeScript.
import type { Formatter } from "@meantjs/format";

/** A candid-profile-resolved v0 document (docs/profile-v0.md section 10). */
export interface ResolvedForm {
  format: "candid-profile-resolved";
  format_version: 0;
  methods: Record<string, unknown>;
  [key: string]: unknown;
}

/** Argument bytes as this package takes them. */
export type Bytes = Uint8Array | ArrayBuffer | readonly number[];

export interface DecodeLimits {
  maxBytes?: number;
  maxDepth?: number;
  maxElements?: number;
}

// ------------------------------------------------------------------ the ICRC-21 shapes (ICRC-21.did, JS shape)
// A variant is { Tag: payload }, opt T is null or the value, nat and nat64 are bigint, nat8 and int16 numbers.

export interface Icrc21Metadata {
  language: string;
  utc_offset_minutes: number | null;
}
export type Icrc21DeviceSpec = { GenericDisplay: null } | { FieldsDisplay: null };
export interface Icrc21ConsentMessageSpec {
  metadata: Icrc21Metadata;
  device_spec: Icrc21DeviceSpec | null;
}
export interface Icrc21ConsentMessageRequest {
  method: string;
  arg: Uint8Array;
  user_preferences: Icrc21ConsentMessageSpec;
}
export type Icrc21Value =
  | { TokenAmount: { decimals: number; amount: bigint; symbol: string } }
  | { TimestampSeconds: { amount: bigint } }
  | { DurationSeconds: { amount: bigint } }
  | { Text: { content: string } };
export type Icrc21ConsentMessage =
  | { GenericDisplayMessage: string }
  | { FieldsDisplayMessage: { intent: string; fields: [string, Icrc21Value][] } };
export interface Icrc21ConsentInfo {
  consent_message: Icrc21ConsentMessage;
  metadata: Icrc21Metadata;
}
export type Icrc21Error =
  | { UnsupportedCanisterCall: { description: string } }
  | { ConsentMessageUnavailable: { description: string } }
  | { InsufficientPayment: { description: string } }
  | { GenericError: { error_code: bigint; description: string } };
export type Icrc21ConsentMessageResponse = { Ok: Icrc21ConsentInfo } | { Err: Icrc21Error };

/** Where the words of a message come from (ICRC-49: a signer warns when a profile, not the canister, wrote them). */
export interface Provenance {
  intent: { origin: string; profile?: string } | null;
  profiles: unknown[];
}
export interface ConsentDiagnostic {
  code: string;
  at: string;
  message: string;
  [key: string]: unknown;
}

export interface Icrc21Context {
  resolved: ResolvedForm;
  /** Resolved dynamic refs, keyed by `from`: `{ "query:icrc1_decimals": 8, "query:icrc1_symbol": "ICP" }`. */
  refs?: Record<string, unknown>;
  /** Default "fallback" (the ICRC-21 preference). */
  languagePolicy?: "fallback" | "error";
  /** Append the decoded raw arguments (spec section 11 item 1). */
  rawArguments?: boolean;
  limits?: DecodeLimits;
}

/** The response, with two non-enumerable properties: what was adjusted, and where the words come from. */
export type Icrc21Result = Icrc21ConsentMessageResponse & { readonly diagnostics: ConsentDiagnostic[]; readonly provenance: Provenance };

/** The ICRC-21 call as a function. `arg` may also be an ArrayBuffer or an array of byte values. */
export function icrc21ConsentMessage(request: Omit<Icrc21ConsentMessageRequest, "arg"> & { arg: Bytes }, context: Icrc21Context): Icrc21Result;
/** Candid bytes of `icrc21_consent_message_request` in, Candid bytes of `icrc21_consent_message_response` out. */
export function handleConsentRequest(requestBytes: Uint8Array, context: Icrc21Context): Uint8Array;
/** A ConsentError (or any thrown value) as the ICRC-21 error variant. */
export function toIcrc21Error(error: unknown): Icrc21Error;
/** The only language v0 emits. */
export const SUPPORTED_LANGUAGE: "en";

export function encodeConsentResponse(response: Icrc21ConsentMessageResponse): Uint8Array;
export function decodeConsentResponse(bytes: Uint8Array): Icrc21ConsentMessageResponse;
export function encodeConsentRequest(request: Icrc21ConsentMessageRequest): Uint8Array;
/** Throws E_REQUEST on bytes that are not a request. */
export function decodeConsentRequest(bytes: Uint8Array): Icrc21ConsentMessageRequest;
/** A JSON-safe copy: bigint as a decimal string, Uint8Array as `{ hex }`. */
export function toJson(value: unknown): unknown;

// ------------------------------------------------------------------ one form, and the parts

export interface ModelField {
  /** The placeholder path, or the dotted path of a flattened leaf. */
  path: string;
  /** `describe.label` of the position, else its field name (raw, not yet escaped). */
  label: string;
  node: unknown;
  /** The present values: none (absent), one, or one per list element. */
  values: unknown[];
}
export type SentencePart = { lit: string } | { field: ModelField };
export interface Model {
  method: string;
  /** The method's effect kind (spec section 5.3). */
  effect: string;
  title: string;
  /** null for a method without an intent template. */
  sentence: SentencePart[] | null;
  fields: ModelField[];
  argNodes: unknown[];
  argValues: unknown[];
  diagnostics: ConsentDiagnostic[];
  provenance: Provenance;
  [key: string]: unknown;
}

export interface GenerateConsentInput {
  resolved: ResolvedForm;
  method: string;
  /** The Candid-encoded argument tuple. */
  arg: Bytes;
  refs?: Record<string, unknown>;
  /** Default "generic". */
  form?: "fields" | "generic";
  /** Generic form only: show timestamps in this zone (default UTC). */
  utcOffsetMinutes?: number | null;
  rawArguments?: boolean;
  limits?: DecodeLimits;
}
/** One form without the ICRC-21 envelope. `zoneSensitive` is true when a timestamp was shown in the requested zone. */
export function generateConsent(input: GenerateConsentInput): {
  form: "fields" | "generic";
  message: Icrc21ConsentMessage;
  zoneSensitive: boolean;
  diagnostics: ConsentDiagnostic[];
  provenance: Provenance;
  model: Model;
};
export function buildModel(input: { resolved: ResolvedForm; method: string; arg: Bytes; limits?: DecodeLimits }): Model;
/** Argument bytes to one value tree per argument. Throws E_DECODE, E_TOO_LARGE, E_UNSUPPORTED_TYPE or E_RESOLVED_FORM. */
export function decodeArguments(method: { args: unknown[] }, arg: Bytes, limits?: DecodeLimits): unknown[];
/** The candid-core codec schema of one resolved-form position. */
export function schemaFor(node: unknown, where?: string, depth?: number): unknown;

export type TemplateLiteralPart = { t: "lit"; text: string } | { t: "ph"; path: string };
export type TemplatePart = TemplateLiteralPart | { t: "opt"; parts: TemplateLiteralPart[] };
/** Throws E_TEMPLATE. */
export function parseTemplate(template: string): TemplatePart[];

export type PathStep = { kind: "field" | "case"; key: string } | { kind: "elem" };
export interface ResolvedPath {
  index: number;
  steps: PathStep[];
  node: unknown;
  nodes: unknown[];
}
export function resolvePath(method: { args: unknown[] }, relpath: string): ResolvedPath | { error: string };
/** The present values at a resolved path. */
export function valuesAt(path: ResolvedPath, values: unknown[]): unknown[];

/** Renders positions as text, with a budget per message. Used by `renderFields` and `renderGeneric`. */
export declare class Renderer {
  /** `utcOffsetMinutes` as a number shows timestamps in that zone (the generic form); otherwise UTC. */
  constructor(options?: { refs?: Record<string, unknown>; utcOffsetMinutes?: number | null; diagnostics?: ConsentDiagnostic[] });
  refs: Record<string, unknown>;
  utcOffsetMinutes: number | null;
  diagnostics: ConsentDiagnostic[];
  chars: number;
  /** Set when a timestamp was shown in the requested zone. */
  usedZone: boolean;
  formatter(node: unknown): Formatter | null;
  charge(text: string): string;
  text(node: unknown, value: unknown, where?: string): string;
  tupleText(nodes: unknown[], values: unknown[]): string;
  plainTupleText(nodes: unknown[], values: unknown[]): string;
}
/** `UTC`, `UTC+02:00`, `UTC-05:30`. */
export function zoneName(offsetMinutes: number): string;
export function renderFields(model: Model, renderer: Renderer, options?: { rawArguments?: boolean }): { intent: string; fields: [string, Icrc21Value][] };
/** `headingLevel`: the title's heading level (default 1). */
export function renderGeneric(model: Model, renderer: Renderer, options?: { rawArguments?: boolean; headingLevel?: number }): string;

/** A Markdown code span that shows the string verbatim (invisible characters made visible). */
export function codeSpan(s: string): string;
export function escapeMarkdown(s: string): string;
/** Invisible characters shown as `\u{202e}`; nothing is dropped. */
export function visible(s: string): string;

// ------------------------------------------------------------------ errors

export const CODES: Readonly<{
  METHOD_UNKNOWN: "E_METHOD_UNKNOWN";
  DECODE: "E_DECODE";
  TOO_LARGE: "E_TOO_LARGE";
  LANGUAGE: "E_LANGUAGE";
  REQUEST: "E_REQUEST";
  UNSUPPORTED_TYPE: "E_UNSUPPORTED_TYPE";
  RESOLVED_FORM: "E_RESOLVED_FORM";
  TEMPLATE: "E_TEMPLATE";
  TEMPLATE_PATH: "E_TEMPLATE_PATH";
  REF_UNRESOLVED: "E_REF_UNRESOLVED";
  ARG: "E_ARG";
  TAG_TYPE: "E_TAG_TYPE";
  TAG_CONFLICT: "E_TAG_CONFLICT";
}>;
export type ConsentErrorCode = (typeof CODES)[keyof typeof CODES];
/** ICRC-21 `GenericError.error_code` values this package uses. */
export const GENERIC_ERROR_CODES: Readonly<{
  E_RESOLVED_FORM: 1000n;
  E_TEMPLATE: 1001n;
  E_TEMPLATE_PATH: 1002n;
  E_REF_UNRESOLVED: 1100n;
  E_ARG: 1101n;
  E_TAG_TYPE: 1102n;
  E_TAG_CONFLICT: 1103n;
  INTERNAL: 1999n;
}>;
export declare class ConsentError extends Error {
  constructor(code: ConsentErrorCode, message: string, options?: { cause?: unknown });
  name: "ConsentError";
  code: ConsentErrorCode;
}
