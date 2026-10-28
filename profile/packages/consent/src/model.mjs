// The neutral model of one consent message: a title, an optional sentence (the rendered intent template as
// literal and field parts) and the fields. Both ICRC-21 forms are rendered from it (render.mjs), so they cannot
// disagree about which values the call carries.
//
// Which fields appear:
//   - a call with an intent, its case's (spec section 5.2, D-053) or else its method's: the placeholders of its template
//     that are present (spec section 6; section 12: "one (label, Value) row per placeholder"), in template order,
//     once per distinct path;
//   - a call without one: the generic intent. Title from `describe.label` of the method, else `Call <method>`;
//     one field per leaf of the decoded arguments (records are flattened, tagged positions such as accounts are
//     leaves, absent optionals are left out). More than MAX_FIELDS fields or MAX_ELEMENTS list elements is
//     refused (E_TOO_LARGE), never truncated.

import { VALUE_TAGS } from "@meantjs/format";
import { decodeArguments } from "./decode.mjs";
import { CODES, ConsentError, fail } from "./errors.mjs";
import { callTag, effectKind, entriesOf, labelOf, methodOf } from "./resolved.mjs";
import { parseTemplate } from "./template.mjs";
import { resolvePath, valuesAt } from "./paths.mjs";

export const MAX_FIELDS = 64;
export const MAX_ELEMENTS = 256;

/**
 * @typedef {object} Field
 * @property {string} path  the placeholder path, or the dotted path of a flattened leaf
 * @property {string} label  describe.label of the position, else its field name (raw, not yet escaped)
 * @property {object} node  the resolved-form position
 * @property {unknown[]} values  the present values: none (absent), one, or one per list element
 *
 * @typedef {{ lit: string } | { field: Field }} SentencePart
 *
 * @typedef {object} Model
 * @property {string} method
 * @property {string} effect  the effect kind of the call: its case's, else its method's (spec section 5.3, D-053)
 * @property {string} title
 * @property {SentencePart[] | null} sentence  null for a call without an intent template
 * @property {Field[]} fields
 * @property {object[]} argNodes
 * @property {unknown[]} argValues
 * @property {object[]} diagnostics
 * @property {{ intent: { origin: string, profile?: string } | null, profiles: object[] }} provenance  where the words come from
 *   (ICRC-49: a signer warns when it, not the canister, wrote the message; spec section 11 item 1: a profile is a claim)
 */

/**
 * @param {{ resolved: object, method: string, arg: Uint8Array | ArrayBuffer | number[], limits?: object }} input
 * @returns {Model}
 */
export function buildModel({ resolved, method: name, arg, limits }) {
  const method = methodOf(resolved, name);
  return modelOf(resolved, name, method, decodeArguments(method, arg, limits));
}

/** The model of a call whose arguments are decoded already (evm.mjs decodes calldata, then comes here). */
export function modelOf(resolved, name, method, argValues) {
  const diagnostics = [];
  const intentTag = callTag(method, argValues, "intent"); // the call's intent: its case's, else its method's (D-053)
  const intent = intentTag?.args;
  const title = typeof intent?.title === "string" && intent.title.trim() !== "" ? intent.title : (labelOf(method) ?? `Call ${name}`);
  const tagOrigin = intent ? { origin: intentTag.origin, ...(intentTag.profile === undefined ? {} : { profile: intentTag.profile }) } : null;
  const provenance = { intent: tagOrigin, profiles: Array.isArray(resolved.profiles) ? resolved.profiles : [] };
  const base = { method: name, effect: effectKind(method, callTag(method, argValues, "effect")), title, argNodes: method.args, argValues, diagnostics, provenance };

  if (intent && typeof intent.template === "string") {
    try {
      const { sentence, fields } = applyTemplate(method, argValues, parseTemplate(intent.template));
      return { ...base, sentence, fields };
    } catch (e) {
      // A template the profile got wrong must not leave the user without a message: fall back to the generic
      // intent, which lists every argument, and say so.
      if (!(e instanceof ConsentError) || (e.code !== CODES.TEMPLATE && e.code !== CODES.TEMPLATE_PATH)) throw e;
      diagnostics.push({ code: "W_TEMPLATE_FALLBACK", at: name, message: `${e.code}: ${e.message}; the generic intent is used instead` });
    }
  }
  return { ...base, sentence: null, fields: flatten(method, argValues) };
}

