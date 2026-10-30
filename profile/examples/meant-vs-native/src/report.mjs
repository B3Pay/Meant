// Renders the measured results as Markdown (results.md). Every number and verdict here comes from the run.
import { exactDecimal } from "./exact.mjs";
import { unitsCell } from "./units.mjs";

const esc = (s) => String(s).replaceAll("|", "\\|").replaceAll("\n", "<br>");
const table = (head, rows) => [`| ${head.map(esc).join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)].join("\n");
const fence = (text) => ["```", text, "```"].join("\n");
const yes = "✅", no = "❌", stop = "🛑", na = "–";

function scoreboard({ units, consent, eip712, retry }) {
  const u = Object.fromEntries(units.rows.map((r) => [r.input, r.cells]));
  const ok = (cell) => (cell.verdict === "right" || cell.verdict === "refused" ? yes : no);
  const precise = consent.filter((r) => r.id !== "custom");
  const ledgerExact = precise.every((r) => r.nativeAmount === r.exact);
  const meantExact = precise.every((r) => r.meantAmount === r.exact);
  const attacks = eip712.rows.filter((r) => ["chain", "lookalike", "spoof"].includes(r.id));
  const by = Object.fromEntries(retry.rows.map((r) => [r.id, r]));
  const once = (r) => (r.transfers === 1 ? yes : `${no} paid ${r.transfers}×`);
  const rows = [
      ["`1.123456789` on an 8-decimal token is refused, not rounded", ok(u["1.123456789"].hand), ok(u["1.123456789"].viem), ok(u["1.123456789"].ethers), ok(u["1.123456789"].dfinity), ok(u["1.123456789"].meant)],
      ["`1,5` is refused, not read as 1 or 15", ok(u["1,5"].hand), ok(u["1,5"].viem), ok(u["1,5"].ethers), ok(u["1,5"].dfinity), ok(u["1,5"].meant)],
      ["`1.5 ICP` is refused by a TKA ledger; `1.5 TKA` is read", no, "numbers only", "numbers only", "numbers only", yes],
      ["The consent text shows the exact amount (big and 18-decimal amounts)", "", "", "", ledgerExact ? yes : `${no} ledger's ICRC-21 rounds`, meantExact ? yes : no],
      ["A canister with no ICRC-21 code still gets a consent text", "", "", "", `${no} none`, yes],
      ["An EIP-712 request is shown in words, with the same digest", "", "digest only", "digest only", "", eip712.rows.every((r) => (r.expect === "ok") === r.meant.ok && (!r.meant.ok || r.meant.digest === r.viemDigest)) ? yes : no],
      ["Wrong chain, look-alike contract or spoofed type is refused before signing", "", attacks.every((r) => r.viemSigned) ? `${no} signs all 3` : "?", attacks.every((r) => r.ethersSigned) ? `${no} signs all 3` : "?", "", attacks.every((r) => !r.meant.ok) ? `${yes} refuses all 3` : no],
      ["A transfer whose reply was lost, retried, pays once", "", "", "", `${once(by.none)} (default), ${once(by.fresh)} (new stamp), ${once(by.kept)} but reports an error (kept stamp)`, `${once(by.meant)} and reports done`],
      ["The person confirms a preview before every send", "", "", "", "the app's job", `${yes} ${by.meant.previews.length} of ${by.meant.sends.length} sends`],
      ["`1.5` on a 6-decimal ledger sends 1.5, decimals read from the ledger", "", "", "", `${no} sent ${retry.decimals.native.received} with ICP's 8`, retry.decimals.meant.received === "1.5" ? yes : no],
      ["The consent text names the sender and the fee", "", "", "", consent[0].native.text.includes("**Fees:**") ? `${yes} ledger's ICRC-21` : no, consent[0].meant.includes("Fee") ? yes : `${no} not in the packs' texts`],
  ];
  return [
    table(["Check", "By hand", "viem", "ethers", "DFINITY libraries and ledger", "Meant"], rows.map((r) => r.map((c) => c || na))),
    "",
    "The DFINITY column is @dfinity/utils 5.0.0 for amounts, the ledger's own ICRC-21 endpoint for consent texts, and @icp-sdk/canisters 4.0.0 (`IcrcLedgerCanister`) for transfers. – means the tool has no part in that check.",
  ].join("\n");
}

