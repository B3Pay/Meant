// Step 1: the validator moved into this package. The resolved forms of the standard packs and the example must stay
// byte-identical to the committed fixtures (a shared contract), and the package must keep the single-profile behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSchemaValidator, validateProfile, idlHash, parseAddress, jcs, profileId } from "../src/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (p) => readFile(path.join(ROOT, p), "utf8");
const validateSchema = await createSchemaValidator();

for (const [profile, did, fixture] of [
  ["packs/icrc1.profile.json", null, "fixtures/icrc1.resolved.json"],
  ["packs/icrc2.profile.json", null, "fixtures/icrc2.resolved.json"],
  ["examples/tokens.profile.json", "examples/tokens.did", "fixtures/tokens-example.resolved.json"],
]) {
  test(`resolved form of ${profile} is byte-identical to ${fixture}`, async () => {
    const doc = JSON.parse(await read(profile));
    const r = await validateProfile(doc, { validateSchema, did: did ? await read(did) : null, didLabel: did, resolved: true });
    assert.equal(r.ok, true, JSON.stringify(r.diagnostics));
    assert.equal(`${JSON.stringify(r.resolved, null, 2)}\n`, await read(fixture));
  });
}

test("the package exposes the helpers the validator used to own", () => {
  assert.equal(idlHash("amount"), 3573748184);
  assert.equal(parseAddress("icrc1_transfer(0).amount").kind, "arg");
  assert.equal(jcs({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.match(profileId({ a: 1 }), /^candid-profile:v0:sha256:[0-9a-f]{64}$/);
});

test("single-profile diagnostics carry no profile attribution (output unchanged from the old validator)", async () => {
  const doc = JSON.parse(await read("packs/icrc1.profile.json"));
  doc.annotations.push({ at: "icrc1_transfer(0).amout", tag: "amount", args: { decimals: 8 } });
  const r = await validateProfile(doc, { validateSchema });
  assert.equal(r.ok, false);
  const d = r.diagnostics.find((x) => x.code === "E_ADDR_UNRESOLVED");
  assert.deepEqual(Object.keys(d), ["severity", "code", "at", "message"]);
});
