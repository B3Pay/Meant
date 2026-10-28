# @meantjs/tools

Agent tools from any Candid Profile resolved form, for an app or an agent host: MCP tool definitions, input reading in human units, a preview that a person confirms before every send, and the retry and reconcile rules of spec section 7.3. The design and the readings it takes on open questions are in `docs/proposals/w3b-tools-package.md` in the repository; the eval's own tool arm (arm C) is a separate, frozen copy.

```sh
npm install @meantjs/tools
```

- **Runs on:** Node 22 or later and browsers: no `node:*` import, no `Buffer`, no `process` (a test bundles it for the
  browser with esbuild).
- **Module format:** ES modules only, with hand-written TypeScript declarations for every entry.
- **Spec:** [Candid Profile v0](https://github.com/B3Pay/Meant/blob/main/profile/docs/profile-v0.md). **Licence:** Apache-2.0.
- **Versions:** the five Candid Profile packages (`@meantjs/profile`, `/format`, `/consent`, `/tools`,
  `/reconcile`) release together under one version and pin each other exactly; in 0.x a minor is breaking,
  and so is any change to generated text ([releasing](https://github.com/B3Pay/Meant/blob/main/profile/docs/releasing.md)).

## API

```js
import { createToolLayer, toolDefinitions, readToolInput, buildToolPlans } from "@meantjs/tools";

const canisters = [{ id: "ryjl3-tyaaa-aaaaa-aaaba-cai", label: "TKA", refs: { "query:icrc1_decimals": 8, "query:icrc1_symbol": "TKA" } }];

toolDefinitions([icrc1Resolved, icrc2Resolved], { canisters }); // MCP tool definitions, sorted by name

const layer = createToolLayer({
  resolved: [icrc1Resolved, icrc2Resolved],
  canisters,
  encode: (method, value, args) => encodeArgs(methods.get(method).args, args).bytes, // candid-core's encoder
  call: async ({ canister, method, mode, arg, value, args }) => ({ status: "replied", reply }), // or rejected / unknown
  now: async ({ canister }) => canisterTimeNs,           // that canister's clock, bigint ns
  confirm: async (preview) => askThePerson(preview),     // awaited before every send
  reconcile: async ({ canister, method, value, stamp }) => ({ status: "absent" }), // optional, consumer rule 1
});
await layer.callTool("prepare_icrc1_transfer", { canister_id: canisters[0].id, to: "…", amount: "1.5 TKA" });
await layer.callTool("commit", { preview_id: "p1" });
```

- **Tools.** One per query method (named as the method), one `prepare_<method>` per update method, and `commit`, with arm C's rules for which positions are inputs (a value-tagged position is a text input in human units; the idempotency stamp, `auto` defaults and `ui.hidden` positions are filled by the layer). On the pack fixtures the tools, their inputs and their required sets equal `armCToolDefinitions()` (tested). Beyond arm C, for interfaces the packs do not cover (the last five are items 1, 2, 4, 5 and 6 of B2 in `docs/proposals/w9-b3wallet-gaps.md`; the packs meet none of them, so their tools do not change):
  - **A principal.** A `principal` position with no value tag is a text input in the principal's textual form. It has exactly one, with a checksum, so it is read exactly without a profile tag (spec 5.3 has none for it): the input is trimmed, its case ignored, its checksum checked (`E_PRINCIPAL`), and the value is the canonical text. Its schema gives the grammar, two examples and a `pattern`, and a `describe` label goes in front as for any input.
  - **An integer the profile describes.** An integer position (`nat`, `int` and their sized forms) with no value tag but a `describe` is a text input of decimal digits, read as they are: trimmed, no unit, separators, exponent, `+` or leading zeros (`E_SYNTAX`), within the Candid type's bounds (`E_RANGE`); a whole argument of this kind is the input `integer`. The words say what the number is (an action id, a page size), so an integer without a `describe` still has no rule.
  - **A read-only update** (`effect: { kind: "read", irreversible: false, replicated: true }`, D-038) is a read tool named as the method, sent once as an update call (`call` gets `mode: "update"`), so that the answer is certified; no preview, no confirmation. With an idempotency stamp it is skipped.
  - **An update without `idempotency`** gets a prepare tool too, whose description says it has no stamp. Its first send is like any other; after an unknown outcome it is never sent again (spec 5.3: without the tag, an update with unknown outcome is not retried automatically), see `reconcile` below. With an outcome class `retry_new`, which renews a stamp, it is skipped.
  - **Outcome keys through record fields.** A key may pass through a record field to a case (`Ok.state.Failed`). The classifier follows the reply's cases and, at a record, the field the keys read there; a key that names no case or field, ends on a field, or reads another field of a record than an earlier key does (one reply could match both) skips the method.
  - **More than one argument.** Each argument is an input of its own, `arg0`, `arg1` and so on, read by the rules above; an idempotency stamp skips the method.
  - **Text and bool** (D-050). A `text` position is a text input taken as given (not trimmed), checked against its `text` tag: `max_len` and `range` lengths in code points (1024 without either), `pattern` (unanchored, with the `u` flag) and `format` (`url`: an http or https URL; `email`); lone surrogates are refused. A pattern the layer will not run skips the method with the reason: over 256 characters, not valid with the `u` flag, a back reference, a lookaround, or a group that repeats inside a group that repeats (exponential backtracking). A `bool` position is `"true"` or `"false"`.
  - **Nested arguments** (D-050). A record, variant or `vec` that no value tag reads (an account record is still one text input) is one input in JSON: an object for a record (unknown keys refused), `{ "tag": "Case", "value": … }` for a variant case (no `value` for a `null` case), an array for a `vec` (`null` for an element that is none), and each leaf read by its own rule above, as text. At most 256 elements in a `vec` and 4096 values in one input. An issue names its place (`$args[0].command.Follow.followees[1].id`). The input's JSON Schema mirrors the shape (`oneOf` per case, `maxItems`) with each leaf's own schema. A `null` or `reserved` field takes no input, and neither does a lone `null` or `reserved` argument. A recursive position, or a field or case named by a number, still skips the method.
  - **An outcome with `default` alone** (D-049): every reply of the method is that class, whatever its result; outcome keys still need a method with one result.
  - **One tool per case** (D-053, rule 3 of B2). A method whose single argument is a variant with an `intent` or an `effect` on any of its cases gets one tool for each case instead of one for the method: `<method>_<Case>` when the case's effect is a read (every case of a query, or a read-only update case), else `prepare_<method>_<Case>`. Its inputs are the case's payload, read as a single argument is (a record's fields, one value-tagged input, none for a `null` case, else one JSON input), and it sends `{ tag: Case, value }` (a bare `{ tag }` for a `null` case). Its title is the case's intent, else its `describe`, else `<method> <Case>`; its effect the case's, else the method's; the method's `outcome` applies, and a prepare tool needs an intent, the case's or the method's. The case is part of the intent's identity, so two cases with the same inputs are two previews. A case without a rule, or without a name (`#3`), is skipped alone, with `case <Case>:` in front of the reason; a method with an idempotency stamp gets no case tools yet (the stamp would sit inside a case). A tagged variant deeper in the argument (inside a record) stays one JSON input.

  A method with no rule (including a query with more than one result) is skipped and reported in `buildToolPlans(resolved).skipped`, not thrown on; so is every method whose tool name is `commit` or is another method's tool name, every method with an argument field named `canister_id` (the canister selector's input), and every update whose stamp is the whole argument rather than a field (a required stamp field is filled like an optional one). The stamp and the outcome keys are relpaths, matched by the position they resolve to: `(0).Ok`, `.Ok` and `Ok` are one key.
- **Input words.** Each input's description is the format library's `Formatter.describe()`, with the canisters' decimals and symbol filled in when they agree (and its regular-expression `pattern` for amounts and subaccounts). When the canisters disagree the words give the grammar without the numbers.
- **Reading.** `readToolInput(plan, input, { refs, now })` returns `{ value, identity }` or `{ issues: [{ param, path, code, message }] }`, every issue at once, with the format library's codes. `value` is candid-core's domain shape (`T | null` opts, `bigint` for nat/int/nat64/int64, `Uint8Array` blobs, principals as text), so `encodeArgs` takes it: the single argument, or for a method with more than one the argument tuple.
- **Sending.** `encode(method, value, args)` is injected, so the bytes are the host's encoder's (candid-core's `encodeArgs`, as ic-reactor sends; a test checks every send against it). `args` is the whole argument tuple (empty, one argument, or several); encode it. `value` is the single argument, kept for hosts that encode `[value]`; for a method with more than one argument it is the tuple again, so such a host's `encodeArgs(types, [value])` is refused (`invalid_length`, observed with candid-core) rather than encoded wrongly. `call` receives the bytes, `mode` (`"query"`, or `"update"` for a commit and for a read-only update), and the `value` and `args` they encode. Results are `{ content, structuredContent, isError? }`: structured data with a short text beside it.
- **Confirmation.** `confirm(preview)` is awaited before every send, including a re-send. There is no auto-approve default: a form with an update method needs it. A decline sends nothing and answers `declined`.

## Outcomes

| Outcome | When | The intent |
|---|---|---|
| `declined` | `confirm` said no | settled if it had no attempt, else unchanged; after an unknown outcome the result also carries `earlier_outcome: "unknown"` (the earlier attempt may have executed). A stamp declined before any send sets no floor for later stamps of the same arguments, and is never handed out again |
| `success`, `already_done` | the class of the reply | done: a later commit answers `already_done` without sending |
| `retry_same` | the class of the reply | unchanged: handed back, nothing sleeps here. The third one stops the intent (consumer rule 3): `reconcile` after an unknown outcome, else `fail` with `retries_spent`, settled |
| `retry_new` | the class of the reply | a new preview with a new stamp, relative times resolved again; the old preview is retired. A `CreatedInFuture` re-stamp is capped by its `ledger_time` (only that case, matched by its name) |
| `fix_input`, `fail` | the class of the reply | settled |
| `not_executed` | reject code 1, 2 or 3 | unchanged |
| `unknown` | for an update with an idempotency stamp: no answer, or any reject code other than 1 to 3 (4, 5, 6 and any unlisted code; or any reject from `aaaaa-aa`); a `call` that throws is answered the same (`message` is the error's) | unknown: commit again sends the same bytes; preparing it again returns the same preview with outcome `unknown`, as does any later preparation of an intent that had one |
| `reconcile` | after an unknown outcome, any answer but success, already_done or retry_same (retry_same resends the same bytes and stamp, so the ledger's deduplication answers Duplicate within the window and TooOld after it); or a third reject 4/5 of the intent. For an update without an idempotency stamp, at once, in place of `unknown`: the finding is `unreadable` with the reason, and the `reconcile` hook is not called, since there is no stamp to match | held until `reconcile` finds the original (then done) or reports it absent (then settled); without a stamp, held: no commit or preparation of it sends again |

## Tests

`npm test -w packages/tools`: definitions against arm C's, input reading against candid-core's encoder, every outcome row above against a scripted ledger, concurrent preparations and commits, a `call` that throws, the hand-written types against the runtime exports, and the browser bundle. **Observed (2026-10-14, while writing them):** each guard in `src/layer.mjs` was removed once and its test failed; the four regression tests from the review fail on the earlier code. `test/interface-rules.test.mjs` runs the B2 rules on a wallet-like form; **observed (2026-10-24):** each of its ten guards (the update call for a read-only update, the hold after an unknown outcome, a reject 4 and the hook's skip without a stamp, the `describe` requirement, the two record-key checks, the argument tuple, the `retry_new` and stamped-read skips) was removed once and a test failed. `test/readers.test.mjs` runs the D-050 readers, and every value they prepare is encoded by candid-core; **observed (2026-10-27):** removing the bare `{ tag }` for a `null` case, the repeat check on patterns, or the lone-surrogate check made a test fail.

## Not here

- The demo's agent tools are not switched to this package yet: its tools also read address-book names and choose the calling identity per call (the payer question of #10), and its write engine is the app's.
- Arm C keeps its own code; rebuilding it on this package before the freeze, with re-pinned hashes, is recommended in the proposal (D-015 reruns nothing while no run has started).
