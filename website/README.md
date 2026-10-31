# The Meant documentation site

One site for everything in this repository, in two layers: **Interfaces** (the
`meant` crate, `@candid-core/schema`, `@candid-core/cli`, the generator) and
**Profiles** (the Candid Profile spec under `profile/`, the five `@meantjs`
profile packages and the `meant-format` crate). The pair is prepared under new
names, `@meantjs/schema` 0.6.0 and `@meantjs/cli` 0.5.0 (issue #306); until
they are published, the pages teach the published names. The navigation follows the Meant Docs
design system's site structure: Learn, Guides, Concepts, Reference, Chains,
then Project, with each page of one layer marked by that layer's icon.

A static documentation site with **no dependencies at all** — no site generator,
no CSS framework, no webfonts, no npm install. `build.mjs` and `check.mjs` use
Node built-ins only. That is deliberate: this repository exact-pins every
dependency it takes, and a docs site is not a good reason to take a few hundred
more. The one thing the check borrows is the TypeScript compiler already pinned
for the runtime package, to compile the snippets (see Snippets below).

```sh
node website/build.mjs --serve
```

Then open <http://localhost:4173>. Omit `--serve` to build only. Add
`--allow-missing` while drafting to skip sitemap entries whose file does not
exist yet. `--out <dir>` builds somewhere other than `dist/`, and
`check.mjs --dist <dir>` checks that build, so two builds at once do not
overwrite each other.

## Layout

```
website/
  build.mjs         the generator: content + assets -> dist/
  components.mjs    the Meant components a page writes as tags (see below)
  check.mjs         the gates (see below)
  redirects.mjs     the old address's redirects: dist/ -> redirects/
  content/
    _site.json      the sitemap; this is the navigation, and the page order.
                    A section or a page may carry "layer": "interfaces" or
                    "profiles", which puts the layer's icon beside it in the
                    sidebar, above its title and in search results
    <slug>.html     one body fragment per page
  assets/
    style.css       the Meant Docs design system: its tokens, then its component rules
    site.js         theme, mobile nav, search, copy buttons, scrollspy, tabs
    chains.css      the Meant Chains design system: its added tokens, then its
                    component rules; linked only on a page that uses one
    chains.js       its components, unchanged: what moves (copy, expand), and
                    the markup build.mjs writes
    highlight.js    the syntax highlighter, used at build time
    favicon.svg     the Meant mark on a graphite tile
    meant-*.svg     the lockup (header), the mark (footer) and the two layer
                    icons, one file per ground
  snippets.mjs      the TypeScript snippet gates, run by check.mjs
  b3pay-module.json how b3pay.net builds and lists the site (see Publishing)
  dist/             generated; not committed
  redirects/        generated; not committed
```

`dist/` and `redirects/` are generated output and are git-ignored. CI builds
them; see Publishing.

`style.css` is copied from the Meant Docs design system rather than written
here, with one site addition marked as such in the file (`code.wrap`, for
long code in a table cell, until the system takes it or answers it otherwise): its tokens (every colour once per theme, dark first, then spacing, radii,
layout widths and type styles), then its component rules, which style the class
names `build.mjs` already emits. Change a value in the design system and copy
both parts again, so the site and the system never drift. The font stacks name
the system's faces (Schibsted Grotesk, Martian Mono) first and fall back to
system faces, because the site loads no webfonts. The logo files set their own
colours, so the header and footer carry each one twice, `on-dark` and
`on-light`, and the stylesheet shows the one that matches the theme.

The chain pages also use the Meant Chains design system, the look and parts
of the screens where a person reads what a request means on a chain before
anyone signs it. Its two files are copied from the system unchanged:
`chains.js` is its `components/bundle.js`, and `chains.css` holds the three
tokens it adds to Meant Docs' (`--scrim`, `--sheet-max`, `--field-label-w`,
on the same `[data-theme]` selectors as `style.css`) and then its
`components/bundle.css`. Every other token it uses is Meant Docs', with the
same name and value. `build.mjs` links both only on a page that uses one of
its components, `chains.css` after `style.css`: the system's rules that style
a `p`, a heading or a `code` name the element, so they win over the prose
rules here by coming later. Change the system and copy both files again.

## Writing a page

