import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { crc32 as zlibCrc32 } from "node:zlib";
import { CODES, FormatError, displayAccount, parseAccount, principalFromText, principalToText } from "../src/index.mjs";
import { crc32 } from "../src/principal.mjs";
import { SEED, makeRng } from "./helpers/prng.mjs";

const here = (rel) => new URL(rel, import.meta.url);
const vectors = JSON.parse(readFileSync(here("./vectors/icrc1-textual-encoding.json"), "utf8"));
const hex = (b) => Buffer.from(b).toString("hex");
const unhex = (h) => Uint8Array.from(Buffer.from(h, "hex"));
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof FormatError, `expected FormatError, got ${e}`);
    return e.code;
  }
  assert.fail("expected a FormatError, but nothing was thrown");
};

const OWNER = "k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae";

// ---------------------------------------------------------------- official vectors

test("ICRC-1 vectors: provenance is recorded and the committed download matches it", () => {
  const source = JSON.parse(readFileSync(here("../upstream/icrc1/SOURCE.json"), "utf8"));
  assert.match(vectors.source.commit, /^[0-9a-f]{40}$/);
  assert.equal(vectors.source.commit, source.commit);
  assert.equal(vectors.source.path, "standards/ICRC-1/TextualEncoding.md");
  assert.equal(vectors.source.repo, "https://github.com/dfinity/ICRC-1");
  // Hash the bytes only; the download is data and is never imported or executed.
  const md = readFileSync(here("../upstream/icrc1/TextualEncoding.md"));
  assert.equal(createHash("sha256").update(md).digest("hex"), vectors.source.sha256);
  assert.equal(source.files["TextualEncoding.md"].sha256, vectors.source.sha256);
  assert.equal(vectors.parse.length, 7);
  assert.equal(vectors.display.length, 3);
  // every extracted example really appears in the downloaded document
  const text = md.toString("utf8");
  for (const v of vectors.parse) assert.ok(text.includes(v.text), `vector text missing from the source: ${v.text}`);
  for (const v of vectors.display) assert.ok(text.includes(`= "${v.text}"`), `display text missing from the source: ${v.text}`);
});

test("ICRC-1 vectors: every Examples-table row parses as the standard says", () => {
  for (const v of vectors.parse) {
    if (v.ok) {
      const a = parseAccount(v.text);
      assert.equal(a.owner, v.owner, v.text);
      assert.equal(a.subaccount === null ? null : hex(a.subaccount), v.subaccount, v.text);
    } else {
      assert.throws(() => parseAccount(v.text), FormatError, `${v.text} (${v.comment})`);
    }
  }
});

test("ICRC-1 vectors: the rejected rows are rejected for the reason the standard gives", () => {
  const reason = Object.fromEntries(vectors.parse.filter((v) => !v.ok).map((v) => [v.comment, v.text]));
  assert.equal(code(() => parseAccount(reason["The representation is not canonical: default subaccount should be omitted."])), CODES.NOT_CANONICAL);
  assert.equal(code(() => parseAccount(reason["Invalid principal encoding."])), CODES.PRINCIPAL);
  assert.equal(code(() => parseAccount(reason["The representation is not canonical: leading zeros are not allowed in subaccounts."])), CODES.NOT_CANONICAL);
  assert.equal(code(() => parseAccount(reason["Missing check sum."])), CODES.CHECKSUM_MISSING);
});

test("ICRC-1 vectors: every Account.toText example displays as the standard says", () => {
  for (const v of vectors.display) {
    const subaccount = v.subaccount === null ? null : unhex(v.subaccount);
    assert.equal(displayAccount({ owner: v.owner, subaccount }), v.text);
  }
  // The worked example with checksum dfxgiyy
  assert.equal(
    displayAccount({ owner: OWNER, subaccount: Uint8Array.from({ length: 32 }, (_, i) => i + 1) }),
    `${OWNER}-dfxgiyy.102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20`,
  );
});

// ---------------------------------------------------------------- principal text

