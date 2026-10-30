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

**Non-goals for v0:** page layout or views (MCP Apps and host renderers own presentation), cross-canister references, multi-language templates. EVM contracts are in, as an experimental binding (§15: profiles of an ABI and of EIP-712 messages, consent text, the ERC-7730 export); what is still out for them is ERC-7730 import, agent tools, `outcome` classes over reverts and `idempotency` by nonce, later phases of §15 that each need their own decision.

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
| `propose(0).Transfer` | The `Transfer` case of `propose`'s argument (for a case `intent` or `effect`, §5.2) |
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

There are 19 tags. Twelve are **core**: the eval depends on them, so they are stable within v0. Seven are **experimental** and may change.

### 5.1 Value tags

| Tag | Applies to | Args | Core |
|---|---|---|---|
| `amount` | `nat`, `int`, `nat8`…`int64` | `decimals` (0–255 or dynamic, required unless `token`); `symbol` (text or dynamic); `threshold`, `message` (display only, §5.3); `token` (EVM only, §15.9) | ✓ |
| `timestamp` | `nat`, `int`, `nat32`, `nat64`, `int64` | `unit`: `ns`/`us`/`ms`/`s` (required); `epoch`: `unix`; `threshold` with `message`, `labels` (display only, §5.3) | ✓ |
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
| `fixed` | an `address` in the arguments of an EVM function or message (§15.4, D-058) | `value`: one address (required) | exp. |

### 5.2 Method tags (address = bare method name)

| Tag | Args | Core |
|---|---|---|
| `intent` | `title` (≤60 chars) and `template` (§6), both required | ✓ |
| `effect` | `kind`: `read`/`write`/`transfer`/`approve`/`admin`/`destroy`; `irreversible`: bool; `replicated`: bool, optional (a read-only update, §5.3); `grant`: object, optional (what a `transfer` or `approve` lets someone take, §5.3) | ✓ |
| `idempotency` | `mode`: `replay_same_payload`; `stamp`: relpath to the field filled once per intent | ✓ |
| `outcome` | `classes`: `{ relpath → class }`; `default`: class (one of the two at least; §5.3) | ✓ |
| `list` | `cursor` (args relpath); `next`, `items` (results relpaths) | exp. |
| `names` | `set` (required); `items` (results relpath to a `vec` of records, required); `name`, `value` (required), `show`, `kind`: paths inside one item (D-045) | exp. |

**On a variant case (D-053).** `intent` and `effect` MAY also sit at a **case address**: an argument address
`METHOD(i)path` whose last step selects a case of a variant (§3.2 rule 4), such as `propose(0).Transfer`. Its path MUST
NOT step into a vector element (`[]`), and neither a result address nor a `type:` address may be used: one call holds
many elements, and a `type:` address can reach several methods (`E_TAG_TARGET`, as for any other value address). For
each of the two tags, the tagged cases of one method MUST NOT overlap (`E_CASE_OVERLAP`): two case addresses overlap
when one value can take both, that is when they sit in different arguments or their paths part at a record field. They
do not overlap when one lies inside the other's case or when they part at a variant, since a value takes one case of a
variant. The **cases a call takes** are the tagged cases on the path its argument value takes; the deepest of them is
the call's case for that tag. The other method tags (`idempotency`, `outcome`, `list`, `names`) stay on the method.

### 5.3 Normative behavior

**`amount`**
- **Display:** the base-unit integer `v` with `d` decimals is shown as a decimal string with trailing fractional zeros removed, then a space and the symbol. Examples: `150000000` with `d=8` → `1.5 ICP`; `100000000` → `1 ICP`.
- **Threshold (display only, D-054):** a value at or above `threshold` (a decimal string of base units) is shown as `message` (default `Unlimited`) and the symbol: `Unlimited USDC`. `message` needs `threshold`. Input is unchanged: a number at the threshold still parses to its base units. ICRC-21 shows such a value as `Text`, never as a `TokenAmount` (§12).
- **Input:** an optionally negative decimal number with digits on both sides of a single `.` if it has one, optionally followed by whitespace and the symbol: `"1.5"` or `"1.5 ICP"`. Thousands separators, exponents and a leading `+` MUST be rejected. A symbol, if present, MUST match the token's symbol (case-insensitive for ASCII letters only).
- **No rounding:** input with more than `d` fractional digits MUST be rejected, never rounded, including when the extra digits are zeros.
- **Sign:** negative input MUST be rejected unless the Candid type is signed.
- **Bounds:** values outside the range of the position's Candid type MUST be rejected, never wrapped or clamped. Constraints in `range` are always in base units.

**`timestamp`**
- **Display:** canonical RFC 3339 UTC, `YYYY-MM-DDTHH:MM:SS[.f]Z` with trailing zeros of the fraction removed; human renderers localize, using ICRC-21 `utc_offset_minutes` when present.
- **Words (display only, D-055):** `labels` maps exact values (decimal strings of the tagged unit, 1 to 16 entries) to words, and a value at or above `threshold` is shown as `message`; `threshold` and `message` come together, with no default word. A label is checked first, then the threshold, then the time. A value shown as words is never read as a time: not localized, and `Text` in ICRC-21, never `TimestampSeconds`. Input is unchanged; a word is never parsed back. They exist for deadlines whose extreme values are not dates (`uint256` max for "never", which is otherwise out of range; Permit2's expiration 0 for "this block only", which otherwise reads as 1970; §15.9).
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
- **A case's effect (D-053).** A call's effect is the effect of its case (§5.2), else the method's, else the default
  above. The checks of this section (`E_EFFECT_MODE`, `W_EFFECT_MODE`, the read-only update form) apply to a case
  effect against the mode of its method. **The method's effect bounds its cases'**: when any case effect of a method
  is `transfer`, `approve`, `admin` or `destroy`, the method's effect MUST be one of these four, and when any case
  effect is `irreversible: true`, the method's MUST be (`E_CASE_EFFECT`; the default of an update, `write`, is not one
  of the four, so such a method declares its effect). A consumer that does not read case effects therefore confirms
  every call that one that reads them would; reading them can only lift a confirmation from a call whose case is
  weaker, and that is the author's claim, like any effect (§11.1).
