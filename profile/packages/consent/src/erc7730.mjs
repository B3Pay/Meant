// ERC-7730 clear-signing files from an EVM contract's resolved form, and the ERC-8176 attestation a reviewer signs for
// one (spec section 15, D-054). `@meantjs/consent/erc7730`.
//
// The file is the display half of a profile: per function a transaction calls, its `intent` (the intent title), its
// `interpolatedIntent` (the template) and one field per leaf of its parameters. The same resolved form always gives
// the same file, so the same `descriptorHash`. What a profile says that an ERC-7730 file cannot say is refused
// (E_EXPORT), never written as something near it:
//
//   amount      tokenAmount of the contract's own token (`tokenPath: "@.to"`): decimals and symbol read from the
//               ERC-20 `decimals()` and `symbol()`, or given literally and carried as `metadata.token` when the
//               caller says the contract is that token (`options.token`); `threshold` and `message` one to one.
//               Refused otherwise (another method, a symbol missing, a token named by an argument).
//   timestamp   `date` with `encoding: "timestamp"`, seconds only      duration   `duration`, seconds only
//   bytes       `raw` (hex), hex only                                    address    `addressName`
//   the rest    `raw`; `describe.label` is the label, else the parameter's name
//   payable     one more field, `@.value` as `amount` (the native value, which ERC-7730 wallets know and a profile
//               has no position for yet, O2)
//
// The descriptor binds to deployments (ERC-7730 `context.contract.deployments`): the profile's, or the caller's when
// every profile that lists deployments lists them too. `effect`, `idempotency`, `outcome` and the other agent tags
// have no ERC-7730 form and are left out: the file carries what a call says, not what it does.
//
// EIP-712 messages (spec section 15.9) are a file of their own (`options.context: "eip712"`): ERC-7730 binds a file to
// a contract or to messages, not both. Its formats are keyed by each message's `encode_type`, whose Keccak-256 must be
// the message's `type_hash`; `context.eip712` carries the deployments and the domain name and version the profiles
// give. An amount whose token a field names is `tokenAmount` with that field's path, inside a field group of the array
// the two share, as ERC-7730's PermitBatch example writes it.
//
// Some words a profile adds have no ERC-7730 form but change no value: a timestamp's `threshold`, `message` and
// `labels` (written as a plain date), and an intent template ERC-7730 cannot interpolate (an array, a whole tuple, a
// [ ] segment; `interpolatedIntent` is optional and a wallet falls back to `intent`). They are left out, and each is
// returned as a note, instead of refusing the file.

import { AbiError, jcs, keccak256Hex, parseSignature, readAddress, typedDataDigest } from "@meantjs/profile/evm";
import { CODES, fail } from "./errors.mjs";
import { resolvePath } from "./paths.mjs";
import { abiView, entriesOf, labelOf, methodOf, tagArgs } from "./resolved.mjs";
import { parseTemplate } from "./template.mjs";

/** The exact-version schema every exported file names: an alias would move the hash when the alias moves. */
export const ERC7730_SCHEMA_URL = "https://eips.ethereum.org/assets/eip-7730/erc7730-v2.1.0.schema.json";
/** ERC-8176's canonical EAS schema, `bytes32 descriptorHash` (no resolver, revocable). */
export const ERC8176_SCHEMA_UID = "0xe023eef113c1670774801c34b377fdf612dd8a4d2fa92fe382e15bd91fafb5c2";
/** The canonical EAS contract on Ethereum mainnet: the verifying contract of an offchain attestation. */
export const EAS_ADDRESS = "0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587";

const ZERO32 = `0x${"0".repeat(64)}`;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const OPTIONS = new Set(["context", "deployments", "owner", "contractName", "info", "token"]);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";

/** `{ chainId, address }` of the caller or `{ chain_id, address }` of a profile, checked; null when not one. */
function deploymentOf(d) {
  const chainId = d?.chainId ?? d?.chain_id;
  if (!Number.isSafeInteger(chainId) || chainId < 1) return null;
  try {
    return { chainId, address: readAddress(d.address) };
  } catch (e) {
    if (e instanceof AbiError) return null;
    throw e;
  }
}

