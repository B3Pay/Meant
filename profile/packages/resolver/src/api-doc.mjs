/**
 * The text a canister's `get_api_doc` (or `getApiDoc`) query returns, rendered from its resolved form (spec section
 * 10, D-060, proposals/w0-icp-mcp.md).
 *
 * DFINITY's ICP MCP connector and any agent that follows its service discoverability guide read that query before they
 * call a canister: it is where an app says what its interface cannot (units and encoding, which calls need a person's
 * yes, how to retry, what each error means). A profile already says all of it, bound to the interface by its
 * `interface_id`, so the text is generated from the profile rather than written a second time by hand.
 *
 * The renderer is strict, as arm B's notes are: a tag, a tag argument or an argument value it has no sentence for
 * throws, so a spec change cannot silently produce a guide that leaves something out. It is a pure function of the
 * resolved form and the given refs: the same input gives the same bytes, with no clock, no network and no version.
 */

const FORMAT = "candid-profile-resolved";

/** The arguments each value tag may carry. `ui` is for UIs only (spec 5.1) and gets no sentence. */
const POSITION_TAG_ARGS = {
  amount: ["decimals", "symbol", "threshold", "message"],
  timestamp: ["unit", "epoch", "threshold", "message", "labels"],
  duration: ["unit"],
  account: ["encoding"],
  subaccount: [],
  bytes: ["encoding", "max_len"],
  default: ["value", "mode"],
  describe: ["label", "help"],
  text: ["format", "max_len", "pattern"],
  range: ["min", "max", "min_len", "max_len"],
  named: ["set", "by"],
  ui: null,
  // a case address may carry these two (D-053)
  intent: ["title", "template"],
  effect: ["kind", "irreversible", "replicated", "grant"],
};
const METHOD_TAG_ARGS = {
  describe: ["label", "help"],
  intent: ["title", "template"],
  effect: ["kind", "irreversible", "replicated", "grant"],
  idempotency: ["mode", "stamp"],
  outcome: ["classes", "default"],
  list: ["cursor", "next", "items"],
  names: ["set", "items", "name", "value", "show", "kind"],
};

const UNITS = { ns: "nanoseconds", us: "microseconds", ms: "milliseconds", s: "seconds" };
const EFFECT_KINDS = ["read", "write", "transfer", "approve", "admin", "destroy"];
/** Spec 5.3: consumers MUST require a person's confirmation before a call of these kinds. */
const CONFIRM_KINDS = new Set(["transfer", "approve", "admin", "destroy"]);
const CLASS_ORDER = ["success", "already_done", "retry_same", "retry_new", "fix_input", "fail"];
const CLASS_TEXT = {
  success: "done.",
  already_done: "an identical call already executed: treat it as success, report the earlier result, and do not send it again.",
  retry_same: "transient: retry with exactly the same encoded arguments, a few times at most, with backoff.",
  retry_new: "the idempotency stamp is outside the canister's window or ahead of its clock: set a new stamp, show the person the new call, and send it only after their yes (but see rule 1 under Retries).",
  fix_input: "the input needs correcting; the error's fields say how.",
  fail: "do not retry.",
};

