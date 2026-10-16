import { processIdentity, stopRecordedTree } from "./api-process-tree.mjs";
// Update-7: the account pool. Fulcra owns a list of subscription accounts per provider (Claude, Codex); every session
// launch takes one by policy, and a session stopped by a usage limit continues on the next available account.
//
// Store: <Command Centre home>/accounts/accounts.json (dir 0700, file 0600), its own file -- never the shared config
// (L44: older tool servers reject unknown config keys). It holds names, order, status and which session uses which
// account; NEVER a credential.
// Credentials:
//   Claude -- the long-lived subscription token `claude setup-token` prints, in a Fulcra-owned Keychain item (service
//             "Fulcra account", account <id>) the app creates when the account is added. Read at launch only; given to
//             the CLI as CLAUDE_CODE_OAUTH_TOKEN, which the installed CLI (2.1.280) prefers over the saved login and
//             keeps on a 401 (it never falls back to the machine's own login).
//   Codex  -- the account's own CODEX_HOME (<home>/accounts/codex/<id>, 0700) holding its auth.json (codex refreshes
//             it; config.toml pins cli_auth_credentials_store="file"). Everything else in that home links to ONE
//             shared base (sessions, archived_sessions, session_index.jsonl, history.jsonl; CODEX_SQLITE_HOME=base), so
//             a thread started on one account resumes on another with its history (resume looks up the rollout and
//             the state db in the home it runs in).
// Nothing here is logged, returned to a client, or placed in argv.
import { apiKeyHelperCommand } from "./api-key-helper.mjs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { powershellExe } from "./owned.mjs";

export const PROVIDERS = Object.freeze(["claude", "codex"]);
export const POLICIES = Object.freeze(["priority", "spread"]);
export const KEYCHAIN_SERVICE = "Fulcra account";
const MAX_ACCOUNTS = 32,
  MAX_ASSIGNMENTS = 2000,
  MAX_ROTATIONS = 200,
  LOCK_STALE_MS = 10000;
// A limit with no readable reset keeps the account out of rotation for this long, then it is tried again.
export const DEFAULT_LIMIT_MS = 5 * 3600000;
const uuid = (v) => typeof v === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const iso = (t) => new Date(t).toISOString();

export function accountsDir(root) {
  return path.join(root, "accounts");
}
function file(root) {
  return path.join(accountsDir(root), "accounts.json");
}
// `defaults`: the account a NEW session of each provider takes while it is ready (null: the policy decides).
const empty = () => ({
  v: 1,
  policy: "priority",
  accounts: [],
  assignments: {},
  rotations: [],
  defaults: { claude: null, codex: null },
  // The owner's choice: a session waits for its own account's reset unless he turns moving on (it spends another account).
  rotateOnLimit: false,
});

