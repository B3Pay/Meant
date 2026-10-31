/* @ds-bundle: {"format":4,"namespace":"MeantChains","components":[{"name":"SigningSheet"},{"name":"RefusalPanel"},{"name":"TermsCard"},{"name":"GrantSummary"},{"name":"RequestTag"},{"name":"EffectBadge"},{"name":"FieldList"},{"name":"DomainCheck"},{"name":"CalldataView"},{"name":"Provenance"},{"name":"Notice"},{"name":"ChainBadge"},{"name":"Address"},{"name":"TokenAmount"},{"name":"TimeValue"},{"name":"HashChip"},{"name":"AmountField"},{"name":"ChainSupport"},{"name":"OutcomePill"},{"name":"Button"}]} */
/* Meant Chains: markup and behavior for the screens where a person reads what
   an EVM or ICP request means before anyone signs it. No framework: each
   component has html(options) returning its exact markup, and
   MeantChains.init(root) wires what moves (copy, expand, the amount field and
   the action buttons). Values are shown as the @meantjs packages write them;
   nothing here rounds, guesses a token's decimals, signs or sends. */
(function () {
  "use strict";

  var esc = function (value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  var join = function (list, fn) {
    return (list || []).map(fn).join("");
  };
  var uid = 0;
  var nextId = function (prefix) {
    uid += 1;
    return prefix + "-" + uid;
  };

  /* Icons: Meant's 24-unit grid, 2px round stroke, currentColor. copy, check,
     warn, danger and note are Meant Docs' own; send, sign, expand, collapse
     and lock are drawn on the same grid for this system. */
  var SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var ICON = {
    copy: SVG + '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    check: SVG + '<path d="m20 6-11 11-5-5"/></svg>',
    warn: SVG + '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>',
    danger: SVG + '<circle cx="12" cy="12" r="9"/><path d="m15 9-6 6M9 9l6 6"/></svg>',
    note: SVG + '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
    send: SVG + '<path d="M4 12h15M13 6l6 6-6 6"/></svg>',
    sign: SVG + '<path d="M3 16c2-5 4-8 5.5-8 2 0 .5 6 2.5 6 1.5 0 2-3 3.5-3s1.5 2.5 4 2.5"/><path d="M3 20h18"/></svg>',
    expand: SVG + '<path d="m7 9 5-5 5 5M7 15l5 5 5-5"/></svg>',
    collapse: SVG + '<path d="m7 4 5 5 5-5M7 20l5-5 5 5"/></svg>',
    lock: SVG + '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
  };

  /* Check glyphs on a 12-unit grid: passed, failed, not checked. */
  var CHECK = {
    ok: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.6 6.3 5 8.6l4.4-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    fail: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3.2 3.2l5.6 5.6M8.8 3.2 3.2 8.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
    none: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 6h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  };

  /* Outcome glyphs, exactly Meant Docs': one shape per class. */
  var GLYPH = {
    success: '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="currentColor"/></svg>',
    already_done:
      '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="6" cy="6" r="2" fill="currentColor"/></svg>',
    retry_same:
      '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M9.6 4.3A4 4 0 1 0 10 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M10 1.6v2.9H7.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    retry_new:
      '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M9.6 4.3A4 4 0 1 0 10 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M10 1.6v2.9H7.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="6.8" r="1.4" fill="currentColor"/></svg>',
    fix_input: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1L11 6L6 11L1 6Z" fill="currentColor"/></svg>',
    fail: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 2.5L9.5 9.5M9.5 2.5L2.5 9.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    reconcile:
      '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.2 4.3a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="6" cy="10" r=".9" fill="currentColor"/></svg>',
  };
  var OUTCOMES = ["success", "already_done", "retry_same", "retry_new", "fix_input", "fail", "reconcile"];
  var DOES = {
    success: "Report it done.",
    already_done: "Report the earlier result. Never pay again.",
    retry_same: "Resend the same signed bytes.",
    retry_new: "Rebuild, and ask the person to confirm again.",
    fix_input: "Show the hint and ask for a corrected value.",
    fail: "Stop. Do not retry.",
    reconcile: "Check the history before anything else.",
  };

  /* ------------------------------------------------------------- values */

  var EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
  var HEX = /^0x[0-9a-fA-F]+$/;
  var HEX32 = /^0x[0-9a-fA-F]{64}$/;
  var PRINCIPAL = /^(?:[a-z2-7]{5}-)+[a-z2-7]{1,5}$/;
  var ACCOUNT = /^(?:[a-z2-7]{5}-)+[a-z2-7]{1,5}-[a-z2-7]{7}\.[0-9a-f]{1,64}$/;
  var CONTRACT_RE = /^(0x[0-9a-fA-F]{40}) on chain ([0-9]+)$/;
  var TOKEN_AMOUNT_RE = /^(.+) \((0x[0-9a-fA-F]{40})\)$/;
  var TIME_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?: [0-9]{2}:[0-9]{2}:[0-9]{2} UTC|T[0-9]{2}:[0-9]{2}:[0-9]{2}Z)$/;
  var TIME_WORDS = { Never: "never", now: "now", "Only in the block it is used": "block" };

  var kindOf = function (value) {
    var v = String(value == null ? "" : value);
    if (EVM_ADDRESS.test(v)) return "evm";
    if (HEX.test(v)) return "hex";
    if (ACCOUNT.test(v)) return "account";
    if (PRINCIPAL.test(v)) return "principal";
    return "text";
  };

  var shortHex = function (v) {
    return v.length <= 14 ? v : v.slice(0, 6) + "…" + v.slice(-4);
  };
  var shortPrincipal = function (v) {
    var g = v.split("-");
    return g.length <= 4 ? v : g[0] + "-…-" + g.slice(-2).join("-");
  };
  var shortOf = function (v, kind) {
    if (kind === "evm" || kind === "hex") return shortHex(v);
    if (kind === "principal") return shortPrincipal(v);
    if (kind === "account") {
      var dot = v.indexOf(".");
      var sub = v.slice(dot + 1);
      return shortPrincipal(v.slice(0, dot)) + "." + (sub.length > 8 ? sub.slice(0, 4) + "…" + sub.slice(-4) : sub);
    }
    return v.length > 24 ? v.slice(0, 12) + "…" + v.slice(-8) : v;
  };

  /* Groups for checking character by character, ink and ink-muted in turn.
     Hex goes in fours after its 0x; a principal keeps its own dashes. The
     groups are spaced by margin, so selected text copies without spaces. */
  var span = function (text, i, extra) {
    return '<span class="mc-g' + (i % 2 ? " mc-g--alt" : "") + (extra || "") + '">' + esc(text) + "</span>";
  };
  var grouped = function (v, kind) {
    if (kind === "evm" || kind === "hex") {
      return '<span class="mc-g mc-g--prefix">0x</span>' + join(v.slice(2).match(/.{1,4}/g), function (g, i) { return span(g, i); });
    }
    if (kind === "plain") return join(v.match(/.{1,4}/g), function (g, i) { return span(g, i); });
    if (kind === "principal" || kind === "account") {
      var dot = v.indexOf(".");
      var main = dot > 0 ? v.slice(0, dot) : v;
      var out = join(main.split("-"), function (g, i) {
        return (i ? '<span class="mc-g-sep">-</span>' : "") + span(g, i, " mc-g--tight");
      });
      if (dot > 0) {
        out += '<span class="mc-g-sep">.</span>' + join(v.slice(dot + 1).match(/.{1,8}/g), function (g, i) { return span(g, i + 1, " mc-g--tight"); });
      }
      return out;
    }
    return esc(v);
  };

  /* Exact base units to text, as @meantjs/format's displayAmount writes them:
     trailing fractional zeros removed, nothing rounded. */
  var formatUnits = function (units, decimals) {
    var s = String(units);
    var neg = s.charAt(0) === "-";
    if (neg) s = s.slice(1);
    var d = Number(decimals);
    if (!/^[0-9]+$/.test(s) || !(d >= 0 && d <= 255 && Math.floor(d) === d)) {
      throw new Error("formatUnits needs base units as a decimal string and decimals from 0 to 255");
    }
    s = s.replace(/^0+(?=[0-9])/, "");
    while (s.length < d + 1) s = "0" + s;
    var whole = s.slice(0, s.length - d);
    var frac = s.slice(s.length - d).replace(/0+$/, "");
    return (neg && /[1-9]/.test(s) ? "-" : "") + whole + (frac ? "." + frac : "");
  };

  /* Human text to exact base units: the grammar and messages of
     @meantjs/format's parseAmount, for live feedback in AmountField. The units
     a request carries come from @meantjs/format itself, which also checks the
     integer type's range. */
  var AMOUNT_RE = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:\s+(\S(?:.*\S)?))?$/s;
  var asciiLower = function (s) {
    return s.replace(/[A-Z]/g, function (c) { return c.toLowerCase(); });
  };
  var parseAmount = function (input, o) {
    o = o || {};
    var d = Number(o.decimals);
    var expected = o.symbol || undefined;
    var candid = o.candid || "nat";
    var signed = o.signed != null ? !!o.signed : /^int/.test(candid);
    var text = String(input == null ? "" : input).trim();
    var m = AMOUNT_RE.exec(text);
    if (!m) {
      return {
        ok: false,
        code: "E_SYNTAX",
        message: "cannot read " + JSON.stringify(text) + ' as an amount: write digits with an optional decimal point, for example "1.5"' + (expected ? ' or "1.5 ' + expected + '"' : "") + '; no thousands separators, exponents or signs other than "-"',
      };
    }
    var sign = m[1];
    var whole = m[2];
    var frac = m[3] || "";
    var given = m[4];
    if (sign && !signed) {
      var word = /^uint[0-9]+$/.test(candid) ? "ABI type" : "Candid type";
      return { ok: false, code: "E_NEGATIVE", message: "negative amounts are not allowed here (the " + word + " " + candid + " is unsigned)" };
    }
    if (given !== undefined) {
      if (expected === undefined) return { ok: false, code: "E_SYMBOL_MISMATCH", message: 'this amount has no symbol; remove "' + given + '" and give the number only' };
      if (asciiLower(given) !== asciiLower(expected)) return { ok: false, code: "E_SYMBOL_MISMATCH", message: 'the symbol "' + given + '" is not this token\'s symbol "' + expected + '"' };
    }
    if (frac.length > d) {
      return {
        ok: false,
        code: "E_EXCESS_PRECISION",
        message: JSON.stringify(text) + " has " + frac.length + " fractional digits but this token has " + d + "; amounts are never rounded, so give at most " + d,
      };
    }
    var padded = frac;
    while (padded.length < d) padded += "0";
    var digits = (whole + padded).replace(/^0+(?=[0-9])/, "");
    return { ok: true, units: (sign && digits !== "0" ? "-" : "") + digits };
  };

  var pad2 = function (n) {
    return (n < 10 ? "0" : "") + n;
  };
  /* Seconds since the Unix epoch, as the generic consent text writes them. */
  var utc = function (seconds) {
    var ms = Number(seconds) * 1000;
    if (!isFinite(ms) || Math.abs(ms) > 8.64e15) return String(seconds) + " s";
    var t = new Date(ms);
    return t.getUTCFullYear() + "-" + pad2(t.getUTCMonth() + 1) + "-" + pad2(t.getUTCDate()) + " " + pad2(t.getUTCHours()) + ":" + pad2(t.getUTCMinutes()) + ":" + pad2(t.getUTCSeconds()) + " UTC";
  };
  /* Seconds to an ISO 8601 duration, as @meantjs/format's displayDuration writes it: "P1DT2H3M4S". */
  var durationOf = function (seconds) {
    var s = String(seconds);
    if (!/^[0-9]+$/.test(s)) return s;
    var v = BigInt(s);
    var zero = BigInt(0);
    var day = BigInt(86400);
    var hour = BigInt(3600);
    var min = BigInt(60);
    var d = v / day;
    var h = (v % day) / hour;
    var m = (v % hour) / min;
    var sec = v % min;
    var t = (h > zero ? h + "H" : "") + (m > zero ? m + "M" : "") + (sec > zero ? sec + "S" : "");
    var out = d > zero ? d + "D" : "";
    if (!out && !t) t = "0S";
    return "P" + out + (t ? "T" + t : "");
  };
  var isoOf = function (seconds) {
    var ms = Number(seconds) * 1000;
    return isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString().replace(".000Z", "Z") : "";
  };
  var lookup = function (map, address) {
    if (!map || address == null) return undefined;
    if (map[address] !== undefined) return map[address];
    var low = String(address).toLowerCase();
    for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k) && k.toLowerCase() === low) return map[k];
    return undefined;
  };

  var copyButton = function (value, label) {
    var l = label || "Copy";
    return '<button type="button" class="mc-copy" data-mc-copy="' + esc(value) + '" aria-label="' + esc(l) + '" title="' + esc(l) + '">' + ICON.copy + "</button>";
  };
  var checkHtml = function (state, text) {
    var s = CHECK[state] ? state : "none";
    return '<span class="mc-check" data-state="' + s + '">' + CHECK[s] + "<span>" + esc(text) + "</span></span>";
  };
  /* A sheet's title is an h2 unless the host's outline needs another level. */
  var heading = function (level, id, text) {
    var n = Math.min(6, Math.max(2, Number(level) || 2));
    return "<h" + n + ' class="mc-sheet-title" id="' + id + '">' + esc(text) + "</h" + n + ">";
  };
  var labelHtml = function (text) {
    return '<span class="mc-label">' + esc(text) + "</span>";
  };

  var M = {
    icons: ICON,
    checks: CHECK,
    glyphs: GLYPH,
    outcomes: OUTCOMES,
    escape: esc,
    formatUnits: formatUnits,
    parseAmount: parseAmount,
    utc: utc,
    duration: durationOf,
    shorten: function (value, kind) {
      var v = String(value == null ? "" : value);
      return shortOf(v, kind || kindOf(v));
    },
  };

  /* ------------------------------------------------------------- actions */

  M.Button = {
    /* variant: primary | secondary | quiet; action: fires mc:<action> */
    html: function (o) {
      o = o || {};
      var v = o.variant === "secondary" || o.variant === "quiet" ? o.variant : "primary";
      return (
        '<button type="' + (o.type === "submit" ? "submit" : "button") + '" class="mc-button" data-variant="' + v + '"' +
        (o.id ? ' id="' + esc(o.id) + '"' : "") +
        (o.action ? ' data-mc-action="' + esc(o.action) + '"' : "") +
        (o.disabled ? " disabled" : "") +
        ">" + (o.icon && ICON[o.icon] ? ICON[o.icon] : "") + "<span>" + esc(o.label) + "</span></button>"
      );
    },
  };

  /* -------------------------------------------------------------- values */

  var FAMILIES = {
    evm: { code: "EVM", name: "EVM" },
    icp: { code: "ICP", name: "Internet Computer" },
    sol: { code: "SOL", name: "Solana" },
  };

  M.ChainBadge = {
    families: FAMILIES,
    /* family: evm | icp | sol; id: the chain id; name: the wallet's own name for it; network: main | test | local */
    html: function (o) {
      o = o || {};
      var f = FAMILIES[o.family] ? o.family : "evm";
      var net = o.network === "test" ? "testnet" : o.network === "local" ? "local" : "";
      var title = FAMILIES[f].name + (o.id != null ? " chain " + o.id : "") + (o.name ? ", " + o.name : "") + (net ? " (" + net + ")" : "");
      return (
        '<span class="mc-chain" data-family="' + f + '"' + (net ? ' data-network="' + esc(o.network) + '"' : "") + ' title="' + esc(title) + '">' +
        '<span class="mc-chain-code">' + FAMILIES[f].code + "</span>" +
        (o.id != null ? '<span class="mc-chain-id">' + esc(o.id) + "</span>" : "") +
        (o.name ? '<span class="mc-chain-name">' + esc(o.name) + "</span>" : "") +
        (net ? '<span class="mc-chain-net">' + net + "</span>" : "") +
        "</span>"
      );
    },
  };

  M.Address = {
    short: function (value, kind) {
      var v = String(value == null ? "" : value);
      return shortOf(v, kind || kindOf(v));
    },
    grouped: function (value, kind) {
      var v = String(value == null ? "" : value);
      return grouped(v, kind || kindOf(v));
    },
    /* value: the full text; name: the wallet's name for it; mode: short | full; expand, copy */
    html: function (o) {
      o = o || {};
      var v = String(o.value == null ? "" : o.value);
      var kind = o.kind || kindOf(v);
      var full = o.mode === "full";
      return (
        '<span class="mc-address' + (full ? " mc-address--full" : "") + (o.name ? " mc-address--named" : "") + '" data-kind="' + kind + '" data-value="' + esc(v) + '">' +
        (o.name ? '<span class="mc-address-name">' + esc(o.name) + "</span>" : "") +
        '<span class="mc-address-text" title="' + esc(v) + '">' + (full ? grouped(v, kind) : esc(shortOf(v, kind))) + "</span>" +
        (o.expand && !full && shortOf(v, kind) !== v
          ? '<button type="button" class="mc-copy" data-mc-expand aria-expanded="false" aria-label="Show the whole address" title="Show the whole address">' + ICON.expand + "</button>"
          : "") +
        (o.copy === false ? "" : copyButton(v, o.label || "Copy address")) +
        "</span>"
      );
    },
  };

  M.TokenAmount = {
    /* text: the library's display text ("1.5 TKA", "Unlimited TKA", "1.5 TKA (0x…)"),
       or units + decimals + symbol; token: the token's address when a field names it */
    html: function (o) {
      o = o || {};
      var value;
      var symbol = o.symbol || "";
      var token = o.token;
      if (o.text == null && o.units != null) {
        value = o.unlimited ? "Unlimited" : formatUnits(o.units, o.decimals);
      } else {
        var t = String(o.text == null ? "" : o.text);
        var m = TOKEN_AMOUNT_RE.exec(t);
        if (m) {
          t = m[1];
          if (!token) token = m[2];
        }
        var sp = t.lastIndexOf(" ");
        value = sp > 0 ? t.slice(0, sp) : t;
        if (sp > 0 && !o.symbol) symbol = t.slice(sp + 1);
      }
      var unlimited = !!o.unlimited || value === "Unlimited";
      var size = o.size === "sm" ? "sm" : "md";
      return (
        '<span class="mc-amount mc-amount--' + size + (unlimited ? " mc-amount--unlimited" : "") + '">' +
        '<span class="mc-amount-main">' +
        (unlimited ? '<span class="mc-amount-flag">' + ICON.warn + "</span>" : "") +
        '<span class="mc-amount-value">' + esc(value) + "</span>" +
        (symbol ? '<span class="mc-amount-symbol">' + esc(symbol) + "</span>" : "") +
        "</span>" +
        (token ? '<span class="mc-amount-token">' + M.Address.html({ value: token, label: "Copy token address" }) + "</span>" : "") +
        (o.showUnits && o.units != null ? '<span class="mc-amount-units">' + esc(o.units) + " base units" + (o.decimals != null ? " · " + esc(o.decimals) + " decimals" : "") + "</span>" : "") +
        "</span>"
      );
    },
  };

  M.TimeValue = {
    words: { never: "Never", now: "now", block: "Only in the block it is used" },
    /* kind: at | never | now | block | duration; at: seconds since the epoch; seconds: a
       duration; text: the library's text; attention; note */
    html: function (o) {
      o = o || {};
      var kind = o.kind || (o.at != null ? "at" : o.seconds != null ? "duration" : TIME_WORDS[o.text] || "at");
      var text = o.text || (kind === "at" ? utc(o.at) : kind === "duration" ? durationOf(o.seconds) : M.TimeValue.words[kind]);
      var dt = kind === "at" && o.at != null ? isoOf(o.at) : "";
      return (
        '<span class="mc-time' + (o.attention ? " mc-time--attention" : "") + '" data-kind="' + kind + '">' +
        (o.attention ? ICON.warn : "") +
        (dt ? '<time datetime="' + dt + '">' + esc(text) + "</time>" : "<span>" + esc(text) + "</span>") +
        (o.note ? '<span class="mc-time-note">' + esc(o.note) + "</span>" : "") +
        "</span>"
      );
    },
  };

  var HASH_LABELS = {
    digest: "EIP-712 digest",
    typeHash: "Type hash",
    selector: "Selector",
    descriptorHash: "descriptorHash",
    profile_id: "profile_id",
    interface_id: "interface_id",
    terms: "Terms id",
  };
  M.HashChip = {
    labels: HASH_LABELS,
    /* kind: digest | typeHash | selector | descriptorHash | profile_id | interface_id | terms; value: the whole value; mode: short | full */
    html: function (o) {
      o = o || {};
      var v = String(o.value == null ? "" : o.value);
      var label = o.label != null ? o.label : HASH_LABELS[o.kind] || "";
      var colon = v.lastIndexOf(":");
      var prefix = colon > 0 ? v.slice(0, colon + 1) : "";
      var body = colon > 0 ? v.slice(colon + 1) : v;
      var kind = HEX.test(body) ? "hex" : "plain";
      var shown = o.mode === "full" ? grouped(body, kind) : esc(kind === "hex" ? shortHex(body) : body.length > 14 ? body.slice(0, 8) + "…" + body.slice(-4) : body);
      return (
        '<span class="mc-hash' + (o.mode === "full" ? " mc-hash--full" : "") + '" data-kind="' + esc(o.kind || "") + '">' +
        (label ? '<span class="mc-hash-label">' + esc(label) + "</span>" : "") +
        '<span class="mc-hash-value" title="' + esc(v) + '">' + (prefix ? '<span class="mc-hash-prefix">' + esc(prefix) + "</span>" : "") + shown + "</span>" +
        (o.copy === false ? "" : copyButton(v, "Copy " + (label || "value"))) +
        "</span>"
      );
    },
  };

  M.AmountField = {
    parse: parseAmount,
    /* label, decimals, symbol, value, signed, candid (the integer type, default nat), id */
    html: function (o) {
      o = o || {};
      var id = o.id || nextId("mc-amount");
      return (
        '<div class="mc-amount-field" data-decimals="' + esc(o.decimals) + '" data-symbol="' + esc(o.symbol || "") + '" data-candid="' + esc(o.candid || "nat") + '"' + (o.signed ? ' data-signed=""' : "") + ">" +
        '<label class="mc-input-label" for="' + esc(id) + '">' + esc(o.label || "Amount") + "</label>" +
        '<div class="mc-input"><input id="' + esc(id) + '" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" value="' + esc(o.value || "") + '" aria-describedby="' + esc(id) + '-help">' +
        (o.symbol ? '<span class="mc-input-suffix">' + esc(o.symbol) + "</span>" : "") +
        "</div>" +
        '<p class="mc-input-help" id="' + esc(id) + '-help" aria-live="polite">At most ' + esc(o.decimals) + " decimal places. Amounts are never rounded.</p>" +
        "</div>"
      );
    },
  };

  /* ------------------------------------------------------------- request */

  var REQUEST = {
    transaction: { word: "Transaction", icon: "send" },
    signature: { word: "Signature", icon: "sign" },
    call: { word: "Canister call", icon: "send" },
  };
  M.RequestTag = {
    kinds: REQUEST,
    /* kind: transaction | signature | call; standard: "ERC-20", "EIP-712", "ICRC-21" */
    html: function (o) {
      o = o || {};
      var k = REQUEST[o.kind] ? o.kind : "transaction";
      return (
        '<span class="mc-request" data-kind="' + k + '">' + ICON[REQUEST[k].icon] + "<span>" + REQUEST[k].word + "</span>" +
        (o.standard ? '<span class="mc-request-std">' + esc(o.standard) + "</span>" : "") +
        "</span>"
      );
    },
  };

  var EFFECTS = ["read", "write", "transfer", "approve", "admin", "destroy", "irreversible"];
  M.EffectBadge = {
    effects: EFFECTS,
    asks: { read: false, write: false, transfer: true, approve: true, admin: true, destroy: true },
    /* effect: read | write | transfer | approve | admin | destroy | irreversible */
    html: function (o) {
      var e = EFFECTS.indexOf(o && o.effect) === -1 ? "write" : o.effect;
      return '<span class="mc-effect" data-effect="' + e + '">' + e + "</span>";
    },
  };

  /* One field's value, by its type or, for the consent package's fields form
     ([label, text] pairs), by the shape of its text. */
  var fieldValue = function (f) {
    var text = f.text != null ? String(f.text) : "";
    var type = f.type;
    var amounts = text.indexOf("), ") > 0 ? text.split("), ").map(function (p, i, all) { return i < all.length - 1 ? p + ")" : p; }) : null;
    if (!type) {
      if (amounts && amounts.every(function (p) { return TOKEN_AMOUNT_RE.test(p); })) type = "amounts";
      else if (EVM_ADDRESS.test(text)) type = "address";
      else if (HEX32.test(text)) type = "hash";
      else if (CONTRACT_RE.test(text)) type = "contract";
      else if (TOKEN_AMOUNT_RE.test(text) || /^Unlimited \S+$/.test(text) || f.units != null) type = "amount";
      else if (/\b(amount|fee)\b/i.test(String(f.label || "")) && /^-?[0-9]+(\.[0-9]+)? \S+$/.test(text)) type = "amount";
      else if (TIME_RE.test(text) || TIME_WORDS[text]) type = "time";
      else if (/, /.test(text) && text.split(", ").every(function (p) { return TIME_RE.test(p) || TIME_WORDS[p]; })) type = "times";
      else if (kindOf(text) === "principal" || kindOf(text) === "account") type = "address";
      else type = "text";
    }
    var flag = f.flag !== false;
    switch (type) {
      case "address":
        return M.Address.html({ value: f.value || text, name: f.name, expand: true });
      case "contract":
        var c = CONTRACT_RE.exec(text);
        return M.Address.html({ value: c[1], mode: "full" }) + '<span class="mc-field-sub">on chain ' + esc(c[2]) + "</span>";
      case "amount":
        return M.TokenAmount.html({ text: f.units != null ? undefined : text, units: f.units, decimals: f.decimals, symbol: f.symbol, token: f.token, unlimited: f.unlimited });
      case "time":
        return M.TimeValue.html({ text: text || undefined, at: f.at, kind: f.kind || TIME_WORDS[text], attention: f.attention != null ? f.attention : flag && text === "Never" });
      case "amounts":
        return '<span class="mc-times">' + join(amounts, function (p) { return M.TokenAmount.html({ text: p, size: "sm" }); }) + "</span>";
      case "duration":
        return M.TimeValue.html({ kind: "duration", seconds: f.seconds, text: f.seconds == null ? text : undefined });
      case "times":
        return '<span class="mc-times">' + join(text.split(", "), function (p) {
          return M.TimeValue.html({ text: p, kind: TIME_WORDS[p], attention: flag && p === "Never" });
        }) + "</span>";
      case "hash":
        return M.HashChip.html({ value: f.value || text, label: "" });
      case "raw":
        return '<span class="mc-raw">' + esc(text) + "</span>";
      default:
        return '<span class="mc-text">' + esc(text) + "</span>";
    }
  };

  /* A row as the fields form writes it: [label, text] from evmConsent and
     eip712Consent, [label, Icrc21Value] from generateConsent (ICRC-21), or an
     object the wallet added to. */
  var rowOf = function (f) {
    var row = Array.isArray(f) ? { label: f[0], text: f[1] } : f || {};
    var v = row.text;
    if (!v || typeof v !== "object") return row;
    var out = {};
    for (var k in row) if (Object.prototype.hasOwnProperty.call(row, k) && k !== "text") out[k] = row[k];
    if (v.TokenAmount) {
      out.type = "amount";
      out.units = String(v.TokenAmount.amount);
      out.decimals = v.TokenAmount.decimals;
      out.symbol = v.TokenAmount.symbol;
    } else if (v.TimestampSeconds) {
      out.type = "time";
      out.at = String(v.TimestampSeconds.amount);
    } else if (v.DurationSeconds) {
      out.type = "duration";
      out.seconds = String(v.DurationSeconds.amount);
    } else out.text = v.Text ? v.Text.content : "";
    return out;
  };

  M.FieldList = {
    /* fields: the fields form's rows as @meantjs/consent writes them, [label, text] or
       [label, Icrc21Value], or {label, text, type?, name?, token?, units?, decimals?, symbol?, attention?} */
    html: function (o) {
      o = o || {};
      return (
        '<dl class="mc-fields">' +
        join(o.fields, function (f) {
          var row = rowOf(f);
          return '<div class="mc-field"><dt>' + esc(row.label) + "</dt><dd>" + fieldValue(row) + "</dd></div>";
        }) +
        "</dl>"
      );
    },
  };

  M.DomainCheck = {
    /* domain {name, version, chainId, verifyingContract}; wallet {chainId};
       chain {name, network}; deployment {listed, profile}; message {primaryType, typeHash, matched} */
    html: function (o) {
      o = o || {};
      var d = o.domain || {};
      var w = o.wallet || {};
      var dep = o.deployment;
      var msg = o.message;
      var chain = o.chain || {};
      var sameChain = w.chainId != null && String(w.chainId) === String(d.chainId);
      var row = function (label, body) {
        return '<div class="mc-field"><dt>' + esc(label) + "</dt><dd>" + body + "</dd></div>";
      };
      return (
        '<div class="mc-domain">' +
        labelHtml("EIP-712 domain") +
        '<dl class="mc-fields">' +
        row("Name", '<span class="mc-raw">' + esc(d.name == null ? "none" : d.name) + "</span>" + '<span class="mc-field-sub">' + (d.version == null ? "no version" : "version " + esc(d.version)) + "</span>") +
        row(
          "Chain",
          M.ChainBadge.html({ family: "evm", id: d.chainId, name: chain.name, network: chain.network }) +
            checkHtml(sameChain ? "ok" : "fail", sameChain ? "The wallet is on this chain" : w.chainId == null ? "No active chain given: E_REQUEST" : "The wallet is on chain " + w.chainId + ": E_DOMAIN")
        ) +
        row(
          "Verifying contract",
          M.Address.html({ value: d.verifyingContract, mode: "full" }) +
            (dep
              ? checkHtml(dep.listed ? "ok" : "fail", dep.listed ? "Listed by " + (dep.profile ? "profile " + dep.profile : "the profile") : "Not a deployment the profile lists: E_DEPLOYMENT")
              : checkHtml("none", "The profile lists no deployments"))
        ) +
        (msg
          ? row(
              "Message",
              '<span class="mc-type-name">' + esc(msg.primaryType) + "</span>" +
                M.HashChip.html({ kind: "typeHash", value: msg.typeHash }) +
                checkHtml(msg.matched === false ? "fail" : "ok", msg.matched === false ? "No message has this type hash: E_TYPE_HASH" : "Matched by its type hash, never by its name")
            )
          : "") +
        "</dl></div>"
      );
    },
  };

  /* Split a canonical signature into its name and "type name" parameters. */
  var splitSignature = function (sig) {
    var open = sig.indexOf("(");
    if (open < 0) return { name: sig, params: [] };
    var inner = sig.slice(open + 1, sig.lastIndexOf(")"));
    var params = [];
    var depth = 0;
    var cur = "";
    for (var i = 0; i < inner.length; i++) {
      var ch = inner.charAt(i);
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        params.push(cur);
        cur = "";
      } else cur += ch;
    }
    if (cur) params.push(cur);
    return { name: sig.slice(0, open), params: params };
  };

  M.CalldataView = {
    /* "0x" + selector + 32-byte words, split for display */
    words: function (data) {
      var hex = String(data || "").replace(/^0x/, "");
      return { selector: "0x" + hex.slice(0, 8), words: hex.slice(8).match(/.{1,64}/g) || [] };
    },
    /* data: the calldata; signature: "transfer(address to,uint256 value)"; args: [{name, type, text}] */
    html: function (o) {
      o = o || {};
      var w = M.CalldataView.words(o.data);
      var sig = splitSignature(String(o.signature || ""));
      var sigHtml =
        '<span class="mc-sig-name">' + esc(sig.name) + '</span><span class="mc-sig-punct">(</span>' +
        sig.params.map(function (p) {
          var sp = p.lastIndexOf(" ");
          return sp > 0 ? '<span class="mc-sig-type">' + esc(p.slice(0, sp)) + '</span> <span class="mc-sig-arg">' + esc(p.slice(sp + 1)) + "</span>" : '<span class="mc-sig-type">' + esc(p) + "</span>";
        }).join('<span class="mc-sig-punct">, </span>') +
        '<span class="mc-sig-punct">)</span>';
      var word = function (hexWord, i) {
        var lead = (hexWord.match(/^0*/) || [""])[0].length;
        var body = join(hexWord.match(/.{1,8}/g), function (g, j) {
          var dim = Math.max(0, Math.min(g.length, lead - j * 8));
          return '<span class="mc-wg">' + (dim ? '<span class="mc-pad">' + g.slice(0, dim) + "</span>" : "") + esc(g.slice(dim)) + "</span>";
        });
        var offset = "0x" + (i * 32).toString(16).padStart(2, "0");
        return '<li class="mc-word"><span class="mc-word-offset">' + offset + '</span><span class="mc-word-hex">' + body + "</span></li>";
      };
      return (
        '<div class="mc-calldata">' +
        '<div class="mc-calldata-sig"><span class="mc-selector" title="The first 4 bytes of the Keccak-256 of the type-only signature">' + esc(w.selector) + '</span><span class="mc-sig">' + sigHtml + "</span></div>" +
        (o.args && o.args.length
          ? '<dl class="mc-args">' + join(o.args, function (a) {
              return '<div class="mc-arg"><dt><span class="mc-sig-arg">' + esc(a.name) + '</span> <span class="mc-sig-type">' + esc(a.type) + "</span></dt><dd>" + esc(a.text) + "</dd></div>";
            }) + "</dl>"
          : "") +
        '<ol class="mc-words" aria-label="Calldata, 32-byte words after the selector">' + join(w.words, word) + "</ol>" +
        '<p class="mc-calldata-note">' + CHECK.ok + "<span>" + esc(o.note || "Decoded strictly: the values were encoded again and the bytes compared.") + "</span></p>" +
        "</div>"
      );
    },
  };

  var ORIGINS = {
    pack: { word: "Standard pack", note: "Reviewed in the Meant repository. A pack fits any contract or canister with the same interface, so the address shown above is what tells this one apart." },
    author: { word: "Author's profile", note: "The author's own claim about what their contract or canister does." },
    third_party: { word: "Third-party profile", note: "A profile this wallet chose to trust." },
    inferred: { word: "Inferred", note: "Proposed by AI. Only a suggestion until a person approves it." },
  };
  /* The consent result's provenance ({intent: {origin, profile}, profiles: [...]})
     or the flat {origin, profile, profileId}. */
  var provenanceOf = function (o) {
    if (o && o.intent && typeof o.intent === "object") {
      var p = o.intent;
      var prof = (o.profiles || []).filter(function (x) { return x.name === p.profile; })[0] || {};
      return { origin: p.origin, profile: p.profile, profileId: prof.profile_id, approved: o.approved, descriptorHash: o.descriptorHash };
    }
    return o || {};
  };
  M.Provenance = {
    origins: ORIGINS,
    /* the consent result's provenance as is, or origin: pack | author | third_party | inferred;
       profile: its name; approved (inferred); profileId; descriptorHash */
    html: function (input, opts) {
      var o = provenanceOf(input);
      var ids = !(opts && opts.ids === false);
      var origin = ORIGINS[o.origin] ? o.origin : "pack";
      var suggestion = origin === "inferred" && !o.approved;
      return (
        '<div class="mc-provenance" data-origin="' + origin + '"' + (suggestion ? " data-attention" : "") + ">" +
        labelHtml("Words from") +
        '<p class="mc-provenance-src">' + (suggestion ? ICON.warn : "") + (o.profile ? "<code>" + esc(o.profile) + "</code>" : "") + "<span>" + esc(ORIGINS[origin].word) + (origin === "inferred" ? (o.approved ? ", approved by a person" : ", not approved") : "") + "</span></p>" +
        '<p class="mc-provenance-note">' + esc(ORIGINS[origin].note) + "</p>" +
        (ids && o.profileId ? M.HashChip.html({ kind: "profile_id", value: o.profileId }) : "") +
        (ids && o.descriptorHash ? M.HashChip.html({ kind: "descriptorHash", value: o.descriptorHash }) + '<p class="mc-provenance-note">ERC-8176 attestations of this file are not checked yet.</p>' : "") +
        "</div>"
      );
    },
  };

  var TONES = { attention: "warn", danger: "danger", info: "note", ok: "check" };
  M.Notice = {
    /* tone: attention | danger | info | ok; title; text */
    html: function (o) {
      o = o || {};
      var tone = TONES[o.tone] ? o.tone : "info";
      return (
        '<div class="mc-notice" data-tone="' + tone + '" role="note"><span class="mc-notice-icon">' + ICON[TONES[tone]] + '</span><div class="mc-notice-body">' +
        (o.title ? "<strong>" + esc(o.title) + "</strong>" : "") +
        (o.text ? "<p>" + esc(o.text) + "</p>" : "") +
        "</div></div>"
      );
    },
  };

  /* -------------------------------------------------------------- screens */

  var SIGNATURE_NOTE = "This is a signature, not a transaction: whoever holds it can submit it.";
  var LIFT = { Contract: "contract", "EIP-712 digest": "digest", Signature: "signature" };

  /* The intent line: `values` of the generic form as inline code, and every
     whole EVM address, principal and account shortened, with the whole one in
     its title. */
  var inline = function (text) {
    return String(text || "")
      .split("`")
      .map(function (part, i) {
        var h = esc(part)
          .replace(/(?:[a-z2-7]{5}-){4,}[a-z2-7]{1,5}(?:-[a-z2-7]{7}\.[0-9a-f]{1,64})?/g, function (p) {
            return '<span class="mc-inline-address" title="' + p + '">' + shortOf(p, ACCOUNT.test(p) ? "account" : "principal") + "</span>";
          })
          .replace(/0x[0-9a-fA-F]{40}/g, function (a) {
            return '<span class="mc-inline-address" title="' + a + '">' + shortHex(a) + "</span>";
          })
          .replace(/[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9]{2}:[0-9]{2}:[0-9]{2}Z| [0-9]{2}:[0-9]{2}:[0-9]{2} UTC)/g, function (t) {
            return '<span class="mc-nowrap">' + t + "</span>";
          });
        return i % 2 ? '<code class="mc-inline">' + h + "</code>" : h;
      })
      .join("");
  };

  M.SigningSheet = {
    /* consent: what evmConsent, eip712Consent or generateConsent (ICRC-21) returned with
       form "fields", taken as is;
       or its parts: kind (transaction | signature | call), title, intent, effects, fields,
       digest, grant, provenance. Also chain (ChainBadge options), standard, notices,
       contract {address, chainId}, canister {id, name} on ICP, level (the title's heading
       level, 2 to 6), showGrant (the consent's
       grant, with tokens + names), who, actions {confirm, reject}, floating. Explicit
       options win over the consent's. */
    html: function (o) {
      o = o || {};
      var c = o.consent || {};
      /* generateConsent answers in ICRC-21's shape: { FieldsDisplayMessage: { intent, fields } } */
      var icrc21 = !!(c.message && (c.message.FieldsDisplayMessage || c.message.GenericDisplayMessage != null));
      var msg = c.message && c.message.FieldsDisplayMessage ? c.message.FieldsDisplayMessage : c.message && typeof c.message === "object" && !icrc21 ? c.message : {};
      var model = c.model || {};
      var kind = REQUEST[o.kind] ? o.kind : icrc21 ? "call" : c.primaryType ? "signature" : "transaction";
      var fields = [];
      var contract = o.contract;
      var digest = o.digest || c.digest;
      var grant = o.grant !== undefined ? o.grant : o.showGrant && "grant" in c ? c.grant : undefined;
      var provenance = o.provenance || c.provenance;
      var effects = o.effects || (model.effect ? [model.effect] : []);
      var chain = o.chain || (kind === "call" ? { family: "icp" } : { family: "evm", id: c.chainId });
      /* On ICP a grant's token is the canister called (generateConsent's canisterId). */
      var canister = o.canister || (kind === "call" && c.grant && c.grant.token ? { id: c.grant.token } : null);
      var note = kind === "signature" ? SIGNATURE_NOTE : "";
      (o.fields || msg.fields || []).forEach(function (f) {
        var row = rowOf(f);
        var lift = LIFT[row.label];
        if (lift === "contract") {
          var m = CONTRACT_RE.exec(String(row.text));
          if (m && !contract) contract = { address: m[1], chainId: m[2] };
          if (m) return;
        }
        if (lift === "digest") {
          if (!digest) digest = row.text;
          return;
        }
        if (lift === "signature") {
          note = String(row.text).replace(/\.?$/, ".");
          return;
        }
        fields.push(row);
      });
      /* The fields form writes the intent as "Title: line". Titles can hold a colon
         themselves ("Permit2: allow token spending"), so the title is never guessed:
         it is the one given or the model's, and without one the intent is the title. */
      var title = o.title || model.title || "";
      var line = o.intent != null ? String(o.intent) : msg.intent || "";
      if (title && line.indexOf(title + ": ") === 0) line = line.slice(title.length + 2);
      else if (!title) {
        title = line;
        line = "";
      }
      var id = nextId("mc-sheet");
      var actions = o.actions || {};
      var confirm = actions.confirm || (kind === "signature" ? "Sign" : kind === "call" ? "Confirm" : "Send");
      return (
        '<section class="mc-sheet" data-kind="' + kind + '"' + (o.floating ? " data-floating" : "") + ' aria-labelledby="' + id + '">' +
        '<header class="mc-sheet-head">' + M.ChainBadge.html(chain) + M.RequestTag.html({ kind: kind, standard: o.standard }) + "</header>" +
        '<div class="mc-sheet-intent">' + heading(o.level, id, title) +
        (line ? '<p class="mc-sheet-line">' + inline(line) + "</p>" : "") +
        (effects.length ? '<div class="mc-sheet-effects">' + join(effects, function (e) { return M.EffectBadge.html({ effect: e }); }) + "</div>" : "") +
        "</div>" +
        join(o.notices, M.Notice.html) +
        (fields.length ? M.FieldList.html({ fields: fields }) : "") +
        (contract
          ? '<div class="mc-sheet-block"><div class="mc-sheet-block-head">' + labelHtml("Contract") + '<span class="mc-field-sub">on chain ' + esc(contract.chainId) + "</span></div>" + M.Address.html({ value: contract.address, mode: "full", name: contract.name }) + "</div>"
          : "") +
        (canister
          ? '<div class="mc-sheet-block">' + labelHtml("Canister") + M.Address.html({ value: canister.id, mode: "full", name: canister.name }) + "</div>"
          : "") +
        (digest ? '<div class="mc-sheet-block">' + labelHtml("EIP-712 digest") + M.HashChip.html({ value: digest, mode: "full", label: "" }) + "</div>" : "") +
        (note ? M.Notice.html({ tone: "info", text: note }) : "") +
        (grant !== undefined ? M.GrantSummary.html({ grant: grant, tokens: o.tokens, names: o.names }) : "") +
        (provenance ? M.Provenance.html(provenance, { ids: false }) : "") +
        '<footer class="mc-sheet-foot">' +
        '<div class="mc-sheet-actions">' + M.Button.html({ label: actions.reject || "Reject", variant: "secondary", action: "reject" }) + M.Button.html({ label: confirm, action: "confirm", icon: kind === "signature" ? "sign" : "send" }) + "</div>" +
        (o.who ? '<p class="mc-sheet-who">' + esc(o.who) + "</p>" : "") +
        "</footer></section>"
      );
    },
  };

  M.GrantSummary = {
    /* grant: what @meantjs/consent returns ({kind, spender | to, token, amount, ends}) or null;
       tokens: {address: {symbol, decimals}}; names: {address: name} */
    html: function (o) {
      o = o || {};
      var g = o.grant;
      if (!g) {
        return (
          '<div class="mc-grant" data-none>' + labelHtml("What this grants") +
          '<p class="mc-grant-none">' + CHECK.none + "<span>This request has no grant a profile describes, so no terms cover it: it needs your confirmation.</span></p></div>"
        );
      }
      var party = g.kind === "approve" ? g.spender : g.to;
      var tok = lookup(o.tokens, g.token) || {};
      var amount = g.amount || {};
      var amountHtml;
      if (amount.unlimited) amountHtml = M.TokenAmount.html({ text: "Unlimited" + (tok.symbol ? " " + tok.symbol : ""), size: "sm" });
      else if (amount.units === "0") amountHtml = '<span class="mc-text">Nothing</span>';
      else if (tok.decimals != null) amountHtml = M.TokenAmount.html({ units: amount.units, decimals: tok.decimals, symbol: tok.symbol, size: "sm", showUnits: true });
      else amountHtml = '<span class="mc-raw">' + esc(amount.units) + " base units</span>";
      var ends = g.ends || {};
      var endsHtml = ends.now
        ? M.TimeValue.html({ kind: "now", text: "When it is sent" })
        : ends.never
          ? M.TimeValue.html({ kind: "never", attention: true })
          : M.TimeValue.html({ at: ends.at });
      var cell = function (label, body) {
        return '<div class="mc-grant-cell">' + labelHtml(label) + body + "</div>";
      };
      return (
        '<div class="mc-grant" data-kind="' + esc(g.kind) + '">' + labelHtml("What this grants") +
        '<div class="mc-grant-cells">' +
        cell(g.kind === "approve" ? "May spend" : "Is paid", M.Address.html({ value: party, name: lookup(o.names, party) })) +
        cell("Token", M.Address.html({ value: g.token, name: tok.symbol })) +
        cell(g.kind === "approve" ? "Up to" : "Amount", amountHtml) +
        cell("Ends", endsHtml) +
        "</div></div>"
      );
    },
  };

  var GATE = [
    { step: "Propose", who: "The agent writes the terms." },
    { step: "Confirm", who: "You confirm them on the wallet's own screen." },
    { step: "Read", who: "Only now may the agent read the request." },
    { step: "Check", who: "The wallet compares what the request grants with the terms." },
  ];
  M.TermsCard = {
    gate: GATE,
    /* text: termsText's output, exactly; id: confirmTerms' id; state: proposed | confirmed | checked; level;
       verdict: checkGrant's {fits, reasons} */
    html: function (o) {
      o = o || {};
      var state = o.state === "confirmed" || o.state === "checked" ? o.state : "proposed";
      var at = state === "proposed" ? 1 : state === "confirmed" ? 2 : 4;
      var v = o.verdict;
      var id = nextId("mc-terms");
      var steps =
        '<ol class="mc-steps">' +
        GATE.map(function (s, i) {
          var st = i < at ? "done" : i === at ? "current" : "next";
          return '<li class="mc-step" data-state="' + st + '" title="' + esc(s.who) + '"><span class="mc-step-bar"></span><span class="mc-step-word">' + (st === "done" ? CHECK.ok : "") + (i + 1) + " " + esc(s.step) + "</span></li>";
        }).join("") +
        "</ol>";
      var verdict = "";
      if (v) {
        verdict = v.fits
          ? '<div class="mc-verdict" data-fits="true">' + CHECK.ok + '<div><strong>Fits these terms</strong><p>It may be signed without asking you again.</p></div></div>'
          : '<div class="mc-verdict" data-fits="false">' + CHECK.fail + "<div><strong>Outside these terms</strong><ul>" + join(v.reasons, function (r) { return "<li>" + esc(r) + "</li>"; }) + "</ul><p>The agent asks you for new terms. New terms are a new task.</p></div></div>";
      }
      return (
        '<section class="mc-terms" data-state="' + state + '" aria-labelledby="' + id + '">' +
        '<header class="mc-terms-head">' + heading(o.level, id, o.title || "Terms for this task") + steps + "</header>" +
        '<blockquote class="mc-terms-text">' +
        esc(o.text).replace(/0x[0-9a-fA-F]{40}|(?:[a-z2-7]{5}-)+[a-z2-7]{1,5}(?:-[a-z2-7]{7}\.[0-9a-f]{1,64})?/g, function (a) {
          return '<span class="mc-terms-address">' + a + "</span>";
        }) +
        "</blockquote>" +
        (state === "proposed"
          ? '<footer class="mc-sheet-foot"><div class="mc-sheet-actions">' + M.Button.html({ label: "Decline", variant: "secondary", action: "decline" }) + M.Button.html({ label: "Confirm these terms", action: "confirm" }) + '</div><p class="mc-sheet-who">' + esc(o.who || "Confirm terms only here, on the wallet's own screen. Every request that fits them is signed without another yes.") + "</p></footer>"
          : (o.id ? M.HashChip.html({ kind: "terms", value: o.id }) : "") + verdict) +
        "</section>"
      );
    },
  };

  var REFUSALS = {
    E_DOMAIN: "The signing domain does not fit the wallet or the profile: another chain, name or version, or a field EIP-712 does not define.",
    E_TYPE_HASH: "No message the profile describes has this type hash. Requests are matched by type hash, never by name.",
    E_DEPLOYMENT: "This contract, on this chain, is not one the profile lists.",
    E_DECODE: "The values are not exactly their canonical encoding.",
    E_FIXED: "A position the profile pins holds another address.",
    E_REF_UNRESOLVED: "A token's decimals and symbol, or a value the text needs, were not given.",
    E_REQUEST: "The request to the consent function is incomplete, such as no active chain.",
    E_METHOD_UNKNOWN: "The selector is not a function the profile describes.",
    E_RESOLVED_FORM: "The profile given is for another kind of chain, or cannot be trusted.",
    E_UNSUPPORTED_TYPE: "A payable call: its native value has no place in a profile yet.",
  };
  M.RefusalPanel = {
    codes: REFUSALS,
    /* code; message (the library's, verbatim; a leading "CODE: " is dropped); chain; kind; standard; title; level;
       alert (default true: role="alert", for a refusal that appears in answer to a request;
       false where it is shown at rest, such as an example in a page) */
    html: function (o) {
      o = o || {};
      var code = String(o.code || "");
      var msg = String(o.message || "");
      if (msg.indexOf(code + ": ") === 0) msg = msg.slice(code.length + 2);
      var id = nextId("mc-refusal");
      return (
        '<section class="mc-refusal"' + (o.alert === false ? "" : ' role="alert"') + ' aria-labelledby="' + id + '">' +
        (o.chain || o.kind ? '<header class="mc-sheet-head">' + (o.chain ? M.ChainBadge.html(o.chain) : "<span></span>") + (o.kind ? M.RequestTag.html({ kind: o.kind, standard: o.standard }) : "") + "</header>" : "") +
        '<div class="mc-refusal-intro"><span class="mc-refusal-icon">' + ICON.danger + "</span><div>" + heading(o.level, id, o.title || "Refused before anything was shown") +
        (REFUSALS[code] ? '<p class="mc-refusal-meaning">' + esc(REFUSALS[code]) + "</p>" : "") +
        "</div></div>" +
        '<div class="mc-refusal-detail"><code class="mc-refusal-code">' + esc(code) + "</code><p>" + esc(msg) + "</p></div>" +
        '<footer class="mc-sheet-foot"><p class="mc-refusal-foot">Nothing was signed or sent, and there is nothing to confirm.</p>' +
        '<div class="mc-sheet-actions mc-sheet-actions--one">' + M.Button.html({ label: o.close || "Close", variant: "secondary", action: "close" }) + "</div></footer>" +
        "</section>"
      );
    },
  };

  /* ---------------------------------------------------------------- chains */

  var SUPPORT = {
    asOf: "@meantjs 0.5.0",
    chains: [
      { family: "icp", status: "supported", word: "Supported" },
      { family: "evm", status: "experimental", word: "Experimental" },
      { family: "sol", status: "planned", word: "Planned" },
    ],
    /* [what, ICP, EVM, SOL]; each cell [text, state]: yes | not-yet | assumption | open */
    rows: [
      ["Interface file", ["A Candid .did, compiled to a Contract graph", "yes"], ["The ABI, in binds.abi", "yes"], ["The Anchor IDL", "assumption"]],
      ["Where decimals live", ["The ledger: query:icrc1_decimals", "yes"], ["The token: query:decimals, an eth_call", "yes"], ["The mint account, which no value source reads yet", "open"]],
      ["Addresses", ["Principals and ICRC-1 account text", "yes"], ["0x and 40 hex digits, EIP-55", "yes"], ["32-byte keys in base58; a transfer goes to a derived token account", "assumption"]],
      ["Consent", ["ICRC-21", "yes"], ["Consent text, and ERC-7730 files", "yes"], ["No standard found", "open"]],
      ["Retry safety", ["created_at_time, deduplicated in the ledger's window", "yes"], ["Idempotency by nonce", "not-yet"], ["A blockhash, valid for about 150 blocks", "assumption"]],
      ["An unknown outcome", ["The ledger's ICRC-3 blocks", "yes"], ["Receipts", "not-yet"], ["The status of the transaction's signature", "assumption"]],
      ["Errors", ["Result cases, each with an outcome class", "yes"], ["Outcome classes over reverts", "not-yet"], ["Program error codes", "assumption"]],
      ["Local tests", ["PocketIC", "yes"], ["None run yet; Anvil would be the chain", "not-yet"], ["solana-test-validator", "assumption"]],
    ],
  };
  var CELL_WORD = { "not-yet": "Not yet", assumption: "Assumption", open: "Open" };
  M.ChainSupport = {
    data: SUPPORT,
    status: function (o) {
      var c = o || {};
      return '<span class="mc-status" data-status="' + esc(c.status) + '">' + esc(c.word) + "</span>";
    },
    /* rows, chains: default to what @meantjs 0.5.0 supports */
    html: function (o) {
      o = o || {};
      var chains = o.chains || SUPPORT.chains;
      var rows = o.rows || SUPPORT.rows;
      return (
        '<div class="mc-support-wrap"><table class="mc-support"><caption class="mc-support-caption">' + esc(o.caption || "What each chain has in " + SUPPORT.asOf) + "</caption><thead><tr><td></td>" +
        join(chains, function (c) {
          return '<th scope="col">' + M.ChainBadge.html({ family: c.family }) + M.ChainSupport.status(c) + "</th>";
        }) +
        "</tr></thead><tbody>" +
        join(rows, function (r) {
          return (
            '<tr><th scope="row">' + esc(r[0]) + "</th>" +
            join(r.slice(1), function (cell) {
              var st = cell[1] || "yes";
              return '<td data-state="' + esc(st) + '">' + (CELL_WORD[st] ? '<span class="mc-cell-state">' + CELL_WORD[st] + "</span>" : "") + esc(cell[0]) + "</td>";
            }) +
            "</tr>"
          );
        }) +
        "</tbody></table></div>"
      );
    },
  };

  M.OutcomePill = {
    does: DOES,
    /* outcome: success | already_done | retry_same | retry_new | fix_input | fail | reconcile */
    html: function (o) {
      o = o || {};
      var c = OUTCOMES.indexOf(o.outcome) === -1 ? "fail" : o.outcome;
      return '<span class="mc-outcome" data-outcome="' + c + '">' + GLYPH[c] + esc(o.label || c) + "</span>";
    },
  };

  /* -------------------------------------------------------------- behavior */

  var each = function (root, selector, fn) {
    Array.prototype.forEach.call(root.querySelectorAll(selector), fn);
  };
  var selectText = function (el) {
    if (!el || !window.getSelection) return;
    var range = document.createRange();
    range.selectNodeContents(el);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  };

  var wireCopy = function (btn) {
    btn.addEventListener("click", function () {
      var value = btn.getAttribute("data-mc-copy");
      var label = btn.getAttribute("aria-label");
      var done = function () {
        btn.setAttribute("data-copied", "");
        btn.setAttribute("aria-label", "Copied");
        btn.innerHTML = ICON.check;
        setTimeout(function () {
          btn.removeAttribute("data-copied");
          btn.setAttribute("aria-label", label);
          btn.innerHTML = ICON.copy;
        }, 1600);
      };
      var fallback = function () {
        var host = btn.parentNode;
        selectText(host && host.querySelector(".mc-address-text, .mc-hash-value"));
      };
      try {
        navigator.clipboard.writeText(value).then(done, fallback);
      } catch (e) {
        fallback();
      }
    });
  };

  var wireExpand = function (btn) {
    btn.addEventListener("click", function () {
      var host = btn.closest(".mc-address");
      if (!host) return;
      var text = host.querySelector(".mc-address-text");
      var value = host.getAttribute("data-value");
      var kind = host.getAttribute("data-kind");
      var open = btn.getAttribute("aria-expanded") === "true";
      text.innerHTML = open ? esc(shortOf(value, kind)) : grouped(value, kind);
      host.classList.toggle("mc-address--full", !open);
      btn.setAttribute("aria-expanded", open ? "false" : "true");
      btn.setAttribute("aria-label", open ? "Show the whole address" : "Show the short address");
      btn.setAttribute("title", open ? "Show the whole address" : "Show the short address");
      btn.innerHTML = open ? ICON.expand : ICON.collapse;
    });
  };

  var wireAmountField = function (field) {
    var input = field.querySelector("input");
    var help = field.querySelector(".mc-input-help");
    var decimals = field.getAttribute("data-decimals");
    var opts = {
      decimals: decimals,
      symbol: field.getAttribute("data-symbol") || undefined,
      signed: field.hasAttribute("data-signed") ? true : undefined,
      candid: field.getAttribute("data-candid") || "nat",
    };
    var update = function () {
      var text = input.value;
      if (!text.trim()) {
        field.removeAttribute("data-state");
        input.removeAttribute("aria-invalid");
        help.innerHTML = "At most " + esc(decimals) + " decimal places. Amounts are never rounded.";
        return;
      }
      var r = parseAmount(text, opts);
      field.setAttribute("data-state", r.ok ? "ok" : "error");
      if (r.ok) {
        input.removeAttribute("aria-invalid");
        help.innerHTML = '<span class="mc-input-units">' + esc(r.units) + "</span> base units, exactly";
      } else {
        input.setAttribute("aria-invalid", "true");
        help.innerHTML = '<code class="mc-input-code">' + esc(r.code) + "</code> " + esc(r.message);
      }
    };
    input.addEventListener("input", update);
    update();
  };

  var wireAction = function (btn) {
    btn.addEventListener("click", function () {
      var host = btn.closest(".mc-sheet, .mc-terms, .mc-refusal") || btn;
      host.dispatchEvent(new CustomEvent("mc:" + btn.getAttribute("data-mc-action"), { bubbles: true, detail: { source: btn } }));
    });
  };

  M.init = function (root) {
    root = root || document;
    var once = function (selector, fn) {
      each(root, selector, function (el) {
        if (el.__mcWired && el.__mcWired[selector]) return;
        el.__mcWired = el.__mcWired || {};
        el.__mcWired[selector] = true;
        fn(el);
      });
    };
    once("[data-mc-copy]", wireCopy);
    once("[data-mc-expand]", wireExpand);
    once(".mc-amount-field", wireAmountField);
    once("[data-mc-action]", wireAction);
    return root;
  };

  window.MeantChains = M;
})();
