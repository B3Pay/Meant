// EVM ABI function fragments (spec section 15, D-054): reading them, their canonical text, selectors, the identity
// of an interface, and a strict codec for calldata. Plain JavaScript with no dependency, so that it is part of the
// browser-safe `@meantjs/profile/evm` entry.
//
// A type is a tree:
//   { kind: "uint" | "int", bits }   bits 8 to 256 in steps of 8; `uint` and `int` alone are 256
//   { kind: "address" } | { kind: "bool" } | { kind: "string" } | { kind: "bytes" }
//   { kind: "fixedbytes", size }     bytes1 to bytes32 (`byte` is bytes1)
//   { kind: "array", element, length }   length null for T[], else k >= 1 for T[k]
//   { kind: "tuple", components: [{ name, type }] }   name null when unnamed
// Refused: `function`, `fixed` and `ufixed` types, overloaded names (O1), names Candid Profile addresses cannot spell.
//
// Values, as the codec reads and writes them (the consent package's Candid values have the same shape rules):
//   uintN, intN    decimal string when decoded; a decimal string or a bigint when encoded (never a number, D-006)
//   address        EIP-55 text when decoded; any valid address text when encoded (mixed case must match its checksum)
//   bool           boolean
//   bytes, bytesN  Uint8Array
//   string         string (the bytes must be UTF-8)
//   T[], T[k]      array
//   tuple          object keyed by component name, `#i` for the unnamed component at position i

import { keccak256, keccak256Hex } from "./keccak.mjs";
import { sha256Hex } from "./sha256.mjs";
import { jcs } from "./util.mjs";

export class AbiError extends Error {
  /** @param {string} code  E_ABI (a fragment), E_ABI_ENCODE or E_ABI_DECODE (a value) */
  constructor(code, message) {
    super(message);
    this.name = "AbiError";
    this.code = code;
  }
}
const fail = (code, message) => {
  throw new AbiError(code, message);
};

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MUTABILITY = new Set(["pure", "view", "nonpayable", "payable"]);

// ---------------------------------------------------------------------------------------------- types

/** The key of a tuple component: its name, else `#` and its position. */
export const componentKey = (c, i) => c.name ?? `#${i}`;

/** Canonical type text: `uint256`, `(address token,uint256 amount)[]`; with `names`, tuple components keep theirs. */
export function typeString(t, names = false) {
  switch (t.kind) {
    case "uint":
    case "int":
      return `${t.kind}${t.bits}`;
    case "fixedbytes":
      return `bytes${t.size}`;
    case "array":
      return `${typeString(t.element, names)}[${t.length ?? ""}]`;
    case "tuple":
      return `(${t.components.map((c) => param(c, names)).join(",")})`;
    default:
      return t.kind;
  }
}
const param = (p, names) => (names && p.name !== null ? `${typeString(p.type, true)} ${p.name}` : typeString(p.type, names));

function elementary(name, where) {
  if (name === "address" || name === "bool" || name === "string" || name === "bytes") return { kind: name };
  if (name === "byte") return { kind: "fixedbytes", size: 1 };
  let m = /^(u?int)(\d*)$/.exec(name);
  if (m) {
    const bits = m[2] === "" ? 256 : Number(m[2]);
    if (!/^(?:|[1-9]\d*)$/.test(m[2]) || bits < 8 || bits > 256 || bits % 8 !== 0) fail("E_ABI", `${where}: ${name} is not an ABI integer type (8 to 256 bits in steps of 8)`);
    return { kind: m[1], bits };
  }
  m = /^bytes([1-9]\d*)$/.exec(name);
  if (m) {
    const size = Number(m[1]);
    if (size > 32) fail("E_ABI", `${where}: ${name} is not an ABI type (bytes1 to bytes32)`);
    return { kind: "fixedbytes", size };
  }
  if (/^u?fixed/.test(name) || name === "function") fail("E_ABI", `${where}: the ${name} type is not supported (spec section 15)`);
  fail("E_ABI", `${where}: unknown ABI type ${JSON.stringify(name)}`);
}

function withDims(base, dims, where) {
  let t = base;
  for (const d of dims) {
    if (d !== "" && !/^[1-9]\d{0,5}$/.test(d)) fail("E_ABI", `${where}: array length [${d}] must be a positive integer`);
    t = { kind: "array", element: t, length: d === "" ? null : Number(d) };
  }
  return t;
}