test("principal text: well-known ids", () => {
  const known = {
    "aaaaa-aa": "", // the management canister: zero bytes
    "2vxsx-fae": "04", // anonymous
    "ryjl3-tyaaa-aaaaa-aaaba-cai": "00000000000000020101", // ICP ledger
    "rrkah-fqaaa-aaaaa-aaaaq-cai": "00000000000000010101", // NNS governance
    "rwlgt-iiaaa-aaaaa-aaaaa-cai": "000000000000000001" + "01", // NNS registry: canister id 0
  };
  for (const [text, h] of Object.entries(known)) {
    assert.equal(hex(principalFromText(text)), h, text);
    assert.equal(principalToText(unhex(h)), text);
  }
});

test("principal text: case-insensitive input, canonical output", () => {
  assert.equal(hex(principalFromText("RYJL3-TYAAA-AAAAA-AAABA-CAI")), "00000000000000020101");
  assert.equal(parseAccount("RYJL3-TYAAA-AAAAA-AAABA-CAI").owner, "ryjl3-tyaaa-aaaaa-aaaba-cai");
});

test("principal text: malformed input is rejected", () => {
  for (const bad of ["", "-", "aaaaa", "aaaaaaa", "aaaaa-ab", "aaaaaaa-", "aaaa-aaa", "aaaaa--aa", "aaaaa-aa-", "ryjl3-tyaaa-aaaaa-aaaba-caj", "ryjl3tyaaaaaaaaaaabacai", "ryjl3-tyaaa-aaaaa-aaaba-ca1", "ryjl3-tyaaa-aaaaa-aaaba-cai ", "ryjl3-tyaaa-aaaaa-aaaba-cai-"]) {
    assert.equal(code(() => principalFromText(bad)), CODES.PRINCIPAL, JSON.stringify(bad));
  }
  assert.equal(code(() => principalToText(new Uint8Array(30))), CODES.PRINCIPAL, "30 bytes is too long");
  assert.equal(code(() => principalFromText(principalToText(new Uint8Array(29)) + "-aaaaa")), CODES.PRINCIPAL);
  assert.equal(code(() => principalFromText(5)), CODES.TYPE);
});

// ---------------------------------------------------------------- independent oracles

/** CRC-32 from node:zlib, an implementation we did not write. */
const oracleCrc = (bytes) => zlibCrc32(bytes) >>> 0;

/** base32 (lowercase, no padding) by big-integer division: a different algorithm from the bit-shifter in src. */
function oracleBase32(bytes) {
  const A = "abcdefghijklmnopqrstuvwxyz234567";
  const bits = bytes.length * 8;
  const chars = Math.ceil(bits / 5);
  let n = bytes.length === 0 ? 0n : BigInt("0x" + Buffer.from(bytes).toString("hex"));
  n <<= BigInt(chars * 5 - bits);
  let out = "";
  for (let i = 0; i < chars; i++) {
    out = A[Number(n % 32n)] + out;
    n /= 32n;
  }
  return out;
}
const be32 = (n) => Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

function oracleAccountText(owner, sub) {
  const principal = oracleBase32(Uint8Array.from([...be32(oracleCrc(owner)), ...owner])).match(/.{1,5}/g)?.join("-") ?? "";
  if (sub === null || sub.every((b) => b === 0)) return principal;
  const checksum = oracleBase32(be32(oracleCrc(Uint8Array.from([...owner, ...sub]))));
  return `${principal}-${checksum}.${hex(sub).replace(/^0+/, "")}`;
}

test("CRC-32 matches node:zlib", () => {
  const rng = makeRng(SEED);
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926, "the standard check value");
  for (let i = 0; i < 500; i++) {
    const b = rng.bytes(rng.int(80));
    assert.equal(crc32(b), oracleCrc(b), `seed ${SEED}: ${hex(b)}`);
  }
});

// ---------------------------------------------------------------- properties

