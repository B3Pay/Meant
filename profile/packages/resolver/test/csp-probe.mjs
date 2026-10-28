// Run by test/csp.test.mjs under `node --disallow-code-generation-from-strings`, where eval and `new Function` throw:
// the resolver on its shipped schema and packs must work, and only another schema document may need generated code.
// Prints one JSON line.
import * as browser from "@meantjs/profile/browser";
import * as node from "@meantjs/profile";
import { LEDGER_DID } from "./helpers.mjs";

const out = {};
try {
  new Function("return 1");
  out.control = "allowed";
} catch (e) {
  out.control = e.name;
}
const v = await browser.createSchemaValidator();
out.browserPacks = browser.STANDARD_PACKS.map(({ doc }) => v(doc));
out.browserBad = v({ kind: "pack" });
const nv = await node.createSchemaValidator();
out.nodePacks = (await node.loadPacks()).map(({ doc }) => nv(doc));
const r = await browser.resolveService({ did: LEDGER_DID, validateSchema: v, packs: browser.STANDARD_PACKS.map(({ doc }) => ({ doc })) });
out.resolved = [r.ok, r.profiles.map((p) => [p.name, p.status])];
const nr = await node.resolveService({ did: LEDGER_DID, validateSchema: nv, packs: (await node.loadPacks()).map(({ doc }) => ({ doc })) });
out.nodeResolved = [nr.ok, nr.profiles.map((p) => [p.name, p.status])];
out.schemaCodes = [...new Set((await browser.validateProfile({ kind: "pack" }, { validateSchema: v })).diagnostics.map((d) => d.code))];
try {
  await browser.createSchemaValidator({ type: "object" });
  out.otherSchema = "compiled";
} catch (e) {
  out.otherSchema = e.name;
}
console.log(JSON.stringify(out));