A content file is a **body fragment**: no `<!doctype>`, no `<html>`, no
`<body>`, and no `<h1>`. The generator supplies the page title and lead from
`_site.json`, adds ids and anchors to every `<h2>`/`<h3>`, builds the
table of contents from them, and adds previous/next navigation.

Add the page to `_site.json` first — a file not listed there is never built, and
`check.mjs` fails on it.

### Code blocks

```html
<pre data-lang="rust" data-file="src/limits.rs">
let limits = Limits::default().with_max_input_bytes(512);
</pre>
```

The text inside a `<pre>` is taken **literally**, so write `<T>`, `&` and `->`
unescaped. The one rule is that a sample must not contain the literal string
`</pre>`. Highlighting happens at build time, so a published page needs no
JavaScript to be complete — `site.js` only adds theme, search, copying and the
scrollspy.

Nothing in the output uses an ES module or `fetch()`, and every asset
reference is relative, so the page has no reason to need a server or an
origin. Keep it that way: a `type="module"` script or a `fetch()` for the
search index would both break a page opened directly from disk.

Languages: `rust`, `ts`, `js`, `json`, `bash`, `candid`, `toml`, `text`.

### The Meant components

The design system's Meant components are written as tags, and `build.mjs`
expands each into the system's exact markup through `components.mjs`, so the
copied stylesheet styles them and no page repeats the markup:

```html
<layer>profiles</layer>                       the layer icon and its name
<outcome>retry_same</outcome>                 an outcome class, a shape and a word
<effect>transfer</effect>                     an effect
<claim>fact</claim>                           Fact, Assumption or Open, before the sentence it labels
<diag>E_ADDR_UNRESOLVED</diag>                a diagnostic code
<id-chip kind="interface_id">…</id-chip>      an identity, shown truncated and copied whole
<annotation at="…" tag="amount">              one profile annotation, an argument a line
decimals: query:icrc1_decimals
</annotation>
<tool-view><sees value="1.5 ICP">…</sees><sends value="150000000">…</sends></tool-view>
<consent standard="Consent · ICRC-21" title="…" effects="transfer irreversible">
<field name="Amount" amount>1.5 ICP</field>
</consent>
<chain-switch chains="icp evm"></chain-switch> then elements with data-chain-panel="icp" …
```

The header of `components.mjs` lists every attribute. A chain switcher
remembers the reader's choice on their device, so a reader on EVM stays on
EVM from page to page; use one only where the answer differs by chain.

### The Meant Chains components

Three components of the Meant Chains design system show what a wallet shows:
a call or a signature as a person confirms it, a request the library refused,
and what a request grants. The body of each tag is the component's options as
JSON, written literally like a `<pre>`:

```html
<signing-sheet>
{
  "consent": { "message": { "intent": "Send tokens: Send 1.5 TKA to 0x7099…", "fields": [["Amount", "1.5 TKA"]] }, "model": { "title": "Send tokens", "effect": "transfer" } },
  "chain": { "family": "evm", "id": 31337, "name": "Anvil", "network": "local" },
  "standard": "ERC-20",
  "effects": ["transfer", "irreversible"],
  "who": "Only the owner confirms. The model never does."
}
</signing-sheet>
<refusal-panel>{ "code": "E_DOMAIN", "message": "the domain is for chain 31337, the wallet is on chain 1" }</refusal-panel>
<grant-summary>{ "grant": { … }, "tokens": { … }, "names": { … } }</grant-summary>
```

(The `…` above only shortens this example; a page gives every value whole.)
`consent` is what `evmConsent`, `eip712Consent` or `generateConsent` of
`@meantjs/consent` returned with `form: "fields"`, as `toJson` writes it, so
an ICRC-21 amount's bigint is a string. Give its values whole: the component
shortens an address where the whole one is a tap away and keeps the contract,
the canister and the digest whole. Produce the JSON by running the packages,
never by retyping their output. `build.mjs` runs `chains.js` in a `node:vm`
sandbox and writes what the component's `html()` returns, with the title an
`h4` (outside the table of contents) and a refusal an example at rest rather
than an alert. The options are the system's (`components/index.d.ts` there).

### Callouts, tables and the rest

```html
<callout type="warn" title="Short title">
  <p>Body.</p>
</callout>
```

