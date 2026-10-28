# Changelog: @meantjs/tools

The five Candid Profile library packages (`@meantjs/profile`, `/format`, `/consent`, `/tools`, `/reconcile`) release together under one version and pin each other exactly; a version appears here even when this package did not change. Release steps: `docs/releasing.md` in the repository.

## 0.1.0 — 2026-10-28

First published version.

Published under the `@meantjs` scope (D-051). Before any release, this package was `@candid-core/profile-tools`.

- Named inputs (spec §5.3, D-045): where a profile tags a position `named`, a tool takes a name of that set as well as
  a value. The layer reads the set from the canister when the call is prepared (once per intent), resolves the name
  by `resolveName` (`E_NAME_NOT_FOUND`, `E_NAME_AMBIGUOUS`, `E_NAMES_UNREAD`), treats a name and the value it stands
  for as one intent, and shows the name beside the value in previews. `nameEntries` reads a set's entries from a reply of the method
  that lists it, as the layer does.
- Agent tools from any resolved form: one tool per query method, `prepare_<method>` per update method and `commit`,
  with MCP tool definitions (`toolDefinitions`) and exact input reading in human units (`readToolInput`).
- `createToolLayer`: a confirmation hook awaited before every send, an injected encoder, call and clock, idempotent
  commits, classified outcomes and an optional reconcile hook after an unknown outcome.
- No Node built-in: runs in browsers. `displayValue` shows bytes from another realm as it shows this realm's.
- A `principal` position with no value tag is an input in its textual form (checksum checked, canonical text out),
  so a method that takes a principal gets a tool instead of being skipped.
- Interfaces beyond the ICRC packs (B2 of `docs/proposals/w9-b3wallet-gaps.md`; the packs' tools do not change): an
  integer position with a `describe` and no value tag is an input of decimal digits; a read-only update
  (`replicated: true`) is a read tool sent as an update call; an update without `idempotency` gets a prepare tool and
  is never sent again after an unknown outcome; outcome keys may pass through record fields; a method with more than
  one argument takes each as an input (`arg0`, `arg1`, ...).
- `encode` gets a third argument and `call` a field, `args`: the whole argument tuple. Encode it; `value` stays the
  single argument (for a method with more than one, the tuple).
- A query or read-only update with no answer, or refused, says that nothing was read (it said to commit a preview).
- More readers (D-050, proposal `docs/proposals/w6-adoption.md` items 2 and 3): a `text` position is an input of the
  text as given, within its `text` tag (`max_len`, `pattern`, `format`) and `range` lengths, and at most 1024
  characters without a tag; a pattern the layer will not run (over 256 characters, not valid with the `u` flag, a
  back reference, a lookaround, a repeated repeating group) skips the method with that reason. A `bool` position is
  `"true"` or `"false"`. A record, variant or `vec` that no value tag reads is one JSON input whose leaves are read by
  their own rules (`{ "tag": …, "value": … }` for a variant case; at most 256 elements in a `vec` and 4096 values in
  one input), with issue paths into it (`$args[0].command.Follow.followees[1].id`) and a matching JSON Schema. A lone
  `null` or `reserved` argument takes no input. An `outcome` with `default` alone classifies every reply of a method
  with any result. Methods skipped before may now get tools; the packs' tools do not change.
- TypeScript declarations.
