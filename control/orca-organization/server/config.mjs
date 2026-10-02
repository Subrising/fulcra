import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
const object = (v, keys, name, required = []) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw Error(`Invalid setting ${name}`);
  for (const k of required) if (!Object.hasOwn(v, k)) throw Error(`Missing setting ${name}.${k}`);
  for (const k of Object.keys(v))
    if (!keys.includes(k)) throw Error(`Unknown setting ${name}.${k}`);
};
// L44: a config written for a NEWER build carries settings this build does not know. Throwing on them stopped every
// running tool server of an older build the moment a newer build's key was written (memoryRoot, 29 Sep). At the top
// level and directly under `defaults`, unknown keys are therefore ignored -- left in the object untouched, so a write-back
// keeps them -- while every key this build knows is still validated strictly. Deeper objects stay closed.
const open = (v, name, required = []) => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw Error(`Invalid setting ${name}`);
  for (const k of required) if (!Object.hasOwn(v, k)) throw Error(`Missing setting ${name}.${k}`);
};
export const KNOWN_SETTINGS = Object.freeze([
  "version",
  "daemon",
  "authority",
  "providers",
  "hosts",
  "localHost",
  "defaults",
  "artifacts",
  "worktreeLifecycle",
  "outcomesRoot",
  "memoryRoot",
]);
export const KNOWN_DEFAULTS = Object.freeze([
  "modes",
  "thinkingOptionId",
  "ask",
  "models",
  "roles",
]);
// The settings in a config this build does not know (top level, and under defaults), for reporting only.
export function unknownSettings(c) {
  const top = Object.keys(c ?? {}).filter((k) => !KNOWN_SETTINGS.includes(k));
  const d =
    c?.defaults && typeof c.defaults === "object" && !Array.isArray(c.defaults)
      ? Object.keys(c.defaults)
          .filter((k) => !KNOWN_DEFAULTS.includes(k))
          .map((k) => `defaults.${k}`)
      : [];
  return [...top, ...d];
}
const text = (v, name) => {
  if (typeof v !== "string" || !v.trim() || v.length > 256) throw Error(`Invalid setting ${name}`);
};
const uuid = (v) => typeof v === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
// A missing or unusable installation setting. Callers can tell it apart from a missing record (J0-3, J0-4): the
// message names the setting and the fix, and it carries no filesystem error code.
export class NotConfigured extends Error {}
NotConfigured.prototype.name = "NotConfigured";
export function stateRoot(env = process.env) {
  const home =
    env.ORCA_HOME ?? (env.PASEO_HOME ? path.join(env.PASEO_HOME, "command-centre") : undefined);
  if (!home || !path.isAbsolute(home) || path.resolve(home) !== home)
    throw new NotConfigured(
      "Set ORCA_HOME to an absolute Command Centre state root, or set PASEO_HOME",
    );
  return home;
}
export function privateJson(file, limit = 1048576) {
  if (fs.realpathSync(file) !== file) throw Error("Canonical private file required");
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
  );
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || s.mode & 0o077 || s.size > limit)
      throw Error("Private owned bounded file required");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}