function deploymentsOf(resolved, given) {
  const key = (d) => `${d.chainId}:${d.address}`;
  const listing = (Array.isArray(resolved.profiles) ? resolved.profiles : []).filter((p) => Array.isArray(p?.deployments));
  const sets = listing.map((p) => ({ name: p.name, keys: new Set(p.deployments.map(deploymentOf).filter(Boolean).map(key)) }));
  let out;
  if (given !== undefined) {
    if (!Array.isArray(given) || given.length === 0) fail(CODES.REQUEST, "options.deployments must be a non-empty array of { chainId, address }");
    out = given.map((d, i) => deploymentOf(d) ?? fail(CODES.REQUEST, `options.deployments[${i}] needs a positive integer chainId and an address (0x and 40 hex digits; mixed case must match EIP-55)`));
    for (const d of out) for (const s of sets) if (!s.keys.has(key(d))) fail(CODES.DEPLOYMENT, `profile ${s.name} does not list ${d.address} on chain ${d.chainId}`);
  } else {
    if (listing.length === 0) fail(CODES.DEPLOYMENT, "an ERC-7730 file binds to deployments: give options.deployments, or bind them in a contract profile (binds.deployments)");
    out = listing[0].deployments.map(deploymentOf).filter((d) => d && sets.every((s) => s.keys.has(key(d))));
    if (out.length === 0) fail(CODES.DEPLOYMENT, `no deployment is listed by every profile that lists deployments (${listing.map((p) => p.name).join(", ")})`);
  }
  const seen = new Set();
  return out.filter((d) => !seen.has(key(d)) && seen.add(key(d)));
}

function metadataOf(options) {
  const metadata = {};
  for (const k of ["owner", "contractName"]) {
    if (options[k] === undefined) continue;
    if (!nonEmpty(options[k])) fail(CODES.REQUEST, `options.${k} must be a non-empty string`);
    metadata[k] = options[k];
  }
  if (options.info !== undefined) {
    const { url, deploymentDate, ...rest } = isObject(options.info) ? options.info : {};
    if (!nonEmpty(url) || (deploymentDate !== undefined && !nonEmpty(deploymentDate)) || Object.keys(rest).length) fail(CODES.REQUEST, "options.info must be { url, deploymentDate? } with strings");
    metadata.info = deploymentDate === undefined ? { url } : { url, deploymentDate };
  }
  return metadata;
}

/** Whether the contract has the ERC-20 `decimals()` and `symbol()` an ERC-7730 wallet reads for `tokenPath: "@.to"`. */
function erc20Metadata(resolved) {
  const d = resolved.methods.decimals;
  const s = resolved.methods.symbol;
  return isObject(d) && isObject(s) && d.mode === "query" && s.mode === "query" && d.signature === "decimals()" && s.signature === "symbol()" && /^uint\d+$/.test(d.results?.[0]?.abi ?? "") && s.results?.[0]?.abi === "string" && d.results.length === 1 && s.results.length === 1;
}

/** The keys of a placeholder or token path through a viewed tree (`["details", "[]", "token"]`), or null. */
function keysOf(method, relpath) {
  const rp = resolvePath(method, relpath);
  return rp.error ? null : rp.steps.map((st) => (st.kind === "elem" ? "[]" : st.key));
}
const startsWith = (keys, prefix) => prefix.length <= keys.length && prefix.every((k, i) => keys[i] === k);

/**
 * ERC-7730 `visible` of a position a profile pins (`fixed`, spec section 15.4, D-058): `mustMatch` hides the field and
 * makes a wallet refuse any other value, as `evmConsent` and `eip712Consent` do (E_FIXED). Empty for any other position.
 */
