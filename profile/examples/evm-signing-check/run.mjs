// `npm start`: hands every request of src/requests.mjs to the agent's key twice, bare and behind the signing check,
// uses every signature it gets on the local chain as the party it names would, and reads back who holds what. Each
// scenario starts from the same chain. The run checks every expected answer and balance, writes results.md (and the
// same data as JSON with `--json <file>`; `--check` writes nothing), and exits 1 if anything differs. No network:
// while it runs, fetch refuses every host but this machine.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { localChain, PERMIT2, Reverted, USDC, usdcAbi } from "./src/chain.mjs";
import { report } from "./src/report.mjs";
import { AGENT, GROUPS, NAMES, PARTIES, scenarios, START_UNITS } from "./src/requests.mjs";
import { explain, signingCheck } from "./src/signing-check.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const original = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error(`refused: ${url.origin} is not this machine (this demo never talks to a network)`);
  return original(input, init);
};

const started = new Date();
const now = BigInt(Math.floor(started.getTime() / 1000));
const chain = await localChain({ time: now, holders: { [AGENT.address]: START_UNITS } });
// Permit2 needs one ERC-20 approval from the agent before any permit works: a transaction the wallet signs itself,
// once, outside the check (which signs no transactions).
await chain.call(AGENT.address, USDC, usdcAbi, "approve", [PERMIT2, 2n ** 256n - 1n]);

const check = await signingCheck({
  chainId: chain.chainId,
  tokens: { USDC: { address: USDC, decimals: 6 } },
  apps: { "Weather API": PARTIES["Weather API"], "Swap router": PARTIES["Swap router"] },
  now: () => chain.time * 1_000_000_000n, // the wallet's clock is the chain's
});

async function holdings() {
  return Object.fromEntries(await Promise.all(Object.entries(PARTIES).map(async ([name, address]) => [name, await chain.balance(address)])));
}

/** One scenario on one side: the bare key, or the key behind a task whose terms the user confirmed. */
async function side(scenario, guarded) {
  return chain.isolated(async () => {
    const before = await holdings();
    let account = AGENT;
    let terms = null;
    if (guarded) {
      const task = check.task(scenario.terms);
      task.confirm(task.text); // the user's tap on the wallet's own screen
      terms = task.text;
      account = task.guard(AGENT);
    }
    const steps = [];
    for (const step of scenario.steps) {
      let signed;
      try {
        signed = await step.sign(account);
      } catch (error) {
        const refusal = explain(error);
        if (!refusal) throw error;
        steps.push({ signed: false, refusal });
        break;
      }
      let settled = "not replayed";
      if (step.replay !== false) {
        try {
          await scenario.settle(chain, step, signed);
          settled = "settled";
        } catch (error) {
          if (!(error instanceof Reverted)) throw error;
          settled = `reverted: ${error.reason}`;
        }
      }
      steps.push({ signed: true, settled, via: step.via });
    }
    const after = await holdings();
    const gained = {};
    for (const name of Object.keys(PARTIES)) if (name !== "agent" && after[name] !== before[name]) gained[name] = after[name] - before[name];
    return { steps, gained, spent: before.agent - after.agent, terms };
  });
}

const problems = [];
const same = (a, b) => JSON.stringify(Object.entries(a).sort(), (k, v) => (typeof v === "bigint" ? `${v}` : v)) === JSON.stringify(Object.entries(b).sort(), (k, v) => (typeof v === "bigint" ? `${v}` : v));
const rows = [];
for (const s of scenarios(now)) {
  const plain = await side(s, false);
  const guarded = await side(s, true);
  // The bare key signs every well-formed request it is handed.
  if (plain.steps.length !== s.steps.length || !plain.steps.every((x) => x.signed)) problems.push(`${s.id}: the bare key did not sign every request`);
  const refusal = guarded.steps.find((x) => !x.signed)?.refusal ?? null;
  const answer = refusal ? refusal.code : "signed";
  if (answer !== s.expect.check) problems.push(`${s.id}: the check answered ${answer}, expected ${s.expect.check}${refusal ? ` (${refusal.why.join(" ")})` : ""}`);
  if (!same(plain.gained, s.expect.plain)) problems.push(`${s.id}: with the bare key ${JSON.stringify(plain.gained, (k, v) => (typeof v === "bigint" ? `${v}` : v))} moved, expected ${JSON.stringify(s.expect.plain, (k, v) => (typeof v === "bigint" ? `${v}` : v))}`);
  if (!same(guarded.gained, s.expect.guarded)) problems.push(`${s.id}: behind the check ${JSON.stringify(guarded.gained, (k, v) => (typeof v === "bigint" ? `${v}` : v))} moved, expected ${JSON.stringify(s.expect.guarded, (k, v) => (typeof v === "bigint" ? `${v}` : v))}`);
  for (const x of [...plain.steps, ...guarded.steps]) if (x.settled?.startsWith("reverted")) problems.push(`${s.id}: a signed request did not settle (${x.settled})`);
  rows.push({ id: s.id, group: s.group, kind: s.kind, title: s.title, note: s.note ?? null, unused: s.unused ?? null, after: s.steps[0].after ?? null, via: s.steps[0].via, requests: s.steps.length, plain, guarded, refusal });
  console.log(`${s.id.padEnd(20)} bare key: signed ${plain.steps.filter((x) => x.signed).length}/${s.steps.length}, ${String(plain.spent).padStart(10)} units left the wallet | check: ${answer.padEnd(15)} ${String(guarded.spent).padStart(10)} units left`);
}

const data = {
  started: started.toISOString(),
  node: process.version,
  chainId: chain.chainId,
  start_units: START_UNITS,
  parties: PARTIES,
  names: NAMES,
  groups: GROUPS,
  terms: Object.fromEntries(Object.keys(GROUPS).map((g) => [g, rows.find((r) => r.group === g).guarded.terms])),
  rows,
};
const json = (value) => JSON.stringify(value, (k, v) => (typeof v === "bigint" ? `${v}` : v), 2);
const flag = process.argv.indexOf("--json");
if (flag > 0) writeFileSync(process.argv[flag + 1], `${json(data)}\n`);
if (problems.length) {
  console.error(`\n${problems.length} expectation(s) failed; results.md not written:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  process.exit(1);
}
if (process.argv.includes("--check")) {
  console.log("\nEvery expectation held.");
} else {
  writeFileSync(join(here, "results.md"), report(data));
  console.log("\nEvery expectation held. Wrote results.md.");
}
