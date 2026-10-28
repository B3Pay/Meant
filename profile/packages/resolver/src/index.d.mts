// Types for @meantjs/profile (the Node entry). Hand-written; the source is plain ES modules (src/*.mjs). The
// declarations it shares with the browser entry live in browser.d.mts. test/types.test.mjs keeps the declared names
// equal to the runtime exports, and `npm run types` compiles a consumer against them under strict TypeScript.
import type { Pack, SchemaValidator } from "./browser.mjs";

export type {
  Address,
  ContractNode,
  Diagnostic,
  DocDiagnostic,
  Pack,
  PathSegment,
  Position,
  ProfileDocument,
  ProfileStatus,
  ResolveOptions,
  ResolveResult,
  ResolvedForm,
  SchemaValidator,
  ValidateResult,
} from "./browser.mjs";
export {
  DOC_ATTRIBUTES_VERSION,
  Iface,
  LAYERS,
  LayeredTags,
  SubtypeChecker,
  TagIndex,
  analyzeProfiles,
  buildTree,
  compileInterface,
  idlHash,
  interfaceFromEnvelope,
  jcs,
  matchPack,
  matchService,
  parseAddress,
  parseRelPath,
  positions,
  profileFromDocAttributes,
  profileId,
  readServedProfile,
  resolveService,
  resolvedForm,
  SERVED_MAX_BYTES,
  SERVED_METADATA,
  SERVED_SECTION,
  typeSubtype,
  validateProfile,
} from "./browser.mjs";

/** The schema this package ships (a copy of the repository's spec/profile-v0.schema.json). */
export const DEFAULT_SCHEMA_PATH: string;
/** The directory of the standard packs this package ships (copies of the repository's packs/). */
export const DEFAULT_PACKS_DIR: string;

/**
 * The validate function for the profile schema. The shipped schema (the default, or a file or document equal to it) is
 * compiled ahead of time; any other schema is compiled by ajv at run time, with `new Function`.
 *
 * @param schema a path to a schema file, or the schema document (default: the schema this package ships)
 */
export function createSchemaValidator(schema?: string | Record<string, unknown>): Promise<SchemaValidator>;
/** Every `*.profile.json` of kind "pack" in a directory, sorted by file name (default: the packs this package ships). */
export function loadPacks(dir?: string): Promise<Pack[]>;

/** `candid-profile` as a function: the exit code (0 no error, 1 an error diagnostic, 2 usage or I/O). */
export function runCli(argv: string[], io: { stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown } }): Promise<0 | 1 | 2>;
/** The CLI's help text. */
export const USAGE: string;