// ---- store
function parseAccounts(raw) {
  const s = JSON.parse(raw);
  if (s?.v !== 1 || !Array.isArray(s.accounts)) throw Error("Unreadable account store");
  return {
    ...empty(),
    ...s,
    policy: POLICIES.includes(s.policy) ? s.policy : "priority",
    assignments: s.assignments ?? {},
    rotations: Array.isArray(s.rotations) ? s.rotations : [],
    rotateOnLimit: s.rotateOnLimit === true,
    defaults: Object.fromEntries(
      PROVIDERS.map((p) => [p, typeof s.defaults?.[p] === "string" ? s.defaults[p] : null]),
    ),
  };
}
// Remote observations stay in a separate daemon-owned file. Pool writes never turn them into local observations.
function optionalJson(raw) {
  return raw === null ? null : JSON.parse(raw);
}
function attachLimitObservations(s, remoteRaw, usageRaw) {
  const remote = optionalJson(remoteRaw);
  let usage = null;
  try {
    usage = optionalJson(usageRaw);
  } catch {
    /* Usage is advisory; keep local and remote holds. */
  }
  if (
    remote &&
    (remote.v !== 1 || !Array.isArray(remote.observations) || remote.observations.length > 2048)
  )
    throw Error("Unreadable remote account limits");
  const valid = (x) =>
    uuid(x?.accountId) &&
    ["session", "weekly"].includes(x.limitKind) &&
    typeof x.source === "string" &&
    /^[a-zA-Z0-9_-]{1,128}$/.test(x.source) &&
    Number.isFinite(Date.parse(x.resetAt)) &&
    Number.isFinite(Date.parse(x.observedAt));
  if (remote?.observations.some((x) => !valid(x))) throw Error("Unreadable remote account limits");
  for (const a of s.accounts) {
    a.remoteLimits = (remote?.observations ?? []).filter((x) => x.accountId === a.id);
    const report = Array.isArray(usage?.reports)
      ? usage.reports.find((x) => x?.accountId === a.id && x.provider === a.provider)
      : null;
    a.usageObservedAt =
      report?.status !== "unavailable" && (report?.fiveHour || report?.weekly)
        ? report.observedAt
        : null;
  }
  return s;
}
function optionalFile(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function optionalFileAsync(file) {
  try {
    return await fsp.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
// FU-77: the daemon puts a meter on globalThis; without it the call just runs.
const timed = (site, call) => {
  const meter = globalThis[Symbol.for("fulcra.syncIoMeter")];
  return meter ? meter.timed(site, call) : call();
};
export function readAccounts(root) {
  let raw;
  try {
    raw = timed("accounts.read", () => fs.readFileSync(file(root), "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return empty();
    throw e;
  }
  return attachLimitObservations(
    parseAccounts(raw),
    optionalFile(path.join(accountsDir(root), "remote-limits.json")),
    optionalFile(path.join(accountsDir(root), "usage-reports.json")),
  );
}
// The same read without blocking the daemon's main thread on the disk (FU-77). Use this one in async code.
export async function readAccountsAsync(root) {
  let raw;
  try {
    raw = await fsp.readFile(file(root), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return empty();
    throw e;
  }
  const [remote, usage] = await Promise.all([
    optionalFileAsync(path.join(accountsDir(root), "remote-limits.json")),
    optionalFileAsync(path.join(accountsDir(root), "usage-reports.json")),
  ]);
  return attachLimitObservations(parseAccounts(raw), remote, usage);
}
async function writeAccounts(root, s) {
  const dir = accountsDir(root);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const ids = Object.keys(s.assignments);
  if (ids.length > MAX_ASSIGNMENTS)
    for (const id of ids
      .sort((a, b) => String(s.assignments[a].at).localeCompare(String(s.assignments[b].at)))
      .slice(0, ids.length - MAX_ASSIGNMENTS))
      delete s.assignments[id];
  s.rotations = s.rotations.slice(-MAX_ROTATIONS);
  const tmp = path.join(dir, `.accounts-${randomUUID()}.json`);
  const stored = {
    ...s,
    accounts: s.accounts.map(
      ({ remoteLimits: _remoteLimits, usageObservedAt: _usageObservedAt, ...a }) => a,
    ),
  };
  await fsp.writeFile(tmp, JSON.stringify(stored, null, 1) + "\n", { mode: 0o600, flag: "wx" });
  await fsp.rename(tmp, file(root));
}
// One writer at a time across the plugin host and the controller (separate processes): an exclusive lock file; a lock
// older than LOCK_STALE_MS is taken over (a crashed writer), since every write is a single rename.
// The lock alone is withStoreLock, so the other Fulcra-owned files in this directory (role defaults) take the same one.
export async function update(root, fn) {
  return withStoreLock(root, async () => {
    const s = await readAccountsAsync(root);
    const before = JSON.stringify(s);
    const out = await fn(s);
    if (JSON.stringify(s) !== before) await writeAccounts(root, s);
    return out;
  });
}
export async function withStoreLock(root, fn) {
  const dir = accountsDir(root);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, ".lock");
  for (let i = 0; ; i++) {
    try {
      await fsp.writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - (await fsp.stat(lock)).mtimeMs > LOCK_STALE_MS) {
          await fsp.rm(lock, { force: true });
          continue;
        }
      } catch {}
      if (i > 200) throw Error("The account store is busy");
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try {
    return await fn();
  } finally {
    await fsp.rm(lock, { force: true });
  }
}

// ---- status and choice (pure)
export function isApiAccount(a) {
  return (
    a?.provider === "claude" &&
    (a.credentialKind === "api-key" ||
      (a.credentialKind == null &&
        ["personal-workspace-api", "work-workspace-api"].includes(a.name)))
  );
}
export function credentialKind(token) {
  return /^sk-ant-api/i.test(String(token)) ? "api-key" : "subscription";
}
export function accountBudget(a) {
  if (!isApiAccount(a)) return null;
  return (
    a.budget ?? {
      limitUsd:
        a.name === "personal-workspace-api" ? 200 : a.name === "work-workspace-api" ? 500 : null,
      startAt: a.createdAt,
    }
  );
}
export function accountLimit(a, now = Date.now()) {
  if (isApiAccount(a)) return null;
  const localTime = Math.max(
    Date.parse(a.limitObservedAt ?? "") || 0,
    Date.parse(a.usageObservedAt ?? "") || 0,
  );
  const remote = (a.remoteLimits ?? [])
    .filter((x) => Date.parse(x.resetAt) > now && Date.parse(x.observedAt) > localTime)
    .sort((x, y) => Date.parse(y.resetAt) - Date.parse(x.resetAt))[0];
  if (
    a.limitedUntil &&
    Date.parse(a.limitedUntil) > now &&
    (!remote || Date.parse(a.limitedUntil) >= Date.parse(remote.resetAt))
  )
    return { until: a.limitedUntil, kind: a.limitKind ?? null, source: "local" };
  if (remote) return { until: remote.resetAt, kind: remote.limitKind, source: remote.source };
  return null;
}
export function accountStatus(a, now = Date.now()) {
  if (a.localRevoked) return { state: "revoked", reason: "Revoked by the owner" };
  if (!a.enabled) return { state: "disabled" };
  // FU-112: the account's token was revoked or is invalid. Down until the owner signs it in again; no reset time.
  if (a.revoked) return { state: "revoked", reason: String(a.revoked.reason ?? "").slice(0, 200) };
  if (a.auth === "expired") return { state: "auth-expired" };
  if (a.auth === "signing-in") return { state: "signing-in" };
  const limit = accountLimit(a, now);
  if (limit) return { state: "limited", until: limit.until, source: limit.source };
  return { state: "ok" };
}
export function activeCount(s, accountId) {
  return Object.values(s.assignments).filter((x) => x.accountId === accountId && !x.ended).length;
}
// Weekly use at or above this keeps a NEW session off an account while another account is below it (the owner's rule,
// 9 Oct 2026: do not start new work on an account above about 90% of its weekly limit).
export const WEEKLY_LAUNCH_CAP_PCT = 90;
// Each account's weekly use in percent, from <root>/accounts/usage.json (the daemon writes it from its usage readings).
// A figure past its reset is dropped: that window has started over. Unreadable or absent: {} (no account is held back).
function parseUsage(text, now) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  const out = {};
  for (const [id, x] of Object.entries(raw?.accounts ?? {})) {
    if (typeof x?.weeklyUsedPct !== "number" || !Number.isFinite(x.weeklyUsedPct)) continue;
    const reset = typeof x.weeklyResetsAt === "string" ? Date.parse(x.weeklyResetsAt) : NaN;
    if (Number.isFinite(reset) && reset <= now) continue;
    out[id] = x.weeklyUsedPct;
  }
  return out;
}
export function readUsage(root, now = Date.now()) {
  try {
    return parseUsage(
      timed("accounts.usage", () =>
        fs.readFileSync(path.join(accountsDir(root), "usage.json"), "utf8"),
      ),
      now,
    );
  } catch {
    return {};
  }
}
export async function readUsageAsync(root, now = Date.now()) {
  try {
    return parseUsage(await fsp.readFile(path.join(accountsDir(root), "usage.json"), "utf8"), now);
  } catch {
    return {};
  }
}
// The account a NEW launch should use: available ones only -- the provider's default account while it is ready, else by
// the pool's policy. `except` excludes accounts (the one that just hit its limit). `usage` (weekly percent by account)
// holds back accounts at or above WEEKLY_LAUNCH_CAP_PCT while another is below it; when all are, the one with the most
// left is used. Returns null when none is available.
export function choose(s, provider, now = Date.now(), except = [], usage = {}) {
  const budgetHeld = (a) => {
    const budget = accountBudget(a);
    return budget && s.budgetActions?.[`${a.id}:${budget.startAt}`]?.targetId;
  };
  const ready = s.accounts.filter(
    (a) =>
      a.provider === provider &&
      !except.includes(a.id) &&
      accountStatus(a, now).state === "ok" &&
      !budgetHeld(a),
  );
  if (!ready.length) return null;
  const used = (a) => (isApiAccount(a) ? 0 : (usage[a.id] ?? 0));
  const room = ready.filter((a) => used(a) < WEEKLY_LAUNCH_CAP_PCT);
  const ok = room.length ? room : [...ready].sort((x, y) => used(x) - used(y)).slice(0, 1);
  const preferred = ok.find((a) => a.id === s.defaults?.[provider]);
  if (preferred) return preferred;
  const key = (a) =>
    s.policy === "spread"
      ? [activeCount(s, a.id), a.priority, a.createdAt]
      : [a.priority, activeCount(s, a.id), a.createdAt];
  return ok.sort((x, y) => {
    const a = key(x),
      b = key(y);
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
  })[0];
}
// When every account of a provider is limited: the earliest reset (null if none is only limited).
export function earliestReset(s, provider, now = Date.now()) {
  const until = s.accounts
    .filter((a) => a.provider === provider && accountStatus(a, now).state === "limited")
    .map((a) => accountStatus(a, now).until)
    .sort();
  return until[0] ?? null;
}
export function poolFor(s, provider) {
  return s.accounts.some((a) => a.provider === provider && a.enabled);
}

// ---- operations
// A name is shown on every device and in the owner's audit: one that looks like a credential is refused, so a token
// pasted into the name field never becomes a label (the same shapes the host's audit refuses).
const SECRET_SHAPED =
  /sk-ant-|\bsk-[A-Za-z0-9_-]{16,}|\bgh[opsu]_|github_pat_|\bxox[abp]-|\beyJ[A-Za-z0-9_-]{8,}\.|auth\.json|access_token|refresh_token|[A-Za-z0-9+/_-]{40,}/i;
const NAME_LOOKS_SECRET = "That looks like a token, not a name. Name the account, for example Work";
export async function addAccount(root, { provider, name, priority }, now = Date.now()) {
  if (!PROVIDERS.includes(provider)) throw Error("Unknown provider");
  const label = String(name ?? "")
    .trim()
    .slice(0, 60);
  if (!label) throw Error("Name the account");
  if (SECRET_SHAPED.test(String(name ?? ""))) throw Error(NAME_LOOKS_SECRET);
  return update(root, (s) => {
    if (s.accounts.length >= MAX_ACCOUNTS) throw Error("Account limit reached");
    if (
      s.accounts.some(
        (a) => a.provider === provider && a.name.toLowerCase() === label.toLowerCase(),
      )
    )
      throw Error("An account with that name exists");
    const a = {
      id: randomUUID(),
      provider,
      name: label,
      enabled: true,
      priority: Number.isSafeInteger(priority)
        ? priority
        : s.accounts.filter((x) => x.provider === provider).length + 1,
      auth: provider === "codex" ? "signing-in" : "ok",
      limitedUntil: null,
      limitKind: null,
      limitNote: null,
      createdAt: iso(now),
      lastUsedAt: null,
    };
    s.accounts.push(a);
    return a;
  });
}
export async function setAccount(root, id, patch, expectedEpoch) {
  return update(root, (s) => {
    const a = s.accounts.find((x) => x.id === id);
    if (!a) throw Error("No such account");
    if (expectedEpoch !== undefined && (a.keyEpoch ?? null) !== expectedEpoch)
      throw Error("The credential changed during replacement; the account stays blocked");
    if (patch.name !== undefined) {
      const n = String(patch.name).trim().slice(0, 60);
      if (!n) throw Error("Name the account");
      if (SECRET_SHAPED.test(String(patch.name))) throw Error(NAME_LOOKS_SECRET);
      if (
        s.accounts.some(
          (x) =>
            x.id !== a.id && x.provider === a.provider && x.name.toLowerCase() === n.toLowerCase(),
        )
      )
        throw Error("An account with that name exists");
      a.name = n;
    }
    if (patch.credentialKind !== undefined) {
      if (!["api-key", "subscription"].includes(patch.credentialKind))
        throw Error("Unknown credential kind");
      a.credentialKind = patch.credentialKind;
      if (isApiAccount(a)) {
        a.limitedUntil = null;
        a.limitKind = null;
        a.limitNote = null;
      }
    }
    if (patch.budget !== undefined) {
      const b = patch.budget;
      if (
        !isApiAccount(a) ||
        !Number.isFinite(b?.limitUsd) ||
        b.limitUsd <= 0 ||
        !Number.isFinite(Date.parse(b?.startAt))
      )
        throw Error("Invalid API budget");
      a.budget = { limitUsd: b.limitUsd, startAt: new Date(b.startAt).toISOString() };
    }
    if (patch.enabled !== undefined) a.enabled = patch.enabled === true;
    if (patch.priority !== undefined) {
      if (!Number.isSafeInteger(patch.priority) || patch.priority < 1 || patch.priority > 99)
        throw Error("Priority is 1 to 99");
      a.priority = patch.priority;
    }
    if (patch.keyEpoch !== undefined) {
      if (!uuid(patch.keyEpoch)) throw Error("Bad credential generation");
      a.keyEpoch = patch.keyEpoch;
    }
    if (patch.localRevoked !== undefined) a.localRevoked = patch.localRevoked === true;
    if (patch.auth !== undefined) {
      if (!["ok", "expired", "signing-in"].includes(patch.auth)) throw Error("Unknown auth state");
      a.auth = patch.auth;
      if (patch.auth === "ok" && !a.localRevoked) a.revoked = null;
    }
    if (patch.clearLimit === true) {
      if (!a.localRevoked) a.revoked = null;
      a.limitedUntil = null;
      a.limitKind = null;
      a.limitNote = null;
      a.limitObservedAt = iso(Date.now());
    }
    return a;
  });
}
// 7b fold: Move up / Move down swaps an account with its neighbour of the same provider, in one write under the store
// lock (the client never writes two priorities). The provider's list is first renumbered 1..n in its shown order, so a
// tie left by the old Move up (`priority - 1`) is repaired rather than carried.
export async function moveAccount(root, id, direction) {
  if (direction !== "up" && direction !== "down") throw Error("Move up or down");
  return update(root, (s) => {
    const a = s.accounts.find((x) => x.id === id);
    if (!a) throw Error("No such account");
    const list = s.accounts
      .filter((x) => x.provider === a.provider)
      .sort(
        (x, y) =>
          x.priority - y.priority ||
          String(x.createdAt).localeCompare(String(y.createdAt)) ||
          x.id.localeCompare(y.id),
      );
    const i = list.indexOf(a),
      j = direction === "up" ? i - 1 : i + 1;
    if (j < 0) throw Error("It is already first");
    if (j >= list.length) throw Error("It is already last");
    [list[i], list[j]] = [list[j], list[i]];
    list.forEach((x, k) => {
      x.priority = k + 1;
    });
    return a;
  });
}
export async function removeAccount(root, id) {
  return update(root, (s) => {
    const i = s.accounts.findIndex((x) => x.id === id);
    if (i < 0) throw Error("No such account");
    const [a] = s.accounts.splice(i, 1);
    if (s.defaults[a.provider] === a.id) s.defaults[a.provider] = null;
    return a;
  });
}
const LABEL = { claude: "Claude", codex: "Codex" };
// The default account for new sessions of `provider` (null: the pool's order decides).
export async function setDefaultAccount(root, provider, id) {
  if (!PROVIDERS.includes(provider)) throw Error("Unknown provider");
  return update(root, (s) => {
    if (id !== null && !s.accounts.some((a) => a.id === id && a.provider === provider))
      throw Error(`No such ${LABEL[provider]} account`);
    s.defaults[provider] = id;
    return id;
  });
}
export async function setRotateOnLimit(root, value) {
  if (typeof value !== "boolean") throw Error("Invalid limit setting");
  return update(root, (s) => {
    s.rotateOnLimit = value;
    return value;
  });
}
export async function setPolicy(root, policy) {
  if (!POLICIES.includes(policy)) throw Error("Unknown policy");
  return update(root, (s) => {
    s.policy = policy;
    return policy;
  });
}

// A launch of `sessionId`: keep its account while that account is available (a resume stays on its account); otherwise
// take the next one by policy. When the provider's pool is empty -> null (the launch is left exactly as it was: the
// machine's own login, as before the pool). When every account is limited -> the account with the earliest reset
// (the launch will stop at the limit again, and the controller waits for that reset), flagged allLimited.
export async function assign(root, sessionId, provider, now = Date.now()) {
  const usage = await readUsageAsync(root, now);
  return update(root, (s) => assignInStore(s, sessionId, provider, now, [], usage));
}
// `usage` applies only when the session needs an account: a session keeps its own account (no automatic switch).
function assignInStore(s, sessionId, provider, now, except = [], usage = {}) {
  const cur = s.assignments[sessionId],
    held = cur && s.accounts.find((a) => a.id === cur.accountId && a.provider === provider);
  if (cur?.takeover) {
    if (!held || held.provider !== provider || accountStatus(held, now).state !== "ok")
      throw Error("The target account is no longer available");
    return { account: { ...held }, allLimited: false, takeover: true };
  }
  if (!poolFor(s, provider)) return null;
  const heldState = held && !except.includes(held.id) ? accountStatus(held, now).state : null;
  // Waiting is the default: a limited account keeps its session (the launch waits for that reset) unless moving is on.
  // This holds even when the launch hook has already tried that account (`except`): it then refuses, rather than move.
  if (held && accountStatus(held, now).state === "limited" && !s.rotateOnLimit) {
    held.lastUsedAt = iso(now);
    s.assignments[sessionId] = { accountId: held.id, provider, at: iso(now), ended: false };
    return {
      account: { ...held },
      allLimited: true,
      earliestReset: accountStatus(held, now).until,
    };
  }
  let a = heldState === "ok" ? held : choose(s, provider, now, except, usage);
  let allLimited = false;
  if (!a) {
    a =
      s.accounts
        .filter(
          (x) =>
            x.provider === provider &&
            !except.includes(x.id) &&
            accountStatus(x, now).state === "limited",
        )
        .sort((x, y) =>
          accountStatus(x, now).until.localeCompare(accountStatus(y, now).until),
        )[0] ?? null;
    allLimited = !!a;
    if (!a)
      return {
        account: null,
        allLimited: false,
        reason: "No enabled account can be used (signed out or signing in)",
      };
  }
  a.lastUsedAt = iso(now);
  if (held && held.id !== a.id)
    s.rotations.push({
      at: iso(now),
      session: sessionId,
      provider,
      from: held.id,
      fromName: held.name,
      to: a.id,
      toName: a.name,
      resetAt: accountStatus(held, now).until ?? null,
      stopId: null,
      earliestReset: null,
      reason: "launch",
    });
  s.assignments[sessionId] = { accountId: a.id, provider, at: iso(now), ended: false };
  return {
    account: { ...a },
    allLimited,
    earliestReset: allLimited ? accountStatus(a, now).until : null,
  };
}
export async function sessionEnded(root, sessionId) {
  return update(root, (s) => {
    if (s.assignments[sessionId]) s.assignments[sessionId].ended = true;
    return null;
  });
}
// A revoked or invalid token seen on a one-shot call (`fulcra ask`): no session, so the account is marked directly.
// `fresh` is true only for the call that changed the account, so the owner is told once per account (FU-112).
export async function markAccountRevoked(root, accountId, { note = null } = {}, now = Date.now()) {
  return update(root, (s) => {
    const a = s.accounts.find((x) => x.id === accountId);
    if (!a) return null;
    const fresh = !a.revoked;
    if (fresh) a.revoked = { at: iso(now), reason: note ? String(note).slice(0, 200) : "" };
    return { id: a.id, name: a.name, fresh };
  });
}
// A usage limit seen on a one-shot call (`fulcra ask`): no session, so the account is marked directly. Same record as
// rotate() keeps: limitedUntil, limitKind and limitNote; a later reset is never shortened.
export async function markAccountLimited(
  root,
  accountId,
  { resetAt = null, kind = null, note = null } = {},
  now = Date.now(),
) {
  return update(root, (s) => {
    const a = s.accounts.find((x) => x.id === accountId);
    if (!a || isApiAccount(a)) return null;
    const until = resetAt && Date.parse(resetAt) > now ? resetAt : iso(now + DEFAULT_LIMIT_MS);
    if (!a.limitedUntil || Date.parse(a.limitedUntil) < Date.parse(until)) {
      a.limitedUntil = until;
      a.limitKind = typeof kind === "string" && kind ? kind.slice(0, 24) : null;
      a.limitNote = note ? String(note).slice(0, 200) : null;
    }
    a.limitObservedAt = iso(now);
    return { id: a.id, name: a.name, limitedUntil: a.limitedUntil, limitKind: a.limitKind };
  });
}
// A saved stop is only a hint. A new, pinned ask must confirm a Claude subscription limit.
export async function confirmAccountLimit({
  root,
  accountId,
  now = Date.now,
  keychain = createKeychain(),
  spawnClaude,
}) {
  const { askOnce } = await import("./ask.mjs");
  try {
    await askOnce({
      root,
      keychain,
      spawnClaude,
      now,
      limitProbe: true,
      input: {
        account: accountId,
        model: "claude-haiku-5-5",
        prompt: "Reply OK.",
        timeoutMs: 15000,
      },
    });
    return { accountId, limited: false };
  } catch (error) {
    if (error.code === "CONFIRMED_LIMIT" && error.confirmedLimit?.accountId === accountId)
      return error.confirmedLimit;
  }
  return null;
}
function stopAccount(s, sessionId, provider, accountId, stoppedAt) {
  const cur = s.assignments[sessionId];
  if (cur?.takeover) return null;
  if (!accountId && stoppedAt && Date.parse(cur?.at) > Date.parse(stoppedAt)) {
    accountId = s.rotations
      .filter((r) => r.session === sessionId && Date.parse(r.at) > Date.parse(stoppedAt))
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0]?.from;
    if (!accountId) return null;
  }
  return (
    s.accounts.find((a) => a.id === (accountId ?? cur?.accountId) && a.provider === provider) ??
    null
  );
}
// A usage limit on `sessionId`'s account: mark that account limited until `resetAt` (or DEFAULT_LIMIT_MS) and, only when
// the pool's rotateOnLimit is on, move the session to the next available account. Off (the default), the rotation is
// recorded as held and the session stays on its account; the usage-limit resume picks it up after the reset. Returns { from, to, earliestReset } -- `to` null when every account is limited.
// `reassign: false` (a human-held session): the account is marked limited and the event recorded, but the session is
// not moved -- its owner did not ask. Its next launch picks an account like any launch, and that move is recorded too.
export async function rotate(
  root,
  sessionId,
  provider,
  {
    resetAt = null,
    note = null,
    stopId = null,
    reassign = true,
    kind = null,
    accountId = null,
    stoppedAt = null,
    confirmLimit = confirmAccountLimit,
  } = {},
  now = Date.now(),
) {
  const snapshot = await readAccountsAsync(root);
  const binding = stopId && snapshot.limitChecks?.[stopId];
  if (binding && accountId && accountId !== binding.accountId) return null;
  accountId = binding?.accountId ?? accountId;
  const source = stopAccount(snapshot, sessionId, provider, accountId, stoppedAt);
  if (!source || (stopId && snapshot.rotations.some((r) => r.stopId === stopId))) return null;
  accountId = source.id;
  if (provider === "claude" && kind !== "revoked") {
    if (isApiAccount(source)) return null;
    const claim = await update(root, (s) => {
      s.limitChecks ??= {};
      const prior = stopId && s.limitChecks[stopId];
      if (prior && prior.accountId !== accountId) return false;
      if (prior && (!["unavailable", "checking"].includes(prior.outcome) || now < prior.retryAt))
        return false;
      if (stopId)
        s.limitChecks[stopId] = {
          accountId,
          at: iso(now),
          outcome: "checking",
          retryAt: now + 300_000,
        };
      return true;
    });
    if (!claim) return null;
    let confirmation;
    try {
      confirmation = await confirmLimit({ root, accountId, resetAt, kind, now: () => now });
    } catch {
      /* fail closed */
    }
    const confirmed =
      confirmation?.accountId === accountId && ["session", "weekly"].includes(confirmation.kind);
    await update(root, (s) => {
      if (stopId)
        s.limitChecks[stopId] = {
          accountId,
          at: iso(now),
          outcome: confirmed
            ? "limited"
            : confirmation?.limited === false
              ? "clear"
              : "unavailable",
          retryAt: now + 300_000,
        };
    });
    if (!confirmed) return null;
    resetAt = confirmation.resetAt;
    kind = confirmation.kind;
    note = "A pinned live ask confirmed this account's subscription limit.";
  }
  return update(root, (s) => {
    // A stop belongs to one launch. Reconnection must never apply it to a new account.
    if (stopId && s.rotations.some((r) => r.stopId === stopId)) return null;
    const cur = s.assignments[sessionId];
    if (cur?.takeover) return null;
    const from = s.accounts.find((a) => a.id === accountId && a.provider === provider);
    if (!from) return null;
    const revoked = kind === "revoked";
    if (!revoked && isApiAccount(from)) return null;
    const freshRevoked = revoked && !from.revoked;
    if (freshRevoked)
      from.revoked = { at: iso(now), reason: note ? String(note).slice(0, 200) : "" };
    const until = revoked
      ? null
      : resetAt && Date.parse(resetAt) > now
        ? resetAt
        : iso(now + DEFAULT_LIMIT_MS);
    if (!revoked && (!from.limitedUntil || Date.parse(from.limitedUntil) < Date.parse(until))) {
      from.limitedUntil = until;
      // The kind of limit the text named ("session", "weekly", ...). Kept with limitedUntil so the pair can be sent to
      // another computer as one record.
      from.limitKind = typeof kind === "string" && kind ? kind.slice(0, 24) : null;
      from.limitNote = note ? String(note).slice(0, 200) : null;
    }
    if (!revoked) from.limitObservedAt = iso(now);
    // Moving spends another account's usage, so it needs both the caller's ask and the owner's setting.
    // A revoked token cannot work again by waiting, so it moves the session whatever the owner's limit setting is.
    const move = reassign && cur?.accountId === from.id && (revoked || s.rotateOnLimit === true);
    const to = move ? choose(s, provider, now, [from.id]) : null;
    if (to) {
      s.assignments[sessionId] = { accountId: to.id, provider, at: iso(now), ended: false };
      to.lastUsedAt = iso(now);
    }
    const r = {
      at: iso(now),
      session: sessionId,
      provider,
      from: from.id,
      fromName: from.name,
      to: to?.id ?? null,
      toName: to?.name ?? null,
      resetAt: until,
      stopId,
      reason: revoked ? "revoked" : "limit",
      ...(freshRevoked ? { newlyRevoked: true } : {}),
      earliestReset: to ? null : earliestReset(s, provider, now),
      ...(move ? {} : { held: true }),
    };
    s.rotations.push(r);
    return r;
  });
}
// The owner's manual switch of ONE session to another account of its provider. `account` is an id or a name (any case).
// With a takeover seam (W2's, reached through the controller) the takeover OWNS the move: it fences the session, writes
// the assignment and the one history record (reason "manual"), then quietly reconnects with the retained history.
// A manual switch sends no continuation. This function only validates and asks, so it cannot move the store ahead
// of the running process
// (a launch while the takeover runs still takes the old account). Without a seam the choice is written here and applies
// at the session's next start. Messages are plain: never an error's own text, never what was typed (it could be a
// pasted token). Owner-initiated only: reached from the app's own RPC, never from an agent tool.
export async function switchSession(
  root,
  { sessionId, provider, account },
  { takeOver = null } = {},
  now = Date.now(),
) {
  const no = (message) => ({ ok: false, message });
  if (!PROVIDERS.includes(provider)) return no("This session’s provider has no account pool.");
  const want = String(account ?? "").trim();
  const pick = (s) => {
    const mine = s.accounts.filter((a) => a.provider === provider);
    const to =
      mine.find((a) => a.id === want) ??
      mine.find((a) => a.name.toLowerCase() === want.toLowerCase());
    if (!to)
      return {
        refused: `No ${LABEL[provider]} account has that name. Type /account to list them.`,
      };
    const st = accountStatus(to, now);
    if (st.state === "limited") return { refused: `${to.name} is limited until ${st.until}.` };
    if (st.state === "disabled") return { refused: `${to.name} is turned off.` };
    if (st.state === "auth-expired")
      return {
        refused:
          provider === "claude"
            ? `${to.name} is signed out. Add its token again in Settings › Accounts & models.`
            : `${to.name} is signed out. Sign in to it again in Settings › Accounts & models.`,
      };
    if (st.state !== "ok") return { refused: `${to.name} is still signing in.` };
    const cur = s.assignments[sessionId] ?? null,
      from = cur && s.accounts.find((a) => a.id === cur.accountId);
    if (from?.id === to.id && !cur.ended) return { same: to.name };
    return { to, from: from ?? null };
  };
  if (takeOver) {
    const r = pick(await readAccountsAsync(root));
    if (r.refused) return no(r.refused);
    if (r.same) return { ok: true, message: `This session already uses ${r.same}.` };
    let t;
    try {
      t = await takeOver(
        sessionId,
        { id: r.to.id, name: r.to.name, provider },
        { reason: "manual" },
      );
    } catch {
      t = null;
    }
    if (t?.ok)
      return {
        ok: true,
        moved: "takeover",
        message:
          typeof t.message === "string" && t.message
            ? t.message.slice(0, 300)
            : `Switched to account "${r.to.name}".`,
      };
    return no(
      t && typeof t.message === "string" && t.message
        ? t.message.slice(0, 300)
        : `The session could not switch to ${r.to.name}.${r.from ? ` It stays on ${r.from.name}.` : ""}`,
    );
  }
  const r = await update(root, (s) => {
    const x = pick(s);
    if (x.refused || x.same) return x;
    s.assignments[sessionId] = { accountId: x.to.id, provider, at: iso(now), ended: false };
    x.to.lastUsedAt = iso(now);
    s.rotations.push({
      at: iso(now),
      session: sessionId,
      provider,
      from: x.from?.id ?? null,
      fromName: x.from?.name ?? null,
      to: x.to.id,
      toName: x.to.name,
      resetAt: null,
      stopId: null,
      earliestReset: null,
      reason: "manual",
    });
    return x;
  });
  if (r.refused) return no(r.refused);
  if (r.same) return { ok: true, message: `This session already uses ${r.same}.` };
  return {
    ok: true,
    moved: "switch",
    message: `Switched to ${r.to.name}. The session continues on it from its next start.`,
  };
}
// The takeover seam through the controller (COORD decision): W2's `session-takeover` command runs takeOverSession --
// owner/lead-authorised and generation-fenced there; it writes the assignment and the one history record (reason
// "manual"). `call` is the plugin host's management call (localCall). Only its plain message crosses back.
export function controllerTakeOver(call) {
  return async (sessionId, account, o) => {
    const r = await call("session-takeover", {
      session: sessionId,
      accountId: account.id,
      reason: o?.reason ?? "manual",
    });
    return r && typeof r === "object"
      ? {
          ok: r.ok === true,
          message: typeof r.message === "string" && r.message ? r.message.slice(0, 300) : null,
        }
      : null;
  };
}
// The "Switch account…" picker for one session: its provider's accounts with their state, the one it uses, the default.
export function sessionAccounts(s, sessionId, provider, now = Date.now()) {
  const x = s.assignments[sessionId];
  return {
    provider: PROVIDERS.includes(provider) ? provider : null,
    current: x && !x.ended && x.provider === provider ? x.accountId : null,
    accounts: s.accounts
      .filter((a) => a.provider === provider)
      .sort((a, b) => a.priority - b.priority)
      .map((a) => ({
        id: a.id,
        name: a.name,
        status: accountStatus(a, now),
        isDefault: s.defaults?.[provider] === a.id,
      })),
  };
}
export function rotationFor(root, stopId) {
  return readAccounts(root).rotations.findLast((r) => r.stopId === stopId) ?? null;
}

// What a client may see: no credential, no path.
export function publicView(s, now = Date.now()) {
  return {
    policy: s.policy,
    accounts: s.accounts.map((a) => ({
      id: a.id,
      provider: a.provider,
      name: a.name,
      enabled: a.enabled,
      priority: a.priority,
      status: accountStatus(a, now),
      credentialKind: isApiAccount(a) ? "api-key" : "subscription",
      budget: accountBudget(a),
      limitNote: isApiAccount(a) ? null : a.limitNote,
      limitKind: accountLimit(a, now)?.kind ?? null,
      sessions: Object.entries(s.assignments)
        .filter(([, x]) => x.accountId === a.id && !x.ended)
        .map(([id]) => id)
        .slice(0, 50),
      lastUsedAt: a.lastUsedAt,
    })),
    allLimited: Object.fromEntries(
      PROVIDERS.filter((p) => poolFor(s, p)).map((p) => [
        p,
        choose(s, p, now) ? null : earliestReset(s, p, now),
      ]),
    ),
    rotations: s.rotations.slice(-20).map((r) => ({
      at: r.at,
      session: r.session,
      provider: r.provider,
      from: r.fromName,
      to: r.toName,
      resetAt: r.resetAt,
      earliestReset: r.earliestReset,
      ...(r.reason === "manual" || r.reason === "revoked" ? { reason: r.reason } : {}),
    })),
    defaultAccounts: { ...s.defaults },
    rotateOnLimit: s.rotateOnLimit === true,
  };
}
export function accountOf(s, sessionId) {
  const x = s.assignments[sessionId];
  const a = x && s.accounts.find((y) => y.id === x.accountId);
  return a ? { id: a.id, name: a.name, provider: a.provider } : null;
}

// ---- credentials
const TOKEN = /^[A-Za-z0-9._~+/=-]{20,1024}$/;
const run = (bin, args, input, env) =>
  new Promise((resolve, reject) => {
    const p = execFile(
      bin,
      args,
      {
        timeout: 15000,
        maxBuffer: 65536,
        encoding: "utf8",
        env:
          env ??
          Object.fromEntries(
            ["PATH", "HOME", "SystemRoot", "TEMP", "TMP", "USERPROFILE"]
              .filter((k) => process.env[k] !== undefined)
              .map((k) => [k, process.env[k]]),
          ),
      },
      (e, out, err) => {
        // Interactive security can report refusal, then exit zero. Prompts alone
        // are normal; discard every other diagnostic and never retain raw errors.
        if (e || (args[0] === "-i" && err.replace(/security>\s*/g, "").trim()))
          reject(
            Object.assign(Error("Account Keychain: operation-failed"), {
              code: e?.code === 44 ? "ACCOUNT_ITEM_MISSING" : "ACCOUNT_KEYCHAIN_UNAVAILABLE",
            }),
          );
        else resolve(out);
      },
    );
    if (input !== undefined) {
      p.stdin.once("error", () => reject(Error("Account Keychain: operation-failed")));
      p.stdin.end(input);
    }
  });
// The Keychain the app keeps Claude account tokens in. `keychain` (a path) is for tests: a scratch keychain; the product
// uses the user's default keychain. The token goes in through `security -i` on stdin, never argv.
// Tests and gates only: FULCRA_ACCOUNTS_SECURITY (an absolute path, honoured only together with a scratch
// FULCRA_ACCOUNTS_KEYCHAIN) swaps /usr/bin/security for fake-security.fixture.mjs, so no real keychain is ever created
// and the user's keychain search list is never touched (B6).
const testSecurity = (env) =>
  env.FULCRA_ACCOUNTS_KEYCHAIN && path.isAbsolute(env.FULCRA_ACCOUNTS_SECURITY ?? "")
    ? env.FULCRA_ACCOUNTS_SECURITY
    : null;
// Windows has no Keychain. The token is wrapped with DPAPI (CurrentUser scope, so only this Windows user can read it)
// in a PowerShell child: it goes in on stdin, never argv, and one ciphertext file per account sits in `dir`. `runner`
// is a test seam with the same shape as `run`. macOS keeps the Keychain (createKeychain below).
const DPAPI_PROTECT =
  "Add-Type -AssemblyName System.Security;$i=[Console]::In.ReadToEnd();" +
  "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($i),$null,'CurrentUser'))";
const DPAPI_UNPROTECT =
  "Add-Type -AssemblyName System.Security;$i=[Console]::In.ReadToEnd().Trim();" +
  "[Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($i),$null,'CurrentUser'))";
const powershellArgs = (script) => [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  script,
];
export function windowsKeychainDir(env = process.env) {
  const home =
    env.ORCA_HOME ?? (env.PASEO_HOME ? path.join(env.PASEO_HOME, "command-centre") : null);
  if (!home) throw Error("Account Keychain: no Command Centre home");
  return path.join(home, "accounts", "secrets");
}
export function createWindowsKeychain({
  dir = windowsKeychainDir(),
  powershell = powershellExe(),
  runner = run,
} = {}) {
  const fileOf = (id) => path.join(dir, `${id}.dpapi`);
  const unavailable = () =>
    Object.assign(Error("Account Keychain: operation-failed"), {
      code: "ACCOUNT_KEYCHAIN_UNAVAILABLE",
    });
  async function read(id) {
    let cipher;
    try {
      cipher = fs.readFileSync(fileOf(id), "utf8");
    } catch (e) {
      throw e?.code === "ENOENT"
        ? Object.assign(Error("Account Keychain: operation-failed"), {
            code: "ACCOUNT_ITEM_MISSING",
          })
        : unavailable();
    }
    try {
      return (await runner(powershell, powershellArgs(DPAPI_UNPROTECT), cipher)).replace(
        /\r?\n$/,
        "",
      );
    } catch {
      throw unavailable();
    }
  }
  return {
    async put(id, secret) {
      if (!uuid(id)) throw Error("Bad account id");
      if (!TOKEN.test(secret ?? ""))
        throw Error("That does not look like a token from `claude setup-token`");
      let cipher;
      try {
        cipher = (await runner(powershell, powershellArgs(DPAPI_PROTECT), secret)).trim();
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const temp = `${fileOf(id)}.${process.pid}.tmp`;
        fs.writeFileSync(temp, `${cipher}\n`, { mode: 0o600 });
        fs.renameSync(temp, fileOf(id));
      } catch {
        throw Error("Account Keychain: operation-failed");
      }
      let stored;
      try {
        stored = await read(id);
      } catch {
        throw Error("Account Keychain: readback-failed");
      }
      if (stored !== secret) throw Error("Account Keychain: readback-mismatch");
    },
    async get(id) {
      if (!uuid(id)) throw Error("Bad account id");
      try {
        const v = await read(id);
        return TOKEN.test(v) ? v : null;
      } catch (error) {
        if (error?.code === "ACCOUNT_ITEM_MISSING") return null;
        throw Object.assign(Error("Account Keychain temporarily unavailable; retry"), {
          code: "ACCOUNT_KEYCHAIN_UNAVAILABLE",
        });
      }
    },
    async remove(id) {
      if (!uuid(id)) return;
      fs.rmSync(fileOf(id), { force: true });
      if (fs.existsSync(fileOf(id))) throw unavailable();
    },
  };
}
export function createKeychain({
  keychain = process.env.FULCRA_ACCOUNTS_KEYCHAIN || null,
  security = testSecurity(process.env) ?? "/usr/bin/security",
  platform = process.platform,
} = {}) {
  if (platform === "win32" && !keychain) return createWindowsKeychain();
  const kc = keychain ? [keychain] : [];
  const q = (v) => `"${String(v).replace(/[\\"]/g, "")}"`;
  const read = async (id) =>
    (
      await run(security, ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id, "-w", ...kc])
    ).replace(/\r?\n$/, "");
  return {
    async put(id, secret) {
      if (!uuid(id)) throw Error("Bad account id");
      if (!TOKEN.test(secret ?? ""))
        throw Error("That does not look like a token from `claude setup-token`");
      await run(
        security,
        ["-i"],
        `add-generic-password -U -s ${q(KEYCHAIN_SERVICE)} -a ${q(id)} -w ${q(secret)}${keychain ? " " + q(keychain) : ""}\n`,
      );
      let stored;
      try {
        stored = await read(id);
      } catch {
        throw Error("Account Keychain: readback-failed");
      }
      // Settings may acknowledge the token only after this exact item round-trip.
      // Do not repair ACLs or delete items after a refused readback.
      if (stored !== secret) throw Error("Account Keychain: readback-mismatch");
    },
    async get(id) {
      if (!uuid(id)) throw Error("Bad account id");
      try {
        const v = await read(id);
        return TOKEN.test(v) ? v : null;
      } catch (error) {
        if (error?.code === "ACCOUNT_ITEM_MISSING") return null;
        // Timeout, locked Keychain and process/resource failures are not proof
        // that a saved token expired. Preserve account state and permit retry.
        throw Object.assign(Error("Account Keychain temporarily unavailable; retry"), {
          code: "ACCOUNT_KEYCHAIN_UNAVAILABLE",
        });
      }
    },
    async remove(id) {
      if (!uuid(id)) return;
      try {
        await run(security, ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", id, ...kc]);
      } catch (error) {
        if (error?.code !== "ACCOUNT_ITEM_MISSING") throw error;
      }
      try {
        await read(id);
      } catch (error) {
        if (error?.code === "ACCOUNT_ITEM_MISSING") return;
        throw error;
      }
      throw Error("Account Keychain: delete-failed");
    },
  };
}
// The shared Codex base: the home Codex uses without the pool.
export function codexBase(env = process.env) {
  return env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME)
    ? env.CODEX_HOME
    : path.join(env.HOME || os.homedir(), ".codex");
}
export const SHARED = Object.freeze([
  "sessions",
  "archived_sessions",
  "session_index.jsonl",
  "history.jsonl",
]);
export function codexHome(root, id) {
  if (!uuid(id)) throw Error("Bad account id");
  return path.join(accountsDir(root), "codex", id);
}
export function prepareCodexHome(root, id, base = codexBase()) {
  const home = codexHome(root, id);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  for (const d of ["sessions", "archived_sessions"])
    fs.mkdirSync(path.join(base, d), { recursive: true, mode: 0o700 });
  for (const n of SHARED) {
    const link = path.join(home, n);
    try {
      if (fs.readlinkSync(link) === path.join(base, n)) continue;
      fs.rmSync(link, { force: true });
    } catch (e) {
      if (e.code !== "ENOENT" && e.code !== "EINVAL") throw e;
    }
    fs.symlinkSync(path.join(base, n), link);
  }
  const cfg = path.join(home, "config.toml");
  if (!fs.existsSync(cfg))
    fs.writeFileSync(cfg, 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
  return home;
}
// One browser sign-in for a Codex account, on this Mac: `codex login` in the account's own home. Resolves when the
// home holds its auth.json. `codex` is resolved from PATH like the product's own launch.
export function codexLogin(
  root,
  id,
  { codex = "codex", env = process.env, timeoutMs = 600000 } = {},
) {
  const home = prepareCodexHome(root, id, codexBase(env));
  return new Promise((resolve, reject) => {
    const p = spawn(codex, ["login"], {
      env: { ...env, CODEX_HOME: home, CODEX_SQLITE_HOME: codexBase(env) },
      stdio: ["ignore", "ignore", "ignore"],
      detached: false,
    });
    const t = setTimeout(() => {
      p.kill("SIGTERM");
      reject(Error("The sign-in did not finish in time"));
    }, timeoutMs);
    p.on("error", (e) => {
      clearTimeout(t);
      reject(
        Error(
          e.code === "ENOENT"
            ? "Codex is not installed on this Mac"
            : "The sign-in could not start",
        ),
      );
    });
    p.on("exit", (code) => {
      clearTimeout(t);
      fs.existsSync(path.join(home, "auth.json")) && code === 0
        ? resolve(home)
        : reject(Error("The sign-in did not complete"));
    });
  });
}
export function codexSignedIn(root, id) {
  try {
    return fs.statSync(path.join(codexHome(root, id), "auth.json")).isFile();
  } catch {
    return false;
  }
}

// ---- the launch hook (agent.session_open): the account's credential for THIS launch only, never persisted.
export function launchEnv(provider, account, { token, root, session = null, env = process.env }) {
  if (provider === "claude")
    return credentialKind(token) === "api-key"
      ? {
          CLAUDE_CODE_OAUTH_TOKEN: "",
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
          FULCRA_API_KEY_ACCOUNT: JSON.stringify({
            root,
            id: account.id,
            epoch: account.keyEpoch ?? null,
          }),
          FULCRA_API_KEY_HELPER: apiKeyHelperCommand({
            root,
            id: account.id,
            session,
            epoch: account.keyEpoch ?? null,
            env,
          }),
        }
      : {
          CLAUDE_CODE_OAUTH_TOKEN: token,
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_AUTH_TOKEN: "",
          FULCRA_API_KEY_HELPER: "",
          FULCRA_API_KEY_ACCOUNT: "",
        };
  if (provider === "codex")
    return { CODEX_HOME: codexHome(root, account.id), CODEX_SQLITE_HOME: codexBase(env) };
  return {};
}
// FULCRA_ACCOUNT_NAME (the account's display label, not a secret): the host labels a pooled session's usage with it.
export function sessionOpenHook({
  root,
  keychain = createKeychain(),
  now = Date.now,
  env = process.env,
  onAllLimited = () => {},
}) {
  return async ({ request }) => {
    if (request.purpose === "history" || !PROVIDERS.includes(request.provider)) return request;
    const refused = () => Error("The pooled account launch could not be admitted");
    try {
      const storeRoot = root(),
        seen = [],
        sessionId = request.agentId,
        provider = request.provider;
      const usage = await readUsageAsync(storeRoot, now());
      let expected,
        started = false;
      // Absence is history unknown: the bounded store prunes old assignments. Only an ordinary
      // launch with neither a retained assignment nor an enabled pool may opt out.
      for (let tries = 0; tries < MAX_ACCOUNTS; tries++) {
        const reservation = await update(storeRoot, (s) => {
          const cur = s.assignments[sessionId];
          if (started && JSON.stringify(cur) !== expected) throw refused();
          if (cur && cur.provider !== provider) throw refused();
          if (!poolFor(s, provider)) {
            if (!started && !cur) return null;
            throw refused();
          }
          // FU-59: `fulcra run --account <name>` pins a NEW session to that account; a resumed session keeps its own.
          const wanted =
            !cur && !started && typeof request.env?.FULCRA_ACCOUNT_REQUEST === "string"
              ? request.env.FULCRA_ACCOUNT_REQUEST.trim().toLowerCase()
              : "";
          let result;
          if (wanted) {
            const pinned = s.accounts.find(
              (a) =>
                a.provider === provider &&
                (a.id.toLowerCase() === wanted || a.name.toLowerCase() === wanted),
            );
            if (!pinned || accountStatus(pinned, now()).state !== "ok") throw refused();
            pinned.lastUsedAt = iso(now());
            s.assignments[sessionId] = {
              accountId: pinned.id,
              provider,
              at: iso(now()),
              ended: false,
            };
            result = { account: { ...pinned }, allLimited: false };
          } else result = assignInStore(s, sessionId, provider, now(), seen, usage);
          if (!result?.account || seen.includes(result.account.id)) throw refused();
          return { result, assignment: JSON.stringify(s.assignments[sessionId]) };
        });
        if (!reservation) return request;
        started = true;
        expected = reservation.assignment;
        const r = reservation.result;
        seen.push(r.account.id);
        // Credential preparation must not hold the store lock (it may outlive its stale timeout).
        let token = null;
        if (provider === "claude") {
          for (let readAttempt = 0; readAttempt < 2; readAttempt++) {
            // A retry is still this exact reservation, never permission to select
            // another account or revive a revoked one after awaiting Keychain.
            const current = await readAccountsAsync(storeRoot);
            const account = current.accounts.find(
              (a) => a.id === r.account.id && a.provider === provider,
            );
            const state = account && accountStatus(account, now()).state;
            if (
              JSON.stringify(current.assignments[sessionId]) !== expected ||
              (state !== "ok" && !(r.allLimited && state === "limited"))
            )
              throw refused();
            try {
              token = await keychain.get(r.account.id);
            } catch (error) {
              if (error?.code !== "ACCOUNT_KEYCHAIN_UNAVAILABLE" || readAttempt === 1)
                throw refused();
            }
            if (token) break;
          }
        }
        const ready = provider === "claude" ? !!token : codexSignedIn(storeRoot, r.account.id);
        if (ready && r.allLimited) {
          try {
            onAllLimited({ provider, session: sessionId, earliestReset: r.earliestReset });
          } catch {}
        }
        const out = await update(storeRoot, (s) => {
          if (JSON.stringify(s.assignments[sessionId]) !== expected) throw refused();
          const account = s.accounts.find((a) => a.id === r.account.id && a.provider === provider);
          const state = account && accountStatus(account, now()).state;
          if (provider === "claude" && (account?.keyEpoch ?? null) !== (r.account.keyEpoch ?? null))
            throw refused();
          if (state !== "ok" && !(r.allLimited && state === "limited")) throw refused();
          if (!ready) {
            if (r.takeover) throw refused();
            // Missing/unreadable Keychain material is not a provider rejection.
            // Keep Claude retryable on the next launch; never base-login fallback.
            if (provider === "codex") account.auth = "signing-in";
            return null;
          }
          if (provider === "claude") account.credentialKind = credentialKind(token);
          // The current assignment/one-use intent and account eligibility are checked together,
          // immediately before publishing this launch's environment. Labels are never admission evidence.
          return {
            ...request,
            env: {
              ...Object.fromEntries(
                Object.entries(request.env ?? {}).filter(
                  ([, value]) =>
                    credentialKind(token) !== "api-key" ||
                    typeof value !== "string" ||
                    !value.includes(token),
                ),
              ),
              ...launchEnv(provider, account, { token, root: storeRoot, session: sessionId, env }),
              FULCRA_ACCOUNT_ID: account.id,
              FULCRA_ACCOUNT_NAME: String(account.name ?? "").slice(0, 60),
            },
          };
        });
        if (out) return out;
      }
      throw refused();
    } catch {
      // Neither store errors nor credential diagnostics may disclose private data or enable base-login fallback.
      throw refused();
    }
  };
}

// Credential I/O can exceed the metadata lock's stale timeout. This separate lock never expires while its owner lives.
export async function withCredentialLock(root, id, fn, { recoverStale = false } = {}) {
  if (!uuid(id)) throw Error("Bad account id");
  const dir = accountsDir(root);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, `.credential-${id}.lock`);
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      // The metadata lock serializes acquisition and recovery between all contenders.
      await update(root, () => {
        try {
          fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          const owner = Number(fs.readFileSync(lock, "utf8"));
          const age = Date.now() - fs.statSync(lock).mtimeMs;
          let dead = false;
          if (Number.isSafeInteger(owner) && owner > 0) {
            try {
              process.kill(owner, 0);
            } catch (e) {
              dead = e.code === "ESRCH";
            }
          }
          if (!dead || !recoverStale || age < 1000) throw error;
          fs.unlinkSync(lock);
          fs.writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
        }
      });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw Error("The account credential store is busy");
      // Wake on the owner's unlink. The timeout bounds a lost native filesystem event.
      await new Promise((resolve) => {
        const watcher = fs.watch(dir, () => {
          watcher.close();
          clearTimeout(timer);
          resolve();
        });
        const timer = setTimeout(
          () => {
            watcher.close();
            resolve();
          },
          Math.max(1, Math.min(1000, deadline - Date.now())),
        );
        watcher.on("error", () => {
          watcher.close();
          clearTimeout(timer);
          resolve();
        });
        // Close the registration race when the lock was removed before watch started.
        if (!fs.existsSync(lock)) {
          watcher.close();
          clearTimeout(timer);
          resolve();
        }
      });
    }
  }
  try {
    return await fn();
  } finally {
    await fsp.rm(lock, { force: true });
  }
}

