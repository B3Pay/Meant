// Keccak-256 in plain JavaScript, synchronous, as Ethereum uses it: the original Keccak padding (0x01), not the NIST
// SHA3-256 one (0x06). For function selectors, EIP-55 checksums, ERC-8176 descriptor hashes and EIP-712 digests
// (spec section 15, D-054). test/evm.test.mjs checks it against the known hashes of the empty string and of the
// ERC-20 selectors, and against the ERC-8176 schema UID.
//
// The 1600-bit state is 25 lanes of 64 bits, each kept as two 32-bit halves: s[2i] the low half, s[2i + 1] the high.

const RC = new Uint32Array([
  // round constants, [low, high] per round
  0x00000001, 0x00000000, 0x00008082, 0x00000000, 0x0000808a, 0x80000000, 0x80008000, 0x80000000,
  0x0000808b, 0x00000000, 0x80000001, 0x00000000, 0x80008081, 0x80000000, 0x00008009, 0x80000000,
  0x0000008a, 0x00000000, 0x00000088, 0x00000000, 0x80008009, 0x00000000, 0x8000000a, 0x00000000,
  0x8000808b, 0x00000000, 0x0000008b, 0x80000000, 0x00008089, 0x80000000, 0x00008003, 0x80000000,
  0x00008002, 0x80000000, 0x00000080, 0x80000000, 0x0000800a, 0x00000000, 0x8000000a, 0x80000000,
  0x80008081, 0x80000000, 0x00008080, 0x80000000, 0x80000001, 0x00000000, 0x80008008, 0x80000000,
]);
// rotation offsets of the rho step, by lane index x + 5y
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
// the lane the pi step moves lane x + 5y to: (y, 2x + 3y)
const PI = ROT.map((_, i) => {
  const x = i % 5;
  const y = (i - x) / 5;
  return y + 5 * ((2 * x + 3 * y) % 5);
});
const RATE = 136; // bytes: 1600 - 2 * 256 bits

function permute(s) {
  const c = new Uint32Array(10);
  const b = new Uint32Array(50);
  for (let round = 0; round < 24; round++) {
    // theta
    for (let x = 0; x < 5; x++) {
      c[2 * x] = s[2 * x] ^ s[2 * x + 10] ^ s[2 * x + 20] ^ s[2 * x + 30] ^ s[2 * x + 40];
      c[2 * x + 1] = s[2 * x + 1] ^ s[2 * x + 11] ^ s[2 * x + 21] ^ s[2 * x + 31] ^ s[2 * x + 41];
    }
    for (let x = 0; x < 5; x++) {
      const next = (x + 1) % 5;
      const prev = (x + 4) % 5;
      const lo = c[2 * prev] ^ ((c[2 * next] << 1) | (c[2 * next + 1] >>> 31));
      const hi = c[2 * prev + 1] ^ ((c[2 * next + 1] << 1) | (c[2 * next] >>> 31));
      for (let y = 0; y < 25; y += 5) {
        s[2 * (x + y)] ^= lo;
        s[2 * (x + y) + 1] ^= hi;
      }
    }
    // rho and pi
    for (let i = 0; i < 25; i++) {
      const lo = s[2 * i];
      const hi = s[2 * i + 1];
      const n = ROT[i];
      const j = PI[i];
      if (n === 0) {
        b[2 * j] = lo;
        b[2 * j + 1] = hi;
      } else if (n < 32) {
        b[2 * j] = (lo << n) | (hi >>> (32 - n));
        b[2 * j + 1] = (hi << n) | (lo >>> (32 - n));
      } else if (n === 32) {
        b[2 * j] = hi;
        b[2 * j + 1] = lo;
      } else {
        const m = n - 32;
        b[2 * j] = (hi << m) | (lo >>> (32 - m));
        b[2 * j + 1] = (lo << m) | (hi >>> (32 - m));
      }
    }
    // chi
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        const i = x + y;
        const i1 = ((x + 1) % 5) + y;
        const i2 = ((x + 2) % 5) + y;
        s[2 * i] = b[2 * i] ^ (~b[2 * i1] & b[2 * i2]);
        s[2 * i + 1] = b[2 * i + 1] ^ (~b[2 * i1 + 1] & b[2 * i2 + 1]);
      }
    }
    // iota
    s[0] ^= RC[2 * round];
    s[1] ^= RC[2 * round + 1];
  }
}

/** Keccak-256 of a byte array (or a string, as its UTF-8 bytes), as 32 bytes. */
export function keccak256(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const s = new Uint32Array(50);
  const blocks = Math.floor(bytes.length / RATE) + 1;
  const padded = new Uint8Array(blocks * RATE);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  for (let off = 0; off < padded.length; off += RATE) {
    for (let k = 0; k < RATE; k += 4) {
      s[k >> 2] ^= padded[off + k] | (padded[off + k + 1] << 8) | (padded[off + k + 2] << 16) | (padded[off + k + 3] << 24);
    }
    permute(s);
  }
  const out = new Uint8Array(32);
  for (let k = 0; k < 32; k++) out[k] = (s[k >> 2] >>> (8 * (k & 3))) & 0xff;
  return out;
}

/** Keccak-256 as 64 lowercase hex digits, without `0x`. */
export function keccak256Hex(input) {
  let hex = "";
  for (const b of keccak256(input)) hex += b.toString(16).padStart(2, "0");
  return hex;
}
