// Placeholder paths (docs/profile-v0.md section 3.2 rule 9): `{amount}`, `{to.owner}`, `{(0).amount}`, `{items[]}`.
// A relpath resolves against the method's argument tuple; with one argument it is relative to argument 0.
//
// Beyond what section 6 says (decisions of this package, listed in the README):
//   - a path that crosses a variant case selects that case; when the value has another case the placeholder is absent;
//   - a path that crosses `[]` yields one value per element (absent elements dropped);
//   - a path the method does not have is "unresolved": absent inside `[ ... ]`, an error outside (the resolver
//     already reports it as E_TEMPLATE_PATH; a pack placeholder the service lacks is skipped by the resolver).

import { parseRelPath } from "@meantjs/profile/address";
import { entriesOf, keyId } from "./resolved.mjs";

/**
 * @typedef {{ kind: "field" | "case", key: string } | { kind: "elem" }} Step
 * @typedef {{ index: number, steps: Step[], node: object, nodes: object[] }} ResolvedPath
 */

/** @returns {ResolvedPath | { error: string }} */
export function resolvePath(method, relpath) {
  const parsed = parseRelPath(relpath);
  if (!parsed) return { error: `bad relative path ${JSON.stringify(relpath)}` };
  let index = parsed.index;
  if (index === null) {
    if (method.args.length !== 1) return { error: `path ${JSON.stringify(relpath)} must start with (i): the method has ${method.args.length} arguments` };
    index = 0;
  }
  if (index >= method.args.length) return { error: `argument index ${index} is out of range` };
  let node = method.args[index];
  const nodes = [node];
  const steps = [];
  for (const seg of parsed.segs) {
    if (node.recursive === true) return { error: `${JSON.stringify(relpath)} enters a position the resolved form cuts at a cycle` };
    if (seg.kind === "elem") {
      if (node.candid !== "vec" || node.element === undefined) return { error: `"[]" applied to ${node.candid}` };
      steps.push({ kind: "elem" });
      node = node.element;
    } else {
      const field = entriesOf(node.fields).find(([key]) => keyId(key) === seg.id);
      const arm = field === undefined ? entriesOf(node.cases).find(([key]) => keyId(key) === seg.id) : undefined;
      const hit = field ?? arm;
      if (hit === undefined) return { error: `no field or case ${JSON.stringify(seg.label)} in ${node.candid}` };
      steps.push({ kind: field ? "field" : "case", key: hit[0] });
      node = hit[1];
    }
    nodes.push(node);
  }
  return { index, steps, node, nodes };
}

/**
 * The present values at a resolved path. An absent optional anywhere on the way (null), a variant with another
 * case, or an empty vector gives no values.
 *
 * @param {ResolvedPath} path
 * @param {unknown[]} values  the decoded argument trees
 * @returns {unknown[]}
 */
export function valuesAt(path, values) {
  let current = [values[path.index]];
  for (let depth = 0; depth < path.steps.length; depth++) {
    const step = path.steps[depth];
    const parentNode = path.nodes[depth];
    const next = [];
    for (const v of current) {
      if (parentNode.optional === true && v === null) continue;
      if (step.kind === "elem") next.push(...v);
      else if (step.kind === "field") next.push(v[step.key]);
      else if (v.tag === step.key) next.push(v.value);
    }
    current = next;
  }
  const leaf = path.node;
  return current.filter((v) => !(leaf.optional === true && v === null));
}
