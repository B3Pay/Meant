# Candid Profile v0

**Status:** Draft 0.2 (2026-10-08). Breaking changes are expected until the preregistered eval reports.
**Normative keywords:** MUST, SHOULD and MAY as in RFC 2119.
**Machine-readable parts:** [`spec/profile-v0.schema.json`](../spec/profile-v0.schema.json) (structure) and [`packages/resolver`](../packages/resolver) (reference checks for addresses, applicability, refs, templates, idempotency and outcomes; `scripts/validate.mjs` is a single-profile CLI over them).

---

## 1. What a profile is

A **profile** attaches *meaning* to positions in a Candid interface: what a number's unit is, which call moves value, how to describe a call to a human, whether a retry is safe, and what each error means. One profile feeds four consumers:

| Consumer | What it gets from the profile |
|---|---|
| Agent tools (MCP, WebMCP) | Human-unit inputs, filled defaults, safe retries, classified outcomes, a confirmation step |
| ICRC-21 consent messages | An intent line and typed display fields, generated for any method |
| MCP Apps cards | The same intent and fields, rendered as an approval or inspection card |
| Web UI (ic-reactor, Rust SSR) | Input widgets, labels, formatting |

**Non-goals for v0:** page layout or views (MCP Apps and host renderers own presentation), cross-canister references, multi-language templates, EVM ABI support (planned for v1 via ERC-7730 import and export).

## 2. Relationship to candid-core

- **Input:** a candid-core Contract v1, compiled from a `.did` file, plus the optional `SourceInfo` sidecar (needed only for doc annotations, §9).
- **Identity is untouched.** A profile never changes `interface_id` or `contract_id`. It is a separate document bound to them (§7), the same way SourceInfo is a sidecar.
- **Why addresses target positions, not type nodes.** candid-core interns structurally equal types into one node. Compiling the ICRC-1 fragment shows the consequence: one `opt blob` node serves `from_subaccount`, `memo` and `Account.subaccount`, and one `nat` node serves `amount`, `fee`, `Ok`, `duplicate_of` and `expected_fee`. Tagging the node would tag every one of them. So profiles address the **edge** that leads to a value: a method argument or result, then a path through fields (§3).

## 3. Addresses

### 3.1 Grammar

```abnf
address      = value-address / method-address
method-address = METHOD                                   ; the method itself
value-address  = METHOD "(" INDEX ")" path                ; argument INDEX
               / METHOD "->(" INDEX ")" path              ; result INDEX
               / "type:" DECL path                         ; canister profiles only
path         = *( "." label / "[]" )
label        = IDENT / "#" U32                             ; field/case name, or raw Candid id
relpath      = [ "(" INDEX ")" ] [ [ "." ] label / "[]" ] *( "." label / "[]" )   ; non-empty
METHOD, DECL, IDENT = [A-Za-z_][A-Za-z0-9_]*
U32          = decimal integer, 0 … 4294967295
```

**Equivalent spellings.** `icrc1_transfer(0).amount` and `icrc1_transfer(0).#3573748184` denote the same position. Implementations MUST compare addresses by their resolved form (method, side, index, id path, or the type edge for `type:` addresses), never as strings.

### 3.2 Resolution rules

1. **Labels hash to Candid ids.** A label resolves to `idl_hash(label)`, the same `u32` the Contract stores. `#n` is the raw id; use it for positional (tuple) fields and numeric labels.
2. **`opt` is transparent.** A path step passes through any `opt` wrappers. A tag on `fee : opt nat` applies to the `nat`. The resolved form records `"optional": true`.
3. **`[]` steps into a vector element.** `blob` (`vec nat8`) is a leaf: tags address the blob itself, never `[]`.
4. **Variant cases are selected like fields:** `icrc1_transfer->(0).Err.BadFee.expected_fee`.
5. **Each address MUST resolve** to exactly one position, or `E_ADDR_UNRESOLVED`.
6. **Packs MUST NOT use `type:` addresses**, because declaration names are not standardized across implementations (`E_PACK_TYPE_REF`).
7. **A `type:` address applies wherever that edge is reached.** Because of interning, it also applies to structurally identical types declared under other names. Validators MUST warn (`W_STRUCTURAL_ALIAS`) when the declaration a `type:` address starts from names a type that another declaration also names; the tag then reaches both. Use a method address to disambiguate.
8. **A pathless `type:` address (`type:Account`) denotes the declaration's whole type**, so it reaches every position of that type. It is allowed only when that type is a record or a variant (`E_TYPE_NODE`). Aliases of primitives, blobs and vectors (`type Tokens = nat`, `type Subaccount = blob`, both in the ICRC-1 `.did`) would tag every `nat` or every `blob` in the interface, block indexes and memos included. Address those through a field path or a method address instead.
9. **Relative paths** (`relpath`) are used inside tag arguments. They resolve against the method's argument tuple (intent placeholders, `idempotency.stamp`, `list.cursor`) or result tuple (`outcome` keys, `list.next`, `list.items`). When the tuple has one element, paths are relative to element 0; otherwise they MUST start with `(i)`.

**v0 limitation:** method names must be identifier-shaped. Quoted Candid method names (for example `"foo-bar"`) are an open question (OQ-3).

### 3.3 Examples

| Address | Meaning |
|---|---|
| `icrc1_transfer` | The method (for method tags) |
| `icrc1_transfer(0).amount` | `amount` field of the first argument |
| `icrc1_transfer(0).to` | The whole `Account` record (for the `account` tag) |
| `icrc1_balance_of->(0)` | The `nat` result |
| `icrc1_transfer->(0).Err.InsufficientFunds.balance` | A field inside an error case |
| `get_blocks->(0).blocks[].#0` | Field id 0 of each vector element |
| `type:Tokens.e8s` | Declaration-based (canister profiles only) |

## 4. Values inside tag arguments

