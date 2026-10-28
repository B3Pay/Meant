#!/usr/bin/env node
// Render an SNS generic-function payload from a profile, or check a proposal's stored rendering against it.
//
//   npm run sns -w packages/consent -- --did <service.did> [--profile <p.json> ...] [--packs] --method <name>
//       (--payload <hex> | --payload-file <file>) [--ref <from>=<value> ...]
//       [--verify <payload_text_rendering file> --target <canister id>]
//
// Without --verify: prints the validator's text (exit 0) or its Err (exit 1).
// With --verify: the file holds the proposal's `payload_text_rendering` as `get_proposal` returns it, and --target is
// the canister the profile describes (the one governance must call); prints each check and exits 1 if any fails.
// `get_proposal` returns the payload only up to 64 bytes, so the payload bytes come from the proposer (--payload-file
// reads raw bytes; --payload takes hex).
// --ref values are numbers when they are all digits, else text: --ref query:icrc1_decimals=8 --ref query:icrc1_symbol=TKA
// Reads local files only; no network.

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createSchemaValidator, loadPacks, resolveService } from "@meantjs/profile";
import { snsValidatorRendering, verifySnsRendering } from "../src/sns.mjs";

const usage = "usage: sns-render --did <service.did> [--profile <p.json> ...] [--packs] --method <name> (--payload <hex> | --payload-file <file>) [--ref <from>=<value> ...] [--verify <file> --target <canister id>]";

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      did: { type: "string" },
      profile: { type: "string", multiple: true, default: [] },
      packs: { type: "boolean", default: false },
      method: { type: "string" },
      payload: { type: "string" },
      "payload-file": { type: "string" },
      ref: { type: "string", multiple: true, default: [] },
      verify: { type: "string" },
      target: { type: "string" },
    },
    strict: true,
  });
  if (!values.did || !values.method || (values.payload === undefined) === (values["payload-file"] === undefined)) return fail(usage);
  if (values.verify !== undefined && values.target === undefined) return fail(`--verify needs --target <canister id>, the canister the profile describes\n${usage}`);

  const payload = values.payload !== undefined ? hexBytes(values.payload) : new Uint8Array(await readFile(values["payload-file"]));
  if (payload === null) return fail("--payload must be hex (an optional 0x prefix, an even number of digits)");
  const refs = {};
  for (const r of values.ref) {
    const eq = r.indexOf("=");
    if (eq <= 0) return fail(`--ref ${r}: expected <from>=<value>`);
    const value = r.slice(eq + 1);
    refs[r.slice(0, eq)] = /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : value;
  }

  const did = await readFile(values.did, "utf8");
  const profiles = await Promise.all(values.profile.map(async (p) => ({ doc: JSON.parse(await readFile(p, "utf8")) })));
  const packs = values.packs ? (await loadPacks()).map(({ doc }) => ({ doc })) : [];
  const resolved = await resolveService({ did, validateSchema: await createSchemaValidator(), profiles, packs });
  const errors = resolved.diagnostics.filter((d) => d.severity === "error");
  if (!resolved.ok) return fail(`the profile does not resolve against the interface:\n${errors.map((d) => `  ${d.code} ${d.at}: ${d.message}`).join("\n")}`);

  if (values.verify === undefined) {
    const r = snsValidatorRendering({ payload, resolved: resolved.resolved, method: values.method, refs });
    if ("Err" in r) return fail(`Err: ${r.Err}`);
    process.stdout.write(`${r.Ok}\n`);
    return 0;
  }
  const r = verifySnsRendering({ payloadTextRendering: await readFile(values.verify, "utf8"), payload, resolved: resolved.resolved, targetCanisterId: values.target, method: values.method, refs });
  for (const c of r.checks) {
    const detail = [c.expected !== undefined ? `expected ${c.expected}` : "", c.found !== undefined ? `found ${c.found}` : "", c.note ?? ""].filter(Boolean).join("; ");
    process.stdout.write(`${c.ok ? "PASS" : "FAIL"} ${c.name}${detail ? `  (${detail})` : ""}\n`);
  }
  return r.ok ? 0 : 1;
}

function hexBytes(s) {
  const h = s.startsWith("0x") ? s.slice(2) : s;
  return /^(?:[0-9a-fA-F]{2})*$/.test(h) ? Uint8Array.from(Buffer.from(h, "hex")) : null;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  return 1;
}

process.exitCode = await main(process.argv.slice(2));
