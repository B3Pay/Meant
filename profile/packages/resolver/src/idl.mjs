// Candid label ids. Pure and dependency-free: the browser-safe `@meantjs/profile/address` entry imports it.

export const U32_MAX = 4294967295;

/** Candid field/method id: the hash of the label (Candid spec, "Hash of field names"). */
export function idlHash(label) {
  let h = 0;
  for (const b of new TextEncoder().encode(label)) h = (Math.imul(h, 223) + b) >>> 0;
  return h;
}
