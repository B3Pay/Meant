// The pinned artifacts (artifacts.json) and where they live in .cache/. Nothing in .cache/ is trusted until its sha256
// matches; nothing in it is imported or interpreted (the PocketIC binary is spawned by absolute path).
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { fileURLToPath } from "node:url";

export const manifest = JSON.parse(readFileSync(new URL("../artifacts.json", import.meta.url), "utf8"));
const cache = (name) => fileURLToPath(new URL(`../.cache/${name}`, import.meta.url));

export const platformKey = () => `${platform()}-${arch()}`;

export const paths = {
  pocketIcGz: cache(`pocket-ic-${manifest.pocket_ic.version}.gz`),
  // the server refuses to start unless its file is named pocket-ic or pocket-ic-server
  pocketIc: cache(`pocket-ic-${manifest.pocket_ic.version}/pocket-ic`),
  file: (name) => cache(`${manifest.sns_governance.commit.slice(0, 12)}-${name}`),
};

export async function sha256File(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/** The path of a pinned file after checking its sha256 again; throws when it is missing or differs. */
export async function verified(path, sha256) {
  let got;
  try {
    got = await sha256File(path);
  } catch {
    throw new Error(`${path} is missing: run \`npm run fetch\` in packages/consent/pocketic`);
  }
  if (got !== sha256) throw new Error(`${path}: sha256 ${got}, pinned ${sha256}; delete it and run \`npm run fetch\``);
  return path;
}