function pinOf(node, where) {
  const fixed = tagArgs(node, "fixed");
  if (fixed === undefined) return {};
  try {
    return { visible: { mustMatch: [readAddress(String(fixed.value))] } };
  } catch (e) {
    if (e instanceof AbiError) fail(CODES.RESOLVED_FORM, `${where}: fixed: ${e.message}`);
    throw e;
  }
}

/**
 * One ERC-7730 field for a leaf of a function's parameters or a message's members. `at` is where the leaf is:
 * `{ method, abs, base }`, its keys from the root and the keys of the field group it is in (its path is relative to it).
 */
function fieldOf(node, path, label, ctx, where, at) {
  const field = { path, label, ...pinOf(node, where) };
  const amount = tagArgs(node, "amount");
  if (amount?.token !== undefined) {
    // In the token a field of the same value names (spec section 15.9): its path, relative to the group.
    const keys = keysOf(at.method, String(amount.token));
    if (keys === null) return ctx.problem(where, `amount.token ${JSON.stringify(amount.token)} does not resolve`);
    if (!startsWith(keys, at.base)) return ctx.problem(where, "the amount is in an array group and its token is outside it; this export writes no path that leaves a group");
    const params = { tokenPath: keys.slice(at.base.length).join(".") };
    if (amount.threshold !== undefined) {
      params.threshold = `0x${BigInt(amount.threshold).toString(16)}`;
      params.message = amount.message ?? "Unlimited";
    }
    return { ...field, format: "tokenAmount", params };
  }
  if (amount !== undefined) {
    const dynamic = amount.decimals?.from === "query:decimals" && amount.symbol?.from === "query:symbol";
    const literal = Number.isInteger(amount.decimals) && typeof amount.symbol === "string";
    if (dynamic) {
      if (!ctx.erc20) return ctx.problem(where, "amount reads query:decimals and query:symbol, but the contract has no ERC-20 decimals() and symbol() an ERC-7730 wallet reads");
      ctx.dynamic = true;
    } else if (literal) {
      if (!ctx.tokenName) return ctx.problem(where, "amount with literal decimals and symbol: an ERC-7730 file carries them only as the contract's own token (metadata.token); pass options.token = { name } if this contract is that token");
      const token = { decimals: amount.decimals, ticker: amount.symbol };
      if (ctx.token && (ctx.token.decimals !== token.decimals || ctx.token.ticker !== token.ticker)) return ctx.problem(where, `amount in ${token.ticker} with ${token.decimals} decimals, where another is in ${ctx.token.ticker} with ${ctx.token.decimals}: an ERC-7730 file has one metadata.token`);
      ctx.token = token;
    } else {
      return ctx.problem(where, "amount without the contract's own decimals and symbol (both read from decimals() and symbol(), or both literal) has no ERC-7730 form");
    }
    const params = { tokenPath: "@.to" };
    if (amount.threshold !== undefined) {
      params.threshold = `0x${BigInt(amount.threshold).toString(16)}`;
      params.message = amount.message ?? "Unlimited";
    }
    return { ...field, format: "tokenAmount", params };
  }
  const time = tagArgs(node, "timestamp") ?? tagArgs(node, "duration");
  if (time !== undefined) {
    const kind = tagArgs(node, "timestamp") !== undefined ? "timestamp" : "duration";
    if (time.unit !== "s") return ctx.problem(where, `${kind} in ${time.unit}: ERC-7730 ${kind === "timestamp" ? "dates" : "durations"} are in seconds`);
    const words = ["threshold", "labels"].filter((k) => time[k] !== undefined);
    if (kind === "timestamp" && words.length) ctx.note(where, `the timestamp's ${words.join(" and ")} ha${words.length > 1 ? "ve" : "s"} no ERC-7730 date form and ${words.length > 1 ? "are" : "is"} left out; the file shows the date`);
    return kind === "timestamp" ? { ...field, format: "date", params: { encoding: "timestamp" } } : { ...field, format: "duration" };
  }
  const bytes = tagArgs(node, "bytes");
  if (bytes !== undefined && bytes.encoding !== "hex") return ctx.problem(where, `bytes as ${bytes.encoding}: ERC-7730 shows bytes as hex only`);
  return { ...field, format: node.abi === "address" ? "addressName" : "raw" };
}

