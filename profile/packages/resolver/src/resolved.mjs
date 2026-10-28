/**
 * The resolved form (spec section 10): one tree per method with the effective tags attached to every position.
 * buildTree is moved verbatim from scripts/validate.mjs. The shape is a shared contract (fixtures/*.resolved.json).
 */
import { positions } from "./tags.mjs";

export function buildTree(iface, methodName, side, tags) {
  const out = [];
  const stack = []; // [node object, depth]
  for (const pos of positions(iface, methodName, side)) {
    const { ref: r, optional } = iface.unwrapOpt(pos.ref);
    const n = iface.node(r);
    const node = { candid: n.kind === "primitive" ? n.primitive : iface.isBlob(r) ? "blob" : n.kind };
    if (optional) node.optional = true;
    const t = tags.at(pos, iface);
    if (t) node.tags = t;
    if (pos.cyclic) node.recursive = true;
    const depth = pos.key.split("|")[3] === "" ? 0 : pos.key.split("|")[3].split("/").length;
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    if (depth === 0) out.push(node);
    else {
      const parentNode = stack[stack.length - 1].node;
      const last = pos.display.endsWith("[]") ? null : pos.display.slice(pos.display.lastIndexOf(".") + 1);
      if (last === null) parentNode.element = node;
      else {
        const bucket = pos.parent.kind === "record" ? "fields" : "cases";
        parentNode[bucket] ??= {};
        parentNode[bucket][last] = node;
      }
    }
    stack.push({ node, depth });
  }
  return out;
}

/**
 * @param iface    the interface the tree is built over
 * @param profiles every profile that contributes, highest precedence first: [{ doc, pid }]
 * @param tags     a LayeredTags
 */
export function resolvedForm(iface, profiles, tags, diagnostics) {
  const methods = {};
  for (const [name, m] of [...iface.methods.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const mt = { ...tags.methodTags(name) };
    if (!mt.effect) {
      mt.effect = m.mode === "update" || m.mode === "oneway"
        ? { args: { kind: "write", irreversible: true }, origin: "default" }
        : { args: { kind: "read", irreversible: false }, origin: "default" };
    }
    methods[name] = { mode: m.mode, tags: mt, args: buildTree(iface, name, "args", tags), results: buildTree(iface, name, "results", tags) };
  }
  return {
    format: "candid-profile-resolved",
    format_version: 0,
    interface_id: iface.contract.identities.interface ?? null,
    profiles: profiles.map(({ doc, pid }) => ({ name: doc.name, origin: doc.origin, profile_id: pid })),
    methods,
    diagnostics,
  };
}