function checkComponents(components, where) {
  if (components.length === 0) fail("E_ABI", `${where}: a tuple needs at least one component`);
  const seen = new Set();
  components.forEach((c, i) => {
    if (c.name === null) return;
    if (!IDENT.test(c.name)) fail("E_ABI", `${where}: the name ${JSON.stringify(c.name)} is not an identifier (letters, digits and _)`);
    if (seen.has(c.name)) fail("E_ABI", `${where}: two components are named ${JSON.stringify(c.name)}`);
    if (/^#/.test(c.name) || components.some((d, j) => j !== i && d.name === null && `#${j}` === c.name)) fail("E_ABI", `${where}: ambiguous name ${c.name}`);
    seen.add(c.name);
  });
}

// ---------------------------------------------------------------------------------------------- human-readable fragments

class Reader {
  constructor(text, where) {
    this.s = text;
    this.i = 0;
    this.where = where;
  }
  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
  }
  peek(ch) {
    this.ws();
    return this.s[this.i] === ch;
  }
  eat(ch) {
    this.ws();
    if (this.s[this.i] !== ch) fail("E_ABI", `${this.where}: expected "${ch}" at position ${this.i} of ${JSON.stringify(this.s)}`);
    this.i++;
  }
  word() {
    this.ws();
    const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.s.slice(this.i));
    if (!m) return null;
    this.i += m[0].length;
    return m[0];
  }
  peekWord() {
    const at = this.i;
    const w = this.word();
    this.i = at;
    return w;
  }
  end() {
    this.ws();
    return this.i >= this.s.length;
  }
  dims() {
    const out = [];
    for (;;) {
      this.ws();
      const m = /^\[(\d*)\]/.exec(this.s.slice(this.i));
      if (!m) return out;
      out.push(m[1]);
      this.i += m[0].length;
    }
  }
  /** `( param, … )` */
  params() {
    this.eat("(");
    const out = [];
    if (this.peek(")")) {
      this.i++;
      return out;
    }
    for (;;) {
      out.push(this.param());
      if (this.peek(",")) {
        this.i++;
        continue;
      }
      this.eat(")");
      return out;
    }
  }
  /** `type [location] [name]`; a tuple type is `(…)` or `tuple(…)` */
  param() {
    let base;
    if (this.peek("(")) base = { kind: "tuple", components: this.params() };
    else {
      const w = this.word();
      if (w === null) fail("E_ABI", `${this.where}: expected a type at position ${this.i} of ${JSON.stringify(this.s)}`);
      if (w === "tuple" && this.peek("(")) base = { kind: "tuple", components: this.params() };
      else {
        base = elementary(w, this.where);
        if (w === "address" && this.peekWord() === "payable") this.word();
      }
    }
    if (base.kind === "tuple") checkComponents(base.components, this.where);
    const type = withDims(base, this.dims(), this.where);
    let name = this.peek(",") || this.peek(")") ? null : this.word();
    if (name === "indexed") fail("E_ABI", `${this.where}: "indexed" belongs to events; only functions are read`);
    if (name === "memory" || name === "calldata" || name === "storage") name = this.peek(",") || this.peek(")") ? null : this.word();
    return { name, type };
  }
}

function fromText(text, where) {
  const r = new Reader(text, where);
  const kw = r.word();
  if (kw !== "function") {
    if (["event", "error", "constructor", "fallback", "receive", "struct"].includes(kw)) return null; // not a function: not read (spec section 15)
    fail("E_ABI", `${where}: a fragment starts with "function", found ${JSON.stringify(text)}`);
  }
  const name = r.word();
  if (name === null) fail("E_ABI", `${where}: the function has no name`);
  const inputs = r.params();
  let stateMutability = "nonpayable";
  let outputs = [];
  let seen = false;
  while (!r.end()) {
    const w = r.word();
    if (w === "external" || w === "public") continue;
    if (w === "returns") {
      outputs = r.params();
      continue;
    }
    const m = w === "constant" ? "view" : w;
    if (!MUTABILITY.has(m)) fail("E_ABI", `${where}: unexpected ${JSON.stringify(w ?? r.s.slice(r.i))} in ${JSON.stringify(text)}`);
    if (seen) fail("E_ABI", `${where}: two state mutabilities in ${JSON.stringify(text)}`);
    seen = true;
    stateMutability = m;
  }
  return { name, inputs, outputs, stateMutability };
}

