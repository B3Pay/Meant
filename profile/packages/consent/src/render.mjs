// The two ICRC-21 forms from a Model (docs/profile-v0.md section 12).
//
// FieldsDisplayMessage (plain text, no formatting; times are UTC seconds, so the message does not depend on the
// user's time zone):
//   intent  = title + ": " + the rendered template      (no template: the title alone)
//   fields  = one (label, Value) row per placeholder; label = describe.label, else the field name
//
// GenericDisplayMessage (Markdown, the layout of the ICRC-21 examples: a `#` title, one paragraph, then
// `**label:**` lines). Every value comes from the call, which the relying party controls, so it goes into a
// code span, where Markdown is not parsed. Template text and labels come from the profile and are plain text:
// their Markdown punctuation is escaped.

import { codeBlock, codeSpan, emptyMarkdown, escapeLineStart, escapeMarkdown, oneLine, visible } from "./text.mjs";

const NONE_PLAIN = "(none)";
const NONE_MARKDOWN = "*(none)*";

/** Label and title: one line, trimmed, never empty. */
function plainLabel(raw, fallback) {
  const s = oneLine(raw).trim();
  return s === "" ? fallback : s;
}

/** The text of a field's values, plain: the values joined by ", ", or "(none)". */
function fieldPlain(field, renderer) {
  if (field.values.length === 0) return NONE_PLAIN;
  return field.values.map((v, i) => visible(renderer.text(field.node, v, field.path + (field.values.length > 1 ? `[${i}]` : "")))).join(", ");
}

function fieldMarkdown(field, renderer) {
  if (field.values.length === 0) return NONE_MARKDOWN;
  return field.values.map((v, i) => codeSpan(renderer.text(field.node, v, field.path + (field.values.length > 1 ? `[${i}]` : "")))).join(", ");
}

/**
 * @param {import("./model.mjs").Model} model
 * @param {import("./display.mjs").Renderer} renderer  UTC (no zone)
 * @param {{ rawArguments?: boolean }} [options]
 * @returns {{ intent: string, fields: Array<[string, object]> }}
 */
export function renderFields(model, renderer, { rawArguments = false } = {}) {
  const title = plainLabel(model.title, model.method);
  let intent = title;
  if (model.sentence !== null) {
    const sentence = model.sentence.map((p) => ("lit" in p ? oneLine(p.lit) : fieldPlain(p.field, renderer))).join("");
    if (sentence.trim() !== "") intent = `${title}: ${sentence.trim()}`;
  }
  const fields = model.fields.map((f) => [plainLabel(f.label, f.path), fieldValue(f, renderer)]);
  if (rawArguments) fields.push(["Raw arguments", { Text: { content: visible(renderer.tupleText(model.argNodes, model.argValues)) } }]);
  return { intent, fields };
}

/** One row's ICRC-21 Value: typed when the field is a single value the typed form carries exactly, else Text. */
function fieldValue(field, renderer) {
  if (field.values.length === 1) {
    const v = renderer.icrc21Value(field.node, field.values[0], field.path);
    if (v.Text) v.Text.content = visible(v.Text.content);
    return v;
  }
  return { Text: { content: fieldPlain(field, renderer) } };
}

/**
 * @param {import("./model.mjs").Model} model
 * @param {import("./display.mjs").Renderer} renderer  zoned when the request carried a utc_offset_minutes
 * @param {{ rawArguments?: boolean, headingLevel?: number }} [options]  `headingLevel`: the title's heading level
 *   (default 1; an SNS validator rendering sits under governance's own `##` headings and uses 3)
 * @returns {string}
 */
export function renderGeneric(model, renderer, { rawArguments = false, headingLevel = 1 } = {}) {
  const blocks = [`${"#".repeat(headingLevel)} ${escapeMarkdown(plainLabel(model.title, model.method))}`];
  if (model.sentence !== null) {
    let paragraph = model.sentence.map((p) => ("lit" in p ? escapeMarkdown(oneLine(p.lit)) : fieldMarkdown(p.field, renderer))).join("").trim();
    if (model.sentence[0] && "lit" in model.sentence[0]) paragraph = escapeLineStart(paragraph);
    if (paragraph !== "") blocks.push(paragraph);
  }
  if (model.fields.length > 0) {
    blocks.push(model.fields.map((f) => `- **${escapeMarkdown(plainLabel(f.label, f.path))}:** ${fieldMarkdown(f, renderer)}`).join("\n"));
  } else if (model.sentence === null) {
    blocks.push("This call has no arguments.");
  }
  if (rawArguments) blocks.push(`**Raw arguments:**\n\n${codeBlock(renderer.tupleText(model.argNodes, model.argValues))}`);
  return blocks.join("\n\n");
}

export { emptyMarkdown };