function unitsSection(units) {
  const head = ["Text", "Means", ...units.tools.map((t) => t.label)];
  const rows = units.rows.map((r) => [`\`${r.input}\``, r.want === null ? `refuse (${r.why})` : `${exactDecimal(r.want, r.decimals)} ${r.symbol}`, ...units.tools.map((t) => unitsCell(r, r.cells[t.key]))]);
  return [
    table(head, rows),
    "",
    `Calls: ${units.tools.map((t) => `${t.label} ${t.note}`).join("; ")}. Decimals are 8 (TKA) except the last row (18, TKC).`,
    "",
    "- ✅ the right base units, ❌ different base units than the text means (silently), 🛑 refused with an error, ⚠️ accepted here and refused later by the Candid encoder.",
    "- viem, ethers and @dfinity/utils read numbers only: `1.5 ICP` is refused because of its unit, so checking that the unit is this ledger's is left to the app. Meant reads the unit and checks it against the ledger's `icrc1_symbol`.",
    "- `By hand` is an illustration of app code, not a measurement of any app. With `Math.floor` instead of `Math.round` it also gets `0.29` wrong (28999999 base units).",
    "- Meant is stricter than the others in two cases this table does not show: `1.` and `.5` are refused (`E_SYNTAX`, with a hint), where viem, ethers and @dfinity/utils accept them.",
    units.rustSkipped ? "- The Rust column was skipped: cargo is not installed." : "- The Rust crate and the JavaScript package gave the same value, or the same error code and message, for every row (the run checks this).",
  ].join("\n");
}

function consentSection(rows) {
  const t = table(
    ["Call", "Raw Candid (no ICRC-21)", "DFINITY ledger's own ICRC-21", "Meant (@meantjs/consent)"],
    rows.map((r) => [
      r.label,
      r.rawAmount,
      r.native.ok ? `${r.nativeAmount === r.exact ? yes : no} \`${r.nativeAmount}\`` : `${no} ${r.native.text}`,
      `${r.meantAmount === r.exact ? yes : no} \`${r.meantAmount}\``,
    ]),
  );
  const first = rows[0];
  const fieldsFail = rows.filter((r) => r.id !== "custom" && !r.nativeFields.ok).map((r) => r.label);
  return [
    t,
    "",
    `The exact amount of each call is computed with BigInt arithmetic independent of every tool. All three ledgers run the same pinned DFINITY ledger wasm; Meant's texts come from the ICRC-1 and ICRC-2 packs that @meantjs/profile ships, applied to the ledger's .did, with the decimals and symbol read from the ledger.`,
    "",
    `The first call in full: the ledger's text, then Meant's.`,
    "",
    fence(first.native.text),
    "",
    fence(first.meant),
    "",
    `- The ledger's text names the sender and the fee; the packs' texts do not. Meant's renderer never states ledger state the call does not carry (the fee here is \`null\`, so the ledger's default applies).`,
    `- The ledger's FieldsDisplay form refuses ${fieldsFail.length} of these calls (\`Failed to convert tokens to u64\`): ${fieldsFail.join("; ")}. Meant's FieldsDisplay form answered every call (amounts above u64 go in a Text field).`,
    `- The raw Candid value is what a signer can show when a canister has no ICRC-21 endpoint: base units, memo bytes as numbers, no token, no decimals.`,
  ].join("\n");
}

function eip712Section({ rows, erc7730 }) {
  const t = table(
    ["Request", "viem 2.57.4 (local account)", "ethers 6.17.0 (Wallet)", "Meant (@meantjs/consent/evm)"],
    rows.map((r) => [r.label, r.viemSigned ? "signed" : "refused", r.ethersSigned ? "signed" : "refused", r.meant.ok ? `${yes} text, digest = viem's` : `${stop} \`${r.meant.code}\`: ${r.meant.message}`]),
  );
  const permit = rows.find((r) => r.id === "permit2");
  return [
    t,
    "",
    "What a raw field viewer shows for the Permit2 request (the message as it is):",
    "",
    fence(permit.raw),
    "",
    "What Meant shows for it:",
    "",
    fence(permit.meant.message),
    "",
    `- viem's \`hashTypedData\`, ethers' \`TypedDataEncoder.hash\` and Meant gave the same digest for both valid requests (the run checks this).`,
    `- viem and ethers are signing libraries: checking a request against what the person expects is the wallet's job, and they do not claim to do it. Meant is a way to do that job from a profile. Browser wallets were not tested here.`,
    `- The same Permit2 profile also yields the contract's ERC-7730 clear-signing file (${erc7730.formats.length} message formats, ${erc7730.bytes} bytes of JSON) and the ERC-8176 \`descriptorHash\` an attestation of it would carry: \`${erc7730.descriptorHash}\`.`,
  ].join("\n");
}