// ---------------------------------------------------------------------------------------------- JSON ABI entries

function jsonParam(p, where) {
  if (p === null || typeof p !== "object" || typeof p.type !== "string") fail("E_ABI", `${where}: a parameter needs a "type" string`);
  const m = /^([a-z0-9]+)((?:\[\d*\])*)$/.exec(p.type);
  if (!m) fail("E_ABI", `${where}: unknown ABI type ${JSON.stringify(p.type)}`);
  let base;
  if (m[1] === "tuple") {
    if (!Array.isArray(p.components)) fail("E_ABI", `${where}: a tuple parameter needs "components"`);
    base = { kind: "tuple", components: p.components.map((c, i) => jsonParam(c, `${where}.components[${i}]`)) };
    checkComponents(base.components, where);
  } else base = elementary(m[1], where);
  const dims = [...m[2].matchAll(/\[(\d*)\]/g)].map((d) => d[1]);
  const name = typeof p.name === "string" && p.name !== "" ? p.name : null;
  return { name, type: withDims(base, dims, where) };
}

function fromJson(e, where) {
  const kind = e.type ?? "function";
  if (kind !== "function") return null; // events, errors, the constructor, fallback and receive are not read
  if (typeof e.name !== "string" || e.name === "") fail("E_ABI", `${where}: the function has no name`);
  let stateMutability = e.stateMutability;
  if (stateMutability === undefined) stateMutability = e.constant === true ? "view" : e.payable === true ? "payable" : "nonpayable";
  if (!MUTABILITY.has(stateMutability)) fail("E_ABI", `${where}: unknown stateMutability ${JSON.stringify(stateMutability)}`);
  const list = (xs, side) => {
    if (xs === undefined) return [];
    if (!Array.isArray(xs)) fail("E_ABI", `${where}: "${side}" must be an array`);
    return xs.map((p, i) => jsonParam(p, `${where}.${side}[${i}]`));
  };
  return { name: e.name, inputs: list(e.inputs, "inputs"), outputs: list(e.outputs, "outputs"), stateMutability };
}

// ---------------------------------------------------------------------------------------------- functions

/** `transfer(address,uint256)`, the text a selector hashes. */
export const typeSignature = (f) => `${f.name}(${f.inputs.map((p) => typeString(p.type)).join(",")})`;
/** `transfer(address to,uint256 value)`, as ERC-7730 keys a function. */
export const namedSignature = (f) => `${f.name}(${f.inputs.map((p) => param(p, true)).join(",")})`;
/** `function decimals() view returns (uint8)`: names kept, `nonpayable` left out, one form per function. */
export function canonicalFragment(f) {
  const mut = f.stateMutability === "nonpayable" ? "" : ` ${f.stateMutability}`;
  const out = f.outputs.length ? ` returns (${f.outputs.map((p) => param(p, true)).join(",")})` : "";
  return `function ${namedSignature(f)}${mut}${out}`;
}
/** The 4-byte selector as `0x` and 8 hex digits. */
export const selectorOf = (f) => `0x${keccak256Hex(typeSignature(f)).slice(0, 8)}`;

function finish(f, where) {
  if (!IDENT.test(f.name)) fail("E_ABI", `${where}: the function name ${JSON.stringify(f.name)} is not an identifier (letters, digits and _)`);
  checkParams(f.inputs, `${where} (inputs)`);
  checkParams(f.outputs, `${where} (outputs)`);
  return { ...f, signature: namedSignature(f), typeSignature: typeSignature(f), selector: selectorOf(f), canonical: canonicalFragment(f) };
}
function checkParams(params, where) {
  if (params.length) checkComponents(params, where);
}

/**
 * Read an ABI: an array whose entries are human-readable fragments (`function transfer(address to, uint256 value)
 * returns (bool)`) or JSON ABI entries. Only functions are read; events, errors, the constructor, fallback and receive
 * are skipped. Every problem is reported, none thrown.
 *
 * @param {unknown} entries
 * @param {string} [label]  how the diagnostics name the array (`binds.abi`)
 * @returns {{ functions: object[], errors: { at: string, message: string }[] }}
 */
