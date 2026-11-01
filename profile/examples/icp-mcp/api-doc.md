# TOK, an example token ready for ICP MCP

This guide is generated from the canister's Candid Profile. It says what the positions of the interface in `candid:service` mean; it does not change them. Every path below is an address of the profile spec: `method(0).field` is a field of the first argument, `method->(0).Err.Case` a case of the first result.

- Interface: `candid-core:interface:v1:sha256:88f4bbfeb015b87b623f049c09150328b82f800616110fa2ea739d9a44643d9b`
- Profile: `icp-mcp-example` (author), `candid-profile:v0:sha256:062d31e110dd7ffca136e2adf338118c40e5612e77802d2e0fc50cc95ea23198`

## Before you call

- Ask the person to confirm before any call marked so below (`send`). Show what the call does, in human units, and send it only after their yes.
- Amounts are integers in base units. Convert exactly: an amount with more fractional digits than the token has is an error, never rounded.
- Times are integers since the Unix epoch, in the unit each position names. Take the current time from the canister (a recent certificate), not from your own clock.
- A reply case this guide does not classify is a failure: do not retry it.

## Units and encoding

- **Amount:** a whole number of base units. With d decimals, 1 token = 10^d base units, so `1.5` of a token with 8 decimals is `150_000_000`.

## Retries

- `send`: set the stamp once per intent, to the canister's current time, and encode the arguments once. After a timeout or an unknown outcome, send exactly the same bytes again; inside its deduplication window the canister executes the call once or answers with an `already_done` case.
- Rule 1: if an earlier attempt had an unknown outcome and a later one returns a `retry_new` case, the window has passed and the first attempt may have executed. Look for it in the canister's history (ICRC-3 blocks since the stamp) before any new attempt, and ask the person when the history cannot settle it.
- Rule 2: after a case that reports the canister's time (ICRC-1's `CreatedInFuture` does), the new stamp must not exceed that time.
- What each outcome class below means:
  - `success`: done.
  - `already_done`: an identical call already executed: treat it as success, report the earlier result, and do not send it again.
  - `retry_new`: the idempotency stamp is outside the canister's window or ahead of its clock: set a new stamp, show the person the new call, and send it only after their yes (but see rule 1 under Retries).
  - `fail`: do not retry.

## Methods

### `balance` (query)

Balance of a principal.

- Effect: `read`.
- Arguments:
  - `balance(0)`: Owner.
- Result:
  - `balance->(0).e8s`: Amount; an amount of TOK in base units (8 decimals).

### `get_api_doc` (query)

This guide. Generated from this canister's profile.

- Effect: `read`.

### `icrc10_supported_standards` (query)

Standards this canister supports.

- Effect: `read`.

### `icrc21_canister_call_consent_message` (update)

ICRC-21 consent message for a call. Show it to the person before a send; it is generated from the same profile.

- Effect: `read`; call it as an update, not a query, so that its answer is certified.

### `send` (update)

- Effect: `transfer`, irreversible; **ask the person to confirm before you call it**.
- What it does: Send TOK. Template: `Send {amount.e8s} to {to}[ with memo {memo}]`, where each `{path}` is the argument at that path, in human units.
- Arguments:
  - `send(0).to`: Recipient.
  - `send(0).memo` (opt): the UTF-8 bytes of a text; at most 32 bytes; suggested value: `null`.
  - `send(0).created_at` (opt): Created at; a time, in nanoseconds since the Unix epoch (UTC); the idempotency stamp (see Retries). The canister deduplicates a send that carries it for 24 hours.
  - `send(0).amount.e8s`: Amount; an amount of TOK in base units (8 decimals).
- Result:
  - `send->(0).Ok`: Block index.
  - `send->(0).Err.Duplicate.block`: Existing block index. The same send was already executed in this block.
  - `send->(0).Err.Insufficient.balance.e8s`: Amount; an amount of TOK in base units (8 decimals).
  - `send->(0).Err.CreatedInFuture.canister_time`: a time, in nanoseconds since the Unix epoch (UTC).
- Idempotency: set `created_at` once per intent and resend exactly the same arguments on every retry (see Retries).
- Outcomes, by the case of the reply:
  - `Ok`: `success`
  - `Err.Duplicate`: `already_done`
  - `Err.TooOld`, `Err.CreatedInFuture`: `retry_new`
  - `Err.Insufficient`: `fail`
  - any other reply: `fail`
