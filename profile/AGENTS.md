# AGENTS.md

Instructions for any coding agent (Claude Code, Codex, others) working in `profile/`, the Candid Profile spec and the
`@meantjs` packages. Humans: see `README.md`. Run every command below from this folder.

## Commands

```sh
npm ci                # Node >= 22; installs @candid-core/cli (wasm), ajv and TypeScript, pinned exactly
npm run validate      # JSON Schema + semantic checks: packs/*.profile.json and examples/
npm test              # node:test over scripts/*.test.mjs and packages/*/test/*.test.mjs
npm run fixtures      # regenerate fixtures/*.resolved.json and packages/resolver/data/ after any spec, pack, example or validator change
npm run types         # compile strict TypeScript consumers against the library packages' hand-written .d.mts
npm run pack:check    # pack the five library packages, install the tarballs outside the repo, use and bundle them (needs the npm registry)
```

Before you finish any change, run `npm run validate && npm test`. Both must pass. If you changed packs, examples or the
validator, also run `npm run fixtures` and commit the result. If you added, moved or removed a file of a library
package, or changed its exports or its `.d.mts` types, run `npm run types && npm run pack:check`.

## Ground rules

1. **The spec is the source of truth.** A change to a tag, an address rule or a behavior updates
   `docs/profile-v0.md`, `spec/profile-v0.schema.json`, the resolver and the tests in the same change.
2. **Fixtures are generated.** Never hand-edit `fixtures/*.resolved.json` or `packages/resolver/data/`; regenerate them
   with `npm run fixtures`.
3. **Pin dependencies exactly** (`npm install --save-exact`).
4. **No silent rounding.** Code that converts values rejects excess precision rather than round (spec section 5.3).
5. **Label claims** in docs as facts (with a source or an observation), assumptions or open questions.
6. **This folder is a copy** of the project's working repository (README, "How this folder is made"), and so are
   `.github/workflows/profile-ci.yml` and `npm-release-profile.yml`. A maintainer applies accepted pull requests
   there, and the next update brings them back; a change made only here is undone by it.