- **Literals:** JSON strings, booleans and integers. Integers that can exceed 2^53 (amounts, bounds) MUST be decimal strings, for example `"100000000"`.
- **Dynamic values:** `{ "from": "query:<method>" }`, `{ "from": "now" }`, `{ "from": "caller" }`.
  - `query:<method>` MUST name a query (or composite query) method on the same canister that takes no arguments and returns one value of the expected kind (`E_REF_*`). Example: `{ "from": "query:icrc1_decimals" }`.
  - `now` and `caller` are only valid where the tag allows them (in v0, `default.value`).
  - **`now` uses the canister's clock, not the host's.** Consumers MUST take the time from the canister's environment, for example the time in a recent certificate or the transport's `now()`. A host clock that is ahead of the replica produces `CreatedInFuture`; one that is behind produces `TooOld`.
  - Consumers resolve dynamic values once per canister per session, by querying or from a trusted configuration of the same canister, and cache them. See §11 for the trust caveat.
- **Candid literals:** `default.value` holds Candid textual syntax, for example `"null"` or `"opt 0"`.

## 5. Tags

There are 18 tags. Twelve are **core**: the eval depends on them, so they are stable within v0. Six are **experimental** and may change.

### 5.1 Value tags

| Tag | Applies to | Args | Core |
|---|---|---|---|
| `amount` | `nat`, `int`, `nat8`…`int64` | `decimals` (0–255 or dynamic, required); `symbol` (text or dynamic) | ✓ |
| `timestamp` | `nat`, `int`, `nat32`, `nat64`, `int64` | `unit`: `ns`/`us`/`ms`/`s` (required); `epoch`: `unix` | ✓ |
| `duration` | same as `timestamp` | `unit` (required) | ✓ |
| `account` | `record { owner : principal; subaccount : opt blob }` | `encoding`: `icrc1` | ✓ |
| `subaccount` | `blob` | none | ✓ |
| `bytes` | `blob` | `encoding`: `utf8`/`hex`/`base64` (required); `max_len` | ✓ |
| `default` | any position (`null` only on `opt`) | `value` (Candid literal or dynamic); `mode`: `auto`/`suggest` | ✓ |
| `describe` | any position, or a method | `label`, `help` | ✓ |
| `text` | `text` | `format`: `plain`/`markdown`/`email`/`url`; `max_len`; `pattern` | exp. |
| `range` | numeric, `text`, `vec` | `min`, `max` (decimal strings, base units); `min_len`, `max_len` | exp. |
| `ui` | any position | `order`, `group`, `hidden`, `widget` (UI only; agents ignore it) | exp. |
| `named` | a position a name from a `names` set can stand for (D-045) | `set` (required); `by`: `value`/`show` | exp. |

### 5.2 Method tags (address = bare method name)

| Tag | Args | Core |
|---|---|---|
| `intent` | `title` (≤60 chars); `template` (§6) | ✓ |
| `effect` | `kind`: `read`/`write`/`transfer`/`approve`/`admin`/`destroy`; `irreversible`: bool; `replicated`: bool, optional (a read-only update, §5.3) | ✓ |
| `idempotency` | `mode`: `replay_same_payload`; `stamp`: relpath to the field filled once per intent | ✓ |
| `outcome` | `classes`: `{ relpath → class }`; `default`: class (one of the two at least; §5.3) | ✓ |
| `list` | `cursor` (args relpath); `next`, `items` (results relpaths) | exp. |
| `names` | `set` (required); `items` (results relpath to a `vec` of records, required); `name`, `value` (required), `show`, `kind`: paths inside one item (D-045) | exp. |

### 5.3 Normative behavior

**`amount`**
- **Display:** the base-unit integer `v` with `d` decimals is shown as a decimal string with trailing fractional zeros removed, then a space and the symbol. Examples: `150000000` with `d=8` → `1.5 ICP`; `100000000` → `1 ICP`.
- **Input:** an optionally negative decimal number with digits on both sides of a single `.` if it has one, optionally followed by whitespace and the symbol: `"1.5"` or `"1.5 ICP"`. Thousands separators, exponents and a leading `+` MUST be rejected. A symbol, if present, MUST match the token's symbol (case-insensitive for ASCII letters only).
- **No rounding:** input with more than `d` fractional digits MUST be rejected, never rounded, including when the extra digits are zeros.
- **Sign:** negative input MUST be rejected unless the Candid type is signed.
- **Bounds:** values outside the range of the position's Candid type MUST be rejected, never wrapped or clamped. Constraints in `range` are always in base units.

**`timestamp`**
- **Display:** canonical RFC 3339 UTC, `YYYY-MM-DDTHH:MM:SS[.f]Z` with trailing zeros of the fraction removed; human renderers localize, using ICRC-21 `utc_offset_minutes` when present.
- **Input:** an absolute RFC 3339 time with an explicit zone (leap seconds are rejected), or a relative ISO 8601 duration prefixed with `+` (`+PT24H`, `+P7D`), resolved at fill time against `now` floored to the tagged unit.
- **Conversion:** to the tagged `unit` MUST be exact.

**`duration`** uses ISO 8601 durations (`PT24H`) for both input and display. Only the units `W`, `D`, `H`, `M` (after `T`) and `S` are allowed: `P1D` is exactly 86,400 s. Calendar years and months (`P1Y`, `P1M`) MUST be rejected because their length is undefined. The same rule applies to the relative `timestamp` input. Display uses `D`, `H`, `M` and `S` only (never `W`), omitting zero components: 86,400 s is `P1D`, 5,400 s is `PT1H30M`, 0 is `PT0S`. A fraction is allowed on the seconds only and MUST convert exactly; a leading `-` is allowed only when the Candid type is signed.

