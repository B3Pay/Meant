export { icrc21ConsentMessage, handleConsentRequest, toIcrc21Error, SUPPORTED_LANGUAGE } from "./icrc21.mjs";
export { encodeConsentResponse, decodeConsentResponse, encodeConsentRequest, decodeConsentRequest, toJson } from "./icrc21-codec.mjs";
export { generateConsent } from "./consent.mjs";
export { buildModel } from "./model.mjs";
export { decodeArguments, schemaFor } from "./decode.mjs";
export { parseTemplate } from "./template.mjs";
export { resolvePath, valuesAt } from "./paths.mjs";
export { Renderer, zoneName } from "./display.mjs";
export { renderFields, renderGeneric } from "./render.mjs";
export { codeSpan, escapeMarkdown, visible } from "./text.mjs";
export { ConsentError, CODES, GENERIC_ERROR_CODES } from "./errors.mjs";
// SNS validator renderings are the `./sns` subpath (`@meantjs/consent/sns`): they hash with node:crypto,
// and this entry must bundle for a browser (test/browser-bundle.test.mjs).