function privateRoot(home) {
  let s;
  try {
    s = fs.lstatSync(home);
  } catch (e) {
    if (e.code === "ENOENT")
      throw new NotConfigured(
        `ORCA_HOME names a folder that does not exist (${home}): create it with mode 700, or run the first-run setup (node tools/init-config.mjs)`,
      );
    throw e;
  }
  if (
    fs.realpathSync(home) !== home ||
    !s.isDirectory() ||
    s.uid !== process.getuid() ||
    s.mode & 0o077
  )
    throw Error("ORCA_HOME must be a canonical private owned directory (mode 700)");
}
// DESIGN-NEXT-BUILD A2: role-aware session defaults. The closed set of creation roles; per role an optional preferred
// provider (used only when the caller names none) and per-provider model / thinking / mode. provider-mode.mjs checks the
// values themselves (model family, thinking enum, refused and unsupported modes).
export const SESSION_ROLES = Object.freeze(["planning", "orchestration", "implementation"]);
function validateRoles(roles) {
  object(roles, SESSION_ROLES, "defaults.roles");
  for (const [role, entry] of Object.entries(roles)) {
    object(entry, ["provider", "claude", "codex"], `defaults.roles.${role}`);
    if (entry.provider !== undefined && !["claude", "codex"].includes(entry.provider))
      throw Error(`Invalid setting defaults.roles.${role}.provider`);
    for (const provider of ["claude", "codex"]) {
      if (entry[provider] === undefined) continue;
      object(
        entry[provider],
        ["model", "thinkingOptionId", "modeId"],
        `defaults.roles.${role}.${provider}`,
      );
      for (const [k, v] of Object.entries(entry[provider]))
        if (typeof v !== "string" || !v || v.length > 128)
          throw Error(`Invalid setting defaults.roles.${role}.${provider}.${k}`);
      if (
        entry[provider].thinkingOptionId !== undefined &&
        !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
          entry[provider].thinkingOptionId,
        )
      )
        throw Error(`Invalid setting defaults.roles.${role}.${provider}.thinkingOptionId`);
    }
  }
}
export function validateConfig(c) {
  open(c, "config", [
    "version",
    "daemon",
    "authority",
    "providers",
    "hosts",
    "localHost",
    "defaults",
    "artifacts",
  ]);
  if (c.version !== 2) throw Error("Invalid setting version (expected 2)");
  object(c.daemon, ["url"], "daemon", ["url"]);
  object(c.authority, ["companyId", "programmeId", "issueApi"], "authority", [
    "companyId",
    "programmeId",
    "issueApi",
  ]);
  for (const [v, name, protocols] of [
    [c.daemon.url, "daemon.url", ["ws:", "wss:"]],
    [c.authority.issueApi, "authority.issueApi", ["http:", "https:"]],
  ]) {
    if (v === null) continue;
    let u;
    try {
      u = new URL(v);
    } catch {
      throw Error(`Invalid setting ${name}`);
    }
    if (
      !protocols.includes(u.protocol) ||
      u.username ||
      u.password ||
      u.hash ||
      (name === "authority.issueApi" && u.search)
    )
      throw Error(`Invalid setting ${name}`);
  }
  for (const k of ["companyId", "programmeId"])
    if (!uuid(c.authority[k])) throw Error(`Invalid setting authority.${k}`);
  object(c.providers, ["claude", "codex"], "providers", ["claude", "codex"]);
  for (const p of ["claude", "codex"])
    if (typeof c.providers[p] !== "string" || c.providers[p].split("/")[0] !== p)
      throw Error(`Invalid setting providers.${p}`);
  const names = new Set(),
    ids = new Set();
  const host = (h, name, local = false) => {
    object(h, local ? ["name", "serverId"] : ["name", "serverId", "sshTarget"], name, [
      "name",
      "serverId",
    ]);
    text(h.name, `${name}.name`);
    if (["all", "unknown"].includes(h.name) || names.has(h.name))
      throw Error(`Duplicate or reserved setting ${name}.name`);
    names.add(h.name);
    if (
      h.serverId !== null &&
      (typeof h.serverId !== "string" ||
        !/^srv_[A-Za-z0-9_-]{8,64}$/.test(h.serverId) ||
        ids.has(h.serverId))
    )
      throw Error(`Invalid setting ${name}.serverId`);
    if (h.serverId) ids.add(h.serverId);
    if (!local && h.sshTarget !== undefined) {
      text(h.sshTarget, `${name}.sshTarget`);
      if (h.sshTarget.startsWith("-") || /\s/.test(h.sshTarget))
        throw Error(`Invalid setting ${name}.sshTarget`);
    }
  };
  host(c.localHost, "localHost", true);
  if (!Array.isArray(c.hosts) || c.hosts.length > 64) throw Error("Invalid setting hosts");
  c.hosts.forEach((h, i) => host(h, `hosts.${i}`));
  open(c.defaults, "defaults");
  for (const [key, value] of Object.entries(c.defaults)) {
    if (!KNOWN_DEFAULTS.includes(key)) continue;
    if (key === "thinkingOptionId") {
      if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value))
        throw Error("Invalid setting defaults.thinkingOptionId");
      continue;
    }
    if (key === "roles") {
      validateRoles(value);
      continue;
    }
    object(value, ["claude", "codex"], `defaults.${key}`);
    for (const [provider, setting] of Object.entries(value))
      if (
        key === "ask"
          ? !Array.isArray(setting) || setting.some((x) => typeof x !== "string")
          : typeof setting !== "string"
      )
        throw Error(`Invalid setting defaults.${key}.${provider}`);
  }
  object(c.artifacts, Object.keys(c.artifacts ?? {}), "artifacts");
  for (const [id, files] of Object.entries(c.artifacts))
    if (
      !uuid(id) ||
      !Array.isArray(files) ||
      files.some(
        (f) => typeof f !== "string" || path.isAbsolute(f) || f.split(/[\\/]/).includes(".."),
      )
    )
      throw Error("Invalid setting artifacts");
  if (c.worktreeLifecycle !== undefined) {
    object(c.worktreeLifecycle, ["retentionDays"], "worktreeLifecycle", ["retentionDays"]);
    validateRetention(c.worktreeLifecycle.retentionDays);
  }
  // Cutover: the published-outcome folder may be kept where the live installation had it (ORCA_OUTCOMES_DIR). Only outcome
  // reads use it. The reader still requires a canonical folder and regular files.
  // The shared-memory corpus may likewise be read where the installation already keeps it (memoryRoot, e.g. the
  // decisions vault) instead of a copy under <home>/memory. Validated the same way; existence and canonical form are
  // checked where it is read (portable-memory/core.mjs), so a missing folder reports itself instead of stopping startup.
  for (const key of ["outcomesRoot", "memoryRoot"]) {
    const v = c[key];
    if (
      v !== undefined &&
      (typeof v !== "string" ||
        !path.isAbsolute(v) ||
        path.normalize(v) !== v ||
        v.length > 1024 ||
        (v.endsWith("/") && v !== "/"))
    )
      throw Error(`Invalid setting ${key}`);
  }
  return c;
}
export function firstRun(env = process.env) {
  const home = stateRoot(env);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  privateRoot(home);
  const c = {
    version: 2,
    daemon: { url: null },
    authority: { companyId: randomUUID(), programmeId: randomUUID(), issueApi: null },
    providers: { claude: "claude", codex: "codex" },
    localHost: { name: "This Mac", serverId: null },
    hosts: [],
    defaults: {},
    artifacts: {},
    worktreeLifecycle: { retentionDays: "never" },
  };
  const create = (name, value) => {
    const temporary = path.join(home, `.${name}-${randomUUID()}`);
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    try {
      fs.linkSync(temporary, path.join(home, name));
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    } finally {
      fs.unlinkSync(temporary);
    }
  };
  create("config.json", c);
  create("tasks.json", { version: 1, issues: [], projects: [] });
  return loadConfig(env);
}
export function loadConfig(env = process.env) {
  const home = stateRoot(env);
  privateRoot(home);
  const c = validateConfig(privateJson(path.join(home, "config.json"), 32768));
  return Object.freeze({
    ...c,
    home,
    controller: home,
    daemonHome: home,
    memoryRoot: c.memoryRoot ?? path.join(home, "memory"),
    outcomesRoot: c.outcomesRoot ?? path.join(home, "memory"),
    tasks: path.join(home, "tasks.json"),
    url: c.daemon.url,
  });
}
export function requiredSetting(value, setting) {
  if (value === null || value === undefined || value === "")
    throw Error(`Configure ${setting} in command-centre/config.json`);
  return value;
}

function validateRetention(value) {
  if (value !== "never" && (!Number.isInteger(value) || value < 0 || value > 36500))
    throw Error("Invalid setting worktreeLifecycle.retentionDays");
  return value;
}
// Only this setting changes. Re-read the private config before the atomic write so
// provider settings, identity and all other V2 fields are preserved.
export function worktreeLifecycleSettings(env = process.env) {
  return {
    async get() {
      return loadConfig(env).worktreeLifecycle?.retentionDays ?? "never";
    },
    async set(value) {
      validateRetention(value);
      const { home } = loadConfig(env),
        file = path.join(home, "config.json");
      const config = validateConfig(privateJson(file, 32768));
      config.worktreeLifecycle = { retentionDays: value };
      const temporary = path.join(home, `.config-${randomUUID()}`);
      try {
        fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", {
          mode: 0o600,
          flag: "wx",
          flush: true,
        });
        fs.renameSync(temporary, file);
        const fd = fs.openSync(home, "r");
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
      return value;
    },
  };
}
