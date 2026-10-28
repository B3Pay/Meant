# The example SNS validator on PocketIC

The example validator canister (`../rust/examples/sns_validator.rs`) registered with the real SNS governance canister on PocketIC. What it checks, what was observed and the versions: `../README.md`, section "On SNS governance".

```sh
npm ci      # here, after `npm ci` at the repository root
npm test    # fetch and sha256-check the pinned artifacts (artifacts.json), build both example canisters, run
```

Local only: no mainnet, no cycles bought, no keys. Downloads go to `.cache/` (git-ignored) and are refused unless their sha256 matches `artifacts.json`.
