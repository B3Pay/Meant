/* The Meant components of the Meant Docs design system, as the generator
 * writes them. Zero dependencies.
 *
 * A content page writes a component as a tag, and build.mjs expands it here
 * into the design system's exact markup (its components/bundle.js, html()), so
 * the stylesheet copied from the system styles it unchanged and no page
 * repeats the markup by hand. An attribute value may hold `>` (an address
 * such as `balance->(0).e8s`): the tag patterns skip over quoted values. check.mjs reads the same lists to refuse a value
 * the component does not have.
 *
 *   <layer>profiles</layer>                  a layer icon and the layer's name
 *   <outcome>retry_same</outcome>            OutcomePill (label="…" optional)
 *   <effect>transfer</effect>                EffectBadge
 *   <claim>fact</claim>                      ClaimLabel: fact, assumption, open
 *   <diag>E_ADDR_UNRESOLVED</diag>           DiagnosticCode (href="…" optional)
 *   <id-chip kind="interface_id">…</id-chip> IdentityChip
 *   <annotation at="…" tag="amount" interface="…">
 *     decimals: query:icrc1_decimals         AnnotationBlock, one arg a line
 *   </annotation>
 *   <tool-view bridge="…">
 *     <sees value="1.5 ICP">…</sees>         ToolView; the inner text is literal
 *     <sends value="150000000">…</sends>
 *   </tool-view>
 *   <consent standard="…" title="…" effects="transfer irreversible">
 *     <field name="To" address="…">Alice</field>
 *     <field name="Amount" amount>1.5 ICP</field>   ConsentPreview
 *   </consent>
 *   <chain-switch chains="icp evm"></chain-switch>   ChainSwitcher; the panels
 *                                            are elements with data-chain-panel
 */

export const escapeHtml = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* The two layers, each with its icon from the design system: the colon for
 * Interfaces (the `meant` crate, `amount : nat`) and the tag for Profiles. The
 * icon always sits beside the layer's name or a page of that layer, never alone. */
export const LAYERS = {
  interfaces: { name: "Interfaces", icon: "meant-layer-interfaces" },
  profiles: { name: "Profiles", icon: "meant-layer-profiles" },
};
export const layerIcon = (layer, size = 14) => {
  const entry = LAYERS[layer];
  if (!entry) return "";
  return (
    `<img class="on-dark" src="assets/${entry.icon}-dark.svg" alt="" width="${size}" height="${size}">` +
    `<img class="on-light" src="assets/${entry.icon}-light.svg" alt="" width="${size}" height="${size}">`
  );
};

