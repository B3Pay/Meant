#!/usr/bin/env node
// The `/.well-known/ic-architecture` manifest of an app built on this canister (DFINITY's service discoverability
// guide, layer 1): publishing it at the app's origin opts the app into ICP MCP. Canister ids differ per network, so it
// is written at deploy time:
//
//   node examples/icp-mcp/manifest.mjs <canister id> > dist/.well-known/ic-architecture
//
// Serve it as a static file with `Content-Type: application/json`, not rewritten to index.html.

const PRINCIPAL = /^[a-z2-7]{5}(-[a-z2-7]{5})*(-[a-z2-7]{1,5})?$/;

export function manifest(canisterId) {
  if (typeof canisterId !== "string" || !PRINCIPAL.test(canisterId)) throw new TypeError(`manifest: ${JSON.stringify(canisterId)} is not a canister id`);
  return {
    version: "1.0.0",
    canisters: [
      {
        id: canisterId,
        name: "tok",
        role: "the token",
        description: "Call get_api_doc first. Ask the person before any send; icrc21_canister_call_consent_message says what a send does.",
      },
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.stdout.write(`${JSON.stringify(manifest(process.argv[2]), null, 2)}\n`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}