`type` is `note`, `tip`, `warn` or `danger`. Tables are plain `<table>` and get
wrapped for horizontal scrolling. The other components — `.card-grid`,
`.steps`, `.tabs`, `.api-entry`, `.pill` — are documented by example in
`assets/style.css` and used across the existing pages.

## Gates

```sh
node website/build.mjs && node website/check.mjs
```

`check.mjs` fails the build on:

- a document shell or an `<h1>` in a content fragment;
- a content file missing from `_site.json`, or a sitemap entry with no file;
- a `<pre>` with no `data-lang`, or an unknown language;
- an unbalanced or unknown-typed `<callout>`;
- an internal link to a slug that is not in the sitemap, or a `#fragment` that
  matches no heading on the target page;
- a root-absolute `href`/`src`, which resolves above the site root on Pages
  while still working on a local server — the one mistake local preview cannot
  catch;
- a performance claim, or marketing filler, anywhere in the prose;
- a Meant component with a value it does not have (an outcome class, an
  effect, a claim, a chain or a layer), a chain panel without a switcher, or a
  `<diag>` code that the profile spec, the profile packages' sources and
  `meant-format` define nowhere;
- a Meant Chains component whose body is not JSON or does not render, with an
  effect or a chain family it does not have, with a refusal code the consent
  functions do not throw or the profile sources define nowhere, or with a
  value shortened by hand (a `…` anywhere in its JSON);
- an `@meantjs/<name>@<version>` that is not one of the `@meantjs` packages
  this repository builds (the five profile packages and the pair) or not the
  version its `package.json` holds;
- a name `@candid-core/schema` 0.2.0 has and 0.3.0 removes (and so `latest`,
  0.5.0, lacks)
  (`createActor`, `httpTransport`, `PrincipalValue`, the four removed
  subpaths, `unrepresentable_option`, …) on any page but the migration page and
  the release history on the status page — in prose or in a code block, because
  a block that shows one teaches it as surely as a sentence does;
- a page that describes the TypeScript packages without carrying exactly one
  `Upgrading from an earlier release` callout (`NOTE_TITLE` in `check.mjs`)
  that links the four migration pages, `migrating-from-0-5.html`,
  `migrating-from-0-4.html`, `migrating-from-0-3.html` and
  `migrating-from-0-2.html`, inside the callout itself (`NOTE_LINKS`). While
  the renamed pair is prepared, each note ends by saying so, with
  `migrating-from-0-5.html`. The site describes the surface the repository
  builds, which is what the `latest` dist-tag holds (`@candid-core/schema`
  0.5.0 and `@candid-core/cli` 0.4.0, published on 2026-10-27). Each page's
  note names what the previous stable pair (0.4.0 / 0.3.0) lacks of what the
  page shows, with `migrating-from-0-4.html`, and what the pair before it
  (0.3.0 / 0.2.0) lacks, with `migrating-from-0-3.html`; the stable pair
  before that (0.2.0 / 0.1.0) differs more, and each page says how once, in
  that one place, with `migrating-from-0-2.html`;
- any TypeScript or JavaScript snippet that is not verified (next section).

And, **in a code block only** — because a page is expected to discuss the
broken spellings, and a copyable line is the thing that must work:

- an install, `npx` or bare `import` line for any name in `UNPUBLISHED_NPM`
  in `check.mjs` — the list this repository keeps of names it has prepared but
  not published. It holds the pair's new names, `@meantjs/schema` and
  `@meantjs/cli`, until their publish; adding a name is what preparing the
  next package does, and emptying it is what publishing one does. A block
  whose first line is the header the generator writes (`GENERATED_HEADER`,
  read from a golden) is the generator's output, so the import rule skips it:
  a generated module shows the import the generator in this repository
  writes. Install lines get no such exemption;
- an install, `npx` or import line naming a spec in `UNPUBLISHED_NPM_SPECS` —
  a version or dist-tag of a published name that the registry does not hold
  yet, such as a prepared beta (`@candid-core/schema@0.3.0-beta.2`, or
  `@candid-core/schema@beta` before any beta exists). The version-bump pull
  request adds its specs; the publish-day pull request removes them;
- the crate's old name: `use candid_core::`, a `candid-core = …` dependency
  line, or `cargo add`/`cargo install candid-core`. The crate is `meant`
  since the rename; the Contract format's own `candid-core` strings are
  unchanged, and the `@candid-core/` npm names stay published, so these rules
  touch none of them;
