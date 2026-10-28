/**
 * Pack matching (spec section 7, D-005, D-019): a pack applies to a canister whose service is a subtype of the
 * Candid fragment in `binds.requires`, with result variants allowed to be wider. No file system here; packs.mjs adds
 * reading packs from a directory.
 */
import { compileInterface } from "./compile.mjs";
import { matchService } from "./subtype.mjs";

/**
 * @param canister an Iface (label "canister")
 * @param pack     a parsed, schema-valid pack document
 * @returns { matched, reasons, relaxed } or { error: [candid-core diagnostics] } when `requires` does not compile
 */
export async function matchPack(canister, pack, opts = {}) {
  const compiled = await compileInterface(pack.binds.requires, "pack fragment");
  if (compiled.failure) return { error: compiled.failure };
  const r = matchService(canister, compiled.iface, { resultVariants: "relaxed", lossyOpt: false, ...opts });
  return { matched: r.ok, reasons: r.reasons, relaxed: r.relaxed, fragment: compiled.iface };
}
