// @meantjs/consent as a TypeScript consumer uses it: the ICRC-21 call over a resolved form.
import { createSchemaValidator, loadPacks, resolveService } from "@meantjs/profile";
import {
  ConsentError,
  decodeConsentResponse,
  encodeConsentRequest,
  generateConsent,
  handleConsentRequest,
  icrc21ConsentMessage,
  type Icrc21ConsentMessageResponse,
  type Icrc21Result,
} from "@meantjs/consent";
import { LEDGER_DID, bytesFromHex, check } from "./check.mts";

const r = await resolveService({ did: LEDGER_DID, validateSchema: await createSchemaValidator(), packs: (await loadPacks()).map(({ doc }) => ({ doc })) });
check(r.ok && r.resolved !== null, "resolved");
const resolved = r.resolved;
const refs = { "query:icrc1_decimals": 8, "query:icrc1_symbol": "TKA" };
// The plain transfer: 0.29 TKA to k2t6j-..., every optional absent (packages/consent/test/golden/transfer-tka-basic.json).
const arg = bytesFromHex(
  "4449444c086c06fbca0101c6fcb60204ba89e5c20405a2de94eb060282f3f3910c07d8a38ca80d7d6c02b3b0dac30368ad86ca8305026e036d7b6e7d6e066d7b6e780100011db56bf994b37ae8e79f5ce000be1727a6060ae4eef24736b7cc999c3c020000000001008058b6afdadc18c082ea0d",
);

const response: Icrc21Result = icrc21ConsentMessage(
  { method: "icrc1_transfer", arg, user_preferences: { metadata: { language: "en", utc_offset_minutes: null }, device_spec: { GenericDisplay: null } } },
  { resolved, refs },
);
check("Ok" in response, "Ok");
const message = response.Ok.consent_message;
check("GenericDisplayMessage" in message && message.GenericDisplayMessage.includes("0.29 TKA"), "the generic message");
check(Array.isArray(response.diagnostics) && response.provenance.intent !== undefined, "diagnostics and provenance");

const fields = generateConsent({ resolved, method: "icrc1_transfer", arg, refs, form: "fields" });
check("FieldsDisplayMessage" in fields.message, "the fields message");
const amount = fields.message.FieldsDisplayMessage.fields.find(([label]) => label === "Amount")?.[1];
check(amount !== undefined && "TokenAmount" in amount && amount.TokenAmount.amount === 29000000n, "a TokenAmount");

const request = encodeConsentRequest({ method: "icrc1_transfer", arg, user_preferences: { metadata: { language: "en", utc_offset_minutes: 60 }, device_spec: null } });
const decoded: Icrc21ConsentMessageResponse = decodeConsentResponse(handleConsentRequest(request, { resolved, refs }));
check("Ok" in decoded, "the canister-side wrapper");

try {
  generateConsent({ resolved, method: "nope", arg, refs });
  check(false, "an unknown method must throw");
} catch (e) {
  check(e instanceof ConsentError && e.code === "E_METHOD_UNKNOWN", "E_METHOD_UNKNOWN");
}

export function refused(): void {
  // @ts-expect-error the form is "fields" or "generic"
  generateConsent({ resolved, method: "icrc1_transfer", arg, form: "markdown" });
}
