/**
 * The semantic engine: index every annotation of every contributing profile by canonical position, merge the layers
 * (spec section 8) and run the per-annotation checks. For a single profile this is exactly the old
 * scripts/validate.mjs `validateFile` core, in the same order, with the same diagnostics.
 */
import { parseAddress } from "./address.mjs";
import { jcs } from "./util.mjs";
import { TagIndex, LayeredTags, positions } from "./tags.mjs";
import {
  NUMERIC, METHOD_TAGS, CASE_TAGS, CONFIRM_KINDS, STALE_CODES, VALUE_CONVERSION_TAGS, EVM_LATER_TAGS,
  checkApplicability, checkDynamic, parseTemplate, outcomeCoverage, caseTargetError, otherCase, overlap, defaultEffect,
  tokenPathError, grantError, pinError,
} from "./checks.mjs";

/** Spec section 8, highest precedence first. */
export const LAYERS = ["author", "third_party", "pack", "inferred"];
const rank = (origin) => LAYERS.indexOf(origin);

function buildLayers(entries, keep = () => true) {
  const byLayer = new Map();
  for (const e of entries) {
    if (!keep(e)) continue;
    const layer = e.item.doc.origin;
    if (!byLayer.has(layer)) byLayer.set(layer, new TagIndex());
    byLayer.get(layer).add(e.res.key, e.ann.tag, e.entry);
  }
  return new LayeredTags(LAYERS.filter((l) => byLayer.has(l)).map((name) => ({ name, index: byLayer.get(name) })));
}

/**
 * @param iface  the interface every address resolves against
 * @param items  [{ doc, pid, rebinding, bound, apply }]; `apply` marks a pack that matched a service and is applied to it;
 *   `bound` is { at, id, given }, what a profile binds to against what was given, when it is not `binds.interface_id`
 *   against the interface's id (a contract profile binds by its own ABI, spec section 15.3)
 * @param opts.attribute  add `profile` to each diagnostic (multi-profile output)
 * @returns { diagnostics, layered, ordered, stale }  `ordered` is items by precedence; `stale` the stale items
 */