function retrySection(retry) {
  const t = table(
    ["Way", "What the caller was told", "Bob received", "Transfers on the ledger"],
    retry.rows.map((r) => [r.label, r.told.join("; then "), `${r.received} ${retry.token}`, String(r.transfers)]),
  );
  const m = retry.rows.find((r) => r.id === "meant");
  const p = m.previews[0];
  const d = retry.decimals;
  return [
    "Alice sends 0.29 TKA to Bob. The ledger runs the call, and the reply is lost on the way back (a dropped connection, simulated in the transport). The caller tries again two seconds later.",
    "",
    t,
    "",
    `- With the library's default (no \`created_at_time\`) or a new stamp per attempt, the ledger cannot tell the retry from a new payment: Bob is paid twice. With a kept stamp the ledger refuses the retry as a \`Duplicate\`, and the library throws it as an error: the money moved, the app is told it failed. Turning that \`Duplicate\` into "done" is left to each app.`,
    `- Meant's profile says it: \`created_at_time\` is the idempotency stamp, set once and reused, and \`Err.Duplicate\` is \`already_done\`. The tool layer sent the same bytes both times (${m.sends.length} sends, identical), and preparing the call again returned the same preview instead of a new stamp.`,
    `- Before each send the person was shown the preview: "${p.title}", ${p.arguments.amount.text} to ${p.arguments.to.text}, effect ${p.effect.kind}${p.effect.irreversible ? ", irreversible" : ""}.`,
    `- @meantjs/reconcile read the ledger's ICRC-3 log afterwards and found the original transfer: \`${m.reconcile.status}\`, block ${m.reconcile.block}.`,
    "",
    "### Decimals: assumed by the app, or read from the ledger",
    "",
    table(
      ["Way", "Base units sent", `Bob received (${d.token}, 6 decimals)`],
      [
        ["An app that converts with ICP's 8 decimals (`convertStringToE8s(\"1.5\")` of @dfinity/utils)", String(d.native.amount), `${no} ${d.native.received} ${d.token}`],
        ["@meantjs/tools, decimals from the ledger's `icrc1_decimals`, as the profile names it", "1500000", `${d.meant.received === "1.5" ? yes : no} ${d.meant.received} ${d.token}`],
      ],
    ),
    "",
    `- The 8-decimal helper is an illustration of a known kind of bug, not a measurement of any app. The profile names where decimals come from (\`{ "from": "query:icrc1_decimals" }\`), and the host reads them from the canister: ${JSON.stringify(d.meant.refs)}.`,
    `- \`1.5 TKA\` given to the TKB ledger's tool was refused before any preview: \`${d.wrongTokenIssues[0].code}\`, ${d.wrongTokenIssues[0].message}.`,
  ].join("\n");
}

function agentSection(agent) {
  return [
    "The words an agent gets for the transfer's `amount`. Without a profile, all it has is the Candid type:",
    "",
    fence(agent.raw),
    "",
    "With the ICRC-1 pack, from `toolDefinitions` of @meantjs/tools for the TKA ledger:",
    "",
    fence(agent.meant),
    "",
    "- Whether these words make agents safer is what the preregistered eval tests; this run does not test any model.",
  ].join("\n");
}

export function renderResults(results) {
  const { meta } = results;
  return [
    "# Meant next to the usual tools: results",
    "",
    `Generated by \`npm start\` on ${meta.date} (Node ${meta.node}). Everything ran on this machine: PocketIC ${meta.pocketIc} with the DFINITY ICRC ledger of ${meta.ledger}, no mainnet and no real funds. The EIP-712 keys were made for the run and hold nothing. Do not edit this file; run \`npm start\` again.`,
    "",
    "Packages: " + meta.packages.map(([n, v]) => `${n} ${v}`).join(", ") + (meta.rust ? `; meant-format ${meta.rust} (crates.io)` : "") + ".",
    "",
    "## Scoreboard",
    "",
    scoreboard(results),
    "",
    "## 1. Amounts people write",
    "",
    unitsSection(results.units),
    "",
    "## 2. What the person approves on the Internet Computer (ICRC-21)",
    "",
    consentSection(results.consent),
    "",
    "## 3. What the person signs on Ethereum (EIP-712)",
    "",
    eip712Section(results.eip712),
    "",
    "## 4. A lost reply, then a retry",
    "",
    retrySection(results.retry),
    "",
    "## 5. What an agent is told",
    "",
    agentSection(results.agent),
    "",
  ].join("\n");
}
