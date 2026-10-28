// EVM calldata -> the consent text of a call (spec section 15, D-054). ICRC-21 is the Internet Computer's, so an EVM
// call gets the same model and the same two layouts without the ICRC-21 envelope: the generic form (Markdown) and the
// fields form as plain text.
//
// Steps:
//   1. the resolved form must be an EVM contract's (`chain: "evm"`), and the call's target, when a profile lists
//      deployments, one of them (a profile describes the contracts it binds, never a look-alike);
//   2. the selector picks the function; its `signature` gives the parameter types, and calldata is decoded strictly
//      (`@meantjs/profile/evm` decodeParams: anything but the canonical encoding of the values read is refused);
//   3. the resolved tree is read as a Candid-shaped view (a tuple is a record, an array a vec), so the template, the
//      paths and the fields are those of a Candid call (model.mjs);
//   4. the text ends with the contract's address and chain: a pack applies to any contract whose functions match, so a
//      person must see which contract asks (spec section 11).
//
// Refused: a payable function (its native value has no position yet, O2), and a call with no matching selector.

import { AbiError, decodeParams, parseSignature, readAddress } from "@meantjs/profile/evm";
import { Renderer } from "./display.mjs";
import { CODES, ConsentError, fail } from "./errors.mjs";
import { modelOf } from "./model.mjs";
import { renderGeneric, renderPlain } from "./render.mjs";
import { abiView, methodOf } from "./resolved.mjs";
import { codeSpan } from "./text.mjs";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function bytesOf(calldata) {
  if (calldata instanceof Uint8Array) return calldata;
  if (typeof calldata === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(calldata)) return Uint8Array.from(calldata.slice(2).match(/../g) ?? [], (h) => parseInt(h, 16));
  fail(CODES.REQUEST, "calldata must be a Uint8Array or 0x hex text");
}

function chainOf(chainId) {
  if (chainId === undefined || chainId === null) return null;
  const s = typeof chainId === "number" && Number.isSafeInteger(chainId) ? String(chainId) : typeof chainId === "bigint" ? chainId.toString() : chainId;
  if (typeof s !== "string" || !/^[1-9][0-9]{0,19}$/.test(s)) fail(CODES.REQUEST, `chainId must be a positive integer, got ${String(chainId)}`);
  return s;
}

/** The function of a selector, from the resolved form; its signature is checked against the selector. */
function functionOf(resolved, selector) {
  const hit = Object.entries(resolved.methods).find(([, m]) => isObject(m) && m.selector === selector);
  if (!hit) fail(CODES.METHOD_UNKNOWN, `the resolved form has no function with selector ${selector}`);
  const [name, method] = hit;
  let f;
  try {
    f = parseSignature(String(method.signature), `methods.${name}.signature`);
  } catch (e) {
    if (e instanceof AbiError) fail(CODES.RESOLVED_FORM, e.message);
    throw e;
  }
  if (f.name !== name || f.selector !== selector) fail(CODES.RESOLVED_FORM, `methods.${name}: the signature ${method.signature} does not hash to ${selector}`);
  return { name, method: methodOf(resolved, name, "evm"), f };
}

/**
 * Decode one EVM call against a resolved form: which function, and its arguments.
 *
 * @param {object} resolved  an EVM contract's resolved form (`chain: "evm"`)
 * @param {Uint8Array | string} calldata  the selector and the ABI-encoded arguments
 * @param {{ maxBytes?: number, maxDepth?: number, maxElements?: number }} [limits]
 * @returns {{ method: string, selector: string, values: Record<string, unknown> }}
 */
