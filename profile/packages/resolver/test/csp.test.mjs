// A page with a Content-Security-Policy that has no 'unsafe-eval' can use the resolver on its shipped schema: the
// schema is compiled ahead of time (data/profile-v0.validate.mjs), and the cli's wasm needs only 'wasm-unsafe-eval'.
// Two checks, each with a control that proves the restriction is live: Node with code generation from strings
// disabled, and Chromium under the policy itself (skipped when no Chrome or Chromium is found; set CHROME_PATH).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { LEDGER_DID } from "./helpers.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const require = createRequire(import.meta.url);

test("on Node with eval and new Function disabled, the shipped schema validates and resolves; another schema cannot compile", () => {
  const r = spawnSync(process.execPath, ["--disallow-code-generation-from-strings", path.join(HERE, "csp-probe.mjs")], { encoding: "utf8", cwd: PKG });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").at(-1));
  const applied = [true, [["icrc1", "applied"], ["icrc2", "applied"]]];
  assert.deepEqual(out, {
    control: "EvalError", // the flag is live
    browserPacks: [true, true],
    browserBad: false,
    nodePacks: [true, true],
    resolved: applied,
    nodeResolved: applied,
    schemaCodes: ["E_SCHEMA"],
    otherSchema: "EvalError", // ajv's run-time compile needs generated code, so the precompiled path is the one used
  });
});

const CHROME_CANDIDATES = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"];
const chrome = process.env.CHROME_PATH ? (existsSync(process.env.CHROME_PATH) ? process.env.CHROME_PATH : null) : (CHROME_CANDIDATES.find((p) => existsSync(p)) ?? null);

const CSP = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'";

/** The page's script: run `body` with the browser entry in scope, record the result and every CSP violation. */
const pageScript = (body) => `
import { createSchemaValidator, resolveService, STANDARD_PACKS, initCompiler } from ${JSON.stringify(path.join(PKG, "src/browser.mjs"))};
const violations = [];
document.addEventListener("securitypolicyviolation", (e) => violations.push(e.violatedDirective + " " + e.blockedURI));
let result;
try {
  ${body}
} catch (e) {
  result = { error: e.name + ": " + e.message };
}
await new Promise((r) => setTimeout(r, 100)); // violation events are queued as tasks
window.__done = { result, violations };
`;

const PAGES = {
  ok: pageScript(`
  await initCompiler("/cli.wasm");
  const did = await (await fetch("/ledger.did")).text();
  const v = await createSchemaValidator();
  const r = await resolveService({ did, validateSchema: v, packs: STANDARD_PACKS.map(({ doc }) => ({ doc })) });
  result = { packs: STANDARD_PACKS.map(({ doc }) => v(doc)), bad: v({ kind: "pack" }), ok: r.ok, profiles: r.profiles.map((p) => [p.name, p.status]) };`),
  control: pageScript(`
  await createSchemaValidator({ type: "object" });
  result = { compiled: true };`),
};

test("in Chromium, under a CSP with no 'unsafe-eval', the browser entry resolves on its shipped schema", { skip: chrome ? false : "no Chrome or Chromium (set CHROME_PATH)" }, async (t) => {
  const bundles = {};
  for (const [name, contents] of Object.entries(PAGES)) {
    const out = await build({
      stdin: { contents, resolveDir: PKG, sourcefile: `${name}.mjs` },
      bundle: true,
      platform: "browser",
      format: "esm",
      write: false,
      logLevel: "silent",
      external: ["node:*"], // the cli's guarded import, taken only on Node
    });
    bundles[`/${name}.js`] = out.outputFiles[0].text;
  }
  const wasm = await readFile(path.join(path.dirname(require.resolve("@candid-core/cli/package.json")), "wasm/candid_core_wasm_bg.wasm"));
  const server = createServer((req, res) => {
    const send = (type, body) => res.writeHead(200, { "content-type": type, "content-security-policy": CSP }).end(body);
    const page = /^\/(\w+)\.html$/.exec(req.url)?.[1];
    if (page && PAGES[page]) return send("text/html", `<!doctype html><script type="module" src="/${page}.js"></script>`);
    if (bundles[req.url]) return send("text/javascript", bundles[req.url]);
    if (req.url === "/cli.wasm") return send("application/wasm", wasm);
    if (req.url === "/ledger.did") return send("text/plain", LEDGER_DID);
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  t.after(() => browser.close());
  const run = async (name) => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/${name}.html`);
    await page.waitForFunction(() => window.__done !== undefined, null, { timeout: 30_000 });
    return page.evaluate(() => window.__done);
  };

  assert.deepEqual(await run("ok"), {
    result: { packs: [true, true], bad: false, ok: true, profiles: [["icrc1", "applied"], ["icrc2", "applied"]] },
    violations: [],
  });
  // The control: the same policy refuses ajv's run-time compile of another schema, so the policy is enforced.
  const control = await run("control");
  assert.match(control.result.error, /^EvalError/);
  assert.deepEqual(control.violations, ["script-src eval"]);
});