export function analyzeProfiles(iface, items, { attribute = true } = {}) {
  const diagnostics = [];
  const ordered = items.map((item) => ({ ...item, diags: [] })).sort((a, b) => rank(a.doc.origin) - rank(b.doc.origin));
  for (const item of ordered) {
    item.diag = (severity, code, at, message) => {
      const d = { severity, code, at, message };
      if (attribute) d.profile = item.doc.name;
      diagnostics.push(d);
      item.diags.push(d);
    };
  }
  const boundOf = (item) => item.bound ?? { at: "binds.interface_id", id: item.doc.binds.interface_id, given: iface.interfaceId };

  // A pin (`fixed`, spec 15.4, D-058) holds the value the profile's words were written for. A profile with a pin that
  // does not hold keeps only its effects, without grants, and its pins that hold: never its words without the pin. A
  // pin's problem is always an error, never a pack annotation skipped.
  const unpinned = new Set();
  const pinFailed = (item, code, at, message) => {
    unpinned.add(item);
    item.diag("error", code, at, `${message}; this profile keeps only its effects (without grants) and its pins that hold, since its words were written for the pinned value (spec section 15.4)`);
  };
  const pins = new Map(); // position key -> { value, item, at }: every profile pins a position to one value (spec 15.4)
  const badPins = new Set(); // pin entries that do not hold, left out of the resolved form

  for (const item of ordered) {
    if (item.rebinding) {
      const { at, id, given } = boundOf(item);
      const what = at === "binds.abi" ? "ABI" : "interface";
      item.diag("warning", "W_REBOUND", at, `profile is bound to ${id} but the given ${what} is ${given}; checking whether every address still resolves`);
    }
  }

  // Pass 1: resolve every address and index tags by canonical key, one TagIndex per layer.
  const seenByLayer = new Map();
  const entries = [];
  const meta = new WeakMap(); // tag entry -> { item, at } (kept out of the entry so the resolved form stays unchanged)
  for (const item of ordered) {
    const { doc, diag } = item;
    if (!seenByLayer.has(doc.origin)) seenByLayer.set(doc.origin, new Map());
    const seen = seenByLayer.get(doc.origin);
    for (const original of doc.annotations) {
      let a = original;
      const at = a.at;
      const addr = parseAddress(at);
      const pinned = a.tag === "fixed";
      const fail = pinned ? (code, message) => pinFailed(item, code, at, message) : (code, message) => diag("error", code, at, message);
      if (!addr) { fail("E_ADDR_SYNTAX", "address does not parse"); continue; }
      if (doc.kind === "pack" && addr.kind === "type") { fail("E_PACK_TYPE_REF", "packs must use method addresses (declaration names are not standardized)"); continue; }
      const res = iface.resolve(addr);
      if (res.error) {
        // A pack applied to a service that is a narrower subtype (fewer result cases, fewer optional fields) cannot
        // address what is not there. That is expected, not an error in the pack.
        if (item.apply && !pinned) diag("info", "I_PACK_ANNOTATION_SKIPPED", at, `${a.tag}: ${res.error}`);
        else fail(res.code ?? "E_ADDR_UNRESOLVED", res.error);
        continue;
      }
      if (pinned) {
        const prev = pins.get(res.key);
        const value = String(a.args.value).toLowerCase();
        if (prev && prev.value !== value) {
          const where = prev.item === item ? `"${prev.at}"` : `profile "${prev.item.doc.name}" "${prev.at}"`;
          pinFailed(item, "E_CONFLICT", at, `fixed pins this position to ${a.args.value}, where ${where} pins it to another value`);
          continue;
        }
        if (!prev) pins.set(res.key, { value, item, at });
      }
      if (addr.kind === "type") {
        const others = (iface.aliases.get(iface.decls.get(addr.decl)) ?? []).filter((n) => n !== addr.decl);
        if (others.length) diag("warning", "W_STRUCTURAL_ALIAS", at, `declaration "${addr.decl}" is structurally identical to ${others.map((n) => `"${n}"`).join(", ")}; the tag reaches every one of them`);
      }
      const dupKey = `${a.tag}@${res.key}`;
      if (seen.has(dupKey)) {
        const prev = seen.get(dupKey);
        const where = prev.item === item ? `"${prev.a.at}"` : `profile "${prev.item.doc.name}" "${prev.a.at}"`;
        if (jcs(prev.a.args) === jcs(a.args)) diag("warning", "W_DUPLICATE", at, `duplicate ${a.tag} (same position as ${where})`);
        else if (prev.item === item) diag("error", "E_CONFLICT", at, `two different ${a.tag} annotations at the same position ("${prev.a.at}" and "${at}")`);
        else diag("error", "E_CONFLICT", at, `two different ${a.tag} annotations at the same position (profile "${prev.item.doc.name}" "${prev.a.at}" and profile "${doc.name}" "${at}")`);
        continue;
      }
      if (item.apply && a.tag === "outcome" && a.args.classes) {
        const kept = {};
        for (const [k, v] of Object.entries(a.args.classes)) {
          const r = iface.resolveRel(addr.method, "results", k);
          if (r.error || r.parent?.kind !== "variant") diag("info", "I_PACK_ANNOTATION_SKIPPED", at, `outcome "${k}": ${r.error ?? "not a variant case"}`);
          else kept[k] = v;
        }
        a = { ...a, args: { ...a.args, classes: kept } };
      }
      seen.set(dupKey, { a, item });
      const entry = { args: a.args, origin: doc.origin, profile: doc.name };
      meta.set(entry, { item, at });
      entries.push({ item, ann: a, addr, res, entry });
    }
  }
  const tags = buildLayers(entries);

  // Pass 2: per-annotation checks (needs the merged index for stamp lookups).
  // A pack applied to a service is allowed to differ from its fragment in the ways Candid subtyping allows, so an
  // annotation that no longer holds on this service is dropped with an info, not reported as an error in the pack.
  const dropped = new Set();
  const caseEntries = []; // case intents and effects, checked against each other and their method after the loop

  /** An effect against the method's mode (spec 5.3); for a case effect, the mode of the method it sits in. */
  const checkEffectMode = (m, { kind, irreversible, replicated }, diag, at) => {
    // A signed EIP-712 message (spec section 15.9) runs nothing when it is signed: any kind describes what it allows.
    if (m.mode === "message") {
      if (replicated === true) diag("error", "E_EFFECT_MODE", at, "replicated: true applies to update methods, not to a message");
      return;
    }
    if (m.mode !== "update" && m.mode !== "oneway" && kind !== "read") diag("error", "E_EFFECT_MODE", at, `${m.mode} method cannot have effect kind "${kind}"`);
    // A read-only update (D-038): a read sent as an update so that its answer goes through consensus.
    if (replicated === true) {
      if (m.mode !== "update") diag("error", "E_EFFECT_MODE", at, `replicated: true applies to update methods, not to a ${m.mode} method`);
      if (kind !== "read" || irreversible !== false) diag("error", "E_EFFECT_MODE", at, `replicated: true needs kind "read" and irreversible: false, found kind "${kind}" and irreversible: ${irreversible}`);
    }
    const replicatedRead = replicated === true && m.mode === "update" && kind === "read" && irreversible === false;
    if ((m.mode === "update" || m.mode === "oneway") && kind === "read" && !replicatedRead) {
      diag("warning", "W_EFFECT_MODE", at, `${m.mode} method declared as read${m.mode === "update" && replicated !== true ? "; a read sent as an update says irreversible: false, replicated: true" : ""}`);
    }
  };

  /** An intent template's placeholders (spec section 6); `caseAddr` is the case a case intent sits on. */
  const checkTemplate = (item, methodName, template, diag, at, caseAddr) => {
    const t = parseTemplate(template);
    if (t.error) return diag("error", "E_TEMPLATE", at, t.error);
    if (iface.chain === "evm" && t.segments) return diag("error", "E_TEMPLATE", at, "an EVM contract's template has no [ ] segments: an ABI value is never absent (spec section 15)");
    for (const p of t.placeholders) {
      const r = iface.resolveRel(methodName, "args", p.path);
      if (r.error && item.apply && p.inOptional) { // absent in this service: the optional segment renders empty (spec section 6)
        item.diag("info", "I_PACK_ANNOTATION_SKIPPED", at, `intent: {${p.path}} is absent in this service (${r.error}); its optional segment renders empty`);
        continue;
      }
      if (r.error) { diag("error", "E_TEMPLATE_PATH", at, `{${p.path}}: ${r.error}`); continue; }
      const other = caseAddr && otherCase(iface, caseAddr, p.path);
      if (other) { diag("error", "E_TEMPLATE_PATH", at, `{${p.path}}: ${other}`); continue; }
      if (!p.inOptional && iface.node(r.ref).kind === "opt") diag("warning", "W_TEMPLATE_OPTIONAL", at, `{${p.path}} is optional but sits outside a [ ] segment`);
    }
  };

  /**
   * A grant that does not hold (spec 5.3, D-056). A pack applied to a service loses only its grant, never the effect:
   * dropping the effect would leave a transfer or approve with the default effect, which needs no confirmation.
   */
  const grants = []; // effects whose grant holds, checked again once dropped tags are known
  const badGrant = (e, diag, why) => {
    if (!e.item.apply) return diag("error", "E_GRANT", e.ann.at, why);
    const { grant, ...args } = e.entry.args;
    e.entry.args = args;
    e.item.diag("info", "I_PACK_ANNOTATION_SKIPPED", e.ann.at, `effect grant dropped, the effect kept: E_GRANT: ${why}`);
  };

  const sets = new Map(); // names set -> { at, method, fields: { name, value, show?, kind? } } (spec 5.3, D-045)
  const named = []; // named positions, checked once every set is known
  for (const e of entries) {
    const { item, ann: a, addr, res } = e;
    const { doc } = item;
    const diag = !item.apply ? item.diag : (severity, code, at, message) => {
      if (severity !== "error") return item.diag(severity, code, at, message);
      dropped.add(e);
      item.diag("info", "I_PACK_ANNOTATION_SKIPPED", at, `${a.tag} dropped: ${code}: ${message}`);
    };
    const at = a.at;
    if (iface.chain === "evm" && EVM_LATER_TAGS.has(a.tag)) {
      diag("error", "E_TAG_TARGET", at, `${a.tag} is not defined for EVM contracts yet: it needs receipts, nonces or reads that a later phase adds (spec section 15)`);
      continue;
    }
    // intent and effect on a case of a variant in the arguments (spec 5.2, D-053)
    if (CASE_TAGS.has(a.tag) && !res.method) {
      const why = caseTargetError(iface, addr, res, a.tag);
      if (why) { diag("error", "E_TAG_TARGET", at, why); continue; }
      const m = iface.methods.get(addr.method);
      if (a.tag === "effect") {
        checkEffectMode(m, a.args, diag, at);
        if (a.args.grant) badGrant(e, diag, "a grant sits on the effect of a method, not of a case, in this version (D-056)");
      } else checkTemplate(item, addr.method, a.args.template, diag, at, addr);
      caseEntries.push({ e, diag });
      continue;
    }
    if (METHOD_TAGS.has(a.tag)) {
      const m = res.method;
      const methodName = addr.method;
      if (a.tag === "effect") checkEffectMode(m, a.args, diag, at);
      if (a.tag === "effect" && a.args.grant) {
        const why = grantError(iface, tags, methodName, a.args);
        if (why) badGrant(e, diag, why);
        else grants.push({ e, diag });
      }
      if (a.tag === "idempotency") {
        if (m.mode !== "update") diag("error", "E_IDEMPOTENCY_MODE", at, "idempotency applies to update methods");
        const r = iface.resolveRel(methodName, "args", a.args.stamp);
        if (r.error) diag("error", "E_ADDR_UNRESOLVED", at, `stamp: ${r.error}`);
        else {
          if (iface.node(r.ref).kind !== "opt") diag("warning", "W_STAMP_REQUIRED", at, "stamp field is not optional; the tool layer must always fill it");
          if (!tags.at(r, iface)?.timestamp) diag("error", "E_STAMP_UNTAGGED", at, `stamp field "${a.args.stamp}" needs a timestamp annotation`);
        }
      }
      if (a.tag === "outcome") {
        const classes = a.args.classes ?? {}; // left out: every reply is the default's class (spec 5.3, D-049)
        for (const k of Object.keys(classes)) {
          const r = iface.resolveRel(methodName, "results", k);
          if (r.error) diag("error", "E_ADDR_UNRESOLVED", at, `outcome "${k}": ${r.error}`);
          else if (r.parent?.kind !== "variant") diag("error", "E_OUTCOME_NOT_CASE", at, `outcome "${k}" must select a variant case`);
        }
        outcomeCoverage(iface, methodName, classes, diag, at, Boolean(a.args.default));
        if (doc.kind === "pack" && !a.args.default) diag("warning", "W_PACK_NO_DEFAULT", at, "pack outcome without default: result cases a matching canister adds (spec §7) would be unclassified");
      }
      if (a.tag === "intent") checkTemplate(item, methodName, a.args.template, diag, at);
      if (a.tag === "names") {
        const effect = tags.methodTags(methodName).effect?.args;
        const replicatedRead = m.mode === "update" && effect?.kind === "read" && effect.irreversible === false && effect.replicated === true;
        if (m.mode !== "query" && m.mode !== "composite_query" && !replicatedRead) {
          diag("error", "E_NAMES_MODE", at, `names needs a query, a composite query or a read-only update (D-038); "${methodName}" is ${m.mode}`);
        }
        if (m.args.length !== 0) diag("error", "E_NAMES_SHAPE", at, `names needs a method without arguments; "${methodName}" takes ${m.args.length}`);
        const items = iface.resolveRel(methodName, "results", a.args.items);
        const vec = items.error ? undefined : iface.unwrapOpt(items.ref).ref;
        if (items.error) diag("error", "E_ADDR_UNRESOLVED", at, `names.items: ${items.error}`);
        else if (iface.node(vec).kind !== "vec" || iface.isBlob(vec) || iface.node(iface.unwrapOpt(iface.node(vec).inner).ref).kind !== "record") {
          diag("error", "E_NAMES_SHAPE", at, `names.items must be a vec of records, found ${iface.describeType(items.ref)}`);
        } else {
          const fields = {};
          for (const k of ["name", "value", "show", "kind"]) {
            if (a.args[k] === undefined) continue;
            const r = iface.resolveRel(methodName, "results", `${a.args.items}[].${a.args[k]}`);
            if (r.error) diag("error", "E_ADDR_UNRESOLVED", at, `names.${k}: ${r.error}`);
            else fields[k] = r.ref;
          }
          if (fields.name !== undefined && iface.prim(iface.unwrapOpt(fields.name).ref) !== "text") {
            diag("error", "E_NAMES_FIELD", at, `names.name must be text, found ${iface.describeType(fields.name)}`);
          } else if (fields.name !== undefined && fields.value !== undefined) {
            const prev = sets.get(a.args.set);
            if (prev) diag("error", "E_NAMES_SET_DUPLICATE", at, `names set "${a.args.set}" is already declared at "${prev.at}"`);
            else sets.set(a.args.set, { at, method: methodName, fields });
          }
        }
      }
      if (a.tag === "list") {
        for (const [k, side] of [["cursor", "args"], ["next", "results"], ["items", "results"]]) {
          const r = iface.resolveRel(methodName, side, a.args[k]);
          if (r.error) diag("error", "E_ADDR_UNRESOLVED", at, `list.${k}: ${r.error}`);
        }
      }
      continue;
    }
    if (a.tag === "fixed") {
      const why = pinError(iface, addr, res, a.args.value);
      if (why) {
        badPins.add(e);
        pinFailed(item, why.code, at, why.message);
      }
      continue;
    }
    if (res.method) {
      if (a.tag !== "describe") diag("error", "E_TAG_TARGET", at, `${a.tag} is a value tag; address a value, not a method`);
      continue;
    }
    const err = checkApplicability(iface, a.tag, res.ref);
    if (err) diag("error", "E_TAG_NOT_APPLICABLE", at, err);
    if (a.tag === "named") named.push({ a, res, diag, at });
    if (a.tag === "amount" && a.args.token !== undefined) {
      const why = tokenPathError(iface, addr, a.args.token);
      if (why) diag("error", "E_TOKEN_PATH", at, why);
    } else if (a.tag === "amount") {
      checkDynamic(iface, a.args.decimals, "numeric", diag, at);
      checkDynamic(iface, a.args.symbol, "text", diag, at);
    }
    if (a.tag === "default") {
      if (a.args.value === "null" && iface.node(res.ref).kind !== "opt") diag("error", "E_DEFAULT_NULL", at, "default null on a non-optional value");
      if (typeof a.args.value === "object") checkDynamic(iface, a.args.value, "any", diag, at);
    }
  }

  // A named position needs its set, and the type of the field that fills it (spec 5.3, D-045).
  for (const { a, res, diag, at } of named) {
    const set = sets.get(a.args.set);
    const by = a.args.by ?? "value";
    if (!set) { diag("error", "E_NAMED_SET", at, `no names tag declares the set "${a.args.set}"`); continue; }
    const field = set.fields[by];
    if (field === undefined) { diag("error", "E_NAMED_SET", at, `names set "${a.args.set}" has no ${by} field`); continue; }
    if (iface.unwrapOpt(res.ref).ref !== iface.unwrapOpt(field).ref) {
      diag("error", "E_NAMED_TYPE", at, `named: the position is ${iface.describeType(res.ref)}, but the ${by} of set "${a.args.set}" is ${iface.describeType(field)}`);
    } else if (iface.prim(iface.unwrapOpt(res.ref).ref) === "text" && tags.at(res, iface)?.text?.args?.pattern === undefined) {
      diag("warning", "W_NAMED_UNPATTERNED", at, `named text without a text.pattern: every input is looked up as a name first, so a name could stand in for a value (spec 5.3)`);
    }
  }

  // Tagged cases of one method must not overlap, and a case effect needs a method effect at least as strong
  // (spec 5.2 and 5.3, D-053).
  for (let j = 0; j < caseEntries.length; j++) {
    const { e, diag } = caseEntries[j];
    const { addr, ann: a } = e;
    for (const { e: prev } of caseEntries.slice(0, j)) {
      if (prev.ann.tag !== a.tag || prev.addr.method !== addr.method || prev.res.key === e.res.key) continue;
      const why = overlap(iface, prev.addr, addr);
      if (why) diag("error", "E_CASE_OVERLAP", a.at, `${a.tag} on "${prev.ann.at}" and on "${a.at}": one call can take both cases (${why})`);
    }
    if (a.tag !== "effect") continue;
    const m = iface.methods.get(addr.method);
    const declared = tags.methodTags(addr.method).effect?.args;
    const method = declared ?? defaultEffect(m.mode);
    const whose = `the method's effect is ${method.kind}${method.irreversible ? ", irreversible" : ""}${declared ? "" : " (the default)"}`;
    if (CONFIRM_KINDS.has(a.args.kind) && !CONFIRM_KINDS.has(method.kind)) {
      diag("error", "E_CASE_EFFECT", a.at, `case effect ${a.args.kind} needs a person's confirmation, but ${whose}; declare the method's effect as transfer, approve, admin or destroy, so that a consumer that reads only method tags confirms it too`);
    } else if (a.args.irreversible === true && method.irreversible !== true) {
      diag("error", "E_CASE_EFFECT", a.at, `case effect is irreversible, but ${whose}; a method with an irreversible case is irreversible`);
    }
  }

  // Dropping a value tag can leave an idempotency stamp without its timestamp tag: drop that idempotency too. It can
  // also leave a grant without the amount, timestamp or account tag it needs.
  if (dropped.size) {
    const without = buildLayers(entries, (e) => !dropped.has(e));
    for (const { e, diag } of grants) {
      const why = !dropped.has(e) && grantError(iface, without, e.addr.method, e.entry.args);
      if (why) badGrant(e, diag, `${why} (a tag it needs was dropped in this service)`);
    }
    for (const e of entries) {
      if (!e.item.apply || e.ann.tag !== "idempotency" || dropped.has(e)) continue;
      const r = iface.resolveRel(e.addr.method, "args", e.ann.args.stamp);
      if (!r.error && !without.at(r, iface)?.timestamp) {
        dropped.add(e);
        e.item.diag("info", "I_PACK_ANNOTATION_SKIPPED", e.ann.at, `idempotency dropped: the stamp field "${e.ann.args.stamp}" has no timestamp tag in this service`);
      }
    }
  }

  // Binding (spec sections 7 and 15.3): a canister or contract profile whose interface changed is stale when anything
  // no longer holds.
  const stale = new Set(ordered.filter((item) => item.rebinding && item.diags.some((d) => STALE_CODES.has(d.code))));
  // A stale profile must not supply value-conversion tags, and a dropped pack annotation is not applied: keep both
  // out of the merged result. A profile with a pin that does not hold supplies its effects, without grants, and its
  // pins that hold (spec 15.4, D-058).
  for (const e of entries) {
    if (!unpinned.has(e.item) || e.ann.tag !== "effect" || e.entry.args.grant === undefined) continue;
    const { grant, ...args } = e.entry.args;
    e.entry.args = args;
  }
  const keep = (e) => !dropped.has(e) && !badPins.has(e) && !(stale.has(e.item) && VALUE_CONVERSION_TAGS.has(e.ann.tag)) && !(unpinned.has(e.item) && e.ann.tag !== "effect" && e.ann.tag !== "fixed");
  const final = stale.size || dropped.size || unpinned.size ? buildLayers(entries, keep) : tags;

  // Overrides: the same tag at the same position in a lower layer (W_OVERRIDDEN, spec section 8).
  if (final.layers.length > 1) {
    const overrides = new Map();
    const note = (cands, display) => {
      for (const [tag, list] of Object.entries(cands)) {
        const winner = list[0];
        for (const loser of list.slice(1)) {
          const w = meta.get(winner);
          const l = meta.get(loser);
          const key = `${tag}|${l.item.doc.name}|${l.at}|${w.item.doc.name}|${w.at}`;
          const o = overrides.get(key);
          if (o) o.positions++;
          else overrides.set(key, { tag, winner, loser, w, l, positions: 1, first: display });
        }
      }
    };
    for (const [name] of iface.methods) {
      note(final.candidatesAtMethod(name), name);
      for (const side of ["args", "results"]) for (const pos of positions(iface, name, side)) note(final.candidates(pos, iface), pos.display);
    }
    for (const o of overrides.values()) {
      const where = o.positions > 1 ? `${o.positions} positions, first ${o.first}` : o.first;
      o.l.item.diag("warning", "W_OVERRIDDEN", o.l.at, `${o.tag} from profile "${o.l.item.doc.name}" (${o.loser.origin}) is overridden by profile "${o.w.item.doc.name}" (${o.winner.origin}) at "${o.w.at}" [${where}]`);
    }
  }

  // Coverage hint: numeric positions in the arguments of update methods and EIP-712 messages with no meaning attached
  // (merged view).
  const MEANING = ["amount", "timestamp", "duration", "describe", "range"];
  for (const [name, m] of iface.methods) {
    if (m.mode !== "update" && m.mode !== "message") continue;
    for (const pos of positions(iface, name, "args")) {
      const p = iface.prim(iface.unwrapOpt(pos.ref).ref);
      const t = final.at(pos, iface);
      if (NUMERIC.has(p) && !MEANING.some((x) => t?.[x])) diagnostics.push({ severity: "info", code: "I_UNTAGGED_NUMERIC", at: pos.display, message: `${p} argument without amount/timestamp/duration/describe` }); // about the merged interface, so no profile
    }
  }

  for (const item of stale) {
    item.diag("error", "E_STALE", boundOf(item).at, "the interface changed and some annotations no longer hold; value-conversion tags must not be used (the resolved form omits this profile's value-conversion tags)");
  }
  return { diagnostics, layered: final, ordered, stale };
}
