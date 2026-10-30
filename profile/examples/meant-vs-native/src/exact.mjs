// Exact base units to token text with BigInt only. Independent of @meantjs/format on purpose: the write-up checks
// every tool's text, Meant's included, against this.
export function exactDecimal(units, decimals) {
  const neg = units < 0n;
  const s = (neg ? -units : units).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
