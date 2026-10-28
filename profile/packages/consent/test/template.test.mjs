import assert from "node:assert/strict";
import { test } from "node:test";
import { ConsentError } from "../src/errors.mjs";
import { parseTemplate } from "../src/template.mjs";
import { icrc1, icrc2 } from "./helpers.mjs";

const lit = (text) => ({ t: "lit", text });
const ph = (path) => ({ t: "ph", path });
const opt = (...parts) => ({ t: "opt", parts });

test("template: literals, placeholders and optional segments", () => {
  assert.deepEqual(parseTemplate("Send {amount} to {to}[ from subaccount {from_subaccount}][ with memo {memo}]"), [
    lit("Send "), ph("amount"), lit(" to "), ph("to"),
    opt(lit(" from subaccount "), ph("from_subaccount")),
    opt(lit(" with memo "), ph("memo")),
  ]);
  assert.deepEqual(parseTemplate(""), []);
  assert.deepEqual(parseTemplate("plain"), [lit("plain")]);
});

test("template: the four escapes produce literal braces and brackets", () => {
  assert.deepEqual(parseTemplate("{{a}} [[b]] {x}"), [lit("{a} [b] "), ph("x")]);
  assert.deepEqual(parseTemplate("[ {{x}} ]"), [opt(lit(" {x} "))]);
});

test("template: relative paths with indexes, dots and [] are kept verbatim", () => {
  assert.deepEqual(parseTemplate("{(0).to.owner} {items[]} {#5}"), [ph("(0).to.owner"), lit(" "), ph("items[]"), lit(" "), ph("#5")]);
});

test("template: syntax errors are ConsentError E_TEMPLATE with the resolver's wording", () => {
  const errors = { "[ [a] ]": "nested [ ] segments are not allowed in v0", "a ]": "unbalanced ]", "a }": "unbalanced }", "a {x": "unclosed {", "a [x": "unclosed [" };
  for (const [t, message] of Object.entries(errors)) {
    assert.throws(() => parseTemplate(t), (e) => e instanceof ConsentError && e.code === "E_TEMPLATE" && e.message === message, t);
  }
  assert.throws(() => parseTemplate(42), (e) => e.code === "E_TEMPLATE");
});

test("template: every template of the packs parses and has placeholders the method has", () => {
  for (const resolved of [icrc1, icrc2]) {
    for (const [name, m] of Object.entries(resolved.methods)) {
      const template = m.tags.intent?.args.template;
      if (template === undefined) continue;
      const parts = parseTemplate(template);
      const paths = parts.flatMap((p) => (p.t === "ph" ? [p.path] : p.t === "opt" ? p.parts.filter((q) => q.t === "ph").map((q) => q.path) : []));
      assert.ok(paths.length > 0, name);
      for (const path of paths) assert.ok(Object.hasOwn(m.args[0].fields, path), `${name}: {${path}} is a field of the argument`);
    }
  }
});

// The scan must be the resolver's, character for character (packages/resolver/src/checks.mjs, parseTemplate).
test("template: agrees with the resolver's parseTemplate on 5000 random templates", async (t) => {
  let reference;
  try {
    ({ parseTemplate: reference } = await import("../../resolver/src/checks.mjs"));
  } catch {
    t.skip("the resolver no longer exports parseTemplate from src/checks.mjs; update this test");
    return;
  }
  let seed = 20261009;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const alphabet = ["{", "}", "[", "]", "{", "}", "[", "]", "a", "b", " ", ".", "x"];
  for (let i = 0; i < 5000; i++) {
    const t = Array.from({ length: Math.floor(rnd() * 14) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
    const want = reference(t);
    let got;
    try {
      got = { parts: parseTemplate(t) };
    } catch (e) {
      got = { error: e.message };
    }
    if (want.error !== undefined) assert.equal(got.error, want.error, JSON.stringify(t));
    else {
      assert.equal(got.error, undefined, JSON.stringify(t));
      const flat = got.parts.flatMap((p) => (p.t === "ph" ? [{ path: p.path, inOptional: false }] : p.t === "opt" ? p.parts.filter((q) => q.t === "ph").map((q) => ({ path: q.path, inOptional: true })) : []));
      assert.deepEqual(flat, want.placeholders, JSON.stringify(t));
    }
  }
});