- a `meant` or `meant-format` dependency requirement that is anything other
  than the exact pin. The required spelling is derived from the `version` in
  each crate's own `Cargo.toml` rather than written down here, so a release
  makes every stale line in the documentation fail on the next run. While
  that version is a prerelease the `=` is mandatory, because a caret
  requirement never selects a prerelease; until 1.0 it stays mandatory by
  policy, because a caret requirement would take a breaking 0.x release. Note
  that a bare `meant = "0.1.0"` _is_ a caret requirement. After 1.0 the plain
  requirement becomes the correct one and this rule follows on its own;
- a bare `cargo add meant`, or `cargo add meant@<wrong-req>` (and the same
  for `meant-format`), and a `cargo install <crate> --version` naming another
  version than the manifest's;
- a dependency line or `cargo add` for a crate version in
  `UNPUBLISHED_CRATES` in `check.mjs`: a version a manifest holds that
  crates.io does not yet. The list is empty today; the version-bump pull
  request adds an entry and the publish removes it.

`cargo install meant --version 0.1.0` is deliberately **not** flagged as a
caret requirement. Cargo's manual states that a `--version` without a
requirement operator installs exactly that version and is not treated as a
caret requirement — unlike a dependency in a manifest, where a bare string is
one.

It also warns about softer filler without failing.

### Snippets

Every `<pre>` of language `ts` or `js` is in exactly one of these classes, and
a block in none of them fails the build:

| Attribute | Gate |
| --- | --- |
| `data-file="path"` | An excerpt of a repository file. Every run of lines must appear in that file verbatim (whitespace trimmed; a trailing `{` or `;` is ignored, so a signature can be quoted without its body). Mark an intended gap with a line `// …`, or add `data-partial` to require only that the lines appear in the file in order. |
| `data-check` | Compiled on its own by the pinned compiler, and must have no diagnostics. It may sit beside `data-file`. |
| `data-check="name"` | Blocks of one page with the same name are concatenated, in page order, into one file: an example built up across several blocks. |
| `data-check-fails="TS2322@3"` | Must **not** compile: the compiler must report that code at that line of the block (1-based) and nothing else anywhere in it, so a block whose showcased line was fixed cannot stay "proven stale" because another line keeps the same error. This is how the migration page proves a "before" snippet is stale rather than asserting it. |
| `data-unchecked="reason"` | The visible opt-out, with a reason. Every exemption is listed in the summary line. |

A `js` block is written to a `.js` file and compiled with `allowJs` and
`checkJs`, so TypeScript-only syntax in it is refused as the syntax error a
reader copying it would get.

Compilation uses the TypeScript pinned in `crates/candid-core-ts/ts`
(`npm ci` there installs it; the site itself still takes no dependency) with
`strict`, resolving `@meantjs/schema` and its three subpaths to the source in
that directory and `@meantjs/cli` to its hand-written declarations. Until the
new names are published, `@candid-core/schema` and `@candid-core/cli`, which
the pages still teach, resolve to the same files (`PAIR_NAMES` in
`snippets.mjs`): 0.6.0 and 0.5.0 are 0.5.0 and 0.4.0's code under new names,
as their release notes measure.
Exactly the four exported subpaths resolve, so an import of a removed one is a
compile error, which is what the migration page's "before" blocks rely on.
The five `@meantjs` profile packages, and exactly the subpaths each one
exports, resolve to their hand-written `.d.mts` declarations under
`profile/packages/*/src`, read from each package's own `exports` map (its
`types` condition), so a profile snippet is checked against the types the
published tarball carries, and a subpath a sync adds resolves with no change
here.
A snippet may import `./ledger.ts`, `./shadowing.ts` or `./generated/interface`,
which the gate supplies from the checked-in goldens, so the import resolves to
real generated output. If the compiler is not installed the check fails and
says how to install it; `--skip-snippets` checks everything else while
drafting and is never passed in CI.

Every one of those checks exists because a draft got it wrong. Each was
demonstrated by injecting the corresponding fault into a page, watching
`check.mjs` exit non-zero and name it, and then reverting — a gate shown only
by its green path is not evidence.

## Accuracy