export function decodeCalldata(resolved, calldata, limits) {
  if (!isObject(resolved) || resolved.format !== "candid-profile-resolved" || !isObject(resolved.methods) || resolved.chain !== "evm") methodOf(resolved, "", "evm"); // throws the right error
  const data = bytesOf(calldata);
  if (data.length < 4) fail(CODES.DECODE, `calldata of ${data.length} bytes has no selector`);
  const selector = `0x${[...data.subarray(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const { name, f } = functionOf(resolved, selector);
  try {
    return { method: name, selector, values: decodeParams(f.inputs, data.subarray(4), limits) };
  } catch (e) {
    if (e instanceof AbiError) throw new ConsentError(CODES.DECODE, `${name}: ${e.message}`, { cause: e });
    throw e;
  }
}

/** Every profile that lists deployments must list this one (chain id and address). */
function checkTarget(resolved, to, chain) {
  for (const p of Array.isArray(resolved.profiles) ? resolved.profiles : []) {
    if (!Array.isArray(p?.deployments)) continue;
    if (chain === null) fail(CODES.REQUEST, `profile ${p.name} binds deployments: give the chainId of the call`);
    const listed = p.deployments.some((d) => String(d.chain_id) === chain && typeof d.address === "string" && d.address.toLowerCase() === to.toLowerCase());
    if (!listed) fail(CODES.DEPLOYMENT, `profile ${p.name} describes ${p.deployments.map((d) => `${d.address} on chain ${d.chain_id}`).join(", ")}, not ${to} on chain ${chain}`);
  }
}

/**
 * The consent text of an EVM call.
 *
 * @param {object} input
 * @param {object} input.resolved  an EVM contract's resolved form
 * @param {Uint8Array | string} input.calldata
 * @param {string} input.to  the contract called (shown, and checked against the profiles' deployments)
 * @param {number | bigint | string} [input.chainId]  needed when a profile lists deployments
 * @param {Record<string, unknown>} [input.refs]  resolved dynamic refs, for example { "query:decimals": 6, "query:symbol": "USDC" }
 * @param {"generic" | "fields"} [input.form]  default "generic"
 * @param {number | null} [input.utcOffsetMinutes]  generic form only (default 0, UTC)
 * @param {boolean} [input.rawArguments]  append the decoded arguments (spec section 11 item 1)
 * @param {object} [input.limits]  decoder limits (maxBytes, maxDepth, maxElements)
 * @returns {{ form: string, message: string | { intent: string, fields: Array<[string, string]> }, method: string, selector: string, to: string, chainId: string | null, diagnostics: object[], provenance: object, model: object }}
 */
export function evmConsent({ resolved, calldata, to, chainId, refs = {}, form = "generic", utcOffsetMinutes = null, rawArguments = false, limits }) {
  if (form !== "generic" && form !== "fields") fail(CODES.REQUEST, `form must be "generic" or "fields", got ${JSON.stringify(form)}`);
  let target;
  try {
    target = readAddress(to);
  } catch (e) {
    if (e instanceof AbiError) fail(CODES.REQUEST, `to: ${e.message}`);
    throw e;
  }
  const chain = chainOf(chainId);
  const { method: name, selector, values } = decodeCalldata(resolved, calldata, limits);
  checkTarget(resolved, target, chain);
  const method = methodOf(resolved, name, "evm");
  if (method.state_mutability === "payable") fail(CODES.UNSUPPORTED_TYPE, `${name} is payable: the native value a call sends has no position in a profile yet (spec section 15, O2)`);
  const viewed = { ...method, args: method.args.map((n, i) => abiView(n, `${name}(${i})`)) };
  const model = modelOf(resolved, name, viewed, viewed.args.length ? [values] : []);
  const where = `${target}${chain === null ? "" : ` on chain ${chain}`}`;
  const done = (rest) => ({ ...rest, method: name, selector, to: target, chainId: chain, diagnostics: model.diagnostics, provenance: model.provenance, model });
  if (form === "fields") {
    const plain = renderPlain(model, new Renderer({ refs, diagnostics: model.diagnostics }), { rawArguments });
    plain.fields.push(["Contract", where]);
    return done({ form, message: plain });
  }
  const renderer = new Renderer({ refs, utcOffsetMinutes: utcOffsetMinutes ?? 0, diagnostics: model.diagnostics });
  const text = `${renderGeneric(model, renderer, { rawArguments })}\n\n**Contract:** ${codeSpan(target)}${chain === null ? "" : ` on chain ${chain}`}`;
  return done({ form, message: text });
}
