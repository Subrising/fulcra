import { z } from "zod";
import type { ProviderDefinition } from "./providers.js";

// Host-mediated provider requests for plugins (CONTRACTS §7.2 v1.7). A plugin names an account, a
// method and a path; the host attaches the account's credential and sends the request only to that
// account's provider API base. The plugin never sees the credential: it is not in the request the
// plugin builds, it cannot be redirected to another origin, and it is scrubbed from the response.

const JsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const QueryValueSchema = z.union([z.string().max(2048), z.number(), z.boolean()]);

export const CredentialRequestSchema = z
  .object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    path: z.string().min(1).max(2048),
    query: z
      .record(
        z.string().min(1).max(128),
        z.union([QueryValueSchema, z.array(QueryValueSchema).max(50)]),
      )
      .optional(),
    headers: z.record(z.string().min(1).max(64), z.string().max(1024)).optional(),
    body: JsonValueSchema.optional(),
  })
  .strict();

export type CredentialRequest = z.infer<typeof CredentialRequestSchema>;

export interface CredentialResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

// Every error that reaches the plugin is one of these: written by the host, never derived from the
// provider's answer, and bounded.
export class CredentialRequestError extends Error {
  constructor(message: string) {
    super(message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message);
    this.name = "CredentialRequestError";
  }
}

const MAX_ERROR_LENGTH = 300;

// Plugins may set only these request headers. Authentication, cookies, host and proxy headers are
// always the host's; asking for one is refused rather than silently dropped.
const ALLOWED_REQUEST_HEADERS = new Set([
  "accept",
  "content-type",
  "if-none-match",
  "if-modified-since",
  "x-github-api-version",
  "x-atlassian-token",
]);

const RETURNED_RESPONSE_HEADERS = [
  "content-type",
  "etag",
  "last-modified",
  "link",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-ratelimit-used",
];

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const REQUEST_TIMEOUT_MS = 30_000;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function hasUnsafeCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

// A path is a plain absolute path under one of the provider's prefixes: no traversal, no encoded
// separators, no query or fragment (query goes in `query`), no backslashes or whitespace.
function assertSafePath(path: string, prefixes: readonly string[]): void {
  const lower = path.toLowerCase();
  if (
    !path.startsWith("/") ||
    path.includes("//") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    path.includes("@") ||
    hasUnsafeCharacter(path) ||
    lower.includes("%2e") ||
    lower.includes("%2f") ||
    lower.includes("%5c") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new CredentialRequestError("That path is not allowed");
  }
  if (!prefixes.some((prefix) => path.startsWith(prefix))) {
    throw new CredentialRequestError(
      `Requests for this account must start with ${prefixes.join(" or ")}`,
    );
  }
}

function withinApi(url: URL, base: URL, prefixes: readonly string[]): boolean {
  if (url.origin !== base.origin || url.username || url.password) return false;
  const basePath = base.pathname.replace(/\/$/, "");
  if (!url.pathname.startsWith(`${basePath}/`)) return false;
  const relative = url.pathname.slice(basePath.length);
  return prefixes.some((prefix) => relative.startsWith(prefix));
}

function requestHeaders(input: CredentialRequest): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json", "User-Agent": "Fulcra" };
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    const lower = name.toLowerCase();
    if (!ALLOWED_REQUEST_HEADERS.has(lower)) {
      throw new CredentialRequestError(`The ${name} header is set by the host, not by plugins`);
    }
    if (/[\r\n]/.test(value)) throw new CredentialRequestError(`The ${name} header is not valid`);
    headers[lower] = value;
  }
  return headers;
}

function requestBody(input: CredentialRequest): string | undefined {
  if (input.body === undefined) return undefined;
  if (input.method === "GET" || input.method === "DELETE") {
    throw new CredentialRequestError(`${input.method} requests do not take a body`);
  }
  const body = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    throw new CredentialRequestError("The request body is too large");
  }
  return body;
}

// Every form in which the account's secret could come back: the token itself, the header value,
// the Basic credential and their URL and JSON escapes.
export function secretForms(secrets: readonly string[]): string[] {
  const forms = new Set<string>();
  for (const secret of secrets) {
    if (secret.length < 4) continue;
    forms.add(secret);
    forms.add(encodeURIComponent(secret));
    forms.add(JSON.stringify(secret).slice(1, -1));
  }
  // Longest first, so a header value is replaced whole before the token inside it.
  return [...forms].sort((left, right) => right.length - left.length);
}

export function scrub(text: string, forms: readonly string[]): string {
  return forms.reduce((current, form) => current.split(form).join("[redacted]"), text);
}

function containsSecret(text: string, forms: readonly string[]): boolean {
  return forms.some((form) => text.includes(form));
}

// JSON-style escapes a reader could decode themselves: \uXXXX (including surrogate pairs) and \/.
function decodeEscapes(text: string): string {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\\//g, "/");
}

// Raw text (non-JSON answers and header values). If decoding its escapes would reveal a secret,
// the decoded text is scrubbed and returned instead, so the plugin cannot recover it by decoding.
export function scrubText(text: string, forms: readonly string[]): string {
  const decoded = decodeEscapes(text);
  return decoded !== text && containsSecret(decoded, forms)
    ? scrub(decoded, forms)
    : scrub(text, forms);
}

