// Types for @meantjs/profile/address: the address grammar (spec section 3) and the Candid field-name hash, with
// no dependency, for a browser bundle. Hand-written; the source is src/address.mjs and src/idl.mjs.
// test/types.test.mjs keeps the declared names equal to the runtime exports.

export interface PathSegment {
  kind: "field" | "elem";
  /** The field name, or `#<id>` for a numeric id. */
  label?: string;
  id?: number;
}

export type Address =
  | { kind: "type"; decl: string; segs: PathSegment[] }
  | { kind: "arg" | "result"; method: string; index: number; segs: PathSegment[] }
  | { kind: "method"; method: string; segs: [] };

/** The largest Candid field id. */
export const U32_MAX: 4294967295;
/** The Candid field-name hash. */
export function idlHash(label: string): number;
/** `.amount.e8s`, `.#5`, `[]` to segments; null when the path does not parse. */
export function parsePath(path: string): PathSegment[] | null;
/** `send(0).to`, `balance->(0)`, `type:Tokens.e8s` or a method name; null when the address does not parse. */
export function parseAddress(at: string): Address | null;
/** A path relative to a method: `(0).to.owner`, `to.owner` or `Ok`; `index` is null without `(n)`. */
export function parseRelPath(rel: string): { index: number | null; segs: PathSegment[] } | null;
/** The resolver's key of a method position. */
export function methodKey(method: string, side: "arg" | "res", index: number, segs: PathSegment[]): string;
/** The resolver's key of a `type:` edge. */
export function edgeKey(parent: { container: number; kind: string; id?: number }): string;
