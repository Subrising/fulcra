import { compare, hashSync } from "bcryptjs";
import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
<<<<<<< HEAD
import {
  DAEMON_AUTH_PROTOCOL_PREFIX,
  DAEMON_PLAIN_PROTOCOL,
  LEGACY_BEARER_PROTOCOL_PREFIX,
  passwordFromBearerToken,
  passwordFromProtocol,
} from "@getpaseo/protocol/daemon-credential";
=======
>>>>>>> refs/tags/v0.10.3
import { matchesLocalCredential } from "./local-credential.js";

export const DAEMON_PASSWORD_BCRYPT_COST = 12;

export interface DaemonAuthConfig {
  password?: string;
  localCredential?: () => string | null;
}

export interface BearerAuthRejectContext {
  path: string;
  method: string;
  hasToken: boolean;
}

interface BearerValidationInput {
  password: string | undefined;
  token: string | null;
}

export async function isBearerTokenValidAsync(input: BearerValidationInput): Promise<boolean> {
  if (!input.password) {
    return true;
  }
  if (input.token === null) {
    return false;
  }

  return compare(input.token, input.password);
}

<<<<<<< HEAD
export function isBearerTokenValid(input: BearerValidationInput): boolean {
  return isBearerTokenValidSync(input);
}

export function isBearerTokenValidSync(input: BearerValidationInput): boolean {
  if (!input.password) {
    return true;
  }
  if (input.token === null) {
    return false;
  }

  return compareSync(input.token, input.password);
}

=======
>>>>>>> refs/tags/v0.10.3
export function hashDaemonPassword(password: string): string {
  return hashSync(password, DAEMON_PASSWORD_BCRYPT_COST);
}

export function extractHttpBearerToken(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const [scheme, ...tokenParts] = value.trim().split(/\s+/);
  if (scheme !== "Bearer" || tokenParts.length !== 1) {
    return null;
  }
  // Current clients send `b64u.<base64url>` for any password that is not a plain token.
  return tokenParts[0] ? passwordFromBearerToken(tokenParts[0]) : null;
}

/**
 * The offered subprotocol that carries the password: the encoded `fulcra.auth.` form from current clients first, else
 * the legacy `paseo.bearer.` form from older ones.
 */
export function extractWsBearerProtocol(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const offered = value.split(",").map((protocol) => protocol.trim());
  return (
    offered.find((protocol) => protocol.startsWith(DAEMON_AUTH_PROTOCOL_PREFIX)) ??
    offered.find(
      (protocol) =>
        protocol.startsWith(LEGACY_BEARER_PROTOCOL_PREFIX) &&
        protocol.length > LEGACY_BEARER_PROTOCOL_PREFIX.length,
    ) ??
    null
  );
}

/** The password an offered subprotocol carries (decoded for the current form), or null. */
export function extractWsBearerToken(protocol: string | null): string | null {
  return protocol ? passwordFromProtocol(protocol) : null;
}

/**
 * The subprotocol to answer with. A current client also offers the plain `fulcra.v1`, which carries no secret, so the
 * handshake never echoes the credential; an older client offers only its credential protocol, which is echoed as
 * before (a browser refuses a handshake that answers none of its offers).
 */
export function selectDaemonProtocol(offered: Iterable<string>): string | false {
  const list = [...offered];
  if (!list.some((protocol) => extractWsBearerToken(protocol) !== null)) return false;
  if (list.includes(DAEMON_PLAIN_PROTOCOL)) return DAEMON_PLAIN_PROTOCOL;
  return list.find((protocol) => extractWsBearerToken(protocol) !== null) ?? false;
}

export function createRequireBearerMiddleware(
  auth: DaemonAuthConfig | undefined,
  onReject?: (context: BearerAuthRejectContext) => void,
): RequestHandler {
  const password = auth?.password;
  return (req, res, next) => {
    if (!password || shouldBypassBearerAuth(req.method, req.path)) {
      next();
      return;
    }

    void (async () => {
      try {
        const token = extractHttpBearerToken(req.header("authorization"));
        const localCredential = req.path === "/api/status" ? auth?.localCredential?.() : null;
        const isLocal =
          localCredential !== null &&
          localCredential !== undefined &&
          token !== null &&
          matchesLocalCredential(localCredential, token);
        if (!isLocal && !(await isBearerTokenValidAsync({ password, token }))) {
          onReject?.({
            path: req.path,
            method: req.method,
            hasToken: token !== null,
          });
          res.status(401).json({ error: "Unauthorized" });
          return;
        }

        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

const SELF_AUTHENTICATING_ROUTES = new Set(["/api/files/download", "/mcp/agents"]);

function isBearerFreeRoute(path: string): boolean {
  return path === "/api/health" || SELF_AUTHENTICATING_ROUTES.has(path);
}

export function shouldBypassBearerAuth(method: string, path: string): boolean {
  if (method === "OPTIONS") {
    return true;
  }
  return isBearerFreeRoute(path);
}

/**
 * Authorizes a request to the Agent MCP endpoint (/mcp/agents), which is exempt
 * from the global daemon-password middleware. Accepts either the per-daemon-run
 * capability token the daemon injects into its own agents' configs and MCP
 * client, or a valid daemon-password bearer (so existing password-authenticated
 * callers keep working). When no daemon password is configured the endpoint is
 * open, matching the global middleware's behavior.
 */
export async function isAgentMcpRequestAuthorized(input: {
  password: string | undefined;
  capabilityToken: string | null;
  authorizationHeader: string | undefined;
}): Promise<boolean> {
  const token = extractHttpBearerToken(input.authorizationHeader);
  // Reserved report credentials select only native metadata read/consume, never the agent action endpoint.
  if (token?.startsWith("report1.")) return false;
  if (!input.password) {
    return true;
  }
  if (input.capabilityToken !== null && token !== null) {
    // Constant-time compare; length-guard first because timingSafeEqual throws
    // on differing buffer lengths.
    const provided = Buffer.from(token);
    const expected = Buffer.from(input.capabilityToken);
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
      return true;
    }
  }
  return isBearerTokenValidAsync({ password: input.password, token });
}
