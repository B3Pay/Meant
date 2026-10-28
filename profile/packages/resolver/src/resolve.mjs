/**
 * Resolve a service with any number of profiles (spec sections 7, 8 and 10).
 *
 *   explicit profiles     applied as given: canister profiles are checked for binding (rebound/stale), packs must match;
 *   candidate packs       tried by Candid subtyping against `binds.requires`; those that match are applied, the rest
 *                         are reported and left out;
 *   layers                author > third_party > pack > inferred, merged per tag per position (W_OVERRIDDEN, E_CONFLICT).
 *
 * New diagnostic codes introduced here (additive; proposed in docs/proposals/w1-resolved-form-additions.md):
 *   I_PACK_MATCHED, I_PACK_NOT_MATCHED, E_PACK_NOT_MATCHED, I_PACK_ANNOTATION_SKIPPED; and an optional `profile`
 *   field on diagnostics that come from a profile. E_ENVELOPE (an `envelope` input that is not a readable candid-core
 *   ContractEnvelope) is proposed in docs/proposals/w1-envelope-input.md.
 */
import { profileId } from "./util.mjs";
import { compileInterface, interfaceFromEnvelope } from "./compile.mjs";
import { analyzeProfiles } from "./analyze.mjs";
import { matchPack } from "./pack-match.mjs";
import { resolvedForm } from "./resolved.mjs";
import { schemaDiagnostics } from "./schema-core.mjs";

const describeReasons = (reasons) => {
  const shown = reasons.slice(0, 3).map((r) => `${r.at}: ${r.message}`).join("; ");
  return reasons.length > 3 ? `${shown}; and ${reasons.length - 3} more` : shown;
};

/**
 * @param opts.did           Candid source of the service, compiled here; or
 * @param opts.envelope      the service's candid-core ContractEnvelope, already compiled (exactly one of the two)
 * @param opts.didLabel      how E_CANDID (or E_ENVELOPE) names the input
 * @param opts.profiles      [{ doc, label? }] explicit profiles, applied or rejected
 * @param opts.packs         [{ doc, label? }] candidate packs, applied only if they match
 * @param opts.validateSchema from createSchemaValidator()
 * @returns { ok, resolved, diagnostics, profiles }  `resolved` is null when the service does not compile (or the
 *          envelope cannot be read).
 *          `profiles[i]` = { name, origin, kind, profile_id, status, explicit } with status one of
 *          applied | rebound | stale | not_matched | invalid.
 */
export async function resolveService(opts) {
  const fromEnvelope = opts.envelope !== undefined;
  if (fromEnvelope === (opts.did !== undefined)) throw new TypeError("resolveService: give exactly one of `did` and `envelope`");
  if (!fromEnvelope) return resolveCompiled(opts, false);
  // interfaceFromEnvelope checks the graph before anything walks it; anything it still misses in someone else's
  // document is reported against the envelope rather than thrown.
  try {
    return await resolveCompiled(opts, true);
  } catch (e) {
    const at = opts.didLabel ?? "envelope";
    return { ok: false, resolved: null, diagnostics: [{ severity: "error", code: "E_ENVELOPE", at, message: `the envelope's graph could not be resolved: ${e?.message ?? e}` }], profiles: [] };
  }
}

async function resolveCompiled(opts, fromEnvelope) {
  const diagnostics = [];
  const statuses = [];
  const compiled = fromEnvelope ? interfaceFromEnvelope(opts.envelope, "canister") : await compileInterface(opts.did, "canister");
  if (compiled.failure) {
    const [code, at] = fromEnvelope ? ["E_ENVELOPE", opts.didLabel ?? "envelope"] : ["E_CANDID", opts.didLabel ?? "service.did"];
    for (const d of compiled.failure) diagnostics.push({ severity: "error", code, at, message: `${d.code}: ${d.message}` });
    return { ok: false, resolved: null, diagnostics, profiles: statuses };
  }
  const { iface } = compiled;

  const candidates = [
    ...(opts.profiles ?? []).map((p, i) => ({ ...p, explicit: true, label: p.label ?? `profile #${i + 1}` })),
    ...(opts.packs ?? []).map((p, i) => ({ ...p, explicit: false, label: p.label ?? `pack #${i + 1}` })),
  ];
  const items = [];
  const taken = new Set();
  for (const c of candidates) {
    const name = c.doc?.name ?? c.label;
    const note = (severity, code, at, message) => diagnostics.push({ severity, code, at, message, profile: name });
    if (!opts.validateSchema(c.doc)) {
      for (const d of schemaDiagnostics(opts.validateSchema)) diagnostics.push({ ...d, profile: name });
      statuses.push({ name, origin: c.doc?.origin ?? null, kind: c.doc?.kind ?? null, profile_id: null, status: "invalid", explicit: c.explicit });
      continue;
    }
    const doc = c.doc;
    const pid = profileId(doc);
    if (taken.has(pid)) continue; // the same document given twice (for example explicitly and through the pack search)
    const status = { name: doc.name, origin: doc.origin, kind: doc.kind, profile_id: pid, status: "applied", explicit: c.explicit };
    if (doc.kind === "pack") {
      const m = await matchPack(iface, doc);
      if (m.error) {
        for (const d of m.error) note("error", "E_CANDID", "binds.requires", `${d.code}: ${d.message}`);
        statuses.push({ ...status, status: "invalid" });
        continue;
      }
      if (!m.matched) {
        const why = describeReasons(m.reasons);
        if (c.explicit) note("error", "E_PACK_NOT_MATCHED", doc.name, `the service is not a subtype of the pack's binds.requires: ${why}`);
        else note("info", "I_PACK_NOT_MATCHED", doc.name, `pack does not apply: ${why}`);
        statuses.push({ ...status, status: "not_matched" });
        continue;
      }
      const wider = m.relaxed.map((r) => `${r.at} has extra cases ${r.cases.join(", ")}`);
      note("info", "I_PACK_MATCHED", doc.name, `the service is a subtype of the pack's binds.requires${wider.length ? ` (result variants wider than the pack, D-019: ${wider.join("; ")})` : ""}`);
      items.push({ doc, pid, rebinding: false, apply: true, status });
    } else {
      items.push({ doc, pid, rebinding: doc.binds.interface_id !== iface.interfaceId, apply: false, status });
    }
    taken.add(pid);
  }

  const analysis = analyzeProfiles(iface, items, { attribute: true });
  diagnostics.push(...analysis.diagnostics);
  for (const item of analysis.ordered) {
    item.status.status = analysis.stale.has(item) ? "stale" : item.rebinding ? "rebound" : "applied";
  }
  // Report profiles in precedence order, then the ones that were left out.
  const applied = analysis.ordered.map((i) => i.status);
  const left = statuses.splice(0);
  const resolved = resolvedForm(iface, analysis.ordered, analysis.layered, diagnostics);
  return { ok: !diagnostics.some((d) => d.severity === "error"), resolved, diagnostics, profiles: [...applied, ...left] };
}
