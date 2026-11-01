/**
 * candid-profile resolve (<service.did> | --envelope <file> | --abi <file>) [--profile p.json ...] [--packs] [--packs-dir dir]
 * candid-profile api-doc (<service.did> | --envelope <file>) [--profile p.json ...] [--packs] [--ref from=value ...] [--title t]
 *
 * `resolve` prints the resolved form (docs/profile-v0.md section 10) on stdout and a summary on stderr; `api-doc` prints
 * the text of the canister's `get_api_doc` query, rendered from that resolved form (D-060).
 * Exit code: 0 when no diagnostic is an error, 1 when one is (the resolved form is still printed when the service
 * compiles), 2 for a usage or I/O problem.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createSchemaValidator } from "./schema.mjs";
import { DEFAULT_PACKS_DIR, loadPacks } from "./packs.mjs";
import { resolveService } from "./resolve.mjs";
import { ApiDocError, renderApiDoc } from "./api-doc.mjs";

export const USAGE = `usage: candid-profile resolve <service.did> [options] > resolved.json
       candid-profile resolve --envelope <file> [options] > resolved.json
       candid-profile resolve --abi <file> [options] > resolved.json
       candid-profile api-doc <service.did> [options] [--ref from=value ...] [--title text] > api-doc.md
       candid-profile api-doc --envelope <file> [options] [--ref ...] [--title text] > api-doc.md

  --envelope <file>   the service's candid-core ContractEnvelope (as \`candid-core-cli gen\` writes it), instead of
                      compiling a .did here
  --abi <file>        an EVM contract's ABI, a JSON array of human-readable fragments or JSON ABI entries
                      (experimental, spec section 15)
  --profile <file>    a profile to apply (repeatable). A pack given this way must match the service.
  --packs             try every pack in the packs directory; apply those that match
  --packs-dir <dir>   packs directory (default: the standard packs this package ships)
  --ref <from>=<val>  api-doc only: the value of a dynamic reference, as JSON or else as text
                      (--ref query:icrc1_decimals=8 --ref query:icrc1_symbol=ICP); repeatable
  --title <text>      api-doc only: the guide's heading (default "API guide")
  --verbose           also list info diagnostics on stderr
  --quiet             no summary on stderr
  -h, --help          this text
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { did: null, envelope: null, abi: null, profiles: [], refs: {}, title: undefined, packs: false, packsDir: DEFAULT_PACKS_DIR, verbose: false, quiet: false, help: false };
  const args = [...argv];
  const value = (name, inline) => {
    if (inline !== undefined) return inline;
    const v = args.shift();
    if (v === undefined || v.startsWith("--")) throw new UsageError(`${name} needs a value`);
    return v;
  };
  while (args.length) {
    const a = args.shift();
    const [flag, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    if (flag === "--profile") opts.profiles.push(value(flag, inline));
    else if (flag === "--envelope") opts.envelope = value(flag, inline);
    else if (flag === "--abi") opts.abi = value(flag, inline);
    else if (flag === "--packs") opts.packs = true;
    else if (flag === "--ref") {
      const pair = value(flag, inline);
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new UsageError(`--ref needs <from>=<value>, not ${pair}`);
      const from = pair.slice(0, eq);
      const raw = pair.slice(eq + 1);
      if (Object.hasOwn(opts.refs, from)) throw new UsageError(`--ref ${from} is given twice`);
      let v;
      try { v = JSON.parse(raw); } catch { v = raw; }
      opts.refs[from] = v;
    }
    else if (flag === "--title") opts.title = value(flag, inline);
    else if (flag === "--packs-dir") opts.packsDir = value(flag, inline);
    else if (flag === "--verbose") opts.verbose = true;
    else if (flag === "--quiet") opts.quiet = true;
    else if (flag === "-h" || flag === "--help") opts.help = true;
    else if (a.startsWith("-")) throw new UsageError(`unknown option ${a}`);
    else if (opts.did === null) opts.did = a;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  return opts;
}

async function readJsonFile(file, what) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (e) {
    throw new UsageError(`cannot read ${what} ${file}: ${e.message}`);
  }
}

/**
 * @param argv  arguments after the program name, starting with the command
 * @param io    { stdout, stderr } with write(string)
 * @returns the exit code
 */
