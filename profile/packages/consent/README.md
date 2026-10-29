# @meantjs/consent

ICRC-21 consent messages, and the text an SNS proposal's validator returns, from a Candid Profile resolved form (`docs/profile-v0.md` sections 6, 11 and 12). Give it the resolved form of a canister, a method name and the Candid-encoded argument bytes; it returns the `icrc21_consent_message_response` for **any** method, as `GenericDisplayMessage` (Markdown) or `FieldsDisplayMessage` (typed rows). No network code; tested against the standard's `.did`. A Rust version for canisters lives in the repository (`packages/consent/rust/`, not in the npm package; section below).

```sh
npm install @meantjs/consent
```

- **Runs on:** Node 22 or later and browsers for the main entry and the EVM subpaths (no Node built-in, no `Buffer`;
  checked with esbuild). `@meantjs/consent/sns` hashes with `node:crypto` and is Node only.
- **Module format:** ES modules only, with hand-written TypeScript declarations for every entry.
- **Spec:** [Candid Profile v0](https://github.com/B3Pay/Meant/blob/main/profile/docs/profile-v0.md). **Licence:** Apache-2.0.
- **Versions:** the five Candid Profile packages (`@meantjs/profile`, `/format`, `/consent`, `/tools`,
  `/reconcile`) release together under one version and pin each other exactly; in 0.x a minor is breaking,
  and so is any change to generated text ([releasing](https://github.com/B3Pay/Meant/blob/main/profile/docs/releasing.md)).

```js
import { icrc21ConsentMessage, handleConsentRequest } from "@meantjs/consent";

const response = icrc21ConsentMessage(
  {
    method: "icrc1_transfer",
    arg: argBytes, // Uint8Array: the Candid-encoded argument tuple of the call
    user_preferences: { metadata: { language: "en", utc_offset_minutes: 120 }, device_spec: { GenericDisplay: null } },
  },
  {
    resolved, // fixtures/*.resolved.json shape, or the output of `candid-profile resolve`
    refs: { "query:icrc1_decimals": 8, "query:icrc1_symbol": "TKA" }, // dynamic refs, resolved by the caller
  },
);
// { Ok: { consent_message: { GenericDisplayMessage: "# Send tokens\n\nSend `0.29 TKA` to ..." }, metadata: { language: "en", utc_offset_minutes: null } } }
// or { Err: { UnsupportedCanisterCall | ConsentMessageUnavailable | GenericError: ... } }
```

## API (`src/index.mjs`)

The main entry runs in a browser: it imports no Node built-in and uses no `Buffer` (`test/browser-bundle.test.mjs`
bundles it with esbuild for the browser platform). The three SNS rows below are the `./sns` subpath
(`@meantjs/consent/sns`, `src/sns.mjs`), which hashes with `node:crypto` and is Node-only.

| Function | Does |
|---|---|
| `icrc21ConsentMessage(request, context)` | The ICRC-21 call as a function. Request and result are JS objects (below). `context`: `resolved`, `refs`, `languagePolicy` (`"fallback"` default, or `"error"`), `rawArguments`, `limits`. The result also has two non-enumerable properties: `diagnostics` (what was adjusted) and `provenance` (`{ intent: { origin, profile } \| null, profiles }`, so a signer can warn when a profile, not the canister, wrote the words). |
| `handleConsentRequest(requestBytes, context)` | Candid bytes of `icrc21_consent_message_request` in, Candid bytes of `icrc21_consent_message_response` out: what a canister endpoint returns. |
| `encodeConsentResponse` / `decodeConsentResponse` / `encodeConsentRequest` / `decodeConsentRequest` | The Candid codec for the ICRC-21 types (schemas written from `ICRC-21.did`). |
| `toJson(value)` | JSON-safe copy: bigint as decimal string (D-006), `Uint8Array` as `{hex}`. |
| `snsValidatorRendering({ payload, resolved, method, refs, limits })` | An SNS generic-function validator as a function: payload bytes in, `{ Ok: text }` or `{ Err: text }` out (section below). Non-enumerable `diagnostics` and `provenance`, as above. |
| `handleSnsValidatorCall(payload, context)` / `encodeValidatorResult` / `decodeValidatorResult` | The canister-side wrapper and the codec of `variant { Ok : text; Err : text }`. |
| `verifySnsRendering({ payloadTextRendering, payload, resolved, targetCanisterId, method, refs })`, `parseGovernanceRendering(text)` | The reviewer's check of a stored proposal rendering; `SNS_RENDERING_RULES` names the rules. |
| `generateConsent({ resolved, method, arg, refs, form, utcOffsetMinutes, rawArguments })` | One form without the ICRC-21 envelope; returns `{ message, zoneSensitive, diagnostics, provenance, model }`. |
| `decodeArguments(method, bytes, limits)` | Step 1 alone: argument bytes to the value tree. |
| `parseTemplate`, `resolvePath`, `valuesAt`, `Renderer`, `renderFields`, `renderGeneric`, `codeSpan`, `escapeMarkdown`, `visible` | The parts. |

**JS shapes** (`src/icrc21-codec.mjs`): a variant is `{ Tag: payload }` (`{ GenericDisplay: null }` for a bare case); `opt T` is `null` or the value; `nat`, `nat64` are `bigint`; `nat8`, `int16` are numbers; `blob` is `Uint8Array`; `vec record { text; Value }` is an array of `[label, value]` pairs. This is the shape of the standard's example JSON (`{"Text": {"content": ...}}`).

## What happens, in order

1. **Decode** (`src/decode.mjs`). The argument bytes are decoded against the method's resolved-form tree into a value tree aligned with its positions: integers as decimal strings, floats as numbers, `blob` as `Uint8Array`, absent `opt` as `null`, records as objects keyed like `fields`, variants as `{ tag, value }`, vectors as arrays. Nothing is rounded or truncated.
2. **Intent** (`src/template.mjs`, `src/model.mjs`). The call's `intent.template`: that of the deepest variant case with an `intent` that the decoded arguments hold, else the method's (spec §5.2, D-053; the call's effect, shown in the SNS rendering, is chosen the same way). A resolved form whose tagged cases one call holds side by side is not one a resolver writes; the method's tag is used for it. placeholders rendered through `formatterFor` of `@meantjs/format` (so `amount`, `timestamp`, `duration`, `account`, `subaccount`, `bytes` mean exactly what arm C means), `[ ... ]` dropped when a placeholder inside is absent, escapes `{{ }} [[ ]]`. Untagged positions render as Candid text. A method without `intent` gets a generic intent (title from `describe.label` of the method or `Call <method>`, one row per argument leaf). The renderer has no network access and never states anything about ledger state; dynamic refs come in through `refs`. A ref you did not supply stops the message (`E_REF_UNRESOLVED`), a number is never shown without its decimals.
3. **Forms** (`src/render.mjs`, `src/icrc21.mjs`), section 12:
   - `FieldsDisplayMessage`: `intent` = title, `": "`, rendered template; one `(label, Value)` row per placeholder, label from `describe.label` else the field name; `amount` is a `TokenAmount` when it fits `nat64` and has a symbol, else `Text`; `timestamp` is `TimestampSeconds` after an exact ns-to-s conversion (the library throws `E_INEXACT` otherwise and the row is `Text` in RFC 3339 UTC); `duration` is `DurationSeconds`; everything else is `Text`. UTC only, never zone-sensitive.
   - `GenericDisplayMessage`: `# title`, the rendered template as a paragraph, then `- **label:** value` for the same fields. Times are shown in `utc_offset_minutes` (`2026-10-09 14:00:00 UTC+02:00`), UTC when absent, and the response metadata says which offset was applied.

## EVM contracts (experimental: `src/evm.mjs`, `src/erc7730.mjs`)

Spec section 15, D-054 and D-055 (EIP-712 messages, §15.9). An EVM contract's resolved form (`"chain": "evm"`, from `resolveService({ abi })` of
`@meantjs/profile`) is read by two subpaths; the main entry refuses it with `E_RESOLVED_FORM`, and `evmConsent` refuses
a Candid one.

| Function | Does |
|---|---|
| `decodeCalldata(resolved, calldata, limits)` (`/evm`) | The function a selector names and its arguments, keyed by parameter name. Strict: values read from anything but their canonical ABI encoding are `E_DECODE`. |
| `evmConsent({ resolved, calldata, to, chainId, refs, tokens, form, utcOffsetMinutes, rawArguments, limits })` (`/evm`) | The consent text of a call: the same model and the same two forms as ICRC-21, without its envelope (`"generic"` Markdown, or `"fields"` as an intent line and `[label, text]` rows), ending with the contract's address and chain, which a person must see because a pack matches any contract with the right functions. A call to a contract its profiles do not list is `E_DEPLOYMENT`; a payable function is `E_UNSUPPORTED_TYPE` (its native value has no position yet). `tokens`: the decimals and symbol of each token an amount's `token` field names, by address; the address is shown beside the symbol. |
| `eip712Consent({ resolved, typedData, chainId, refs, tokens, form, utcOffsetMinutes, rawArguments, limits })` (`/evm`) | The consent text of an EIP-712 signing request (`eth_signTypedData_v4`'s JSON), matched to a message of the resolved form by its type hash, never its name. Refused before anything is shown: a domain for another chain than the wallet's, without `chainId` or `verifyingContract`, with a salt, or whose name or version is not its profiles' (`E_DOMAIN`); a contract its profiles do not list (`E_DEPLOYMENT`); no message with the type hash (`E_TYPE_HASH`); values that are not exactly the members, canonically written (`E_DECODE`); a token not in `tokens` (`E_REF_UNRESOLVED`). Ends with the verifying contract, the EIP-712 digest and "This is a signature, not a transaction: whoever holds it can submit it." Returns `typeHash`, `digest`, `verifyingContract` and `chainId` with the text. |
| `erc7730Descriptor(resolved, { context, deployments, owner, contractName, info, token })` (`/erc7730`) | The contract's ERC-7730 clear-signing file and its ERC-8176 `descriptorHash`: deterministic, `$schema` pinned to the exact 2.1.0 file, one entry per function a transaction calls, or with `context: "eip712"` one per message, keyed by its `encodeType`. What an ERC-7730 file cannot say (a time in ms, `utf8` bytes, an amount in another token, an unnamed parameter) is `E_EXPORT`, never written as something near it; no deployment is `E_DEPLOYMENT`. What it cannot say but changes no value (a timestamp's "Never", a template over an array) is left out and listed in `notes`. The mapping is spec §15.7 and §15.9. |
| `descriptorHash(descriptor)` (`/erc7730`) | Keccak-256 of the RFC 8785 form: the hash of a file someone edited. |
| `erc8176Attestation({ descriptorHash, time, expirationTime, salt, refUID })` (`/erc7730`) | The unsigned ERC-8176 attestation (EAS offchain v2 typed data) and its EIP-712 digest, for a reviewer to sign with their own key. Nothing is signed or sent. |

```js
import { eip712Consent, evmConsent } from "@meantjs/consent/evm";
import { erc7730Descriptor, erc8176Attestation } from "@meantjs/consent/erc7730";

evmConsent({ resolved, calldata, to: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", refs: { "query:decimals": 18, "query:symbol": "WETH" } }).message;
// # Send tokens\n\nSend `1.5 WETH` to `0xfB69…d359`\n\n- **Amount:** `1.5 WETH`\n- **Recipient:** `0xfB69…d359`\n\n**Contract:** `0xC02a…6Cc2`
const { descriptor, descriptorHash } = erc7730Descriptor(resolved, { deployments: [{ chainId: 1, address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" }] });
const { typedData, digest } = erc8176Attestation({ descriptorHash, time: 1777630591, expirationTime: 1785406591, salt });

// A Permit2 signing request, with the profile in @meantjs/profile/packs/permit2.profile.json
eip712Consent({ resolved: permit2, typedData, chainId: 1, tokens: { "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48": { decimals: 6, symbol: "USDC" } } }).message;
// # Permit2: allow token spending\n\nLet `0x66a9…A8Af` spend up to `Unlimited USDC (0xA0b8…eB48)`. Allowance expires: …
```

Every exported file in the tests is checked against the ERC-7730 2.1.0 JSON Schema (vendored in
`test/upstream/erc7730/`, CC0, sha256 in its `SOURCE.json`), and the hashes and digests they pin were computed by an
independent implementation. **Fact** (ERC-7730): a wallet that finds no ticker for a `tokenAmount` "SHOULD display the
raw value instead with an 'Unknown token' warning"; this package would produce no message there, and a file cannot make
a wallet refuse. The Rust version does not cover EVM.

## SNS proposal validators (`src/sns.mjs`)

The governance counterpart of ICRC-21. An SNS proposal that executes a generic nervous system function calls a dapp method with a payload. Apart from the proposer's own title and summary, the only description of that payload governance shows is the text the dapp's validator method returns. `snsValidatorRendering` is that validator, generated from the profile. Proposal for the spec text: `docs/proposals/w4-sns-validator-rendering.md`.

```js
import { snsValidatorRendering, handleSnsValidatorCall, verifySnsRendering } from "@meantjs/consent/sns";

snsValidatorRendering({ payload, resolved, method: "pay_grant", refs });
// { Ok: "### Pay a grant\n\nPay `123.456789 GOV` from the treasury to ..." }  or  { Err: "E_DECODE: ..." }
handleSnsValidatorCall(payloadBytes, { resolved, method, refs }); // Candid bytes of variant { Ok : text; Err : text }
verifySnsRendering({ payloadTextRendering, payload, resolved, targetCanisterId, method, refs }); // { ok, checks, expectedRendering, parsed }
```

**What SNS governance does** (fact: dfinity/ic `649156c`, `rs/sns/governance/src/proposal.rs`, `canister_control.rs`, `types.rs`):
- On submission it calls the validator with the payload bytes, unchanged, and decodes the reply as `Result<String, String>`. `Err` rejects the proposal.
- It stores `Ok(text)` as `payload_text_rendering` under its own headings: `# Proposal to execute nervous system function:`, `## Nervous system function:` (the function record as Rust debug text), `## Payload sha256:`, `## Payload:` and then the text.
- On adoption it calls the target method with the same bytes.
- `get_proposal` returns the rendering, but the payload only when it is at most 64 bytes; above that it returns a text summary with the SHA-256. `list_proposals` returns neither.

The NNS dapp shows the rendering as Markdown (fact: dfinity/nns-dapp `94b6cde`, `SnsProposalPayloadSection.svelte`).

**The text** (rules `candid-profile-sns/v0`):
1. The generic consent message (section 12), with the title at heading level 3 so it nests under governance's `## Payload:`. Times are in UTC.
2. `**Method:**` and `**Effect:**` (kind and reversibility). When the resolver supplied the section 5.3 default, the text says so.
3. The arguments as Candid text with no formatter applied, always: base units, nanoseconds, bytes. This view does not depend on the profile's units.
4. `**Rendered from:**`: each profile with its `profile_id`, the `interface_id`, and the rules.

Anything the generator cannot describe is `Err`, so governance rejects the proposal: an unknown method, bytes that do not decode, an untypeable position, a missing dynamic ref, or a message over the limits. Errors use the codes of the table above. Values are escaped exactly as in the generic consent message: a memo that imitates `## Payload:` cannot add a heading.

**The reviewer's check.** The proposer publishes the payload bytes. Given the proposal's `payload_text_rendering`, the same profile and the canister it describes, `verifySnsRendering` runs five checks:
- governance's layout, with the function record exactly as `{:#?}` prints a generic function (one field per line), so the target is read from its own line and never from text in the function's name or description;
- `sha256(payload)` equals governance's `Payload sha256`;
- the function's `target_canister_id` is the canister the reviewer names (a resolved form names no canister, so without `targetCanisterId` this check fails);
- the function's `target_method_name` is the method the profile describes;
- the validator's text equals what the profile renders for those bytes.

It names `get_proposal`'s 64-byte summary when it is passed instead of the payload. From the command line:

```sh
npm run sns -w packages/consent -- --did dapp.did --profile dapp.profile.json --method pay_grant --payload-file payload.bin --verify rendering.txt --target <canister id>
```

Local files only, no network.

## Codec

**`@candid-core/schema` 0.5.0** (`decodeArgs`, the same package that backs `@candid-core/cli` 0.4.0, pinned exactly; 0.4.0 until D-047, 0.3.0 and 0.2.0 until D-037). It decodes against an expected schema with the Candid coercion relation and explicit resource budgets, returns `bigint` and `Uint8Array` (lossless), and has no dependencies. The schema is built from the resolved-form tree, so the bytes never choose the types.

Considered and not chosen: `@dfinity/didc` 0.0.4 (the Rust crates as wasm) prints textual Candid, which would need a second parser, and wants a `.did` the consent generator does not have; a hand-written decoder would be new code to trust. `@dfinity/didc` is used **in the tests**, as an independent oracle: 16 wire variants and 3000 mutated encodings are accepted and rejected exactly as Rust candid does (`test/decode-differential.test.mjs`; a 20,000-input scratch run found 0 disagreements), and every reply is decoded against the standard's `.did`.

## Escaping (spec section 6, section 11 item 4)

The relying party is not trusted, so every value that comes from the call is shown inert:

- **Generic form (Markdown):** a value is a code span, verbatim, with a fence one backtick longer than any run inside. Links, images, HTML, autolinks, emphasis, entities, headings and tables do not exist inside it. Control, format (bidi overrides, zero-width) and line-separator characters are shown as `\u{202e}`, never passed through. Text from the profile (template literals, labels, the title) is plain text: Markdown punctuation is backslash-escaped, line breaks become spaces. Checked with the CommonMark reference parser (`commonmark`, dev dependency) on 38 hostile values.
- **Fields form:** plain text, as ICRC-21 requires. Only the invisible characters are made visible.
- A memo that is not valid UTF-8, has control characters, or starts with `0x` is hex (spec section 5.3, enforced by the format library).

## Errors

| Cause | ICRC-21 result |
|---|---|
| Unknown method, argument bytes that do not decode, arguments too large, malformed request, unsupported language with `languagePolicy: "error"` | `UnsupportedCanisterCall` (`description` starts with the code: `E_METHOD_UNKNOWN`, `E_DECODE`, `E_TOO_LARGE`, `E_REQUEST`, `E_LANGUAGE`) |
| A value that reaches a position the resolved form cuts (`recursive: true`; a call whose value avoids every cut gets its message, D-042), or a method with a `func` or `service` position | `ConsentMessageUnavailable` (`E_UNSUPPORTED_TYPE`) |
| Missing dynamic ref, invalid tag argument, malformed resolved form (an EVM one among them) | `GenericError` with `error_code` 1100 (ref), 1101 (arg), 1102 (tag type), 1103 (tag conflict), 1000 (resolved form), 1999 (internal) |

A language other than English is **not** an error: ICRC-21 says a message "should be preferred over sending an icrc21_error" and "the metadata must match the consent_message provided", so the answer is English with `metadata.language: "en"` (`I_LANGUAGE_FALLBACK` in `diagnostics`). Limits are explicit and never truncate: 2 MiB of argument bytes, 64 fields, 256 list elements, 32 KiB of message text.

## Rust version for canisters (`rust/`)

An SNS validator is a canister method, so the renderer also exists as a Rust crate, `candid-profile-consent` (not published). It reads the same resolved form (JSON) and writes the same text, byte for byte:

| Function | Does |
|---|---|
| `sns_validator_rendering(resolved, method, payload, refs)` | `Ok(text)` or `Err(text)`, as `snsValidatorRendering`. |
| `handle_sns_validator_call(...)`, `encode_validator_result(...)` | The Candid-encoded reply a validator method returns. |
| `render_sns_payload(..., limits)` | The same with the error as a value and the diagnostics. |
| `generic_consent_message(resolved, method, arg, refs, utc_offset_minutes, raw_arguments, limits)` | The ICRC-21 `GenericDisplayMessage` text, as `generateConsent` with `form: "generic"`. |
| `parse_resolved(json)` | The resolved form from its JSON text (field order kept: it is the order of the Candid text). |

It decodes with the `candid` crate against types built from the resolved form, as `src/decode.mjs` does with `@candid-core/schema`, and ports the format library's display side (`packages/format`) for the six value tags. Where JavaScript's strings show through (UTF-16 lengths for the 32 KiB budget, `trim`, the neighbours of an underscore), the crate counts and looks the way JavaScript does.

```sh
cd packages/consent/rust
cargo test                                   # unit tests, the goldens, the differential corpus
cargo build --release --target wasm32-unknown-unknown --example sns_validator
node check-canister.mjs                      # the dapp's SNS goldens through the example canister's wasm, in Node
```

- **Tests.** `tests/golden.rs` runs all 13 SNS goldens and the generic message of all 20 ICRC-21 goldens: `Ok` byte for byte (with the reply's Candid bytes), `Err` by code (the two decoders word their errors differently). `tests/differential.rs` runs the corpus of `test/differential/` (below): 203 payloads, every one answered alike, `Ok` text and `Err` code, in both forms. Deliberate mutations of the port (float formatting, `trim`, the underscore rule, UTF-16 counting, `ui.order`, the subaccount, base64 and duration rules, the limits) each make it fail.
- **The example canister** (`examples/sns_validator.rs`): `validate_<method>` query methods for the hypothetical dapp of `test/fixtures/sns-dapp.did`, written against the six system API functions it needs, so the crate's own dependencies are all it has. Each call writes one `debug_print` line with the method, the payload size and the instructions spent. `check-canister.mjs` instantiates the wasm in Node with those functions stubbed and checks the dapp's 7 SNS golden cases; that is not a replica. Release wasm: 731,172 bytes, not stripped or optimised further. `examples/sns_target.rs` is a stand-in for the dapp itself, for the PocketIC test only: it records each call.
- **Versions** (observed 2026-10-12): rustc and cargo 1.97.0, target `wasm32-unknown-unknown`; `rust-version` 1.85 (the highest of the dependencies). Dependencies pinned exactly in `Cargo.toml`, the full tree in `Cargo.lock`: `candid` 0.10.38 (no default features; `value`), `serde_json` 1.0.154 (`preserve_order`), `num-bigint` 0.4.6, `unicode-general-category` 1.1.0 (Unicode 16.0, as Node 22's ICU 77.1), `ryu-js` 1.0.3 (JavaScript's number formatting).
- **Not ported:** the `FieldsDisplayMessage` form, the ICRC-21 request and response envelope, the reviewer's check (it runs off-chain, in JavaScript).

### On SNS governance (`pocketic/`)

The example validator, registered with the real SNS governance canister on PocketIC. Not part of `npm test` at the root: it downloads pinned binaries and builds the canisters first.

```sh
npm ci                               # at the repository root (the test imports this package and @dfinity/didc)
cd packages/consent/pocketic
npm ci                               # @dfinity/pic 0.25.0, @icp-sdk/core 6.1.0; install scripts off (.npmrc)
npm test                             # fetch + sha256-check the artifacts, build both example canisters, run
```

The test starts one PocketIC instance with an SNS subnet (governance, plus empty canisters for root, ledger and swap) and an application subnet (the example validator and the stand-in dapp). One neuron holds all the voting power, so each proposal is adopted when made. It adds one generic function per dapp method by proposal, then proposes every dapp case of `test/sns-golden/`.

**Observed** (2026-10-12; 10 of 10 tests pass):
- Governance accepts the example's query methods as validators and calls them across subnets.
- For the five cases that render, `payload_text_rendering` equals `governanceRendering` of `test/sns-helpers.mjs` (the layout the unit tests derive from the governance source) around the golden text, byte for byte. `verifySnsRendering` passes on it, and fails when the reviewer names another canister. A mutant of the test that expects another topic fails, so the comparison is live.
- `get_proposal` returns the 91-byte payload as exactly `proposalPayloadSummary` simulates. The reviewer's check names that summary when it is passed in place of the bytes.
- The two `Err` cases: `manage_neuron` answers `error_type` 15, `1 defects in Proposal:` then `Invalid proposal: ` and the validator's text. No proposal, no call to the target.
- On adoption the target receives the payload unchanged with governance as the caller, and governance keeps the reply in `execution_reply`.
- Instructions per validator call, from the canister log, parsing the resolved form included (a query keeps no state): 1.6 to 2.5 million (`pause` 1,807,012; `pay_grant`, 91 bytes, 2,476,305). The direct preview queries left no log lines; the seven calls governance made did.

**Versions** (`pocketic/artifacts.json`): PocketIC server 16.0.0 (linux-x64 unpacked here; darwin-arm64 as pinned by W2), SNS governance wasm and `.did` from DFINITY's CI at dfinity/ic `649156c2bca1315da5699e2125b34be6397c9987` (both sha256 equal the published `SHA256SUMS`), `@dfinity/pic` 0.25.0, `@icp-sdk/core` 6.1.0. **Open:** deployed SNSes run the governance version blessed through SNS-W, which may differ from this commit; re-run on a version bump.
- **Known difference: the decoders' work bounds.** The JavaScript codec refuses bytes with more than 100,000 values or nesting deeper than 64, skipped values included (`E_TOO_LARGE`). The `candid` crate bounds work differently (here: its skipping quota, 16 units per byte of the 2 MiB limit). So a payload with, say, an ignored extra field holding a million `null`s is rendered in Rust and refused in JavaScript; the reviewer's check then fails visibly on `payload_rendering`. Everything the method's type reads is the same in both. Matching the bounds exactly would need a Candid value counter of our own. **Fact:** SNS governance does not cap the payload below the message size at `649156c` (`PROPOSAL_EXECUTE_SNS_FUNCTION_PAYLOAD_BYTES_MAX = 70000` in `types.rs` is marked dead code with a TODO).

## Tests and fixtures

```sh
npm test -w packages/consent        # 171 tests, or `npm test` at the repo root
npm run golden -w packages/consent  # regenerate the goldens, both REVIEW.md, the resolved forms and the corpus the Rust tests read
npm run upstream -w packages/consent -- --out <new empty dir>   # re-download the ICRC-21 files and compare sha256 (network)
```

| File | What it checks |
|---|---|
| `test/decode*.test.mjs` | The value tree; refusal of what cannot be typed; agreement with Rust candid. |
| `test/template.test.mjs`, `paths.test.mjs` | Same scan as the resolver's `parseTemplate` (5000 random templates), placeholder paths. |
| `test/text.test.mjs`, `render.test.mjs` | Escaping with the CommonMark parser, optional segments, generic intent, limits. |
| `test/icrc21.test.mjs` | Forms, language, time zones, section 12 mapping, errors; replies decoded against `test/upstream/icrc21/ICRC-21.did`. |
| `test/golden.test.mjs`, `test/golden/` | 20 cases: the three update methods on 8, 6 and 18 decimals. `REVIEW.md` is the by-eye copy. Each case also has expectations worked out by hand (`cases.mjs`). |
| `test/pipeline.test.mjs` | The real ledger `.did` through the real resolver; the tokens example (`type:` addresses, nested placeholder); a canister with no profile. |
| `test/oisy-comparison.test.mjs` | Backs `docs/oisy-comparison.md`. |
| `test/sns.test.mjs`, `test/sns-golden/` | 13 SNS validator cases (`cases.mjs`, hand-worked expectations; `REVIEW.md` is the by-eye copy, with one case inside governance's wrapper). Reply bytes are read and re-encoded identically by Rust candid as `variant { Ok : text; Err : text }`. The CommonMark parser checks that the whole stored rendering has only governance's headings and one of ours. The governance layout is checked against the upstream test vector in `test/upstream/sns/`. The reviewer's check covers a misstated amount, another target canister or method, a function name or description that imitates the target fields, no expected canister given, other bytes, the 64-byte summary, other units at the reviewer, and a fake second hash header. The CLI is covered too. `test/sns-golden/resolved/` holds the dapp's resolved forms for the Rust tests; a test checks that they are the resolver's output. |
| `test/differential.test.mjs`, `test/differential/` | The corpus the Rust port is compared on (`corpus.json`, from the seeded generator in `build.mjs`): `test/fixtures/wide.did` with its author profile, with no profile, and with faults a resolver would not write; payloads encoded by `@dfinity/didc`, then truncated, changed, extended, swapped between methods, or encoded untyped to exercise subtyping; the message limits; refs given in odd forms. The test checks that the stored corpus is what the package answers and that it reaches every outcome it compares. |

Untrusted third-party data lives in `test/upstream/icrc21/` (the standard, commit and sha256 in `SOURCE.json`), `test/upstream/sns/` (the governance test vector, same) and `test/fixtures/ledger.did`; tests only read it as text. `test/fixtures/sns-dapp.did`, `test/fixtures/wide.did` and their profiles describe hypothetical canisters written for these tests.

## Security notes

- A profile is a claim, not a proof (spec section 11 item 1). `provenance` tells the signer which profile wrote the words; `rawArguments: true` appends the decoded raw arguments for transfer, approve, admin and destroy.
- Dynamic refs come from a single replica unless the caller certifies them (section 11 item 2). Resolve `decimals` and `symbol` through an update call or cross-check with `icrc1_metadata` before showing a transfer. Generation inside the canister avoids this.
- The package has no I/O. Work is bounded: decoder budgets, field and element limits, message size.

## Not done

- In Rust: the `FieldsDisplayMessage` form and the ICRC-21 envelope (`rust/`, above).
- The caller's account (`From`) and a fee line: see `docs/oisy-comparison.md` for why they are absent.
- Other languages; `device_spec` hints beyond the two forms.
- Recursive and `func`/`service` positions (need a richer resolved form, or the Contract).
- EVM: payable functions in the consent text, EIP-712 witness messages and the signer check (spec §15.9 O9, O13),
  ERC-7730 import, checking attestations, and the Rust
  version.
