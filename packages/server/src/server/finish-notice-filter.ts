// FU-439: a worker's finished turn is sent up only when it carries a result or a question the lead must answer.
// A turn that ends with "started X, will continue" is held. Errors and permission requests never reach this check.
import { parseWorkerResult } from "./ledger-routing/service.js";

const RESULT_START = /^(?:\*\*|__|`)?(?:DONE|BLOCKED|DECISION)\b/;
const CLOSERS = /[\s*_`"')\]]+$/;

/** True when the final message starts with DONE, BLOCKED or DECISION (first line), or ends in that result line. */
function carriesResult(text: string): boolean {
  const first = text.split(/\r?\n/, 1)[0]!.trim();
  return RESULT_START.test(first) || parseWorkerResult(text) !== null;
}

/** True when the last sentence of the final message is a question. */
function asksQuestion(text: string): boolean {
  return text.replace(CLOSERS, "").endsWith("?");
}

/** Whether a finished turn with this final message goes to the lead. An unreadable message (null) is sent. */
export function finishNoticeWanted(lastMessage: string | null | undefined): boolean {
  if (lastMessage === null || lastMessage === undefined) return true;
  const text = lastMessage.trim();
  return text !== "" && (carriesResult(text) || asksQuestion(text));
}
