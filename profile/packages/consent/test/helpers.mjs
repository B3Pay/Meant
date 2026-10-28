// Shared test helpers. Argument bytes are produced by @dfinity/didc (the Rust candid crates compiled to wasm), an
// encoder independent of the @candid-core/schema codec the library decodes with.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { encode } from "@dfinity/didc";
import { HtmlRenderer, Parser } from "commonmark";

const read = (rel, base) => readFileSync(new URL(rel, base), "utf8");

export const repoFixture = (name) => JSON.parse(read(`../../../fixtures/${name}`, import.meta.url));
export const LEDGER_DID = read("./fixtures/ledger.did", import.meta.url);
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** Resolved forms of the standard packs (shared contract; never edited here). */
export const icrc1 = repoFixture("icrc1.resolved.json");
export const icrc2 = repoFixture("icrc2.resolved.json");

/** Test principals. ALICE and BOB are self-authenticating-looking user principals; SPENDER is a canister id. */
export const ALICE = "k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae";
export const BOB = "ig6pt-bilfj-ewrb5-gyxsa-gisbm-b7z5p-o47mn-dswdx-s225j-4ysgf-ig6";
export const SPENDER = "un4fu-tqaaa-aaaab-qadjq-cai";

/** The three eval ledgers (eval/tasks-v0.json environment.ledgers): symbol and decimals. */
export const LEDGERS = Object.freeze({
  TKA: { symbol: "TKA", decimals: 8 },
  TKB: { symbol: "TKB", decimals: 6 },
  TKC: { symbol: "TKC", decimals: 18 },
});

/** The dynamic refs a caller resolves once per ledger (docs/profile-v0.md section 4). */
export const refsFor = ({ symbol, decimals }) => ({ "query:icrc1_decimals": decimals, "query:icrc1_symbol": symbol });

/** Candid text for a 32-byte subaccount whose last byte is n. */
export const subaccountText = (n) => `blob "${"\\00".repeat(31)}\\${n.toString(16).padStart(2, "0")}"`;

/** Textual Candid arguments -> bytes, coerced to the declared argument types of `method` in `did`. */
export function encodeCall(method, argsText, did = LEDGER_DID) {
  const hex = encode({ idl: did, input: argsText, targetFormat: "hex", withType: { kind: "methodParams", name: method } });
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

export const hexOf = (bytes) => Buffer.from(bytes).toString("hex");
export const fromHex = (hex) => Uint8Array.from(Buffer.from(hex, "hex"));

/** A resolved form with one update method, for tests that need tags the packs do not carry. */
export function syntheticResolved(name, argNodes, methodTags = {}, mode = "update") {
  return {
    format: "candid-profile-resolved",
    format_version: 0,
    interface_id: null,
    profiles: [],
    methods: { [name]: { mode, tags: methodTags, args: argNodes, results: [] } },
    diagnostics: [],
  };
}

export const tag = (args = {}) => ({ args, origin: "author", profile: "test" });

/** Parse Markdown with the CommonMark reference implementation: the node types, the literals of code nodes and the HTML. */
export function inspectMarkdown(markdown) {
  const root = new Parser().parse(markdown);
  const types = new Set();
  const codes = [];
  const walker = root.walker();
  for (let e = walker.next(); e; e = walker.next()) {
    if (!e.entering) continue;
    types.add(e.node.type);
    if (e.node.type === "code" || e.node.type === "code_block") codes.push(e.node.literal);
  }
  return { types, codes, html: new HtmlRenderer({ safe: false }).render(root) };
}
