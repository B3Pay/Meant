import assert from "node:assert/strict";
import { test } from "node:test";
import { codeBlock, codeSpan, escapeLineStart, escapeMarkdown, oneLine, visible } from "../src/text.mjs";
import { inspectMarkdown as inspect } from "./helpers.mjs";

test("visible: control, format and separator characters are shown, not passed through", () => {
  assert.equal(visible("a\u202eb"), "a\\u{202e}b");
  assert.equal(visible("a\u0000b\tc\nd\u2028e\u2029f\u200dg\u0085"), "a\\u{0}b\\u{9}c\\u{a}d\\u{2028}e\\u{2029}f\\u{200d}g\\u{85}");
  assert.equal(visible("plain ünïcödé 日本語 🙂"), "plain ünïcödé 日本語 🙂");
  assert.equal(visible("\ud800"), "\ufffd", "a lone surrogate cannot be shown; it becomes U+FFFD");
});

test("oneLine: line breaks in profile text become one space", () => {
  assert.equal(oneLine("a\nb\r\nc\u2028d"), "a b c d");
  assert.equal(oneLine("a\u0007b"), "a\\u{7}b");
});

test("codeSpan: the fence outgrows backticks inside, padding protects edge backticks and spaces", () => {
  assert.equal(codeSpan("abc"), "`abc`");
  assert.equal(codeSpan("a`b"), "``a`b``");
  assert.equal(codeSpan("a``b"), "```a``b```");
  assert.equal(codeSpan("`a"), "`` `a ``");
  assert.equal(codeSpan("a`"), "`` a` ``");
  assert.equal(codeSpan(" a"), "`  a `");
  assert.equal(codeSpan("a "), "` a  `");
  assert.equal(codeSpan("   "), "`   `");
  assert.equal(codeSpan(""), "*(empty)*", "an empty value cannot be a code span, and is not mistaken for the text (empty)");
});

const HOSTILE = [
  "[link](https://evil.example)",
  "![image](https://evil.example/x.png)",
  "<script>alert(1)</script>",
  '<a href="https://evil.example">pay here</a>',
  "<https://evil.example>",
  "<b>bold</b> <i>x</i> <img src=x onerror=alert(1)>",
  "https://evil.example/path?q=1",
  "www.evil.example and user@evil.example",
  "**bold** _italic_ ~~strike~~",
  "`tick` ``double`` ```triple```",
  "`",
  "``",
  "```",
  "\\ \\* \\[x\\] \\`",
  "&amp; &#x41; &copy; &lt;b&gt;",
  "# heading",
  "- item",
  "1. one",
  "> quote",
  "---",
  "***",
  "===",
  "    indented code",
  "|a|b|\n|-|-|\n|c|d|",
  "[ref]: https://evil.example\n\n[ref]",
  "text\n\n# injected heading\n\n- injected item",
  "line one\r\nline two",
  "para\u2028sep\u2029arate",
  "  leading and trailing spaces  ",
  " ",
  "a\u202eb",
  "zero\u200bwidth",
  "tab\there",
  "\u0000nul",
  "emoji \u{1F468}\u200d\u{1F469} family",
  "Approve [**Approve**](javascript:alert(1))",
  "| Amount | 1000000 TKA |",
  "x".repeat(2000),
];

test("markdown: a hostile value in a code span is one code node and nothing else (CommonMark reference parser)", () => {
  for (const hostile of HOSTILE) {
    const markdown = `Send ${codeSpan(hostile)} now`;
    const { types, codes, html } = inspect(markdown);
    assert.deepEqual([...types].sort(), ["code", "document", "paragraph", "text"], JSON.stringify(hostile));
    assert.equal(codes.length, 1, JSON.stringify(hostile));
    assert.equal(codes[0], visible(hostile) === "" ? "" : visible(hostile).replace(/\n/g, " "), JSON.stringify(hostile));
    assert.doesNotMatch(html.replace(/<code>[\s\S]*?<\/code>/g, ""), /<(a|img|script|b|i|h\d|ul|ol|li|blockquote|pre|table|hr)\b/, JSON.stringify(hostile));
  }
});

test("markdown: the same values in a list item and next to a bold label stay inert", () => {
  for (const hostile of HOSTILE) {
    const markdown = `# Title\n\nText\n\n- **Memo:** ${codeSpan(hostile)}`;
    const { types, codes } = inspect(markdown);
    assert.deepEqual([...types].sort(), ["code", "document", "heading", "item", "list", "paragraph", "strong", "text"], JSON.stringify(hostile));
    assert.equal(codes.length, 1, JSON.stringify(hostile));
  }
});

test("markdown: escaped profile text renders as the text it is", () => {
  const profileText = "Send *these* [tokens](https://evil.example) <b>now</b> & `go` #1 ~x~ | y | _z_ \\ ";
  const { types, html } = inspect(escapeMarkdown(profileText));
  assert.deepEqual([...types].sort(), ["document", "paragraph", "text"]);
  assert.doesNotMatch(html, /<(a|img|b|em|strong|code|del)\b/);
  assert.equal(html.replace(/<\/?p>\n?/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim(), profileText.trim());
});

test("escapeMarkdown: underscores inside a word stay readable, all other underscores are escaped", () => {
  assert.equal(escapeMarkdown("icrc1_transfer from_subaccount"), "icrc1_transfer from_subaccount");
  assert.equal(escapeMarkdown("_a_ a_ _a a__b"), "\\_a\\_ a\\_ \\_a a\\_\\_b");
  for (const text of ["icrc1_transfer", "from_subaccount_x", "a_b_c", "_x_", "__x__", "a__b", "x_ y"]) {
    const { types, html } = inspect(escapeMarkdown(text));
    assert.deepEqual([...types].sort(), ["document", "paragraph", "text"], text);
    assert.equal(html.trim(), `<p>${text}</p>`, text);
  }
});

test("markdown: a template that starts with a list marker or a number does not open a block", () => {
  for (const start of ["1. First", "2) Second", "- dash", "+ plus", "= equals"]) {
    const { types } = inspect(escapeLineStart(escapeMarkdown(start)));
    assert.deepEqual([...types].sort(), ["document", "paragraph", "text"], start);
  }
});

test("codeBlock: fenced block whose fence outgrows any backtick run", () => {
  assert.equal(codeBlock("(1)"), "```\n(1)\n```");
  const { types, codes } = inspect(codeBlock("a ``` b ```` c"));
  assert.deepEqual([...types].sort(), ["code_block", "document"]);
  assert.equal(codes[0], "a ``` b ```` c\n");
});
