// `@meantjs/profile/browser` is the resolver for a browser bundle: no Node built-in in its module graph, the
// schema and standard packs as data, and the same functions as the main entry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import * as browser from "../src/browser.mjs";
import * as barrel from "../src/index.mjs";
import { sha256, sha256Hex } from "../src/sha256.mjs";
import { LEDGER_DID, read } from "./helpers.mjs";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = async (file) => JSON.parse(await readFile(path.join(PKG, file), "utf8"));

test("the browser entry is exported", async () => {
  const pkg = await readJson("package.json");
  assert.deepEqual(pkg.exports["./browser"], { types: "./src/browser.d.mts", default: "./src/browser.mjs" });
  assert.equal(await import("@meantjs/profile/browser"), browser);
});

test("the browser entry bundles with no node:* import and no Node global; its one package import is the cli", async () => {
  // @candid-core/cli is left out: it is the wasm compiler's own published package, and it reads its wasm with a
  // guarded `import("node:fs/promises")` only when it runs on Node.
  const result = await build({
    entryPoints: [path.join(PKG, "src/browser.mjs")],
    absWorkingDir: PKG,
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    minify: true,
    legalComments: "none",
    metafile: true,
    logLevel: "silent",
    external: ["@candid-core/cli"],
  });
  const inputs = Object.keys(result.metafile.inputs);
  assert.deepEqual(inputs.filter((p) => p.startsWith("node:") || p.includes("(disabled):")), []);
  const own = inputs.filter((p) => !p.includes("node_modules/")).sort();
  assert.ok(own.includes("src/browser.mjs") && own.includes("data/profile-v0.schema.json"), own.join("\n"));
  assert.deepEqual(own.filter((p) => ["src/cli.mjs", "src/packs.mjs", "src/schema.mjs", "src/index.mjs"].includes(p)), []);
  const [output] = Object.values(result.metafile.outputs);
  assert.deepEqual([...new Set(output.imports.map((i) => i.path))], ["@candid-core/cli"]);
  const text = result.outputFiles[0].text;
  assert.doesNotMatch(text, /\bBuffer\b/);
  // `process` as a global; ajv has an option called `code.process`, read as a property.
  assert.doesNotMatch(text, /(?<![.\w$])process\b(?!\s*:)/);
});

