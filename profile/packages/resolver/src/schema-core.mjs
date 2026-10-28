// The schema checks without the file system: compile a schema document, report its errors. schema.mjs adds reading
// the schema from a path (Node); the browser entry passes the document the package ships.
//
// The schema this package ships is compiled ahead of time (data/profile-v0.validate.mjs, ajv's standalone code,
// written by scripts/data.mjs), so validating against it generates no code at run time and runs under a
// Content-Security-Policy without 'unsafe-eval'. Any other schema document is compiled by ajv here, at run time, which
// uses `new Function`; ajv is loaded only then.
import shipped from "../data/profile-v0.schema.json" with { type: "json" };
import { validate as precompiled } from "../data/profile-v0.validate.mjs";
import { jcs } from "./util.mjs";

const SHIPPED_JCS = jcs(shipped);

/**
 * Compile a profile schema document once; the result is a validate function with ajv's `errors`. A document equal
 * to the shipped schema (as JSON, whatever its key order) gets the precompiled validator.
 */
export async function compileSchema(doc) {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new TypeError("createSchemaValidator: expected a path or a schema object");
  if (doc === shipped || jcs(doc) === SHIPPED_JCS) return ownErrors(precompiled);
  const { default: Ajv2020Module } = await import("ajv/dist/2020.js");
  const Ajv2020 = Ajv2020Module.default ?? Ajv2020Module;
  return new Ajv2020({ allErrors: true, strict: true }).compile(doc);
}

/** A validate function with its own `errors`, as each run-time compile has, over the one shared precompiled one. */
function ownErrors(validate) {
  const own = (doc) => {
    const ok = validate(doc);
    own.errors = validate.errors;
    return ok;
  };
  own.errors = null;
  return own;
}

/** E_SCHEMA diagnostics for the errors of a failed validate call. */
export function schemaDiagnostics(validateSchema) {
  return validateSchema.errors.map((e) => ({
    severity: "error",
    code: "E_SCHEMA",
    at: e.instancePath || "/",
    message: `${e.message}${e.params ? ` ${JSON.stringify(e.params)}` : ""}`,
  }));
}
