# Changelog: @meantjs/profile

The five Candid Profile library packages (`@meantjs/profile`, `/format`, `/consent`, `/tools`, `/reconcile`) release together under one version and pin each other exactly; a version appears here even when this package did not change. Release steps: `docs/releasing.md` in the repository.

## 0.1.0 (unreleased)

First published version.

Published under the `@meantjs` scope (D-051). Before any release, this package was `@candid-core/profile`.

- Validates Candid Profile v0 documents against the schema and the service's Candid interface, matches packs by Candid
  subtyping (with the result-variant relaxation), merges layers by precedence and emits the resolved form
  (`resolveService`, `validateProfile`, `matchPack`).
- Takes the service as `.did` source (compiled with `@candid-core/cli` 0.4.0) or as its candid-core `ContractEnvelope`.
- Ships the profile schema and the ICRC-1 and ICRC-2 packs as data (`./schema.json`, `./packs/*`); the Node entry's
  defaults (`createSchemaValidator()`, `loadPacks()`, `candid-profile resolve --packs`) read these copies.
- Entries: `.` (Node), `./browser` (no Node built-in), `./address` (the address grammar, no dependency), and the
  `candid-profile` CLI.
- TypeScript declarations for every entry.
- Names (spec §5.3, D-045): the experimental `names` and `named` tags and their checks (six errors and
  `W_NAMED_UNPATTERNED`).
- Doc annotations (spec §9, proposal `docs/proposals/w1-doc-attributes.md`): `profileFromDocAttributes` turns the tags
  an author writes as `.did` doc comments, as candid-core's `didToDocAttributes` reads them, into an `author` canister
  profile. `DOC_ATTRIBUTES_VERSION` is the doc attributes version it reads (1). It needs a `@candid-core/cli` release
  after 0.3.0 to be fed from `.did` text.
- The shipped schema is compiled ahead of time (`data/profile-v0.validate.mjs`, ajv's standalone code), so
  `createSchemaValidator()` on it generates no code at run time: a page needs no CSP `'unsafe-eval'` (the cli's wasm
  needs `'wasm-unsafe-eval'`). Its answers equal ajv's run-time compile on every profile in the repository and tens of
  thousands of mutations of them. Another schema document is still compiled at run time, and ajv is loaded only then.
  Each validator keeps its own `errors`. The browser bundle grows from 189.5 KB to 265.6 KB minified.
- Served profiles (spec §8.1, D-048): `readServedProfile(bytes, { canisterId })` checks the bytes a canister serves
  as `icp:public candid:profile` (`E_SERVED` for anything but UTF-8 JSON of an `author` canister profile, at most
  1 MiB, bound to that canister or to none); `SERVED_SECTION`, `SERVED_METADATA` and `SERVED_MAX_BYTES` name the
  section, its metadata path and its limit. In both entries.
- An `outcome` may give `default` alone (spec §5.3, D-049): the class of every reply of a method whose result has no
  variant to select. The schema needs `classes` or `default`; on a result that reaches a variant, `default` alone
  leaves every case to the default (`W_OUTCOME_UNCLASSIFIED`, info).