// A parsed JSON value with every decoded string, and every object key, scrubbed. Objects are rebuilt
// with own properties only, so a "__proto__" key stays an ordinary key.
export function scrubJson(value: unknown, forms: readonly string[]): unknown {
  if (typeof value === "string") return scrub(value, forms);
  if (Array.isArray(value)) return value.map((item) => scrubJson(item, forms));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        scrub(key, forms),
        scrubJson(item, forms),
      ]),
    );
  }
  return value;
}

async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new CredentialRequestError("The provider's answer was too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function allowedPrefixes(provider: ProviderDefinition): readonly string[] {
  return [...provider.api.pathPrefixes, ...(provider.api.readOnlyPathPrefixes ?? [])];
}

function isReadOnlyTarget(url: URL, base: URL, provider: ProviderDefinition): boolean {
  const relative = url.pathname.slice(base.pathname.replace(/\/$/, "").length);
  return (provider.api.readOnlyPathPrefixes ?? []).some((prefix) => relative.startsWith(prefix));
}

function buildUrl(base: URL, provider: ProviderDefinition, request: CredentialRequest): URL {
  assertSafePath(request.path, allowedPrefixes(provider));
  const readOnly = (provider.api.readOnlyPathPrefixes ?? []).some((prefix) =>
    request.path.startsWith(prefix),
  );
  if (readOnly && request.method !== "GET") {
    throw new CredentialRequestError(
      `${request.path.split("/").slice(0, 3).join("/")}/ is read-only`,
    );
  }
  const url = new URL(`${base.pathname.replace(/\/$/, "")}${request.path}`, base.origin);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    for (const item of Array.isArray(value) ? value : [value]) {
      url.searchParams.append(key, String(item));
    }
  }
  if (!withinApi(url, base, allowedPrefixes(provider))) {
    throw new CredentialRequestError("That path is not allowed");
  }
  return url;
}

// The next URL of a redirect, or an error. The credential only ever goes to this account's API:
// no other origin, no other path.
function redirectTarget(input: {
  response: Response;
  from: URL;
  base: URL;
  provider: ProviderDefinition;
  hop: number;
}): URL {
  const { provider } = input;
  const location = input.response.headers.get("location");
  if (!location || input.hop >= MAX_REDIRECTS) {
    throw new CredentialRequestError(`${provider.label} redirected too many times`);
  }
  let next: URL;
  try {
    next = new URL(location, input.from);
  } catch {
    throw new CredentialRequestError(`${provider.label} sent an invalid redirect`);
  }
  if (!withinApi(next, input.base, allowedPrefixes(provider))) {
    throw new CredentialRequestError(
      `${provider.label} redirected to another site; the request was stopped`,
    );
  }
  return next;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

async function scrubbedAnswer(
  response: Response,
  secrets: readonly string[],
): Promise<CredentialResponse> {
  const forms = secretForms(secrets);
  const raw = await readLimited(response);
  const returned: Record<string, string> = {};
  for (const name of RETURNED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) returned[name] = scrubText(value, forms);
  }
  // JSON is parsed here, in the host, and scrubbed after decoding: a token written with \u escapes
  // is caught in values and keys at any depth.
  const parsed = raw ? parseJson(raw) : { ok: false as const };
  if (parsed.ok && (returned["content-type"] ?? "").includes("json")) {
    return { status: response.status, headers: returned, body: scrubJson(parsed.value, forms) };
  }
  // Not labelled JSON but parseable as JSON with a hidden secret: return the scrubbed JSON text.
  if (parsed.ok && containsSecret(JSON.stringify(parsed.value), forms)) {
    return {
      status: response.status,
      headers: returned,
      body: JSON.stringify(scrubJson(parsed.value, forms)),
    };
  }
  return { status: response.status, headers: returned, body: scrubText(raw, forms) };
}

interface SendInput {
  provider: ProviderDefinition;
  site: string | null;
  authorization: string;
  secrets: readonly string[];
  request: CredentialRequest;
  fetch: typeof fetch;
}

// The whole operation, reading and scrubbing the answer included, fails only with a host-written
// CredentialRequestError. Anything else (a broken body stream, a parser fault) becomes a fixed
// message, so no provider text or secret travels in an error.
export async function sendCredentialRequest(input: SendInput): Promise<CredentialResponse> {
  try {
    return await sendUnguarded(input);
  } catch (error) {
    if (error instanceof CredentialRequestError) throw error;
    throw new CredentialRequestError(`The request to ${input.provider.label} failed`);
  }
}

async function sendUnguarded(input: SendInput): Promise<CredentialResponse> {
  const { provider, request } = input;
  const base = new URL(provider.api.base(input.site));
  let url = buildUrl(base, provider, request);
  const headers = requestHeaders(request);
  let method: string = request.method;
  let body = requestBody(request);
  if (body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";

  for (let hop = 0; ; hop += 1) {
    let response: Response;
    try {
      response = await input.fetch(url, {
        method,
        headers: { ...headers, Authorization: input.authorization },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new CredentialRequestError(`Couldn't reach ${provider.label}`);
    }
    if (!REDIRECT_STATUSES.has(response.status)) return scrubbedAnswer(response, input.secrets);
    await response.body?.cancel().catch(() => undefined);
    url = redirectTarget({ response, from: url, base, provider, hop });
    if (response.status === 303) {
      method = "GET";
      body = undefined;
    }
    if (method !== "GET" && isReadOnlyTarget(url, base, provider)) {
      throw new CredentialRequestError(`${provider.label} redirected a write to a read-only path`);
    }
  }
}