- **What a call grants (`grant`, D-056).** An effect of kind `transfer` or `approve` MAY carry `grant`: who may take
  tokens because of the call or the signature, which token, how many and until when, so that a consumer can compare a
  request with terms the user confirmed (below). Its values are relpaths into the method's arguments, written as an
  intent template's placeholders are (§6). None may step into `[]`: a grant covers one token, so a request that grants
  several (Permit2's `PermitBatch`) has none in v0. It names:
  - `spender` or `to`, exactly one: who may take the tokens. `spender` is for an allowance, or for a signature whose
    submitter chooses where the tokens go; `to` is for a transfer whose recipient is fixed, by a call or by a signature
    (EIP-3009's signatures and x402's Permit2 payment, §15.9). An `approve`'s grant names a `spender`. The position is
    an `address` (§15) or carries an `account` tag.
  - `amount`: a position with an `amount` tag, of an unsigned type, where a value at or above the tag's `threshold`
    means unlimited; or a `bool`, where `true` is unlimited and `false` grants nothing (DAI's permit, §15.9).
  - `ends`, optional: one to eight positions with a `timestamp` tag. The grant ends at the latest of them, and one at or
    above its tag's `threshold`, or an optional one left out, means it never ends. With no `ends`, an `approve` never
    ends and a `transfer` ends when it is made.

  `spender`, `to` and `amount` are in every call: neither optional nor inside a case of a variant, and no position of
  a grant is inside one. The token is the one the `amount` tag names (`token`, §15.9), else the contract or canister
  the call is for. A deadline that bounds only when a signature may be used is not an end of what it grants:
  EIP-2612's `deadline` and DAI's `expiry` set allowances that never end, so neither is in `ends`. A grant on another
  kind, on a case effect (§5.2), or whose positions break these rules is `E_GRANT`; a pack applied to a service where
  its grant does not hold keeps its effect and loses the grant (`I_PACK_ANNOTATION_SKIPPED`). A grant is the author's
  claim, like any effect (§11.1).
- **Confirmation:** consumers MUST require explicit human confirmation before executing a call whose effect is `transfer`, `approve`, `admin` or `destroy`, unless a separately configured policy, such as a spending budget, pre-authorizes it. Policies are outside v0, except confirmed terms, below.
- **Confirmed terms (D-056).** Terms are what the user allows one task: the token, who may take it (`spender` or
  `to`), the most it may be (or unlimited) and the latest end (or never). Terms the user confirmed for one task, before
  the agent read the request, are such a policy for that task's request. A request whose grant fits them MAY be signed
  or sent without a second confirmation. It fits when:
  - its token and its `spender` or `to` are the terms', compared as values (an address by its 20 bytes, an account by
    its owner and its subaccount, the default subaccount equal to an absent one);
  - its amount is at most the terms' most; unlimited fits only unlimited terms, and a grant of nothing fits any terms;
  - it ends no later than the terms' latest end; one that never ends fits only terms that never end, and a transfer
    fits terms whose end has not passed.

  A request that does not fit is refused with its reasons, and the agent asks the user for new terms rather than
  offering the request for a yes. A request without a grant is not covered by terms and needs its confirmation. The
  terms MUST be shown to the user exactly (§11 item 10), and they cover one task: the request the agent was working
  on when the user confirmed them, and no other. A request is named by what is signed or sent (an EIP-712 request by
  its digest), not by its grant: two requests can grant the same, as two Permit2 transfers that differ only in their
  nonce do, and each of them can be spent.

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
- **Case templates (D-053):** a case intent's template (§5.2) names values as a method's template does, by relpaths
  from the method's argument tuple (§3.2 rule 9), so it can show values outside its case: `propose(0).Transfer` says
  `Send {Transfer.amount} to {Transfer.to}`, and a case inside a record, such as `manage(0).command.Disburse`, can
  name the record's other fields (`{id}`) beside its own (`{command.Disburse.amount}`). A placeholder
  whose path selects another case of a variant that the case address passes through can never be present, and is
  `E_TEMPLATE_PATH`.
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
- The validator prints it. Packs in this repo as of 2026-10-30: `icrc1` → `…4eaa9312…`, `icrc2` → `…f9d75e8b…` (D-056 added their grants). Any edit changes them.

**Canister profiles** bind to `interface_id`. Given a live interface:

1. **Same `interface_id`:** the profile is valid.
2. **Different `interface_id`:** re-resolve every address against the new interface and re-check tag applicability.
   - **Everything still holds:** the profile is `rebound` (`W_REBOUND`).
   - **Anything fails:** the profile is `stale` (`E_STALE`, reported in addition to the specific errors). Consumers MUST NOT use its value-conversion tags (`amount`, `timestamp`, `duration`, `account`, `subaccount`, `bytes`, and `named`, since a name stands in for a value, D-045), and agent tools fall back to raw Candid for those positions. A resolver MUST NOT emit those tags in the resolved form: it leaves the stale profile's value-conversion tags out and keeps the rest (`intent`, `effect`, `describe`, `default`, …).

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
  `ic-wasm canister.wasm -o canister.wasm metadata candid:profile -f my.profile.json -v public` (the project's kit,
  not public yet, does the same as `candid-profile-kit embed`), and is served from the next install or upgrade.
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
  - A case `intent` or `effect` (§5.2, D-053) has no doc form in v0: `@intent` and `@effect` on a method take no
    `at`, and on a field or a declaration they are not allowed. Write a case tag in a profile.
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
- A case node's `tags` MAY hold `intent` and `effect` (§5.2, D-053). A consumer that does not read them uses the
  method's, which §5.3 bounds.

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
9. **An EVM pack applies to any contract whose functions match** (§15.3), so a hostile contract can match ERC-20, call
   its drain "Send tokens" and answer "USDT" to `symbol()`. A consumer MUST show the contract's address, with its EIP-55
   checksum, whenever it asks a person to confirm a call matched by a pack; the consent text of §15.6 ends with it.
   **Fact** ([ERC-7730](https://eips.ethereum.org/EIPS/eip-7730), Security Considerations): the same risk is named
   there as "parameter injection using legitimate, high-profile contract formats". `query:` refs on an EVM contract
   are `eth_call`s answered by one RPC node, as item 2's are by one replica.
10. **Confirmed terms authorize in advance** (§5.3, D-056). Whoever confirms terms authorizes every request that fits
    them, so the confirmation MUST come from the user, on the wallet's own screen, never through a tool the agent can
    call. The terms MUST be shown exactly: the full address, the amount without rounding, and "unlimited" or "never
    ends" written out when the terms say so. **Fact** (observed 2026-10-29, the everyday-wording test of Meant's
    signing guard): small models that wrote the terms from a user's everyday words filled a term the user had left out
    with the loosest value ("unlimited", "never"), and a check against those terms passed requests the user never
    asked for; the check itself held every time. A grant is the profile's claim (item 1), and terms cover what a
    grant says: a request outside its grant's words (another call, another chain) is checked by the rest of the
    consumer, as without terms.
11. **A pin protects only the consumers that read it** (`fixed`, §15.4, D-058). x402's Permit2 payment pays
    `witness.to` only when its spender is x402's proxy; a consumer that skips `fixed` shows the words, and reads the
    grant, for any spender, and terms for one payee would then pass a payment that another spender can send anywhere.
    A resolved form that holds a pin MUST NOT be given to a consumer that does not read `fixed`. The reference consent
    package reads it from 0.5.0, and the five reference packages pin each other exactly; an older consent package
    skips the tag. **Open** (OQ-17): the resolved form does not say which tags a consumer must understand, so an older
    consumer cannot tell that it should refuse.

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
1. The fields-form `intent` is the title of the **call's intent**, a colon and a space, and the rendered template. The call's intent is the intent of the case the call takes (§5.2, D-053), else the method's. The title stands alone when the template renders as empty text (every part of it sits in a `[ ]` segment the call drops) or fails at consent time (rule 12). An intent without a template does not occur: the schema requires both `title` and `template`.
2. Rows are in the order of first appearance in the call's template, one per distinct path. A placeholder in a dropped `[ ]` segment contributes none; an absent placeholder outside a segment renders as `(none)`.
3. A placeholder whose path crosses a variant case is absent unless the value holds that case. A placeholder over `[]` renders its elements joined with `, `; more than 256 elements is refused.
4. Untagged values render in Candid text syntax, except that a principal on its own renders as its textual form.
5. `TokenAmount` only when the amount is non-negative, fits `nat64` and the tag has a symbol; otherwise `Text`. `TimestampSeconds` and `DurationSeconds` only when the converted value is exact and fits `nat64`; otherwise `Text`.
6. Generic form times are `YYYY-MM-DD HH:MM:SS[.f] UTC+HH:MM` from the exact instant; the response carries the applied `utc_offset_minutes` exactly when a time is shown in the generic form. The fields form is UTC seconds and never zone-sensitive. An offset outside ±24 h is ignored with a diagnostic.
7. Generic layout: `# title`, the paragraph, then `- **label:** value` lines. Values from the call are Markdown code spans (fence longer than any backtick run inside); an empty value is `*(empty)*`; text that comes from the profile is backslash-escaped. Bare URLs in a profile's own template text are the author's responsibility.
8. A call without an intent (neither its case's nor its method's) gets the title from `describe.label`, else `Call <method>`, and one row per leaf of the decoded arguments (records flattened, value-tagged positions as leaves, absent optionals left out, `ui.order` first). More than 64 rows is refused, never truncated.
9. A request for a language the profile does not have is answered in the profile's language, and the metadata says which (ICRC-21 prefers a message over an error). An absent `device_spec` means `GenericDisplay`.
10. A value a formatter refuses is shown as raw Candid text with a diagnostic; a formatter that cannot be built (unresolved dynamic ref, bad tag argument) produces no message, so a number is never shown without its decimals.
11. The consent message carries the decoded raw arguments only on request. The signer that displays the message is the consumer that SHOULD show them (§11 item 1).
12. Nothing the resolved form cannot carry is guessed at. A position it cuts (`recursive: true`) is decoded as `reserved`, so the bytes there are skipped without trusting their type; a call whose value reaches a cut position (the chosen case of a variant, a present `opt`, a field of a record the value holds, an element of a `vec`) is `ConsentMessageUnavailable`, and a call whose value avoids every cut gets its message (D-042). `func`, `service` and `opt opt T` positions make the whole method `ConsentMessageUnavailable`. A template that fails at consent time falls back to the generic intent's rows (rule 8) under the intent's own title, with `W_TEMPLATE_FALLBACK`.

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
| `E_TAG_TARGET` / `E_TAG_NOT_APPLICABLE` | error | Wrong kind of target / wrong Candid type. Includes an `intent` or `effect` at a value address that is not a case of a variant in the arguments, or that steps into `[]` (§5.2), on an EVM contract `idempotency`, `outcome`, `list`, `names` and `named` (not yet) and `account` and `subaccount` (no ABI type), and a `fixed` that is not on an `address` in the arguments of an EVM function or message: in a result or at a `type:` address / on another type or a Candid position (§15.4) |
| `E_REF_UNRESOLVED` / `E_REF_NOT_QUERY` / `E_REF_SHAPE` / `E_REF_TYPE` / `E_DYNAMIC_KIND` | error | Bad dynamic value |
| `E_DEFAULT_NULL` | error | `null` default on a non-optional position |
| `E_EFFECT_MODE` | error | An effect that does not fit the method: a query or composite query declared as something other than `read`, or `replicated: true` anywhere but on an update method with `kind: "read"` and `irreversible: false` (§5.3) |
| `E_IDEMPOTENCY_MODE` / `E_STAMP_UNTAGGED` | error | Idempotency on a query / stamp without a `timestamp` tag |
| `E_OUTCOME_NOT_CASE` | error | Outcome key is not a variant case |
| `E_TEMPLATE` / `E_TEMPLATE_PATH` | error | Template syntax, or a `[ ]` segment on an EVM contract (§15.4) / unknown placeholder, or one through another case of a variant on a case intent's path (§6) |
| `E_CASE_OVERLAP` | error | Two tagged cases of one method, for the same tag, that one value can take both (§5.2) |
| `E_CASE_EFFECT` | error | A case effect that needs confirmation, or is irreversible, under a method effect that does not or is not (§5.3) |
| `E_CONFLICT` | error | Two different values for one tag at one position. For `fixed`, two different addresses in any layers, reported at the lower one (§15.4) |
| `E_STALE` | error | Bound interface changed and some address or tag no longer holds |
| `E_PACK_NOT_MATCHED` | error | A pack the caller asked for explicitly does not apply to the service |
| `E_ABI` | error | An EVM ABI (`binds.abi`, or the contract's given as the interface) that cannot be read: a fragment that does not parse, a type that does not exist, an overloaded function name (O1), two components with one field id, or no function at all (§15.1) |
| `E_CHAIN` | error | A profile or pack for an EVM contract given for a Candid service, or the other way round (§15.3) |
| `E_ADDRESS_CHECKSUM` | error | A deployment address (§15.3) or a `fixed` value (§15.4) in mixed case that does not match its EIP-55 checksum |
| `E_EIP712` | error | `binds.eip712.types` that cannot be read (a struct name that is not an identifier or reads as an ABI type or `EIP712Domain`, a member type that is not canonical or not a type, a struct that contains itself or refers to a refused one), a message that shares its name with a function, two profiles that give one type name different members, or types with no message and no function (§15.9) |
| `E_TOKEN_PATH` | error | An `amount.token` that is not a relative path to an `address` in the same argument and the same array element as the amount, or that is given on a Candid service (§15.9, OQ-6) |
| `E_GRANT` | error | A `grant` on an effect that is not a method's `transfer` or `approve` (another kind, a case effect), an `approve`'s grant with `to`, or a position that breaks §5.3: a path that does not resolve, steps into `[]` or passes through a case of a variant; a `spender` or `to` that is neither an `address` nor `account`-tagged; an `amount` that is neither an unsigned `amount`-tagged position nor a `bool`; an optional `spender`, `to` or `amount`; an `ends` position without a `timestamp` tag (§5.3, D-056) |
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

**An error at a pin** (a `fixed` annotation, §15.4) says so at the end of its message, and its profile then supplies only its `effect` tags, without their grants, and its pins that hold. It is never dropped as `I_PACK_ANNOTATION_SKIPPED`.

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

## 15. EVM contracts (experimental, D-054)

**Status:** experimental, phase 1 and the first part of phase 2. A profile can describe an EVM contract's functions;
from it come consent text for a call's calldata and an ERC-7730 clear-signing file with its ERC-8176
`descriptorHash`. It can also describe the EIP-712 messages a wallet is asked to sign (§15.9, D-055), with consent text
for a signing request and an ERC-7730 file of the messages. Agent tools, `outcome` classes over reverts,
`idempotency` by nonce and ERC-7730 import are later phases, each its own decision. The eval does not use any of it.

### 15.1 The interface: an ABI

- **Fact** ([ERC-7730](https://eips.ethereum.org/EIPS/eip-7730)): a function is matched by its selector, the first
  4 bytes of Keccak-256 (Ethereum's, not NIST SHA3-256) of its type-only signature (`transfer(address,uint256)` →
  `0xa9059cbb`). Parameter names are not part of it; ERC-7730 files carry them in their keys
  (`transfer(address to,uint256 value)`), and so does a profile, in `binds.abi`.
- `binds.abi` is an array of human-readable fragments (`function transfer(address to, uint256 value) returns (bool)`)
  or JSON ABI entries. Only functions are read: events, errors, the constructor, `fallback` and `receive` are skipped.
  Aliases read as their canonical types (`uint` is `uint256`, `constant` is `view`), and the canonical fragment of a
  function is `function NAME(type name,…) [view|pure|payable] returns (…)`.
- **Overloaded names are refused** (`E_ABI`; O1): an address names a function by its name alone.
- **Identity:** `candid-profile:evm-abi:v0:sha256:<hex>`, SHA-256 over the RFC 8785 (JCS) form of the sorted canonical
  fragments. It is the resolved form's `interface_id`, and what a contract profile binds to.

The resolver reads an ABI as the graph a Candid interface compiles to, so addresses, tags, merging and the resolved
form work as for a canister:

| ABI | As a profile sees it |
|---|---|
| a function | a method: `view` and `pure` are queries, `nonpayable` and `payable` updates |
| its parameters | one record at argument index 0: `transfer(0).to`; a function without parameters has no argument |
| its outputs | the result tuple: `balanceOf->(0)` |
| a tuple | a record, its components in ABI order. A named component's id is the Candid hash of its name (§3.2 rule 1); an unnamed one's is its position, addressed `#i` |
| `T[]`, `T[k]` | a vector, `[]`; `T[k]` keeps its length |
| anything else | a primitive named by its canonical type: `uint256`, `int64`, `address`, `bool`, `string`, `bytes`, `bytes32` |

Template placeholders read `{to}` and `{value}`, as ERC-7730's do.

### 15.2 Values

- **Integers** are `uintN` and `intN` for N = 8, 16, …, 256, with the bounds of their N bits. `amount` input and
  display are §5.3's, with no rounding.
- **Addresses** have one text form, `0x` and 40 hex digits. They are shown with their EIP-55 checksum. On input, an
  address in mixed case MUST match its checksum; an address in one case carries no checksum and is accepted (O3).
- **Calldata** MUST be decoded strictly: a decoder that reads values from bytes other than their canonical ABI
  encoding (dirty padding, an offset that does not point where the encoder would write, bytes left over) MUST refuse
  them. The consent text of §15.6 re-encodes the values it read and compares the bytes.

### 15.3 Profiles and packs

- **A contract profile** has `kind: "contract"`, an `origin` of `author`, `third_party` or `inferred`, and
  `binds: { "abi": […], "deployments": [ { "chain_id": 1, "address": "0x…" } ] }`. It may have `binds.eip712`
  (§15.9) beside `abi` or instead of it. `deployments` is optional; it says
  which contracts the profile describes, as ERC-7730's `context.contract.deployments` does. An address in mixed case
  that does not match its EIP-55 checksum is `E_ADDRESS_CHECKSUM`; a deployment listed twice is `W_DUPLICATE`.
- A contract profile is checked against its own `binds.abi`. Resolved against another ABI (`candid-profile resolve
  --abi`), it is rebound or stale by the rules of §7 for a canister profile, with the identity of §15.1: `W_REBOUND`
  and `E_STALE` are reported at `binds.abi` and name the identity of its ABI, since a contract profile has no
  `binds.interface_id`.
- **An EVM pack** has `kind: "pack"` and `binds.abi` instead of `binds.requires`. It applies to a contract that has
  every function of the pack with the same selector (so the same name and parameter types), the same output types and
  the same kind of call (a query; or an update that is payable exactly when the pack's is). There is no subtyping. A
  pack's addresses and placeholders use the pack's parameter names; when it applies, they are rewritten to the
  contract's, component by component, by position (EIP-20 names them `_to` and `_value`, WETH `dst` and `wad`).
- A profile or pack for the other kind of interface is `E_CHAIN` when given explicitly, and skipped in a pack search.
- **Standard pack:** [`packs/erc20.profile.json`](../packs/erc20.profile.json), the ERC-20 `transfer`, `approve`,
  `transferFrom`, `balanceOf`, `allowance`, `decimals` and `symbol`. **Fact**
  ([EIP-20](https://eips.ethereum.org/EIPS/eip-20)): `decimals()` and `symbol()` are optional, so a token without them
  matches no pack and needs a contract profile with literal values. The EIP-712 standard files (an EIP-2612 pack, and
  Permit2 and DAI's permit as contract profiles) are in §15.9.

### 15.4 Tags

| Tag | On an EVM contract |
|---|---|
| `amount` | `uint8`…`uint256`, `int8`…`int256`. `query:` refs are `eth_call`s of a `view` or `pure` function of the same contract with no argument and one result. `token` names the token by an `address` field instead (§15.9) |
| `timestamp`, `duration` | `uint32`…`uint256`, `int64`…`int256`. `timestamp` words (§5.3) are for EVM deadlines first |
| `bytes` | `bytes`, `bytes1`…`bytes32` |
| `text` | `string` |
| `range` | an integer type, `string`, an array |
| `describe`, `default`, `ui`, `intent`, `effect` | as §5 says |
| `fixed` | `address`, in the arguments of a function or a message (below) |
| `account`, `subaccount` | none (`E_TAG_NOT_APPLICABLE`): an address needs no tag (§15.2) |
| `idempotency`, `outcome`, `list`, `names`, `named` | not yet (`E_TAG_TARGET`): they need nonces, receipts and reads that a later phase adds |

An ABI value is never absent, so an EVM template MUST NOT use `[ ]` segments (`E_TEMPLATE`); the escapes of §6 are
unchanged. `effect` defaults as in §5.3. The native value a `payable` function receives has no position yet (O2).

**A pin (`fixed`, D-058).** `fixed` says that the profile describes the call or the message only with one address at a
position, its `value`. x402's Permit2 payment needs it (§15.9): Permit2 lets the spender choose where the tokens go,
and only the code of x402's proxy sends them to the payee the message names, so its words hold only when the spender
is that proxy.

- It sits on an `address` in the arguments of a function or a message, in a tuple or in every element of an array. In
  a result or at a `type:` address it is `E_TAG_TARGET`; on another type, or on a Candid service, whose positions hold
  no EVM address, it is `E_TAG_NOT_APPLICABLE`. Its `value` follows §15.2: in mixed case it MUST match its checksum
  (`E_ADDRESS_CHECKSUM`).
- A consumer MUST refuse a call or a signing request whose value at a pinned position is another address, before it
  shows any text (`E_FIXED`, §15.6 and §15.9). Addresses are compared by their 20 bytes.
- **A pin that does not hold takes the profile's words with it.** The words were written for the pinned value, so a
  profile with a pin that is refused (any error above, an address that does not resolve, or a conflict) supplies only
  its `effect` tags, without their `grant`, and its pins that hold. Its other tags are left out of the resolved form,
  which is still written beside the errors. The call or the request then needs a person's confirmation, and no terms
  can pass it (§5.3). A pin's error is never dropped as a pack annotation that does not apply
  (`I_PACK_ANNOTATION_SKIPPED`).
- **Pins do not give way to precedence** (§8). One position holds at most one pinned value across all the profiles of
  a service. A second, different value is `E_CONFLICT` at the profile of lower precedence (in one layer, the one given
  later), which loses its words as above; a profile that pins one position to two values loses its own. Equal pins
  are one pin.
- The ERC-7730 export writes a pin as `visible: { "mustMatch": [value] }` (§15.7).

### 15.5 Resolved form

The resolved form of an EVM contract has the top-level field `"chain": "evm"`. Its nodes carry `abi` where a Candid
form's carry `candid`: the canonical type of a primitive, `"tuple"` with `fields`, or `"array"` with `element` and, for
`T[k]`, `length`. Each method also has `selector` (`0xa9059cbb`), `signature` (the ERC-7730 key form, with names:
`transfer(address to,uint256 value)`) and `state_mutability`; each entry of `profiles` that binds deployments lists
them as `deployments`. EIP-712 messages are under a top-level `messages` map, never `methods` (§15.9): each has
`encode_type`, `type_hash`, `tags` and `args`, and each entry of `profiles` that binds a domain lists its name and
version as `eip712_domain`. Without messages the map is absent, so a phase 1 form is unchanged. A consumer MUST refuse
a resolved form whose `chain` it does not know rather than read it as Candid (the reference consent and tool packages
do).

### 15.6 Consent text for a call

ICRC-21 is the Internet Computer's, so an EVM call gets the same model and the same two layouts as §12 without the
ICRC-21 envelope (`@meantjs/consent/evm`, `evmConsent`): the generic form as Markdown, and the fields form as an intent
line and `(label, text)` rows. The selector picks the function, calldata is decoded strictly (§15.2), and the text ends
with the contract's address and chain (§11 item 9). When a profile lists deployments, the call's contract and chain
MUST be one of them (`E_DEPLOYMENT`). A `payable` function is refused until its value has a position (O2). An
argument whose position is pinned and holds another address is `E_FIXED` (§15.4), before any text.

### 15.7 ERC-7730 files and ERC-8176 attestations

**Fact** ([ERC-8176](https://eips.ethereum.org/EIPS/eip-8176), Draft): an ERC-8176 attestation is an EAS attestation,
under the schema `bytes32 descriptorHash` (UID `0xe023eef1…b5c2`), that a party reviewed the ERC-7730 file whose
RFC 8785 serialization has that Keccak-256. It describes no call; it vouches for a file.

From an EVM contract's resolved form, `@meantjs/consent/erc7730` writes that file (`erc7730Descriptor`): the same
resolved form always gives the same bytes, so the same `descriptorHash`. `$schema` names the exact version
`erc7730-v2.1.0.schema.json`, so that a new release of the `v2` alias cannot move the hash. One entry per function a
transaction calls (an update), keyed by its `signature` (for the messages of §15.9, `options.context: "eip712"` gives a file
of their own):

| Profile | ERC-7730 |
|---|---|
| `intent.title` (else `describe.label` of the method, else `Call <name>`) | `intent` |
| `intent.template` | `interpolatedIntent`: `{(0).to}` reads `{to}`, `[[` and `]]` are plain brackets, `{{` and `}}` stay |
| each leaf of the parameters, in ABI order | one entry of `fields`; `path` in the parameter names, `name.[]` through an array; `label` is `describe.label`, else the name |
| `amount` with `query:decimals` and `query:symbol` (the ERC-20 functions) | `tokenAmount`, `tokenPath: "@.to"` |
| `amount` with literal `decimals` and `symbol` | the same, with `metadata.token` (only when the caller says the contract is that token) |
| `amount` with `token` (§15.9) | `tokenAmount`, `tokenPath` the token's path; inside the field group of an array when the token is in the same element |
| `threshold`, `message` | `threshold` (`0x` hex), `message` |
| `timestamp` in `s` | `date`, `encoding: "timestamp"` |
| `duration` in `s` | `duration` |
| `bytes` in `hex`, untagged `bytes` | `raw` |
| an untagged `address` | `addressName` |
| anything else | `raw` |
| a `payable` function | one more field, `@.value` as `amount` (the native value, which an ERC-7730 wallet knows) |
| `fixed` (§15.4) | `visible: { "mustMatch": [value] }` on its field, the value with its EIP-55 checksum |
| `binds.deployments` | `context.contract.deployments` (the caller may pick a subset; a file needs at least one) |

What a profile says that an ERC-7730 file cannot say is refused (`E_EXPORT`), never written as something near it: a
time in another unit, `utf8` or `base64` bytes, an amount whose decimals and symbol are not the contract's own (or
whose token is outside the array group it is in), an unnamed parameter. `effect` and the agent tags have no ERC-7730
form; the file carries what a call says, not what it does.

Some words have no ERC-7730 form but change no value, and are left out with a note (the export's `notes`) instead of
refusing the file (D-055): a timestamp's `threshold`, `message` and `labels` (the file shows the date), and a template
ERC-7730 cannot interpolate (a placeholder over an array, a whole tuple or a pinned position), which gets no
`interpolatedIntent`.
**Fact** (ERC-7730): `interpolatedIntent` is optional, and a wallet falls back to `intent` when interpolation fails.
Phase 1 refused the whole file for such a template; every file phase 1 wrote is written the same now.

**Fact** (ERC-7730 v2.1.0, the field's `visible` rules): `mustMatch` makes "the field always hidden AND check its
value against the list. Wallet should raise an error if the value does not match the list", and "Interpolated intents
MUST only refer to paths that are noted as always visible", so a template that names a pinned position has no
`interpolatedIntent`. **Assumption:** a wallet compares a `mustMatch` address as an address, whatever the case of its
letters. ERC-7730 does not say; a wallet that compares the text refuses a request written in another case, which
fails closed.

`erc8176Attestation` gives the unsigned offchain attestation (EAS offchain v2 typed data: domain `EAS Attestation`,
version `0.26`, chain 1, the canonical EAS contract; `data` is the hash) and its EIP-712 digest. A reviewer signs it
with their own key. This repository never signs or posts one: it holds no reviewer's key, and an onchain attestation
spends mainnet ETH, which the project never does (no mainnet funds, ever; every test runs on a local network).
Checking attestations is a later phase.

### 15.8 Open items

- **O1.** Overloaded function names (ERC-721 `safeTransferFrom`). Candidate: `name@0x<selector>`.
- **O2.** The native value of a `payable` call as a position, with the chain's native decimals and symbol.
- **O3.** Whether a transfer recipient typed in one case (no checksum) is accepted everywhere.
- **O4.** Whether EVM packs should apply only to deployments a consumer lists (§11 item 9 shows the address meanwhile).
- **O5** and **O6** of the proposal are settled here: `abi` beside `candid` with a top-level `chain` (§15.5), and an
  export that refuses what it cannot express (§15.7).
- **O7.** **Fact** (ERC-7730): a wallet that finds no ticker "SHOULD display the raw value instead with an 'Unknown
  token' warning", where §12 rule 10 produces no message. An exported file cannot make a wallet refuse.
- **O8.** **Assumption:** a wallet reads `metadata.token` as the token at `@.to`. ERC-7730 calls it the token "exported
  by this format"; the export writes it only when the caller says the contract is that token.
- The open items of EIP-712 messages are O9 to O14, in §15.9.

### 15.9 Typed messages (EIP-712, D-055)

**Status:** experimental, the first part of phase 2 (`proposals/w0-evm-eip712.md`, Q1 to Q5 as recommended). A
profile can describe the EIP-712 messages a wallet is asked to sign; from it come consent text for a signing request
and an ERC-7730 file of the messages. Signing, checking signatures, witness messages other than x402's (O9) and agent
tools are not in it.

**Fact** ([EIP-712](https://eips.ethereum.org/EIPS/eip-712), Final): a signing request (`eth_signTypedData_v4`) has
`types`, `primaryType`, `domain` and `message`. The signature signs `keccak256(0x1901 ‖ domainSeparator ‖
hashStruct(message))`. A struct's `typeHash` is the Keccak-256 of its `encodeType`: the struct with its members, then
every struct it refers to, sorted by name (`Mail(Person from,Person to,string contents)Person(string name,address
wallet)`). The domain's fields are `name`, `version`, `chainId`, `verifyingContract` and `salt`, in that order, each
optional. The EIP says a user agent should refuse to sign when `chainId` is not the active chain.

#### Types and messages

- `binds.eip712: { "domain": { "name": "Permit2", "version": "1" }, "types": { "PermitSingle": [ { "name":
  "details", "type": "PermitDetails" }, … ] } }`, in a contract profile or an EVM pack. `types` has the request's own
  JSON shape, without `EIP712Domain`. `domain` is optional and binds only the name and the version; `chainId` and
  `verifyingContract` come from `binds.deployments`. A pack has no domain (each token's is its own) and keeps its
  `binds.abi`, by which it matches (§15.3).
- A struct name is an identifier that does not read as an ABI type (`uint256`, `bytes32`, `tuple`, …) and is not
  `EIP712Domain`. Members have unique names. A member type is a canonical ABI type as written (`uint256`, never `uint`:
  the type hash hashes the text) or a struct of the same map, either with array suffixes (`T[]`, `T[k]`, k ≥ 1). No
  struct contains itself. Anything else is `E_EIP712` at its place; a struct that refers to a refused one is refused
  too.
- **A message** is a type the same document tags with `intent` at its bare name (`PermitSingle`). Its struct is
  argument 0, as a function's parameters are (§15.1): `PermitSingle(0).details.amount`. A type without an intent is a
  type only, and an address that names it is `E_ADDR_UNRESOLVED`. A message may not share its name with a function,
  two profiles may not give one type name different members (the later profile is invalid), and types with no message
  and no function describe nothing: each is `E_EIP712`.
- The resolver computes each message's `encode_type` and `type_hash`. **A request matches a message by its type hash,
  never by its name**: DAI's `Permit` and EIP-2612's share a name and not a hash.
- **Tags.** `intent` and `effect` as on a function. A signature runs nothing when it is signed, so `effect` says what
  it allows, of any kind (`approve` for an allowance, `transfer` for a one-time transfer; default `write`,
  irreversible), and `replicated` does not apply (`E_EFFECT_MODE`). The value tags and the tags that are not yet
  defined are as in §15.4.
- **A message's grant** (§5.3, D-056) names its positions as its template does, from the struct:
  `{ "spender": "spender", "amount": "details.amount", "ends": ["details.expiration", "sigDeadline"] }` for Permit2's
  `PermitSingle`. **Fact** (Uniswap `permit2` at `main`, read 2026-10-30, `src/libraries/Allowance.sol`): an
  expiration of 0 is stored as the time of the block the permit is used in, and that block may come as late as
  `sigDeadline`; the latest of the two is the end, so 0 needs no rule of its own.
- **Identity.** The resolved form's `interface_id` covers the struct types with the functions: §15.1's hash over the
  sorted canonical fragments and one `struct <Name>(<type> <name>,…)` line per type. With no types it is §15.1's, so a
  phase 1 form is unchanged. Whether a contract profile is rebound or stale (§15.3) is decided by its functions alone,
  so the messages a pack adds never make it stale.

#### An amount in the token a field names

`amount.token` is a relative path (§4) from the argument to an `address` field of the same argument, whose path up to
its last `[]` is the amount's own: the token is in the same array element as the amount, or outside every array
(`"token": "details[].token"` for `details[].amount`). Then `decimals` and `symbol` are not given (the schema refuses
them): they are that token's `decimals()` and `symbol()`. The consumer reads them and passes them per token address
(`tokens: { "0xA0b8…": { "decimals": 6, "symbol": "USDC" } }`); the libraries do no I/O. Without an entry there is no
text (`E_REF_UNRESOLVED`; §12 rule 10), never a number read in the wrong decimals. A token's `symbol()` is its own
claim, so its address is always shown beside it: `1.5 USDC (0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48)`. A path
that breaks these rules is `E_TOKEN_PATH`, and so is `token` on a Candid service, whose ledger a field cannot name yet
(OQ-6). `token` works on functions too.

#### Consent text for a signing request

`@meantjs/consent/evm`, `eip712Consent({ resolved, typedData, chainId, refs, tokens, form, utcOffsetMinutes,
rawArguments, limits })`, takes the wallet's active chain. It refuses before anything is shown:

1. `E_DOMAIN`: a domain field EIP-712 does not define; a `salt` (O11); a `types.EIP712Domain` that does not list the
   domain's fields in EIP-712 order (it may be left out); no `chainId` (the signature would be valid on every chain);
   no `verifyingContract`; a `chainId` other than the wallet's; a `name` or `version` other than that of every profile
   that binds a domain, absent where the profile's is absent (Permit2's domain has no version).
2. `E_TYPE_HASH`: no message has the request's type hash. `E_DEPLOYMENT`: a profile lists deployments and the
   verifying contract on the chain is not one of them, so a look-alike contract named "Permit2" gets none of Permit2's
   words.
3. `E_DECODE`: values that are not exactly the members, or not canonical. Integers are decimal strings without
   leading zeros, or JSON numbers up to 2^53 − 1, within their type's range. Addresses follow §15.2. `bytesN` has
   exactly N bytes, as `0x` hex. An array has its declared length, within the decoder's limits.
4. `E_FIXED`: a pinned member (`fixed`, §15.4) that holds another address, such as x402's Permit2 payment with a
   spender other than x402's proxy.
5. `E_REF_UNRESOLVED`: an amount in a token not in `tokens`, or a `query:` ref not in `refs`. For a pack's message
   the `query:` refs are calls to the verifying contract: the consumer resolves that contract's ABI with the packs.

The text is §15.6's model and two forms, then the verifying contract and its chain, the EIP-712 digest (a hardware
wallet that shows the hash can be checked against it), and "This is a signature, not a transaction: whoever holds it
can submit it."

#### The ERC-7730 file of the messages

ERC-7730 binds a file to a contract or to messages, not both, so `erc7730Descriptor(resolved, { context: "eip712" })`
writes the messages' file, with its own `descriptorHash`. **Fact** (ERC-7730): `context.eip712` has `domain` (each
value must match the request's) and `deployments`; formats are keyed by the primary type's `encodeType`, whose hash
must match; for a message, `@.to` is the verifying contract.

- `context.eip712.domain` is the name and version the profiles bind (absent for a pack), and `deployments` as in
  §15.7. Formats are keyed by `encode_type`, and the export checks that its Keccak-256 is the `type_hash`.
- Fields follow §15.7's table. An amount with `token` is `tokenAmount` with `tokenPath`. An array whose elements hold
  an amount in a token of the same element is a field group (`{ "path": "details.[]", "fields": […] }`), its paths
  relative to the element, as ERC-7730's own PermitBatch example writes it. An EIP-2612 amount is `tokenPath: "@.to"`:
  the verifying contract is the token.
- A message without a title is `Sign <name>`. The notes of §15.7 apply: Permit2's file shows its deadlines as dates.

#### Standard files

- [`packs/erc2612.profile.json`](../packs/erc2612.profile.json), a pack: EIP-2612's `Permit` message and the `permit`
  function that submits one. It applies to a token with `permit`, `nonces`, `DOMAIN_SEPARATOR`, `decimals` and
  `symbol`; amounts read the token's `decimals()` and `symbol()`, and a deadline of `uint256` max reads "Never".
  **Fact** ([EIP-2612](https://eips.ethereum.org/EIPS/eip-2612)): "The `deadline` argument can be set to `uint(-1)`
  to create `Permit`s that effectively never expire."
- [`packs/permit2.profile.json`](../packs/permit2.profile.json), a contract profile (`origin: "third_party"`):
  Permit2's `PermitSingle` and `PermitBatch` (an allowance, `approve`) and `PermitTransferFrom` and
  `PermitBatchTransferFrom` (one transfer, `transfer`), amounts in the token each message names. Bound to domain
  `Permit2` and to `0x000000000022D473030F116dDEE9F6B43aC78BA3` on chains 1 and 42161 (**Fact**: ERC-7730's own
  Permit2 example) and on Base and Base Sepolia, 8453 and 84532 (**Fact**: its code and `DOMAIN_SEPARATOR()`, read on
  chain on 2026-10-30, and Uniswap's deployments page; D-058, O10). **Fact** (Uniswap `permit2`, `Allowance.sol` and
  `AllowanceTransfer.sol`): "If the inputted expiration is 0, the allowance only lasts the duration of the block", so
  it reads "Only in the block it is used"; an allowance of `type(uint160).max` is never decremented, so it reads
  "Unlimited".
- [`packs/dai-permit.profile.json`](../packs/dai-permit.profile.json), a contract profile: DAI's older `Permit`, bound
  to domain `Dai Stablecoin` version `1` and to `0x6B175474E89094C44Da98b954EedeAC495271d0F` on chain 1 (**Fact**:
  `MCD_DAI` in the Sky chainlog, read 2026-10-28). **Fact** (MakerDAO `dss/src/dai.sol`): `expiry == 0` never expires,
  `allowed` sets the allowance to `uint(-1)` or 0, and `PERMIT_TYPEHASH` is
  `0xea2aa0a1be11a07ed86d755c93467f4f82362b452371d1ba94d1715123511acb`, which the resolver's hash matches.
- [`packs/usdc.profile.json`](../packs/usdc.profile.json) and
  [`packs/usdc-base-sepolia.profile.json`](../packs/usdc-base-sepolia.profile.json), contract profiles (D-058): USDC's
  EIP-3009 messages. `TransferWithAuthorization` and `ReceiveWithAuthorization` pay `to` once (`transfer`, with a
  grant to `to` that ends at `validBefore`), and `CancelAuthorization` cancels an unused one (`write`, no grant).
  `usdc` is bound to domain `USD Coin` version `2` and to USDC on chains 1, 8453 and 42161; `usdc-base-sepolia` to
  domain `USDC` version `2` on Base Sepolia (84532), whose USDC signs under that name. Amounts are in 6 decimals,
  `USDC`. **Fact** (read on chain on 2026-10-30): each contract's `DOMAIN_SEPARATOR()`, `decimals()` and three type
  hashes. **Fact** (EIP-3009; Circle's `EIP3009.sol` at `fc85788`): a signature is valid only after `validAfter` and
  before `validBefore`, both strictly, so the text reads "Valid after" and "Expires", and only the payee may submit a
  `ReceiveWithAuthorization`. USDC's ABI names each of its four signature functions twice, so the profiles describe
  the messages only (O1). x402's `exact` scheme pays by `TransferWithAuthorization` by default (**Fact**:
  `coinbase/x402` at `0e6e8c5`, `specs/schemes/exact/scheme_exact_evm.md`).
- [`packs/x402-exact-permit2.profile.json`](../packs/x402-exact-permit2.profile.json), a contract profile (D-058):
  x402's `exact` payment through Permit2, the `PermitWitnessTransferFrom` with x402's witness `Witness(address
  to,uint256 validAfter)` (type hash `0xebc156cd23678a74c94df13d772ef5478420637f0c94bd10d509e1dc98f521c7`), bound to
  Permit2's domain and deployments. Its spender is pinned (`fixed`, §15.4) to x402's proxy,
  `0x402085c248EeA27D92E8b30b2C58ed07f9E20001`, and its grant pays `witness.to`. **Fact** (`coinbase/x402` at
  `0e6e8c5`, `contracts/evm/src/x402BasePermit2Proxy.sol` and `x402ExactPermit2Proxy.sol`): the proxy's `settle`
  sends exactly `permitted.amount` to `witness.to` and reverts while the block's time is before `validAfter`, so the
  text reads "Usable from". **Fact** (read on chain on 2026-10-30): the proxy has the same code on the four chains,
  and its `PERMIT2()` is Permit2. x402's `upto` scheme signs another witness, so another type hash, and matches
  nothing.

The type hashes of the ten standard messages, EIP-712's `Mail` type hash and digest, the consent goldens' digests and
the exported files' `descriptorHash`es were recomputed by an independent Python EIP-712 and Keccak-256 (the phase 1
cross-check tool). USDC's three type hashes and the type hash of x402's `Witness` equal the contracts' own constants,
read on chain; x402's example EIP-3009 signature and two real x402 Permit2 payments on Base Sepolia recover to their
signers over the digests the consent package computes (**Fact**, the `ecrecover` precompile through `eth_call`,
2026-10-30).

#### Open items

- **O9.** Permit2 witness messages (`PermitWitnessTransferFrom` with a protocol's own witness type). Each needs its
  own profile, which pins the protocol's settlement contract as the spender (`fixed`, §15.4) when the witness names
  where the tokens go. x402's `exact` payment has one (D-058); a request with any other witness matches nothing and
  gets no text.
- **O10.** Permit2's deployments beyond chains 1, 8453, 42161 and 84532: its address is the same on many chains, and
  each is added after checking Uniswap's list and the chain itself, never assumed.
- **O11.** Domains with a `salt`, and contracts whose domain name or version changes after deployment: refused for
  now.
- **O12.** DAI's `allowed` bool reads through its template ("to all of it if allowed is true, to none if false");
  a case-like reading of `true` and `false` would need D-053 for `bool`.
- **O13.** The signer against an `owner` or `holder` member: whether the text should say so, or refuse, when they
  differ. **Open:** the consent function does not take the signer yet.
- **O14.** Permits that differ from EIP-2612 by a member match nothing and get no text; a pack per variant is added
  only when one is seen.
