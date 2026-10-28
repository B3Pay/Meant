/**
 * Names (spec section 5.3, D-045): the one normalization and the one resolution rule every consumer uses to turn a
 * name ("my Savings" without the "my") into the value a `names` set gives for it.
 */

/** Unicode NFKC, the default full lowercase mapping, White_Space runs made one space, then trimmed. */
export function normalizeName(text) {
  return text.normalize("NFKC").toLowerCase().replace(/\p{White_Space}+/gu, " ").trim();
}

/**
 * Resolves `input` against a set's entries.
 *
 * @param entries  [{ name, value, show?, kind? }] as the set's method lists them
 * @param input    the text a person or an agent gave
 * @param opts.isValue  whether a text is a valid value of the position by its own tags and type
 * @param opts.kind     when given, only entries for which kind(entry.kind) is true can match
 * @param opts.by       "value" (default) or "show": which field of the entry fills the position
 * @returns { value, direct: true } for input that is a value; { value, entry } for one match;
 *          { error: "not_found" } or { error: "ambiguous", entries } otherwise
 */
export function resolveName(entries, input, { isValue = () => false, kind, by = "value" } = {}) {
  if (isValue(input)) return { value: input, direct: true };
  const want = normalizeName(input);
  if (!want) return { error: "not_found" };
  const found = entries.filter((e) => {
    const name = normalizeName(e.name);
    return name !== "" && name === want && !isValue(e.name) && (!kind || kind(e.kind));
  });
  if (found.length === 0) return { error: "not_found" };
  if (found.length > 1) return { error: "ambiguous", entries: found };
  return { value: by === "show" ? found[0].show : found[0].value, entry: found[0] };
}

/**
 * A Candid value as one comparable text: numbers and bigints by their digits, bytes by their content, records with
 * their fields in order of name. Two values have the same key exactly when they are the same Candid value.
 */
function valueKey(value) {
  return JSON.stringify(value, (_, v) => {
    if (typeof v === "bigint" || typeof v === "number") return `#${v}`;
    if (ArrayBuffer.isView(v)) return `0x${Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), (b) => b.toString(16).padStart(2, "0")).join("")}`;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]));
    return v;
  });
}

/** The one entry with a name that `value` belongs to, compared as Candid values (an account by owner and subaccount); undefined if none or several. */
export function ownerOf(entries, value, { by = "value" } = {}) {
  const key = valueKey(value);
  const owners = entries.filter((e) => valueKey(by === "show" ? e.show : e.value) === key && normalizeName(e.name) !== "");
  return owners.length === 1 ? owners[0] : undefined;
}

/** The display of a named position's value: the name of the one entry it belongs to, then the shown value. */
export function nameOf(entries, value, { by = "value", show = String } = {}) {
  const owner = ownerOf(entries, value, { by });
  return owner ? `${owner.name} (${show(owner.show ?? value)})` : show(value);
}
