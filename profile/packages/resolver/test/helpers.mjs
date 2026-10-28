import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSchemaValidator, resolveService, compileInterface } from "../src/index.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const read = (p) => readFile(path.isAbsolute(p) ? p : path.join(ROOT, p), "utf8");
export const readJson = async (p) => JSON.parse(await read(p));
export const validateSchema = await createSchemaValidator();
export const icrc1 = await readJson("packs/icrc1.profile.json");
export const icrc2 = await readJson("packs/icrc2.profile.json");

/** A small ledger that has both standards: the union of the two packs' fragments. */
export const LEDGER_DID = `
type Account = record { owner : principal; subaccount : opt blob };
type TransferArgs = record {
  from_subaccount : opt blob; to : Account; amount : nat; fee : opt nat; memo : opt blob; created_at_time : opt nat64;
};
type TransferError = variant {
  BadFee : record { expected_fee : nat };
  BadBurn : record { min_burn_amount : nat };
  InsufficientFunds : record { balance : nat };
  TooOld;
  CreatedInFuture : record { ledger_time : nat64 };
  Duplicate : record { duplicate_of : nat };
  TemporarilyUnavailable;
  GenericError : record { error_code : nat; message : text };
};
type ApproveArgs = record {
  from_subaccount : opt blob; spender : Account; amount : nat; expected_allowance : opt nat;
  expires_at : opt nat64; fee : opt nat; memo : opt blob; created_at_time : opt nat64;
};
type ApproveError = variant {
  BadFee : record { expected_fee : nat };
  InsufficientFunds : record { balance : nat };
  AllowanceChanged : record { current_allowance : nat };
  Expired : record { ledger_time : nat64 };
  TooOld;
  CreatedInFuture : record { ledger_time : nat64 };
  Duplicate : record { duplicate_of : nat };
  TemporarilyUnavailable;
  GenericError : record { error_code : nat; message : text };
};
type TransferFromArgs = record {
  spender_subaccount : opt blob; from : Account; to : Account; amount : nat; fee : opt nat; memo : opt blob; created_at_time : opt nat64;
};
type TransferFromError = variant {
  BadFee : record { expected_fee : nat };
  BadBurn : record { min_burn_amount : nat };
  InsufficientFunds : record { balance : nat };
  InsufficientAllowance : record { allowance : nat };
  TooOld;
  CreatedInFuture : record { ledger_time : nat64 };
  Duplicate : record { duplicate_of : nat };
  TemporarilyUnavailable;
  GenericError : record { error_code : nat; message : text };
};
type AllowanceArgs = record { account : Account; spender : Account };
service : {
  icrc1_symbol : () -> (text) query;
  icrc1_decimals : () -> (nat8) query;
  icrc1_fee : () -> (nat) query;
  icrc1_balance_of : (Account) -> (nat) query;
  icrc1_transfer : (TransferArgs) -> (variant { Ok : nat; Err : TransferError });
  icrc2_approve : (ApproveArgs) -> (variant { Ok : nat; Err : ApproveError });
  icrc2_transfer_from : (TransferFromArgs) -> (variant { Ok : nat; Err : TransferFromError });
  icrc2_allowance : (AllowanceArgs) -> (record { allowance : nat; expires_at : opt nat64 }) query;
}
`;

export async function interfaceIdOf(did) {
  const { iface, failure } = await compileInterface(did);
  if (failure) throw new Error(JSON.stringify(failure));
  return iface.interfaceId;
}

export function canisterProfile({ name = "mine", origin = "author", interfaceId, annotations, canister_id }) {
  return {
    format: "candid-profile", format_version: 0, kind: "canister", name, origin, language: "en",
    binds: { interface_id: interfaceId, ...(canister_id ? { canister_id } : {}) },
    annotations,
  };
}

/** resolveService with the shared schema validator; `profiles` and `packs` are plain documents. */
export function resolve(did, { profiles = [], packs = [] } = {}) {
  return resolveService({
    did, validateSchema,
    profiles: profiles.map((doc) => ({ doc })),
    packs: packs.map((doc) => ({ doc })),
  });
}

export const codes = (r) => r.diagnostics.map((d) => d.code);
export const byCode = (r, code) => r.diagnostics.filter((d) => d.code === code);
export const errors = (r) => r.diagnostics.filter((d) => d.severity === "error");

/** Walk a resolved tree by field/case names: node(m.args[0], "to", "owner"). */
export function node(tree, ...names) {
  let n = tree;
  for (const name of names) n = name === "[]" ? n.element : (n.fields ?? n.cases)[name];
  return n;
}
