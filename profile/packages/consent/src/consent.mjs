// resolved form + method + Candid argument bytes -> a consent message, without the ICRC-21 envelope.
// `icrc21.mjs` wraps this into the ICRC-21 request/response shapes.

import { Renderer } from "./display.mjs";
import { buildModel } from "./model.mjs";
import { renderFields, renderGeneric } from "./render.mjs";

/**
 * @param {object} input
 * @param {object} input.resolved  a resolved form (docs/profile-v0.md section 10)
 * @param {string} input.method  the method being called
 * @param {Uint8Array | ArrayBuffer | number[]} input.arg  the Candid-encoded argument tuple
 * @param {Record<string, unknown>} [input.refs]  resolved dynamic refs, for example { "query:icrc1_decimals": 8, "query:icrc1_symbol": "ICP" }
 * @param {"fields" | "generic"} [input.form]  default "generic"
 * @param {number | null} [input.utcOffsetMinutes]  generic form only: show timestamps in this zone (default 0, UTC). The fields form is always UTC seconds
 * @param {boolean} [input.rawArguments]  append the decoded raw arguments (spec section 11 item 1)
 * @param {object} [input.limits]  decoder limits (maxBytes, maxDepth, maxElements)
 * @returns {{ form: "fields" | "generic", message: object, zoneSensitive: boolean, diagnostics: object[], provenance: object, model: object }}
 *   `message` is `{ FieldsDisplayMessage: { intent, fields } }` or `{ GenericDisplayMessage: string }` (ICRC-21 shapes,
 *   integers as bigint). `zoneSensitive` is true when a timestamp was shown in the requested zone.
 */
export function generateConsent({ resolved, method, arg, refs = {}, form = "generic", utcOffsetMinutes = null, rawArguments = false, limits }) {
  const model = buildModel({ resolved, method, arg, limits });
  const diagnostics = model.diagnostics;
  const done = (rest) => ({ ...rest, diagnostics: dedupe(diagnostics), provenance: model.provenance, model });
  if (form === "fields") {
    const renderer = new Renderer({ refs, utcOffsetMinutes: null, diagnostics });
    const { intent, fields } = renderFields(model, renderer, { rawArguments });
    return done({ form, message: { FieldsDisplayMessage: { intent, fields } }, zoneSensitive: false });
  }
  const renderer = new Renderer({ refs, utcOffsetMinutes: utcOffsetMinutes ?? 0, diagnostics });
  const text = renderGeneric(model, renderer, { rawArguments });
  return done({ form: "generic", message: { GenericDisplayMessage: text }, zoneSensitive: renderer.usedZone });
}

function dedupe(diagnostics) {
  const seen = new Set();
  return diagnostics.filter((d) => {
    const key = `${d.code}\u0000${d.at}\u0000${d.message}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}
