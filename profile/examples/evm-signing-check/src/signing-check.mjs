// Meant's signing check for an AI agent's EVM key. The user confirms the terms of a task on the wallet's own screen
// (the token, who is paid or may spend, at most how much, until when); the agent then signs through an account that
// signs only EIP-712 requests a Meant profile reads and whose grant fits those terms, and that says why, in words, when
// it does not. Two published packages and nothing else: @meantjs/consent 0.8.0 (the terms guard, D-056 and D-062) and
// @meantjs/profile 0.8.0 (the profiles of USDC, Permit2 and x402's payments). It imports no Node built-in: bundled
// for a browser by esbuild, it builds with @meantjs/cli left external, as scripts/package-check bundles
// @meantjs/profile/browser (that is the Candid compiler, which these EVM profiles never call). A wallet can copy this
// file as it is.
import { GuardError, guardSigner } from "@meantjs/consent/guard";
import { readTerms, TermsError, termsGate } from "@meantjs/consent/terms";
import { createSchemaValidator, validateProfile } from "@meantjs/profile/browser";
import permit2 from "@meantjs/profile/packs/permit2.profile.json" with { type: "json" };
import usdcBaseSepolia from "@meantjs/profile/packs/usdc-base-sepolia.profile.json" with { type: "json" };
import usdcDomainUsdc from "@meantjs/profile/packs/usdc-domain-usdc.profile.json" with { type: "json" };
import usdc from "@meantjs/profile/packs/usdc.profile.json" with { type: "json" };
import x402ExactPermit2 from "@meantjs/profile/packs/x402-exact-permit2.profile.json" with { type: "json" };
import x402UptoPermit2 from "@meantjs/profile/packs/x402-upto-permit2.profile.json" with { type: "json" };

/** What the account may sign for: USDC's own messages (EIP-3009, EIP-2612), Permit2's permits and x402's two Permit2 payments, as @meantjs/profile ships them. */
export const PROFILES = Object.freeze([usdc, usdcDomainUsdc, usdcBaseSepolia, permit2, x402ExactPermit2, x402UptoPermit2]);

/** The tool an agent calls to propose a task's terms. The wallet shows the text on its own screen; only the user's tap there confirms it. */
export const TERMS_TOOL = Object.freeze({
  name: "propose_terms",
  description:
    "Propose the terms of one task for the user to confirm on the wallet's own screen, before any signing request is read. Write only what the user said, and ask the user for any term they did not give. Nothing is signed until the user confirms, and then only a request within these terms.",
  inputSchema: {
    type: "object",
    properties: {
      token: { type: "string", description: "The token, by the symbol the wallet knows, such as USDC." },
      to: { type: "string", description: "Who is paid: a name the wallet knows, or the address the user gave. Give `to` or `spender`, not both." },
      spender: { type: "string", description: "Who may spend the tokens: an app's name the wallet knows, or the address the user gave." },
      max_amount: { type: "string", description: "The most, in tokens (\"0.05\", \"100 USDC\"), or \"unlimited\" if the user said so." },
      expires_by: { type: "string", description: "When the permission ends: a date (YYYY-MM-DD), a length (\"30 days\"), hours (\"2 hours\"), or \"never\" if the user said so." },
    },
    required: ["token", "max_amount", "expires_by"],
    additionalProperties: false,
  },
});

const systemNow = () => BigInt(Date.now()) * 1_000_000n;

/**
 * The check for one wallet: the chain it signs for, the tokens it holds and the names it knows.
 *
 * @param {{ chainId: number, tokens: Record<string, { address: string, decimals: number }>, apps?: Record<string, string>, utcOffsetMinutes?: number, now?: () => bigint }} wallet
 *   `tokens` by symbol and `apps` by name, as the user knows them; `now` is nanoseconds since the Unix epoch
 */
export async function signingCheck({ chainId, tokens, apps = {}, utcOffsetMinutes = 0, now = systemNow }) {
  const validateSchema = await createSchemaValidator();
  const forms = [];
  for (const doc of PROFILES) {
    const result = await validateProfile(doc, { validateSchema, resolved: true });
    if (!result.ok) throw new Error(`profile ${doc.name} does not validate: ${result.diagnostics.map((d) => d.code).join(", ")}`);
    forms.push(result.resolved);
  }
  const wallet = { tokens, apps, utcOffsetMinutes };
  return {
    forms,
    /**
     * One task, from the terms the agent proposed (TERMS_TOOL's arguments). Throws TermsError when a term cannot be
     * read: an unknown token or name, excess decimals, a past date. Nothing is guessed or rounded.
     */
    task(fields) {
      const gate = termsGate();
      const text = gate.propose(readTerms(fields, { ...wallet, now: now() }));
      return {
        /** The terms in words: show exactly this to the user, on the wallet's own screen. */
        text,
        /** Call from the wallet's own Confirm button with the text it showed; never from a tool the agent can call. */
        confirm: (shown) => gate.confirm(shown),
        /** The user said no: nothing can be signed until the agent proposes terms again and the user confirms them. */
        decline: () => gate.reject(),
        /** The account to give the agent (x402's client, a viem wallet client): it signs only within the confirmed terms. */
        guard: (account) => guardSigner(account, { gate, wallet, chainId, forms, now }),
      };
    },
  };
}

// A refusal names, for each profile, why it does not read the request. The one to show is the profile that came
// closest: a pin that failed, then a domain that differs, then a contract that is not listed, then another message.
const CLOSEST = ["E_FIXED", "E_DOMAIN", "E_DEPLOYMENT", "E_TYPE_HASH"];
const REASON = /^forms\[\d+\]: (E_[A-Z0-9_]+): ([\s\S]*)$/;
const sentence = (s) => `${s.charAt(0).toUpperCase()}${s.slice(1)}${/[.!?]$/.test(s) ? "" : "."}`;

/**
 * Why the guarded account did not sign, in words for the user and the agent: `{ code, title, why, next }`. Returns
 * null for an error the check did not raise, which the wallet handles as it already does.
 */
export function explain(error) {
  if (error instanceof GuardError && error.code === "E_GUARD_REFUSED") {
    return { code: error.code, title: "Not signed: this request is not what you confirmed.", why: error.reasons.map(sentence), next: "If the user wants this request, they confirm new terms for it on the wallet's screen; otherwise refuse it." };
  }
  if (error instanceof GuardError && error.code === "E_GUARD_UNKNOWN") {
    const next = "Refuse it: a wallet signs only what it can read.";
    const read = error.reasons.map((r) => REASON.exec(r)).filter(Boolean).map(([, code, text]) => ({ code, text }));
    if (read.length === 0) return { code: error.code, title: "Not signed: the profiles that read this request disagree on what it grants.", why: error.reasons.map(sentence), next };
    if (read.every((r) => r.code === "E_DOMAIN" && r.text.startsWith("the domain is for chain"))) {
      return { code: error.code, title: "Not signed: this request is for another chain.", why: [sentence(read[0].text)], next };
    }
    const rank = (r) => (CLOSEST.includes(r.code) ? CLOSEST.indexOf(r.code) : CLOSEST.length);
    const closest = read.reduce((best, r) => (rank(r) < rank(best) ? r : best));
    return { code: error.code, title: "Not signed: this request is not what it claims to be.", why: [sentence(closest.text)], next };
  }
  if (error instanceof TermsError && error.code === "E_TERMS_ORDER") {
    return { code: error.code, title: "Not signed: no confirmed terms cover this request.", why: [sentence(error.message)], next: "Ask the user to confirm terms for it." };
  }
  return null;
}
