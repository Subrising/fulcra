// Fulcra J4 port to host-mediated credentials (CONTRACTS v1.7 §7.1/§7.2, v1.10 API bases). A connector never sees a
// token, an Authorization header or an account: it is handed one `http` object bound to one account, and calls
//   http.get(path, query?, headers?) → the parsed JSON body
// For a connected account, `http` is the host's `server.credentials.request(accountId, connector, {method: "GET", …})`:
// the host attaches authentication itself and sends the request only to that account's provider API base. The `gh`
// login is the other implementation (github.mjs `createGhHttp`), where the gh CLI reads its own token.
//
// Everything that can go wrong becomes a TrackerFailure from the existing enum; the host's own message text is never
// carried out, and `detail` names the two cases the service and connectors act on.
import { TrackerFailure } from "../trackers/http.mjs";
// The request headers a connector may set (the host refuses any other, including Authorization/Cookie/Host).
export const REQUEST_HEADERS = Object.freeze([
  "Accept",
  "X-GitHub-Api-Version",
  "X-Atlassian-Token",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const failure = (kind, detail, extra = {}) =>
  Object.assign(new TrackerFailure(kind), detail ? { detail } : {}, extra);
// The host's refusals (J5b credential-service / credential-request), by meaning. Messages are matched, never shown.
export function hostRefusal(error) {
  const m = String(error?.message ?? "");
  if (/did not declare/i.test(m)) return failure("error", "needs-host-update");
  // Outside the provider's allowed API paths ("That path is not allowed", "Requests for this account must start with …").
  if (/path is not allowed|must start with/i.test(m))
    return failure("forbidden", "path-not-allowed");
  if (/too many requests/i.test(m)) return failure("rate-limited", null, { retryAfterMs: 60000 });
  if (/couldn't reach|timed? ?out/i.test(m)) return failure("offline");
  if (/too large/i.test(m)) return failure("invalid-response");
  if (/no .*account|reconnect|disconnect|keychain|revoked/i.test(m))
    return failure("auth-required");
  return failure("error");
}
const header = (headers, name) => {
  if (!headers || typeof headers !== "object") return null;
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return String(v);
  return null;
};
// A provider status as a failure, or null for success.
export function statusFailure(status, headers) {
  if (status >= 200 && status < 300) return null;
  if (status === 401) return failure("auth-required");
  if (status === 404) return failure("not-found");
  if (status === 429 || (status === 403 && header(headers, "x-ratelimit-remaining") === "0")) {
    const after = Number(header(headers, "retry-after")),
      reset = Number(header(headers, "x-ratelimit-reset"));
    return failure("rate-limited", null, {
      retryAfterMs:
        Number.isFinite(after) && after > 0
          ? after * 1000
          : Number.isFinite(reset) && reset > 0
            ? Math.max(0, reset * 1000 - Date.now())
            : 60000,
    });
  }
  if (status === 403) return failure("forbidden");
  if (status >= 500) return failure("offline");
  return failure("error");
}
// The account-bound `http`. GET only: trackers are read-only in v1, and the host refuses anything else anyway.
export function accountHttp({ request, accountId, connector }) {
  const unavailable =
    typeof request !== "function"
      ? failure("error", "needs-host-update")
      : !UUID.test(accountId ?? "")
        ? failure("auth-required")
        : null;
  return {
    kind: "account",
    async get(path, query = {}, headers = {}) {
      if (unavailable) throw unavailable;
      if (
        typeof path !== "string" ||
        !path.startsWith("/") ||
        Object.keys(headers).some((h) => !REQUEST_HEADERS.includes(h))
      )
        throw failure("error");
      const input = {
        method: "GET",
        path,
        ...(Object.keys(query).length
          ? {
              query: Object.fromEntries(
                Object.entries(query).map(([k, v]) => [
                  k,
                  Array.isArray(v) ? v.map(String) : String(v),
                ]),
              ),
            }
          : {}),
        ...(Object.keys(headers).length ? { headers } : {}),
      };
      let r;
      try {
        r = await request(accountId, connector, input);
      } catch (error) {
        throw hostRefusal(error);
      }
      if (!r || !Number.isInteger(r.status)) throw failure("invalid-response");
      const bad = statusFailure(r.status, r.headers);
      if (bad) throw bad;
      let body = r.body;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch {
          throw failure("invalid-response");
        }
      }
      if (body === null || typeof body !== "object") throw failure("invalid-response");
      return body;
    },
  };
}
// An `http` that is never usable (no account, no host store): every call reports why.
export const noHttp = (kind = "auth-required", detail = null) => ({
  kind: "none",
  async get() {
    throw failure(kind, detail);
  },
});
