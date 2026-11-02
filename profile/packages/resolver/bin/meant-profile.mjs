#!/usr/bin/env node
import { main } from "../src/cli.mjs";

main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr })
  .then((code) => { process.exitCode = code; })
  .catch((e) => { console.error(e); process.exitCode = 2; });
