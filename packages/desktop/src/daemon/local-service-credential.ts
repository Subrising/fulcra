import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

// L39: the Mac's own Command Centre window signs in to the service that runs this same home (e.g. a launchd-managed
// daemon) as its local owner, using that home's `controller.secret`.
//
// Same rules as the owned-daemon path (command-centre-headers.ts): this runs in the main process only; the secret is
// injected as the Authorization header of the window's own main-frame WebSocket to loopback; it never crosses IPC or a
// reflected subprotocol, and the renderer never sees it. On top of that, the secret is sent only when:
// - the target is ws:// on loopback and is exactly the endpoint this home's running daemon records (pid alive);
// - this home has a configured daemon password, and `controller.secret` bcrypt-matches it (so it is that daemon's
//   own password, and nothing else is ever sent);
// - `controller.secret` is a regular file (not a link), owned by this user, not readable by group or others, small.
// Anything else is "not this path" (undefined): no remote target, no other home, no other file.

export const CONTROLLER_SECRET_FILE = "controller.secret";
const MAX_SECRET_BYTES = 4096;
const MAX_CACHED_MATCHES = 8;

// bcrypt is deliberately slow and a renderer can ask for connection checks repeatedly. A (hash, candidate) pair
// always verifies the same way, so its result is kept, under a digest of both (never the secret itself). A changed
// file or password makes a new key, so no result can go stale.
const verifiedMatches = new Map<string, boolean>();

async function cachedMatch(
  candidate: string,
  hash: string,
  matches: LocalServiceCredentialDeps["matches"],
): Promise<boolean> {
  const key = createHash("sha256").update(hash).update("\0").update(candidate).digest("hex");
  const known = verifiedMatches.get(key);
  if (known !== undefined) return known;
  const result = await matches(candidate, hash);
  if (verifiedMatches.size >= MAX_CACHED_MATCHES) verifiedMatches.clear();
  verifiedMatches.set(key, result);
  return result;
}

export interface LocalServiceCredentialDeps {
  home: string;
  /** This home's running daemon (null when none): its pid lock, alive. */
  readInstance(home: string): Promise<{ pid: number; listen?: string | null } | null>;
  /** The loopback ws:// URL a running daemon of this home listens on, or null. */
  endpointOf(home: string, instance: { pid: number; listen?: string | null }): string | null;
  /** The configured daemon password hash for this home, if any. */
  configuredPasswordHash(home: string): string | null | undefined;
  /** The host's own check: does this secret match the configured hash? */
  matches(secret: string, hash: string): Promise<boolean>;
  /** This process's user id. */
  uid: number;
  /** Test seam; defaults to the real file system. */
  readSecret?(file: string): Promise<SecretFile | null>;
}

export interface SecretFile {
  isFile: boolean;
  isSymbolicLink: boolean;
  uid: number;
  mode: number;
  size: number;
  read(): Promise<string>;
}

async function readSecretFile(file: string): Promise<SecretFile | null> {
  try {
    const stat = await lstat(file);
    return {
      isFile: stat.isFile(),
      isSymbolicLink: stat.isSymbolicLink(),
      uid: stat.uid,
      mode: stat.mode,
      size: stat.size,
      read: () => readFile(file, "utf8"),
    };
  } catch {
    return null;
  }
}

function isLoopbackWs(url: string): boolean {
  try {
    const target = new URL(url);
    return target.protocol === "ws:" && ["127.0.0.1", "[::1]"].includes(target.hostname);
  } catch {
    return false;
  }
}

/** Whether the secret file is this user's own, private, regular file. */
function isPrivateOwnFile(file: SecretFile | null, uid: number): file is SecretFile {
  return (
    file !== null &&
    file.isFile &&
    !file.isSymbolicLink &&
    file.uid === uid &&
    (file.mode & 0o077) === 0 &&
    file.size > 0 &&
    file.size <= MAX_SECRET_BYTES
  );
}

/**
 * The local owner credential for the window's own WebSocket to this home's running daemon, or undefined when this
 * path does not apply. Never returns anything for a remote target, another home or a secret that isn't this daemon's
 * password.
 */
export async function localServiceOwnerCredential(
  url: string,
  deps: LocalServiceCredentialDeps,
): Promise<string | undefined> {
  if (!isLoopbackWs(url)) return undefined;
  const instance = await deps.readInstance(deps.home);
  if (!instance || deps.endpointOf(deps.home, instance) !== url) return undefined;
  const hash = deps.configuredPasswordHash(deps.home);
  if (!hash) return undefined;
  const file = await (deps.readSecret ?? readSecretFile)(
    path.join(deps.home, CONTROLLER_SECRET_FILE),
  );
  if (!isPrivateOwnFile(file, deps.uid)) return undefined;
  const content = await file.read();
  // The file's exact contents first, then without surrounding whitespace (a trailing newline).
  let secret: string | undefined;
  for (const candidate of Array.from(new Set([content, content.trim()]))) {
    if (candidate && (await cachedMatch(candidate, hash, deps.matches))) {
      secret = candidate;
      break;
    }
  }
  if (!secret) return undefined;
  // Still this home's same daemon after the (asynchronous) checks.
  const after = await deps.readInstance(deps.home);
  if (!after || after.pid !== instance.pid || deps.endpointOf(deps.home, after) !== url)
    return undefined;
  return secret;
}
