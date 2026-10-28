// SNS proposals that execute a generic nervous system function: the validator method as a function (the governance
// counterpart of ICRC-21), and the reviewer's check of what a proposal shows.
//
// What SNS governance does (fact: dfinity/ic commit 649156c2bca1315da5699e2125b34be6397c9987,
// rs/sns/governance/src/proposal.rs `validate_and_render_execute_nervous_system_function`, canister_control.rs
// `perform_execute_generic_nervous_system_function_validate_and_render_call`, types.rs `summarize_blob_field`):
//   - When the proposal is submitted, governance calls `validator_method_name` on `validator_canister_id` with the
//     proposal's payload bytes, unchanged. The reply must decode as `variant { Ok : text; Err : text }` (Rust
//     `Result<String, String>`). `Err(e)` rejects the proposal ("Invalid proposal: e").
//   - `Ok(text)` is stored as the proposal's `payload_text_rendering`, inside governance's own Markdown:
//       # Proposal to execute nervous system function:
//       ## Nervous system function:      (the function record, Rust {:#?} debug text)
//       ## Payload sha256:               (lowercase hex of the payload)
//       ## Payload:                      (the validator's text, verbatim)
//   - When the proposal is adopted, governance calls `target_method_name` on `target_canister_id` with the same bytes.
//   - `get_proposal` returns the rendering, but the payload only when it is at most 64 bytes; a longer payload comes
//     back as a text summary with its SHA-256. `list_proposals` returns neither.
// Fact: the NNS dapp shows `payload_text_rendering` as Markdown (dfinity/nns-dapp 94b6cde,
// SnsProposalPayloadSection.svelte -> ProposalSummary.svelte -> gix-components Markdown).
//
// So the validator's text is what voters read about the call, and it is written by the dapp that proposes it.
// Rendering it from a published profile lets anyone with the payload bytes and the profile render it again and
// compare (`verifySnsRendering`).
//
// Rules (`SNS_RENDERING_RULES`; proposal docs/proposals/w4-sns-validator-rendering.md):
//   1. The body is the generic consent message of spec section 12 with the title at heading level 3, so it nests
//      under governance's `## Payload:`. Times are shown in UTC (`2026-10-09 12:00:00 UTC`, rule 6 of section 12):
//      a proposal has many readers and no user preferences.
//   2. Then the method the rendering describes and its effect (spec section 5.3; the default for an update without
//      an `effect` tag is said to be a default).
//   3. Then the arguments as Candid text with no formatter applied (base units, nanoseconds, bytes), always: there is
//      no signer between the text and the voter to show them (spec section 11 item 1).
//   4. Then where the words come from: every profile with its profile_id, the interface_id, and these rules.
//   5. Anything the generator cannot describe is `Err`, so governance rejects the proposal: an unknown method,
//      bytes that do not decode, an untypeable position, a missing dynamic ref, more than the message limits.
//      A proposal never reaches voters undescribed.

import { createHash } from "node:crypto";
import { c } from "@candid-core/schema";
import { decode, encode } from "@candid-core/schema/codec";
import { MAX_MESSAGE_CHARS, Renderer } from "./display.mjs";
import { bytesOf } from "./bytes.mjs";
import { ConsentError, CODES, fail } from "./errors.mjs";
import { buildModel } from "./model.mjs";
import { renderGeneric } from "./render.mjs";
import { methodOf } from "./resolved.mjs";
import { codeBlock, codeSpan, escapeMarkdown, oneLine } from "./text.mjs";

/** The name and version of the rules this module renders by. Part of every rendering, so a re-render knows what to compare. */
export const SNS_RENDERING_RULES = "candid-profile-sns/v0";

const MAX_ERROR = 1000;
const ValidatorResult = c.variant({ Ok: c.text, Err: c.text });

// ------------------------------------------------------------------------------------------------ rendering

/**
 * The validator method as a function.
 *
 * @param {object} input
 * @param {Uint8Array | ArrayBuffer | number[]} input.payload  `ExecuteGenericNervousSystemFunction.payload`: the Candid
 *   argument bytes of the target method, exactly as governance passes them
 * @param {object} input.resolved  the resolved form of the target canister (docs/profile-v0.md section 10)
 * @param {string} input.method  the target method this validator is registered for (`target_method_name`)
 * @param {Record<string, unknown>} [input.refs]  resolved dynamic refs, keyed by `from`
 * @param {object} [input.limits]  decoder limits
 * @returns {{ Ok: string } | { Err: string }}  plus two non-enumerable properties: `diagnostics` and `provenance`
 */
