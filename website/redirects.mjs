#!/usr/bin/env node
/* Redirect pages for the site's old address.
 *
 * The site is published at the address content/_site.json names as "url"
 * (ic-reactor.b3pay.net/candid-core/): B3Pay/ic-reactor's docs deploy builds
 * this repository's main with build.mjs and serves website/dist there. This
 * repository's own Pages site, b3hr4d.github.io/candid-core/, keeps the links
 * already published to it working instead. For each page build.mjs wrote, it
 * holds a page of the same name that sends the reader to that page at the
 * new address, its query and #fragment kept; its 404 page sends any other
 * path there too, where a miss lands on the site's home.
 *
 * The new address keeps the site's path, so the 404 page only swaps the host.
 *
 * Zero dependencies. Run after build.mjs:
 *
 *   node website/redirects.mjs        write website/redirects from website/dist
 */

import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, "dist");
const OUT = join(HERE, "redirects");

// GitHub Pages serves a project site under its repository's name.
const OLD_BASE = "/candid-core/";

const site = JSON.parse(await readFile(join(HERE, "content", "_site.json"), "utf8"));
const url = new URL(site.url);
if (url.protocol !== "https:" || url.pathname !== OLD_BASE || url.search || url.hash) {
  throw new Error(`_site.json "url" must be an https address whose path is ${OLD_BASE}, not ${site.url}`);
}
if (!existsSync(join(DIST, "index.html"))) {
  throw new Error(`${DIST} holds no built site: run node website/build.mjs first`);
}

const escapeHtml = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* The script goes first, so the query and the fragment survive; the refresh
 * is for a reader without JavaScript, and the canonical link tells a search
 * engine where the page is now. */
const redirect = ({ title, href, script }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Moved: ${title}</title>
<link rel="canonical" href="${escapeHtml(href)}">
<script>${script}</script>
<meta http-equiv="refresh" content="0; url=${escapeHtml(href)}">
</head>
<body>
<p>This page has moved to <a href="${escapeHtml(href)}">${escapeHtml(href)}</a>.</p>
</body>
</html>
`;

const names = (await readdir(DIST)).filter((name) => name.endsWith(".html")).sort();

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

for (const name of names) {
  const html = await readFile(join(DIST, name), "utf8");
  const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1];
  if (!title) throw new Error(`${name} has no <title>`);
  const href = name === "index.html" ? url.href : new URL(name, url).href;
  const script = `location.replace(${JSON.stringify(href)} + location.search + location.hash);`;
  await writeFile(join(OUT, name), redirect({ title, href, script }), "utf8");
}

const notFound = `var path = location.pathname;
var rest = path.indexOf(${JSON.stringify(OLD_BASE)}) === 0 ? path.slice(${OLD_BASE.length}) : "";
location.replace(${JSON.stringify(url.href)} + rest + location.search + location.hash);`;
await writeFile(
  join(OUT, "404.html"),
  redirect({ title: escapeHtml(site.title), href: url.href, script: notFound }),
  "utf8",
);

console.log(`wrote ${names.length} redirect pages and a 404 page to ${url.href} -> ${OUT}`);
