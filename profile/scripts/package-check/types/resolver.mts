// @meantjs/profile (the Node entry) as a TypeScript consumer uses it.
import {
  DEFAULT_PACKS_DIR,
  LAYERS,
  USAGE,
  DOC_ATTRIBUTES_VERSION,
  compileInterface,
  createSchemaValidator,
  loadPacks,
  profileFromDocAttributes,
  profileId,
  readServedProfile,
  resolveService,
  runCli,
  SERVED_MAX_BYTES,
  SERVED_METADATA,
  SERVED_SECTION,
  validateProfile,
  type Diagnostic,
  type DocDiagnostic,
  type Pack,
  type ResolveResult,
} from "@meantjs/profile";
import schema from "@meantjs/profile/schema.json" with { type: "json" };
import icrc1 from "@meantjs/profile/packs/icrc1.profile.json" with { type: "json" };
import { LEDGER_DID, check } from "./check.mts";

const validateSchema = await createSchemaValidator();
const fromDocument = await createSchemaValidator(schema);
check(fromDocument(icrc1) && validateSchema(icrc1), "the shipped schema validates the shipped pack");
const packs: Pack[] = await loadPacks();
check(packs.map((p) => p.doc.name).join() === "icrc1,icrc2" && DEFAULT_PACKS_DIR.length > 0, "the shipped packs");

const r: ResolveResult = await resolveService({ did: LEDGER_DID, validateSchema, packs: packs.map(({ doc }) => ({ doc })) });
check(r.ok && r.resolved !== null && r.resolved.format === "candid-profile-resolved", "resolved");
const errors: Diagnostic[] = r.diagnostics.filter((d) => d.severity === "error");
check(errors.length === 0 && r.profiles.every((p) => p.status === "applied"), "both packs applied");
check(LAYERS[0] === "author" && profileId(icrc1).startsWith("candid-profile:v0:sha256:"), "profile ids");

const compiled = await compileInterface(LEDGER_DID);
check("iface" in compiled && compiled.iface.methods.get("icrc1_transfer")?.mode === "update", "compileInterface");
const v = await validateProfile(icrc1, { validateSchema, did: LEDGER_DID });
check(v.ok, "validateProfile");

const fromDocs = profileFromDocAttributes({ ok: false, diagnostics: [] }, { name: "mine" });
const docDiagnostics: DocDiagnostic[] = fromDocs.diagnostics;
check(!fromDocs.ok && fromDocs.doc === null && docDiagnostics[0]?.code === "E_DOC_INPUT" && DOC_ATTRIBUTES_VERSION === 1, "profileFromDocAttributes refuses what is not a doc attributes response");

const served = readServedProfile(new TextEncoder().encode(JSON.stringify({ ...icrc1, kind: "canister", origin: "author" })), { canisterId: null });
check(SERVED_SECTION === "icp:public candid:profile" && SERVED_METADATA === "candid:profile" && SERVED_MAX_BYTES === 1 << 20, "the served section's name and limit");
check(served.ok && served.doc?.kind === "canister", "readServedProfile reads an author canister profile");
const bound = readServedProfile(new TextEncoder().encode("{"), { canisterId: "ryjl3-tyaaa-aaaaa-aaaba-cai", label: "x" });
check(!bound.ok && bound.doc === null && bound.diagnostics.map((d) => `${d.code} ${d.at}`).join() === "E_SERVED x", "readServedProfile refuses what is not JSON");

let out = "";
const code = await runCli(["--help"], { stdout: { write: (s: string) => (out += s) }, stderr: { write: (s: string) => (out += s) } });
check(code === 0 && out.includes(USAGE.split("\n")[0]), "runCli");

export function refused(): void {
  // @ts-expect-error validateSchema is required
  void resolveService({ did: LEDGER_DID });
  // @ts-expect-error a doc annotation profile is the author's or a third party's, never a pack
  void profileFromDocAttributes({}, { origin: "pack" });
  // @ts-expect-error the canister that served it, or null before install: never left out
  void readServedProfile(new Uint8Array(), {});
}