export function snsValidatorRendering({ payload, resolved, method, refs = {}, limits } = {}) {
  let result;
  let extras = { diagnostics: [], provenance: null };
  try {
    extras = renderSnsPayload({ payload, resolved, method, refs, limits });
    result = { Ok: extras.text };
  } catch (e) {
    result = { Err: errorText(e) };
    extras.diagnostics.push({ code: e instanceof ConsentError ? e.code : "E_INTERNAL", at: "payload", message: String(e?.message ?? e) });
  }
  Object.defineProperty(result, "diagnostics", { value: extras.diagnostics, enumerable: false });
  Object.defineProperty(result, "provenance", { value: extras.provenance, enumerable: false });
  return result;
}

/**
 * The canister-side wrapper: the payload bytes in (the validator method takes the target method's arguments), the
 * Candid-encoded `variant { Ok : text; Err : text }` out.
 *
 * @param {Uint8Array} payload
 * @param {{ resolved: object, method: string, refs?: Record<string, unknown>, limits?: object }} context
 * @returns {Uint8Array}
 */
export function handleSnsValidatorCall(payload, context) {
  return encodeValidatorResult(snsValidatorRendering({ ...context, payload }));
}

/** Candid-encode a validator reply. */
export function encodeValidatorResult(result) {
  const keys = result !== null && typeof result === "object" ? Object.keys(result) : [];
  if (keys.length !== 1 || (keys[0] !== "Ok" && keys[0] !== "Err") || typeof result[keys[0]] !== "string") fail(CODES.REQUEST, "a validator result is { Ok: text } or { Err: text }");
  const r = encode(ValidatorResult, { tag: keys[0], value: result[keys[0]] });
  if (!r.ok) fail(CODES.REQUEST, `the validator result does not encode: ${r.issues[0].code} at ${r.issues[0].path}`);
  return r.bytes;
}

/** Decode a validator reply, as governance does (`Decode!(&reply, Result<String, String>)`). */
export function decodeValidatorResult(bytes) {
  const r = decode(ValidatorResult, bytes);
  if (!r.ok) fail(CODES.DECODE, `not a variant { Ok : text; Err : text }: ${r.issues[0].code} at ${r.issues[0].path}`);
  return { [r.value.tag]: r.value.value };
}

function renderSnsPayload({ payload, resolved, method: name, refs, limits }) {
  const method = methodOf(resolved, name);
  const model = buildModel({ resolved, method: name, arg: payload, limits });
  const renderer = new Renderer({ refs, utcOffsetMinutes: 0, diagnostics: model.diagnostics });
  const blocks = [renderGeneric(model, renderer, { headingLevel: 3 })];
  blocks.push(`**Method:** ${codeSpan(name)}. **Effect:** ${effectText(method)}.`);
  blocks.push(`**Arguments (Candid, as sent, no units applied):**\n\n${codeBlock(renderer.plainTupleText(model.argNodes, model.argValues))}`);
  blocks.push(sourceText(resolved));
  const text = blocks.join("\n\n");
  if (text.length > MAX_MESSAGE_CHARS) fail(CODES.TOO_LARGE, `the rendering would exceed ${MAX_MESSAGE_CHARS} characters; it is never truncated`);
  return { text, diagnostics: model.diagnostics, provenance: model.provenance };
}

const isQuery = (method) => method.mode === "query" || method.mode === "composite_query";

/**
 * The effect kind and reversibility (spec section 5.3), and whether a profile stated them. The resolver writes the
 * section 5.3 default with origin "default" when no profile has an `effect` tag; this says so instead of passing a
 * default off as the author's word.
 */
function effectText(method) {
  const tag = method.tags?.effect;
  const query = isQuery(method);
  const kind = typeof tag?.args?.kind === "string" ? tag.args.kind : query ? "read" : "write";
  const irreversible = typeof tag?.args?.irreversible === "boolean" ? tag.args.irreversible : tag ? null : !query;
  const reversibility = kind === "read" || irreversible === null ? "" : irreversible ? ", irreversible" : ", reversible";
  const stated = tag !== undefined && tag.origin !== "default";
  const note = stated ? "" : ` (the default for ${query ? "a query" : "an update"}; no profile states an effect)`;
  return `${escapeMarkdown(oneLine(kind))}${reversibility}${note}`;
}

