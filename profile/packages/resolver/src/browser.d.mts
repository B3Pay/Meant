// Types for @meantjs/profile/browser. Hand-written; the source is plain ES modules (src/*.mjs). The internal
// graph classes (Iface, TagIndex, LayeredTags, SubtypeChecker) are declared opaquely.

/** A Candid Profile document (docs/profile-v0.md): a canister profile or a pack. */
export interface ProfileDocument {
  format: "candid-profile";
  format_version: 0;
  kind: "canister" | "pack";
  name: string;
  origin: "author" | "third_party" | "pack" | "inferred";
  annotations: { at: string; tag: string; args?: Record<string, unknown> }[];
  [key: string]: unknown;
}

/** A candid-profile-resolved v0 document (docs/profile-v0.md section 10). */
export interface ResolvedForm {
  format: "candid-profile-resolved";
  format_version: 0;
  interface_id: string;
  profiles: unknown[];
  methods: Record<string, unknown>;
  diagnostics: Diagnostic[];
  [key: string]: unknown;
}

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  /** A JSON pointer for E_SCHEMA, an address (`send(0).to`, `type:Tokens.e8s`) or a document path (`binds.interface_id`). */
  at: string;
  message: string;
  /** The profile's name, when the diagnostic comes from one. */
  profile?: string;
}

export interface ProfileStatus {
  name: string;
  origin: string | null;
  kind: string | null;
  profile_id: string | null;
  status: "applied" | "rebound" | "stale" | "not_matched" | "invalid";
  explicit: boolean;
}

export interface Pack {
  file: string;
  doc: ProfileDocument;
}

/** An Ajv validate function for the profile schema. */
export interface SchemaValidator {
  (doc: unknown): boolean;
  errors?: { instancePath: string; message?: string; params?: Record<string, unknown> }[] | null;
}

export interface ResolveOptions {
  /** Candid source of the service (exactly one of `did` and `envelope`). */
  did?: string;
  /** The service's candid-core ContractEnvelope. */
  envelope?: unknown;
  didLabel?: string;
  /** Applied as given; a pack here must match. */
  profiles?: { doc: unknown; label?: string }[];
  /** Tried by Candid subtyping; applied only if they match. */
  packs?: { doc: unknown; label?: string }[];
  validateSchema: SchemaValidator;
}

export interface ResolveResult {
  ok: boolean;
  /** null when the service does not compile (or the envelope cannot be read). */
  resolved: ResolvedForm | null;
  diagnostics: Diagnostic[];
  profiles: ProfileStatus[];
}

export interface ValidateResult {
  ok: boolean;
  profile_id?: string;
  interface_id?: string;
  methods?: number;
  annotations?: number;
  diagnostics: Diagnostic[];
  resolved?: ResolvedForm;
}

import type { Address, PathSegment } from "./address.mjs";
export type { Address, PathSegment } from "./address.mjs";

/** A node of the candid-core Contract graph (`kind` is primitive, opt, vec, record, variant, func, service, ...). */
export interface ContractNode {
  kind: string;
  primitive?: string;
  inner?: number;
  fields?: { id: number; type: number }[];
  [key: string]: unknown;
}

/** A compiled interface: the Contract graph with the lookups the resolver uses. */
export declare class Iface {
  constructor(envelope: unknown, label?: string);
  label: string;
  /** Method name -> mode and the type refs of its argument and result tuples. */
  methods: Map<string, { mode: string; args: number[]; results: number[] }>;
  /** Declaration name -> type ref. */
  decls: Map<string, number>;
  get interfaceId(): string | null;
  node(ref: number): ContractNode;
  unwrapOpt(ref: number): { ref: number; optional: boolean };
  fieldName(container: number, id: number): string;
  isBlob(ref: number): boolean;
  isAccount(ref: number): boolean;
  /** `nat64`, `opt blob`, `record`, ... */
  describeType(ref: number): string;
}

/** One value position of a method side, as `positions` yields it. */
export interface Position {
  ref: number;
  parent: { container: number; kind: string; id?: number } | null;
  key: string;
  /** The position's address, `send(0).amount.e8s` or `balance->(0)`. */
  display: string;
  /** The walk stopped here (a cycle or the depth bound). */
  cyclic: boolean;
}
export declare class TagIndex {
  [key: string]: unknown;
}
export declare class LayeredTags {
  [key: string]: unknown;
}
export declare class SubtypeChecker {
  [key: string]: unknown;
}

/** The profile schema (a copy of spec/profile-v0.schema.json). */
export const PROFILE_SCHEMA: Record<string, unknown>;
/** The standard packs (copies of packs/*.profile.json), sorted by file name. */
export const STANDARD_PACKS: readonly Pack[];
export const LAYERS: readonly ["author", "third_party", "pack", "inferred"];