// ---------------------------------------------------------------------------------------------- template

function nameOf(path, resolvedPath) {
  for (let i = resolvedPath.steps.length - 1; i >= 0; i--) {
    const s = resolvedPath.steps[i];
    if (s.kind !== "elem") return s.key;
  }
  return `Argument ${resolvedPath.index + 1}`;
}

function applyTemplate(method, argValues, parts) {
  const known = new Map(); // path -> Field
  const sentence = [];
  const fields = [];

  const lookup = (path) => {
    const hit = known.get(path);
    if (hit) return { field: hit, fresh: false };
    const rp = resolvePath(method, path);
    if (rp.error) return { error: rp.error };
    const values = valuesAt(rp, argValues);
    if (values.length > MAX_ELEMENTS) fail(CODES.TOO_LARGE, `{${path}} has ${values.length} values; the limit is ${MAX_ELEMENTS}`);
    return { field: { path, label: labelOf(rp.node) ?? nameOf(path, rp), node: rp.node, values }, fresh: true };
  };
  const register = ({ field, fresh }) => {
    if (!fresh) return field;
    known.set(field.path, field);
    fields.push(field);
    if (fields.length > MAX_FIELDS) fail(CODES.TOO_LARGE, `the template has more than ${MAX_FIELDS} distinct placeholders`);
    return field;
  };

  for (const part of parts) {
    if (part.t === "lit") sentence.push({ lit: part.text });
    else if (part.t === "ph") {
      const found = lookup(part.path);
      if (found.error) fail(CODES.TEMPLATE_PATH, `{${part.path}}: ${found.error}`);
      sentence.push({ field: register(found) });
    } else {
      // [ ... ]: dropped when any placeholder inside is absent (null) or names a position this method lacks.
      const looked = part.parts.map((p) => (p.t === "ph" ? lookup(p.path) : null));
      const unresolved = looked.find((l) => l?.error);
      if (unresolved || looked.some((l) => l && l.field.values.length === 0)) continue;
      for (let i = 0; i < part.parts.length; i++) {
        const p = part.parts[i];
        sentence.push(p.t === "lit" ? { lit: p.text } : { field: register(looked[i]) });
      }
    }
  }
  return { sentence, fields };
}

// ---------------------------------------------------------------------------------------------- generic intent

const hasValueTag = (node) => VALUE_TAGS.some((t) => node.tags && Object.hasOwn(node.tags, t));

/**
 * Field order of the resolved form is canonical id order (spec section 10), which reads as random. `ui.order`
 * ("use ui.order for presentation") puts the fields that have one first, ascending; the rest keep id order.
 */
function presentationOrder(entries) {
  const order = (child) => {
    const n = child.tags?.ui?.args?.order;
    return Number.isFinite(n) ? n : Infinity;
  };
  return entries.map((e, i) => ({ e, i })).sort((a, b) => order(a.e[1]) - order(b.e[1]) || a.i - b.i).map(({ e }) => e);
}

function flatten(method, argValues) {
  const fields = [];
  const multi = method.args.length > 1;
  const emit = (node, value, keys, index) => {
    const dotted = keys.join(".");
    const label = labelOf(node) ?? (multi ? `Argument ${index + 1}${dotted ? ` ${dotted}` : ""}` : dotted || `Argument ${index + 1}`);
    if (node.candid === "vec" && value.length > MAX_ELEMENTS) fail(CODES.TOO_LARGE, `${label} has ${value.length} elements; the limit is ${MAX_ELEMENTS}`);
    fields.push({ path: `(${index})${keys.map((k) => `.${k}`).join("")}`, label, node, values: [value] });
    if (fields.length > MAX_FIELDS) fail(CODES.TOO_LARGE, `the arguments have more than ${MAX_FIELDS} fields`);
  };
  const walk = (node, value, keys, index) => {
    if (node.optional === true && value === null) return;
    const children = node.candid === "record" && node.recursive !== true && !hasValueTag(node) ? presentationOrder(entriesOf(node.fields)) : [];
    if (children.length > 0) for (const [key, child] of children) walk(child, value[key], [...keys, key], index);
    else emit(node, value, keys, index);
  };
  method.args.forEach((node, i) => walk(node, argValues[i], [], i));
  return fields;
}
