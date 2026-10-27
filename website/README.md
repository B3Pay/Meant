# The candid-core documentation site

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
exist yet.

## Layout

```
website/
  build.mjs         the generator: content + assets -> dist/
  check.mjs         the gates (see below)
  redirects.mjs     the old address's redirects: dist/ -> redirects/
  content/
    _site.json      the sitemap; this is the navigation, and the page order
    <slug>.html     one body fragment per page
  assets/
    style.css       the Meant Docs design system: its tokens, then its component rules
    site.js         theme, mobile nav, search, copy buttons, scrollspy, tabs
    highlight.js    the syntax highlighter, used at build time
    favicon.svg     the Meant mark on a graphite tile
    meant-*.svg     the lockup (header) and the mark (footer), one file per ground
  snippets.mjs      the TypeScript snippet gates, run by check.mjs
  dist/             generated; not committed
  redirects/        generated; not committed
```

`dist/` and `redirects/` are generated output and are git-ignored. CI builds
them; see Publishing.

`style.css` is copied from the Meant Docs design system rather than written
here: its tokens (every colour once per theme, dark first, then spacing, radii,
layout widths and type styles), then its component rules, which style the class
names `build.mjs` already emits. Change a value in the design system and copy
both parts again, so the site and the system never drift. The font stacks name
the system's faces (Schibsted Grotesk, Martian Mono) first and fall back to
system faces, because the site loads no webfonts. The logo files set their own
colours, so the header and footer carry each one twice, `on-dark` and
`on-light`, and the stylesheet shows the one that matches the theme.

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
- a name `@candid-core/schema` 0.2.0 has and 0.3.0 removes (and so `latest`,
  0.4.0, lacks)
  (`createActor`, `httpTransport`, `PrincipalValue`, the four removed
  subpaths, `unrepresentable_option`, …) on any page but the migration page and
  the release history on the status page — in prose or in a code block, because
  a block that shows one teaches it as surely as a sentence does;
- a page that describes the TypeScript packages without carrying exactly one
  `Upgrading from an earlier release` callout (`NOTE_TITLE` in `check.mjs`)
  that links the three migration pages, `migrating-from-0-4.html`,
  `migrating-from-0-3.html` and `migrating-from-0-2.html`, inside the callout
  itself (`NOTE_LINKS`). The site describes the surface the repository
  builds. The `latest` dist-tag holds `@candid-core/schema` 0.4.0 and
  `@candid-core/cli` 0.3.0, published on 2026-10-10, and the repository is
  prepared as 0.5.0 and 0.4.0, not yet published: each page's note says so,
  names what the page shows that is new in the prepared pair, and links
  `migrating-from-0-4.html`. Each note also names what the stable pair before
  `latest` (0.3.0 / 0.2.0) lacks of what the page shows, with
  `migrating-from-0-3.html`; the stable pair before that (0.2.0 / 0.1.0)
  differs more, and each page says how once, in that one place, with
  `migrating-from-0-2.html`;
- any TypeScript or JavaScript snippet that is not verified (next section).

And, **in a code block only** — because a page is expected to discuss the
broken spellings, and a copyable line is the thing that must work:

- an install, `npx` or bare `import` line for any name in `UNPUBLISHED_NPM`
  in `check.mjs` — the list this repository keeps of names it has prepared but
  not published. The list is empty today; adding a name is what preparing the
  next package does, and emptying it is what publishing one does;
- an install, `npx` or import line naming a spec in `UNPUBLISHED_NPM_SPECS` —
  a version or dist-tag of a published name that the registry does not hold
  yet, such as a prepared beta (`@candid-core/schema@0.3.0-beta.2`, or
  `@candid-core/schema@beta` before any beta exists). The version-bump pull
  request adds its specs; the publish-day pull request removes them;
- a `candid-core` dependency requirement that is anything other than the
  exact pin. The required spelling is derived from the `version` in
  `Cargo.toml` rather than written down here, so a release makes every stale
  line in the documentation fail on the next run. While that version is a
  prerelease the `=` is mandatory, because a caret requirement never selects
  a prerelease; until 1.0 it stays mandatory by policy, because a caret
  requirement would take a breaking 0.x release. Note that a bare
  `candid-core = "0.1.0"` _is_ a caret requirement. After 1.0 the plain
  requirement becomes the correct one and this rule follows on its own;
- a bare `cargo add candid-core`, or `cargo add candid-core@<wrong-req>`.

`cargo install candid-core --version 0.1.0` is deliberately **not**
flagged. Cargo's manual states that a `--version` without a requirement
operator installs exactly that version and is not treated as a caret
requirement — unlike a dependency in a manifest, where a bare string is one.

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
`strict`, resolving `@candid-core/schema` and its three subpaths to the source
in that directory and `@candid-core/cli` to its hand-written declarations.
Exactly the four exported subpaths resolve, so an import of a removed one is a
compile error, which is what the migration page's "before" blocks rely on.
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

## Publishing

The site is published at <https://ic-reactor.b3pay.net/candid-core/>, beside
the docs of the libraries built on it. B3Pay/ic-reactor's docs deploy checks
out this repository's `main`, runs `node website/build.mjs` on Node 24.18.0
and serves `website/dist` there as it was built, every day and on each of its
own deploys. It installs nothing and runs neither `check.mjs` nor the snippet
gates, so the pull-request check here is what keeps a broken page off that
site; its own link check crawls these pages too, and fails its daily run on a
broken link. So what that repository relies on is this directory's own rules:
`build.mjs` takes no dependency and writes `website/dist`, and every link and
asset reference it emits is relative (`check.mjs` fails a root-absolute
`href`, `src` or `srcset`, in the sources and in the built pages). A merge to
`main` normally reaches that site at its next daily run; a run that fails
leaves the site as it was until the failure is fixed.

`.github/workflows/docs.yml` builds and checks the site, and publishes this
repository's own Pages site, <https://b3hr4d.github.io/candid-core/>, the site's
first address. That site now holds redirects (`redirects.mjs`, run after
`build.mjs`): each page sends the reader to the same page at the new address,
its query and `#fragment` kept, and its 404 page sends any other path there
too, where a miss lands on the home page. The links already published to the
old address, in READMEs on crates.io and npm and in release notes, keep
working that way. The deploy publishes them only once the new address serves
this site's home page.

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
