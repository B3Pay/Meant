// A transcription, by reading, of how OISY's signer builds the fallback consent message for icrc1_transfer when
// the ledger does not answer the ICRC-21 call. NOT executed from OISY's code: the downloaded repositories were
// only read (they are untrusted data). The transcription is checked against the expectations in OISY's own tests
// (see test/oisy-comparison.test.mjs).
//
// Sources, as read:
//   dfinity/oisy-wallet            c4eb38920a1c110bb6c908a18d7336d4d306638c (v2.6.1, 2026-10-08)
//     package.json / package-lock.json: "@dfinity/oisy-wallet-signer": "^6.0.0", locked at 6.0.0
//     src/frontend/src/lib/components/signer/SignerConsentMessage.svelte     renders the message (marked + DOMPurify)
//     src/frontend/src/lib/utils/html.utils.ts                               UNTRUSTED_CONFIG (allowed tags and attributes)
//   dfinity/oisy-wallet-signer     89c42a33189c2be04bdd004441f36fb36ded95c7 (tag v6.0.0, 2026-05-22)
//     src/builders/signer.builders.ts   buildContentMessageIcrc1Transfer, section(), buildMemo()
//     src/utils/format.utils.ts         formatAmount
//     src/utils/builders.utils.ts       decodeMemo
//     src/i18n/en.json                  the labels
//     src/services/signer.service.ts    loadConsentMessage / tryBuildConsentMessageOnError (when the fallback runs)

import { displayAccount } from "@meantjs/format";

/** formatAmount of src/utils/format.utils.ts: a double and Intl.NumberFormat. */
export function formatAmount({ amount, decimals }) {
  const converted = Number(amount) / 10 ** decimals;
  // For ease of readability we want to display two decimals at least but, handle edge case where ledgers have none or 1 decimal set.
  const minimumFractionDigits = decimals >= 1 ? 1 : decimals;
  return new Intl.NumberFormat("en-US", { minimumFractionDigits, maximumFractionDigits: decimals }).format(converted);
}

/** decodeMemo of src/utils/builders.utils.ts: TextDecoder without `fatal`, so it never throws and the hex branch is dead. */
export function decodeMemo(bytes) {
  try {
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return `0x${Buffer.from(bytes).toString("hex")}`;
  }
}

const section = (text) => `**${text}:**`;

/**
 * buildContentMessageIcrc1Transfer: `{amount, from_subaccount, to, fee, memo}` are the decoded arguments (this package's
 * value tree), `owner` the signer's principal text (the caller), `token` the ledger metadata read at signing time.
 */
export function oisyIcrc1TransferMessage({ args, owner, token }) {
  const { amount, from_subaccount: fromSubaccount, to, fee, memo } = args;
  const { symbol, decimals, fee: tokenFee } = token;
  const message = ["# Approve the transfer of funds"];
  message.push(`${section("Amount")}\n${formatAmount({ amount: BigInt(amount), decimals })} ${symbol}`);
  message.push(`${section("From")}\n${displayAccount({ owner, subaccount: fromSubaccount })}`);
  message.push(`${section("To")}\n${displayAccount({ owner: to.owner, subaccount: to.subaccount })}`);
  message.push(`${section("Fee")}\n${formatAmount({ amount: BigInt(fee ?? tokenFee), decimals })} ${symbol}`);
  if (memo !== null) message.push(`${section("Memo")}\n${decodeMemo(memo)}`);
  return message.join("\n\n");
}
