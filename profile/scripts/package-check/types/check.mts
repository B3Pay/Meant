// A tiny assertion for the consumer programs: they import no node:* module, so they compile without Node's types.
export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`check failed: ${message}`);
}

export function bytesFromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
}

/** A small ledger with both standards: the union of the two packs' fragments (as in the resolver's tests). */
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
