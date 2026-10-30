# @meantjs/profile

Validates Candid Profiles, matches packs to a service, merges layers and emits the resolved form that consumers read
(`docs/profile-v0.md` sections 7, 8 and 10). Dependencies, pinned exactly: `@candid-core/cli` 0.4.0 (wasm: `.did`
to Contract) and `ajv` 8.18.0.

```sh
npm install @meantjs/profile
```

- **Runs on:** Node 22 or later for the main entry and the `candid-profile` CLI. `@meantjs/profile/browser` is for
  browser bundles (checked with esbuild, and in Chromium under a CSP without `'unsafe-eval'`; the cli's wasm needs
  `'wasm-unsafe-eval'`, below). `@meantjs/profile/address` and `@meantjs/profile/evm` have no dependency and run
  anywhere.
- **Module format:** ES modules only, with hand-written TypeScript declarations for every entry.
- **Spec:** [Candid Profile v0](https://github.com/B3Pay/Meant/blob/main/profile/docs/profile-v0.md). **Licence:** Apache-2.0.
- **Versions:** the five Candid Profile packages (`@meantjs/profile`, `/format`, `/consent`, `/tools`,
  `/reconcile`) release together under one version and pin each other exactly; in 0.x a minor is breaking,
  and so is any change to generated text ([releasing](https://github.com/B3Pay/Meant/blob/main/profile/docs/releasing.md)).

```js
import { createSchemaValidator, resolveService, loadPacks, validateProfile } from "@meantjs/profile";

const validateSchema = await createSchemaValidator();                 // the schema this package ships
const packs = await loadPacks();                                      // the standard packs it ships (ERC-20, ICRC-1, ICRC-2)
const r = await resolveService({
  did: await readFile("ledger.did", "utf8"),
  validateSchema,
  profiles: [{ doc: authorProfile }],                                  // applied as given (a pack here must match)
  packs: packs.map(({ doc }) => ({ doc })),                            // tried; applied only if they match
});
r.ok; r.resolved; r.diagnostics; r.profiles;                           // r.resolved has the shape of fixtures/*.resolved.json
```

Two inputs, exactly one per call: `did` (Candid source, compiled here with the pinned cli) or `envelope` (the
service's candid-core `ContractEnvelope`, as `candid-core-cli gen` writes it next to a generated module). With an
envelope the service is not compiled again, so the resolved form's `interface_id` is the one the app's generator
wrote (`test/envelope.test.mjs`: the same resolved form for the ledger `.did` and `examples/tokens.did` either way).
The envelope's identities are taken as written (nothing here can recompute them, so a hand-edited envelope keeps an
id that no longer describes it). Its graph is checked before anything walks it: every reference, the fields each
node kind needs, methods that name funcs, an actor, no opt that contains only itself, and the field-names table (it
must be there, and each name must hash to its field's id). One that fails is an `E_ENVELOPE` error with
`resolved: null`, and anything the checks still miss is reported the same way rather than thrown. Packs still compile their `binds.requires`, so the cli stays a
dependency. CLI: `candid-profile resolve --envelope app.envelope.json --packs`.

The defaults are the data the package ships (`data/`), so they work wherever it is installed. The same data is
exported for passing as documents:

```js
import schema from "@meantjs/profile/schema.json" with { type: "json" };          // copy of spec/profile-v0.schema.json
import icrc1 from "@meantjs/profile/packs/icrc1.profile.json" with { type: "json" };
const validateSchema = await createSchemaValidator(schema);                            // a document, not a path
const r = await resolveService({ did, validateSchema, packs: [{ doc: icrc1 }] });
```

`data/` is generated from the repository's `spec/` and `packs/` by `npm run data -w packages/resolver` (part of
`npm run fixtures`); `test/data.test.mjs` fails when it is stale. `@meantjs/profile/address` (`parseRelPath`, `parseAddress`, `idlHash`, `U32_MAX`) imports
nothing outside its own two modules, so a browser bundle may use it; the main entry loads Node built-ins, ajv and the
cli wasm.

`@meantjs/profile/browser` is the whole resolver for a browser bundle: the main entry's functions without the
ones that read files (`loadPacks`, the CLI, the default paths), plus the shipped data and the cli's wasm loader.

```js
import { createSchemaValidator, resolveService, STANDARD_PACKS, initCompiler } from "@meantjs/profile/browser";

await initCompiler(wasmUrl);                         // optional: only when the bundler moves candid_core_wasm_bg.wasm
const validateSchema = await createSchemaValidator(); // the shipped schema; a document, never a path
const r = await resolveService({ did, validateSchema, profiles: [{ doc }], packs: STANDARD_PACKS.map(({ doc }) => ({ doc })) });
```

Types: `src/index.d.mts`, `src/address.d.mts` and `src/browser.d.mts` (hand-written, each the `types` condition of
its entry; `scripts/types.test.mjs` keeps their names equal to the runtime exports, and `npm run types` compiles strict
consumers against them). `profileId` hashes with a plain-JavaScript SHA-256 (`src/sha256.mjs`, synchronous, compared with node:crypto in the
tests), so neither entry needs node:crypto.

**Content-Security-Policy.** The shipped schema is compiled ahead of time (`data/profile-v0.validate.mjs`, ajv's
standalone code, generated by `npm run data` and checked by `test/data.test.mjs`), so `createSchemaValidator()` on it,
or on any document equal to it, generates no code at run time: a page needs no `'unsafe-eval'`. The cli's wasm needs
`'wasm-unsafe-eval'` in `script-src`. Only another schema document is compiled by ajv at run time, with `new
Function`, and needs `'unsafe-eval'`. `test/csp.test.mjs` checks both: on Node with code generation from strings
disabled, and in Chromium under `script-src 'self' 'wasm-unsafe-eval'` (skipped without a Chrome or Chromium; set
`CHROME_PATH`).
`test/browser-entry.test.mjs` bundles the entry for the browser and fails on any `node:*` import or Node global
(the cli is left out of that bundle: it is its own published package, and it reads its wasm with a guarded
`import("node:fs/promises")` only on Node), checks the data against `data/`, and resolves `examples/` both ways.

`validateProfile(doc, { validateSchema, did, resolved })` is the single-profile validator (what `scripts/validate.mjs`
wraps). Source map: `iface.mjs` (Contract graph), `address.mjs`, `tags.mjs` (`TagIndex`, `LayeredTags`), `checks.mjs`,
`analyze.mjs` (index, merge, per-annotation checks), `doc-annotations.mjs`, `resolved.mjs`, `subtype.mjs`, `pack-match.mjs` (and `packs.mjs`,
which reads a directory), `schema-core.mjs` (and `schema.mjs`, which reads a path), `resolve.mjs`, `validate.mjs`,
`browser.mjs`.

## Doc annotations (spec section 9)

An author can write the tags in the `.did` itself, as doc comments. candid-core reads them (doc attributes v1: one
`@name(key = value, ...)` syntax, malformed lines refused, each attribute handed out with the SourceInfo path of the
item it documents), and `profileFromDocAttributes` turns them into an `author` canister profile bound to the
interface's `interface_id`:

```candid
type Tokens = record {
  /// @amount(decimals = 8, symbol = "ICP")
  e8s : nat64;
};
service : {
  decimals : () -> (nat8) query;
  /// Send tokens to another principal.
  /// @intent(title = "Send", template = "Send {amount} to {to}")
  /// @amount(at = "amount", decimals = query(decimals))
  send : (record { to : principal; amount : nat }) -> (variant { Ok : nat; Err : text });
}
```

```js
import { didToDocAttributes } from "@candid-core/cli"; // a release after 0.3.0: 0.3.0 does not have it
import { profileFromDocAttributes, resolveService } from "@meantjs/profile";

const { ok, doc, diagnostics } = profileFromDocAttributes(await didToDocAttributes(did), { name: "my-ledger" });
const r = await resolveService({ did, validateSchema, profiles: doc ? [{ doc }] : [] });
```

- Method docs: method tags (`intent`, `effect`, `idempotency`, `outcome`, `list`, `names`) apply to the method. Value
  tags need `at`: `at = "amount"` for the arguments, `at = "->(0).Ok"` for the results, starting with `(i)` when the
  tuple has more than one element. `@describe` without `at` describes the method.
- Declaration and field docs: `type:<Decl>` and `type:<Decl>.<field>`. A field of an inline actor type becomes a method
  address (`inline(0).items[].price`): the method is found by its SourceInfo path, an `opt` adds nothing and a `vec`
  adds `[]` (OQ-4). `at` reaches further inside (`@bytes(at = "subaccount", encoding = "hex")` on an account field).
- Values: text, numbers (whole only, kept exact; past 2^53 or for `range` bounds a decimal string), `true`/`false`,
  identifiers as text (`unit = ns`), `query(m)`, `now()`, `caller()`, lists and records
  (`classes = { Ok = success, "Err.TooOld" = fix_input }`).
- Prose becomes `describe.help` (lines joined, paragraphs kept), except on an integer the same doc gives no value tag:
  a described integer is an agent input of plain digits (D-044), so that prose is reported (`I_DOC_PROSE`) instead.
- Only bare names that are profile tags are read. A dotted name (`@ui.hidden`) is another tool's; any other bare name
  is left alone, with a warning when it is one or two letters from a tag (`@amout`).
- Errors (the profile is still returned with what could be placed): `E_DOC_TARGET` (a tag no v0 address reaches, such
  as inside a func value or a callback service, or one in the wrong place), `E_DOC_VALUE` (a fraction, an unknown
  call), `E_DOC_SYNTAX` (candid-core refused the comment), `E_DOC_INPUT` (not a doc attributes v1 response). Each
  names the item's address, its SourceInfo `path` and `source`, and the doc line.

`didToDocAttributes` is new in the pinned `@candid-core/cli` 0.4.0; the tests read real responses it wrote
(`test/fixtures/doc-attributes/`, provenance in its `SOURCE.json`, regenerated with
`node scripts/doc-attributes-fixtures.mjs`, or with `--cli <path>` for a local build of candid-core's npm package). The proposal is `docs/proposals/w1-doc-attributes.md`.

## Served profiles (spec section 8.1, D-048)

A canister serves its profile as the public custom section `icp:public candid:profile`. Reading the bytes is the
consumer's job (one certified `read_state` of `/canister/<id>/metadata/candid:service` and `.../candid:profile`;
the project's kit, not public yet, does it with `@icp-sdk/core`); this package checks what came back:

```js
import { readServedProfile, resolveService } from "@meantjs/profile";

const served = readServedProfile(profileBytes, { canisterId: "ryjl3-tyaaa-aaaaa-aaaba-cai" });
// served.ok: served.doc is the profile; otherwise served.diagnostics holds E_SERVED and nothing is applied
const r = await resolveService({ did: serviceText, profiles: served.ok ? [{ doc: served.doc }] : [] });
```

- `E_SERVED` (`at`: `candid:profile`, or `label`): not a `Uint8Array`, over 1 MiB (`SERVED_MAX_BYTES`), not UTF-8, a
  byte order mark, not JSON, not one object, a `kind` other than `canister`, an `origin` other than `author`, or a
  `binds.canister_id` that is not `canisterId`. `canisterId: null` skips that last check, for a module that is not
  installed yet (a module does not know the id it will run as); any other non-string throws.
- Binding is the resolver's usual rule (spec section 7): resolve against the `candid:service` the same canister
  serves, so a profile for another interface is `rebound` or `stale` as any other.
- Tests: `test/served.test.mjs`; end to end on PocketIC in the kit's tests, which are not public yet.

## EVM contracts (experimental, spec section 15, D-054 and D-055)

A third input, `abi`: an EVM contract's ABI as human-readable fragments or JSON ABI entries. The resolver reads it as
the graph a `.did` compiles to (a function is a method, its parameters one record at argument 0, a tuple a record in
ABI order), so addresses, tags, layers and the resolved form work unchanged; the resolved form says `"chain": "evm"`,
its nodes carry `abi` instead of `candid`, and each method has `selector`, `signature` and `state_mutability`.

```js
const r = await resolveService({ abi: ["function transfer(address dst, uint256 wad) returns (bool)", …], validateSchema, packs: (await loadPacks()).map(({ doc }) => ({ doc })) });
r.resolved.methods.transfer.tags.intent.args.template; // "Send {wad} to {dst}": the erc20 pack's, in this contract's names
```

- **Contract profiles** (`kind: "contract"`) carry their ABI in `binds.abi` and the contracts they describe in
  `binds.deployments` (EIP-55 checked: `E_ADDRESS_CHECKSUM`). **EVM packs** carry `binds.abi` and apply to a contract
  that has every one of their functions, by selector, output types and kind of call (no subtyping); their addresses
  and placeholders are rewritten to the contract's parameter names by position. A pack or profile for the other kind
  of interface is `E_CHAIN` when given, and skipped in a pack search, so `loadPacks()` serves both kinds.
- **EIP-712 messages** (spec §15.9, D-055): `binds.eip712: { domain?, types }` in a contract profile (with or without
  `binds.abi`) or an EVM pack. A type the same document tags with `intent` is a message, addressed like a function
  (`PermitSingle(0).details.amount`) and listed under the resolved form's `messages` with its `encode_type` and
  `type_hash`. `amount.token` names an amount's token by an `address` field (`E_TOKEN_PATH` otherwise). Bad types, a
  message named like a function and two meanings for one type name are `E_EIP712`. Standard files: the `erc2612`
  pack, and the contract profiles `permit2`, `dai-permit`, `usdc`, `usdc-base-sepolia` and `x402-exact-permit2`
  shipped beside the packs (`@meantjs/profile/packs/permit2.profile.json`); `loadPacks()` returns the packs only.
- **Pins** (`fixed`, spec §15.4, D-058): an `address` in the arguments of a function or a message that the profile
  describes only with one value, as x402's Permit2 payment holds x402's proxy as its spender. A pin that does not hold
  (another place or type, a bad checksum, an address that does not resolve, another value pinned by any profile) is
  an error, and its profile then supplies only its effects, without grants, and its pins that hold.
- **Refused for now:** overloaded function names and unreadable fragments (`E_ABI`); `idempotency`, `outcome`, `list`,
  `names` and `named` on a contract (`E_TAG_TARGET`); `account` and `subaccount` (`E_TAG_NOT_APPLICABLE`); `[ ]`
  template segments (`E_TEMPLATE`).
- **`@meantjs/profile/evm`** is the toolkit underneath, browser-safe and without dependencies: `keccak256`, `parseAbi`,
  `parseSignature`, `canonicalFragment`, `selectorOf`, `abiInterfaceId`, a strict codec (`encodeParams`, `encodeCall`,
  `decodeParams`: a value read from anything but its canonical encoding is refused), `toChecksumAddress`,
  `readAddress`, `typedDataDigest` (EIP-712), `encodeType`, `eip712TypeHash` and `parseEip712Types`.
  `test/evm.test.mjs` checks Keccak against an independent implementation (and the block boundary), the ERC-20
  selectors, the ERC-8176 schema UID, EIP-55's examples and EIP-712's Mail example; `test/eip712.test.mjs` the type
  hashes of the standard messages (DAI's equals `dai.sol`'s constant).

## CLI

```sh
node packages/resolver/bin/candid-profile.mjs resolve <service.did> [--profile p.json ...] [--packs] [--packs-dir dir] [--verbose] [--quiet] > resolved.json
node packages/resolver/bin/candid-profile.mjs resolve --abi contract.abi.json [--profile p.json ...] [--packs]   # an EVM contract (section 15)
# after `npm ci` the bin is also linked: npx candid-profile resolve ...
```

- `--profile` may repeat; a pack given this way must match (`E_PACK_NOT_MATCHED` otherwise).
- `--packs` tries every standard pack this package ships (or every pack in `--packs-dir`) and applies those that match; the others get `I_PACK_NOT_MATCHED` (info).
- stdout: the resolved form (also when diagnostics contain errors, as long as the `.did` compiles). stderr: applied profiles, counts, warnings and errors (`--verbose`: infos too).
- Exit code 0: no error diagnostic. 1: at least one. 2: usage or I/O.
- A `.did` with `import` is not followed yet; give the CLI a single file.

Real input: `test/fixtures/ledger.did`, the ICRC ledger `.did` of release `ledger-suite-icrc-2026-03-09`, the file the eval harness pins
(sha256 and URL in `test/fixtures/SOURCES.json`). `candid-profile resolve test/fixtures/ledger.did --packs` applies `icrc1` and `icrc2`,
with 0 errors, 0 warnings and 3 infos (two matches, and the `int16` `utc_offset_minutes` of ICRC-21 that no profile tags).

## Merge (spec section 8)

Layers, highest first: `author`, `third_party`, `pack`, `inferred`. One `TagIndex` per layer.

- The first layer that has a tag at a position supplies it; the same tag lower down is dropped with `W_OVERRIDDEN`.
- Within a layer (also across several profiles of that layer): method position beats a `type:` edge beats a whole-declaration
  tag. Two different values at one specificity: `E_CONFLICT`, the first one given stays. Equal values: `W_DUPLICATE`.
- Layer decides before specificity.
- `profiles` in the resolved form lists every applied profile, highest layer first. Each tag carries `origin` and `profile`.
- A stale canister profile (spec section 7) keeps its non-conversion tags but loses `amount`, `timestamp`, `duration`,
  `account`, `subaccount`, `bytes` in the output.

## Pack matching and Candid subtyping (spec section 7, D-005, D-019)

A pack applies when the service is a **subtype** of the Candid fragment in `binds.requires`, with result variants allowed to be wider.

### Was an existing checker usable? No.

| Candidate | Finding (2026-10-09) |
|---|---|
| `@dfinity/didc` 0.0.4 (wasm of the Rust candid crates) | Exports `start`, `getServiceMethods`, `encode`, `decode` only. The subtype code is linked in (it backs `decode`) but there is no entry point that compares two services. |
| `@candid-core/cli` 0.2.0 (surveyed 2026-10-09; 0.3.0 since D-037 adds `projectDid` and `checkCompatible`, not surveyed) | Exports `init`, `didToContract`, `didToModule`. No compatibility check. |
| candid-core compatibility (b3hr4d/candid-core#247) | An open issue ("Interface projection and a live-compatibility check over written .did files"), not code. Its acceptance criteria ask for the same relation as here plus differential tests against upstream `candid`. |
| `@candid-core/schema` 0.3.0 (surveyed 2026-10-09) `wireSubtypeOfSchema` | An internal method of the binary decoder (not an export): it relates a wire type table to a runtime schema, not two Contracts. Read as a second opinion on the rules. |
| Rust `didc` 0.5.4 (binary from the local cargo bin; its linked candid revision was not determined) and the source of candid 0.10.37 (newest in the local cargo registry) | `didc check` is the oracle for the differential tests (below); the 0.10.37 `src/types/subtype.rs` was read for the rules. Neither is a runtime dependency. |

So `src/subtype.mjs` implements the relation over two candid-core Contract graphs (`Iface`), one per side, since a canister and a pack fragment are compiled separately.

### Rules implemented

Source: Candid specification, "Upgrading and Subtyping > Rules" (https://github.com/dfinity/candid/blob/c7659ca/spec/Candid.md, the revision the Rust crate links to). `S <: T` means S can be used where T is expected.

| Spec subsection | Rule as implemented |
|---|---|
| Primitive Types | `t <: t`; `nat <: int`; `any <: reserved`; `empty <: any` |
| Vectors | `vec S <: vec T` if `S <: T` (`blob` is `vec nat8`) |
| Options | `opt S <: opt T` if `S <: T`; `null <: opt T`; `S <: opt T` if `S <: T` and T is not null, reserved or opt |
| Options, "unusual rules" | **Off by default** (`lossyOpt`). They make `opt S <: opt T` hold for unrelated S and T (the value decodes as null). The spec says they exist for transitivity and that tools should warn when used; for pack matching they would accept `fee : opt text` against a pack that says `opt nat`. With `lossyOpt: true` they are implemented as "always true" |
| Records | `record S <: record T` if every field of T is in S with a subtype, or is absent from S and its type is opt, null or reserved. Extra fields in S are ignored. Fields compare by id |
| Variants | `variant S <: variant T` if every case of S is in T with a subtype (S may have fewer cases) |
| Functions | `func S <: func T` if the annotations are equal, `tuple(T.args) <: tuple(S.args)` (contravariant) and `tuple(S.results) <: tuple(T.results)` (covariant); tuples follow the record rule over positions 0, 1, ... |
| Services | `service S <: service T` if every method of T is in S with a function subtype. Extra methods ignored; init args of a class ignored |
| (coinduction) | A pair met again while it is being decided is assumed true, so recursive types terminate |
| (bounds, profile spec section 11.6) | Depth 256 and 2,000,000 pair evaluations; beyond that the answer is "not a subtype" |

**D-019 relaxation.** For a variant reached through a method *result*, extra cases in the canister are allowed. "Reached through" is
a descent from the result by record fields, `opt`, `vec` and variant payloads, with covariant polarity. Entering a `func` or `service`
type resets to strict. Argument positions are always strict. The matcher reports every relaxed position
(`I_PACK_MATCHED` message and `matchPack(...).relaxed`).

**Not implemented, on purpose:** the Rust crate's catch-all that accepts `S <: opt T` for any S with only a warning (it is not a rule of the spec);
`service <: principal` (not in this revision of the spec; the Rust crate has it).

### Verification

- **Facts (run 2026-10-09):** `test/subtype.test.mjs` holds 41 service pairs, each with the answer of the Rust `didc check` 0.5.4 and of the spec rules. With `lossyOpt: true` the checker answers like Rust on all 41; with it off it differs on exactly the 3 rows that need the unusual opt rules. A seeded differential test (250 random pairs, in the repository) runs when `didc` is installed and checks: never more permissive than `didc`, and identical to `didc` whenever `didc` does not report its special opt rule. Scratch runs during development (about 7,400 further random pairs; the "never more permissive" check on 2,800 of them) found no violation. In those runs `didc` used its special opt rule on about 13% of the pairs; where it accepted through that rule, this checker with `lossyOpt: true` also accepted in about 87% of the cases (the rest need the Rust catch-all, which is not a spec rule).
- **Label: assumption.** Rust `didc` and the spec could both be wrong in a way that this checker repeats. The candid-core decoder (`wireSubtypeOfSchema`) was read for the same rules but not run against this checker.
- **Open:** a Candid corner we did not exercise is `service <: principal` and quoted method names (OQ-3).

### What happens after a match

A matched pack is applied to the **service's** types (addresses resolve against the service). Subtyping lets the service differ from the
fragment, so some annotations may name a position the service does not have, or have a shape a tag no longer fits. These are dropped with
`I_PACK_ANNOTATION_SKIPPED` instead of being reported as errors in the pack: an address that is gone (a result case the service removed,
an optional field it lacks), an `outcome` key that is not a case, a template placeholder inside an optional segment that is absent (the
segment renders empty), a tag that does not apply to the service's type (for example `account` on a record with an extra optional field),
and an `idempotency` whose stamp lost its `timestamp` tag. A placeholder outside an optional segment that cannot be resolved is dropped with its `intent`.
