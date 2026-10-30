// Section 1: the text a person or an agent writes, turned into the base units a call carries. Pure code, no network.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseUnits as viemParseUnits } from "viem";
import { parseUnits as ethersParseUnits } from "ethers";
import { FromStringToTokenError, TokenAmountV2 } from "@dfinity/utils";
import { parseAmount } from "@meantjs/format";
import { exactDecimal } from "./exact.mjs";

/** `want`: the base units the text means, or null when no amount is right and the text must be refused. */
export const CASES = [
  { input: "0.29", decimals: 8, symbol: "TKA", want: 29_000_000n, why: "an everyday amount" },
  { input: "1.123456789", decimals: 8, symbol: "TKA", want: null, why: "one digit more than the token has" },
  { input: "0.000000001", decimals: 8, symbol: "TKA", want: null, why: "less than one base unit" },
  { input: "1,5", decimals: 8, symbol: "TKA", want: null, why: "a decimal comma: 1.5 or 15?" },
  { input: "1.5 ICP", decimals: 8, symbol: "TKA", want: null, why: "the wrong token for this ledger" },
  { input: "-1", decimals: 8, symbol: "TKA", want: null, why: "negative, for a nat" },
  { input: "100000000000000000000.1", decimals: 8, symbol: "TKA", want: 10_000_000_000_000_000_000_010_000_000n, why: "a large amount" },
  { input: "1.000000000000000001", decimals: 18, symbol: "TKC", want: 1_000_000_000_000_000_001n, why: "18 decimals, like ckETH" },
];

/** What app code often does by hand (an illustration, not a measurement of any app). */
const byHand = (text, decimals) => BigInt(Math.round(parseFloat(text) * 10 ** decimals));

const TOOLS = [
  { key: "hand", label: "By hand", note: "`BigInt(Math.round(parseFloat(text) * 10 ** decimals))`", run: (c) => byHand(c.input, c.decimals) },
  { key: "viem", label: "viem 2.57.4", note: "`parseUnits(text, decimals)`", run: (c) => viemParseUnits(c.input, c.decimals) },
  { key: "ethers", label: "ethers 6.17.0", note: "`parseUnits(text, decimals)`", run: (c) => ethersParseUnits(c.input, c.decimals) },
  {
    key: "dfinity",
    label: "@dfinity/utils 5.0.0",
    note: "`TokenAmountV2.fromString({ amount, token })`",
    run: (c) => {
      const r = TokenAmountV2.fromString({ amount: c.input, token: { symbol: c.symbol, name: c.symbol, decimals: c.decimals } });
      if (r instanceof TokenAmountV2) return r.toUlps();
      throw Object.assign(new Error(FromStringToTokenError[r]), { code: FromStringToTokenError[r] });
    },
  },
  { key: "meant", label: "@meantjs/format 0.3.0", note: "`parseAmount(text, { decimals, symbol })`", run: (c) => BigInt(parseAmount(c.input, { decimals: c.decimals, symbol: c.symbol, candid: "nat" })) },
];

/** The Rust column: meant-format 0.2.0 from crates.io, built in rust/. Null only when cargo is not installed; a failed build fails the run. */
function rustResults(cases) {
  const dir = path.join(import.meta.dirname, "..", "rust");
  const bin = path.join(dir, "target", "release", process.platform === "win32" ? "meant-vs-native-rust.exe" : "meant-vs-native-rust");
  if (!existsSync(bin)) {
    const build = spawnSync("cargo", ["build", "--release", "--locked", "--quiet"], { cwd: dir, encoding: "utf8" });
    if (build.error?.code === "ENOENT") return null;
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error(`cargo could not build the Rust helper (rust/):\n${build.stderr}`);
  }
  const run = spawnSync(bin, { input: cases.map((c) => `${c.decimals}\t${c.symbol}\t${c.input}\n`).join(""), encoding: "utf8" });
  if (run.status !== 0) throw new Error(`the Rust helper failed: ${run.stderr}`);
  return run.stdout.trimEnd().split("\n").map((line) => {
    const [kind, a, message] = line.split("\t");
    return kind === "ok" ? { value: BigInt(a) } : { code: a, message };
  });
}

/** One cell: what the tool did with the text, judged against what the text means. */
function judge(c, outcome) {
  if ("value" in outcome) {
    if (c.want !== null && outcome.value === c.want) return { verdict: "right", value: outcome.value };
    // A negative amount for a nat is still caught later, when the Candid encoder refuses it.
    if (c.want === null && outcome.value < 0n) return { verdict: "late", value: outcome.value };
    return { verdict: "wrong", value: outcome.value };
  }
  return { verdict: c.want === null ? "refused" : "refused-valid", code: outcome.code, message: outcome.message };
}

export function runUnits() {
  const rust = rustResults(CASES);
  const rows = CASES.map((c, i) => {
    const cells = {};
    for (const t of TOOLS) {
      let outcome;
      try {
        outcome = { value: t.run(c) };
      } catch (e) {
        outcome = { code: e.code ?? e.shortMessage ?? e.name, message: (e.shortMessage ?? e.message).split("\n")[0] };
      }
      cells[t.key] = judge(c, outcome);
    }
    if (rust) {
      cells.rust = judge(c, rust[i]);
      // The two Meant implementations must agree exactly: the same value, or the same error code and message.
      const js = cells.meant, rs = cells.rust;
      if (js.verdict !== rs.verdict || js.value !== rs.value || js.code !== rs.code || js.message !== rs.message) {
        throw new Error(`@meantjs/format and meant-format disagree on ${JSON.stringify(c.input)}: ${JSON.stringify([js, rs], (k, v) => (typeof v === "bigint" ? `${v}` : v))}`);
      }
    }
    return { ...c, cells };
  });
  // The claims the write-up makes. If a library changes behaviour, the run fails instead of printing a stale story.
  for (const r of rows) {
    if (r.cells.meant.verdict === "wrong" || r.cells.meant.verdict === "refused-valid") throw new Error(`Meant got ${JSON.stringify(r.input)} wrong`);
  }
  const tools = [...TOOLS, ...(rust ? [{ key: "rust", label: "meant-format 0.2.0 (Rust)", note: "`AmountFormat::new(d).with_symbol(s)?.parse(text)`" }] : [])];
  return { rows, tools, rustSkipped: !rust };
}

/** A cell as Markdown: the amount it means in tokens, so a reader sees the size of a mistake. */
export function unitsCell(row, cell) {
  if (cell.verdict === "right") return `✅ ${exactDecimal(cell.value, row.decimals)}`;
  if (cell.verdict === "wrong") return `❌ ${exactDecimal(cell.value, row.decimals)}`;
  if (cell.verdict === "late") return `⚠️ ${exactDecimal(cell.value, row.decimals)} (the encoder refuses it later)`;
  if (cell.verdict === "refused") return `🛑 refused`;
  return `⚠️ refused a valid amount`;
}
