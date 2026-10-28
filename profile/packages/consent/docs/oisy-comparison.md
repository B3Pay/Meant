# OISY's fallback consent message for `icrc1_transfer`, compared with the profile-generated one

Workstream W4, 2026-10-09. Backed by `test/oisy-comparison.test.mjs`: every message below is the one the code computes now, and the claims about what the two messages contain are assertions there. Claims about OISY's dialog and about when its fallback runs are read from source and labeled as such. Labels used in this document: **Fact** (read in source or observed), **Assumption**, **Unverified**.

## Short answer

For a plain transfer the two messages say the same thing about the call: amount, recipient, memo. They differ in four places:

1. **Exactness (fact).** OISY's amount goes through a JavaScript double (`Number(amount) / 10 ** decimals`) and `Intl.NumberFormat`, so it silently rounds: `9007199254740993` base units on 8 decimals is shown as `90,071,992.54740992 TKA`, and `123456789012345678` base units on 18 decimals as `0.12345678901234568 TKC`. The profile-generated message uses the exact decimal conversion of `@meantjs/format` (spec section 5.3, D-006) and shows `90071992.54740993 TKA` and `0.123456789012345678 TKC`.
2. **The memo (fact).** OISY pastes the decoded memo into the Markdown. A memo can add its own sections (`**Amount:**`), links and headings, and a memo that is not UTF-8 reaches the screen as U+FFFD and control characters (the hex fallback in `decodeMemo` cannot run, see below). The profile-generated message puts every value from the call into a Markdown code span and shows anything that is not plain printable UTF-8 as `0x` hex.
3. **Coverage (fact).** OISY's fallback exists for exactly three methods, each hand-coded. The profile-generated message comes from tags, so any method with an `intent` gets its own sentence and any other method gets a generic intent listing its decoded arguments.
4. **What it leaves out (fact, by design).** The profile-generated message has no **From** line and no **Fee** line when the call names no fee. The call's bytes do not carry the caller, and the default fee is ledger state (spec section 6 forbids state-dependent claims; ICRC-21 says the message must stay true despite the delay between fetching it and submitting the call). OISY shows both, reading the caller from the signer and the fee from the ledger at signing time.

## Sources and commits

| What | Where | Commit |
|---|---|---|
| The wallet that shows the message | `github.com/dfinity/oisy-wallet`, `src/frontend/src/lib/components/signer/SignerConsentMessage.svelte`, `src/frontend/src/lib/utils/html.utils.ts` (`UNTRUSTED_CONFIG`), `src/frontend/src/lib/components/signer/SignerConsentMessageWarning.svelte` | `c4eb38920a1c110bb6c908a18d7336d4d306638c` (v2.6.1, 2026-10-08, head of the default branch on 2026-10-09) |
| Where the fallback message is **built** | `github.com/dfinity/oisy-wallet-signer`, `src/builders/signer.builders.ts` (`buildContentMessageIcrc1Transfer`), `src/utils/format.utils.ts` (`formatAmount`), `src/utils/builders.utils.ts` (`decodeMemo`), `src/i18n/en.json`, `src/services/signer.service.ts` (when it runs) | `89c42a33189c2be04bdd004441f36fb36ded95c7` (tag `v6.0.0`, 2026-05-22). The wallet depends on it as `"@dfinity/oisy-wallet-signer": "^6.0.0"` and its lockfile pins `6.0.0` |
| The ledger's own ICRC-21 message, which OISY's code says it imitates | `github.com/dfinity/ic`, `packages/icrc-ledger-types/src/icrc21/lib.rs` and `responses.rs` | tag `ledger-suite-icrc-2026-03-09` (ref `cf41372e3d4dc1accfe2c09a7969f8bddc729dc1`), the release whose `ledger.did` this repository pins |
| The standard | `github.com/dfinity/wg-identity-authentication`, `topics/ICRC-21/` (`ICRC-21.did`, `icrc_21_consent_msg.md`, `examples/`) | `202e6df31e338a91d485663834818bdd96e05c6a`; copies and hashes in `test/upstream/icrc21/` |

**Fact:** the fallback is not in the wallet repository. The wallet only renders what the signer library returns.

All three repositories were downloaded into empty directories outside this repository (shallow `git clone`, then `curl` for single files) and **only read**. Nothing was installed, built or executed from them; they are untrusted data.

## When OISY's fallback runs (fact, from `signer.service.ts` and `SignerConsentMessage.svelte`)

