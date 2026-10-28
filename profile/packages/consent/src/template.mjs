// Intent templates (docs/profile-v0.md section 6):
//
//   Send {amount} to {to}[ from subaccount {from_subaccount}][ with memo {memo}]
//
// Placeholders `{relpath}`, optional segments `[ ... ]` (no nesting in v0), escapes `{{ }} [[ ]]`. The scan is
// the one of `parseTemplate` in packages/resolver/src/checks.mjs, character for character, so a template the
// resolver accepted parses here into the same placeholders (a test compares the two on the fixtures and on
// generated templates). Unlike that function, this one keeps the literal text.

import { CODES, fail } from "./errors.mjs";

/**
 * @typedef {{ t: "lit", text: string } | { t: "ph", path: string }} Part
 * @typedef {Part | { t: "opt", parts: Part[] }} TemplatePart
 */

/** @returns {TemplatePart[]} */
export function parseTemplate(template) {
  if (typeof template !== "string") fail(CODES.TEMPLATE, "the intent template is not a string");
  /** @type {TemplatePart[]} */
  const top = [];
  /** @type {Part[] | null} */
  let segment = null;
  let lit = "";
  const target = () => segment ?? top;
  const flush = () => {
    if (lit !== "") target().push({ t: "lit", text: lit });
    lit = "";
  };
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if ((ch === "{" || ch === "}" || ch === "[" || ch === "]") && template[i + 1] === ch) {
      lit += ch;
      i++;
      continue;
    }
    if (ch === "[") {
      if (segment) fail(CODES.TEMPLATE, "nested [ ] segments are not allowed in v0");
      flush();
      segment = [];
    } else if (ch === "]") {
      if (!segment) fail(CODES.TEMPLATE, "unbalanced ]");
      flush();
      top.push({ t: "opt", parts: segment });
      segment = null;
    } else if (ch === "{") {
      const end = template.indexOf("}", i);
      if (end < 0) fail(CODES.TEMPLATE, "unclosed {");
      flush();
      target().push({ t: "ph", path: template.slice(i + 1, end) });
      i = end;
    } else if (ch === "}") {
      fail(CODES.TEMPLATE, "unbalanced }");
    } else lit += ch;
  }
  if (segment) fail(CODES.TEMPLATE, "unclosed [");
  flush();
  return top;
}

/** Every placeholder of a parsed template, in order, with whether it sits in an optional segment. */
export function placeholdersOf(parts) {
  const out = [];
  for (const p of parts) {
    if (p.t === "ph") out.push({ path: p.path, inOptional: false });
    else if (p.t === "opt") for (const q of p.parts) if (q.t === "ph") out.push({ path: q.path, inOptional: true });
  }
  return out;
}
