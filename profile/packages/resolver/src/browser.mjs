/**
 * `@meantjs/profile/browser`: the resolver without Node built-ins, for a browser bundle. The same functions as
 * the main entry, except the ones that read files (`loadPacks`, the CLI, the default paths): the schema and the
 * standard packs come in as the data this package ships, and `createSchemaValidator` takes a document, never a
 * path. The Candid compiler is the `@candid-core/cli` wasm; it initializes itself on first use (fetched next to the
 * module), or call `initCompiler(urlOrBytes)` first when a bundler moves the wasm file.
 *
 * test/browser-entry.test.mjs keeps the module graph free of node:* imports and checks the data against data/.
 */
import schema from "../data/profile-v0.schema.json" with { type: "json" };
import icrc1 from "../data/packs/icrc1.profile.json" with { type: "json" };
import icrc2 from "../data/packs/icrc2.profile.json" with { type: "json" };
import erc20 from "../data/packs/erc20.profile.json" with { type: "json" };
import erc2612 from "../data/packs/erc2612.profile.json" with { type: "json" };
import { compileSchema } from "./schema-core.mjs";

export { init as initCompiler } from "@candid-core/cli";
export { idlHash, jcs, profileId } from "./util.mjs";
export { parseAddress, parseRelPath } from "./address.mjs";
export { Iface } from "./iface.mjs";
export { TagIndex, LayeredTags, positions } from "./tags.mjs";
export { schemaDiagnostics } from "./schema-core.mjs";
export { compileInterface, interfaceFromEnvelope } from "./compile.mjs";
export { validateProfile } from "./validate.mjs";
export { resolveService } from "./resolve.mjs";
export { matchPack } from "./pack-match.mjs";
export { matchService, typeSubtype, SubtypeChecker } from "./subtype.mjs";
export { analyzeProfiles, LAYERS } from "./analyze.mjs";
export { resolvedForm, buildTree } from "./resolved.mjs";
export { profileFromDocAttributes, DOC_ATTRIBUTES_VERSION } from "./doc-annotations.mjs";
export { readServedProfile, SERVED_SECTION, SERVED_METADATA, SERVED_MAX_BYTES } from "./served.mjs";

/** The profile schema (a copy of spec/profile-v0.schema.json). */
export const PROFILE_SCHEMA = schema;

/**
 * The standard packs (copies of packs/*.profile.json whose kind is "pack"), sorted by file name, in the shape
 * `loadPacks` returns. The standard contract profiles there (Permit2, DAI's permit, USDC, x402's Permit2 payment) are
 * under `./packs/*` too.
 */
export const STANDARD_PACKS = Object.freeze([
  { file: "erc20.profile.json", doc: erc20 },
  { file: "erc2612.profile.json", doc: erc2612 },
  { file: "icrc1.profile.json", doc: icrc1 },
  { file: "icrc2.profile.json", doc: icrc2 },
]);

/**
 * The validate function for the profile schema. The schema this package ships (the default, or any document equal to
 * it) is compiled ahead of time and generates no code at run time, so it needs no 'unsafe-eval' in a page's
 * Content-Security-Policy. Any other document is compiled by ajv with `new Function`, which does.
 *
 * @param doc the schema document (default: the copy this package ships)
 */
export async function createSchemaValidator(doc = schema) {
  if (typeof doc === "string") throw new TypeError("createSchemaValidator: the browser entry takes the schema document, not a path");
  return compileSchema(doc);
}
