#!/usr/bin/env node
// Writes the two files the canister embeds, from icp-mcp.did and icp-mcp.profile.json (D-061):
//   icp-mcp.resolved.json  the resolved form (spec section 10), which the canister's ICRC-21 replies are rendered from
//   api-doc.md             the reply of get_api_doc (spec section 8.2), rendered from that resolved form
// The canister also embeds icp-mcp.did and icp-mcp.profile.json themselves, as its candid:service and candid:profile
// custom sections. scripts/icp-mcp-example.test.mjs checks that the committed files are what this writes.
//
//   node examples/icp-mcp/build.mjs           # write
//   node examples/icp-mcp/build.mjs --check   # exit 1 when a committed file differs

import { readFile, writeFile } from "node:fs/promises";
import { createSchemaValidator, renderApiDoc, resolveService } from "../../packages/resolver/src/index.mjs";

const here = (f) => new URL(f, import.meta.url);
/** The token's own decimals and symbol are literals in its profile; it has no dynamic refs. */
export const REFS = Object.freeze({});
export const TITLE = "TOK, an example token ready for ICP MCP";

export async function build() {
  const did = await readFile(here("icp-mcp.did"), "utf8");
  const profile = JSON.parse(await readFile(here("icp-mcp.profile.json"), "utf8"));
  const r = await resolveService({ did, didLabel: "icp-mcp.did", validateSchema: await createSchemaValidator(), profiles: [{ doc: profile }], packs: [] });
  if (!r.ok) throw new Error(`icp-mcp: the profile has errors: ${JSON.stringify(r.diagnostics.filter((d) => d.severity === "error"))}`);
  return {
    "icp-mcp.resolved.json": `${JSON.stringify(r.resolved, null, 2)}\n`,
    "api-doc.md": renderApiDoc(r.resolved, { refs: REFS, title: TITLE }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = await build();
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [name, text] of Object.entries(files)) {
    if (check) {
      const old = await readFile(here(name), "utf8").catch(() => null);
      if (old !== text) { console.error(`icp-mcp: ${name} is not what build.mjs writes`); stale++; }
    } else {
      await writeFile(here(name), text);
      console.log(`wrote examples/icp-mcp/${name}`);
    }
  }
  process.exitCode = stale ? 1 : 0;
}