**`account`**
- **Display:** the ICRC-1 textual encoding (principal, or `principal-checksum.subaccounthex`).
- **Input:** the same textual encoding, or a bare principal for the default subaccount. Input is case-insensitive; non-canonical forms (an explicit default subaccount, leading zeros in the subaccount, a missing checksum) MUST be rejected as the ICRC-1 textual encoding specifies.
- **Checksum:** consumers MUST verify it on input.

**`subaccount`**
- **Input:** `#n` or a plain decimal `n` with 0 ≤ n < 2^64 (encoded as 32 bytes, big-endian), or exactly 64 hex characters, optionally prefixed with `0x`. A string of exactly 64 hex digits is read as hex even when every digit is a decimal digit; a decimal `n` has no leading zeros.
- **Display:** `#n` if and only if the first 24 bytes are zero (n < 2^64); otherwise 64 lowercase hex characters.
- **Round trip:** `parse(display(x)) = x` MUST hold for every 32-byte value.

**`bytes`**
- **`utf8`:**
  - Input is plain text, encoded as UTF-8. Input starting with `0x` is read as hex.
  - Display shows the decoded text when the bytes are valid UTF-8 without control, format or line-separator characters (Unicode Cc, Cf, Zl, Zp) and the text does not start with `0x`; otherwise `0x` followed by lowercase hex.
- **`hex`, `base64`:** input and display use that encoding. Hex input accepts an optional `0x` prefix and either case; display is always `0x` plus lowercase hex. Base64 uses the RFC 4648 standard alphabet, padding optional on input and always written on display, non-zero spare bits rejected.
- **`max_len`** counts bytes after encoding.

**`default`**
- **`auto`:** the tool layer fills the value, and agent-facing tool schemas MUST NOT expose the field.
- **`suggest`:** the field is exposed, with the default pre-filled.