export async function main(argv, io) {
  const err = (s) => io.stderr.write(`${s}\n`);
  try {
    const [command, ...rest] = argv;
    if (command === undefined || command === "-h" || command === "--help") { err(USAGE.trimEnd()); return command === undefined ? 2 : 0; }
    if (command !== "resolve" && command !== "api-doc") throw new UsageError(`unknown command ${command}`);
    const opts = parseArgs(rest);
    if (opts.help) { err(USAGE.trimEnd()); return 0; }
    if (command === "resolve" && (Object.keys(opts.refs).length || opts.title !== undefined)) throw new UsageError("--ref and --title are for api-doc");
    if (command === "api-doc" && opts.abi) throw new UsageError("api-doc is for Internet Computer canisters; an EVM contract has no get_api_doc");
    const given = [opts.did, opts.envelope, opts.abi].filter((x) => x !== null).length;
    if (given > 1) throw new UsageError("give only one of <service.did>, --envelope and --abi");
    if (given === 0) throw new UsageError("missing <service.did> (or --envelope <file>, or --abi <file>)");
    const input = {};
    if (opts.envelope) input.envelope = await readJsonFile(opts.envelope, "envelope");
    else if (opts.abi) input.abi = await readJsonFile(opts.abi, "ABI");
    else {
      try { input.did = await readFile(opts.did, "utf8"); } catch (e) { throw new UsageError(`cannot read ${opts.did}: ${e.message}`); }
    }

    const validateSchema = await createSchemaValidator();
    const profiles = [];
    for (const f of opts.profiles) profiles.push({ doc: await readJsonFile(f, "profile"), label: f });
    const packs = [];
    if (opts.packs) {
      let found;
      try { found = await loadPacks(opts.packsDir); } catch (e) { throw new UsageError(`cannot read packs from ${opts.packsDir}: ${e.message}`); }
      if (!found.length) throw new UsageError(`no packs (*.profile.json of kind pack) in ${opts.packsDir}`);
      for (const p of found) packs.push({ doc: p.doc, label: path.relative(process.cwd(), p.file) });
    }

    const r = await resolveService({ ...input, didLabel: opts.did ?? opts.envelope ?? opts.abi, validateSchema, profiles, packs });
    if (command === "api-doc") {
      if (!opts.quiet) summary(r, opts, err);
      if (!r.ok || !r.resolved) { err("candid-profile: no api-doc: the profiles have errors"); return 1; }
      let text;
      try {
        text = renderApiDoc(r.resolved, { refs: opts.refs, title: opts.title });
      } catch (e) {
        if (!(e instanceof ApiDocError)) throw e;
        err(`candid-profile: ${e.message}`);
        return 1;
      }
      io.stdout.write(text);
      return 0;
    }
    if (r.resolved) io.stdout.write(`${JSON.stringify(r.resolved, null, 2)}\n`);
    if (!opts.quiet) summary(r, opts, err);
    return r.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof UsageError) { err(`candid-profile: ${e.message}`); err(USAGE.trimEnd()); return 2; }
    throw e;
  }
}

function summary(r, opts, err) {
  const count = (s) => r.diagnostics.filter((d) => d.severity === s).length;
  if (r.resolved) err(`candid-profile: ${opts.did ?? opts.envelope ?? opts.abi}  ${r.resolved.interface_id}  [${Object.keys(r.resolved.methods).length} methods]`);
  for (const p of r.profiles) err(`  ${p.status.padEnd(11)} ${String(p.name).padEnd(16)} ${String(p.origin ?? "?").padEnd(12)} ${p.profile_id ?? ""}`);
  err(`  ${count("error")} error, ${count("warning")} warning, ${count("info")} info`);
  for (const d of r.diagnostics) {
    if (d.severity === "info" && !opts.verbose) continue;
    err(`  ${d.severity.padEnd(7)} ${d.code.padEnd(26)} ${d.profile ? `[${d.profile}] ` : ""}${d.at}  ${d.message}`);
  }
}
