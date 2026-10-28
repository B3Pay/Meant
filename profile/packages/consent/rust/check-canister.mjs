#!/usr/bin/env node
// Runs the SNS golden cases of the dapp through the example validator canister (examples/sns_validator.rs), with the
// system API functions it imports stubbed in Node. This checks the wasm build end to end (decode, render,
// reply bytes); it is not a replica: no cycles, no instruction limit, no inter-canister call. Build first:
//
//   cargo build --release --target wasm32-unknown-unknown --example sns_validator
//   node check-canister.mjs

import { readFileSync, readdirSync } from "node:fs";

const wasm = readFileSync(new URL("./target/wasm32-unknown-unknown/release/examples/sns_validator.wasm", import.meta.url));
const goldenDir = new URL("../test/sns-golden/", import.meta.url);

let instance;
let arg;
let reply;
const mem = () => new Uint8Array(instance.exports.memory.buffer);
const ic0 = {
  msg_arg_data_size: () => arg.length,
  msg_arg_data_copy: (dst, offset, size) => mem().set(arg.subarray(offset, offset + size), dst),
  msg_reply_data_append: (src, size) => reply.push(...mem().slice(src, src + size)),
  msg_reply: () => {},
  performance_counter: () => 0n,
  debug_print: () => {},
};
instance = (await WebAssembly.instantiate(wasm, { ic0 })).instance;

/** `variant { Ok : text; Err : text }` as one argument, as governance decodes it: { Ok } or { Err }, else null. */
function decodeReply(bytes) {
  const header = Buffer.from("4449444c016b02bc8a0171c5fed201710100", "hex"); // DIDL, the variant type, one value of it
  if (!Buffer.from(bytes.subarray(0, header.length)).equals(header)) return null;
  let i = header.length;
  const tag = bytes[i++];
  let len = 0;
  for (let shift = 0; ; shift += 7) {
    const b = bytes[i++];
    len += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) break;
  }
  if (i + len !== bytes.length || tag > 1) return null;
  return { [tag === 0 ? "Ok" : "Err"]: Buffer.from(bytes.subarray(i)).toString("utf8") };
}

let failed = 0;
let ran = 0;
for (const f of readdirSync(goldenDir).filter((x) => x.endsWith(".json")).sort()) {
  const g = JSON.parse(readFileSync(new URL(f, goldenDir), "utf8"));
  if (g.source !== "dapp") continue;
  arg = Uint8Array.from(Buffer.from(g.payload_hex, "hex"));
  reply = [];
  instance.exports[`canister_query validate_${g.method}`]();
  ran++;
  const got = Uint8Array.from(reply);
  const r = decodeReply(got);
  // Ok must be byte-identical; an Err must carry the same code (the two decoders word their errors differently)
  const same = "Ok" in g.reply ? Buffer.from(got).toString("hex") === g.reply_hex : r !== null && "Err" in r && r.Err.split(":")[0] === g.reply.Err.split(":")[0];
  if (!same) failed++;
  console.log(`${same ? "ok  " : "FAIL"} ${g.id}`);
}
console.log(`${ran - failed} of ${ran} dapp cases match; wasm ${wasm.length} bytes`);
process.exitCode = failed === 0 && ran > 0 ? 0 : 1;
