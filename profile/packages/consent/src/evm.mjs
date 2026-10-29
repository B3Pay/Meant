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
//
// A typed message (EIP-712, spec section 15.9) is the other thing an EVM wallet is asked to sign: `eip712Consent`
// gives it the same model and layouts, after checking that the request is the message a profile describes (its chain,
// its contract, its domain, its type hash) and reading its values strictly. An amount whose token a field names is
// shown with that token's decimals and symbol, which the caller supplies per address (`tokens`), and its address.

import { AbiError, DEFAULT_ABI_LIMITS, decodeParams, eip712TypeHash, keccak256Hex, parseEip712Types, parseSignature, readAddress, typedDataDigest } from "@meantjs/profile/evm";
import { Renderer, TokenAmount } from "./display.mjs";
import { CODES, ConsentError, fail } from "./errors.mjs";
import { modelOf } from "./model.mjs";
import { resolvePath } from "./paths.mjs";
import { renderGeneric, renderPlain } from "./render.mjs";
import { abiView, entriesOf, methodOf, tagArgs } from "./resolved.mjs";
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

/** The caller's `tokens`: the decimals and symbol of each token, keyed by its address in any valid spelling. */
function tokenTable(tokens) {
  if (!isObject(tokens)) fail(CODES.REQUEST, "tokens must be an object of token address to { decimals, symbol }");
  const out = new Map();
  for (const [k, v] of Object.entries(tokens)) {
    let address;
    try {
      address = readAddress(k);
    } catch (e) {
      if (e instanceof AbiError) fail(CODES.REQUEST, `tokens: ${e.message}`);
      throw e;
    }
    if (!isObject(v)) fail(CODES.REQUEST, `tokens[${JSON.stringify(k)}] must be { decimals, symbol }`);
    if (out.has(address)) fail(CODES.REQUEST, `tokens lists ${address} twice`);
    out.set(address, { decimals: v.decimals, symbol: v.symbol });
  }
  return out;
}

/**
 * The arguments with each amount whose token a field names (spec section 15.9) made a TokenAmount: its base units, the
 * address that field holds in the same array element, and that token's metadata from `tokens`. A token the caller did
 * not describe stops the message (E_REF_UNRESOLVED): a number without its decimals is never shown (spec section 12
 * rule 10).
 */
