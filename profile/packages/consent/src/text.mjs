// Text safety: making untrusted strings visible and escaping them for the target format (spec section 6,
// "Escaping values"; section 11 item 4).
//
// Two targets:
//   - plain text (ICRC-21 FieldsDisplayMessage): no formatting elements, so only invisible and control
//     characters are made visible.
//   - Markdown (GenericDisplayMessage): values from the call (the relying party is not trusted) go into a code
//     span, where nothing is parsed: no link, image, autolink, HTML, emphasis or entity. Text that comes from
//     the profile (template literals, labels) is plain text: its Markdown punctuation is backslash-escaped.

/** Control (Cc), format (Cf, including bidi overrides), line separator (Zl) and paragraph separator (Zp) characters. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const LINE_BREAKS = /[\r\n\u0085\u2028\u2029]+/g;

/**
 * Show invisible characters instead of passing them through: U+202E becomes the six characters `\u{202e}`.
 * Never drops a character. A lone surrogate (possible in JSON read from disk) becomes U+FFFD.
 */
export function visible(s) {
  return String(s).toWellFormed().replace(UNSAFE, (ch) => `\\u{${ch.codePointAt(0).toString(16)}}`);
}

/** Template text and labels come from the profile: one line, so line breaks become one space. */
export function oneLine(s) {
  return visible(String(s).toWellFormed().replace(LINE_BREAKS, " "));
}

/**
 * Backslash-escape the characters that start inline Markdown constructs (CommonMark: any ASCII punctuation may be
 * escaped). An underscore between two letters or digits cannot open emphasis in CommonMark, so `snake_case` stays
 * readable in the raw message; every other underscore is escaped.
 */
export function escapeMarkdown(s) {
  return s.replace(/[\\`*[\]<>&~|#]|_/gu, (ch, i) => {
    if (ch === "_" && /[\p{L}\p{N}]/u.test(s[i - 1] ?? "") && /[\p{L}\p{N}]/u.test(s[i + 1] ?? "")) return ch;
    return `\\${ch}`;
  });
}

/** A list marker or ordered-list number at the start of a line would open a block; escape it. */
export function escapeLineStart(s) {
  return s.replace(/^(\s*)(\d+)([.)])/, "$1$2\\$3").replace(/^(\s*)([-+=])/, "$1\\$2");
}

/**
 * One string as a Markdown code span: verbatim, whatever it contains. The fence is one backtick longer than the
 * longest backtick run inside; a space pads content that starts or ends with a backtick or a space (CommonMark
 * strips one space from each side when both are present). Control and invisible characters are made visible
 * first. An empty string has no code span; the caller shows `*(empty)*` instead (see emptyMarkdown).
 */
export function codeSpan(s) {
  const text = visible(s);
  if (text === "") return emptyMarkdown();
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(longest + 1);
  const allSpaces = /^ +$/.test(text);
  const pad = !allSpaces && (/^[ `]/.test(text) || /[ `]$/.test(text)) ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** An empty string, distinguishable from a code span that contains the same words. */
export function emptyMarkdown() {
  return "*(empty)*";
}

/** A fenced block for one line of technical text; the fence outgrows any backtick run inside. */
export function codeBlock(s) {
  const text = visible(s);
  let longest = 2;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(longest + 1);
  return `${fence}\n${text}\n${fence}`;
}
