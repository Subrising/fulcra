// Match provider diagnostics, never arbitrary assistant prose about a network.
const TRANSIENT =
  /\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)\b|(?:HTTP|status(?: code)?|API Error:)\s*5\d\d\b|\b(?:overloaded_error|server overloaded)\b|(?:can(?:not|[’']t) reach|unable to connect to) (?:the )?API server/i;
const PERMANENT =
  /\b(?:401|403)\b|unauthori[sz]ed|permission|admission.refused|content[_ ](?:filter|policy)|safety|invalid (?:request|api key)|authentication/i;
export function transientNetworkError(text) {
  return (
    typeof text === "string" && text.length <= 4000 && !PERMANENT.test(text) && TRANSIENT.test(text)
  );
}
export function endingNetworkError(text) {
  return typeof text === "string" &&
    /^API Error: [^\n]+$/.test(text.trim()) &&
    transientNetworkError(text)
    ? text.trim()
    : null;
}
export const NETWORK_BACKOFF_MS = [30_000, 120_000, 600_000];
