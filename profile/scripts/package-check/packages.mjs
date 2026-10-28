// The library packages meant for npm, by directory under packages/. They release in lockstep (one version) and pin
// each other exactly. Everything else under packages/ stays private.
export const LIBRARY_DIRS = Object.freeze(["resolver", "format", "consent", "tools", "reconcile"]);

/** SHA-256 of the Apache License 2.0 text (apache.org LICENSE-2.0.txt), which every library package ships as LICENSE. */
export const APACHE_2_0_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";