/* Outcome glyphs: one shape per class, so a class never depends on colour. */
const GLYPH = {
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
export const OUTCOMES = Object.keys(GLYPH);
export const EFFECTS = ["read", "write", "transfer", "approve", "admin", "destroy", "irreversible"];
export const CLAIMS = ["fact", "assumption", "open"];
export const CHAINS = [
  { id: "icp", name: "Internet Computer", code: "ICP" },
  { id: "evm", name: "Ethereum", code: "EVM" },
  { id: "sol", name: "Solana", code: "SOL" },
];

const attr = (attributes, name, fallback = "") =>
  (attributes.match(new RegExp(`\\b${name}="([^"]*)"`)) || [, fallback])[1];

/** The inner text of a component tag: written literally, like a <pre>. */
const literal = (body) => escapeHtml(body.replace(/^\n/, "").replace(/\s+$/, ""));

/** Expands the Meant components into their markup.
 * The markup is the design system's (components/bundle.js, html()), so the
 * stylesheet copied from it styles them unchanged. Runs after code blocks, so
 * a <pre> it emits is not taken for a code sample. check.mjs validates the
 * values (an outcome class, an effect, a diagnostic code that exists). */
export function renderComponents(html) {
  const outcome = (name, label) =>
    `<span class="outcome ${name}">${GLYPH[name] || GLYPH.fail}${escapeHtml(label || name)}</span>`;
  const effect = (name) => `<span class="effect ${escapeHtml(name)}">${escapeHtml(name)}</span>`;
  const idChip = (kind, value) =>
    `<span class="id-chip"><span class="id-kind">${escapeHtml(kind)}</span><span class="id-value" title="${escapeHtml(value)}">${escapeHtml(value)}</span><button type="button" data-copy="${escapeHtml(value)}">Copy</button></span>`;

  return html
    .replace(/<layer>([\s\S]*?)<\/layer>/g, (whole, raw) => {
      const layer = raw.trim();
      return `${layerIcon(layer, 12)}${escapeHtml(LAYERS[layer] ? LAYERS[layer].name : layer)}`;
    })
    .replace(/<outcome((?:[^>"]|"[^"]*")*)>([\s\S]*?)<\/outcome>/g, (whole, attributes, name) =>
      outcome(name.trim(), attr(attributes, "label")),
    )
    .replace(/<effect>([\s\S]*?)<\/effect>/g, (whole, name) => effect(name.trim()))
    .replace(/<claim>([\s\S]*?)<\/claim>/g, (whole, kind) => {
      const k = kind.trim();
      return `<span class="claim ${escapeHtml(k)}">${escapeHtml(k)}</span>`;
    })
    .replace(/<diag((?:[^>"]|"[^"]*")*)>([\s\S]*?)<\/diag>/g, (whole, attributes, raw) => {
      const code = raw.trim();
      const severity = code[0] === "E" ? ["error", "E"] : code[0] === "W" ? ["warning", "W"] : ["info", "I"];
      const href = attr(attributes, "href");
      const tag = href ? "a" : "span";
      return `<${tag} class="diag ${severity[0]}"${href ? ` href="${escapeHtml(href)}"` : ""} title="${severity[0]}"><span class="sev">${severity[1]}</span><span class="code">${escapeHtml(code)}</span></${tag}>`;
    })
    .replace(/<id-chip((?:[^>"]|"[^"]*")*)>([\s\S]*?)<\/id-chip>/g, (whole, attributes, value) =>
      idChip(attr(attributes, "kind"), value.trim()),
    )
    .replace(/<annotation((?:[^>"]|"[^"]*")*)>([\s\S]*?)<\/annotation>/g, (whole, attributes, body) => {
      // One argument per line, `key: value`.
      const args = body
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf(":");
          return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
        });
      const iface = attr(attributes, "interface");
      return (
        '<figure class="annotation"><figcaption class="annotation-head">Profile annotation' +
        (iface ? idChip("interface_id", iface) : "") +
        '</figcaption><dl class="annotation-body">' +
        `<dt>at</dt><dd><span class="annotation-address">${escapeHtml(attr(attributes, "at"))}</span></dd>` +
        `<dt>tag</dt><dd><span class="annotation-tag">${layerIcon("profiles")}${escapeHtml(attr(attributes, "tag"))}</span></dd>` +
        (args.length
          ? '<dt>args</dt><dd><ul class="annotation-args">' +
            args
              .map(([k, v]) => `<li><span class="k">${escapeHtml(k)}</span>: <span class="v">${escapeHtml(v)}</span></li>`)
              .join("") +
            "</ul></dd>"
          : "") +
        "</dl></figure>"
      );
    })
    .replace(/<tool-view((?:[^>"]|"[^"]*")*)>([\s\S]*?)<\/tool-view>/g, (whole, attributes, body) => {
      const side = (name, label) => {
        const m = body.match(new RegExp(`<${name}((?:[^>"]|"[^"]*")*)>([\\s\\S]*?)</${name}>`)) || ["", "", ""];
        return `<div class="tool-side ${name}"><span class="tool-label">${label}</span><span class="tool-value">${escapeHtml(attr(m[1], "value"))}</span><pre>${literal(m[2])}</pre></div>`;
      };
      return (
        '<div class="tool-view">' +
        side("sees", "The model sees") +
        `<div class="tool-bridge" aria-hidden="true">${escapeHtml(attr(attributes, "bridge", "exact, no rounding"))}</div>` +
        side("sends", "The call sends") +
        "</div>"
      );
    })
    .replace(/<consent((?:[^>"]|"[^"]*")*)>([\s\S]*?)<\/consent>/g, (whole, attributes, body) => {
      const fields = [...body.matchAll(/<field((?:[^>"]|"[^"]*")*)>([\s\S]*?)<\/field>/g)]
        .map(([, a, value]) => {
          const address = attr(a, "address");
          const amount = /\bamount\b/.test(a.replace(/="[^"]*"/g, ""));
          return `<div><dt>${escapeHtml(attr(a, "name"))}</dt><dd><span${amount ? ' class="is-amount"' : ""}>${escapeHtml(value.trim())}</span>${address ? `<span class="is-address">${escapeHtml(address)}</span>` : ""}</dd></div>`;
        })
        .join("");
      const effects = attr(attributes, "effects").split(/\s+/).filter(Boolean).map(effect).join("");
      const note = attr(attributes, "note", "Only the owner confirms. The model never does.");
      // The design system gives .consent no outer margin, unlike .annotation
      // and .tool-view; the wrapper adds the same spacing they have, here, so
      // the copied stylesheet stays the system's.
      return (
        '<div style="margin: var(--space-4) 0 var(--space-6)">' +
        `<section class="consent" aria-label="Consent preview"><div class="consent-head"><span class="consent-standard">${escapeHtml(attr(attributes, "standard"))}</span>` +
        `<h4 class="consent-title">${escapeHtml(attr(attributes, "title"))}</h4><div class="consent-effects">${effects}</div></div>` +
        `<dl class="consent-fields">${fields}</dl>` +
        '<div class="consent-foot"><button class="button secondary" type="button" data-consent="reject">Reject</button><button class="button" type="button" data-consent="confirm">Confirm</button>' +
        `<span class="consent-note" aria-live="polite">${escapeHtml(note)}</span></div></section></div>`
      );
    })
    .replace(/<chain-switch((?:[^>"]|"[^"]*")*)><\/chain-switch>/g, (whole, attributes) => {
      const wanted = attr(attributes, "chains", "icp evm").split(/\s+/);
      const chains = CHAINS.filter((chain) => wanted.includes(chain.id));
      const selected = attr(attributes, "selected", chains[0].id);
      return (
        '<div class="chain-switch" role="group" aria-label="Chain">' +
        chains
          .map(
            (chain) =>
              `<button type="button" data-chain="${chain.id}" aria-pressed="${chain.id === selected}">${escapeHtml(chain.name)} <span class="chain-code">${chain.code}</span></button>`,
          )
          .join("") +
        "</div>"
      );
    });
}