function sourceText(resolved) {
  const lines = [];
  const profiles = Array.isArray(resolved.profiles) ? resolved.profiles : [];
  for (const p of profiles) {
    const id = typeof p?.profile_id === "string" ? `: ${codeSpan(p.profile_id)}` : "";
    lines.push(`- Profile ${codeSpan(String(p?.name ?? "(unnamed)"))} (${escapeMarkdown(oneLine(String(p?.origin ?? "unknown origin")))})${id}`);
  }
  if (profiles.length === 0) lines.push("- No profile: every argument is listed as Candid");
  if (typeof resolved.interface_id === "string") lines.push(`- Interface: ${codeSpan(resolved.interface_id)}`);
  lines.push(`- Rules: ${codeSpan(SNS_RENDERING_RULES)}`);
  return `**Rendered from:**\n\n${lines.join("\n")}`;
}

function errorText(e) {
  const s = e instanceof ConsentError ? `${e.code}: ${e.message}` : `E_INTERNAL: ${String(e?.message ?? e)}`;
  return s.length > MAX_ERROR ? `${s.slice(0, MAX_ERROR)}...` : s;
}

// ------------------------------------------------------------------------------------------------ the reviewer's check

const HEAD = "# Proposal to execute nervous system function:\n\n## Nervous system function:\n\n";
const SHA_HEAD = "\n\n## Payload sha256: \n\n";
const PAYLOAD_HEAD = "\n\n## Payload:\n\n";
const SUMMARY_MARK = "NOT THE ORIGINAL CONTENTS OF THIS FIELD";

const DEBUG_STRING = String.raw`"(?:[^"\\\n]|\\.)*"`;
const DEBUG_PRINCIPAL = "[a-z0-9]+(?:-[a-z0-9]+)+";
/** `field: None,` or `field: Some(` value `),` on lines of their own at `indent` spaces, as `{:#?}` prints an Option. */
const optionField = (indent, field, value) => {
  const pad = " ".repeat(indent);
  return `${pad}${field}: (?:None|Some\\(\\n${pad}    (${value}),\\n${pad}\\)),\\n`;
};
/**
 * The whole function block, exactly as `{:#?}` prints a generic NervousSystemFunction (dfinity/ic 649156c): one field
 * per line at a fixed indent. Debug strings escape line breaks and quotes, so text in the name or the description stays
 * on its own line and can never pass for a field. Groups: description, target canister, target method, validator
 * canister, validator method, topic.
 */
const FUNCTION_BLOCK = new RegExp(
  "^NervousSystemFunction \\{\\n" +
    "    id: \\d+,\\n" +
    `    name: ${DEBUG_STRING},\\n` +
    optionField(4, "description", DEBUG_STRING) +
    "    function_type: Some\\(\\n" +
    "        GenericNervousSystemFunction\\(\\n" +
    "            GenericNervousSystemFunction \\{\\n" +
    optionField(16, "target_canister_id", DEBUG_PRINCIPAL) +
    optionField(16, "target_method_name", DEBUG_STRING) +
    optionField(16, "validator_canister_id", DEBUG_PRINCIPAL) +
    optionField(16, "validator_method_name", DEBUG_STRING) +
    optionField(16, "topic", "[A-Za-z]+") +
    "            \\},\\n" +
    "        \\),\\n" +
    "    \\),\\n" +
    "\\}$",
);

/**
 * Split a stored `payload_text_rendering` into governance's parts. Strings in the function block are Rust debug text,
 * which escapes line breaks, so the first `## Payload sha256:` header after the function block is governance's own.
 * The function block must be the generic function's debug text exactly (`FUNCTION_BLOCK`); anything else is not
 * governance's layout, and the fields are read only from their own lines.
 *
 * @param {string} text
 * @returns {{ functionText: string, payloadSha256: string, payloadRendering: string, targetMethod: string | null,
 *   targetCanisterId: string | null, validatorMethod: string | null, validatorCanisterId: string | null } | null}
 */
