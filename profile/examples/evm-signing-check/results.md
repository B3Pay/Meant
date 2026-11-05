# The signing check, replayed on a local chain

Written by `npm start` on 2026-11-04 17:12 UTC (Node v22.23.4). Each request below was handed to an AI agent's EVM key twice: once straight to the key, with nothing in between (a viem account, through x402's own client or a viem wallet client), and once through Meant's signing check (`src/signing-check.mjs`), after the user confirmed the task's terms. Every signature the key gave was then used by the party the request names, on a local EVM that runs Base Sepolia's USDC, Permit2 and x402 contracts at their addresses, and the USDC that moved is read back from that chain. Each request starts from the same state: the agent holds 1,000 USDC and has approved Permit2 once.

**Bad requests signed: 11 of 11 by the bare key, 0 of 11 behind the check.** Real requests signed: 4 of 4 by the bare key, 4 of 4 behind the check. The bare key's signatures for bad requests moved up to 1,000 USDC of the agent's 1,000 USDC; behind the check none of them was signed, so none of them moved anything.

The agent here is a script that hands every request to the signer; no model is asked. The check is in the signer, so it answers the same whatever the agent decides.

## An agent pays an API by x402

The user asked: "Get today's forecast from the Weather API, and pay it at most 0.05 USDC."

The terms the user confirmed on the wallet's screen: "Weather API (0xeaCF2A8C912F23029766162A907deE22D3b36D51) may be sent at most 0.05 USDC, until the end of 5 November 2026 (UTC)."

| Request | Bare key | Behind the check |
|---|---|---|
| **Real:** Pays the API 0.01 USDC (EIP-3009, x402's default) | Signed; Weather API got 0.01 USDC. | Signed; Weather API got 0.01 USDC. |
| **Attack:** The API asks for 25 USDC instead of 0.01 | Signed; Weather API got 25 USDC. | **Not signed.** The request allows 25 USDC, the terms say at most 0.05 USDC. |
| **Attack:** The 402 answer names another payee | Signed; the attacker got 0.01 USDC. | **Not signed.** The recipient is 0x3df316dA2A59C9Fd6FDEbe30130a9B9fb332eeeC, the terms say Weather API (0xeaCF2A8C912F23029766162A907deE22D3b36D51). |
| **Tampered:** The payment is for Base, a mainnet, and its USDC | Signed: a USDC payment valid on Base, a mainnet. Not used: this demo never touches a mainnet. | **Not signed.** The domain is for chain 8453, the wallet is on chain 84532. |
| **Second request:** A second 0.01 USDC payment for the same task | Signed both; Weather API got 0.02 USDC in all. | First signed; Weather API got 0.01 USDC. Second: **Not signed.** These terms cover one request, the one already checked; another request is a new task, with new terms. |
| **Real:** Pays the API 0.01 USDC by Permit2 (x402's exact proxy) | Signed; Weather API got 0.01 USDC. | Signed; Weather API got 0.01 USDC. |
| **Attack:** The same Permit2 payment to another payee | Signed; the attacker got 0.01 USDC. | **Not signed.** The recipient is 0x3df316dA2A59C9Fd6FDEbe30130a9B9fb332eeeC, the terms say Weather API (0xeaCF2A8C912F23029766162A907deE22D3b36D51). |
| **Real:** Pays by usage, at most 0.05 USDC; the call costs 0.01 (upto) | Signed; Weather API got 0.01 USDC. | Signed; Weather API got 0.01 USDC. |
| **Attack:** The usage cap is 50 USDC, and the facilitator charges all of it | Signed; Weather API got 50 USDC. | **Not signed.** The request allows 50 USDC, the terms say at most 0.05 USDC. |

## A trading agent signs a Permit2 permit for a swap

The user asked: "Swap 100 USDC on the swap app. Its router may spend at most 100 USDC of mine, for 30 days."

The terms the user confirmed on the wallet's screen: "Swap router (0x94CC152FEcfaD551cb817360c97b09ec50Ed7465) may spend at most 100 USDC, until the end of 4 December 2026 (UTC)."

| Request | Bare key | Behind the check |
|---|---|---|
| **Real:** Lets the router spend 100 USDC for 7 days | Signed; Swap router got 100 USDC. | Signed; Swap router got 100 USDC. |
| **Attack:** An unlimited allowance (2^160 - 1) instead of 100 USDC | Signed; Swap router got 1,000 USDC (all the agent held). | **Not signed.** The request is unlimited, the terms say at most 100 USDC. |
| **Attack:** 100 USDC written with 18 decimals (100 x 10^18 units) | Signed; Swap router got 1,000 USDC (all the agent held). | **Not signed.** The request allows 100000000000000 USDC, the terms say at most 100 USDC. |
| **Attack:** The permit names another spender | Signed; the attacker got 100 USDC. | **Not signed.** The spender is 0x3df316dA2A59C9Fd6FDEbe30130a9B9fb332eeeC, the terms say Swap router (0x94CC152FEcfaD551cb817360c97b09ec50Ed7465). |
| **Attack:** The allowance lasts three years; used two years later | Signed; Swap router got 100 USDC 730 days later. | **Not signed.** The permission lasts until 3 November 2029 at 00:00 (UTC), the terms say until the end of 4 December 2026 (UTC). |
| **Tampered:** The verifying contract is one digit off Permit2's | Signed: a permit for a contract that is not Permit2. Not used: no contract is at that address on the local chain. | **Not signed.** Profile permit2 describes 0x000000000022D473030F116dDEE9F6B43aC78BA3 on chains 1, 14, 50, 51, 137, 143, 988, 1328, 1329, 2201, 4326, 8453, 10143, 31612, 42161, 42220, 43113, 43114, 80002, 84532, 421614, 5042002, 11142220, not 0x000000000022d473030f116ddee9f6b43AC78bA4 on chain 84532. |
| **Tampered:** A struct named PermitSingle with an extra member | Signed: a signature over a type that is not Permit2's PermitSingle. Not used: no contract on the local chain checks that type. | **Not signed.** No message of the resolved form has the type hash 0x5d0171106d2c4b3b84ee7668720e7d44943e8939a460fe69068e1bf23082c940 (PermitSingle); a request is matched by its type hash, never by its name. |

## How a refusal reads

`explain(error)` turns the check's refusal into words for the user and the agent. The titles of this run:

- Not signed: this request is not what you confirmed. (`E_GUARD_REFUSED`) If the user wants this request, they confirm new terms for it on the wallet's screen; otherwise refuse it.
- Not signed: this request is for another chain. (`E_GUARD_UNKNOWN`) Refuse it: a wallet signs only what it can read.
- Not signed: no confirmed terms cover this request. (`E_TERMS_ORDER`) Ask the user to confirm terms for it.
- Not signed: this request is not what it claims to be. (`E_GUARD_UNKNOWN`) Refuse it: a wallet signs only what it can read.

## What ran

- The check: `@meantjs/consent` 0.8.0 (`guardSigner`, `termsGate`) and the USDC, Permit2 and x402 profiles of `@meantjs/profile` 0.8.0, from npm.
- The requests: x402's own client, `@x402/evm` 2.28.0 (`ExactEvmScheme`, `UptoEvmScheme`), and a viem 2.57.4 wallet client; the key is a viem local account made for this demo.
- The chain: `@ethereumjs/vm` 10.1.3 in this process, chain id 84532, running the code of `artifacts.json` (keccak-256 checked) at Base Sepolia's addresses. USDC's and Permit2's EIP-712 domain separators on it equal Base Sepolia's.

