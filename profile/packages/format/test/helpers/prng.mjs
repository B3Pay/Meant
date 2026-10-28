// Small seeded PRNG for property tests (no dependency). The seed defaults to a constant so a
// failure reproduces; set FORMAT_TEST_SEED to explore other inputs. Every property test puts the
// seed in its assertion messages.

export const SEED = Number(process.env.FORMAT_TEST_SEED ?? 20261009) >>> 0;

/** mulberry32 */
export function makeRng(seed = SEED) {
  let a = seed >>> 0;
  const next32 = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  };
  const rng = {
    next32,
    /** integer in [0, n) for n up to 2^32 */
    int(n) {
      return Math.floor((next32() / 4294967296) * n);
    },
    pick(arr) {
      return arr[rng.int(arr.length)];
    },
    bool() {
      return (next32() & 1) === 1;
    },
    /** uniform bigint with exactly `bits` random bits */
    bits(bits) {
      let v = 0n;
      for (let got = 0; got < bits; got += 32) v = (v << 32n) | BigInt(next32());
      const extra = BigInt(Math.ceil(bits / 32) * 32 - bits);
      return v >> extra;
    },
    /** bigint with a random bit length in [0, maxBits], so small and huge values are both common */
    bigint(maxBits) {
      return rng.bits(rng.int(maxBits + 1));
    },
    bytes(n) {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = next32() & 255;
      return out;
    },
  };
  return rng;
}
