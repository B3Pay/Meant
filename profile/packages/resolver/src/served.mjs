/**
 * A profile served by its canister (spec section 8.1, D-048): the public custom section `icp:public candid:profile`,
 * read by a consumer through a certified `read_state` at `/canister/<id>/metadata/candid:profile`.
 *
 * This module reads the section's bytes; it does not fetch them, so the library keeps no agent dependency (the caller
 * does the network part, for example with `@icp-sdk/core`'s `readState`). What it checks is what only a served profile
 * can get wrong: the bytes are UTF-8 JSON of at most 1 MiB, the document is a `canister` profile of origin `author`,
 * and its `binds.canister_id`, when given, is the canister that served it. Everything else (the schema, the binding to
 * the interface the same canister serves as `candid:service`, every tag) is `resolveService`'s, as for any profile.
 *
 * New diagnostic code (spec section 13): E_SERVED.
 */

/** The name of the custom section a canister serves its profile in. */
export const SERVED_SECTION = "icp:public candid:profile";
/** The metadata name a consumer reads: `/canister/<id>/metadata/candid:profile`. */
export const SERVED_METADATA = "candid:profile";
/** The largest served profile read: the platform's limit for all of a canister's custom sections together. */
export const SERVED_MAX_BYTES = 1024 * 1024;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * @param bytes          the content of the canister's `candid:profile` metadata (a Uint8Array)
 * @param opts.canisterId the textual id of the canister that served it; null only before the module is installed
 *                       anywhere (a section added to a built module), which leaves `binds.canister_id` unchecked
 * @param opts.label     how diagnostics name the input (default "candid:profile")
 * @returns { ok, doc, diagnostics }  `doc` is the parsed profile, or null when it cannot be used (E_SERVED)
 */
export function readServedProfile(bytes, opts = {}) {
  const at = opts.label ?? SERVED_METADATA;
  const refuse = (message) => ({ ok: false, doc: null, diagnostics: [{ severity: "error", code: "E_SERVED", at, message }] });
  if (opts.canisterId !== null && (typeof opts.canisterId !== "string" || opts.canisterId === "")) {
    throw new TypeError("readServedProfile: give the serving canister's id as opts.canisterId (null before it is installed)");
  }
  if (!(bytes instanceof Uint8Array)) return refuse("the served profile is not bytes");
  if (bytes.length > SERVED_MAX_BYTES) return refuse(`the served profile is ${bytes.length} bytes, over the ${SERVED_MAX_BYTES} a canister can serve`);
  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    return refuse("the served profile is not UTF-8");
  }
  if (text.startsWith("﻿")) return refuse("the served profile starts with a byte order mark");
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return refuse(`the served profile is not JSON: ${e.message}`);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return refuse("the served profile is not a JSON object");
  if (doc.kind !== "canister") return refuse(`a canister serves a profile of kind "canister", not ${JSON.stringify(doc.kind ?? null)}`);
  if (doc.origin !== "author") return refuse(`a profile its canister serves is the author's: origin "author", not ${JSON.stringify(doc.origin ?? null)}`);
  const bound = doc.binds?.canister_id;
  if (bound !== undefined && opts.canisterId !== null && bound !== opts.canisterId) {
    return refuse(`the served profile is bound to canister ${JSON.stringify(bound)}, but ${opts.canisterId} served it`);
  }
  return { ok: true, doc, diagnostics: [] };
}
