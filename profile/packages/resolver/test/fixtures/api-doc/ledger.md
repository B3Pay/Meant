# ICP ledger

This guide is generated from the canister's Meant profile. It says what the positions of the interface in `candid:service` mean; it does not change them. Every path below is an address of the profile spec: `method(0).field` is a field of the first argument, `method->(0).Err.Case` a case of the first result.

- Interface: `candid-core:interface:v1:sha256:22eb4787e1a755acb9aabd0ed2121d754098bcd1cedb5d0ed8b5c4effb921846`
- Profile: `icrc1` (pack), `candid-profile:v0:sha256:4eaa9312d60661248ff5627dba9906aa91240abe84cb1b1da8ca20a6fba2e3e6`
- Profile: `icrc2` (pack), `candid-profile:v0:sha256:f9d75e8bf5ff2edb0b167988feee494eeb54c386e6f62252c4bd96ac56346567`

## Before you call

- Ask the person to confirm before any call marked so below (`icrc1_transfer`, `icrc2_approve` or `icrc2_transfer_from`). Show what the call does, in human units, and send it only after their yes.
- Amounts are integers in base units. Convert exactly: an amount with more fractional digits than the token has is an error, never rounded.
- Times are integers since the Unix epoch, in the unit each position names. Take the current time from the canister (a recent certificate), not from your own clock.
- An update without an idempotency stamp (`icrc21_canister_call_consent_message`) whose outcome is unknown (a timeout, "may or may not have been executed") must not be sent again automatically: check whether it took effect, and ask the person.
- A reply case this guide does not classify is a failure: do not retry it.

## Units and encoding

- **Amount:** a whole number of base units. With d decimals, 1 token = 10^d base units, so `1.5` of a token with 8 decimals is `150_000_000`.
- **ICRC-1 account:** `record { owner : principal; subaccount : opt blob }`. People write it as the bare principal (default subaccount) or as `principal-checksum.subaccounthex`; check the checksum.

## Retries

- `icrc1_transfer`, `icrc2_approve` or `icrc2_transfer_from`: set the stamp once per intent, to the canister's current time, and encode the arguments once. After a timeout or an unknown outcome, send exactly the same bytes again; inside its deduplication window the canister executes the call once or answers with an `already_done` case.
- Rule 1: if an earlier attempt had an unknown outcome and a later one returns a `retry_new` case, the window has passed and the first attempt may have executed. Look for it in the canister's history (ICRC-3 blocks since the stamp) before any new attempt, and ask the person when the history cannot settle it.
- Rule 2: after a case that reports the canister's time (ICRC-1's `CreatedInFuture` does), the new stamp must not exceed that time.
- Rule 3: stop `retry_same` retries before the window can close; then apply rule 1.
- What each outcome class below means:
  - `success`: done.
  - `already_done`: an identical call already executed: treat it as success, report the earlier result, and do not send it again.
  - `retry_same`: transient: retry with exactly the same encoded arguments, a few times at most, with backoff.
  - `retry_new`: the idempotency stamp is outside the canister's window or ahead of its clock: set a new stamp, show the person the new call, and send it only after their yes (but see rule 1 under Retries).
  - `fix_input`: the input needs correcting; the error's fields say how.
  - `fail`: do not retry.

## Methods

### `archives` (query)

- Effect: `read`.

### `get_blocks` (query)

- Effect: `read`.

### `get_data_certificate` (query)

- Effect: `read`.

### `get_transactions` (query)

- Effect: `read`.

### `icrc103_get_allowances` (query)

- Effect: `read`.

### `icrc106_get_index_principal` (query)

- Effect: `read`.

### `icrc10_supported_standards` (query)

- Effect: `read`.

### `icrc1_balance_of` (query)

Balance of an account.

- Effect: `read`.
- Arguments:
  - `icrc1_balance_of(0)`: an ICRC-1 account.
- Result:
  - `icrc1_balance_of->(0)`: an amount of ICP in base units (8 decimals).

### `icrc1_decimals` (query)

- Effect: `read`.

### `icrc1_fee` (query)

- Effect: `read`.
- Result:
  - `icrc1_fee->(0)`: an amount of ICP in base units (8 decimals).

### `icrc1_metadata` (query)

- Effect: `read`.

### `icrc1_minting_account` (query)

- Effect: `read`.

### `icrc1_name` (query)

- Effect: `read`.

### `icrc1_supported_standards` (query)

- Effect: `read`.

### `icrc1_symbol` (query)

- Effect: `read`.

### `icrc1_total_supply` (query)

- Effect: `read`.

### `icrc1_transfer` (update)

