// The library packages' types are hand-written next to plain ES modules. These tests keep the two from drifting apart:
// every JavaScript entry a package exports has a `types` condition, and the names its declaration file exports are
// exactly the names the module exports at run time. `npm run types` then compiles strict consumer programs against
// the declarations (scripts/package-check/types/), and `npm run pack:check` compiles and runs them on the tarballs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LIBRARY_DIRS } from "./package-check/packages.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = LIBRARY_DIRS;

/**
 * The value names a declaration file exports: `export function|const|class|declare class` and the names of
 * `export { a, b as c } from "..."` (not `export type { ... }`). `export *` is refused: the list must be explicit.
 */
export function declaredNames(text) {
  assert.doesNotMatch(text, /^export \*/m, "a declaration file must list its exports (no export *)");
  const names = [...text.matchAll(/^export (?:declare )?(?:function|const|class) (\w+)/gm)].map((m) => m[1]);
  for (const m of text.matchAll(/^export \{([^}]*)\} from /gm)) {
    for (const part of m[1].split(",").map((s) => s.trim()).filter(Boolean)) names.push(part.split(/\s+as\s+/).pop());
  }
  return [...new Set(names)].sort();
}

test("declaredNames reads declarations and re-export lists, and skips type-only exports", () => {
  const text = 'export function a(): void;\nexport declare class B {}\nexport const c: 1;\nexport { d, e as f } from "./x.mjs";\nexport type { G } from "./x.mjs";\nexport interface H {}\n';
  assert.deepEqual(declaredNames(text), ["B", "a", "c", "d", "f"]);
  assert.throws(() => declaredNames('export * from "./x.mjs";\n'), /no export \*/);
});

for (const dir of PACKAGES) {
  const pkgDir = path.join(ROOT, "packages", dir);
  const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
  for (const [key, target] of Object.entries(pkg.exports)) {
    const file = typeof target === "string" ? target : target.default;
    if (key.includes("*") || !/\.m?js$/.test(file)) continue;
    test(`${pkg.name}${key.slice(1)}: has types that declare exactly its runtime exports`, async () => {
      assert.equal(typeof target, "object", `${key} has no types condition`);
      assert.deepEqual(Object.keys(target), ["types", "default"], `${key}: types must come first, then default`);
      const runtime = Object.keys(await import(pathToFileURL(path.join(pkgDir, target.default)).href)).sort();
      assert.deepEqual(declaredNames(readFileSync(path.join(pkgDir, target.types), "utf8")), runtime);
    });
  }
  test(`${pkg.name}: the top-level types field is the main entry's`, () => {
    assert.equal(pkg.types, pkg.exports["."].types);
  });
}
