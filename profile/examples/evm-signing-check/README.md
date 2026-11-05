# Meant's signing check for AI agents on EVM

An AI agent that holds an EVM key signs what it is handed. When an x402 API asks for 25 USDC instead of 0.01, or a
swap app's permit is unlimited, a bare key signs it, and whoever the request names can then take the money. This
folder puts Meant's check between the agent and its key, and replays 16 such requests on a local chain to show what
each one does with and without it.

The check has two steps. First the user confirms the task's terms on the wallet's own screen: the token, who is paid
or who may spend, the most, and until when. Then the agent signs through a guarded account. That account signs only an
EIP-712 request that a Meant profile reads, and only if what the request grants fits those terms. When it refuses, it
says why in words. It is [`src/signing-check.mjs`](src/signing-check.mjs), about 110 lines on top of two published packages:
`@meantjs/consent` 0.8.0 (its terms guard, `guardSigner` and `termsGate`) and `@meantjs/profile` 0.8.0 (the profiles of USDC,
Permit2 and x402's payments).

```sh
npm ci
npm run fetch   # the contracts' code from Base Sepolia (read-only calls), each keccak-256 checked against artifacts.json
npm start       # about 2 seconds; writes results.md
npm test        # the check's own tests, then the replay again
```

Node 22.12 or later. **No mainnet, no funds.** The chain is an EVM in this process (`@ethereumjs/vm` 10.1.3) with Base
Sepolia's chain id, running the code Base Sepolia runs at the same addresses: Circle's USDC, Uniswap's Permit2 and
x402's two Permit2 proxies. The USDC is minted for the run and exists only in memory. While `npm start` runs, `fetch`
refuses every host but this machine. `npm run fetch` is the only step that uses the network, and it only reads.

## Add it to a wallet

```js
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { explain, signingCheck, TERMS_TOOL } from "./signing-check.mjs";

const check = await signingCheck({
  chainId: 84532,
  tokens: { USDC: { address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", decimals: 6 } },
  apps: { "Weather API": "0xeaCF2A8C912F23029766162A907deE22D3b36D51" },
});

// The agent calls TERMS_TOOL with the user's terms. The wallet shows task.text on its own screen.
const task = check.task({ token: "USDC", to: "Weather API", max_amount: "0.05", expires_by: "1 day" });
// "Weather API (0xeaCF…6D51) may be sent at most 0.05 USDC, until the end of 5 November 2026 (UTC)."
task.confirm(task.text); // only from the wallet's own Confirm button, never from a tool the agent can call

// The agent gets the guarded account. Give it to x402's client or to a viem wallet client in place of the key.
const account = task.guard(privateKeyToAccount(key));
try {
  const payment = await new ExactEvmScheme(account).createPaymentPayload(2, requirements);
} catch (error) {
  const why = explain(error); // { code, title, why, next }, or null for an error the check did not raise
  // "Not signed: this request is not what you confirmed." ["The request allows 25 USDC, the terms say at most 0.05 USDC."]
}
```

A viem wallet client works too: `createWalletClient({ account, chain, transport })`, then
`walletClient.signTypedData(...)` goes through the check. The guarded account has only `address` and
`signTypedData` (and `readContract`, when the signer it wraps has one), so neither the agent nor x402's client can
reach the key's `signTransaction` or `signMessage`.

## What the run shows

These facts were observed in the run that wrote [`results.md`](results.md). The run checks each one, so it fails if one
stops holding:

- **The bare key signs every request it is handed.** It signs all 16, through x402's own client (`@x402/evm` 2.28.0) or a viem
  2.57.4 wallet client. On the local chain those signatures paid 25 USDC for a 0.01 USDC call, paid an
  attacker, let a facilitator charge a 50 USDC usage cap, let a swap router take all 1,000 USDC the agent held
  (an unlimited permit, and 100 USDC written with 18 decimals), and let a router take 100 USDC two years later (a
  permit that lasts three years).
- **Behind the check, only what the user confirmed is signed.** The 4 real requests are signed and settle on the
  local chain for exactly their amount: an x402 payment by EIP-3009, by Permit2, and by usage (upto), and a 100
  USDC Permit2 permit. The 11 bad ones are refused before anything is signed, each with a reason in words. Eight of them change the
  amount, the payee, the spender or the end. Three are not what they claim: another chain, a contract one digit off
  Permit2's address, and a look-alike type.
- **Terms cover one request.** A second payment under the same terms is refused, and the agent asks again. The bare
  key paid twice.
- **The chain runs Base Sepolia's own code.** `npm run fetch` keeps a contract's code only if its keccak-256 is the
  pin, and each pin is the codeHash Base Sepolia returned for that contract at block 54440084 (`eth_getProof`, read
  on 2026-11-04). The run checks the hashes again, and it stops unless USDC's and Permit2's EIP-712 domain separators
  on the local chain equal Base Sepolia's. So the signatures here are the ones Base Sepolia would accept.

Assumptions:

- The bad requests are ours: each is one change to a real request, not a recording of an attack seen in the wild.
  Two of them, the look-alike contract and the look-alike type, are the requests of
  [`examples/meant-vs-native`](../meant-vs-native), moved from Ethereum to Base Sepolia.
- USDC and Permit2 on mainnets answer these requests as Base Sepolia's code does. Not checked: this demo never touches a
  mainnet.

Open, or not covered yet:

- **Transactions are not checked.** The guarded account signs no transactions (D-062), so an ERC-20 `approve` or
  `transfer`, a swap's router call and x402's gas-sponsored approval are outside it. Permit2's one-time approval is a
  transaction the wallet signs itself.
- **One request per terms.** An agent that pays an API many times asks the user each time. A standing budget is the next
  decision, if x402 teams ask for it.
- **Only these six profiles.** The check covers USDC's own messages on the chains the packs list, Permit2's
  permits and x402's exact and upto payments. Another token needs its profile in `PROFILES`.
- **Local signers only.** The check wraps a signer in the shape of a viem `LocalAccount` or x402's `ClientEvmSigner`.
  A browser wallet or a remote signer reached through `eth_signTypedData_v4` is not wrapped here.
- **The demo confirms the terms in code.** A wallet must take the confirmation from its own screen.
- **Not run against anvil.** The chain is `@ethereumjs/vm`, in this process.

## Files

| File | What it is |
|---|---|
| `src/signing-check.mjs` | The check: `signingCheck`, `task().confirm/decline/guard`, `explain`, `TERMS_TOOL`, `PROFILES` |
| `src/requests.mjs` | The 16 requests, with the user's asks and terms, and what the run must observe for each |
| `src/chain.mjs` | The local chain: the pinned code at Base Sepolia's addresses, USDC set up as Base Sepolia's |
| `run.mjs` | Runs each request on the bare key and behind the check, uses every signature on the chain, checks, writes `results.md` |
| `artifacts.json`, `scripts/fetch-code.mjs` | The code pins (address, size, keccak-256, domain separators) and the read-only fetch |
| `test/signing-check.test.mjs` | The check's order, what it signs and keeps, the words of each refusal, and the replay |

The contract code is not in this repository: `npm run fetch` reads it from Base Sepolia. Licences: Circle's
stablecoin-evm (USDC and its SignatureChecker) and coinbase/x402 are Apache-2.0, Uniswap's Permit2 is MIT.