- Effect: `transfer`, irreversible; **ask the person to confirm before you call it**.
- What it does: Send tokens. Template: `Send {amount} to {to}[ from subaccount {from_subaccount}][ with memo {memo}][ paying fee {fee}]`, where each `{path}` is the argument at that path, in human units.
- Grants the recipient at `to` up to the amount at `amount`, once: the grant ends when the transfer is made. Tell the person who may take how much, and until when.
- Arguments:
  - `icrc1_transfer(0).to`: Recipient; an ICRC-1 account.
  - `icrc1_transfer(0).fee` (opt): Fee; an amount of ICP in base units (8 decimals); send `null` here unless the person asks for something else. Leave empty to pay the ledger's current default fee. A wrong explicit fee fails with BadFee.
  - `icrc1_transfer(0).memo` (opt): Memo; the UTF-8 bytes of a text; suggested value: `null`. Transfers with different memos are never deduplicated against each other. Ledgers accept at least 32 bytes; longer memos may be rejected.
  - `icrc1_transfer(0).from_subaccount` (opt): From subaccount; a subaccount: exactly 32 bytes. Omit to send from the default subaccount.
  - `icrc1_transfer(0).created_at_time` (opt): Created at; a time, in nanoseconds since the Unix epoch (UTC); the idempotency stamp (see Retries). Set once per intent by the tool layer; enables the ledger's duplicate protection.
  - `icrc1_transfer(0).amount`: Amount; an amount of ICP in base units (8 decimals).
- Result:
  - `icrc1_transfer->(0).Ok`: Block index.
  - `icrc1_transfer->(0).Err.BadBurn.min_burn_amount`: an amount of ICP in base units (8 decimals).
  - `icrc1_transfer->(0).Err.Duplicate.duplicate_of`: Existing block index. The same transfer was already executed in this block.
  - `icrc1_transfer->(0).Err.BadFee.expected_fee`: an amount of ICP in base units (8 decimals).
  - `icrc1_transfer->(0).Err.CreatedInFuture.ledger_time`: a time, in nanoseconds since the Unix epoch (UTC).
  - `icrc1_transfer->(0).Err.InsufficientFunds.balance`: an amount of ICP in base units (8 decimals).
- Idempotency: set `created_at_time` once per intent and resend exactly the same arguments on every retry (see Retries).
- Outcomes, by the case of the reply:
  - `Ok`: `success`
  - `Err.Duplicate`: `already_done`
  - `Err.TemporarilyUnavailable`: `retry_same`
  - `Err.TooOld`, `Err.CreatedInFuture`: `retry_new`
  - `Err.BadFee`, `Err.BadBurn`: `fix_input`
  - `Err.InsufficientFunds`, `Err.GenericError`: `fail`
  - any other reply: `fail`

### `icrc21_canister_call_consent_message` (update)

- Effect: `write`, irreversible.

### `icrc2_allowance` (query)

- Effect: `read`.
- Arguments:
  - `icrc2_allowance(0).account`: an ICRC-1 account.
  - `icrc2_allowance(0).spender`: an ICRC-1 account.
- Result:
  - `icrc2_allowance->(0).allowance`: an amount of ICP in base units (8 decimals).
  - `icrc2_allowance->(0).expires_at` (opt): a time, in nanoseconds since the Unix epoch (UTC).

### `icrc2_approve` (update)

- Effect: `approve`; **ask the person to confirm before you call it**.
- What it does: Approve spending. Template: `Set {spender}'s allowance to {amount}, replacing any existing allowance[ (only if the current allowance is {expected_allowance})][ until {expires_at}][ from subaccount {from_subaccount}][ with memo {memo}]`, where each `{path}` is the argument at that path, in human units.
- Grants the spender at `spender` up to the amount at `amount`, until the latest of `expires_at`. Tell the person who may take how much, and until when.
- Arguments:
  - `icrc2_approve(0).fee` (opt): an amount of ICP in base units (8 decimals); send `null` here unless the person asks for something else.
  - `icrc2_approve(0).memo` (opt): Memo; the UTF-8 bytes of a text; suggested value: `null`. Ledgers accept at least 32 bytes; longer memos may be rejected.
  - `icrc2_approve(0).from_subaccount` (opt): From subaccount; a subaccount: exactly 32 bytes.
  - `icrc2_approve(0).created_at_time` (opt): a time, in nanoseconds since the Unix epoch (UTC); the idempotency stamp (see Retries).
  - `icrc2_approve(0).amount`: Allowance; an amount of ICP in base units (8 decimals). Maximum the spender may transfer. An approval replaces the previous allowance; it does not add to it.
  - `icrc2_approve(0).expected_allowance` (opt): Expected current allowance; an amount of ICP in base units (8 decimals). Optional safety check: the call fails with AllowanceChanged if the current allowance differs.
  - `icrc2_approve(0).expires_at` (opt): Expires at; a time, in nanoseconds since the Unix epoch (UTC). Omit for an allowance that does not expire.
  - `icrc2_approve(0).spender`: Spender; an ICRC-1 account.
