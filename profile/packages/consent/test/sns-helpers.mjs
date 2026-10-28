// Helpers for the SNS validator rendering tests: the hypothetical dapp of test/fixtures/sns-dapp.did through the real
// resolver, and governance's own wrapper around a validator's text, written from the SNS governance source.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createSchemaValidator, loadPacks, resolveService } from "@meantjs/profile";

const read = (rel) => readFileSync(new URL(rel, import.meta.url), "utf8");

export const DAPP_DID = read("./fixtures/sns-dapp.did");
const DAPP_PROFILE = JSON.parse(read("./fixtures/sns-dapp.profile.json"));

const validateSchema = await createSchemaValidator();
const packs = (await loadPacks()).map(({ doc }) => ({ doc }));
async function resolve(profiles) {
  const r = await resolveService({ did: DAPP_DID, validateSchema, profiles, packs });
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics.filter((d) => d.severity === "error")));
  return r.resolved;
}

/** The dapp with its author profile, and the same dapp with no profile at all. */
export const dapp = await resolve([{ doc: DAPP_PROFILE }]);
export const bareDapp = await resolve([]);

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * The `{function:#?}` debug text of a generic NervousSystemFunction, in the layout of the expected value of the
 * upstream test `validate_and_render_execute_nervous_system_function_success` (dfinity/ic 649156c,
 * rs/sns/governance/src/proposal.rs).
 */
export function functionDebug({ id = 1000, name = "a", description = null, target, targetMethod, validator, validatorMethod, topic = "DaoCommunitySettings" }) {
  return `NervousSystemFunction {
    id: ${id},
    name: ${JSON.stringify(name)},
    description: ${description === null ? "None" : `Some(\n        ${JSON.stringify(description)},\n    )`},
    function_type: Some(
        GenericNervousSystemFunction(
            GenericNervousSystemFunction {
                target_canister_id: Some(
                    ${target},
                ),
                target_method_name: Some(
                    ${JSON.stringify(targetMethod)},
                ),
                validator_canister_id: Some(
                    ${validator},
                ),
                validator_method_name: Some(
                    ${JSON.stringify(validatorMethod)},
                ),
                topic: Some(
                    ${topic},
                ),
            },
        ),
    ),
}`;
}

/** What governance stores as `payload_text_rendering` (proposal.rs, `validate_and_render_execute_nervous_system_function`). */
export function governanceRendering(fnDebug, payload, rendering) {
  return `# Proposal to execute nervous system function:

## Nervous system function:

${fnDebug}

## Payload sha256: 

${sha256Hex(payload)}

## Payload:

${rendering}`;
}

/** What `get_proposal` returns in place of a payload over 64 bytes (types.rs, `summarize_blob_field`). */
export function proposalPayloadSummary(blob) {
  if (blob.length <= 64) return Uint8Array.from(blob);
  const hex = (b) => [...b].map((x) => x.toString(16).toUpperCase().padStart(2, "0")).join(" ");
  const digest = createHash("sha256").update(blob).digest();
  const tail = blob.slice(blob.length - 32); // rchunks_exact(32).next(): the last 32 bytes (blob.length > 64 here)
  const text = `⚠️ NOT THE ORIGINAL CONTENTS OF THIS FIELD ⚠️\n\nThe original value had the following properties:\n- Length: ${blob.length}\n- SHA256 Hash:                ${hex(digest)}\n- Leading  32 Bytes (in hex): ${hex(blob.slice(0, 32))}\n- Trailing 32 Bytes (in hex): ${hex(tail)}`;
  return new TextEncoder().encode(text);
}