**`effect`**
- **Defaults when the tag is absent:** query methods → `read`; update methods → `write` with `irreversible: true` (conservative).
- **Effect and mode:** a query or composite query declared as anything but `read` is `E_EFFECT_MODE`. A `read` on an update or a oneway method is `W_EFFECT_MODE`, except in the read-only update form below.
- **A read-only update (D-038):** `{ "kind": "read", "irreversible": false, "replicated": true }` declares an update method that changes no canister state the profile describes and is called as an update so that its answer is certified by the subnet rather than given by one replica. **Fact** ([IC interface specification, HTTPS interface](https://docs.internetcomputer.org/references/ic-interface-spec/https-interface/)): the reply to an update call comes with a certificate of the subnet's state (through `read_state`, or in the synchronous call response), while a query's reply comes from a single replica and is signed only by that node. Consumers MUST send it as an update call, never through the query endpoint, or the certification it declares is lost. The form is valid only on an `update` method, with `kind: "read"` and `irreversible: false`; `replicated: true` with another `kind`, with `irreversible: true`, or on a `query`, `composite_query` or `oneway` method is `E_EFFECT_MODE` (a oneway call has no answer to certify; a query is a `read` already). The valid form gets no `W_EFFECT_MODE`. `replicated: false` is the same as leaving it out. The form changes no other rule: the method is a `read` for consumers, and it is still an update for retries (see `idempotency` below). `replicated` is the author's claim, like any effect: the resolver cannot check that the method changes nothing, so without `W_EFFECT_MODE` the claim rests on the profile's provenance (§11.1).
- **Confirmation:** consumers MUST require explicit human confirmation before executing `transfer`, `approve`, `admin` or `destroy`, unless a separately configured policy, such as a spending budget, pre-authorizes it. Policies are outside v0.

**`idempotency` (`replay_same_payload`)**
- **The stamp field** MUST carry a `timestamp` tag (`E_STAMP_UNTAGGED`).
- **The tool layer owns it.** Stamp positions MUST NOT appear in agent-facing tool schemas or be editable in UIs. The tool layer stamps them from the canister's clock (§4).
- **The tool layer fills the stamp once per user intent**, encodes the arguments once, and reuses **the exact encoded bytes** for every retry of that intent.
- **One intent, one stamp.** An intent is identified by the canister, the method and the converted arguments without the stamp (base units, defaults applied, `auto` fields filled). The tool layer MUST keep the intents it has stamped during the session. A new preparation whose intent matches one whose last attempt is pending or had an unknown outcome MUST NOT mint a new stamp: it MUST return the existing prepared call (same identifier, same bytes) and say so, or refuse until rule 1 below has settled the earlier attempt. An intent is unsettled while it was prepared but not committed, its last attempt was `retry_same`, it was rejected by the replica, or its outcome is unknown; it is settled by `success`, `already_done`, `fail`, `fix_input` or reconciliation. Only once the earlier intent is settled MAY the same arguments be stamped again, as a new intent that the user confirms again, and the stamp of that new intent MUST be later than the stamp of every earlier intent with the same identity. A relative time input is identified by its duration, not by the instant it resolves to; inputs that convert to the same value are the same intent, and the all-zero subaccount equals an absent one.
- **After an unknown outcome**, the tool layer's response MUST tell the caller to repeat the commit of the same prepared call, and MUST NOT suggest preparing a new one.
- **Unknown outcome:** if a call's outcome is unknown (timeout, connection loss, "may have executed"), the consumer MAY retry with the same bytes **within the canister's deduplication window**. Inside the window, the canister either executes the call once or returns the `already_done` case.
- **A rejection by the replica** (a trap, a refused call) means the call did not execute; it is not an unknown outcome, and the same bytes may be sent again.
- **Without this tag**, consumers MUST NOT retry an update with unknown outcome automatically.
- **Why ICRC-1 works this way:**
  - Deduplication applies only when `created_at_time` is set, and only within `TX_WINDOW` (+ `PERMITTED_DRIFT`), which the ledger defines.
  - Different memos are never treated as duplicates.
  - A duplicate returns `Duplicate { duplicate_of }`.

**`outcome` classes**

| Class | Meaning for the caller |
|---|---|
| `success` | Done. |
| `already_done` | An identical call already executed. Treat it as success and report the referenced result (for example `duplicate_of`). |
| `retry_same` | Transient. Retry with the same encoded bytes. |
| `retry_new` | The idempotency stamp expired or is ahead of the canister clock. Re-stamp, show the user the new intent, and retry only after confirmation. |
| `fix_input` | The input needs correcting (fee, expiry, allowance). Error fields carry the hint. |
| `fail` | Do not retry. |

- **`outcome` keys** MUST select variant cases (`E_OUTCOME_NOT_CASE`).
- **A result that is not a variant (D-049).** `classes` MAY be left out when the method's result has no variant to select: a record, a number, nothing. `default` is then required and is the class of every reply. A failure of such a method reaches the consumer only as a reject, which the consumer handles as for any update (§5.3 `idempotency`: a rejection by the replica means the call did not execute; an unknown outcome follows the retry rules). On a method whose result does reach a variant, `default` without `classes` leaves every case unclassified, as any case without a key (`W_OUTCOME_UNCLASSIFIED`, at info level because the default is set).
- **Overlapping keys:** when `Err` and `Err.BadFee` are both given, the most specific key (longest path) wins.
- **Unclassified cases** fall back to `default` (diagnostic at info level), or produce `W_OUTCOME_UNCLASSIFIED` when there is no default.
- **Consumers MUST treat a result case that has no class and no default as `fail`.** This covers cases the profile never saw, such as the extra result cases a pack match allows (§7).

**`names` and `named` (D-045)**

People give things names (an account's label, a contact, a member's label, a known neuron) and then use the names in
place of the values. `names` says where a canister lists such names; `named` says which positions accept one. Every
consumer (agent tools, consent messages, guards) then resolves a name by the same rule, instead of each by its own.

- **A names set.** `names` marks a method that lists named things: `items` is the results relpath of the list, and
  `name`, `value`, `show` and `kind` are paths inside one item (relative to an element of `items`).
  - The method MUST be a query or a composite query, or a read-only update (D-038), and MUST take no arguments
    (`E_NAMES_MODE`, `E_NAMES_SHAPE`), so the canister vouches for its own names as it does for its decimals (§4).
  - `items` MUST resolve to a `vec` of records and `name` to `text` (`E_NAMES_SHAPE`, `E_NAMES_FIELD`).
  - `value` is what a name stands for; `show`, when given, is what to display beside the name (an address, when
    `value` is an id); `kind`, when given, splits the set (an account's chain), so a consumer can ask for "the account
    named Main that holds Bitcoin".
  - A set name is declared once among the merged profiles (`E_NAMES_SET_DUPLICATE`).
- **A named position.** `named` with `set` marks a position whose value a name of that set can stand for; `by`
  (default `value`) says which field of the entry fills it. The set MUST be declared (`E_NAMED_SET`), and the
  position MUST have the same Candid type as that field (`E_NAMED_TYPE`). `named` stacks with the position's other
  tags: a transfer's `to` stays whatever it was, and a name is tried only when the input is not a value.
- **The match.** `normalize(t)` is Unicode NFKC, then the Unicode default lowercase mapping (full, without locale
  rules), then every run of `White_Space` characters made one space, then leading and trailing spaces removed. A name
  matches text `t` when the two normalized strings are equal. Nothing else is removed: words such as "my" or "the" are
  the reader's to drop, not the resolver's. Lowercase, not case folding, so that JavaScript, Rust and Python give the
  same answer from their standard libraries ("STRASSE" does not match "Straße"). Test vectors:
  [`spec/names-vectors.json`](../spec/names-vectors.json).
- **Resolution** of input `t` at a named position, given the set's entries (and optionally a `kind`):
  1. Input that is a valid value of the position by its own tags and type (an address, a principal, a number) is that
     value. It is not looked up. A `text` position's valid values are the texts its `text.pattern` matches; a named
     `text` position without a pattern gets `W_NAMED_UNPATTERNED`, since every input is then looked up first and a
     name could stand in for text that was meant as a value. Input there that matches no name is passed on as text.
  2. Otherwise the entries whose normalized name equals `normalize(t)`, of the given `kind` if one is given: exactly
     one gives its `value` (or `show`, with `by: "show"`); none is **not found**; more than one is **ambiguous**.
     Consumers MUST NOT pick one of several: an agent tool asks the person, a guard reports "not checked".
  3. An entry whose name is itself a valid value of the position never matches, so a label written as an address
     cannot redirect a transfer. An entry whose normalized name is empty never matches.
- **Display.** A consumer SHOULD show a named position's value with the name of the one entry it belongs to, as
  `Savings (efadq-…-kjy554y.1)`; with no such entry, or several, the value alone. For `transfer`, `approve`, `admin`
  and `destroy`, the value MUST be shown whenever a name is. Names are untrusted text a person typed: escape them
  (§6) and never let one stand in for the value.
- **Once per intent.** A name is resolved when the call is prepared, and the prepared call carries the value. A rename
  after the person confirmed changes what is displayed beside the value, never the value sent.

**Outcome handling rules for consumers** (these depend on call history, so they cannot live in the static class map):
1. **`reconcile` overrides `retry_new` after an unknown outcome.** If an earlier attempt of the same intent had an unknown outcome and a later attempt returns a `retry_new` case (for example `TooOld`), the deduplication window has passed and the first attempt may have executed. The consumer MUST treat this as `reconcile`: check the canister's history for the original before any new attempt (ICRC-3 blocks since the stamp, matched on operation, stamp, amount, accounts, memo and caller; balances and allowances cannot settle it). If the history cannot settle it, ask the user, and MUST NOT send or re-stamp the call until the user has answered. `reconcile` is a result of the consumer, not a class of a pack.
2. **`CreatedInFuture`:** the new stamp MUST NOT exceed the `ledger_time` the error reports. Re-stamping from the same skewed clock would fail again.
3. **Retry budget:** `retry_same` retries MUST stop before the deduplication window can close, at most a few attempts with backoff. After that, apply rule 1.

## 6. Intent templates

```text
Send {amount} to {to}[ from subaccount {from_subaccount}][ with memo {memo}]
```

- **Placeholders:** `{relpath}` is rendered with the formatter of the tag at that position (`amount` → `1.5 ICP`, `account` → textual encoding, `timestamp` → date). Positions without a formatting tag render as Candid text.
- **Optional segments:** `[ … ]` is dropped when any placeholder inside it is absent (`null`). Nesting is not allowed in v0.
- **Optional placeholders:** a placeholder that resolves to an `opt` position outside `[ … ]` triggers `W_TEMPLATE_OPTIONAL`.
- **Escapes:** `{{`, `}}`, `[[`, `]]`.
- **Escaping values:** rendered values MUST be escaped for the target format. In Markdown (ICRC-21 `GenericDisplayMessage`), a memo containing `[link](…)` must not render as a link.
- **No state-dependent claims:** templates MUST describe only what the call does with its arguments, never state-dependent facts such as "your balance after this is…". ICRC-21 requires a consent message to describe every possible outcome despite the delay between fetching and submitting.

## 7. Document format, identity and binding

```jsonc
{
  "format": "candid-profile",
  "format_version": 0,
  "kind": "canister",                // or "pack"
  "name": "my-ledger",
  "origin": "author",                // author | third_party | inferred  (packs: "pack")
  "language": "en",
  "binds": { "interface_id": "candid-core:interface:v1:sha256:…", "canister_id": "…" },
  "annotations": [ { "at": "icrc1_transfer(0).amount", "tag": "amount", "args": { "decimals": 8, "symbol": "ICP" } } ]
}
```

**`profile_id`**
- Defined as `candid-profile:v0:sha256:<hex>`, over the RFC 8785 (JCS) canonical JSON of the document.
- The validator prints it. Packs in this repo as of 2026-10-09: `icrc1` → `…e5b16b51…`, `icrc2` → `…5230908f…` (D-029). Any edit changes them.

**Canister profiles** bind to `interface_id`. Given a live interface:

1. **Same `interface_id`:** the profile is valid.
2. **Different `interface_id`:** re-resolve every address against the new interface and re-check tag applicability.
   - **Everything still holds:** the profile is `rebound` (`W_REBOUND`).
   - **Anything fails:** the profile is `stale` (`E_STALE`, reported in addition to the specific errors). Consumers MUST NOT use its value-conversion tags (`amount`, `timestamp`, `duration`, `account`, `subaccount`, `bytes`), and agent tools fall back to raw Candid for those positions. A resolver MUST NOT emit those tags in the resolved form: it leaves the stale profile's value-conversion tags out and keeps the rest (`intent`, `effect`, `describe`, `default`, …).

**Packs** bind structurally:
- `binds.requires` holds a Candid service fragment, and a pack applies to a canister whose service type is a **subtype** of that fragment.
- Every `query:` ref in a pack MUST be a method of the fragment.
- **Result variants may be wider (D-019).** Under Candid subtyping a variant with extra cases is a supertype, so a canister whose result variant has cases the fragment lacks is not, strictly, a subtype. Pack matching relaxes this for variants reached through a *result* position: extra cases are allowed. They carry no annotations, and for `outcome` they fall back to `default`, or to `fail` when there is no default (§5.3). Argument positions follow strict Candid subtyping. A pack `outcome` tag SHOULD set `default` (`W_PACK_NO_DEFAULT`).

## 8. Layering and precedence

A canister's effective profile is merged from layers, highest first:

| Layer | Source | Trust |
|---|---|---|
| `author` | Served by the canister as the public custom section `icp:public candid:profile` (§8.1), or shipped by its author | The author's claim (§11) |
| `third_party` | A profile the consumer chose to trust (v1: attestations) | As configured |
| `pack` | Standard packs matched by subtyping | Reviewed in this repo |
| `inferred` | AI-proposed; MUST be approved by a human before it is active; until then shown only as a suggestion | Lowest |

- **Merging is per tag, per position.** The first layer, highest first, that has the tag at the position supplies it. The same tag at the same position in a lower layer is dropped and reported (`W_OVERRIDDEN`). Other tags on that position are kept. The layer decides before specificity: an `author` tag given through a `type:` address beats a `pack` tag given through a method address.
- **Within one layer** (also when the layer holds several profiles, for example two packs): a method address beats a `type:` address. Two different values for the same tag at the same specificity is `E_CONFLICT`; the first one given is kept. Equal values are `W_DUPLICATE`.
- **A pack that matches a service is applied to the service's own types:** addresses resolve against the service, not the fragment. A position the pack names that the service lacks, which subtyping allows, is skipped (`I_PACK_ANNOTATION_SKIPPED`).

### 8.1 Serving a profile (D-048)

A canister serves its own profile, so that a consumer who knows only the canister's id can find it.

- **Where.** The profile document, as UTF-8 JSON (RFC 8259) without a byte order mark, is the content of the canister's
  public Wasm custom section `icp:public candid:profile`.
  - **Fact** ([IC interface specification, canister information](https://docs.internetcomputer.org/references/ic-interface-spec/)):
    the content of a custom section `icp:public <name>` is at `/canister/<canister_id>/metadata/<name>` in the state
    tree, and "otherwise, this path does not exist". The specification recommends `icp:public candid:service` for the
    canister's Candid interface; the profile is its neighbour.
  - **Fact** ([HTTPS interface, read state](https://docs.internetcomputer.org/references/ic-interface-spec/https-interface/)):
    anyone may request that path for a public section, also when the canister has no such section, and the reply is a
    certificate of the subnet's state, unlike a query's reply, which one replica signs.
  - **Fact** ([resource limits](https://docs.internetcomputer.org/references/resource-limits/)): at most 16 exported
    custom sections named `icp:…` and 1 MiB of exported custom sections per canister. A served profile is therefore at
    most 1 MiB.
- **What may be served.** A profile of `kind: "canister"` and `origin: "author"`. `binds.canister_id` MAY be left out
  (one module installed as many canisters); when given, it MUST be the id of the canister that serves it. Bytes that are
  not such a document are `E_SERVED`, and the profile is not applied.
- **How a consumer reads it.**
  1. Read `/canister/<id>/metadata/candid:service` and `/canister/<id>/metadata/candid:profile` in **one** `read_state`
     request, and verify the certificate. One certificate gives both from the same state, so the pair cannot come from
     two versions of the module.
  2. A path the certificate shows absent means the canister serves nothing there: no profile is not an error. A path the
     certificate neither holds nor shows absent is an error; the consumer MUST NOT read it as absent.
  3. Bind the profile as any other (§7) against the interface the same canister serves as `candid:service`: the same
     `interface_id` applies it, a different one makes it `rebound` or `stale`. A canister that serves no `candid:service`
     gives nothing to bind against, and the consumer binds against the interface it has from elsewhere.
  4. Apply it in the `author` layer (§8).
- **A tagged `.did`.** The `candid:service` a canister serves MAY carry doc annotations (§9). They are an `author`
  profile too, read from the same certificate. A consumer that reads both applies both in the `author` layer, where two
  different values for one tag at one position are `E_CONFLICT` (§8).
- **Adding it** needs no code change: the section can be added to a built module, for example with
  `ic-wasm canister.wasm -o canister.wasm metadata candid:profile -f my.profile.json -v public` or
  `candid-profile-kit embed canister.wasm --profile my.profile.json`, and is served from the next install or upgrade.
  A profile served this way changes with the module only: editing it changes the module hash and needs an upgrade.
- **Other channels.** A profile read through a query method, or fetched from any host but the canister's certified
  state, is not certified (§11.2). A consumer MAY still apply it in the `author` layer when it trusts that channel, as
  for a profile the author ships with their code.

## 9. Doc annotations (authoring inside the `.did`)

Authors can write tags as doc comments. A compiler turns candid-core `SourceInfo` docs into an `author` profile:

```candid
type Tokens = record {
  /// @amount(decimals = 8, symbol = "ICP")
  e8s : nat64;
};
type SendArgs = record { to : principal; amount : nat; memo : opt blob };
service : {
  decimals : () -> (nat8) query;
  /// Send tokens to another principal.
  /// @intent(title = "Send", template = "Send {amount} to {to}[ with memo {memo}]")
  /// @effect(kind = "transfer", irreversible = true)
  /// @amount(at = "amount", decimals = query(decimals), symbol = "TOK")
  /// @bytes(at = "memo", encoding = "utf8")
  /// @amount(at = "->(0).Ok", decimals = query(decimals), symbol = "TOK")
  send : (SendArgs) -> (variant { Ok : nat; Err : text });
}
```

- **Syntax:** a doc line `@<tag>(k = v, …)`, where `<tag>` is one of §5. Values are numbers, `"strings"`, `true`/`false`, `query(m)`, `now()` or `caller()`. Any other `@word` is left as prose.
- **`at`** targets a position relative to the documented item. Candid has no doc comments on function arguments, so method docs reach their positions this way:
  - `at = "<relpath>"` targets the arguments.
  - `at = "-><relpath>"` targets the results.
- **Attachment:**
  - Docs on declarations become `type:<Decl>` addresses.
  - Docs on fields become `type:<Decl>.<field>` when the field is declared in a named type. Docs on fields inside inline actor types use the SourceInfo occurrence path; mapping that to a method address needs confirming against real SourceInfo output (OQ-4).
  - Method docs become method addresses.
- **Plain prose** (non-`@` lines) becomes `describe.help`.
- **Identity:** annotations change `source_bundle_id` but never `interface_id` or `contract_id`, because docs live in SourceInfo, outside the Contract.

## 10. Resolved form (consumer interchange)

Consumers do not implement address resolution. They read the **resolved form**: one tree per method with tags attached to each position. The interface is either compiled from Candid source or taken from a candid-core `ContractEnvelope` that a generator already wrote; the resolved form is the same either way, and its `interface_id` is the envelope's `contract.identities.interface` (D-039). Generate it with:

```sh
node scripts/validate.mjs packs/icrc1.profile.json --resolved > fixtures/icrc1.resolved.json
```

```jsonc
{
  "format": "candid-profile-resolved", "format_version": 0,
  "interface_id": "candid-core:interface:v1:sha256:…",
  "profiles": [ { "name": "icrc1", "origin": "pack", "profile_id": "…" } ],
  "methods": {
    "icrc1_transfer": {
      "mode": "update",
      "tags": { "intent": { "args": {…}, "origin": "pack", "profile": "icrc1" }, "effect": {…}, "idempotency": {…}, "outcome": {…} },
      "args": [ { "candid": "record", "fields": {
        "amount": { "candid": "nat", "tags": { "amount": { "args": { "decimals": { "from": "query:icrc1_decimals" }, … } } } },
        "created_at_time": { "candid": "nat64", "optional": true, "tags": { "timestamp": {…}, "ui": {…} } }
      } } ],
      "results": [ { "candid": "variant", "cases": { "Ok": {…}, "Err": {…} } } ]
    }
  },
  "diagnostics": []
}
```

**Node fields:**
- `candid`: a primitive name, or `record`/`variant`/`vec`/`blob`/`func`/`service`.
- `optional`, `fields` (records), `cases` (variants), `element` (vectors).
- `recursive: true` where a cycle is cut.
- `tags`: `{ tag → { args, origin, profile } }`.

**Ordering and unresolved values:**
- Field order follows canonical id order, not source order; use `ui.order` for presentation.
- Dynamic values stay unresolved (`{ "from": … }`): resolving them needs the network, so it is the consumer's job.

**Where tags come from:**
- Tags from `type:` addresses appear at every position reached through that edge.
- A method-address tag at the same position wins (§8).

**Reference implementation:** `@meantjs/profile` (`packages/resolver`). `candid-profile resolve <service.did> [--profile p.json ...] [--packs]` merges any number of profiles (§8), matches packs by subtyping (§7) and prints the resolved form. `profiles` lists every applied profile, highest layer first. `scripts/validate.mjs` remains the single-profile validator and generates the fixtures. Diagnostics from a multi-profile resolve carry an optional `profile` field naming the profile they are about.

## 11. Security considerations

1. **A profile is a claim, not a proof.** An author profile can describe a drain as "claim reward". ERC-7730 has the same limit; Ethereum's clear-signing effort adds ERC-8176 attestations for this.
   - **v0 mitigations:** provenance on every tag; binding to `interface_id`.
   - **Consumers** SHOULD show decoded raw arguments next to the rendered intent for `transfer`, `approve`, `admin` and `destroy`.
   - Third-party attestation is v1.
2. **Dynamic refs come from a single replica.** A plain query response is not certified, so a malicious replica could report wrong `decimals`, and every displayed amount would be wrong by a power of ten.
   - Consumers SHOULD resolve refs used to render `transfer`/`approve` intents through an update call or a certified path, or cross-check with `icrc1_metadata`.
   - Consent messages generated *inside* the canister avoid this, because the canister knows its own decimals.
3. **No silent rounding or truncation** anywhere in value conversion (§5.3).
4. **Escape rendered values** for the target format (§6).
5. **ICRC-21 field limits.**
   - `TokenAmount.amount` is `nat64`, so 18-decimal tokens above about 18.4 whole units do not fit. Consumers MUST fall back to a `Text` field for them.
   - `TimestampSeconds` is in seconds, while ICRC-1 timestamps are in nanoseconds. Convert using the `timestamp` tag; never pass the raw value.
6. **Bounded work.** Resolution of untrusted profiles and interfaces SHOULD reuse candid-core's `Limits` budget.
7. **Names are untrusted display text** (`names`, §5.3). Whoever may name an account or join with a label chooses the
   text: it can look like an address, mimic another entry, or press the reader ("approved by the CEO"). The rules of
   §5.3 keep a name from ever replacing a value: a value always wins, ambiguous names fail, and the value is shown
   beside the name. Names read through a plain query come from one replica, as dynamic refs do (item 2).
8. **A served profile is certified, not vouched for** (§8.1). The certificate proves that the canister serves these
   bytes, so no replica or boundary node can change them, but the words are still the author's claim (item 1). A
   canister can serve a profile that calls a drain "claim reward"; the controller that installs the module chooses it.

## 12. Mapping to ICRC-21 (informative)

For `device_spec = FieldsDisplay`:

| Profile | `icrc21_consent_message.FieldsDisplayMessage` |
|---|---|
| `intent.title` + rendered `template` | `intent` |
| each placeholder | one `(label, Value)` row; label from `describe.label`, else the field name |
| `amount` | `TokenAmount { decimals; amount; symbol }` when it fits `nat64`, else `Text` |
| `timestamp` | `TimestampSeconds { amount }` after unit conversion |
| `duration` | `DurationSeconds { amount }` after unit conversion |
| everything else | `Text { content }` |

For `GenericDisplay`, the output is the rendered template as Markdown, followed by the same fields as a list.

**Rendering rules (D-028, reference implementation `packages/consent`):**
1. The fields-form `intent` is the title, a colon and a space, and the rendered template; the title alone when the method has no template.
2. Rows are in the order of first appearance in the template, one per distinct path. A placeholder in a dropped `[ ]` segment contributes none; an absent placeholder outside a segment renders as `(none)`.
3. A placeholder whose path crosses a variant case is absent unless the value holds that case. A placeholder over `[]` renders its elements joined with `, `; more than 256 elements is refused.
4. Untagged values render in Candid text syntax, except that a principal on its own renders as its textual form.
5. `TokenAmount` only when the amount is non-negative, fits `nat64` and the tag has a symbol; otherwise `Text`. `TimestampSeconds` and `DurationSeconds` only when the converted value is exact and fits `nat64`; otherwise `Text`.
6. Generic form times are `YYYY-MM-DD HH:MM:SS[.f] UTC+HH:MM` from the exact instant; the response carries the applied `utc_offset_minutes` exactly when a time is shown in the generic form. The fields form is UTC seconds and never zone-sensitive. An offset outside ±24 h is ignored with a diagnostic.
7. Generic layout: `# title`, the paragraph, then `- **label:** value` lines. Values from the call are Markdown code spans (fence longer than any backtick run inside); an empty value is `*(empty)*`; text that comes from the profile is backslash-escaped. Bare URLs in a profile's own template text are the author's responsibility.
8. A method without `intent` gets the title from `describe.label`, else `Call <method>`, and one row per leaf of the decoded arguments (records flattened, value-tagged positions as leaves, absent optionals left out, `ui.order` first). More than 64 rows is refused, never truncated.
9. A request for a language the profile does not have is answered in the profile's language, and the metadata says which (ICRC-21 prefers a message over an error). An absent `device_spec` means `GenericDisplay`.
10. A value a formatter refuses is shown as raw Candid text with a diagnostic; a formatter that cannot be built (unresolved dynamic ref, bad tag argument) produces no message, so a number is never shown without its decimals.
11. The consent message carries the decoded raw arguments only on request. The signer that displays the message is the consumer that SHOULD show them (§11 item 1).
12. Nothing the resolved form cannot carry is guessed at. A position it cuts (`recursive: true`) is decoded as `reserved`, so the bytes there are skipped without trusting their type; a call whose value reaches a cut position (the chosen case of a variant, a present `opt`, a field of a record the value holds, an element of a `vec`) is `ConsentMessageUnavailable`, and a call whose value avoids every cut gets its message (D-042). `func`, `service` and `opt opt T` positions make the whole method `ConsentMessageUnavailable`. A template that fails at consent time falls back to the generic intent with `W_TEMPLATE_FALLBACK`.

## 13. Diagnostics

| Code | Severity | Meaning |
|---|---|---|
| `E_SCHEMA` | error | Fails the JSON Schema |
| `E_CANDID` | error | The interface (`requires` or `--did`) does not compile |
| `E_ENVELOPE` | error | The interface was given as a candid-core `ContractEnvelope` (`--envelope`) that the resolver cannot read. Among the reasons: not an object, no `contract`, a `contract.format` other than `candid-core`, a `format_version` other than 1, no `contract.identities.interface`, or a type reference outside `contract.types`. The list is not exhaustive: any envelope that fails candid-core's own structural or canonical checks (profiles, declarations, node kinds, actors, function modes) is also `E_ENVELOPE`. No resolved form is produced. |
| `E_SERVED` | error | A profile a canister serves (§8.1) that cannot be used: its bytes are not UTF-8 JSON (or start with a byte order mark), it is over 1 MiB, it is not one JSON object of `kind: "canister"` and `origin: "author"`, or its `binds.canister_id` names another canister. The profile is not applied; the rest of the service resolves without it. |
| `E_ADDR_SYNTAX` / `E_ADDR_UNRESOLVED` | error | Address does not parse / resolve |
| `E_PACK_TYPE_REF` | error | `type:` address in a pack |
| `E_TYPE_NODE` | error | Pathless `type:` address on a declaration that is not a record or a variant |
| `E_TAG_TARGET` / `E_TAG_NOT_APPLICABLE` | error | Wrong kind of target / wrong Candid type |
| `E_REF_UNRESOLVED` / `E_REF_NOT_QUERY` / `E_REF_SHAPE` / `E_REF_TYPE` / `E_DYNAMIC_KIND` | error | Bad dynamic value |
| `E_DEFAULT_NULL` | error | `null` default on a non-optional position |
| `E_EFFECT_MODE` | error | An effect that does not fit the method: a query or composite query declared as something other than `read`, or `replicated: true` anywhere but on an update method with `kind: "read"` and `irreversible: false` (§5.3) |
| `E_IDEMPOTENCY_MODE` / `E_STAMP_UNTAGGED` | error | Idempotency on a query / stamp without a `timestamp` tag |
| `E_OUTCOME_NOT_CASE` | error | Outcome key is not a variant case |
| `E_TEMPLATE` / `E_TEMPLATE_PATH` | error | Template syntax / unknown placeholder |
| `E_CONFLICT` | error | Two different values for one tag at one position |
| `E_STALE` | error | Bound interface changed and some address or tag no longer holds |
| `E_PACK_NOT_MATCHED` | error | A pack the caller asked for explicitly does not apply to the service |
| `E_NAMES_MODE` / `E_NAMES_SHAPE` / `E_NAMES_FIELD` / `E_NAMES_SET_DUPLICATE` | error | A `names` set on a method that is not a query or a read-only update / that takes arguments, or whose `items` is not a `vec` of records / whose `name` is not `text` / declared twice (§5.3) |
| `E_NAMED_SET` / `E_NAMED_TYPE` | error | A `named` position whose set is not declared (or has no `show` for `by: "show"`) / whose type differs from the set's field (§5.3) |
| `W_NAMED_UNPATTERNED` | warning | A `named` `text` position without a `text.pattern`: names are looked up before values (§5.3) |
| `W_REBOUND` | warning | Interface changed; reported first, then either confirmed or followed by `E_STALE` |
| `W_NO_INTERFACE` | warning | Canister profile checked without its `.did`; semantic checks skipped |
| `W_DUPLICATE`, `W_EFFECT_MODE`, `W_STAMP_REQUIRED`, `W_TEMPLATE_OPTIONAL`, `W_STRUCTURAL_ALIAS`, `W_PACK_NO_DEFAULT`, `W_OVERRIDDEN` | warning | See sections above |
| `I_PACK_MATCHED` | info | A pack applies; the message lists every result variant wider than the fragment (D-019) and its extra cases |
| `I_PACK_NOT_MATCHED` | info | A candidate pack from the pack search does not apply; the message gives the first reasons |
| `I_PACK_ANNOTATION_SKIPPED` | info | A matched pack names a position the service lacks, which subtyping allows; the annotation is dropped |
| `W_OUTCOME_UNCLASSIFIED` | warning, or info when `default` is set | A result case without a class |
| `I_UNTAGGED_NUMERIC` | info | A numeric update argument has no meaning attached |

**Not checked by the v0 validator:** whether `default.value` literals other than `null` type-check against their position. Consumers MUST check this before using a default.

## 14. Facts, assumptions and open questions

**Facts (verified 2026-10-08):**
- The candid-core Contract v1 shape, interning, and the `org.candid-core.field-names/v1` extension (observed from `@candid-core/cli` 0.2.0 output).
- ICRC-1/ICRC-2 types and deduplication rules.
- The ICRC-1 textual account encoding.
- ICRC-21 types, including `FieldsDisplayMessage`, `TokenAmount.amount : nat64` and `TimestampSeconds`.

**Assumptions:**
- Typed tools built from these tags reduce agent value errors. This is what the eval tests.
- Doc-annotation ergonomics are good enough for authors.
- Candid subtyping, relaxed for result variants (§7), is the right pack-match rule.

**Open questions:** see [`open-questions.md`](./open-questions.md).
