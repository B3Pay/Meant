// results.md from one run's data: what each request was, what the bare key and the check did with it, and the USDC
// the local chain shows moved because of it. Amounts are exact (base units over 10^6, never rounded).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = (name) => JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")).version;
export const VERSIONS = () => Object.fromEntries(["@meantjs/consent", "@meantjs/profile", "@x402/evm", "viem", "@ethereumjs/vm"].map((n) => [n, version(n)]));

/** Base units of a 6-decimal token as exact text, thousands grouped: 1000000000 -> "1,000", 10000 -> "0.01". */
export function usdc(units) {
  const n = BigInt(units);
  const sign = n < 0n ? "-" : "";
  const abs = n < 0n ? -n : n;
  const whole = (abs / 1_000_000n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""} USDC`;
}

const KIND = { real: "Real", attack: "Attack", tampered: "Tampered", rule: "Second request" };
const who = (name) => (name === "attacker" ? "the attacker" : name);
const moved = (gained) => Object.entries(gained).map(([name, units]) => `${who(name)} got ${usdc(units)}`).join(", ");
const esc = (s) => String(s).replaceAll("|", "\\|");

function bare(row) {
  const { steps, gained } = row.plain;
  if (row.note) return `Signed: ${row.note}. Not used: ${row.unused}.`;
  const signed = steps.length > 1 ? `Signed both; ${moved(gained)} in all` : `Signed; ${moved(gained)}`;
  const all = Object.values(gained).some((u) => BigInt(u) === BigInt(row.start)) ? " (all the agent held)" : "";
  const later = row.after ? ` ${Number(BigInt(row.after) / 86_400n)} days later` : "";
  return `${signed}${all}${later}.`;
}

function checked(row) {
  const { steps, gained } = row.guarded;
  const refusal = row.refusal ? `**Not signed.** ${row.refusal.why.join(" ")}` : null;
  if (!refusal) return `Signed; ${moved(gained)}.`;
  return steps[0].signed ? `First signed; ${moved(gained)}. Second: ${refusal}` : refusal;
}

export function report(data) {
  const rows = data.rows.map((r) => ({ ...r, start: data.start_units }));
  const bad = rows.filter((r) => r.kind === "attack" || r.kind === "tampered");
  const real = rows.filter((r) => r.kind === "real");
  const signedBy = (list, side) => list.filter((r) => r[side].steps.every((s) => s.signed)).length;
  const most = rows.filter((r) => r.kind === "attack").reduce((m, r) => (BigInt(r.plain.spent) > m ? BigInt(r.plain.spent) : m), 0n);
  const v = VERSIONS();
  const lines = [
    "# The signing check, replayed on a local chain",
    "",
    `Written by \`npm start\` on ${data.started.slice(0, 16).replace("T", " ")} UTC (Node ${data.node}). Each request below was handed to an AI agent's EVM key twice: once straight to the key, with nothing in between (a viem account, through x402's own client or a viem wallet client), and once through Meant's signing check (\`src/signing-check.mjs\`), after the user confirmed the task's terms. Every signature the key gave was then used by the party the request names, on a local EVM that runs Base Sepolia's USDC, Permit2 and x402 contracts at their addresses, and the USDC that moved is read back from that chain. Each request starts from the same state: the agent holds ${usdc(data.start_units)} and has approved Permit2 once.`,
    "",
    `**Bad requests signed: ${signedBy(bad, "plain")} of ${bad.length} by the bare key, ${signedBy(bad, "guarded")} of ${bad.length} behind the check.** Real requests signed: ${signedBy(real, "plain")} of ${real.length} by the bare key, ${signedBy(real, "guarded")} of ${real.length} behind the check. The bare key's signatures for bad requests moved up to ${usdc(most)} of the agent's ${usdc(data.start_units)}; behind the check none of them was signed, so none of them moved anything.`,
    "",
    "The agent here is a script that hands every request to the signer; no model is asked. The check is in the signer, so it answers the same whatever the agent decides.",
  ];
  for (const [group, g] of Object.entries(data.groups)) {
    lines.push("", `## ${g.title}`, "", `The user asked: "${g.ask}"`, "", `The terms the user confirmed on the wallet's screen: "${data.terms[group]}"`, "", "| Request | Bare key | Behind the check |", "|---|---|---|");
    for (const r of rows.filter((x) => x.group === group)) lines.push(`| **${KIND[r.kind]}:** ${esc(r.title)} | ${esc(bare(r))} | ${esc(checked(r))} |`);
  }
  lines.push(
    "",
    "## How a refusal reads",
    "",
    "`explain(error)` turns the check's refusal into words for the user and the agent. The titles of this run:",
    "",
    ...[...new Set(rows.filter((r) => r.refusal).map((r) => `- ${r.refusal.title} (\`${r.refusal.code}\`) ${r.refusal.next}`))],
    "",
    "## What ran",
    "",
    `- The check: \`@meantjs/consent\` ${v["@meantjs/consent"]} (\`guardSigner\`, \`termsGate\`) and the USDC, Permit2 and x402 profiles of \`@meantjs/profile\` ${v["@meantjs/profile"]}, from npm.`,
    `- The requests: x402's own client, \`@x402/evm\` ${v["@x402/evm"]} (\`ExactEvmScheme\`, \`UptoEvmScheme\`), and a viem ${v.viem} wallet client; the key is a viem local account made for this demo.`,
    `- The chain: \`@ethereumjs/vm\` ${v["@ethereumjs/vm"]} in this process, chain id ${data.chainId}, running the code of \`artifacts.json\` (keccak-256 checked) at Base Sepolia's addresses. USDC's and Permit2's EIP-712 domain separators on it equal Base Sepolia's.`,
    "",
  );
  return `${lines.join("\n")}\n`;
}
