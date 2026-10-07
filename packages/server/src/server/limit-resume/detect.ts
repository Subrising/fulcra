import { parseLimitReset } from "./parse-reset.js";

// Which stops are usage limits. Two shapes end a turn on a limit:
// - a failed turn whose error text says so (API 429s, Codex), and
// - the Claude CLI's own way: the turn *completes* with one synthetic assistant message that is only its fixed limit
//   line ("You've hit your session limit · resets 12:50am (Australia/Brisbane)").
// The second is matched structurally, on the whole final message, so ordinary prose that mentions a limit never
// counts. The grammar mirrors control/src/control/usage-limits.mjs (the two trees cannot import each other; the
// fixtures in detect.test.ts are copied from its tests).

export interface LimitStop {
  provider: "claude" | "codex" | "other";
  kind?: "network";
  /** Epoch ms of the stated reset, or null when the text did not say. */
  resetAt: number | null;
}

const TRANSIENT_NETWORK =
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b|(?:HTTP|status(?: code)?|API Error:)\s*5\d\d\b|\b(?:overloaded_error|server overloaded)\b|(?:can(?:not|[’']t) reach|unable to connect to) (?:the )?API server/i;
const PERMANENT_NETWORK =
  /\b(?:401|403)\b|unauthori[sz]ed|permission|admission.refused|content[_ ](?:filter|policy)|safety|invalid (?:request|api key)|authentication/i;
export function isTransientNetworkError(text: string): boolean {
  return text.length <= 4000 && !PERMANENT_NETWORK.test(text) && TRANSIENT_NETWORK.test(text);
}
const FAILED_TURN_LIMIT =
  /usage limit|rate.?limit|hit your [^.]{1,30} limit|limit reached|too many requests|\b429\b|quota (?:exceeded|exhausted)/i;

const CLAUDE_LINE =
  /^You(?:'|’)ve hit your [A-Za-z][A-Za-z0-9 -]{0,23} limit · resets (?:[A-Z][a-z]{2} \d{1,2}(?:,| at) )?\d{1,2}(?::\d{2})?(?:am|pm)(?: \([A-Za-z]+(?:\/[A-Za-z0-9_+-]+){0,2}\))?$/;
const CLAUDE_LEGACY = /^Claude AI usage limit reached\|\d{10}$/;
const CODEX_LINE = /^(?:You(?:'|’)ve hit your usage limit|Usage limit reached)[^\n]{0,180}$/;

function providerOf(text: string): LimitStop["provider"] {
  if (/Try again at/.test(text) || CODEX_LINE.test(text)) return "codex";
  if (/hit your .* limit|Claude AI usage limit/.test(text)) return "claude";
  return "other";
}

export function classifyFailedTurn(text: string, now: number): LimitStop | null {
  if (isTransientNetworkError(text)) return { provider: "other", resetAt: null, kind: "network" };
  if (!FAILED_TURN_LIMIT.test(text)) return null;
  return { provider: providerOf(text), resetAt: parseLimitReset({ text, now }) };
}

/** The assistant message that ended a turn, when its whole text is a provider's limit line. */
export function classifyEndingAssistantMessage(
  text: string | null | undefined,
  now: number,
): LimitStop | null {
  const line = text?.trim();
  if (!line || line.length > 200 || line.includes("\n")) return null;
  if (/^API Error: [^\n]+$/.test(line) && isTransientNetworkError(line))
    return { provider: "claude", resetAt: null, kind: "network" };
  if (!CLAUDE_LINE.test(line) && !CLAUDE_LEGACY.test(line) && !CODEX_LINE.test(line)) return null;
  return { provider: providerOf(line), resetAt: parseLimitReset({ text: line, now }) };
}