/** Whether a subtree holds an amount whose token path starts with `prefix` (it is in the same array element). */
function tokenInside(node, method, prefix) {
  if (node.candid === "record") return entriesOf(node.fields).some(([, child]) => tokenInside(child, method, prefix));
  if (node.candid === "vec") return tokenInside(node.element, method, prefix);
  const token = tagArgs(node, "amount")?.token;
  const keys = token === undefined ? null : keysOf(method, String(token));
  return keys !== null && startsWith(keys, prefix);
}

/**
 * The ERC-7730 fields of a viewed parameter tree, depth first in ABI order. An array whose elements hold an amount
 * whose token is in the same element is a field group (`{ path: "details.[]", fields }`), its paths relative to the
 * element, as ERC-7730's PermitBatch example writes it; any other array is flattened (`legs.[].to`).
 */
function fieldsOf(node, abs, rel, ctx, method, name) {
  if (node.candid === "record") return entriesOf(node.fields).flatMap(([k, child]) => fieldsOf(child, [...abs, k], [...rel, k], ctx, method, name));
  if (node.candid === "vec") {
    const element = [...abs, "[]"];
    if (tokenInside(node.element, method, element)) return [{ path: [...rel, "[]"].join("."), fields: fieldsOf(node.element, element, [], ctx, method, name) }];
    return fieldsOf(node.element, element, [...rel, "[]"], ctx, method, name);
  }
  const label = labelOf(node) ?? [...abs].reverse().find((k) => k !== "[]");
  const where = `${name}(0).${abs.join(".").replaceAll(".[]", "[]")}`;
  return [fieldOf(node, rel.join("."), label, ctx, where, { method, abs, base: abs.slice(0, abs.length - rel.length) })];
}

