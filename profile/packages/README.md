# packages/

npm workspaces, one directory per package. The five library packages publish to npm under the `@meantjs` scope and
release together under one version, pinning each other exactly. Each package keeps its tests in `test/*.test.mjs`,
which the root `npm test` runs.

| Directory | Package |
|---|---|
| `resolver/` | `@meantjs/profile` |
| `format/` | `@meantjs/format` |
| `consent/` | `@meantjs/consent` |
| `tools/` | `@meantjs/tools` |
| `reconcile/` | `@meantjs/reconcile` |

The library packages list what they ship in `files`, and `scripts/package-check/manifest.json` holds the exact file
list and exports of each tarball. `npm run pack:check` packs them, compares each tarball with the manifest, installs
the tarballs into a scratch project outside the repository, uses every export there and bundles each browser entry.
After adding, moving or removing a file of one of these packages, review the tarball and run
`node scripts/package-check/check.mjs --update`. Their types are hand-written `.d.mts` files next to the modules, and
`npm run types` compiles strict consumer programs against them. `docs/releasing.md` is the release procedure.
