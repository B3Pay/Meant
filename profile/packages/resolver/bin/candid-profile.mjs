#!/usr/bin/env node
// The command's old name (D-064): it runs meant-profile, with a warning on stderr, and is removed in a later release.
import { main } from "../src/cli.mjs";

process.stderr.write("candid-profile: this command is now meant-profile; the old name is removed in a later release\n");
main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr })
  .then((code) => { process.exitCode = code; })
  .catch((e) => { console.error(e); process.exitCode = 2; });
