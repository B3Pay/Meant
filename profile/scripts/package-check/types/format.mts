// @meantjs/format as a TypeScript consumer uses it.
import {
  CODES,
  FormatError,
  VALUE_TAGS,
  asUint8Array,
  displayAccount,
  displayAmount,
  displayTimestamp,
  formatterFor,
  parseAccount,
  parseAmount,
  parseDuration,
  parseSubaccount,
  principalFromText,
  principalToText,
  type Account,
  type FormatErrorCode,
  type Formatter,
} from "@meantjs/format";
import { check } from "./check.mts";

const base: string = parseAmount("1.5 TKA", { decimals: 8, symbol: "TKA" });
check(base === "150000000", "parseAmount");
check(displayAmount(150000000n, { decimals: 8, symbol: "TKA" }) === "1.5 TKA", "displayAmount");
check(parseDuration("PT24H", { unit: "s" }) === "86400", "parseDuration");
check(displayTimestamp(0n, { unit: "ns" }) === "1970-01-01T00:00:00Z", "displayTimestamp");
const view: Uint8Array | null = asUint8Array(new Uint8Array([1, 2]));
check(view !== null && view.length === 2 && asUint8Array(new Uint16Array(1)) === null, "asUint8Array");

const owner = "k2t6j-2nvnp-4zjm3-25dtz-6xhaa-c7boj-5gayf-oj3xs-i43lp-teztq-6ae";
const account: Account = parseAccount(owner);
check(account.subaccount === null && displayAccount(account) === owner, "account round trip");
const bytes: Uint8Array = principalFromText(owner);
check(principalToText(bytes) === owner, "principal round trip");
check(parseSubaccount("#7")[31] === 7, "parseSubaccount");

try {
  parseAmount("0.123456789 TKA", { decimals: 8, symbol: "TKA" });
  check(false, "excess precision must throw");
} catch (e) {
  check(e instanceof FormatError, "a FormatError");
  const code: FormatErrorCode = e.code;
  check(code === CODES.EXCESS_PRECISION, "E_EXCESS_PRECISION");
}

const f: Formatter | null = formatterFor(
  { candid: "nat", tags: { amount: { args: { decimals: { from: "query:icrc1_decimals" }, symbol: "TKA" } } } },
  { refs: { "query:icrc1_decimals": 8 } },
);
check(f !== null && f.tag === "amount", "formatterFor");
const parsed = f.safeParse("2 TKA");
check(parsed.ok && parsed.value === "200000000", "safeParse");
const failed = f.safeParse("2 XYZ");
check(!failed.ok && failed.error.code === "E_SYMBOL_MISMATCH", "safeParse error code");
check(f.describe().summary.length > 0 && VALUE_TAGS.includes(f.tag), "describe");

// The types refuse what the library refuses.
export function refused(): void {
  // @ts-expect-error a number is not an amount: it may have lost precision already
  displayAmount(1.5, { decimals: 8 });
  // @ts-expect-error the unit is one of ns, us, ms, s
  parseDuration("PT1H", { unit: "h" });
  // @ts-expect-error decimals is required
  parseAmount("1", {});
}
