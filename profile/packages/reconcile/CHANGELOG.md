# Changelog: @meantjs/reconcile

The five Candid Profile library packages (`@meantjs/profile`, `/format`, `/consent`, `/tools`, `/reconcile`) release together under one version and pin each other exactly; a version appears here even when this package did not change. Release steps: `docs/releasing.md` in the repository.

## 0.3.0 — 2026-10-29

No changes in this package.

## 0.2.0 — 2026-10-28

No changes in this package.

## 0.1.0 — 2026-10-28

First published version.

Published under the `@meantjs` scope (D-051). Before any release, this package was `@candid-core/profile-reconcile`.

- After an unknown outcome, the ICRC-3 block an ICRC-1/2 write leaves (`expectedTransaction`) and whether the blocks
  read since the first send hold it: found, absent, not yet, or unreadable with a lookalike (`matchBlocks`). Every
  rule errs on the safe side: never "absent" while a send may still land.
- No transport and no Node built-in: runs in browsers.
- TypeScript declarations.