test("sha256 agrees with node:crypto", () => {
  const lengths = [...Array(200).keys(), 447, 448, 511, 512, 1000, 4096, 65537];
  for (const n of lengths) {
    const bytes = randomBytes(n);
    assert.equal(Buffer.from(sha256(bytes)).toString("hex"), createHash("sha256").update(bytes).digest("hex"), `length ${n}`);
  }
  for (const s of ["", "abc", "é ü 漢字 🙂", "\ud800 lone surrogate", "x".repeat(10_000)]) {
    assert.equal(sha256Hex(s), createHash("sha256").update(s).digest("hex"), JSON.stringify(s.slice(0, 20)));
  }
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("the browser entry carries the schema and every standard pack in data/", async () => {
  assert.deepEqual(browser.PROFILE_SCHEMA, await readJson("data/profile-v0.schema.json"));
  const files = (await readdir(path.join(PKG, "data/packs"))).filter((f) => f.endsWith(".profile.json")).sort();
  assert.deepEqual(browser.STANDARD_PACKS.map((p) => p.file), files);
  for (const { file, doc } of browser.STANDARD_PACKS) assert.deepEqual(doc, await readJson(`data/packs/${file}`), file);
  const loaded = await barrel.loadPacks();
  assert.deepEqual(browser.STANDARD_PACKS.map((p) => p.doc), loaded.map((p) => p.doc));
});

test("the browser entry exports the main entry's functions, except the ones that read files", () => {
  const fileOnly = new Set(["loadPacks", "DEFAULT_PACKS_DIR", "DEFAULT_SCHEMA_PATH", "runCli", "USAGE", "createSchemaValidator"]);
  for (const name of Object.keys(barrel)) {
    if (fileOnly.has(name)) continue;
    assert.equal(browser[name], barrel[name], name);
  }
  for (const name of fileOnly) if (name !== "createSchemaValidator") assert.equal(browser[name], undefined, name);
});

test("createSchemaValidator takes a document (by default the shipped schema), never a path", async () => {
  await assert.rejects(browser.createSchemaValidator("spec/profile-v0.schema.json"), /not a path/);
  await assert.rejects(browser.createSchemaValidator(null), TypeError);
  const validate = await browser.createSchemaValidator();
  for (const { file, doc } of browser.STANDARD_PACKS) assert.equal(validate(doc), true, file);
  assert.equal(validate({ kind: "pack" }), false);
  assert.ok(browser.schemaDiagnostics(validate).every((d) => d.code === "E_SCHEMA"));
});

test("resolving through the browser entry gives the main entry's resolved form", async () => {
  const packs = (await barrel.loadPacks()).map(({ doc }) => ({ doc }));
  const author = JSON.parse(await read("examples/tokens.profile.json"));
  const did = await read("examples/tokens.did");
  const viaBarrel = await barrel.resolveService({ did, validateSchema: await barrel.createSchemaValidator(), profiles: [{ doc: author }], packs });
  const viaBrowser = await browser.resolveService({ did, validateSchema: await browser.createSchemaValidator(), profiles: [{ doc: author }], packs: browser.STANDARD_PACKS.map(({ doc }) => ({ doc })) });
  assert.deepEqual(viaBrowser, viaBarrel);
  assert.equal(viaBrowser.ok, true);
  const ledger = await browser.resolveService({ did: LEDGER_DID, validateSchema: await browser.createSchemaValidator(), packs: browser.STANDARD_PACKS.map(({ doc }) => ({ doc })) });
  assert.deepEqual(ledger.profiles.map((p) => p.status), ["applied", "applied"]);
});

test("the hand-written types declare exactly the runtime exports", async () => {
  const dts = await readFile(path.join(PKG, "src/browser.d.mts"), "utf8");
  const declared = [...dts.matchAll(/^export (?:declare )?(?:function|const|class) (\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual(declared, Object.keys(browser).sort());
});

test("analyzeProfiles returns the collections its declaration names", async () => {
  const { iface } = await browser.compileInterface(await read("examples/tokens.did"));
  const analysis = browser.analyzeProfiles(iface, []);
  const dts = await readFile(path.join(PKG, "src/browser.d.mts"), "utf8");
  const fields = [...dts.match(/^export function analyzeProfiles\(.*\): \{ (.*) \};$/m)[1].matchAll(/(\w+): ([^;]+)/g)];
  const kinds = fields.map(([, name, type]) => [name, type.endsWith("[]") ? "array" : type.startsWith("Set<") ? "set" : "other"]);
  assert.deepEqual(kinds, [["diagnostics", "array"], ["layered", "other"], ["ordered", "array"], ["stale", "set"]]);
  for (const [name, kind] of kinds) {
    if (kind === "array") assert.ok(Array.isArray(analysis[name]), name);
    if (kind === "set") assert.ok(analysis[name] instanceof Set, name);
  }
});

test("the Iface members the types declare are there, with the declared shapes", async () => {
  const { iface } = await browser.compileInterface(await read("examples/tokens.did"));
  assert.ok(iface.methods instanceof Map && iface.decls instanceof Map);
  assert.deepEqual([...iface.methods.keys()].sort(), ["balance", "send"]);
  const send = iface.methods.get("send");
  assert.equal(send.mode, "update");
  assert.ok(Array.isArray(send.args) && Array.isArray(send.results));
  assert.match(iface.interfaceId, /^candid-core:interface:v1:sha256:[0-9a-f]{64}$/);
  for (const name of ["node", "unwrapOpt", "fieldName", "isBlob", "isAccount", "describeType"]) assert.equal(typeof iface[name], "function", name);
  const displays = [...browser.positions(iface, "send", "args")].map((p) => [p.display, iface.describeType(p.ref), typeof p.key, p.cyclic]);
  assert.deepEqual(displays.find(([d]) => d === "send(0).amount.e8s"), ["send(0).amount.e8s", "nat64", "string", false]);
  assert.equal(iface.describeType(iface.decls.get("Tokens")), "record");
});
