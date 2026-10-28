Envelopes written by `candid-core-cli gen` (`@candid-core/cli` 0.3.0) from `../ledger.did` and
`examples/tokens.did`; the `.ts` modules it writes beside them are not kept. Regenerate with
`node_modules/.bin/candid-core-cli gen <file.did> -o <this dir>` after a cli bump. `test/envelope.test.mjs`
checks that the resolver gives the same resolved form from each envelope as from its `.did`.
