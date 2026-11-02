# API guide

This guide is generated from the canister's Meant profile. It says what the positions of the interface in `candid:service` mean; it does not change them. Every path below is an address of the profile spec: `method(0).field` is a field of the first argument, `method->(0).Err.Case` a case of the first result.

- Interface: `candid-core:interface:v1:sha256:f8358625dd47a9b6a237a3a268ba83291fcd0dc27093e80ac27cc48a49dc1d6c`
- Profile: `tokens-example` (author), `candid-profile:v0:sha256:70abc8cbce701650b6adafeabbf636a10b9c80e620bfcb6cc2d8793ee027745c`

## Before you call

- Ask the person to confirm before any call marked so below (`send`). Show what the call does, in human units, and send it only after their yes.
- Amounts are integers in base units. Convert exactly: an amount with more fractional digits than the token has is an error, never rounded.
- Times are integers since the Unix epoch, in the unit each position names. Take the current time from the canister (a recent certificate), not from your own clock.
- A reply case this guide does not classify is a failure: do not retry it.

## Units and encoding

- **Amount:** a whole number of base units. With d decimals, 1 token = 10^d base units, so `1.5` of a token with 8 decimals is `150_000_000`.

## Retries

- `send`: set the stamp once per intent, to the canister's current time, and encode the arguments once. After a timeout or an unknown outcome, send exactly the same bytes again; inside its deduplication window the canister executes the call once or answers with an `already_done` case.
- What each outcome class below means:
  - `success`: done.
  - `already_done`: an identical call already executed: treat it as success, report the earlier result, and do not send it again.
  - `fail`: do not retry.

## Methods

### `balance` (query)

- Effect: `read`.
- Result:
  - `balance->(0).e8s`: Balance; an amount of TOK in base units (8 decimals).

### `send` (update)

- Effect: `transfer`, irreversible; **ask the person to confirm before you call it**.
- What it does: Send TOK. Template: `Send {amount.e8s} to {to}[ with memo {memo}]`, where each `{path}` is the argument at that path, in human units.
- Arguments:
  - `send(0).memo` (opt): the UTF-8 bytes of a text; suggested value: `null`.
  - `send(0).created_at` (opt): a time, in nanoseconds since the Unix epoch (UTC); the idempotency stamp (see Retries).
  - `send(0).amount.e8s`: Amount; an amount of TOK in base units (8 decimals).
- Result:
  - `send->(0).Err.Insufficient.balance.e8s`: Amount; an amount of TOK in base units (8 decimals).
- Idempotency: set `created_at` once per intent and resend exactly the same arguments on every retry (see Retries).
- Outcomes, by the case of the reply:
  - `Ok`: `success`
  - `Err.Duplicate`: `already_done`
  - `Err.Insufficient`, `Err.Other`: `fail`
  - any other case: `fail`
