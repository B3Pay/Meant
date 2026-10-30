// The two ways to talk to the ledgers on PocketIC. Native: @icp-sdk/canisters' IcrcLedgerCanister over an actor from
// its own IDL. Meant: candid-core's codec for the ledger's .did, the resolved form @meantjs/profile makes from the
// .did and the packs it ships, and the refs the profile names, read from the ledger itself.
import { didToContract } from "@candid-core/cli";
import { serviceMethods } from "@candid-core/schema";
import { decodeArgs, encodeArgs } from "@candid-core/schema/codec";
import { schemaFromContract } from "@candid-core/schema/contract";
import { createSchemaValidator, loadPacks, resolveService } from "@meantjs/profile";
import { IcrcLedgerCanister } from "@icp-sdk/canisters/ledger/icrc";
// The package does not export its declarations; the IDL is the one its IcrcLedgerCanister is built on.
import { idlFactory } from "../node_modules/@icp-sdk/canisters/declarations/ledger-icrc/icrc_ledger.idl.js";

export async function ledgerInterface(did) {
  const compiled = await didToContract(did);
  if (compiled.ok === false) throw new Error(`the ledger .did does not compile: ${JSON.stringify(compiled.diagnostics)}`);
  const loaded = schemaFromContract(compiled);
  if (!loaded.ok) throw new Error("candid-core cannot load the ledger contract");
  const methods = serviceMethods(loaded.actor);
  const validateSchema = await createSchemaValidator();
  const packs = (await loadPacks()).map(({ doc }) => ({ doc }));
  const r = await resolveService({ did, validateSchema, packs });
  if (!r.ok) throw new Error(`resolve: ${JSON.stringify(r.diagnostics.filter((d) => d.severity === "error"))}`);
  const encode = (method, args) => {
    const e = encodeArgs(methods.get(method).args, args);
    if (!e.ok) throw new Error(`${method}: ${JSON.stringify(e.issues)}`);
    return e.bytes;
  };
  const decode = (method, bytes) => {
    const d = decodeArgs(methods.get(method).results, bytes);
    if (!d.ok) throw new Error(`${method}: ${JSON.stringify(d.issues)}`);
    return d.values[0];
  };
  return { methods, resolved: r.resolved, profiles: r.profiles, encode, decode };
}

/** Every `{ from: "query:<method>" }` the resolved form names, read from the canister: what makes "1.5" mean 1.5 TKB. */
export async function refsFromCanister(iface, pic, canisterId, sender) {
  const names = new Set();
  JSON.stringify(iface.resolved, (k, v) => {
    if (k === "from" && typeof v === "string" && v.startsWith("query:")) names.add(v);
    return v;
  });
  const refs = {};
  for (const ref of [...names].sort()) {
    const method = ref.slice("query:".length);
    const reply = await pic.queryCall({ canisterId, method, arg: iface.encode(method, []), sender });
    refs[ref] = iface.decode(method, reply);
  }
  return refs;
}

/**
 * IcrcLedgerCanister on an actor of PocketIC's. `loseReplies` names methods whose first reply is lost: the ledger
 * runs the call, then the caller gets a network error instead of the answer, as after a dropped connection.
 */
export function nativeLedger(pic, canisterId, sender, { loseReplies = [] } = {}) {
  const actor = pic.createActor({ idlFactory, canisterId, sender });
  const lost = new Set();
  const lossy = new Proxy(actor, {
    get(target, prop) {
      const fn = target[prop];
      if (typeof fn !== "function" || !loseReplies.includes(prop)) return fn;
      return async (...args) => {
        const reply = await fn.apply(target, args);
        if (lost.has(prop)) return reply;
        lost.add(prop);
        throw new Error("network error: the connection dropped before the reply arrived");
      };
    },
  });
  return IcrcLedgerCanister.create({ canisterId, serviceOverride: lossy, certifiedServiceOverride: lossy });
}

/** The ledger's transfer blocks, through ICRC-3, in the { tag, value } shape @meantjs/reconcile reads. */
export async function transferBlocks(iface, pic, canisterId, sender) {
  const reply = iface.decode("icrc3_get_blocks", await pic.queryCall({ canisterId, method: "icrc3_get_blocks", arg: iface.encode("icrc3_get_blocks", [[{ start: 0n, length: 1000n }]]), sender }));
  return { logLength: reply.log_length, blocks: reply.blocks.map((b) => ({ id: b.id, block: b.block })) };
}

export async function balanceOf(iface, pic, canisterId, owner) {
  const arg = iface.encode("icrc1_balance_of", [{ owner: owner.toText(), subaccount: null }]);
  return iface.decode("icrc1_balance_of", await pic.queryCall({ canisterId, method: "icrc1_balance_of", arg, sender: owner }));
}
