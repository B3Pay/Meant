// Bytes as callers hand them over: a Uint8Array or an ArrayBuffer from any realm (an iframe, a node:vm context, an
// extension's content script, a test environment), or an array of integers 0..255 (the JSON form of a blob). Anything
// else is not bytes: an array holding 256 or -1 is refused, never wrapped modulo 256, so a message never describes
// other bytes than the ones it was given.
import { asUint8Array } from "@meantjs/format";

const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get;

/** The value as a Uint8Array of this realm (a view, not a copy, where it can be), or null when it is not bytes. */
export function bytesOf(value) {
  const view = asUint8Array(value);
  if (view !== null) return view;
  if (isArrayBuffer(value)) {
    try {
      return new Uint8Array(value);
    } catch {
      return null; // detached
    }
  }
  if (Array.isArray(value) && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) return Uint8Array.from(value);
  return null;
}

/** An ArrayBuffer of any realm: its intrinsic getter reads the internal slot, which nothing else has. */
function isArrayBuffer(value) {
  try {
    arrayBufferByteLength.call(value);
    return true;
  } catch {
    return false;
  }
}