function randomAccount(rng) {
  const owner = rng.bytes(rng.int(30));
  const kind = rng.int(6);
  let sub = null;
  if (kind === 1) sub = new Uint8Array(32); // explicit default
  else if (kind >= 2) {
    sub = rng.bytes(32);
    sub.fill(0, 0, rng.int(33)); // 0 to 32 leading zero bytes, so trimming is exercised
    if (kind === 3 && rng.bool()) sub[31] = 0; // trailing zero byte
  }
  return { owner, sub };
}

test(`property: display then parse is the identity, and display matches an independently built text (seed ${SEED})`, () => {
  const rng = makeRng(SEED + 10);
  for (let i = 0; i < 3000; i++) {
    const { owner, sub } = randomAccount(rng);
    const text = displayAccount({ owner, subaccount: sub });
    assert.equal(text, oracleAccountText(owner, sub), `seed ${SEED + 10}: owner ${hex(owner)} sub ${sub && hex(sub)}`);
    const back = parseAccount(text);
    assert.equal(back.owner, principalToText(owner));
    const isDefault = sub === null || sub.every((b) => b === 0);
    if (isDefault) assert.equal(back.subaccount, null, text);
    else assert.deepEqual(hex(back.subaccount), hex(sub), text);
    assert.equal(displayAccount(back), text, "display is stable");
  }
});

test(`property: any single-character change to a canonical account text is rejected (seed ${SEED})`, () => {
  const rng = makeRng(SEED + 11);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567-.0123456789";
  for (let i = 0; i < 40; i++) {
    const { owner, sub } = randomAccount(rng);
    const text = displayAccount({ owner, subaccount: sub });
    for (let p = 0; p < text.length; p++) {
      for (const ch of alphabet) {
        if (ch === text[p]) continue;
        const mutated = text.slice(0, p) + ch + text.slice(p + 1);
        assert.throws(() => parseAccount(mutated), FormatError, `seed ${SEED + 11}: ${text} -> ${mutated}`);
      }
    }
  }
});

// ---------------------------------------------------------------- rules

test("account: a bare principal is the default subaccount", () => {
  assert.deepEqual(parseAccount(OWNER), { owner: OWNER, subaccount: null });
  assert.equal(displayAccount({ owner: OWNER }), OWNER);
  assert.equal(displayAccount({ owner: OWNER, subaccount: null }), OWNER);
  assert.equal(displayAccount({ owner: OWNER, subaccount: new Uint8Array(32) }), OWNER);
});

test("account: input is trimmed, case-insensitive, and displayed canonically", () => {
  const withSub = displayAccount({ owner: OWNER, subaccount: Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0)) });
  assert.equal(withSub, `${OWNER}-6cc627i.1`);
  const a = parseAccount(`  ${withSub.toUpperCase()}  `);
  assert.equal(displayAccount(a), withSub);
  assert.equal(hex(a.subaccount), "00".repeat(31) + "01");
});

test("account: subaccount hex is trimmed of leading zeros but never of other zeros", () => {
  for (const [subHex, tail] of [["00".repeat(31) + "10", "10"], ["01" + "00".repeat(31), "1" + "00".repeat(31)], ["000000000000000000000000000000000000000000000000000000000000abcd", "abcd"]]) {
    const text = displayAccount({ owner: "aaaaa-aa", subaccount: unhex(subHex) });
    assert.ok(text.endsWith(`.${tail}`), text);
    assert.equal(hex(parseAccount(text).subaccount), subHex);
  }
});

test("account: the checksum is verified on input (spec 5.3)", () => {
  const good = `${OWNER}-dfxgiyy.102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20`;
  assert.ok(parseAccount(good));
  assert.equal(code(() => parseAccount(good.replace("-dfxgiyy.", "-dfxgiyz."))), CODES.CHECKSUM);
  assert.equal(code(() => parseAccount(good.replace("-dfxgiyy.", "-aaaaaaa."))), CODES.CHECKSUM);
  assert.equal(code(() => parseAccount(good.slice(0, -1) + "1")), CODES.CHECKSUM, "a changed subaccount digit");
  // the checksum of a different owner
  const other = displayAccount({ owner: "ryjl3-tyaaa-aaaaa-aaaba-cai", subaccount: Uint8Array.from({ length: 32 }, (_, i) => i + 1) });
  const otherChecksum = other.split("-").at(-1).split(".")[0];
  assert.equal(code(() => parseAccount(good.replace("dfxgiyy", otherChecksum))), CODES.CHECKSUM);
});

