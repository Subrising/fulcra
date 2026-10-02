// J3: the only outbound HTTP path a tracker connector has. GET only, no redirects, bounded body and time,
// and every failure reduced to a fixed enum: no status text, body, header or credential is ever carried
// out of here in an error. The fetch function is a port so tests use recorded fixtures, never the network.
export const FAILURES = Object.freeze([
  "auth-required",
  "forbidden",
  "not-found",
  "rate-limited",
  "offline",
  "invalid-response",
  "error",
]);
export const MAX_BODY = 1048576,
  TIMEOUT_MS = 15000;
export class TrackerFailure extends Error {
  // retryAfterMs is RELATIVE: the service applies it with its own clock, so backoff never mixes clocks.
  constructor(failure, retryAfterMs = null) {
    super(FAILURES.includes(failure) ? failure : "error");
    this.name = "TrackerFailure";
    this.failure = FAILURES.includes(failure) ? failure : "error";
    this.retryAfterMs = retryAfterMs;
  }
}
const ALLOWED_HOST = (host) =>
  host === "api.github.com" ||
  host === "api.bitbucket.org" ||
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/.test(host);
// x-ratelimit-reset is an absolute wall-clock epoch, so it is converted against the wall clock here.
function retryAfterFrom(headers, wallNow) {
  const after = Number(headers.get("retry-after"));
  if (Number.isFinite(after) && after > 0) return Math.min(after * 1000, 3600000);
  const reset = Number(headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0)
    return Math.max(1000, Math.min(reset * 1000 - wallNow, 3600000));
  return 60000;
}
async function readBounded(response) {
  if (!response.body) throw new TrackerFailure("invalid-response");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_BODY) throw new TrackerFailure("invalid-response");
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new TrackerFailure("invalid-response");
  }
}
// Returns { status: 200, json, etag } or { status: 304 }. Throws TrackerFailure for everything else.
export async function getJson({ fetcher, url, headers, etag = null, now = Date.now() }) {
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    !ALLOWED_HOST(target.hostname) ||
    target.username ||
    target.password
  )
    throw new TrackerFailure("error");
  const sent = { ...headers, ...(etag ? { "If-None-Match": etag } : {}) };
  let response;
  try {
    response = await fetcher(target.href, {
      method: "GET",
      headers: sent,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new TrackerFailure("offline");
  }
  const status = response.status;
  if (status === 304) return { status: 304 };
  if (status === 401) throw new TrackerFailure("auth-required");
  if (
    status === 429 ||
    (status === 403 &&
      (response.headers.get("x-ratelimit-remaining") === "0" ||
        response.headers.get("retry-after")))
  )
    throw new TrackerFailure("rate-limited", retryAfterFrom(response.headers, now));
  if (status === 403) throw new TrackerFailure("forbidden");
  if (status === 404 || status === 410) throw new TrackerFailure("not-found");
  if (status >= 300 && status < 400) throw new TrackerFailure("invalid-response");
  if (status < 200 || status >= 300) throw new TrackerFailure("error");
  return { status: 200, json: await readBounded(response), etag: response.headers.get("etag") };
}
