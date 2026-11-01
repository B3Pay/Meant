#!/usr/bin/env node
// The `/.well-known/ic-architecture` manifest of an app built on this canister (DFINITY's service discoverability
// guide, layer 1): publishing it at the app's origin opts the app into ICP MCP. Canister ids differ per network, so it
// is written at deploy time:
//
//   node examples/icp-mcp/manifest.mjs <canister id> > dist/.well-known/ic-architecture
//
// Serve it as a static file with `Content-Type: application/json`, not rewritten to index.html.

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function crc32(bytes) {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/**
 * The textual form of a principal (IC interface specification, "Textual representation of principals"): base32 of
 * the CRC-32 of the bytes followed by the bytes, lowercase, in groups of five. Valid when it decodes to 4 + at most 29
 * bytes whose checksum holds and encodes back to exactly the same text, so a typo that keeps the shape is refused.
 */
export function isPrincipalText(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > 63) return false;
  const digits = text.replaceAll("-", "");
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of digits) {
    const d = ALPHABET.indexOf(ch);
    if (d < 0) return false;
    value = (value << 5) | d;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  if (bytes.length < 4 || bytes.length > 4 + 29) return false;
  const body = bytes.slice(4);
  const sum = crc32(body);
  if (bytes[0] !== sum >>> 24 || bytes[1] !== ((sum >>> 16) & 0xff) || bytes[2] !== ((sum >>> 8) & 0xff) || bytes[3] !== (sum & 0xff)) return false;
  // encode back: base32 without padding, groups of five
  let out = "";
  bits = 0;
  value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out.match(/.{1,5}/g).join("-") === text;
}

export function manifest(canisterId) {
  if (!isPrincipalText(canisterId)) throw new TypeError(`manifest: ${JSON.stringify(canisterId)} is not a principal in its textual form (checksum included)`);
  return {
    version: "1.0.0",
    canisters: [
      {
        id: canisterId,
        name: "tok",
        role: "the token",
        description: "Call get_api_doc first. Ask the person before any send; icrc21_canister_call_consent_message says what a send does.",
      },
    ],
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.stdout.write(`${JSON.stringify(manifest(process.argv[2]), null, 2)}\n`);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}
