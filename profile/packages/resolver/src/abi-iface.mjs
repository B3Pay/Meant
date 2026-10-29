/**
 * An EVM contract interface as the resolver sees one (spec section 15, D-054): its function fragments laid out as the
 * graph a Candid interface compiles to, so that addresses, tags, merging and the resolved form work unchanged.
 *
 *   a function       a method; `view` and `pure` are queries, `nonpayable` and `payable` updates
 *   its parameters   one record at argument index 0 (`transfer(0).to`); a function without parameters has no argument
 *   its outputs      the result tuple (`balanceOf->(0)`)
 *   a tuple          a record whose fields keep the ABI order; a named component's id is the Candid hash of its name,
 *                    an unnamed one's is its position (`#1`)
 *   T[] and T[k]     a vector (`[]`); T[k] keeps its length
 *   anything else    a primitive named by its canonical ABI type (`uint256`, `address`, `bytes32`, `string`)
 *   an EIP-712       a method of mode "message" (spec section 15.9) whose one argument is the struct, a record of its
 *   message          members in order (`PermitSingle(0).details.amount`); it has no results
 */
import { Iface } from "./iface.mjs";
import { idlHash } from "./idl.mjs";
import { AbiError, abiInterfaceId, componentKey, eip712AbiType, eip712TypeHash, encodeType, parseAbi, parseEip712Types, readAddress } from "./abi.mjs";

export class AbiIface extends Iface {
  /**
   * @param functions from parseAbi
   * @param eip712  { types, messages } (spec section 15.9): the struct types, and which of them are messages
   */
  constructor(envelope, functions, label, eip712 = { types: {}, messages: [] }) {
    super(envelope, label);
    this.chain = "evm";
    this.functions = new Map(functions.map((f) => [f.name, f]));
    /** The identity of the functions alone: what a contract profile's `binds.abi` binds to (spec section 15.1). */
    this.abiId = abiInterfaceId(functions);
    this.structs = eip712.types;
    this.messages = new Map(eip712.messages.map((name) => [name, { encodeType: encodeType(eip712.types, name), typeHash: eip712TypeHash(eip712.types, name) }]));
  }
  resolve(addr) {
    const r = super.resolve(addr);
    if (r.error && addr.kind !== "type" && !this.methods.has(addr.method) && Object.hasOwn(this.structs, addr.method)) {
      return { error: `${addr.method} is an EIP-712 type but not a message: tag its name with intent to make it one, or address it through a message that contains it` };
    }
    return r;
  }
  isBlob(ref) {
    const p = this.prim(ref);
    return p === "bytes" || /^bytes\d+$/.test(p ?? "");
  }
  isAccount() { return false; }
  /** The canonical ABI type of a position: `uint256`, `address[]`, `(address,uint256)`. */
  describeType(ref) {
    const n = this.types[ref];
    if (n.kind === "primitive") return n.primitive;
    if (n.kind === "vec") return `${this.describeType(n.inner)}[${n.length ?? ""}]`;
    return `(${n.fields.map((f) => this.describeType(f.type)).join(",")})`;
  }
  /** The `abi` of a resolved-form node: the primitive's type, `tuple` or `array`. */
  abiType(ref) {
    const n = this.types[ref];
    return n.kind === "primitive" ? n.primitive : n.kind === "record" ? "tuple" : "array";
  }
}

/**
 * @param entries  an ABI: human-readable fragments or JSON ABI entries (parseAbi)
 * @param label    how diagnostics name it (`binds.abi`, `abi`)
 * @param eip712   { types, messages, label } (spec section 15.9): struct types already read by parseEip712Types, the
 *                 names of those that are messages, and how diagnostics name the types; null for none
 * @param opts.allowEmpty  an interface with no function and no message is not refused (resolveService adds the
 *                 messages of its profiles later)
 * @returns {{ iface: AbiIface } | { failure: { at: string, message: string }[] }}
 */