test("account: a missing or malformed checksum", () => {
  for (const bad of [`${OWNER}.1`, `${OWNER}-.1`, `${OWNER}-abc.1`, `${OWNER}-6cc627.1`, `${OWNER}-6cc627ii.1`, `${OWNER}-6cc6271.1`, `.1`, "aaaaa-aa.1"]) {
    const c = code(() => parseAccount(bad));
    assert.ok([CODES.CHECKSUM_MISSING, CODES.PRINCIPAL].includes(c), `${bad} -> ${c}`);
  }
  assert.equal(code(() => parseAccount(`${OWNER}.1`)), CODES.CHECKSUM_MISSING);
});

test("account: non-canonical texts are rejected", () => {
  assert.equal(code(() => parseAccount(`${OWNER}-q6bn32y.`)), CODES.NOT_CANONICAL, "default subaccount written out");
  assert.equal(code(() => parseAccount(`${OWNER}-q6bn32y.0`)), CODES.NOT_CANONICAL, "zero subaccount");
  assert.equal(code(() => parseAccount(`${OWNER}-q6bn32y.${"0".repeat(64)}`)), CODES.NOT_CANONICAL, "64 zero digits");
  assert.equal(code(() => parseAccount(`${OWNER}-6cc627i.01`)), CODES.NOT_CANONICAL, "leading zero");
  assert.equal(code(() => parseAccount(`${OWNER}-6cc627i.${"0".repeat(63)}1`)), CODES.NOT_CANONICAL, "padded to 64");
  assert.equal(code(() => parseAccount("k2t6j2nvnp4zjm3-25dtz6xhaac7boj5gayfoj3xs-i43lp-teztq-6ae")), CODES.PRINCIPAL, "wrong dashes");
});

test("account: other malformed input", () => {
  assert.equal(code(() => parseAccount(`${OWNER}-6cc627i.1.2`)), CODES.SYNTAX);
  assert.equal(code(() => parseAccount(`${OWNER}-6cc627i.xyz`)), CODES.HEX);
  assert.equal(code(() => parseAccount(`${OWNER}-6cc627i.1${"0".repeat(64)}`)), CODES.LENGTH, "65 digits");
  assert.equal(code(() => parseAccount("")), CODES.PRINCIPAL);
  assert.equal(code(() => parseAccount("not a principal")), CODES.PRINCIPAL);
  assert.equal(code(() => parseAccount(12)), CODES.TYPE);
  assert.equal(code(() => parseAccount("a".repeat(5000))), CODES.TOO_LONG);
});

test("account: display validates its input", () => {
  assert.equal(code(() => displayAccount({ owner: OWNER, subaccount: new Uint8Array(31) })), CODES.LENGTH);
  assert.equal(code(() => displayAccount({ owner: OWNER, subaccount: new Uint8Array(33) })), CODES.LENGTH);
  assert.equal(code(() => displayAccount({ owner: "nope" })), CODES.PRINCIPAL);
  assert.equal(code(() => displayAccount({ owner: new Uint8Array(30) })), CODES.PRINCIPAL);
  assert.equal(code(() => displayAccount({ owner: OWNER, subaccount: "00" })), CODES.TYPE);
  assert.equal(code(() => displayAccount({ owner: OWNER, subaccount: [1, 2, 300] })), CODES.TYPE);
  assert.equal(code(() => displayAccount(null)), CODES.TYPE);
  const arr = Array.from({ length: 32 }, (_, i) => i + 1);
  assert.equal(displayAccount({ owner: OWNER, subaccount: arr }), displayAccount({ owner: OWNER, subaccount: Uint8Array.from(arr) }), "a JSON array of byte values is accepted");
  assert.equal(displayAccount({ owner: principalFromText(OWNER) }), OWNER, "owner as bytes");
});