/** What the renderer has no sentence for. The guide is not written rather than written without it. */
export class ApiDocError extends Error {
  constructor(where, what) {
    super(`api-doc: no sentence for ${what} (${where})`);
    this.name = "ApiDocError";
    this.at = where;
  }
}
const NoSentence = ApiDocError;

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Author text in Markdown: one line, with the characters that could make a link, an emphasis or a table escaped. */
function md(text) {
  if (typeof text !== "string") throw new TypeError("api-doc: text expected");
  return text.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/[\\`*_[\]<>|#]/g, (c) => `\\${c}`);
}
/** A literal in a code span; a backtick inside makes the span longer, as CommonMark allows. */
function code(text) {
  const s = String(text).replace(/[\r\n\u2028\u2029]+/g, " ");
  const runs = s.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(0, ...runs.map((r) => r.length)) + 1);
  const pad = s.startsWith("`") || s.endsWith("`") ? " " : "";
  return `${fence}${pad}${s}${pad}${fence}`;
}
const joinOr = (items) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} or ${items.at(-1)}`);

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function isDynamic(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && typeof value.from === "string";
}

/** A tag argument as words: a literal as given, a dynamic value from `refs`, or what to ask the canister for. */
function valueText(where, value, refs) {
  if (!isDynamic(value)) return { known: true, value };
  const from = value.from;
  if (Object.hasOwn(refs, from)) return { known: true, value: refs[from] };
  if (from.startsWith("query:")) return { known: false, text: `what ${code(from.slice(6))} returns` };
  if (from === "now") return { known: false, text: "the canister's current time (not your own clock)" };
  if (from === "caller") return { known: false, text: "the caller's principal" };
  throw new NoSentence(where, `the dynamic value ${JSON.stringify(from)}`);
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

function checkArgs(where, tag, args, allowed) {
  if (!Object.hasOwn(allowed, tag)) throw new NoSentence(where, `the tag \`${tag}\``);
  if (allowed[tag] === null) return;
  for (const key of Object.keys(args ?? {})) if (!allowed[tag].includes(key)) throw new NoSentence(where, `the argument \`${key}\` of the tag \`${tag}\``);
}

/** Sentences for the value tags of one position. `ctx.used` collects the legend entries the guide needs. */
function positionFacts(where, node, ctx) {
  const tags = node.tags ?? {};
  for (const [tag, t] of Object.entries(tags)) checkArgs(where, tag, t.args, POSITION_TAG_ARGS);
  const a = (tag) => tags[tag]?.args ?? {};
  const facts = [];

  if (tags.amount) {
    const { decimals, symbol, threshold, message } = a("amount");
    const d = valueText(where, decimals, ctx.refs);
    const s = symbol === undefined ? { known: true, value: undefined } : valueText(where, symbol, ctx.refs);
    const unit = s.known ? (s.value === undefined ? "the token" : md(String(s.value))) : `the token (symbol: ${s.text})`;
    if (d.known) {
      if (!Number.isInteger(d.value) || d.value < 0 || d.value > 255) throw new NoSentence(where, `decimals ${JSON.stringify(d.value)}`);
      facts.push(`an amount of ${unit} in base units (${d.value} decimals)`);
    } else {
      facts.push(`an amount of ${unit} in base units (decimals: ${d.text})`);
    }
    if (threshold !== undefined) facts.push(`a value of ${code(threshold)} or more means ${md(message ?? "Unlimited")}`);
    ctx.used.add("amount");
  }
  if (tags.timestamp) {
    const { unit, epoch = "unix", threshold, message, labels } = a("timestamp");
    if (!Object.hasOwn(UNITS, unit) || epoch !== "unix") throw new NoSentence(where, `timestamp unit ${unit} and epoch ${epoch}`);
    facts.push(`a time, in ${UNITS[unit]} since the Unix epoch (UTC)`);
    for (const [v, word] of Object.entries(labels ?? {})) facts.push(`${code(v)} means ${md(word)}`);
    if (threshold !== undefined) facts.push(`a value of ${code(threshold)} or more means ${md(message)}`);
    ctx.used.add("time");
  }
  if (tags.duration) {
    const { unit } = a("duration");
    if (!Object.hasOwn(UNITS, unit)) throw new NoSentence(where, `duration unit ${unit}`);
    facts.push(`a length of time, in ${UNITS[unit]}`);
    ctx.used.add("time");
  }
  if (tags.account) {
    if (a("account").encoding !== "icrc1") throw new NoSentence(where, `account encoding ${a("account").encoding}`);
    facts.push("an ICRC-1 account");
    ctx.used.add("account");
  }
  if (tags.subaccount) {
    facts.push("a subaccount: exactly 32 bytes");
  }
  if (tags.bytes) {
    const { encoding, max_len } = a("bytes");
    const what = { utf8: "the UTF-8 bytes of a text", hex: "bytes, which people read and write as hex", base64: "bytes, which people read and write as base64" }[encoding];
    if (what === undefined) throw new NoSentence(where, `bytes encoding ${encoding}`);
    facts.push(what);
    if (max_len !== undefined) facts.push(`at most ${max_len} bytes`);
  }
  if (tags.text) {
    const { format, max_len, pattern } = a("text");
    const what = { plain: "plain text", markdown: "Markdown text", email: "an email address", url: "an http or https URL" }[format ?? "plain"];
    if (what === undefined) throw new NoSentence(where, `text format ${format}`);
    facts.push(what);
    if (max_len !== undefined) facts.push(`at most ${max_len} characters`);
    if (pattern !== undefined) facts.push(`matching the regular expression ${code(pattern)}`);
  }
  if (tags.range) {
    const { min, max, min_len, max_len } = a("range");
    if (min !== undefined && max !== undefined) facts.push(`from ${code(min)} to ${code(max)}${tags.amount ? " base units" : ""}`);
    else if (min !== undefined) facts.push(`at least ${code(min)}${tags.amount ? " base units" : ""}`);
    else if (max !== undefined) facts.push(`at most ${code(max)}${tags.amount ? " base units" : ""}`);
    if (min_len !== undefined && max_len !== undefined) facts.push(`a length from ${min_len} to ${max_len}`);
    else if (min_len !== undefined) facts.push(`a length of at least ${min_len}`);
    else if (max_len !== undefined) facts.push(`a length of at most ${max_len}`);
  }
  if (tags.default) {
    const { value, mode } = a("default");
    const v = valueText(where, value, ctx.refs);
    const shown = v.known ? code(v.value) : v.text;
    if (mode === "auto") facts.push(`send ${shown} here unless the person asks for something else`);
    else if (mode === "suggest") facts.push(`suggested value: ${shown}`);
    else throw new NoSentence(where, `default mode ${mode}`);
  }
  if (tags.named) {
    const { set, by = "value" } = a("named");
    const lister = ctx.nameSets.get(set);
    const field = lister?.args[by];
    if (lister === undefined || (by !== "value" && by !== "show") || typeof field !== "string") throw new NoSentence(where, `the names set ${JSON.stringify(set)} with by ${by}`);
    facts.push(`a name the person uses may stand for this value: find the one entry with that name in ${code(lister.method)} and send its ${code(field)} here (see Names)`);
    ctx.used.add("names");
  }
  return facts;
}

/** Every position below `node` that has something to say, in the resolved form's order. */
function collect(base, node, path, ctx, out) {
  const where = `${base}${path}`;
  const facts = positionFacts(where, node, ctx);
  const describe = node.tags?.describe?.args;
  const caseTags = { intent: node.tags?.intent?.args, effect: node.tags?.effect?.args };
  if (facts.length || describe || caseTags.intent || caseTags.effect) out.push({ where, node, facts, describe, caseTags });
  for (const [k, v] of Object.entries(node.fields ?? {})) collect(base, v, `${path}.${k}`, ctx, out);
  for (const [k, v] of Object.entries(node.cases ?? {})) collect(base, v, `${path}.${k}`, ctx, out);
  if (node.element) collect(base, node.element, `${path}[]`, ctx, out);
}

function effectWords(where, effect) {
  if (!EFFECT_KINDS.includes(effect.kind)) throw new NoSentence(where, `effect kind ${effect.kind}`);
  const words = [`${code(effect.kind)}${effect.irreversible ? ", irreversible" : ""}`];
  if (effect.replicated) words.push("call it as an update, not a query, so that its answer is certified");
  if (CONFIRM_KINDS.has(effect.kind)) words.push("**ask the person to confirm before you call it**");
  return words.join("; ");
}

function grantWords(where, method, grant) {
  if (grant === undefined) return undefined;
  const who = grant.spender !== undefined ? `the spender at ${code(grant.spender)}` : grant.to !== undefined ? `the recipient at ${code(grant.to)}` : null;
  if (who === null || grant.amount === undefined) throw new NoSentence(where, "a grant without spender, to or amount");
  for (const k of Object.keys(grant)) if (!["spender", "to", "amount", "ends"].includes(k)) throw new NoSentence(where, `the grant field \`${k}\``);
  const ends = grant.ends?.length ? `, until the latest of ${grant.ends.map(code).join(", ")}` : method.tags?.effect?.args?.kind === "approve" ? ", with no end" : "";
  return `Grants ${who} up to the amount at ${code(grant.amount)}${ends}. Tell the person who may take how much, and until when.`;
}

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

function defaultEffect(method) {
  return method.mode === "query" || method.mode === "composite_query" ? { kind: "read", irreversible: false } : { kind: "write", irreversible: true };
}

function renderMethod(name, method, ctx) {
  const tags = method.tags ?? {};
  for (const [tag, t] of Object.entries(tags)) checkArgs(name, tag, t.args, METHOD_TAG_ARGS);
  const lines = [`### ${code(name)} (${method.mode})`, ""];
  const describe = tags.describe?.args;
  if (describe?.label || describe?.help) lines.push([describe.label && `${md(describe.label)}.`, describe.help && md(describe.help)].filter(Boolean).join(" "), "");

  const effect = tags.effect?.args ?? defaultEffect(method);
  if (CONFIRM_KINDS.has(effect.kind)) ctx.confirm.push(name);
  const bullets = [`- Effect: ${effectWords(name, effect)}.`];
  if (tags.intent) bullets.push(`- What it does: ${md(tags.intent.args.title)}. Template: ${code(tags.intent.args.template)}, where each ${code("{path}")} is the argument at that path, in human units.`);
  const grant = grantWords(name, method, effect.grant);
  if (grant) bullets.push(`- ${grant}`);

  const positions = [];
  method.args.forEach((arg, i) => collect(name, arg, `(${i})`, ctx, positions));
  const results = [];
  method.results.forEach((res, i) => collect(`${name}->`, res, `(${i})`, ctx, results));
  const stamp = tags.idempotency?.args.stamp;
  const stampWhere = stamp === undefined ? undefined : `${name}${stamp.startsWith("(") ? stamp : `(0)${stamp.startsWith(".") ? "" : "."}${stamp}`}`;
  const positionLine = (p) => {
    const parts = [];
    if (p.describe?.label) parts.push(md(p.describe.label));
    parts.push(...p.facts);
    if (p.where === stampWhere) parts.push("the idempotency stamp (see Retries)");
    if (p.caseTags.effect) {
      parts.push(`this case's effect: ${effectWords(p.where, p.caseTags.effect)}`);
      if (CONFIRM_KINDS.has(p.caseTags.effect.kind)) ctx.confirm.push(p.where);
    }
    if (p.caseTags.intent) parts.push(`this case does: ${md(p.caseTags.intent.title)} (${code(p.caseTags.intent.template)})`);
    const help = p.describe?.help ? ` ${md(p.describe.help)}` : "";
    return `  - ${code(p.where)}${p.node.optional ? " (opt)" : ""}: ${parts.join("; ")}.${help}`;
  };
  if (positions.length) bullets.push("- Arguments:", ...positions.map(positionLine));
  if (results.length) bullets.push("- Result:", ...results.map(positionLine));

  if (tags.idempotency) {
    const { mode } = tags.idempotency.args;
    if (mode !== "replay_same_payload") throw new NoSentence(name, `idempotency mode ${mode}`);
    if (!positions.some((p) => p.where === stampWhere)) throw new NoSentence(name, `an idempotency stamp ${stamp} with no timestamp`);
    bullets.push(`- Idempotency: set ${code(stamp)} once per intent and resend exactly the same arguments on every retry (see Retries).`);
    ctx.stamped.push(name);
  } else if (method.mode === "update" && effect.kind !== "read") {
    ctx.unstamped.push(name);
  }
  if (tags.outcome) {
    const { classes = {}, default: fallback } = tags.outcome.args;
    const byClass = new Map();
    for (const [key, cls] of Object.entries(classes)) {
      if (!CLASS_ORDER.includes(cls)) throw new NoSentence(name, `outcome class ${cls}`);
      byClass.set(cls, [...(byClass.get(cls) ?? []), key]);
    }
    if (fallback !== undefined && !CLASS_ORDER.includes(fallback)) throw new NoSentence(name, `outcome class ${fallback}`);
    const items = [];
    for (const cls of CLASS_ORDER) {
      const keys = byClass.get(cls);
      if (keys) {
        items.push(`  - ${keys.map(code).join(", ")}: ${code(cls)}`);
        ctx.classes.add(cls);
      }
    }
    if (fallback !== undefined) {
      items.push(`  - ${Object.keys(classes).length ? "any other reply" : "every reply"}: ${code(fallback)}`);
      ctx.classes.add(fallback);
    } else {
      items.push(`  - any other case: ${code("fail")}`);
      ctx.classes.add("fail");
    }
    bullets.push("- Outcomes, by the case of the reply:", ...items);
  }
  if (tags.list) {
    const { cursor, next, items } = tags.list.args;
    bullets.push(`- Paged: the items are at ${code(items)}; pass the result's ${code(next)} as ${code(cursor)} to read the next page, until it is absent.`);
  }
  if (tags.names) {
    const { set, items, name: nameField, value, show, kind } = tags.names.args;
    const fields = [`${code(nameField)} is the name`, `${code(value)} the value it stands for`];
    if (show !== undefined) fields.push(`${code(show)} what to show beside the name`);
    if (kind !== undefined) fields.push(`${code(kind)} its kind`);
    bullets.push(`- Lists the names of the set ${code(set)}: the entries are the elements of ${code(items)}; in each, ${fields.join("; ")} (see Names).`);
  }
  lines.push(...bullets);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The guide
// ---------------------------------------------------------------------------

function checkResolved(resolved) {
  if (resolved === null || typeof resolved !== "object" || resolved.format !== FORMAT || resolved.format_version !== 0) {
    throw new TypeError(`renderApiDoc: a resolved form (format "${FORMAT}", format_version 0) is required`);
  }
  if (resolved.chain !== undefined) throw new TypeError(`renderApiDoc: a resolved form of chain ${JSON.stringify(resolved.chain)} has no get_api_doc; it is for Internet Computer canisters`);
  if (resolved.methods === null || typeof resolved.methods !== "object") throw new TypeError("renderApiDoc: the resolved form has no methods");
  if ((resolved.diagnostics ?? []).some((d) => d.severity === "error")) throw new TypeError("renderApiDoc: the resolved form has errors; fix the profile first");
}

/**
 * Render the `get_api_doc` text for a canister.
 *
 * @param resolved    the canister's resolved form (`resolveService(...).resolved`, or `candid-profile resolve`)
 * @param opts.refs   values of dynamic references, by their `from` (`{ "query:icrc1_decimals": 8 }`); one without a
 *                    value is written as what to ask the canister for
 * @param opts.title  the guide's heading (default "API guide")
 * @returns Markdown, ending with one newline
 */
export function renderApiDoc(resolved, opts = {}) {
  checkResolved(resolved);
  const refs = opts.refs ?? {};
  if (refs === null || typeof refs !== "object" || Array.isArray(refs)) throw new TypeError("renderApiDoc: opts.refs must be an object");
  const title = opts.title ?? "API guide";

  const names = Object.keys(resolved.methods).sort();
  const nameSets = new Map();
  for (const n of names) {
    const set = resolved.methods[n].tags?.names?.args?.set;
    if (set !== undefined) nameSets.set(set, { method: n, args: resolved.methods[n].tags.names.args });
  }
  const ctx = { refs, used: new Set(), classes: new Set(), confirm: [], stamped: [], unstamped: [], nameSets };
  const methods = names.map((n) => renderMethod(n, resolved.methods[n], ctx));

  const out = [`# ${md(title)}`, ""];
  out.push(
    "This guide is generated from the canister's Candid Profile. It says what the positions of the interface in `candid:service` mean; it does not change them. Every path below is an address of the profile spec: `method(0).field` is a field of the first argument, `method->(0).Err.Case` a case of the first result.",
    "",
    `- Interface: ${code(resolved.interface_id)}`,
  );
  for (const p of resolved.profiles ?? []) out.push(`- Profile: ${code(p.name)} (${p.origin}), ${code(p.profile_id)}`);
  out.push("");

  out.push("## Before you call", "");
  if (ctx.confirm.length) out.push(`- Ask the person to confirm before any call marked so below (${joinOr([...new Set(ctx.confirm)].map(code))}). Show what the call does, in human units, and send it only after their yes.`);
  if (ctx.used.has("amount")) out.push("- Amounts are integers in base units. Convert exactly: an amount with more fractional digits than the token has is an error, never rounded.");
  if (ctx.used.has("time")) out.push("- Times are integers since the Unix epoch, in the unit each position names. Take the current time from the canister (a recent certificate), not from your own clock.");
  if (ctx.unstamped.length) out.push(`- An update without an idempotency stamp (${joinOr(ctx.unstamped.map(code))}) whose outcome is unknown (a timeout, "may or may not have been executed") must not be sent again automatically: check whether it took effect, and ask the person.`);
  out.push("- A reply case this guide does not classify is a failure: do not retry it.", "");

  const legend = [];
  if (ctx.used.has("amount")) legend.push("- **Amount:** a whole number of base units. With d decimals, 1 token = 10^d base units, so `1.5` of a token with 8 decimals is `150_000_000`.");
  if (ctx.used.has("account")) legend.push("- **ICRC-1 account:** `record { owner : principal; subaccount : opt blob }`. People write it as the bare principal (default subaccount) or as `principal-checksum.subaccounthex`; check the checksum.");
  if (ctx.used.has("names")) legend.push("- **Names:** a name stands for a value only when exactly one entry of the set has it, compared after Unicode NFKC, lowercase and collapsed spaces. With none, or several, ask the person; never pick one. A name that is itself a valid value is that value.");
  if (legend.length) out.push("## Units and encoding", "", ...legend, "");

  if (ctx.stamped.length || ctx.classes.size) {
    out.push("## Retries", "");
    if (ctx.stamped.length) {
      out.push(`- ${joinOr(ctx.stamped.map(code))}: set the stamp once per intent, to the canister's current time, and encode the arguments once. After a timeout or an unknown outcome, send exactly the same bytes again; inside its deduplication window the canister executes the call once or answers with an ${code("already_done")} case.`);
    }
    if (ctx.classes.has("retry_new")) {
      out.push(
        `- Rule 1: if an earlier attempt had an unknown outcome and a later one returns a ${code("retry_new")} case, the window has passed and the first attempt may have executed. Look for it in the canister's history (ICRC-3 blocks since the stamp) before any new attempt, and ask the person when the history cannot settle it.`,
        "- Rule 2: after a case that reports the canister's time (ICRC-1's `CreatedInFuture` does), the new stamp must not exceed that time.",
      );
    }
    if (ctx.classes.has("retry_same")) out.push(`- Rule 3: stop ${code("retry_same")} retries before the window can close${ctx.classes.has("retry_new") ? "; then apply rule 1" : ""}.`);
    if (ctx.classes.size) out.push("- What each outcome class below means:");
    for (const cls of CLASS_ORDER) if (ctx.classes.has(cls)) out.push(`  - ${code(cls)}: ${CLASS_TEXT[cls]}`);
    out.push("");
  }

  out.push("## Methods", "", methods.join("\n\n"), "");
  return out.join("\n");
}
