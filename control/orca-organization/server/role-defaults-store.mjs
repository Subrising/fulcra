// Update-7: persisted model + effort defaults per role and provider, edited in Settings -> Accounts & models.
// Its own file (<Command Centre home>/accounts/defaults.json, 0600): the shared config's defaults.roles is a CLOSED
// object that older tool servers validate (L44), so new roles (review, research) and every edit live here. Readers take
// this store first and the shared config's defaults.roles second, so an installation that never opened the screen keeps
// exactly its current behaviour for the three existing roles.
// Values are requests, not guarantees: every create path checks them against the installed provider's model list and
// that model's efforts (session-defaults.ts applyRoleDefaults), and falls back to the provider's own default.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { accountsDir, withStoreLock } from "./accounts.mjs";

export const DEFAULT_ROLES = Object.freeze([
  "orchestration",
  "planning",
  "review",
  "implementation",
  "research",
  "light",
]);
export const LEAD_ROLES = Object.freeze(["orchestration", "planning", "review"]);
const sel = (model, thinkingOptionId) => ({ model, thinkingOptionId });
// The owner's rule (update-7 W3): leads (prime, orchestrator, planner, reviewer) Opus 5.5 medium; implementers Sonnet 5.5
// medium, or Codex gpt-6.1-sol medium. High is what a task asks for (a per-call effort), not what every lead pays for.
// FULCRA(claude-only, David 7 Oct 2026): every role's default provider is Claude; Codex stays a choice.
export const SEED = Object.freeze({
  orchestration: {
    provider: "claude",
    claude: sel("claude/claude-opus-5-5", "medium"),
    codex: sel("codex/gpt-6.1-sol", "medium"),
  },
  planning: {
    provider: "claude",
    claude: sel("claude/claude-opus-5-5", "medium"),
    codex: sel("codex/gpt-6.1-sol", "medium"),
  },
  review: {
    provider: "claude",
    claude: sel("claude/claude-opus-5-5", "medium"),
    codex: sel("codex/gpt-6.1-sol", "medium"),
  },
  implementation: {
    provider: "claude",
    claude: sel("claude/claude-sonnet-5-5", "medium"),
    codex: sel("codex/gpt-6.1-sol", "medium"),
  },
  research: {
    provider: "claude",
    claude: sel("claude/claude-sonnet-5-5", "medium"),
    codex: sel("codex/gpt-6.1-sol", "medium"),
  },
  // FULCRA(light-role): summaries, digests, searches, test runs, simulated users and monitors. Only this store and the
  // seed name it, never the shared config, whose closed role list older builds validate.
  light: {
    provider: "claude",
    claude: sel("claude/claude-haiku-5-5", "medium"),
    codex: sel("codex/gpt-6.1-sol", "medium"),
  },
});
// Update-7 W3 (owner, 01:29Z): the default permission mode for new sessions, per provider. Claude `auto` is the model
// classifier (not bypassPermissions, which is never offered); Codex `auto-review` preserves its review policy. The
// choices are what Settings offers and what a stored value may be.
export const MODE_CHOICES = Object.freeze({
  claude: Object.freeze(["auto", "acceptEdits", "default", "plan"]),
  codex: Object.freeze(["full-access", "auto-review", "auto"]),
});
export const SEED_MODES = Object.freeze({ claude: "auto", codex: "auto-review" });
const MODE_PROVIDERS = Object.freeze(["claude", "codex"]);
const modeOf = (p, v) => (typeof v === "string" && MODE_CHOICES[p].includes(v) ? v : null);
const file = (root) => path.join(accountsDir(root), "defaults.json");
const clean = (v, max) => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : null);
function cleanRole(r, fallback) {
  const s = (p) => ({
    model: clean(r?.[p]?.model, 200),
    thinkingOptionId: clean(r?.[p]?.thinkingOptionId, 40),
  });
  return {
    provider: ["claude", "codex"].includes(r?.provider) ? r.provider : fallback.provider,
    claude: r?.claude ? s("claude") : fallback.claude,
    codex: r?.codex ? s("codex") : fallback.codex,
  };
}
// The effective table: this store over the shared config's roles (existing three) over the seed. Modes: a Settings
// choice, then the shared config's defaults.modes (read, never written: the live value is an operator one-shot), then
// the seed.
export function readRoleDefaults(root, configRoles = null, configModes = null) {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file(root), "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const roles = {};
  for (const role of DEFAULT_ROLES) {
    const fromConfig = configRoles?.[role]
      ? cleanRole(
          {
            provider: configRoles[role].provider,
            claude: configRoles[role].claude,
            codex: configRoles[role].codex,
          },
          SEED[role],
        )
      : SEED[role];
    roles[role] = stored.roles?.[role] ? cleanRole(stored.roles[role], fromConfig) : fromConfig;
  }
  const modes = Object.fromEntries(
    MODE_PROVIDERS.map((p) => [
      p,
      modeOf(p, stored.modes?.[p]) ?? modeOf(p, configModes?.[p]) ?? SEED_MODES[p],
    ]),
  );
  return { roles, orchestrationGuard: stored.orchestrationGuard === true, modes };
}
// Startup initializes only an absent installation table. An existing (including migrated)
// Settings file is left byte-identical; an explicit config choice wins over the seed.
// FULCRA(light-role): roles newer than the builds that may still read this file are not written here; the seed supplies
// them, and a Settings save is the first write that names them.
const INITIAL_ROLES = Object.freeze(DEFAULT_ROLES.filter((role) => role !== "light"));
export function initializeRoleDefaults(root, configRoles = null, configModes = null) {
  const read = readRoleDefaults(root, configRoles, configModes);
  const table = {
    ...read,
    roles: Object.fromEntries(INITIAL_ROLES.map((role) => [role, read.roles[role]])),
  };
  const dir = accountsDir(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.defaults-${randomUUID()}.json`);
  try {
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, ...table }, null, 1) + "\n", {
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    try {
      fs.linkSync(tmp, file(root));
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
  return readRoleDefaults(root, configRoles, configModes);
}
// The modes chosen in Settings only (no config, no seed): the controller places them above the shared config.
export function chosenModes(root) {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file(root), "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return Object.fromEntries(
    MODE_PROVIDERS.map((p) => [p, modeOf(p, stored.modes?.[p])]).filter(([, m]) => m),
  );
}
// The provider someone actually chose for a role (Settings, then the shared config), or null. With none, a create that
// omits its provider uses the seed's provider only where the controller finds it offered on this host (update-7 W3).
export function configuredRoleProvider(root, configRoles, role) {
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file(root), "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  for (const p of [stored.roles?.[role]?.provider, configRoles?.[role]?.provider])
    if (["claude", "codex"].includes(p)) return p;
  return null;
}
// The read-modify-write runs under the account store's lock (R1 B2): the plugin host and the controller are separate
// processes, and without it one save could overwrite another's.
export function writeRoleDefaults(root, patch, configRoles = null) {
  return withStoreLock(root, async () => writeRoleDefaultsLocked(root, patch, configRoles));
}
function writeRoleDefaultsLocked(root, patch, configRoles) {
  const cur = readRoleDefaults(root, configRoles);
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file(root), "utf8"));
  } catch {}
  stored = {
    v: 1,
    roles: stored.roles ?? {},
    orchestrationGuard: stored.orchestrationGuard === true,
    modes: stored.modes ?? {},
  };
  if (patch.mode) {
    const p = patch.mode.provider;
    if (!MODE_PROVIDERS.includes(p) || !modeOf(p, patch.mode.modeId)) throw Error("Unknown mode");
    stored.modes[p] = patch.mode.modeId;
  }
  if (patch.role) {
    if (!DEFAULT_ROLES.includes(patch.role)) throw Error("Unknown role");
    stored.roles[patch.role] = cleanRole(patch.defaults, cur.roles[patch.role]);
  }
  if (patch.orchestrationGuard !== undefined)
    stored.orchestrationGuard = patch.orchestrationGuard === true;
  const dir = accountsDir(root);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.defaults-${randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(stored, null, 1) + "\n", { mode: 0o600, flag: "wx" });
  fs.renameSync(tmp, file(root));
  return readRoleDefaults(root, configRoles);
}
// The shape the create hook (applyRoleDefaults) reads: roles.<role>.<provider> = { model, thinkingOptionId }.
export function hookRoles(table) {
  return Object.fromEntries(
    Object.entries(table.roles).map(([role, r]) => [role, { claude: r.claude, codex: r.codex }]),
  );
}