export function abiInterface(entries, label = "abi", ifaceLabel = "contract", eip712 = null, { allowEmpty = false } = {}) {
  const { functions, errors } = parseAbi(entries, label);
  if (errors.length) return { failure: errors };
  const messages = eip712?.messages ?? [];
  if (functions.length === 0 && messages.length === 0 && !allowEmpty) return { failure: [eip712 ? { at: eip712.label, message: "the ABI has no functions and no type is a message (tag a type's name with intent)" } : { at: label, message: "the ABI has no functions" }] };
  const types = [];
  const names = [];
  const failure = [];
  const add = (node) => types.push(node) - 1;
  const build = (t, where) => {
    if (t.kind === "tuple") {
      const ref = add(null);
      const ids = new Map();
      const fields = t.components.map((c, i) => {
        const id = c.name === null ? i : idlHash(c.name);
        const key = componentKey(c, i);
        if (ids.has(id)) failure.push({ at: where, message: `components ${ids.get(id)} and ${key} have the same field id ${id}; rename one` });
        ids.set(id, key);
        names.push([ref, id, key]);
        return { id, type: build(c.type, `${where}.${key}`) };
      });
      types[ref] = { kind: "record", fields };
      return ref;
    }
    if (t.kind === "array") {
      const ref = add(null);
      types[ref] = { kind: "vec", inner: build(t.element, `${where}[]`), length: t.length };
      return ref;
    }
    return add({ kind: "primitive", primitive: t.kind === "uint" || t.kind === "int" ? `${t.kind}${t.bits}` : t.kind === "fixedbytes" ? `bytes${t.size}` : t.kind });
  };
  const methods = functions.map((f) => {
    const args = f.inputs.length ? [build({ kind: "tuple", components: f.inputs }, `${f.name}(0)`)] : [];
    const results = f.outputs.map((o, i) => build(o.type, `${f.name}->(${i})`));
    const mode = f.stateMutability === "view" || f.stateMutability === "pure" ? "query" : "update";
    return { name: f.name, function: add({ kind: "func", mode, args, results }) };
  });
  for (const name of messages) {
    const at = `${eip712.label}.${name}`;
    if (functions.some((f) => f.name === name)) {
      failure.push({ at, message: `a function and a message are both named ${name}; an address names one of them` });
      continue;
    }
    methods.push({ name, function: add({ kind: "func", mode: "message", args: [build(eip712AbiType(eip712.types, name), `${name}(0)`)], results: [] }) });
  }
  if (failure.length) return { failure };
  const service = add({ kind: "service", methods });
  const structs = eip712?.types ?? {};
  const envelope = {
    contract: { types, declarations: [], actor: { kind: "service", service }, identities: { interface: abiInterfaceId(functions, structs) } },
    extensions: { "org.candid-core.field-names/v1": names },
  };
  return { iface: new AbiIface(envelope, functions, ifaceLabel, { types: structs, messages }) };
}

/**
 * The messages a profile or pack declares (spec section 15.9): the types of `binds.eip712` whose name the same
 * document tags with `intent`. Returns { types, messages, errors }.
 */
export function eip712Of(doc, label = "binds.eip712.types") {
  const spec = doc.binds?.eip712;
  if (spec === undefined) return { types: {}, messages: [], errors: [] };
  const { types, errors } = parseEip712Types(spec.types, label);
  const messages = [...new Set(doc.annotations.filter((a) => a.tag === "intent" && Object.hasOwn(types, a.at)).map((a) => a.at))].sort();
  return { types, messages, errors };
}

/**
 * `binds.deployments` of a contract profile: an address in mixed case must match its EIP-55 checksum, and a deployment
 * is listed once. `diag(severity, code, at, message)`.
 */
export function checkDeployments(doc, diag) {
  const seen = new Set();
  (doc.binds.deployments ?? []).forEach((d, i) => {
    const at = `binds.deployments[${i}]`;
    let address;
    try {
      address = readAddress(d.address);
    } catch (e) {
      if (!(e instanceof AbiError)) throw e;
      return diag("error", "E_ADDRESS_CHECKSUM", `${at}.address`, e.message);
    }
    const key = `${d.chain_id}:${address}`;
    if (seen.has(key)) diag("warning", "W_DUPLICATE", at, `chain ${d.chain_id} ${address} is listed twice`);
    seen.add(key);
  });
}