export function parseAbi(entries, label = "abi") {
  const errors = [];
  const functions = [];
  if (!Array.isArray(entries)) return { functions, errors: [{ at: label, message: "an ABI is an array of fragments or JSON ABI entries" }] };
  entries.forEach((e, i) => {
    const where = `${label}[${i}]`;
    try {
      const f = typeof e === "string" ? fromText(e, where) : e !== null && typeof e === "object" && !Array.isArray(e) ? fromJson(e, where) : fail("E_ABI", `${where}: neither a fragment nor a JSON ABI entry`);
      if (f !== null) functions.push({ ...finish(f, where), at: where });
    } catch (err) {
      if (!(err instanceof AbiError)) throw err;
      errors.push({ at: where, message: err.message.startsWith(`${where}: `) ? err.message.slice(where.length + 2) : err.message });
    }
  });
  const byName = new Map();
  const bySelector = new Map();
  const kept = [];
  for (const f of functions) {
    const same = byName.get(f.name);
    if (same && same.canonical === f.canonical) continue; // the same function twice
    if (same) {
      const why = same.typeSignature === f.typeSignature ? `${f.typeSignature} is declared twice, with different names or results` : `${f.name} is overloaded (${same.typeSignature} and ${f.typeSignature}); overloaded functions are not supported yet (spec section 15, O1)`;
      errors.push({ at: f.at, message: why });
      continue;
    }
    const clash = bySelector.get(f.selector);
    if (clash) {
      errors.push({ at: f.at, message: `${f.typeSignature} and ${clash.typeSignature} have the same selector ${f.selector}` });
      continue;
    }
    byName.set(f.name, f);
    bySelector.set(f.selector, f);
    kept.push(f);
  }
  return { functions: kept.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), errors };
}

/** The identity of an EVM interface: SHA-256 over the JCS array of its canonical fragments, sorted (spec section 15). */
export function abiInterfaceId(functions) {
  return `candid-profile:evm-abi:v0:sha256:${sha256Hex(jcs(functions.map((f) => f.canonical).sort()))}`;
}

/** Read one function from its named signature (`transfer(address to,uint256 value)`), as a resolved form carries it. */
export function parseSignature(text, where = "signature") {
  const r = new Reader(`function ${text}`, where);
  r.word();
  const name = r.word();
  if (name === null) fail("E_ABI", `${where}: no function name in ${JSON.stringify(text)}`);
  const inputs = r.params();
  if (!r.end()) fail("E_ABI", `${where}: unexpected text after the parameters of ${JSON.stringify(text)}`);
  return finish({ name, inputs, outputs: [], stateMutability: "nonpayable" }, where);
}

// ---------------------------------------------------------------------------------------------- EIP-55 addresses

const HEX40 = /^0x[0-9a-fA-F]{40}$/;

