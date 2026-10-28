/**
 * Single-profile validation: the behavior of the original scripts/validate.mjs, as a library call.
 * A pack is checked against its own `binds.requires` fragment; a canister profile against the given interface.
 */
import { profileId } from "./util.mjs";
import { compileInterface } from "./compile.mjs";
import { abiInterface, checkDeployments } from "./abi-iface.mjs";
import { analyzeProfiles } from "./analyze.mjs";
import { resolvedForm } from "./resolved.mjs";
import { schemaDiagnostics } from "./schema-core.mjs";

/**
 * @param doc            the parsed profile
 * @param opts.validateSchema  from createSchemaValidator()
 * @param opts.did       Candid source text of the interface (canister profiles; packs use binds.requires)
 * @param opts.didLabel  how E_CANDID names the .did (a path)
 * @param opts.resolved  also return the resolved form
 * @returns { ok, profile_id?, interface_id?, methods?, annotations?, diagnostics, resolved? }
 */
export async function validateProfile(doc, opts) {
  const diagnostics = [];
  const diag = (severity, code, at, message) => diagnostics.push({ severity, code, at, message });

  if (!opts.validateSchema(doc)) {
    diagnostics.push(...schemaDiagnostics(opts.validateSchema));
    return { ok: false, diagnostics };
  }
  const pid = profileId(doc);

  // An EVM contract profile or pack carries its own ABI (spec section 15): it is checked against that.
  if (doc.kind === "contract" || (doc.kind === "pack" && doc.binds.abi !== undefined)) {
    const compiled = abiInterface(doc.binds.abi, "binds.abi");
    if (compiled.failure) {
      for (const d of compiled.failure) diag("error", "E_ABI", d.at, d.message);
      return { ok: false, profile_id: pid, diagnostics };
    }
    if (doc.kind === "contract") checkDeployments(doc, diag);
    return finish(doc, pid, compiled.iface, false, diagnostics, opts);
  }

  let didSource;
  if (doc.kind === "pack") didSource = doc.binds.requires;
  else if (opts.did !== undefined && opts.did !== null) didSource = opts.did;
  else {
    diag("warning", "W_NO_INTERFACE", "", "canister profile without --did: semantic checks skipped");
    return { ok: true, profile_id: pid, diagnostics };
  }
  const compiled = await compileInterface(didSource);
  if (compiled.failure) {
    for (const d of compiled.failure) diag("error", "E_CANDID", doc.kind === "pack" ? "binds.requires" : opts.didLabel, `${d.code}: ${d.message}`);
    return { ok: false, profile_id: pid, diagnostics };
  }
  const { iface } = compiled;
  const rebinding = doc.kind === "canister" && doc.binds.interface_id !== iface.interfaceId;
  return finish(doc, pid, iface, rebinding, diagnostics, opts);
}

function finish(doc, pid, iface, rebinding, earlier, opts) {
  const analysis = analyzeProfiles(iface, [{ doc, pid, rebinding, apply: false }], { attribute: false });
  const diagnostics = [...earlier, ...analysis.diagnostics];
  const ok = !diagnostics.some((d) => d.severity === "error");
  const result = { ok, profile_id: pid, interface_id: iface.interfaceId, methods: iface.methods.size, annotations: doc.annotations.length, diagnostics };
  if (opts.resolved) result.resolved = resolvedForm(iface, [{ doc, pid }], analysis.layered, diagnostics);
  return result;
}