The pages state exact API signatures, default limit values, CLI flags, error
codes and version numbers. All of them are checkable against the source. When
you change a public API, grep this directory for its name before you assume the
docs still hold — nothing here is generated from the code, so nothing here
updates itself.

The profile pages describe `profile/`, which is a synced copy of the
candid-profile repository that each sync pull request replaces whole (see the
repository's `CLAUDE.md`). A sync that changes the spec, a pack or a package's
API changes what those pages must say: the snippet, version and diagnostic-code
gates catch part of it, and the rest is a read of the sync's diff against the
pages under Guides · Profiles, Concepts · Profiles and Reference · Profiles.

## Publishing

The site is published at <https://b3pay.net/docs/meant/>, beside the docs of
B3Pay's other products, as `b3pay-module.json` here describes.
`.github/workflows/b3pay-site.yml` calls b3pay.net's reusable workflow, pinned
to a commit of B3Pay/b3pay.net, which runs `node website/build.mjs --out <dir>`
in a checkout of this repository with nothing installed, checks what it wrote,
and builds the whole of b3pay.net with it, links checked, so a page that would
break that site fails here. On a pull request touching `website/**` that is
all it does. A merge to `main` touching it also commits the built pages to
this repository's `b3pay-site` branch, which b3pay.net serves, and asks
b3pay.net to rebuild; without the `B3PAY_SITE_DEPLOY_HOOK` secret the pages go
live with b3pay.net's next deploy. It never writes to B3Pay/b3pay.net.

B3Pay/ic-reactor's docs deploy still builds a copy at the address before it,
<https://ic-reactor.b3pay.net/candid-core/>: it checks out this repository's
`main`, runs `node website/build.mjs` on Node 24.18.0 and serves `website/dist`
there as it was built, every day and on each of its own deploys. Neither site
installs anything for these pages or runs `check.mjs` or the snippet gates, so
the pull-request check here is what keeps a broken page off them; their own
link checks crawl these pages too. So what they rely on is this directory's own
rules: `build.mjs` takes no dependency and writes `website/dist`, or the folder
`--out` names, and every link and asset reference it emits is relative
(`check.mjs` fails a root-absolute `href`, `src` or `srcset`, in the sources
and in the built pages). A merge to `main` normally reaches
ic-reactor.b3pay.net at its next daily run; a run that fails leaves that copy
as it was until the failure is fixed.

`.github/workflows/docs.yml` builds and checks the site, and publishes this
repository's own Pages site. That was <https://b3hr4d.github.io/candid-core/>,
the site's first address, until the repository moved to B3Pay on 2026-10-28;
GitHub now serves it at <https://b3pay.github.io/Meant/>, where nothing links.
What it publishes there are redirects (`redirects.mjs`, run after
`build.mjs`): each page sends the reader to the same page at the new address,
its query and `#fragment` kept, and its 404 page sends any other path there
too, where a miss lands on the home page. The deploy publishes them only once
the new address serves this site's home page.

The first address answers 404 since the move, and so do the links already
published to it, in READMEs on crates.io and npm and in release notes.
Nothing had been announced there, so no copy of the redirects keeps them
working (the owner's call, 2026-10-28). Do not create a repository named
`candid-core` under `b3hr4d`: GitHub would then stop redirecting the old
repository address to this one.

- A **pull request** touching `website/**`, or anything a snippet is compiled
  against or excerpted from (the runtime package's sources and tests, the
  generator's goldens and library, the CLI package's library and tests),
  builds before installing anything, as the other repository does, then
  installs the pinned compiler, runs `check.mjs` and writes the redirects. It
  publishes nothing.
- A **merge to `main`** touching the same paths republishes the redirects.
- **Run workflow** on the Actions tab republishes on demand — but only with
  `main` selected. There is one Pages site and no preview channel, so a
  dispatch from any other ref builds and checks, prints a warning saying it
  did not publish, and skips the deploy. A dispatch with `publish` set to
  `site` publishes the site itself here instead of the redirects, should the
  new address stop serving it.

The published URL is a subpath, not a domain root, which is why every asset
reference and internal link the generator emits is relative. If you ever add an
absolute path such as `/assets/style.css`, the site breaks where it is
published and keeps working locally — the worst kind of bug. To check a change
against the real shape of the URL, serve `dist` under a prefix rather than at
the root.
