// Runs every comparison, checks the claims the write-up makes, and writes results.md.
// npm run fetch first (PocketIC and the ledger, sha256-checked). No mainnet: see src/world.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { toolDefinitions } from "@meantjs/tools";
import { manifest } from "./src/artifacts.mjs";
import { runUnits } from "./src/units.mjs";
import { runEip712 } from "./src/eip712.mjs";
import { ALICE, startWorld } from "./src/world.mjs";
import { ledgerInterface, refsFromCanister } from "./src/ledger.mjs";
import { runConsent } from "./src/consent.mjs";
import { runRetry } from "./src/retry.mjs";
import { renderResults } from "./src/report.mjs";

// Read from the installed files: not every package exports its package.json.
const version = (name) => JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), "utf8")).version;
const PACKAGES = ["@meantjs/profile", "@meantjs/format", "@meantjs/consent", "@meantjs/tools", "@meantjs/reconcile", "viem", "ethers", "@dfinity/utils", "@icp-sdk/canisters", "@icp-sdk/core", "@dfinity/pic"];
const rustLock = readFileSync(new URL("./rust/Cargo.lock", import.meta.url), "utf8");

const step = (s) => console.log(`- ${s}`);
const units = runUnits();
step(`amounts: ${units.rows.length} texts through ${units.tools.length} converters`);
const eip712 = await runEip712();
step(`EIP-712: ${eip712.rows.length} signing requests`);

const world = await startWorld();
let consent, retry, agent;
try {
  const iface = await ledgerInterface(world.did);
  consent = await runConsent(world, iface);
  step(`ICRC-21: ${consent.length} calls, asked of the ledgers on PocketIC`);
  retry = await runRetry(world, iface);
  step(`lost replies: ${retry.rows.length} ways, plus decimals`);
  const tka = world.tokens.find((t) => t.symbol === "TKA");
  const refs = await refsFromCanister(iface, world.pic, tka.ledger, ALICE);
  const tool = toolDefinitions([iface.resolved], { canisters: [{ id: tka.ledger.toText(), label: "TKA", refs }] }).find((t) => t.name === "prepare_icrc1_transfer");
  agent = {
    raw: /type TransferArg = record \{[\s\S]*?\};/.exec(world.did)[0],
    meant: `amount: ${tool.inputSchema.properties.amount.description}\npattern: ${tool.inputSchema.properties.amount.pattern}`,
  };
} finally {
  await world.stop();
}

const results = {
  meta: {
    date: new Date().toISOString().slice(0, 10),
    node: process.versions.node,
    pocketIc: manifest.pocket_ic.version,
    ledger: manifest.ledger.release,
    packages: PACKAGES.map((n) => [n, version(n)]),
    rust: units.rustSkipped ? null : /name = "meant-format"\nversion = "([^"]+)"/.exec(rustLock)?.[1],
  },
  units, eip712, consent, retry, agent,
};
writeFileSync(new URL("./results.md", import.meta.url), renderResults(results));
step("wrote results.md");