export async function revokeLocalAccount(root, id, now = Date.now()) {
  return update(root, (s) => {
    const a = s.accounts.find((a) => a.id === id);
    if (!a || !isApiAccount(a)) throw Error("No such API account");
    a.localRevoked = true;
    a.keyEpoch = randomUUID();
    a.auth = "expired";
    a.revoked = { at: iso(now), reason: "Revoked by the owner" };
    return a;
  });
}

// Runtime leases are written by the actual Claude spawn boundary, before any helper can run.
export async function waitForApiRuntimes(root, accountId, timeoutMs = 5000) {
  const dir = path.join(accountsDir(root), "api-runtimes");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pending = [];
  for (const name of fs.readdirSync(dir)) {
    if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
    const file = path.join(dir, name);
    let lease;
    try {
      lease = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw Error("API runtime stop could not be confirmed");
    }
    if (lease.accountId !== accountId) continue;
    const ownerStart = processIdentity(lease.ownerPid);
    if (ownerStart === null || (lease.ownerStart && ownerStart !== lease.ownerStart)) {
      pending.push(
        (async () => {
          await stopRecordedTree(lease.childPid, lease.childStart);
          fs.rmSync(file, { force: true });
          // A dead owner cannot clean its private Unix socket directory.
          if (
            typeof lease.address === "string" &&
            /^\/tmp\/fulcra-api-[^/]+\/control\.sock$/.test(lease.address)
          ) {
            try {
              fs.rmSync(lease.address, { force: true });
              fs.rmdirSync(path.dirname(lease.address));
            } catch {
              /* Process termination is already confirmed. */
            }
          }
        })(),
      );
      continue;
    }
    pending.push(
      new Promise((resolve, reject) => {
        if (typeof lease.address !== "string" || !uuid(lease.stopToken)) {
          reject(Error("API runtime stop could not be confirmed"));
          return;
        }
        const socket = net.createConnection(lease.address);
        let reply = "",
          settled = false;
        const finish = (ok) => {
          if (settled) return;
          settled = true;
          socket.destroy();
          ok ? resolve() : reject(Error("API runtime stop could not be confirmed"));
        };
        socket.setTimeout(timeoutMs, () => finish(false));
        socket.once("connect", () => socket.write(`${lease.stopToken}\n`));
        socket.on("data", (chunk) => {
          reply += chunk.toString();
          if (reply.includes("\n")) finish(reply === "stopped\n" && !fs.existsSync(file));
        });
        socket.once("error", () => finish(!fs.existsSync(file)));
        socket.once("close", () => finish(!fs.existsSync(file)));
      }),
    );
  }
  await Promise.all(pending);
}
