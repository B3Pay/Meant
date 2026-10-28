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
const OPTIONS = new Set(["deployments", "owner", "contractName", "info", "token"]);
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

/** One ERC-7730 field for a leaf of a function's parameters. */
function fieldOf(node, path, label, ctx, where) {
  const field = { path, label };
  const amount = tagArgs(node, "amount");
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
    return kind === "timestamp" ? { ...field, format: "date", params: { encoding: "timestamp" } } : { ...field, format: "duration" };
  }
  const bytes = tagArgs(node, "bytes");
  if (bytes !== undefined && bytes.encoding !== "hex") return ctx.problem(where, `bytes as ${bytes.encoding}: ERC-7730 shows bytes as hex only`);
  return { ...field, format: node.abi === "address" ? "addressName" : "raw" };
}

/** Every leaf of a viewed parameter tree, depth first in ABI order: its ERC-7730 path and its label. */
function leaves(node, keys, out) {
  if (node.candid === "record") for (const [k, child] of entriesOf(node.fields)) leaves(child, [...keys, k], out);
  else if (node.candid === "vec") leaves(node.element, [...keys, "[]"], out);
  else out.push({ node, path: keys.join("."), label: labelOf(node) ?? [...keys].reverse().find((k) => k !== "[]") });
  return out;
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

/** The template as an ERC-7730 interpolatedIntent: `{(0).to}` reads `{to}`, `[[` and `]]` are plain brackets. */
function interpolated(template, method, ctx, where) {
  let parts;
  try {
    parts = parseTemplate(template);
  } catch (e) {
    return ctx.problem(where, e.message);
  }
  let out = "";
  for (const p of parts) {
    if (p.t === "lit") out += p.text.replaceAll("{", "{{").replaceAll("}", "}}");
    else if (p.t === "opt") return ctx.problem(where, "an optional [ ] segment has no ERC-7730 form");
    else {
      const rp = resolvePath(method, p.path);
      if (rp.error) return ctx.problem(where, `{${p.path}}: ${rp.error}`);
      if (rp.steps.some((s) => s.kind === "elem")) return ctx.problem(where, `{${p.path}} reads every element of an array; an ERC-7730 interpolation shows one value`);
      if (rp.node.candid === "record" || rp.node.candid === "vec") return ctx.problem(where, `{${p.path}} is a whole ${rp.node.abi}; an ERC-7730 interpolation shows one formatted field`);
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

/**
 * The ERC-7730 file of an EVM contract's resolved form, and its ERC-8176 `descriptorHash`.
 *
 * @param {object} resolved  an EVM contract's resolved form (`chain: "evm"`)
 * @param {object} [options]
 * @param {{ chainId: number, address: string }[]} [options.deployments]  default: the deployments every profile lists
 * @param {string} [options.owner]  ERC-7730 `metadata.owner`
 * @param {string} [options.contractName]  `metadata.contractName`
 * @param {{ url: string, deploymentDate?: string }} [options.info]  `metadata.info`
 * @param {{ name: string }} [options.token]  the contract is the token its literal amounts are in: `metadata.token`
 * @returns {{ descriptor: object, descriptorHash: string }}
 */
export function erc7730Descriptor(resolved, options = {}) {
  if (!isObject(resolved) || resolved.format !== "candid-profile-resolved" || !isObject(resolved.methods) || resolved.chain !== "evm") methodOf(resolved, "", "evm"); // throws the right error
  if (!isObject(options)) fail(CODES.REQUEST, "options must be an object");
  for (const k of Object.keys(options)) if (!OPTIONS.has(k)) fail(CODES.REQUEST, `unknown option ${JSON.stringify(k)}; expected one of ${[...OPTIONS].join(", ")}`);
  if (options.token !== undefined && !(isObject(options.token) && nonEmpty(options.token.name) && Object.keys(options.token).length === 1)) fail(CODES.REQUEST, "options.token must be { name } with a non-empty string");

  const problems = [];
  const ctx = { erc20: erc20Metadata(resolved), tokenName: options.token?.name, token: null, dynamic: false, problem: (at, message) => void problems.push(`${at}: ${message}`) };
  const deployments = deploymentsOf(resolved, options.deployments);
  const metadata = metadataOf(options);

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
    const intent = method.tags?.intent?.args;
    const entry = { intent: nonEmpty(intent?.title) ? intent.title : (labelOf(method) ?? `Call ${name}`) };
    if (typeof intent?.template === "string") {
      const text = interpolated(intent.template, viewed, ctx, `${name}: intent template`);
      if (text !== undefined) entry.interpolatedIntent = text;
    }
    const fields = viewed.args.length ? leaves(viewed.args[0], [], []).map((l) => fieldOf(l.node, l.path, l.label, ctx, `${name}(0).${l.path.replaceAll(".[]", "[]")}`)) : [];
    if (method.state_mutability === "payable") fields.push({ path: "@.value", label: "Value sent", format: "amount" });
    if (fields.length) entry.fields = fields;
    formats[method.signature] = entry;
  }
  if (ctx.dynamic && ctx.token) problems.push("amounts: some read decimals() and symbol(), others are literal; an ERC-7730 wallet reads one token for @.to");
  if (problems.length) fail(CODES.EXPORT, `no ERC-7730 file: ${problems.join("; ")}`);
  if (Object.keys(formats).length === 0) fail(CODES.EXPORT, "no ERC-7730 file: the contract has no function a transaction calls (every function is view or pure)");

  if (ctx.token) metadata.token = { name: ctx.tokenName, ticker: ctx.token.ticker, decimals: ctx.token.decimals };
  const descriptor = { $schema: ERC7730_SCHEMA_URL, context: { contract: { deployments } } };
  if (Object.keys(metadata).length) descriptor.metadata = metadata;
  descriptor.display = { formats };
  return { descriptor, descriptorHash: descriptorHash(descriptor) };
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