- Result:
  - `icrc2_approve->(0).Ok`: Block index.
  - `icrc2_approve->(0).Err.BadFee.expected_fee`: an amount of ICP in base units (8 decimals).
  - `icrc2_approve->(0).Err.AllowanceChanged.current_allowance`: an amount of ICP in base units (8 decimals).
  - `icrc2_approve->(0).Err.CreatedInFuture.ledger_time`: a time, in nanoseconds since the Unix epoch (UTC).
  - `icrc2_approve->(0).Err.Expired.ledger_time`: a time, in nanoseconds since the Unix epoch (UTC).
  - `icrc2_approve->(0).Err.InsufficientFunds.balance`: an amount of ICP in base units (8 decimals).
- Idempotency: set `created_at_time` once per intent and resend exactly the same arguments on every retry (see Retries).
- Outcomes, by the case of the reply:
  - `Ok`: `success`
  - `Err.Duplicate`: `already_done`
  - `Err.TemporarilyUnavailable`: `retry_same`
  - `Err.TooOld`, `Err.CreatedInFuture`: `retry_new`
  - `Err.BadFee`, `Err.AllowanceChanged`, `Err.Expired`: `fix_input`
  - `Err.InsufficientFunds`, `Err.GenericError`: `fail`
  - any other reply: `fail`

### `icrc2_transfer_from` (update)

- Effect: `transfer`, irreversible; **ask the person to confirm before you call it**.
- What it does: Transfer using allowance. Template: `Move {amount} from {from} to {to} using an allowance[ (spender subaccount {spender_subaccount})][ with memo {memo}]`, where each `{path}` is the argument at that path, in human units.
- Arguments:
  - `icrc2_transfer_from(0).to`: Recipient; an ICRC-1 account.
  - `icrc2_transfer_from(0).fee` (opt): an amount of ICP in base units (8 decimals); send `null` here unless the person asks for something else.
  - `icrc2_transfer_from(0).spender_subaccount` (opt): Spender subaccount; a subaccount: exactly 32 bytes.
  - `icrc2_transfer_from(0).from`: From; an ICRC-1 account.
  - `icrc2_transfer_from(0).memo` (opt): Memo; the UTF-8 bytes of a text; suggested value: `null`. Ledgers accept at least 32 bytes; longer memos may be rejected.
  - `icrc2_transfer_from(0).created_at_time` (opt): a time, in nanoseconds since the Unix epoch (UTC); the idempotency stamp (see Retries).
  - `icrc2_transfer_from(0).amount`: Amount; an amount of ICP in base units (8 decimals).
- Result:
  - `icrc2_transfer_from->(0).Ok`: Block index.
  - `icrc2_transfer_from->(0).Err.InsufficientAllowance.allowance`: an amount of ICP in base units (8 decimals).
  - `icrc2_transfer_from->(0).Err.BadBurn.min_burn_amount`: an amount of ICP in base units (8 decimals).
  - `icrc2_transfer_from->(0).Err.BadFee.expected_fee`: an amount of ICP in base units (8 decimals).
  - `icrc2_transfer_from->(0).Err.CreatedInFuture.ledger_time`: a time, in nanoseconds since the Unix epoch (UTC).
  - `icrc2_transfer_from->(0).Err.InsufficientFunds.balance`: an amount of ICP in base units (8 decimals).
- Idempotency: set `created_at_time` once per intent and resend exactly the same arguments on every retry (see Retries).
- Outcomes, by the case of the reply:
  - `Ok`: `success`
  - `Err.Duplicate`: `already_done`
  - `Err.TemporarilyUnavailable`: `retry_same`
  - `Err.TooOld`, `Err.CreatedInFuture`: `retry_new`
  - `Err.BadFee`, `Err.BadBurn`: `fix_input`
  - `Err.InsufficientFunds`, `Err.InsufficientAllowance`, `Err.GenericError`: `fail`
  - any other reply: `fail`

### `icrc3_get_archives` (query)

- Effect: `read`.

### `icrc3_get_blocks` (query)

- Effect: `read`.

### `icrc3_get_tip_certificate` (query)

- Effect: `read`.

### `icrc3_supported_block_types` (query)

- Effect: `read`.

### `is_ledger_ready` (query)

- Effect: `read`.
