// @meantjs/profile/browser as a TypeScript consumer (a bundled page) uses it; this program runs it on Node.
import { SERVED_SECTION, STANDARD_PACKS, createSchemaValidator, readServedProfile, resolveService, schemaDiagnostics, type ResolveResult } from "@meantjs/profile/browser";
import { LEDGER_DID, check } from "./check.mts";

const validateSchema = await createSchemaValidator();
const r: ResolveResult = await resolveService({ did: LEDGER_DID, validateSchema, packs: STANDARD_PACKS.map(({ doc }) => ({ doc })) });
check(r.ok && r.profiles.length === 2, "resolved with the standard packs");
check(SERVED_SECTION === "icp:public candid:profile" && !readServedProfile(new Uint8Array([0xef, 0xbb, 0xbf]), { canisterId: null }).ok, "served profiles");
check(!validateSchema({ kind: "pack" }) && schemaDiagnostics(validateSchema).every((d) => d.code === "E_SCHEMA"), "schema diagnostics");

export function refused(): void {
  // @ts-expect-error the browser entry takes the schema document, never a path
  void createSchemaValidator("spec/profile-v0.schema.json");
}