/** `0x` and 40 hex digits in the EIP-55 mixed-case checksum form. */
export function toChecksumAddress(address) {
  if (typeof address !== "string" || !HEX40.test(address)) fail("E_ADDRESS", `${JSON.stringify(address)} is not an address (0x and 40 hex digits)`);
  const lower = address.slice(2).toLowerCase();
  const hash = keccak256Hex(lower);
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

/**
 * Read an address: `0x` and 40 hex digits. Text in mixed case is an EIP-55 checksum and must match it; text all in one
 * case carries none (EIP-55) and is accepted (O3). Returns the checksummed form.
 */
export function readAddress(text) {
  const checksummed = toChecksumAddress(text);
  const digits = text.slice(2);
  const mixed = digits !== digits.toLowerCase() && digits !== digits.toUpperCase();
  if (mixed && text !== checksummed) fail("E_ADDRESS_CHECKSUM", `${text} is in mixed case but its EIP-55 checksum does not match (expected ${checksummed})`);
  return checksummed;
}

// ---------------------------------------------------------------------------------------------- codec

const WORD = 32;
const isDynamic = (t) =>
  t.kind === "bytes" || t.kind === "string" || (t.kind === "array" && (t.length === null || isDynamic(t.element))) || (t.kind === "tuple" && t.components.some((c) => isDynamic(c.type)));
const headSize = (t) => {
  if (isDynamic(t)) return WORD;
  if (t.kind === "array") return t.length * headSize(t.element);
  if (t.kind === "tuple") return t.components.reduce((n, c) => n + headSize(c.type), 0);
  return WORD;
};

function word(v) {
  const out = new Uint8Array(WORD);
  let x = BigInt.asUintN(256, v);
  for (let i = WORD - 1; i >= 0 && x > 0n; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const padded = (bytes) => {
  const out = new Uint8Array(Math.ceil(bytes.length / WORD) * WORD);
  out.set(bytes);
  return out;
};
const hexOf = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const bytesFrom = (v, where) => {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(v)) return Uint8Array.from(v.slice(2).match(/../g) ?? [], (h) => parseInt(h, 16));
  fail("E_ABI_ENCODE", `${where}: bytes are a Uint8Array or 0x hex text`);
};

function intValue(t, v, where) {
  let x;
  if (typeof v === "bigint") x = v;
  else if (typeof v === "string" && /^-?(?:0|[1-9]\d*)$/.test(v) && v !== "-0") x = BigInt(v);
  else fail("E_ABI_ENCODE", `${where}: ${typeString(t)} needs a decimal string or a bigint, got ${typeof v === "number" ? "a number" : JSON.stringify(v)}`);
  const [min, max] = t.kind === "uint" ? [0n, 2n ** BigInt(t.bits) - 1n] : [-(2n ** BigInt(t.bits - 1)), 2n ** BigInt(t.bits - 1) - 1n];
  if (x < min || x > max) fail("E_ABI_ENCODE", `${where}: ${x} is outside ${typeString(t)}`);
  return x;
}

function encodeValue(t, v, where) {
  switch (t.kind) {
    case "uint":
    case "int":
      return word(intValue(t, v, where));
    case "bool":
      if (typeof v !== "boolean") fail("E_ABI_ENCODE", `${where}: bool needs true or false`);
      return word(v ? 1n : 0n);
    case "address": {
      let a;
      try {
        a = readAddress(v);
      } catch (e) {
        if (e instanceof AbiError) fail("E_ABI_ENCODE", `${where}: ${e.message}`);
        throw e;
      }
      return word(BigInt(a));
    }
    case "fixedbytes": {
      const b = bytesFrom(v, where);
      if (b.length !== t.size) fail("E_ABI_ENCODE", `${where}: bytes${t.size} needs ${t.size} bytes, got ${b.length}`);
      return padded(b);
    }
    case "bytes":
    case "string": {
      const b = t.kind === "string" ? (typeof v === "string" && v.isWellFormed() ? new TextEncoder().encode(v) : fail("E_ABI_ENCODE", `${where}: string needs well-formed text`)) : bytesFrom(v, where);
      return concat([word(BigInt(b.length)), padded(b)]);
    }
    case "array": {
      if (!Array.isArray(v)) fail("E_ABI_ENCODE", `${where}: ${typeString(t)} needs an array`);
      if (t.length !== null && v.length !== t.length) fail("E_ABI_ENCODE", `${where}: ${typeString(t)} needs ${t.length} elements, got ${v.length}`);
      const body = encodeTuple(v.map(() => t.element), v, (i) => `${where}[${i}]`);
      return t.length === null ? concat([word(BigInt(v.length)), body]) : body;
    }
    case "tuple": {
      if (v === null || typeof v !== "object" || Array.isArray(v)) fail("E_ABI_ENCODE", `${where}: a tuple needs an object keyed by component`);
      const keys = t.components.map(componentKey);
      for (const k of Object.keys(v)) if (!keys.includes(k)) fail("E_ABI_ENCODE", `${where}: no component ${k}`);
      return encodeTuple(
        t.components.map((c) => c.type),
        keys.map((k) => (Object.hasOwn(v, k) ? v[k] : fail("E_ABI_ENCODE", `${where}: missing component ${k}`))),
        (i) => `${where}.${keys[i]}`,
      );
    }
  }
  fail("E_ABI_ENCODE", `${where}: unknown type`);
}

function encodeTuple(types, values, at) {
  const heads = [];
  const tails = [];
  let offset = types.reduce((n, t) => n + headSize(t), 0);
  types.forEach((t, i) => {
    const enc = encodeValue(t, values[i], at(i));
    if (isDynamic(t)) {
      heads.push(word(BigInt(offset)));
      tails.push(enc);
      offset += enc.length;
    } else heads.push(enc);
  });
  return concat([...heads, ...tails]);
}

/** ABI-encode values of a parameter list (`[{ name, type }]`), keyed like a tuple. */
export function encodeParams(params, values) {
  return encodeValue({ kind: "tuple", components: params }, values, "arguments");
}

/** Calldata: the selector, then the encoded parameters. */
export function encodeCall(f, values) {
  const sel = Uint8Array.from(f.selector.slice(2).match(/../g), (h) => parseInt(h, 16));
  return concat([sel, f.inputs.length ? encodeParams(f.inputs, values) : new Uint8Array(0)]);
}

export const DEFAULT_ABI_LIMITS = Object.freeze({ maxBytes: 128 * 1024, maxDepth: 32, maxElements: 4096 });

class Decoder {
  constructor(data, limits) {
    this.data = data;
    this.limits = limits;
    this.elements = 0;
  }
  word(at, where) {
    if (at + WORD > this.data.length) fail("E_ABI_DECODE", `${where}: the data ends before this value`);
    let x = 0n;
    for (let i = 0; i < WORD; i++) x = (x << 8n) | BigInt(this.data[at + i]);
    return x;
  }
  size(at, where, what) {
    const x = this.word(at, where);
    if (x > BigInt(this.data.length)) fail("E_ABI_DECODE", `${where}: ${what} ${x} is beyond the end of the data`);
    return Number(x);
  }
  tuple(types, base, depth, at) {
    if (depth > this.limits.maxDepth) fail("E_ABI_DECODE", `${at(0)}: nested deeper than ${this.limits.maxDepth}`);
    const out = [];
    let pos = base;
    types.forEach((t, i) => {
      if (isDynamic(t)) {
        out.push(this.value(t, base + this.size(pos, at(i), "offset"), depth + 1, at(i)));
        pos += WORD;
      } else {
        out.push(this.value(t, pos, depth + 1, at(i)));
        pos += headSize(t);
      }
    });
    return out;
  }
  value(t, at, depth, where) {
    switch (t.kind) {
      case "uint":
      case "int": {
        let x = this.word(at, where);
        if (t.kind === "int") x = BigInt.asIntN(256, x);
        return x.toString(); // a value outside the type is caught when re-encoded
      }
      case "bool":
        return this.word(at, where) !== 0n;
      case "address":
        return toChecksumAddress(`0x${this.word(at, where).toString(16).padStart(64, "0").slice(-40)}`);
      case "fixedbytes":
        this.word(at, where);
        return this.data.slice(at, at + t.size);
      case "bytes":
      case "string": {
        const n = this.size(at, where, "length");
        if (n > this.limits.maxBytes) fail("E_ABI_DECODE", `${where}: ${n} bytes is over the limit of ${this.limits.maxBytes}`);
        if (at + WORD + n > this.data.length) fail("E_ABI_DECODE", `${where}: the data ends inside this value`);
        const b = this.data.slice(at + WORD, at + WORD + n);
        if (t.kind === "bytes") return b;
        try {
          return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
        } catch {
          fail("E_ABI_DECODE", `${where}: the string is not UTF-8`);
        }
        break;
      }
      case "array": {
        let n = t.length;
        let base = at;
        if (n === null) {
          n = this.size(at, where, "length");
          base = at + WORD;
        }
        this.elements += n;
        if (this.elements > this.limits.maxElements) fail("E_ABI_DECODE", `${where}: more than ${this.limits.maxElements} array elements in the call`);
        return this.tuple(Array(n).fill(t.element), base, depth, (i) => `${where}[${i}]`);
      }
      case "tuple": {
        const keys = t.components.map(componentKey);
        const vals = this.tuple(t.components.map((c) => c.type), at, depth, (i) => `${where}.${keys[i]}`);
        return Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
      }
    }
    fail("E_ABI_DECODE", `${where}: unknown type`);
  }
}

/**
 * Decode ABI-encoded parameters strictly: the bytes must be exactly what `encodeParams` writes for the values read,
 * so dirty padding, a value outside its type, an offset that is not the canonical one and trailing bytes are all
 * refused (E_ABI_DECODE).
 *
 * @param {{ name: string | null, type: object }[]} params
 * @param {Uint8Array} data
 * @param {{ maxBytes?: number, maxDepth?: number, maxElements?: number }} [limits]
 */
export function decodeParams(params, data, limits = {}) {
  const lim = { ...DEFAULT_ABI_LIMITS, ...limits };
  if (!(data instanceof Uint8Array)) fail("E_ABI_DECODE", "the data must be a Uint8Array");
  if (data.length > lim.maxBytes) fail("E_ABI_DECODE", `${data.length} bytes is over the limit of ${lim.maxBytes}`);
  const t = { kind: "tuple", components: params };
  const values = new Decoder(data, lim).value(t, 0, 0, "arguments");
  let again;
  try {
    again = encodeValue(t, values, "arguments");
  } catch (e) {
    if (e instanceof AbiError) fail("E_ABI_DECODE", e.message.replace(/^arguments/, "arguments"));
    throw e;
  }
  if (again.length !== data.length || again.some((b, i) => b !== data[i])) {
    fail("E_ABI_DECODE", "the data is not the canonical ABI encoding of its values (dirty padding, a non-canonical offset or trailing bytes)");
  }
  return values;
}

// ---------------------------------------------------------------------------------------------- EIP-712

const EIP712_DOMAIN = [
  ["name", "string"],
  ["version", "string"],
  ["chainId", "uint256"],
  ["verifyingContract", "address"],
  ["salt", "bytes32"],
];

function typeEncoding(types, primary) {
  const deps = new Set();
  const visit = (name) => {
    if (deps.has(name) || !Object.hasOwn(types, name)) return;
    deps.add(name);
    for (const f of types[name]) visit(f.type.replace(/(\[\d*\])+$/, ""));
  };
  visit(primary);
  deps.delete(primary);
  return [primary, ...[...deps].sort()].map((n) => `${n}(${types[n].map((f) => `${f.type} ${f.name}`).join(",")})`).join("");
}

function encodeField(types, type, value, where) {
  const arr = /^(.*)\[(\d*)\]$/.exec(type);
  if (arr) {
    if (!Array.isArray(value)) fail("E_ABI_ENCODE", `${where}: ${type} needs an array`);
    if (arr[2] !== "" && value.length !== Number(arr[2])) fail("E_ABI_ENCODE", `${where}: ${type} needs ${arr[2]} elements`);
    return keccak256(concat(value.map((v, i) => encodeField(types, arr[1], v, `${where}[${i}]`))));
  }
  if (Object.hasOwn(types, type)) return hashStruct(types, type, value, where);
  if (type === "string") {
    if (typeof value !== "string" || !value.isWellFormed()) fail("E_ABI_ENCODE", `${where}: string needs well-formed text`);
    return keccak256(new TextEncoder().encode(value));
  }
  if (type === "bytes") return keccak256(bytesFrom(value, where));
  const t = elementary(type, where);
  if (t.kind === "uint" || t.kind === "int") {
    const v = typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : value; // EIP-712 JSON allows small numbers
    return encodeValue(t, v, where);
  }
  return encodeValue(t, value, where);
}

function hashStruct(types, name, value, where) {
  if (value === null || typeof value !== "object") fail("E_ABI_ENCODE", `${where}: ${name} needs an object`);
  const fields = types[name];
  for (const k of Object.keys(value)) if (!fields.some((f) => f.name === k)) fail("E_ABI_ENCODE", `${where}: ${name} has no field ${k}`);
  const parts = [keccak256(typeEncoding(types, name))];
  for (const f of fields) {
    if (!Object.hasOwn(value, f.name)) fail("E_ABI_ENCODE", `${where}: missing ${name}.${f.name}`);
    parts.push(encodeField(types, f.type, value[f.name], `${where}.${f.name}`));
  }
  return keccak256(concat(parts));
}

/**
 * The EIP-712 digest of typed data (`keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(message))`): what a signer signs.
 * `types` need not list EIP712Domain; it is derived from the domain's fields when absent.
 *
 * @param {{ domain: object, types: Record<string, { name: string, type: string }[]>, primaryType: string, message: object }} typed
 * @returns {string}  `0x` and 64 hex digits
 */
export function typedDataDigest({ domain, types, primaryType, message }) {
  const all = { ...types };
  if (!Object.hasOwn(all, "EIP712Domain")) all.EIP712Domain = EIP712_DOMAIN.filter(([k]) => Object.hasOwn(domain, k)).map(([name, type]) => ({ name, type }));
  if (!Object.hasOwn(all, primaryType)) fail("E_ABI_ENCODE", `no type ${primaryType}`);
  const separator = hashStruct(all, "EIP712Domain", domain, "domain");
  const struct = hashStruct(all, primaryType, message, "message");
  return `0x${hexOf(keccak256(concat([Uint8Array.of(0x19, 0x01), separator, struct])))}`;
}