/** Initialize the cli's wasm compiler; optional, for a bundler that moves the wasm file. */
export function initCompiler(input?: BufferSource | URL | string | Response): Promise<void>;
/**
 * The validate function for the profile schema. The shipped schema (the default, or a document equal to it) is
 * compiled ahead of time and needs no CSP 'unsafe-eval'; any other document is compiled by ajv with `new Function`.
 */
export function createSchemaValidator(doc?: Record<string, unknown>): Promise<SchemaValidator>;
export function schemaDiagnostics(validateSchema: SchemaValidator): Diagnostic[];
export function resolveService(opts: ResolveOptions): Promise<ResolveResult>;
export function validateProfile(doc: unknown, opts: { validateSchema: SchemaValidator; did?: string | null; didLabel?: string; resolved?: boolean }): Promise<ValidateResult>;

export function idlHash(label: string): number;
/** RFC 8785 (JCS) canonical JSON. */
export function jcs(value: unknown): string;
/** `candid-profile:v0:sha256:<hex>` over the JCS form of the document. */
export function profileId(doc: unknown): string;
export function parseAddress(at: string): Address | null;
export function parseRelPath(rel: string): { index: number | null; segs: PathSegment[] } | null;

export function compileInterface(source: string, label?: string): Promise<{ iface: Iface } | { failure: { code: string; message: string }[] }>;
export function interfaceFromEnvelope(envelope: unknown, label?: string): { iface: Iface } | { failure: { code: string; message: string }[] };
export function matchPack(canister: Iface, pack: unknown, opts?: Record<string, unknown>): Promise<{ matched: boolean; reasons: { at: string; message: string }[]; relaxed: unknown; fragment: Iface } | { error: { code: string; message: string }[] }>;
export function matchService(canister: Iface, fragment: Iface, opts?: Record<string, unknown>): { ok: boolean; reasons: { at: string; message: string }[]; relaxed: unknown };
export function typeSubtype(S: Iface, s: unknown, T: Iface, t: unknown, opts?: Record<string, unknown>): unknown;
export function positions(iface: Iface, methodName: string, side: "args" | "results", maxDepth?: number): Generator<Position>;
export function analyzeProfiles(iface: Iface, items: unknown[], opts?: { attribute?: boolean }): { diagnostics: Diagnostic[]; layered: LayeredTags; ordered: unknown[]; stale: Set<unknown> };
export function resolvedForm(iface: Iface, profiles: unknown[], tags: LayeredTags, diagnostics: Diagnostic[]): ResolvedForm;
export function buildTree(iface: Iface, methodName: string, side: "args" | "results", tags: LayeredTags): unknown;

/** The doc attributes version `profileFromDocAttributes` reads (candid-core `docs/doc-attributes.md`). */
export const DOC_ATTRIBUTES_VERSION: 1;
/** A diagnostic about a doc comment: `at` is the item's address once it has one, else its SourceInfo path. */
export interface DocDiagnostic extends Diagnostic {
  /** The documented item's SourceInfo occurrence path (`actor.methods[2]`, `type:Tokens.fields[0]`). */
  path?: string;
  /** The source file the comment is in, as candid-core names it (`memory:/service.did`). */
  source?: string;
}
/**
 * An author canister profile from the tags written as doc comments in a `.did` (spec section 9). `response` is what
 * `didToDocAttributes(sources)` of `@candid-core/cli` returns; a failed response is passed through as diagnostics.
 * `doc` is null when the comments hold no tag. The profile still goes through `resolveService`, which checks the tags.
 */
export function profileFromDocAttributes(
  response: unknown,
  opts?: { name?: string; origin?: "author" | "third_party"; language?: string; canisterId?: string },
): { ok: boolean; doc: ProfileDocument | null; diagnostics: DocDiagnostic[] };

/** The custom section a canister serves its profile in (spec section 8.1): `"icp:public candid:profile"`. */
export const SERVED_SECTION: "icp:public candid:profile";
/** The metadata name a consumer reads through `read_state`: `/canister/<id>/metadata/candid:profile`. */
export const SERVED_METADATA: "candid:profile";
/** The largest served profile `readServedProfile` reads, in bytes (1 MiB, the platform's custom section limit). */
export const SERVED_MAX_BYTES: number;
/**
 * A profile its canister serves (spec section 8.1), from the bytes of the canister's `candid:profile` metadata. Refused
 * with E_SERVED when the bytes are not UTF-8 JSON of at most 1 MiB, the document is not a `canister` profile of origin
 * `author`, or its `binds.canister_id` names another canister. The profile still goes through `resolveService`, which
 * checks the schema, the binding (against the same canister's `candid:service`) and the tags.
 */
export function readServedProfile(
  bytes: Uint8Array,
  /** `canisterId`: the canister that served it; null only to check a profile before its module is installed. */
  opts: { canisterId: string | null; label?: string },
): { ok: boolean; doc: ProfileDocument | null; diagnostics: Diagnostic[] };