export function parseGovernanceRendering(text) {
  if (typeof text !== "string" || !text.startsWith(HEAD)) return null;
  const sha = text.indexOf(SHA_HEAD, HEAD.length);
  if (sha < 0) return null;
  const hexStart = sha + SHA_HEAD.length;
  const payloadSha256 = text.slice(hexStart, hexStart + 64);
  if (!/^[0-9a-f]{64}$/.test(payloadSha256) || !text.startsWith(PAYLOAD_HEAD, hexStart + 64)) return null;
  const functionText = text.slice(HEAD.length, sha);
  const fn = FUNCTION_BLOCK.exec(functionText);
  if (fn === null) return null;
  const debugString = (s) => (s === undefined ? null : s.slice(1, -1).replace(/\\(.)/g, "$1"));
  return {
    functionText,
    payloadSha256,
    payloadRendering: text.slice(hexStart + 64 + PAYLOAD_HEAD.length),
    targetMethod: debugString(fn[3]),
    targetCanisterId: fn[2] ?? null,
    validatorMethod: debugString(fn[5]),
    validatorCanisterId: fn[4] ?? null,
  };
}

/**
 * The reviewer's check of an SNS proposal that executes a generic nervous system function: do the payload bytes the
 * proposer published hash to what governance recorded, does the function call the canister and the method the profile
 * describes, and is the validator's text exactly what the profile renders for those bytes?
 *
 * @param {object} input
 * @param {string} input.payloadTextRendering  `ProposalData.payload_text_rendering`, from `get_proposal`
 * @param {Uint8Array | ArrayBuffer | number[]} input.payload  the payload bytes, from the proposer (`get_proposal`
 *   returns them only up to 64 bytes)
 * @param {object} input.resolved  the resolved form of the target canister
 * @param {string} input.targetCanisterId  the canister the profile describes, as text: the one the reviewer expects
 *   governance to call. A resolved form names no canister, so without it the `target_canister` check fails.
 * @param {string} input.method  the method the reviewer expects the proposal to call
 * @param {Record<string, unknown>} [input.refs]
 * @param {object} [input.limits]
 * @returns {{ ok: boolean, checks: Array<{ name: string, ok: boolean, expected?: string, found?: string | null, note?: string }>,
 *   expectedRendering: string | null, parsed: object | null }}
 */
export function verifySnsRendering({ payloadTextRendering, payload, resolved, targetCanisterId, method, refs = {}, limits }) {
  const checks = [];
  const parsed = parseGovernanceRendering(payloadTextRendering);
  checks.push({ name: "governance_layout", ok: parsed !== null, ...(parsed === null ? { note: "not the rendering SNS governance stores for an ExecuteGenericNervousSystemFunction proposal" } : {}) });

  const bytes = toBytes(payload);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const summary = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes).includes(SUMMARY_MARK);
  checks.push({
    name: "payload_sha256",
    ok: parsed !== null && parsed.payloadSha256 === digest,
    expected: digest,
    found: parsed?.payloadSha256 ?? null,
    ...(summary ? { note: "these bytes are get_proposal's summary of a payload over 64 bytes, not the payload; get the original bytes from the proposer" } : {}),
  });

  const expectedTarget = typeof targetCanisterId === "string" ? targetCanisterId : null;
  checks.push({
    name: "target_canister",
    ok: parsed !== null && expectedTarget !== null && parsed.targetCanisterId === expectedTarget,
    expected: expectedTarget,
    found: parsed?.targetCanisterId ?? null,
    ...(expectedTarget === null ? { note: "give targetCanisterId, the canister the profile describes: a function may target another canister with the same method" } : {}),
  });

  checks.push({
    name: "target_method",
    ok: parsed !== null && parsed.targetMethod === method,
    expected: method,
    found: parsed?.targetMethod ?? null,
  });

  const r = snsValidatorRendering({ payload: bytes, resolved, method, refs, limits });
  checks.push({
    name: "payload_rendering",
    ok: parsed !== null && "Ok" in r && parsed.payloadRendering === r.Ok,
    ...("Err" in r ? { note: `the profile cannot render these bytes: ${r.Err}` } : {}),
  });
  return { ok: checks.every((x) => x.ok), checks, expectedRendering: r.Ok ?? null, parsed };
}

function toBytes(payload) {
  return bytesOf(payload) ?? fail(CODES.REQUEST, "the payload must be bytes: a Uint8Array, an ArrayBuffer or an array of integers 0 to 255");
}
