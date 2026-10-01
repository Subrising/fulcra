import { findExecutable } from "../../executable-resolution/executable-resolution.js";
import { execCommand } from "../../utils/spawn.js";

// Who this Mac is signed in to GitHub as, read from the host's own `gh` login (U7 W4). Only the
// login, numeric id and site are ever read: `--jq` filters inside gh, so no token reaches this
// process, and gh is never asked to show one. Nothing here is stored; callers keep it in memory.

export interface HostGithubIdentity {
  // null is github.com; otherwise the GitHub Enterprise host, lower-case.
  site: string | null;
  login: string;
  id: number;
}

export type HostGithubSignInState =
  | { status: "signed-in"; identities: HostGithubIdentity[] }
  | { status: "no-cli" }
  | { status: "signed-out" };

export interface HostGithubSignIn {
  read(): Promise<HostGithubSignInState>;
}

export type GhRunner = (ghPath: string, args: string[]) => Promise<string>;

const DEFAULT_TTL_MS = 5 * 60_000;
const GH_TIMEOUT_MS = 10_000;
const MAX_HOSTS = 8;
const HOSTNAME =
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*$/i;
// GitHub Enterprise's SAML-provisioned logins add an underscore suffix (`jdoe_corp`).
const LOGIN = /^[a-z0-9][a-z0-9_-]{0,38}$/i;
const ACTIVE_HOSTS = [
  "auth",
  "status",
  "--json",
  "hosts",
  "--jq",
  '[.hosts[][] | select(.active and .state == "success") | .host]',
];
function userArgs(host: string): string[] {
  return ["api", "user", "--hostname", host, "--jq", "{login: .login, id: .id}"];
}

async function runGh(ghPath: string, args: string[]): Promise<string> {
  const result = await execCommand(ghPath, args, {
    envOverlay: { GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
    timeout: GH_TIMEOUT_MS,
  });
  return result.stdout;
}

export function createHostGithubSignIn(
  options: {
    resolveGhPath?: () => Promise<string | null>;
    run?: GhRunner;
    now?: () => number;
    ttlMs?: number;
    // Called when the answer changes; it gets the status and a count, never a login or a token.
    log?: (message: string, fields: Record<string, unknown>) => void;
  } = {},
): HostGithubSignIn {
  const resolveGhPath = options.resolveGhPath ?? (() => findExecutable("gh"));
  const run = options.run ?? runGh;
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  let cached: { value: HostGithubSignInState; at: number } | null = null;
  let inFlight: Promise<HostGithubSignInState> | null = null;
  let lastLogged: string | null = null;

  async function identityOf(ghPath: string, host: string): Promise<HostGithubIdentity | null> {
    try {
      const parsed = JSON.parse(await run(ghPath, userArgs(host))) as unknown;
      if (!parsed || typeof parsed !== "object") return null;
      const { login, id } = parsed as { login?: unknown; id?: unknown };
      if (typeof login !== "string" || !LOGIN.test(login)) return null;
      if (typeof id !== "number" || !Number.isSafeInteger(id)) return null;
      const lower = host.toLowerCase();
      return { site: lower === "github.com" ? null : lower, login, id };
    } catch {
      return null;
    }
  }

  async function activeHosts(ghPath: string): Promise<string[]> {
    try {
      const parsed = JSON.parse(await run(ghPath, ACTIVE_HOSTS)) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((host): host is string => typeof host === "string" && HOSTNAME.test(host))
        .slice(0, MAX_HOSTS);
    } catch {
      // A gh without `auth status --json` still answers for github.com.
      return ["github.com"];
    }
  }

  async function detect(): Promise<HostGithubSignInState> {
    let ghPath: string | null;
    try {
      ghPath = await resolveGhPath();
    } catch {
      ghPath = null;
    }
    if (!ghPath) return { status: "no-cli" };
    const hosts = await activeHosts(ghPath);
    const identities: HostGithubIdentity[] = [];
    for (const host of hosts) {
      const identity = await identityOf(ghPath, host);
      if (identity && !identities.some((known) => known.site === identity.site)) {
        identities.push(identity);
      }
    }
    return identities.length ? { status: "signed-in", identities } : { status: "signed-out" };
  }

  function remember(value: HostGithubSignInState): HostGithubSignInState {
    cached = { value, at: now() };
    const summary = `${value.status}:${value.status === "signed-in" ? value.identities.length : 0}`;
    if (summary !== lastLogged) {
      lastLogged = summary;
      options.log?.("GitHub sign-in on this Mac", {
        status: value.status,
        accounts: value.status === "signed-in" ? value.identities.length : 0,
      });
    }
    return value;
  }

  return {
    read() {
      if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
      inFlight ??= detect()
        .catch((): HostGithubSignInState => ({ status: "signed-out" }))
        .then(remember)
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
