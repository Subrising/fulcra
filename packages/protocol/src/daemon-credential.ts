// How a client carries the host password when it connects directly, and how the host reads it back.
//
// A password may hold any character: spaces, commas, slashes, quotes, non-ASCII. A WebSocket subprotocol must be an
// HTTP token, and a header value must be visible ASCII, so the raw password is only ever sent where it is valid:
// - Subprotocol: `fulcra.auth.<base64url(utf-8)>`, always valid. The client also offers `fulcra.v1`, which a current
//   host selects, so the handshake never reflects the credential back.
// - Authorization header (Node clients, HTTP): `Bearer <password>` when the password is a plain token, else
//   `Bearer b64u.<base64url(utf-8)>`.
// - For hosts from before this change, the legacy `paseo.bearer.<password>` subprotocol is added only when the
//   password is a valid token (those hosts never accepted any other password on this path anyway).
// Nothing here may be put in an error, a log line or the UI; see redactCredential.

/** Offered alongside the credential so a current host can select a protocol that carries no secret. */
export const DAEMON_PLAIN_PROTOCOL = "fulcra.v1";
export const DAEMON_AUTH_PROTOCOL_PREFIX = "fulcra.auth.";
export const LEGACY_BEARER_PROTOCOL_PREFIX = "paseo.bearer.";
export const ENCODED_BEARER_PREFIX = "b64u.";

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000)
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
  }
  return bytes;
}

/** The password as base64url (no padding) of its UTF-8 bytes: always a valid token. */
export function encodeDaemonPassword(password: string): string {
  const bytes = utf8Bytes(password);
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    if (b !== undefined) out += ALPHABET[(n >> 6) & 63];
    if (c !== undefined) out += ALPHABET[n & 63];
  }
  return out;
}

/** The password back from base64url, or null when the text is not a well-formed encoding of UTF-8. */
export function decodeDaemonPassword(encoded: string): string | null {
  if (!/^[A-Za-z0-9_-]*$/.test(encoded) || encoded.length % 4 === 1) return null;
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const char of encoded) {
    buffer = (buffer << 6) | ALPHABET.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return null;
  }
}

/** The subprotocols a client offers for a direct connection with this password. */
export function daemonAuthProtocols(password: string): string[] {
  const protocols = [
    DAEMON_PLAIN_PROTOCOL,
    DAEMON_AUTH_PROTOCOL_PREFIX + encodeDaemonPassword(password),
  ];
  if (TOKEN.test(LEGACY_BEARER_PROTOCOL_PREFIX + password))
    protocols.push(LEGACY_BEARER_PROTOCOL_PREFIX + password);
  return protocols;
}

/** The Authorization header value for this password; always a valid header value. */
export function daemonAuthorizationHeader(password: string): string {
  const plain = TOKEN.test(password) && !password.startsWith(ENCODED_BEARER_PREFIX);
  return `Bearer ${plain ? password : ENCODED_BEARER_PREFIX + encodeDaemonPassword(password)}`;
}

/** The password carried by one offered subprotocol (new or legacy form), or null when it carries none. */
export function passwordFromProtocol(protocol: string): string | null {
  if (protocol.startsWith(DAEMON_AUTH_PROTOCOL_PREFIX))
    return decodeDaemonPassword(protocol.slice(DAEMON_AUTH_PROTOCOL_PREFIX.length));
  if (
    protocol.startsWith(LEGACY_BEARER_PROTOCOL_PREFIX) &&
    protocol.length > LEGACY_BEARER_PROTOCOL_PREFIX.length
  )
    return protocol.slice(LEGACY_BEARER_PROTOCOL_PREFIX.length);
  return null;
}

/** The password carried by a bearer token (raw, or `b64u.` encoded). */
export function passwordFromBearerToken(token: string): string {
  if (token.startsWith(ENCODED_BEARER_PREFIX)) {
    const decoded = decodeDaemonPassword(token.slice(ENCODED_BEARER_PREFIX.length));
    if (decoded !== null) return decoded;
  }
  return token;
}

/**
 * Text safe to show or log: every form of the password is removed. Use it on anything that might have seen the
 * credential (an exception from constructing the connection names the subprotocol it was given).
 */
export function redactCredential(text: string, password: string | null | undefined): string {
  if (!password) return text;
  let out = text;
  const forms = [
    ...daemonAuthProtocols(password).filter((form) => form !== DAEMON_PLAIN_PROTOCOL),
    daemonAuthorizationHeader(password),
    encodeDaemonPassword(password),
    password,
  ].sort((a, b) => b.length - a.length);
  for (const form of forms) if (form) out = out.split(form).join("[hidden]");
  return out;
}