/** A parameter or tuple component without a name: an ERC-7730 key names every one, and paths need the names. */
function unnamed(params, at = "") {
  for (const [i, p] of params.entries()) {
    const here = `${at}${p.name ?? `#${i}`}`;
    if (p.name === null) return here;
    let t = p.type;
    while (t.kind === "array") t = t.element;
    if (t.kind === "tuple") {
      const hit = unnamed(t.components, `${here}.`);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * The template as an ERC-7730 interpolatedIntent: `{(0).to}` reads `{to}`, `[[` and `]]` are plain brackets. A
 * template ERC-7730 cannot interpolate gets none, and a note: `interpolatedIntent` is optional, and `intent` and the
 * fields still say everything.
 */
function interpolated(template, method, ctx, where) {
  const leftOut = (why) => ctx.note(where, `${why}; interpolatedIntent is left out`);
  let parts;
  try {
    parts = parseTemplate(template);
  } catch (e) {
    return leftOut(e.message);
  }
  let out = "";
  for (const p of parts) {
    if (p.t === "lit") out += p.text.replaceAll("{", "{{").replaceAll("}", "}}");
    else if (p.t === "opt") return leftOut("an optional [ ] segment has no ERC-7730 form");
    else {
      const rp = resolvePath(method, p.path);
      if (rp.error) return ctx.problem(where, `{${p.path}}: ${rp.error}`);
      if (rp.steps.some((s) => s.kind === "elem")) return leftOut(`{${p.path}} reads every element of an array; an ERC-7730 interpolation shows one value`);
      if (rp.node.candid === "record" || rp.node.candid === "vec") return leftOut(`{${p.path}} is a whole ${rp.node.abi}; an ERC-7730 interpolation shows one formatted field`);
      if (tagArgs(rp.node, "fixed") !== undefined) return leftOut(`{${p.path}} is pinned (fixed), so its field is hidden (mustMatch); an ERC-7730 interpolation names only fields that are always shown`);
      out += `{${rp.steps.map((s) => s.key).join(".")}}`;
    }
  }
  return out;
}

/** Every string of the file must be well-formed Unicode: RFC 8785 (JCS) serializes no lone surrogate. */
function checkText(v, where) {
  if (typeof v === "string" && !v.isWellFormed()) fail(CODES.EXPORT, `${where}: the text has a lone surrogate, which RFC 8785 cannot serialize`);
  if (Array.isArray(v)) v.forEach((x, i) => checkText(x, `${where}[${i}]`));
  else if (isObject(v)) for (const [k, x] of Object.entries(v)) checkText(k, where), checkText(x, `${where}.${k}`);
}

/** One ERC-7730 format entry: the intent's title (else `describe.label`, else `fallback`), its template, the fields. */
function entryOf(name, method, viewed, fallback, ctx) {
  const intent = method.tags?.intent?.args;
  const entry = { intent: nonEmpty(intent?.title) ? intent.title : (labelOf(method) ?? fallback) };
  if (typeof intent?.template === "string") {
    const text = interpolated(intent.template, viewed, ctx, `${name}: intent template`);
    if (text !== undefined) entry.interpolatedIntent = text;
  }
  const fields = viewed.args.length ? fieldsOf(viewed.args[0], [], [], ctx, viewed, name) : [];
  return { entry, fields };
}

/** The formats of every function a transaction calls, keyed by its named signature. */
function functionFormats(resolved, ctx) {
  const formats = {};
  for (const [name, m] of entriesOf(resolved.methods)) {
    if (!isObject(m) || m.mode !== "update") continue;
    const method = methodOf(resolved, name, "evm");
    let f;
    try {
      f = parseSignature(String(method.signature), `methods.${name}.signature`);
    } catch (e) {
      if (e instanceof AbiError) fail(CODES.RESOLVED_FORM, e.message);
      throw e;
    }
    if (f.name !== name || f.selector !== method.selector) fail(CODES.RESOLVED_FORM, `methods.${name}: the signature ${method.signature} does not hash to ${method.selector}`);
    const missing = unnamed(f.inputs);
    if (missing !== null) {
      ctx.problem(name, `parameter ${missing} has no name; an ERC-7730 key names every parameter`);
      continue;
    }
    const viewed = { ...method, args: method.args.map((n, i) => abiView(n, `${name}(${i})`)) };
    const { entry, fields } = entryOf(name, method, viewed, `Call ${name}`, ctx);
    if (method.state_mutability === "payable") fields.push({ path: "@.value", label: "Value sent", format: "amount" });
    if (fields.length) entry.fields = fields;
    formats[method.signature] = entry;
  }
  if (Object.keys(formats).length === 0) ctx.problem("functions", "the contract has no function a transaction calls (every function is view or pure)");
  return formats;
}

/** The formats of every EIP-712 message (spec section 15.9), keyed by its encode_type, which must hash to its type_hash. */
function messageFormats(resolved, ctx) {
  const formats = {};
  for (const [name, m] of entriesOf(resolved.messages)) {
    if (!isObject(m) || typeof m.encode_type !== "string" || !m.encode_type.startsWith(`${name}(`) || `0x${keccak256Hex(m.encode_type)}` !== m.type_hash) {
      fail(CODES.RESOLVED_FORM, `messages.${name}: its encode_type does not hash to its type_hash, or names another type`);
    }
    if (!Array.isArray(m.args) || m.args.length !== 1) fail(CODES.RESOLVED_FORM, `messages.${name} has no args array of one struct`);
    const viewed = { ...m, args: m.args.map((n, i) => abiView(n, `${name}(${i})`)) };
    const { entry, fields } = entryOf(name, m, viewed, `Sign ${name}`, ctx);
    if (fields.length) entry.fields = fields;
    formats[m.encode_type] = entry;
  }
  if (Object.keys(formats).length === 0) ctx.problem("messages", "the resolved form describes no EIP-712 message");
  return formats;
}

/** ERC-7730 `context.eip712.domain`: the name and version every profile that gives one gives. */
function domainOf(resolved, ctx) {
  const domain = {};
  for (const p of Array.isArray(resolved.profiles) ? resolved.profiles : []) {
    if (!isObject(p?.eip712_domain)) continue;
    for (const [k, v] of Object.entries(p.eip712_domain)) {
      if ((k !== "name" && k !== "version") || typeof v !== "string") fail(CODES.RESOLVED_FORM, `profile ${p.name}: eip712_domain has ${JSON.stringify(k)}; only a name and a version are bound by a profile`);
      if (Object.hasOwn(domain, k) && domain[k] !== v) ctx.problem("domain", `profiles give the domain two ${k}s, ${JSON.stringify(domain[k])} and ${JSON.stringify(v)}`);
      domain[k] = v;
    }
  }
  return domain;
}

/**
 * The ERC-7730 file of an EVM contract's resolved form, and its ERC-8176 `descriptorHash`.
 *
 * @param {object} resolved  an EVM contract's resolved form (`chain: "evm"`)
 * @param {object} [options]
 * @param {"contract" | "eip712"} [options.context]  the functions a transaction calls (default), or the EIP-712
 *   messages (spec section 15.9): ERC-7730 binds one file to one of the two
 * @param {{ chainId: number, address: string }[]} [options.deployments]  default: the deployments every profile lists
 * @param {string} [options.owner]  ERC-7730 `metadata.owner`
 * @param {string} [options.contractName]  `metadata.contractName`
 * @param {{ url: string, deploymentDate?: string }} [options.info]  `metadata.info`
 * @param {{ name: string }} [options.token]  the contract is the token its literal amounts are in: `metadata.token`
 * @returns {{ descriptor: object, descriptorHash: string, notes: string[] }}  `notes`: what was left out because a
 *   file cannot say it, though the file still shows every value (a timestamp's words, an interpolatedIntent)
 */
export function erc7730Descriptor(resolved, options = {}) {
  if (!isObject(resolved) || resolved.format !== "candid-profile-resolved" || !isObject(resolved.methods) || resolved.chain !== "evm") methodOf(resolved, "", "evm"); // throws the right error
  if (!isObject(options)) fail(CODES.REQUEST, "options must be an object");
  for (const k of Object.keys(options)) if (!OPTIONS.has(k)) fail(CODES.REQUEST, `unknown option ${JSON.stringify(k)}; expected one of ${[...OPTIONS].join(", ")}`);
  if (options.token !== undefined && !(isObject(options.token) && nonEmpty(options.token.name) && Object.keys(options.token).length === 1)) fail(CODES.REQUEST, "options.token must be { name } with a non-empty string");
  const context = options.context ?? "contract";
  if (context !== "contract" && context !== "eip712") fail(CODES.REQUEST, `options.context must be "contract" or "eip712", got ${JSON.stringify(options.context)}`);

  const problems = [];
  const notes = [];
  const ctx = {
    erc20: erc20Metadata(resolved),
    tokenName: options.token?.name,
    token: null,
    dynamic: false,
    problem: (at, message) => void problems.push(`${at}: ${message}`),
    note: (at, message) => void notes.push(`${at}: ${message}`),
  };
  const deployments = deploymentsOf(resolved, options.deployments);
  const metadata = metadataOf(options);
  const formats = context === "eip712" ? messageFormats(resolved, ctx) : functionFormats(resolved, ctx);
  const domain = context === "eip712" ? domainOf(resolved, ctx) : {};
  if (ctx.dynamic && ctx.token) problems.push("amounts: some read decimals() and symbol(), others are literal; an ERC-7730 wallet reads one token for @.to");
  if (problems.length) fail(CODES.EXPORT, `no ERC-7730 file: ${problems.join("; ")}`);

  if (ctx.token) metadata.token = { name: ctx.tokenName, ticker: ctx.token.ticker, decimals: ctx.token.decimals };
  const bound = context === "eip712" ? { eip712: { ...(Object.keys(domain).length ? { domain } : {}), deployments } } : { contract: { deployments } };
  const descriptor = { $schema: ERC7730_SCHEMA_URL, context: bound };
  if (Object.keys(metadata).length) descriptor.metadata = metadata;
  descriptor.display = { formats };
  return { descriptor, descriptorHash: descriptorHash(descriptor), notes };
}

/** ERC-8176 `descriptorHash`: Keccak-256 of the RFC 8785 (JCS) form of a descriptor without `includes`. */
export function descriptorHash(descriptor) {
  if (!isObject(descriptor)) fail(CODES.REQUEST, "a descriptor is a JSON object");
  if (Object.hasOwn(descriptor, "includes")) fail(CODES.REQUEST, "resolve the descriptor's includes first (ERC-8176 hashes the merged file)");
  checkText(descriptor, "descriptor");
  return `0x${keccak256Hex(jcs(descriptor))}`;
}

const ATTEST = [
  { name: "version", type: "uint16" },
  { name: "schema", type: "bytes32" },
  { name: "recipient", type: "address" },
  { name: "time", type: "uint64" },
  { name: "expirationTime", type: "uint64" },
  { name: "revocable", type: "bool" },
  { name: "refUID", type: "bytes32" },
  { name: "data", type: "bytes" },
  { name: "salt", type: "bytes32" },
];

function uint64(v, name) {
  const s = typeof v === "bigint" ? v.toString() : Number.isSafeInteger(v) ? String(v) : v;
  if (typeof s !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(s) || BigInt(s) >= 2n ** 64n) fail(CODES.REQUEST, `${name} must be a uint64 (seconds since the Unix epoch), got ${String(v)}`);
  return s;
}

function bytes32(v, name) {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) fail(CODES.REQUEST, `${name} must be 0x and 64 hex digits`);
  return v.toLowerCase();
}

/**
 * The unsigned ERC-8176 offchain attestation of a descriptor: EAS offchain attestation v2 typed data for a reviewer to
 * sign with their own key (EIP-712), and its digest. Nothing is signed or sent here.
 *
 * @param {object} input
 * @param {string} input.descriptorHash  from erc7730Descriptor (or descriptorHash)
 * @param {bigint | number | string} input.time  when the attestation is made, in Unix seconds
 * @param {bigint | number | string} input.expirationTime  when it expires, in Unix seconds; 0 never (ERC-8176 advises a bound)
 * @param {string} input.salt  32 random bytes, 0x hex: the caller's, so the same input gives the same output
 * @param {string} [input.refUID]  an attestation this one refers to; default none (32 zero bytes)
 * @returns {{ typedData: { domain: object, primaryType: "Attest", types: { Attest: { name: string, type: string }[] }, message: object }, digest: string }}
 */
export function erc8176Attestation({ descriptorHash: hash, time, expirationTime, salt, refUID = ZERO32 } = {}) {
  const message = {
    version: 2,
    schema: ERC8176_SCHEMA_UID,
    recipient: ZERO_ADDRESS,
    time: uint64(time, "time"),
    expirationTime: uint64(expirationTime, "expirationTime"),
    revocable: true,
    refUID: bytes32(refUID, "refUID"),
    data: bytes32(hash, "descriptorHash"), // abi.encode(bytes32) is the 32 bytes themselves
    salt: bytes32(salt, "salt"),
  };
  if (message.expirationTime !== "0" && BigInt(message.expirationTime) <= BigInt(message.time)) fail(CODES.REQUEST, "expirationTime must be 0 or after time");
  const typedData = { domain: { name: "EAS Attestation", version: "0.26", chainId: 1, verifyingContract: EAS_ADDRESS }, primaryType: "Attest", types: { Attest: ATTEST.map((f) => ({ ...f })) }, message };
  return { typedData, digest: typedDataDigest(typedData) };
}
