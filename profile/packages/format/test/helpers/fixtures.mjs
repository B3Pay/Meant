import { readFileSync } from "node:fs";

const ROOT = new URL("../../../../fixtures/", import.meta.url);

export function loadFixture(name) {
  return JSON.parse(readFileSync(new URL(`${name}.resolved.json`, ROOT), "utf8"));
}

/** Every position in a resolved form: { path, node }. */
export function* positions(fixture) {
  function* walk(node, path) {
    yield { path, node };
    for (const [k, c] of Object.entries(node.fields ?? {})) yield* walk(c, `${path}.${k}`);
    for (const [k, c] of Object.entries(node.cases ?? {})) yield* walk(c, `${path}|${k}`);
    if (node.element) yield* walk(node.element, `${path}[]`);
  }
  for (const [m, method] of Object.entries(fixture.methods)) {
    for (const [i, a] of method.args.entries()) yield* walk(a, `${m}.arg${i}`);
    for (const [i, r] of method.results.entries()) yield* walk(r, `${m}.res${i}`);
  }
}

/** The node at a path like "icrc1_transfer.arg0.amount". */
export function nodeAt(fixture, path) {
  for (const p of positions(fixture)) if (p.path === path) return p.node;
  throw new Error(`no node at ${path}`);
}

/** The first node carrying a tag, optionally filtered by Candid type. */
export function firstWithTag(fixture, tag, candid) {
  for (const p of positions(fixture)) if (p.node.tags?.[tag] && (candid === undefined || p.node.candid === candid)) return p.node;
  throw new Error(`no ${tag} node`);
}
