import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { writePrivateFileAtomicSync } from "../../server/private-files.js";
import { safeAccountName } from "./account-usage-sanitize.js";
import type { AccountRoster, AccountUsageRow, PooledAccount } from "./account-usage-types.js";

// update-7c: the roster of Fulcra's account pool, read from Fulcra's own store (<home>/accounts/accounts.json, written by
// the Command Centre plugin; the same file, never a shared config key). Claude tokens come from the Keychain item the
// plugin keeps them in; a Codex account is its own CODEX_HOME directory. Read-only. Nothing here logs or returns a
// credential; an unreadable store is an empty roster (live sessions still show their own account).

const KEYCHAIN_SERVICE = "Fulcra account";
const UUID = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const TOKEN = /^[A-Za-z0-9._~+/=-]{20,1024}$/;

export function keychainToken(id: string): Promise<string | null> {
  if (process.platform !== "darwin" || !UUID.test(id)) return Promise.resolve(null);
  const keychain = process.env.FULCRA_ACCOUNTS_KEYCHAIN;
  const fixture = process.env.FULCRA_ACCOUNTS_SECURITY;
  const security = keychain && fixture && path.isAbsolute(fixture) ? fixture : "/usr/bin/security";
  return new Promise((resolve) => {
    execFile(
      security,
      [
        "find-generic-password",
        "-s",
        KEYCHAIN_SERVICE,
        "-a",
        id,
        "-w",
        ...(keychain ? [keychain] : []),
      ],
      { timeout: 15_000, maxBuffer: 65_536, encoding: "utf8" },
      (error, stdout) => {
        const value = error ? "" : stdout.trim();
        resolve(TOKEN.test(value) ? value : null);
      },
    );
  });
}

export interface FulcraPoolRosterOptions {
  /** The trusted Command Centre distribution home that holds accounts/. */
  root: string;
  readToken?: (id: string) => Promise<string | null>;
}

interface StoredAccount {
  id: string;
  provider: "claude" | "codex";
  name: string;
  enabled: boolean;
  limitedUntil: string | null;
}

function readStore(file: string): StoredAccount[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const accounts = (parsed as { accounts?: unknown })?.accounts;
  if (!Array.isArray(accounts)) return [];
  const out: StoredAccount[] = [];
  for (const raw of accounts) {
    const a = raw as Record<string, unknown>;
    if (
      typeof a?.id === "string" &&
      UUID.test(a.id) &&
      (a.provider === "claude" || a.provider === "codex") &&
      typeof a.name === "string" &&
      a.name.length > 0 &&
      typeof a.enabled === "boolean"
    ) {
      out.push({
        id: a.id,
        provider: a.provider,
        name: safeAccountName(a.name),
        enabled: a.enabled,
        limitedUntil: typeof a.limitedUntil === "string" ? a.limitedUntil : null,
      });
    }
  }
  return out;
}

export function createFulcraPoolRoster(options: FulcraPoolRosterOptions): AccountRoster {
  const readToken = options.readToken ?? keychainToken;
  const accountsDir = path.join(options.root, "accounts");
  return {
    async list(): Promise<PooledAccount[]> {
      const list: PooledAccount[] = [];
      for (const stored of readStore(path.join(accountsDir, "accounts.json"))) {
        const held = stored.limitedUntil ? Date.parse(stored.limitedUntil) : NaN;
        const base = {
          id: stored.id,
          provider: stored.provider,
          name: stored.name,
          ...(Number.isFinite(held) ? { poolLimitedUntilMs: held } : {}),
        };
        if (!stored.enabled) {
          list.push({ ...base, credential: { kind: "unavailable" } });
        } else if (stored.provider === "claude") {
          let token: string | null = null;
          try {
            token = await readToken(stored.id);
          } catch {
            /* Keep this account visible without a credential. */
          }
          list.push({
            ...base,
            credential: token ? { kind: "token", token } : { kind: "unavailable" },
          });
        } else {
          const home = path.join(accountsDir, "codex", stored.id);
          list.push({
            ...base,
            credential: existsSync(path.join(home, "auth.json"))
              ? { kind: "codexHome", home }
              : { kind: "unavailable" },
          });
        }
      }
      return list;
    },
  };
}

/**
 * FULCRA: writes each pooled account's weekly use to <home>/accounts/usage.json, so the pool does not start a new session
 * on an account near its weekly limit. Only account IDs, the provider, the percentage and the reset time; nothing else.
 * Written only when a pool exists and only when the figures change.
 */
export function writeUsageSnapshot(root: string, rows: AccountUsageRow[]): boolean {
  const accountsDir = path.join(root, "accounts");
  if (!existsSync(path.join(accountsDir, "accounts.json"))) return false;
  const accounts: Record<
    string,
    { provider: string; weeklyUsedPct: number; weeklyResetsAt: string | null }
  > = {};
  for (const row of rows) {
    if (!row.accountId || !UUID.test(row.accountId) || !row.weekly) continue;
    if (!Number.isFinite(row.weekly.usedPct)) continue;
    accounts[row.accountId] = {
      provider: row.provider,
      weeklyUsedPct: Math.min(100, Math.max(0, row.weekly.usedPct)),
      weeklyResetsAt: row.weekly.resetsAt,
    };
  }
  const file = path.join(accountsDir, "usage.json");
  const body = `${JSON.stringify({ v: 1, accounts })}\n`;
  try {
    if (readFileSync(file, "utf8") === body) return false;
  } catch {
    /* First write. */
  }
  writePrivateFileAtomicSync(file, body);
  return true;
}