function withTokens(name, viewed, args, tokens) {
  const box = (node, value, keys, indices) => {
    if (node.candid === "record") return Object.fromEntries(entriesOf(node.fields).map(([k, child]) => [k, box(child, value[k], [...keys, k], indices)]));
    if (node.candid === "vec") return value.map((e, i) => box(node.element, e, [...keys, "[]"], [...indices, i]));
    const token = tagArgs(node, "amount")?.token;
    if (token === undefined) return value;
    const where = `${name}(0)${keys.map((k) => (k === "[]" ? "[]" : `.${k}`)).join("")}`;
    const rp = resolvePath(viewed, String(token));
    let address = rp.error ? undefined : args[rp.index];
    let n = 0;
    for (const step of rp.steps ?? []) address = step.kind === "elem" ? address?.[indices[n++]] : address?.[step.key];
    if (typeof address !== "string" || rp.node.abi !== "address" || n > indices.length) fail(CODES.RESOLVED_FORM, `${where}: amount.token ${JSON.stringify(token)} does not lead to an address in the same element`);
    if (!tokens.has(address)) fail(CODES.REF_UNRESOLVED, `${where} is an amount of the token ${address}, whose decimals and symbol were not given (tokens); without them it has no text`);
    return new TokenAmount(value, address, tokens.get(address));
  };
  return args.map((v, i) => box(viewed.args[i], v, [], []));
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
 * @param {Record<string, { decimals: number, symbol?: string }>} [input.tokens]  for an amount whose token a field
 *   names (spec section 15.9): each such token's decimals() and symbol(), keyed by its address
 * @param {"generic" | "fields"} [input.form]  default "generic"
 * @param {number | null} [input.utcOffsetMinutes]  generic form only (default 0, UTC)
 * @param {boolean} [input.rawArguments]  append the decoded arguments (spec section 11 item 1)
 * @param {object} [input.limits]  decoder limits (maxBytes, maxDepth, maxElements)
 * @returns {{ form: string, message: string | { intent: string, fields: Array<[string, string]> }, method: string, selector: string, to: string, chainId: string | null, diagnostics: object[], provenance: object, model: object }}
 */
export function evmConsent({ resolved, calldata, to, chainId, refs = {}, tokens = {}, form = "generic", utcOffsetMinutes = null, rawArguments = false, limits }) {
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
  const model = modelOf(resolved, name, viewed, viewed.args.length ? withTokens(name, viewed, [values], tokenTable(tokens)) : []);
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

// ---------------------------------------------------------------------------------------------- EIP-712 messages

/** The domain's fields in the order EIP-712 lists them, with their types. */
const DOMAIN_FIELDS = [
  ["name", "string"],
  ["version", "string"],
  ["chainId", "uint256"],
  ["verifyingContract", "address"],
  ["salt", "bytes32"],
];

/** One value of a typed message, read strictly (spec section 15.9): the shapes decodeCalldata gives, or E_DECODE. */
function readTyped(types, type, value, where, budget) {
  const bad = (message) => fail(CODES.DECODE, `${where}: ${message}`);
  const arr = /^(.*)\[(\d*)\]$/.exec(type);
  if (arr) {
    if (!Array.isArray(value)) bad(`${type} needs an array`);
    if (arr[2] !== "" && value.length !== Number(arr[2])) bad(`${type} needs ${arr[2]} elements, got ${value.length}`);
    budget.elements += value.length;
    if (budget.elements > budget.maxElements) bad(`more than ${budget.maxElements} array elements in the message`);
    return value.map((v, i) => readTyped(types, arr[1], v, `${where}[${i}]`, budget));
  }
  if (Object.hasOwn(types, type)) {
    if (!isObject(value)) bad(`${type} needs an object of its members`);
    const members = types[type];
    for (const k of Object.keys(value)) if (!members.some((m) => m.name === k)) bad(`${type} has no member ${JSON.stringify(k)}`);
    return Object.fromEntries(members.map((m) => [m.name, Object.hasOwn(value, m.name) ? readTyped(types, m.type, value[m.name], `${where}.${m.name}`, budget) : bad(`${type} needs its member ${m.name}`)]));
  }
  const int = /^(u?)int([0-9]+)$/.exec(type);
  if (int) {
    let x;
    if (typeof value === "number" && Number.isSafeInteger(value)) x = BigInt(value);
    else if (typeof value === "string" && /^-?(?:0|[1-9][0-9]*)$/.test(value) && value !== "-0") x = BigInt(value);
    else bad(`${type} needs a decimal string or a JSON integer below 2^53, got ${JSON.stringify(value)}`);
    const bits = BigInt(int[2]);
    const [min, max] = int[1] === "u" ? [0n, 2n ** bits - 1n] : [-(2n ** (bits - 1n)), 2n ** (bits - 1n) - 1n];
    if (x < min || x > max) bad(`${x} is outside ${type}`);
    return x.toString();
  }
  if (type === "address") {
    try {
      return readAddress(value);
    } catch (e) {
      if (e instanceof AbiError) bad(e.message);
      throw e;
    }
  }
  if (type === "bool") return typeof value === "boolean" ? value : bad("bool needs true or false");
  if (type === "string") return typeof value === "string" && value.isWellFormed() ? value : bad("string needs well-formed text");
  const bytes = /^bytes([0-9]*)$/.exec(type);
  if (bytes) {
    if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) bad(`${type} needs 0x and hex digits`);
    const b = Uint8Array.from(value.slice(2).match(/../g) ?? [], (h) => parseInt(h, 16));
    if (bytes[1] !== "" && b.length !== Number(bytes[1])) bad(`${type} needs ${bytes[1]} bytes, got ${b.length}`);
    if (b.length > budget.maxBytes) bad(`${b.length} bytes is over the limit of ${budget.maxBytes}`);
    return b;
  }
  bad(`unknown type ${type}`);
}

/** The request's domain: only EIP-712's fields, no salt (O3), and its EIP712Domain type, if given, exactly those fields. */
function readDomain(domain, declared) {
  if (!isObject(domain)) fail(CODES.REQUEST, "typedData.domain must be an object");
  for (const k of Object.keys(domain)) if (!DOMAIN_FIELDS.some(([f]) => f === k)) fail(CODES.DOMAIN, `the domain has a field ${JSON.stringify(k)} EIP-712 does not define`);
  if (Object.hasOwn(domain, "salt")) fail(CODES.DOMAIN, "a domain with a salt is not supported yet (spec section 15.9, O3)");
  const fields = DOMAIN_FIELDS.filter(([k]) => Object.hasOwn(domain, k)).map(([name, type]) => ({ name, type }));
  // Each member's name and type, in order; the order of a member's JSON keys is not part of the type (as for the other structs).
  const same = Array.isArray(declared) && declared.length === fields.length && declared.every((m, i) => isObject(m) && m.name === fields[i].name && m.type === fields[i].type);
  if (declared !== undefined && !same) {
    fail(CODES.DOMAIN, `types.EIP712Domain must list the domain's fields in EIP-712 order (${fields.map((f) => `${f.type} ${f.name}`).join(", ")})`);
  }
  for (const k of ["name", "version"]) if (Object.hasOwn(domain, k) && typeof domain[k] !== "string") fail(CODES.DOMAIN, `domain.${k} must be a string`);
  if (!Object.hasOwn(domain, "chainId")) fail(CODES.DOMAIN, "the domain has no chainId, so the signature is valid on every chain; it is refused");
  if (!Object.hasOwn(domain, "verifyingContract")) fail(CODES.DOMAIN, "the domain has no verifyingContract: the contract that will act on the signature must be known");
  const chain = readTyped({}, "uint256", domain.chainId, "domain.chainId", { elements: 0, maxElements: 0, maxBytes: 0 });
  let contract;
  try {
    contract = readAddress(domain.verifyingContract);
  } catch (e) {
    if (e instanceof AbiError) fail(CODES.DOMAIN, `domain.verifyingContract: ${e.message}`);
    throw e;
  }
  return { fields, chain, contract };
}

/** The message of a resolved form whose type hash is the request's; the entry's own encode_type must hash to it. */
function messageOf(resolved, primaryType, typeHash) {
  if (!isObject(resolved) || resolved.format !== "candid-profile-resolved" || !isObject(resolved.methods) || resolved.chain !== "evm") methodOf(resolved, "", "evm"); // throws the right error
  if (!isObject(resolved.messages)) fail(CODES.TYPE_HASH, "the resolved form describes no EIP-712 message");
  const hit = entriesOf(resolved.messages).find(([, m]) => isObject(m) && m.type_hash === typeHash);
  if (!hit) fail(CODES.TYPE_HASH, `no message of the resolved form has the type hash ${typeHash} (${primaryType}); a request is matched by its type hash, never by its name`);
  const [name, m] = hit;
  if (typeof m.encode_type !== "string" || `0x${keccak256Hex(m.encode_type)}` !== typeHash || name !== primaryType || !m.encode_type.startsWith(`${name}(`)) {
    fail(CODES.RESOLVED_FORM, `messages.${name}: its encode_type does not hash to its type_hash, or names another type`);
  }
  if (!Array.isArray(m.args) || m.args.length !== 1) fail(CODES.RESOLVED_FORM, `messages.${name} has no args array of one struct`);
  return { name, message: m };
}

/**
 * Every profile that names the domain (`eip712_domain`) must name the request's: its name and its version each equal,
 * and absent where the profile's is absent (Permit2's domain has no version; one with a version is another domain).
 */
function checkDomain(resolved, domain) {
  for (const p of Array.isArray(resolved.profiles) ? resolved.profiles : []) {
    if (!isObject(p?.eip712_domain)) continue;
    for (const k of ["name", "version"]) {
      const v = p.eip712_domain[k];
      if (domain[k] === v) continue;
      const theirs = domain[k] === undefined ? "a domain without one" : JSON.stringify(domain[k]);
      fail(CODES.DOMAIN, v === undefined ? `profile ${p.name} describes a domain without a ${k}, not one whose ${k} is ${theirs}` : `profile ${p.name} describes the domain whose ${k} is ${JSON.stringify(v)}, not ${theirs}`);
    }
  }
}

/**
 * The consent text of an EIP-712 signing request (spec section 15.9): the message a profile describes, its values in
 * words, and what a signature is. Refused before anything is shown when the request does not match: a domain for
 * another chain than the wallet's or without a chainId or verifyingContract (E_DOMAIN), a contract its profiles do not
 * list (E_DEPLOYMENT), a domain name or version other than its profiles' (E_DOMAIN), no message with the request's
 * type hash (E_TYPE_HASH), a message whose values are not exactly its members, canonically written (E_DECODE).
 *
 * @param {object} input
 * @param {object} input.resolved  an EVM contract's resolved form with `messages`
 * @param {{ types: object, primaryType: string, domain: object, message: object }} input.typedData  the request
 *   (`eth_signTypedData_v4`'s JSON); `types.EIP712Domain` may be left out
 * @param {number | bigint | string} input.chainId  the wallet's active chain
 * @param {Record<string, unknown>} [input.refs]  resolved dynamic refs: `query:` refs are calls to the verifying contract
 * @param {Record<string, { decimals: number, symbol?: string }>} [input.tokens]  each token an amount's `token` names
 * @param {"generic" | "fields"} [input.form]  default "generic"
 * @param {number | null} [input.utcOffsetMinutes]  generic form only (default 0, UTC)
 * @param {boolean} [input.rawArguments]  append the message's values (spec section 11 item 1)
 * @param {{ maxBytes?: number, maxElements?: number }} [input.limits]
 */
export function eip712Consent({ resolved, typedData, chainId, refs = {}, tokens = {}, form = "generic", utcOffsetMinutes = null, rawArguments = false, limits = {} }) {
  if (form !== "generic" && form !== "fields") fail(CODES.REQUEST, `form must be "generic" or "fields", got ${JSON.stringify(form)}`);
  if (!isObject(typedData) || !isObject(typedData.types) || typeof typedData.primaryType !== "string" || !isObject(typedData.message)) {
    fail(CODES.REQUEST, "typedData must be { types, primaryType, domain, message }");
  }
  const active = chainOf(chainId);
  if (active === null) fail(CODES.REQUEST, "give the wallet's active chainId: a signature for another chain is refused");
  const { EIP712Domain: declared, ...own } = typedData.types;
  const { fields: domainType, chain, contract } = readDomain(typedData.domain, declared);
  if (chain !== active) fail(CODES.DOMAIN, `the domain is for chain ${chain}, the wallet is on chain ${active}`);
  const parsed = parseEip712Types(own, "typedData.types");
  if (parsed.errors.length) fail(CODES.REQUEST, parsed.errors.map((e) => `${e.at}: ${e.message}`).join("; "));
  if (!Object.hasOwn(parsed.types, typedData.primaryType)) fail(CODES.REQUEST, `typedData.types has no ${JSON.stringify(typedData.primaryType)}`);
  const typeHash = eip712TypeHash(parsed.types, typedData.primaryType);
  const { name, message } = messageOf(resolved, typedData.primaryType, typeHash);
  checkTarget(resolved, contract, chain);
  checkDomain(resolved, typedData.domain);

  const budget = { elements: 0, maxElements: limits.maxElements ?? DEFAULT_ABI_LIMITS.maxElements, maxBytes: limits.maxBytes ?? DEFAULT_ABI_LIMITS.maxBytes };
  const values = readTyped(parsed.types, name, typedData.message, "message", budget);
  let digest;
  try {
    digest = typedDataDigest({ domain: typedData.domain, types: { ...parsed.types, EIP712Domain: domainType }, primaryType: name, message: typedData.message });
  } catch (e) {
    if (e instanceof AbiError) fail(CODES.DECODE, e.message);
    throw e;
  }
  const viewed = { ...message, args: message.args.map((n, i) => abiView(n, `${name}(${i})`)) };
  const model = modelOf(resolved, name, viewed, withTokens(name, viewed, [values], tokenTable(tokens)));
  const where = `${contract} on chain ${chain}`;
  const done = (rest) => ({ ...rest, primaryType: name, typeHash, digest, verifyingContract: contract, chainId: chain, diagnostics: model.diagnostics, provenance: model.provenance, model });
  if (form === "fields") {
    const plain = renderPlain(model, new Renderer({ refs, diagnostics: model.diagnostics }), { rawArguments });
    plain.fields.push(["Contract", where], ["Signature", SIGNATURE_NOTE], ["EIP-712 digest", digest]);
    return done({ form, message: plain });
  }
  const renderer = new Renderer({ refs, utcOffsetMinutes: utcOffsetMinutes ?? 0, diagnostics: model.diagnostics });
  const text = `${renderGeneric(model, renderer, { rawArguments })}\n\n**Contract:** ${codeSpan(contract)} on chain ${chain}\n\n**EIP-712 digest:** ${codeSpan(digest)}\n\n${SIGNATURE_NOTE}.`;
  return done({ form, message: text });
}

/** What a typed-data signature is, said with every message (spec section 15.9). */
const SIGNATURE_NOTE = "This is a signature, not a transaction: whoever holds it can submit it";
