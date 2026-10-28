#!/usr/bin/env node
// Prints the message blocks of docs/oisy-comparison.md (the test checks that the document contains them verbatim).
import { SCENARIOS, compare } from "../test/oisy-scenarios.mjs";

const visible = (s) => s.replace(/[\p{Cc}\p{Cf}]/gu, (c) => (c === "\n" ? "\n" : `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}>`));
for (const s of SCENARIOS) {
  const r = compare(s);
  console.log(`### ${s.id}: ${s.title}\n`);
  console.log("OISY fallback:\n~~~markdown\n" + visible(r.oisy) + "\n~~~\n");
  console.log("Profile, GenericDisplayMessage:\n~~~markdown\n" + r.generic + "\n~~~\n");
  console.log("Profile, FieldsDisplayMessage:\n~~~text\nintent: " + r.fields.intent + "\n" + r.fields.fields.map(([l, v]) => `${l}: ${JSON.stringify(v, (k, x) => (typeof x === "bigint" ? `${x}` : x))}`).join("\n") + "\n~~~\n");
}