- The signer first sends the ICRC-21 request itself, with `language: 'en'`, `utc_offset_minutes: []` (absent) and `device_spec: []` (absent). Only if that call throws does `tryBuildConsentMessageOnError` look up a builder in `SIGNER_BUILDERS`: `icrc1_transfer`, `icrc2_approve`, `icrc2_transfer_from`. For any other method there is no fallback and the original error is rethrown.
- The builder needs the ledger's `symbol`, `decimals` and `fee`, which the signer reads from the ledger at that moment.
- The result is returned as `Warn`, and the dialog shows a banner: "This token does not provide confirmation messages, so the information below was extracted by $oisy_short" (`en.json` of the wallet; the placeholder is the wallet's short name). This is the ICRC-49 rule that a signer warns when it, not the canister, interpreted the call.
- Argument bytes above 500 bytes are refused (`MAX_CONSENT_MESSAGE_ARG_SIZE_BYTES`, copied from the ledger).
- The dialog renders only `GenericDisplayMessage`; for a `FieldsDisplayMessage` `displayMessage` stays undefined and nothing is rendered. **Unverified by running the wallet**; read from the Svelte source.
- The Markdown goes through `marked` and then DOMPurify with `UNTRUSTED_CONFIG`, which allows `a`, `b`, `blockquote`, `br`, `code`, `del`, `em`, `h1` to `h6`, `hr`, `i`, `li`, `ol`, `p`, `pre`, `s`, `strong`, `sub`, `sup`, tables and `ul`, with the attributes `align`, `colspan`, `href`, `lang`, `rowspan`, `title`. OISY's tests cover buttons, forms and `<style>` in a memo; a memo link or heading is not blocked by this configuration (fact: the configuration; **unverified:** what the dialog looks like).

## How the OISY message was produced

`test/oisy-fallback.mjs` is a 25-line **transcription by reading** of `buildContentMessageIcrc1Transfer`, `formatAmount`, `decodeMemo` and `section`; the account text uses the ICRC-1 textual encoding of this repository's format library, as OISY's `encodeIcrcAccount` does. The transcription is checked against OISY's own expectations, copied into `test/oisy-comparison.test.mjs`: the 18 `formatAmount` vectors of `format.utils.spec.ts` (`'1,234.56'`, `'1.0'`, `'3,200.00000001'`, ...), the message of `signer.builders.spec.ts` for amount `320_000_000_001`, fee `100_330` and memo `PUPT` (`**Fee:**\n0.0010033 TKN`), the no-fee case (token fee `0.0001 TKN`) and `decodeMemo`. **Unverified:** that the published npm artifact `6.0.0` equals the git tag, and that a browser's `Intl.NumberFormat` prints exactly what Node's does (the digits come from the double; only the grouping is locale data, fixed to `en-US`).

The scenario: the OISY user is Alice (`k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae`), the ledger is `TKA` (8 decimals, fee 10,000 base units) or `TKC` (18 decimals, fee 2,000,000,000,000), the recipient is Bob. The profile-generated messages come from `fixtures/icrc1.resolved.json` and `icrc21ConsentMessage`.

## Side by side

### 1. Plain: 0.29 TKA to Bob, nothing optional

**OISY fallback** (transcribed, see "How the OISY message was produced"):

~~~markdown
# Approve the transfer of funds

**Amount:**
0.29 TKA

**From:**
k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae

**To:**
ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6

**Fee:**
0.0001 TKA
~~~

**Profile-generated, `GenericDisplayMessage`:**

~~~markdown
# Send tokens

Send `0.29 TKA` to `ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6`

- **Amount:** `0.29 TKA`
- **Recipient:** `ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6`
~~~

**Profile-generated, `FieldsDisplayMessage`** (OISY's fallback has no counterpart: its dialog renders only `GenericDisplayMessage`):

~~~text
intent: Send tokens: Send 0.29 TKA to ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6
Amount: {"TokenAmount":{"decimals":8,"amount":"29000000","symbol":"TKA"}}
Recipient: {"Text":{"content":"ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6"}}
~~~

The profile message lacks `From` and `Fee`. Both show `0.29 TKA`; for a round amount OISY adds `.0` and thousands separators (`100.0 TKA`, `1,000.0 TKA`) and the profile message follows spec section 5.3 (`100 TKA`).

### 2. Everything optional present

**OISY fallback** (transcribed, see "How the OISY message was produced"):

~~~markdown
# Approve the transfer of funds

**Amount:**
1.5 TKA

**From:**
k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae-6cc627i.1

**To:**
ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6-cabqh3q.7

**Fee:**
0.0001 TKA

**Memo:**
lunch
~~~

**Profile-generated, `GenericDisplayMessage`:**

~~~markdown
# Send tokens

Send `1.5 TKA` to `ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6-cabqh3q.7` from subaccount `#1` with memo `lunch` paying fee `0.0001 TKA`

- **Amount:** `1.5 TKA`
- **Recipient:** `ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6-cabqh3q.7`
- **From subaccount:** `#1`
- **Memo:** `lunch`
- **Fee:** `0.0001 TKA`
~~~

OISY folds sender subaccount and recipient subaccount into the account text (`...-6cc627i.1`), as the ICRC-1 examples recommend. The profile message shows the recipient the same way and the sender's subaccount as `#1`, because the sender account is not in the call.

### 3. Memo structure: A memo that forges a section (it contains a blank line and `**Amount:**`)

**OISY fallback** (transcribed, see "How the OISY message was produced"):

~~~markdown
# Approve the transfer of funds

**Amount:**
100.0 TKA

**From:**
k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae

**To:**
ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6

**Fee:**
0.0001 TKA

**Memo:**
rent

**Amount:**
0.0001 TKA
~~~

**Profile-generated, `GenericDisplayMessage`:**

~~~markdown
# Send tokens

Send `100 TKA` to `ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6` with memo `0x72656e740a0a2a2a416d6f756e743a2a2a0a302e3030303120544b41`

- **Amount:** `100 TKA`
- **Recipient:** `ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6`
- **Memo:** `0x72656e740a0a2a2a416d6f756e743a2a2a0a302e3030303120544b41`
~~~

OISY's message now has two `**Amount:**` sections, the second one written by whoever chose the memo. The profile message shows a memo with line breaks as hex, in one code span: unreadable but unforgeable (the cost is spec section 5.3's rule that control characters force hex, applied to the whole memo).

### 4. Memo link: A memo with a Markdown link

**OISY fallback** (transcribed, see "How the OISY message was produced"):

~~~markdown
# Approve the transfer of funds

**Amount:**
100.0 TKA

**From:**
k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae

**To:**
ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6

**Fee:**
0.0001 TKA

**Memo:**
[Claim your refund](https://evil.example/refund) **now**
~~~

**Profile-generated, `GenericDisplayMessage`:**

~~~markdown
# Send tokens

Send `100 TKA` to `ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6` with memo `[Claim your refund](https://evil.example/refund) **now**`

- **Amount:** `100 TKA`
- **Recipient:** `ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6`
- **Memo:** `[Claim your refund](https://evil.example/refund) **now**`
~~~

In OISY's message the memo is Markdown, so the dialog (with the allow-list above) can show a clickable "Claim your refund" link next to the real fields. In the profile message the same bytes are one code span and parse to a single `code` node (checked with the CommonMark reference parser, `commonmark` 0.31.2, in `test/oisy-comparison.test.mjs`).

### 5. Memo bytes: A memo that is not UTF-8 (bytes ff fe 00 01)

**OISY fallback** (transcribed, see "How the OISY message was produced"):

~~~markdown
# Approve the transfer of funds

**Amount:**
0.00000001 TKA

**From:**
k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae

**To:**
ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6

**Fee:**
0.0001 TKA

**Memo:**
��<U+0000><U+0001>
~~~

**Profile-generated, `GenericDisplayMessage`:**

~~~markdown
# Send tokens

Send `0.00000001 TKA` to `ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6` with memo `0xfffe0001`

- **Amount:** `0.00000001 TKA`
- **Recipient:** `ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6`
- **Memo:** `0xfffe0001`
~~~

`decodeMemo` is `new TextDecoder('utf-8').decode(bytes)` inside a `try`/`catch` that returns hex. A `TextDecoder` constructed without `{ fatal: true }` never throws, so the hex branch is dead code; OISY's own test only reaches it by stubbing `TextDecoder` to throw. (The ledger's Rust code uses `std::str::from_utf8`, which does reject; OISY's comment says it is "similar to" it.)

### 6. Above 2^53: 9007199254740993 base units (2^53 + 1) on 8 decimals

**OISY fallback** (transcribed, see "How the OISY message was produced"):

~~~markdown
# Approve the transfer of funds

**Amount:**
90,071,992.54740992 TKA

**From:**
k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae

**To:**
ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6

**Fee:**
0.0001 TKA
~~~

**Profile-generated, `GenericDisplayMessage`:**

~~~markdown
# Send tokens

Send `90071992.54740993 TKA` to `ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6`

- **Amount:** `90071992.54740993 TKA`
- **Recipient:** `ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6`
~~~

`Number(9007199254740993n)` is `9007199254740992`, so the displayed amount is one base unit too small, and nothing says so. The profile conversion is integer arithmetic and rejects excess precision instead of rounding (ground rule 8).

### 7. Eighteen decimals: 0.123456789012345678 TKC (18 decimals)

**OISY fallback** (transcribed, see "How the OISY message was produced"):

~~~markdown
# Approve the transfer of funds

**Amount:**
0.12345678901234568 TKC

**From:**
k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae

**To:**
ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6

**Fee:**
0.000002 TKC
~~~

**Profile-generated, `GenericDisplayMessage`:**

~~~markdown
# Send tokens

Send `0.123456789012345678 TKC` to `ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6`

- **Amount:** `0.123456789012345678 TKC`
- **Recipient:** `ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6`
~~~

Eighteen-decimal tokens are the case where a double fails first: a 17-digit mantissa cannot hold `123456789012345678`.

## What the profile-generated message adds

- **Exact amounts for every ledger** (facts above). In the `FieldsDisplayMessage`, an amount that fits `nat64` is a `TokenAmount` and one that does not is a `Text` with every digit (spec section 11 item 5). The ledger's own fields message does not do this: `nat_to_u64` in `responses.rs` returns `GenericError` ("Failed to convert tokens to u64") for an amount above 2^64 - 1 (read at the ledger tag above, not executed).
- **Inert user-controlled text.** Values from the call go into code spans (fence longer than any backtick inside); invisible and bidi characters are shown as `\u{...}`; profile text is backslash-escaped. The ledger's own Generic message wraps the memo in a single pair of backticks (`add_memo` in `responses.rs` formats `` \n\n**Memo:**\n`{memo_str}` ``), so a memo that contains a backtick closes the span early. **Fact, by parsing the string that template yields** (the ledger itself was not run): the memo ``a` [x](https://evil.example) `b`` produces a Markdown link next to the real fields (asserted in `test/oisy-comparison.test.mjs`).
- **Any method.** The same code produces the message for `icrc2_approve` (with the expiry in the user's time zone), `icrc2_transfer_from`, and, for methods without an `intent`, a generic intent. OISY's fallback is three functions.
- **Both ICRC-21 forms**, checked against the standard's `ICRC-21.did` (`TokenAmount`, `TimestampSeconds`, `DurationSeconds`, `Text`).
- **No state-dependent claim**: nothing about a default fee or a balance.
- **Provenance** on the result (`provenance.intent`: `{ origin: "pack", profile: "icrc1" }`), so a signer can raise the same kind of warning OISY raises for its fallback. The words of a profile are a claim, not a proof (spec section 11 item 1); the generic intent for an untagged method has no profile behind it.

## What it lacks compared with OISY's fallback

- **`From` (the caller's account).** Not in the argument bytes. A signer that knows the caller could pass it in; the spec has no placeholder for it (`caller` exists only as a `default.value`). Proposed next step, not done.
- **The fee line.** OISY (and the ledger's own message) show the fee the ledger will charge. That is useful to a person, and state-dependent: it can change between fetching the message and executing the call. If W0 wants it, it needs a rule in spec section 6 ("describe state as 'at the time of signing'" or an explicit fee argument), not a template trick.
- **An integrated warning.** OISY's `Warn` banner is part of its dialog. Here `provenance` is data; showing a banner is the signer's job.
- **The wallet's rendering.** OISY sanitizes with DOMPurify and tests that a memo cannot contribute a button. The profile package produces a string that is safe under CommonMark, and does not know the renderer. A renderer with extensions such as GFM bare-URL autolinking is a case this package handles for values (inside code spans nothing is parsed) but not for the literal text of a profile's template.
- **Memo readability.** A memo with a line break is shown as hex. Spec section 5.3 asks for it; OISY shows the text.

## Limits of this comparison

- One signer library version and one wallet commit; the library has no other releases compared.
- OISY's message was transcribed, not run; the transcription is validated only against OISY's own tests.
- Claims about how the dialog renders come from reading its sanitizer configuration, not from running the wallet.
- The ledger's own message was read (`lib.rs`, `responses.rs`), not compared line by line with the ICRC-21 examples of the standard, which differ in labels and wording (`Send {{name}}`, `Approve spending`).
