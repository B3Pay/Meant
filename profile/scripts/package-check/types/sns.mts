// @meantjs/consent/sns (Node only), as a TypeScript consumer uses it.
import { createSchemaValidator, loadPacks, resolveService } from "@meantjs/profile";
import { SNS_RENDERING_RULES, decodeValidatorResult, handleSnsValidatorCall, snsValidatorRendering, type ValidatorResult } from "@meantjs/consent/sns";
import { LEDGER_DID, bytesFromHex, check } from "./check.mts";

const r = await resolveService({ did: LEDGER_DID, validateSchema: await createSchemaValidator(), packs: (await loadPacks()).map(({ doc }) => ({ doc })) });
check(r.resolved !== null, "resolved");
const payload = bytesFromHex(
  "4449444c086c06fbca0101c6fcb60204ba89e5c20405a2de94eb060282f3f3910c07d8a38ca80d7d6c02b3b0dac30368ad86ca8305026e036d7b6e7d6e066d7b6e780100011db56bf994b37ae8e79f5ce000be1727a6060ae4eef24736b7cc999c3c020000000001008058b6afdadc18c082ea0d",
);
const refs = { "query:icrc1_decimals": 8, "query:icrc1_symbol": "TKA" };
const rendering = snsValidatorRendering({ payload, resolved: r.resolved, method: "icrc1_transfer", refs });
check("Ok" in rendering && rendering.Ok.includes(SNS_RENDERING_RULES), "the rendering names its rules");
const reply: ValidatorResult = decodeValidatorResult(handleSnsValidatorCall(payload, { resolved: r.resolved, method: "icrc1_transfer", refs }));
check("Ok" in reply, "the canister-side wrapper");
