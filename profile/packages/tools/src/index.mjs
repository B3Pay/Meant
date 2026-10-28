// @meantjs/tools: agent tools from any resolved form, browser-safe (#16).
// Arm C (packages/mcp-adapters) stays the eval arm with its frozen texts; this is the product tool layer.

export { COMMIT_TOOL, buildToolPlans, caseToolName, prepareToolName, resolvedMethods, toolDefinitions } from "./plan.mjs";
export { displayValue, readToolInput, toCandid } from "./input.mjs";
export { classifyReply, createToolLayer, nameEntries } from "./layer.mjs";
