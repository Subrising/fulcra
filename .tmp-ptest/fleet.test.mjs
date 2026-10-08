var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target2, all) => {
  for (var name2 in all)
    __defProp(target2, name2, { get: all[name2], enumerable: true });
};

// server/config.mjs
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
function stateRoot(env = process.env) {
  const home2 = env.ORCA_HOME ?? (env.PASEO_HOME ? path.join(env.PASEO_HOME, "command-centre") : void 0);
  if (!home2 || !path.isAbsolute(home2) || path.resolve(home2) !== home2)
    throw new NotConfigured(
      "Set ORCA_HOME to an absolute Command Centre state root, or set PASEO_HOME"
    );
  return home2;
}
function privateJson(file2, limit = 1048576) {
  if (fs.realpathSync(file2) !== file2) throw Error("Canonical private file required");
  const fd = fs.openSync(
    file2,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || s.mode & 63 || s.size > limit)
      throw Error("Private owned bounded file required");
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } finally {
    fs.closeSync(fd);
  }
}
function privateRoot(home2) {
  let s;
  try {
    s = fs.lstatSync(home2);
  } catch (e) {
    if (e.code === "ENOENT")
      throw new NotConfigured(
        `ORCA_HOME names a folder that does not exist (${home2}): create it with mode 700, or run the first-run setup (node tools/init-config.mjs)`
      );
    throw e;
  }
  if (fs.realpathSync(home2) !== home2 || !s.isDirectory() || s.uid !== process.getuid() || s.mode & 63)
    throw Error("ORCA_HOME must be a canonical private owned directory (mode 700)");
}
function validateRoles(roles) {
  object(roles, SESSION_ROLES, "defaults.roles");
  for (const [role2, entry] of Object.entries(roles)) {
    object(entry, ["provider", "claude", "codex"], `defaults.roles.${role2}`);
    if (entry.provider !== void 0 && !["claude", "codex"].includes(entry.provider))
      throw Error(`Invalid setting defaults.roles.${role2}.provider`);
    for (const provider2 of ["claude", "codex"]) {
      if (entry[provider2] === void 0) continue;
      object(
        entry[provider2],
        ["model", "thinkingOptionId", "modeId"],
        `defaults.roles.${role2}.${provider2}`
      );
      for (const [k, v] of Object.entries(entry[provider2]))
        if (typeof v !== "string" || !v || v.length > 128)
          throw Error(`Invalid setting defaults.roles.${role2}.${provider2}.${k}`);
      if (entry[provider2].thinkingOptionId !== void 0 && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
        entry[provider2].thinkingOptionId
      ))
        throw Error(`Invalid setting defaults.roles.${role2}.${provider2}.thinkingOptionId`);
    }
  }
}
function validateConfig(c) {
  open(c, "config", [
    "version",
    "daemon",
    "authority",
    "providers",
    "hosts",
    "localHost",
    "defaults",
    "artifacts"
  ]);
  if (c.version !== 2) throw Error("Invalid setting version (expected 2)");
  object(c.daemon, ["url"], "daemon", ["url"]);
  object(c.authority, ["companyId", "programmeId", "issueApi"], "authority", [
    "companyId",
    "programmeId",
    "issueApi"
  ]);
  for (const [v, name2, protocols] of [
    [c.daemon.url, "daemon.url", ["ws:", "wss:"]],
    [c.authority.issueApi, "authority.issueApi", ["http:", "https:"]]
  ]) {
    if (v === null) continue;
    let u;
    try {
      u = new URL(v);
    } catch {
      throw Error(`Invalid setting ${name2}`);
    }
    if (!protocols.includes(u.protocol) || u.username || u.password || u.hash || name2 === "authority.issueApi" && u.search)
      throw Error(`Invalid setting ${name2}`);
  }
  for (const k of ["companyId", "programmeId"])
    if (!uuid(c.authority[k])) throw Error(`Invalid setting authority.${k}`);
  object(c.providers, ["claude", "codex"], "providers", ["claude", "codex"]);
  for (const p of ["claude", "codex"])
    if (typeof c.providers[p] !== "string" || c.providers[p].split("/")[0] !== p)
      throw Error(`Invalid setting providers.${p}`);
  const names = /* @__PURE__ */ new Set(), ids = /* @__PURE__ */ new Set();
  const host = (h, name2, local = false) => {
    object(h, local ? ["name", "serverId"] : ["name", "serverId", "sshTarget"], name2, [
      "name",
      "serverId"
    ]);
    text(h.name, `${name2}.name`);
    if (["all", "unknown"].includes(h.name) || names.has(h.name))
      throw Error(`Duplicate or reserved setting ${name2}.name`);
    names.add(h.name);
    if (h.serverId !== null && (typeof h.serverId !== "string" || !/^srv_[A-Za-z0-9_-]{8,64}$/.test(h.serverId) || ids.has(h.serverId)))
      throw Error(`Invalid setting ${name2}.serverId`);
    if (h.serverId) ids.add(h.serverId);
    if (!local && h.sshTarget !== void 0) {
      text(h.sshTarget, `${name2}.sshTarget`);
      if (h.sshTarget.startsWith("-") || /\s/.test(h.sshTarget))
        throw Error(`Invalid setting ${name2}.sshTarget`);
    }
  };
  host(c.localHost, "localHost", true);
  if (!Array.isArray(c.hosts) || c.hosts.length > 64) throw Error("Invalid setting hosts");
  c.hosts.forEach((h, i) => host(h, `hosts.${i}`));
  open(c.defaults, "defaults");
  for (const [key2, value] of Object.entries(c.defaults)) {
    if (!KNOWN_DEFAULTS.includes(key2)) continue;
    if (key2 === "thinkingOptionId") {
      if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value))
        throw Error("Invalid setting defaults.thinkingOptionId");
      continue;
    }
    if (key2 === "roles") {
      validateRoles(value);
      continue;
    }
    object(value, ["claude", "codex"], `defaults.${key2}`);
    for (const [provider2, setting] of Object.entries(value))
      if (key2 === "ask" ? !Array.isArray(setting) || setting.some((x) => typeof x !== "string") : typeof setting !== "string")
        throw Error(`Invalid setting defaults.${key2}.${provider2}`);
  }
  object(c.artifacts, Object.keys(c.artifacts ?? {}), "artifacts");
  for (const [id6, files] of Object.entries(c.artifacts))
    if (!uuid(id6) || !Array.isArray(files) || files.some(
      (f) => typeof f !== "string" || path.isAbsolute(f) || f.split(/[\\/]/).includes("..")
    ))
      throw Error("Invalid setting artifacts");
  if (c.worktreeLifecycle !== void 0) {
    object(
      c.worktreeLifecycle,
      ["retentionDays", "archiveFinished", "idleMinutes"],
      "worktreeLifecycle",
      ["retentionDays"]
    );
    validateRetention(c.worktreeLifecycle.retentionDays);
    validateCleanup(c.worktreeLifecycle);
  }
  for (const key2 of ["outcomesRoot", "memoryRoot"]) {
    const v = c[key2];
    if (v !== void 0 && (typeof v !== "string" || !path.isAbsolute(v) || path.normalize(v) !== v || v.length > 1024 || v.endsWith("/") && v !== "/"))
      throw Error(`Invalid setting ${key2}`);
  }
  return c;
}
function firstRun(env = process.env) {
  const home2 = stateRoot(env);
  fs.mkdirSync(home2, { recursive: true, mode: 448 });
  privateRoot(home2);
  const c = {
    version: 2,
    daemon: { url: null },
    authority: { companyId: randomUUID(), programmeId: randomUUID(), issueApi: null },
    providers: { claude: "claude", codex: "codex" },
    localHost: { name: "This Mac", serverId: null },
    hosts: [],
    defaults: {},
    artifacts: {},
    worktreeLifecycle: { retentionDays: "never" }
  };
  const create2 = (name2, value) => {
    const temporary = path.join(home2, `.${name2}-${randomUUID()}`);
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
      mode: 384,
      flag: "wx",
      flush: true
    });
    try {
      fs.linkSync(temporary, path.join(home2, name2));
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    } finally {
      fs.unlinkSync(temporary);
    }
  };
  create2("config.json", c);
  create2("tasks.json", { version: 1, issues: [], projects: [] });
  return loadConfig(env);
}
function loadConfig(env = process.env) {
  const home2 = stateRoot(env);
  privateRoot(home2);
  const c = validateConfig(privateJson(path.join(home2, "config.json"), 32768));
  return Object.freeze({
    ...c,
    home: home2,
    controller: home2,
    daemonHome: home2,
    memoryRoot: c.memoryRoot ?? path.join(home2, "memory"),
    outcomesRoot: c.outcomesRoot ?? path.join(home2, "memory"),
    tasks: path.join(home2, "tasks.json"),
    url: c.daemon.url
  });
}
function validateRetention(value) {
  if (value !== "never" && (!Number.isInteger(value) || value < 0 || value > 36500))
    throw Error("Invalid setting worktreeLifecycle.retentionDays");
  return value;
}
function validateCleanup(value) {
  if (value.archiveFinished !== void 0 && typeof value.archiveFinished !== "boolean")
    throw Error("Invalid setting worktreeLifecycle.archiveFinished");
  if (value.idleMinutes !== void 0 && value.idleMinutes !== "never" && (!Number.isSafeInteger(value.idleMinutes) || value.idleMinutes < 1 || value.idleMinutes > 10080))
    throw Error("Invalid setting worktreeLifecycle.idleMinutes");
}
var object, open, KNOWN_SETTINGS, KNOWN_DEFAULTS, text, uuid, NotConfigured, SESSION_ROLES;
var init_config = __esm({
  "server/config.mjs"() {
    "use strict";
    object = (v, keys2, name2, required = []) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) throw Error(`Invalid setting ${name2}`);
      for (const k of required) if (!Object.hasOwn(v, k)) throw Error(`Missing setting ${name2}.${k}`);
      for (const k of Object.keys(v))
        if (!keys2.includes(k)) throw Error(`Unknown setting ${name2}.${k}`);
    };
    open = (v, name2, required = []) => {
      if (!v || typeof v !== "object" || Array.isArray(v)) throw Error(`Invalid setting ${name2}`);
      for (const k of required) if (!Object.hasOwn(v, k)) throw Error(`Missing setting ${name2}.${k}`);
    };
    KNOWN_SETTINGS = Object.freeze([
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
      "memoryRoot"
    ]);
    KNOWN_DEFAULTS = Object.freeze([
      "modes",
      "thinkingOptionId",
      "ask",
      "models",
      "roles"
    ]);
    text = (v, name2) => {
      if (typeof v !== "string" || !v.trim() || v.length > 256) throw Error(`Invalid setting ${name2}`);
    };
    uuid = (v) => typeof v === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
    NotConfigured = class extends Error {
    };
    NotConfigured.prototype.name = "NotConfigured";
    SESSION_ROLES = Object.freeze(["planning", "orchestration", "implementation"]);
  }
});

// server/accounts.mjs
import fs2 from "node:fs";
import path2 from "node:path";
function accountsDir(root) {
  return path2.join(root, "accounts");
}
function file(root) {
  return path2.join(accountsDir(root), "accounts.json");
}
function readAccounts(root) {
  let raw;
  try {
    raw = fs2.readFileSync(file(root), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return empty();
    throw e;
  }
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
      PROVIDERS.map((p) => [p, typeof s.defaults?.[p] === "string" ? s.defaults[p] : null])
    )
  };
}
function accountOf(s, sessionId) {
  const x = s.assignments[sessionId];
  const a = x && s.accounts.find((y) => y.id === x.accountId);
  return a ? { id: a.id, name: a.name, provider: a.provider } : null;
}
var PROVIDERS, POLICIES, DEFAULT_LIMIT_MS, empty, SHARED;
var init_accounts = __esm({
  "server/accounts.mjs"() {
    "use strict";
    PROVIDERS = Object.freeze(["claude", "codex"]);
    POLICIES = Object.freeze(["priority", "spread"]);
    DEFAULT_LIMIT_MS = 5 * 36e5;
    empty = () => ({
      v: 1,
      policy: "priority",
      accounts: [],
      assignments: {},
      rotations: [],
      defaults: { claude: null, codex: null },
      // David's choice: a session waits for its own account's reset unless he turns moving on (it spends another account).
      rotateOnLimit: false
    });
    SHARED = Object.freeze([
      "sessions",
      "archived_sessions",
      "session_index.jsonl",
      "history.jsonl"
    ]);
  }
});

// server/portable.ts
import path3 from "node:path";
function localCatalog() {
  if (!portable) throw Error("Portable configuration required");
  const data = readPrivate(path3.join(portable.home, "tasks.json"));
  if (data.version !== 1 || !Array.isArray(data.issues) || data.issues.length > 1e3)
    throw Error("Invalid local task catalog");
  const projects = data.projects;
  if (projects === void 0) return { issues: data.issues, projects: [] };
  if (!Array.isArray(projects) || projects.length > 64)
    throw Error("Invalid local project catalog");
  const ids = /* @__PURE__ */ new Set();
  for (const row of projects) {
    const id6 = row && typeof row === "object" && !Array.isArray(row) ? row.id : null;
    if (typeof id6 !== "string" || ids.has(id6)) throw Error("Invalid local project catalog");
    ids.add(id6);
  }
  return { issues: data.issues, projects };
}
function localIssues() {
  return localCatalog().issues;
}
function localProjects() {
  return localCatalog().projects;
}
var readPrivate, portable;
var init_portable = __esm({
  "server/portable.ts"() {
    "use strict";
    init_config();
    readPrivate = privateJson;
    portable = new Proxy(
      {},
      {
        get: (_target, key2) => {
          const c = loadConfig();
          return key2 === "company" ? c.authority.companyId : key2 === "programme" ? c.authority.programmeId : c[key2];
        }
      }
    );
  }
});

// shared/plain-reason.mjs
function plainReason(text6) {
  if (typeof text6 !== "string") return text6;
  const m = REFUSAL.exec(text6);
  if (!m) return text6;
  const rest = text6.slice(m[0].length).trim();
  const what = m[1] === "permission" ? "Fulcra's safety check did not allow this permission" : "Fulcra's safety check did not let this message through";
  return rest ? `${what}: ${rest}` : `${what}.`;
}
var REFUSAL;
var init_plain_reason = __esm({
  "shared/plain-reason.mjs"() {
    "use strict";
    REFUSAL = /^(?:Request failed:\s*)?Orca native (admission|permission) refused(?::\s*|\s+)?/;
  }
});

// shared/rpc-contract.ts
import { defineRpc } from "@getpaseo/plugin";
var defineContract;
var init_rpc_contract = __esm({
  "shared/rpc-contract.ts"() {
    "use strict";
    defineContract = defineRpc;
  }
});

// shared/host-binding.ts
import { z } from "zod";
var nativeServerId, nativeHostBindings;
var init_host_binding = __esm({
  "shared/host-binding.ts"() {
    "use strict";
    nativeServerId = z.string().regex(/^srv_[A-Za-z0-9_-]{8,64}$/);
    nativeHostBindings = z.record(z.string().min(1).max(256), nativeServerId.nullable()).refine((value) => {
      const ids = Object.values(value).filter(Boolean);
      return new Set(ids).size === ids.length;
    });
  }
});

// shared/management.ts
import { z as z2 } from "zod";
var id, generation, SUPERVISOR_WORKER_ROWS_MAX, supervisorSchema, handoffSchema, managementInput, managementRpc, taskManagementRpc;
var init_management = __esm({
  "shared/management.ts"() {
    "use strict";
    init_rpc_contract();
    id = z2.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
    generation = z2.number().int().nonnegative();
    SUPERVISOR_WORKER_ROWS_MAX = 256;
    supervisorSchema = z2.object({
      id,
      task: id,
      active: z2.boolean(),
      maxWorkers: z2.number().int().min(1).max(6),
      reserved: z2.number().int().nonnegative(),
      workers: z2.array(
        z2.object({
          requestId: id,
          workerId: id.nullable(),
          phase: z2.string(),
          ownership: z2.enum(["linked", "orphaned", "unresolved"]),
          fault: z2.string().nullable(),
          creation: z2.object({
            startedAt: z2.number().int().nonnegative().nullable(),
            nativeState: z2.string().max(64).nullable(),
            generation: generation.nullable()
          }).strict().nullable().optional(),
          lastEvent: z2.object({
            kind: z2.string(),
            state: z2.string(),
            consumed: z2.boolean(),
            at: z2.string()
          }).nullable()
        }).strict()
      ).max(SUPERVISOR_WORKER_ROWS_MAX)
    }).strict();
    handoffSchema = z2.object({
      id,
      source: id,
      destination: id,
      generation,
      wakeId: id,
      context: z2.string(),
      workers: z2.array(id).max(6),
      predecessors: z2.array(z2.object({ id, state: z2.string() })),
      state: z2.string(),
      consumed: z2.string().nullable(),
      note: z2.string().nullable(),
      at: z2.string(),
      deliveryState: z2.string()
    }).strict();
    managementInput = z2.discriminatedUnion("action", [
      z2.object({
        action: z2.literal("allow-routine"),
        sessionId: id,
        generation,
        reason: z2.string().trim().min(12).max(2e3)
      }).strict(),
      z2.object({
        action: z2.literal("revoke-routine"),
        sessionId: id,
        generation,
        reason: z2.string().trim().min(12).max(2e3)
      }).strict(),
      z2.object({
        action: z2.literal("leadership"),
        sessionId: id,
        generation,
        destinationId: id,
        destinationGeneration: generation,
        messageId: id,
        context: z2.string().trim().min(12).max(8e3),
        maxWorkers: z2.number().int().min(1).max(6),
        workers: z2.array(z2.object({ sessionId: id, expectedGeneration: generation }).strict()).max(6)
      }).strict(),
      z2.object({ action: z2.literal("list") }).strict(),
      z2.object({ action: z2.literal("health") }).strict(),
      z2.object({ action: z2.literal("retry-controller") }).strict(),
      z2.object({ action: z2.literal("acknowledge"), messageId: id }).strict(),
      z2.object({ action: z2.literal("recover"), messageId: id }).strict(),
      z2.object({
        action: z2.literal("disposition"),
        messageId: id,
        reason: z2.string().trim().min(12).max(2e3)
      }).strict(),
      z2.object({ action: z2.literal("inspect"), sessionId: id }).strict(),
      z2.object({
        action: z2.literal("create"),
        projectId: id.optional(),
        messageId: id,
        provider: z2.enum(["claude", "codex"]),
        title: z2.string().trim().min(3).max(120),
        role: z2.enum(["planning", "orchestration", "implementation", "review", "research", "light"]).optional(),
        model: z2.string().trim().min(1).max(96).regex(/^[A-Za-z0-9][A-Za-z0-9._\-/[\]]*$/).optional(),
        effort: z2.enum(["low", "medium", "high", "xhigh", "max"]).optional()
      }).strict(),
      // update-7: five roles; W3: an explicit model / effort
      z2.object({
        action: z2.literal("handback"),
        sessionId: id,
        generation,
        reason: z2.string().trim().min(12).max(2e3)
      }).strict(),
      z2.object({
        action: z2.literal("supervise"),
        sessionId: id,
        generation,
        maxWorkers: z2.number().int().min(1).max(6),
        reason: z2.string().trim().min(12).max(2e3)
      }).strict(),
      z2.object({
        action: z2.literal("resume"),
        sessionId: id,
        generation,
        messageId: id,
        reason: z2.string().trim().min(12).max(2e3),
        workers: z2.array(z2.object({ sessionId: id, expectedGeneration: generation }).strict()).max(6)
      }).strict(),
      z2.object({
        action: z2.literal("takeover"),
        sessionId: id,
        reason: z2.string().trim().min(12).max(2e3)
      }).strict(),
      z2.object({
        action: z2.literal("assign"),
        sessionId: id,
        generation,
        messageId: id,
        text: z2.string().trim().min(1).max(16384)
      }).strict()
    ]);
    managementRpc = defineContract({
      name: "organization.manage",
      input: managementInput,
      output: z2.object({
        status: z2.string(),
        message: z2.string(),
        messageId: id.optional(),
        sessionId: id.optional(),
        observedAt: z2.string(),
        permissions: z2.array(
          z2.object({
            sessionId: id,
            active: z2.boolean(),
            remaining: z2.number().int().min(0).max(100),
            pool: id.nullable(),
            reason: z2.string(),
            pending: z2.number().int().nonnegative(),
            recent: z2.array(z2.object({ id, state: z2.string(), note: z2.string() }))
          })
        ).max(32).optional(),
        permissionError: z2.string().nullable().optional(),
        leadershipCapacity: z2.object({
          handoffs: z2.number().int().nonnegative(),
          deliveries: z2.number().int().nonnegative(),
          transferAllowed: z2.boolean()
        }).optional(),
        leadershipCandidates: z2.array(id).max(32).optional(),
        handoffs: z2.array(handoffSchema).max(20).optional(),
        leadershipError: z2.string().nullable().optional(),
        supervisors: z2.array(supervisorSchema).max(32).optional(),
        // U5-D04: supervisor records set aside (unreadable or a repeated id), never returned; the rest are shown.
        supervisionIssues: z2.object({
          unreadable: z2.number().int().nonnegative(),
          ids: z2.array(z2.string().max(64)).max(8),
          truncated: z2.number().int().nonnegative()
        }).strict().optional(),
        deliveries: z2.array(z2.object({ id, session: id.nullable(), kind: z2.string(), state: z2.string() })).optional(),
        sessions: z2.array(z2.object({ id, mode: z2.enum(["human", "delegated"]), generation, task: id })).optional(),
        partial: z2.boolean().optional()
      }).strict()
    });
    taskManagementRpc = defineContract({
      name: "organization.task-manage",
      input: z2.object({ taskId: id, command: managementInput }).strict(),
      output: managementRpc.output.extend({
        taskAuthority: z2.object({ allowed: z2.boolean(), error: z2.string().nullable() }).strict().optional()
      }).strict()
    });
  }
});

// shared/fleet.ts
var fleet_exports = {};
__export(fleet_exports, {
  activityRpc: () => activityRpc,
  bookActivitySchema: () => bookActivitySchema,
  fleetHostsRpc: () => fleetHostsRpc,
  fleetHostsSchema: () => fleetHostsSchema,
  fleetNode: () => fleetNode,
  fleetRpc: () => fleetRpc,
  fleetSchema: () => fleetSchema,
  quotaStatusSchema: () => quotaStatusSchema,
  quotaWaitSchema: () => quotaWaitSchema
});
import { z as z3 } from "zod";
var text2, id2, quotaWaitSchema, quotaStatusSchema, fleetNode, fleetSchema, fleetRpc, fleetHostsSchema, fleetHostsRpc, activityRpc, bookRow, bookActivitySchema;
var init_fleet = __esm({
  "shared/fleet.ts"() {
    "use strict";
    init_rpc_contract();
    init_host_binding();
    init_management();
    text2 = z3.string().max(512);
    id2 = z3.string().uuid();
    quotaWaitSchema = z3.object({
      messageId: id2,
      sessionId: id2,
      taskId: id2,
      state: z3.enum(["waiting", "checking", "attention"]),
      reason: z3.enum(["provider-limit", "model-limit", "verification"]),
      since: z3.string().datetime().nullable(),
      checkedAt: z3.string().datetime().nullable(),
      nextCheckAt: z3.string().datetime().nullable()
    }).strict();
    quotaStatusSchema = z3.object({
      version: z3.literal(1),
      observedAt: z3.string().datetime(),
      partial: z3.boolean(),
      entries: z3.array(quotaWaitSchema).max(64)
    }).strict();
    fleetNode = z3.object({
      id: id2,
      task: id2,
      host: z3.string().min(1).max(256),
      serverId: nativeServerId.nullable().optional(),
      agentId: id2.nullable(),
      title: text2,
      provider: text2,
      model: text2.nullable(),
      effort: text2.nullable().optional(),
      mode: text2,
      status: text2,
      pending: z3.number().int().nonnegative().nullable(),
      observedAt: text2.nullable(),
      updatedAt: text2.nullable(),
      error: text2.nullable(),
      quotaWait: quotaWaitSchema.nullable().optional(),
      quotaObservedAt: z3.string().datetime().nullable().optional(),
      // Display only (MULTIHOST-DESIGN §5.4): the native host's count of background jobs for a local session. Absent when none or unknown.
      backgroundWork: z3.object({ count: z3.number().int().min(1).max(999) }).strict().optional(),
      // Update-7: ownership and the account a session runs on. `parent` is the session that started it (a manager, a seat
      // holder, or a session that ran `paseo run`); `origin` "spawned" marks a session the controller did not create but a
      // session here did. `account` is the pool account of its current launch (this host's pool; null when none).
      parent: id2.nullable().optional(),
      project: id2.nullable().optional(),
      role: text2.nullable().optional(),
      origin: z3.enum(["enrolled", "spawned"]).optional(),
      // Fulcra 0.2.8 reporting lines, from the session's labels: who it reports to ("owner", "role:main-assistant", a
      // session id, or id@server) and its one direct link.
      reportsTo: z3.string().max(200).nullable().optional(),
      directLink: id2.nullable().optional(),
      account: z3.object({ name: z3.string().max(60), provider: z3.string().max(20) }).strict().nullable().optional()
    });
    fleetSchema = z3.object({
      observedAt: text2,
      hosts: z3.array(z3.string().min(1).max(256)).max(65).optional(),
      total: z3.number().int().nonnegative(),
      partial: z3.boolean(),
      matching: z3.number().int().nonnegative().optional(),
      nextOffset: z3.number().int().nonnegative().nullable().optional(),
      note: text2,
      quotaNote: text2.optional(),
      supervisors: z3.array(supervisorSchema).max(32).optional(),
      supervisionAvailable: z3.boolean().optional(),
      supervisionIssues: z3.object({
        unreadable: z3.number().int().nonnegative(),
        ids: z3.array(z3.string().max(64)).max(8),
        truncated: z3.number().int().nonnegative()
      }).strict().optional(),
      nodes: z3.array(fleetNode).max(64),
      tasks: z3.array(z3.object({ id: id2, title: text2, identifier: text2.nullable() })).max(64),
      edges: z3.array(z3.object({ from: id2, to: id2, active: z3.boolean(), state: text2, event: text2.nullable() })).max(128)
    });
    fleetRpc = defineContract({
      name: "organization.fleet",
      input: z3.object({
        search: z3.string().max(160).optional(),
        offset: z3.number().int().min(0).max(2048).optional(),
        host: z3.string().min(1).max(256).optional(),
        projectId: id2.optional()
      }).strict(),
      output: fleetSchema
    });
    fleetHostsSchema = z3.object({
      local: z3.string().min(1).max(256),
      hosts: z3.array(
        z3.object({ name: z3.string().min(1).max(256), serverId: nativeServerId.nullable() }).strict()
      ).max(65)
    }).strict();
    fleetHostsRpc = defineContract({
      name: "organization.fleet-hosts",
      input: z3.object({}).strict(),
      output: fleetHostsSchema
    });
    activityRpc = defineContract({
      name: "organization.activity",
      input: z3.object({ sessionId: id2, taskId: id2 }).strict(),
      output: z3.object({
        observedAt: text2,
        sessionId: id2,
        taskId: id2,
        note: text2,
        receipts: z3.array(
          z3.object({
            id: id2,
            kind: text2,
            state: text2,
            notification: text2.nullable(),
            evidenceHash: z3.string().regex(/^[a-f0-9]{64}$/).nullable()
          })
        ).max(20),
        activity: z3.array(
          z3.object({
            id: text2,
            kind: text2,
            label: text2,
            state: text2.nullable(),
            files: z3.array(text2).max(8)
          })
        ).max(50)
      })
    });
    bookRow = z3.object({
      id: z3.string().regex(/^\d{1,16}$/),
      kind: z3.enum(["tool_call", "user_message", "assistant_message"]),
      label: z3.string().regex(/^[A-Za-z_][\w .:-]{0,127}$/),
      state: z3.enum(["pending", "running", "completed", "failed", "cancelled", "unknown"]).nullable(),
      files: z3.array(
        z3.string().max(512).regex(/^[^\u0000-\u001f\u007f]*$/)
      ).max(1)
    }).strict().refine(
      (a) => a.kind === "tool_call" ? a.state !== null && !a.label.includes(" ") : a.state === null && !a.files.length && a.label === (a.kind === "user_message" ? "User instruction" : "Assistant response")
    );
    bookActivitySchema = z3.object({
      sessionId: id2,
      taskId: id2,
      agentId: id2,
      nativeId: id2.nullable(),
      observedAt: text2,
      hasOlder: z3.boolean(),
      skippedCount: z3.number().int().nonnegative().max(50),
      withheldPaths: z3.number().int().nonnegative().max(50),
      activity: z3.array(bookRow).max(50)
    }).strict().refine((p) => p.activity.length + p.skippedCount <= 50 && p.withheldPaths <= p.activity.length);
  }
});

// shared/roles.ts
import { z as z4 } from "zod";
var id3, note, stamp, ROLES, seatSchema, projectSession, roleNeed, membership, progress, roleDirectoryRpc, roleProjectRpc, roleAssignRpc, projectRequestSessionRpc, sessionRequest, sessionRequestsRpc, OWNERSHIP_STATE, ownershipRecord, appOwnershipRecord, roleAdoptRpc, seatAllowance, roleAllowancesRpc, roleAllowanceSetRpc, sessionOwnershipRpc, CONTROLLER_METHOD;
var init_roles = __esm({
  "shared/roles.ts"() {
    "use strict";
    init_rpc_contract();
    id3 = z4.string().uuid();
    note = z4.string().max(2e3);
    stamp = z4.string().max(64);
    ROLES = ["prime", "project-orchestrator"];
    seatSchema = z4.object({
      role: z4.enum(ROLES),
      seat: z4.string().min(1).max(64),
      projectId: id3.nullable(),
      state: z4.enum(["assigned", "vacant"]),
      revision: z4.number().int().nonnegative(),
      task: id3.nullable(),
      sessionId: id3.nullable(),
      /** Enough to route a conversation and to fence a write. No working directory, no capability. */
      session: z4.object({ id: id3, task: id3, mode: z4.string().max(32), generation: z4.number().int().min(1) }).strict().nullable(),
      note: note.nullable(),
      at: stamp.nullable(),
      membershipAt: stamp.nullable(),
      sessionPresent: z4.boolean(),
      sessionGenerationChanged: z4.boolean(),
      sessionTaskMatches: z4.boolean(),
      /** Remote seats have no dispatch path; the reason is the controller's own words. */
      dispatch: z4.object({ host: z4.string().max(32), supported: z4.boolean(), reason: note.nullable() }).strict().nullable()
    }).strict();
    projectSession = z4.object({
      sessionId: id3,
      taskId: id3,
      mode: z4.string().max(32),
      generation: z4.number().int().min(1)
    }).strict();
    roleNeed = z4.object({
      kind: z4.string().max(64),
      detail: note,
      taskId: id3.nullable(),
      sessionId: id3.nullable(),
      at: stamp.nullable()
    }).strict();
    membership = z4.object({
      known: z4.boolean(),
      available: z4.boolean(),
      partial: z4.boolean(),
      observedAt: stamp.nullable(),
      memberTaskCount: z4.number().int().nonnegative(),
      truncated: z4.boolean(),
      note
    }).strict();
    progress = z4.object({
      memberTasks: z4.number().int().nonnegative(),
      recorded: z4.number().int().nonnegative(),
      unresolved: z4.number().int().nonnegative(),
      sessions: z4.number().int().nonnegative(),
      truncated: z4.boolean(),
      basis: note
    }).strict();
    roleDirectoryRpc = defineContract({
      name: "organization.role-directory",
      input: z4.object({}).strict(),
      output: z4.object({
        observedAt: z4.string().datetime(),
        available: z4.boolean(),
        /** Present only when `available` is false; the controller's own refusal, never invented. */
        unavailable: note.nullable(),
        primes: z4.array(seatSchema).max(64),
        projectSeats: z4.array(seatSchema).max(128),
        programme: id3.nullable(),
        note
      }).strict()
    });
    roleProjectRpc = defineContract({
      name: "organization.role-project",
      input: z4.object({ projectId: id3 }).strict(),
      output: z4.object({
        observedAt: z4.string().datetime(),
        available: z4.boolean(),
        unavailable: note.nullable(),
        projectId: id3,
        /** Null when the project source could not confirm this project; not the same as no leader. */
        summary: z4.object({
          id: id3,
          name: z4.string().max(160),
          description: z4.string().max(2e3).nullable(),
          status: z4.string().max(64)
        }).strict().nullable(),
        membership: membership.nullable(),
        leader: seatSchema.nullable(),
        primes: z4.array(seatSchema).max(64),
        progress: progress.nullable(),
        needed: z4.array(roleNeed).max(64),
        blockers: z4.array(roleNeed).max(64),
        /** Sessions recorded on this project's member tasks. Membership, not ownership. */
        sessions: z4.array(projectSession).max(128),
        note
      }).strict()
    });
    roleAssignRpc = defineContract({
      name: "organization.role-assign",
      input: z4.discriminatedUnion("action", [
        z4.object({
          action: z4.literal("assign"),
          role: z4.enum(ROLES),
          seat: z4.string().min(1).max(64),
          sessionId: id3,
          expectedRevision: z4.number().int().nonnegative(),
          expectedSessionGeneration: z4.number().int().min(1),
          reason: z4.string().min(12).max(2e3)
        }).strict(),
        z4.object({
          action: z4.literal("vacate"),
          role: z4.enum(ROLES),
          seat: z4.string().min(1).max(64),
          expectedRevision: z4.number().int().min(1),
          reason: z4.string().min(12).max(2e3)
        }).strict()
      ]),
      output: z4.object({
        status: z4.enum(["assigned", "replaced", "reaffirmed", "vacated", "error"]),
        message: note,
        observedAt: z4.string().datetime(),
        role: z4.enum(ROLES).nullable(),
        seat: z4.string().max(64).nullable(),
        revision: z4.number().int().nonnegative().nullable(),
        sessionId: id3.nullable(),
        previousSessionId: id3.nullable(),
        /** Always false. A seat records accountability; it never grants authority. */
        grantsAuthority: z4.literal(false)
      }).strict()
    });
    projectRequestSessionRpc = defineContract({
      name: "organization.project-request-session",
      input: z4.object({
        /** The seat asked to do the work. A project orchestrator seat is the project UUID. */
        seat: id3,
        /** Seat revision actually observed, so a replaced or vacated seat cannot be spent. */
        expectedRevision: z4.number().int().min(1),
        taskId: id3,
        provider: z4.enum(["claude", "codex"]),
        title: z4.string().min(3).max(120),
        reason: z4.string().min(12).max(2e3)
      }).strict(),
      output: z4.object({
        /**
         * `requested` means a request row exists and the seat has been asked. `unavailable` means this
         * controller does not expose seat requests — the state on the running controller today.
         */
        status: z4.enum(["requested", "refused", "unavailable"]),
        message: note,
        observedAt: z4.string().datetime(),
        requestId: id3.nullable(),
        state: z4.string().max(32).nullable(),
        /** Always false: asking a seat for work grants the seat no authority over the result. */
        grantsAuthority: z4.literal(false)
      }).strict()
    });
    sessionRequest = z4.object({
      requestId: id3,
      seat: z4.string().max(64),
      seatRole: z4.string().max(32).nullable(),
      taskId: id3.nullable(),
      provider: z4.string().max(32).nullable(),
      title: z4.string().max(160).nullable(),
      state: z4.string().max(32),
      sessionId: id3.nullable(),
      at: stamp.nullable(),
      detail: note.nullable()
    }).strict();
    sessionRequestsRpc = defineContract({
      name: "organization.project-session-requests",
      input: z4.object({}).strict(),
      output: z4.object({
        observedAt: z4.string().datetime(),
        available: z4.boolean(),
        unavailable: note.nullable(),
        requests: z4.array(sessionRequest).max(128)
      }).strict()
    });
    OWNERSHIP_STATE = ["unknown", "recorded", "declared", "adopted", "managed"];
    ownershipRecord = z4.object({
      sessionId: id3,
      ownership: z4.enum(OWNERSHIP_STATE),
      projectId: id3.nullable(),
      seat: z4.string().max(64).nullable(),
      seatRole: z4.string().max(32).nullable(),
      declaredBy: z4.string().max(64).nullable(),
      parentSession: id3.nullable(),
      at: stamp.nullable(),
      detail: note
    }).strict();
    appOwnershipRecord = z4.object({
      /** Null when the project is not recorded, including managed workers. */
      projectId: z4.string().max(64).nullable(),
      projectName: z4.string().max(160).nullable(),
      taskId: z4.string().max(64).nullable(),
      taskTitle: z4.string().max(512).nullable(),
      /** Null for `declared`: owned by the project, led by nobody until an operator adopts it.
       *  Present for `recorded` and `adopted`, both of which name a seat. */
      leaderAgentId: z4.string().max(64).nullable(),
      leaderTitle: z4.string().max(512).nullable(),
      /**
       * `state`, not `status`: in this codebase `status` already means health or lifecycle
       * (`ProviderStatus`, `PluginListItem.status`, `lastStatus`, the workspace buckets), and reusing
       * it here invites a reader to take `unknown` as *unhealthy* rather than *not established*.
       */
      state: z4.enum(OWNERSHIP_STATE),
      /**
       * `detail`, not `reason`: the controller's sentence is valid in all states, including the
       * healthy ones. `reason` reads as "why it failed" and would discourage sending it on the very
       * path a person most wants explained. Rendered as written; the app invents no wording.
       */
      detail: z4.string().max(2e3).nullable()
    }).strict();
    roleAdoptRpc = defineContract({
      name: "organization.role-adopt",
      input: z4.object({
        seat: id3,
        /** Seat revision actually observed; the allowance is pinned to it. */
        expectedRevision: z4.number().int().min(1),
        /**
         * The **creation record** the ownership row is keyed by — not the session id. A session is
         * adopted by naming how it came into existence, which is what the ownership join uses.
         */
        request: id3,
        reason: z4.string().min(12).max(2e3)
      }).strict(),
      output: z4.object({
        status: z4.enum(["adopted", "refused", "unavailable"]),
        message: note,
        observedAt: z4.string().datetime(),
        sessionId: id3.nullable(),
        seat: z4.string().max(64).nullable(),
        /** Allowance left after this adoption, when the controller reports it. */
        remaining: z4.number().int().nonnegative().nullable(),
        grantsAuthority: z4.literal(false)
      }).strict()
    });
    seatAllowance = z4.object({
      seat: z4.string().max(64),
      role: z4.string().max(32).nullable(),
      /** The seat revision this allowance is pinned to. */
      revision: z4.number().int().nonnegative().nullable(),
      limit: z4.number().int().nonnegative().nullable(),
      used: z4.number().int().nonnegative().nullable(),
      remaining: z4.number().int().nonnegative().nullable(),
      /** False when the allowance is pinned to a revision the seat no longer has. */
      current: z4.boolean(),
      detail: note.nullable()
    }).strict();
    roleAllowancesRpc = defineContract({
      name: "organization.role-allowances",
      input: z4.object({}).strict(),
      output: z4.object({
        observedAt: z4.string().datetime(),
        available: z4.boolean(),
        unavailable: note.nullable(),
        allowances: z4.array(seatAllowance).max(128)
      }).strict()
    });
    roleAllowanceSetRpc = defineContract({
      name: "organization.role-allowance-set",
      input: z4.object({
        seat: z4.string().min(1).max(64),
        /** Required by the controller: a seat identity is (role, seat), not the slug alone. */
        role: z4.enum(ROLES),
        expectedRevision: z4.number().int().min(1),
        /** The controller's bound: 0 to 32 inclusive. */
        maxSessions: z4.number().int().min(0).max(32),
        reason: z4.string().min(12).max(2e3)
      }).strict(),
      output: z4.object({
        status: z4.enum(["granted", "refused", "unavailable"]),
        message: note,
        observedAt: z4.string().datetime(),
        seat: z4.string().max(64).nullable(),
        maxSessions: z4.number().int().nonnegative().nullable(),
        remaining: z4.number().int().nonnegative().nullable(),
        grantsAuthority: z4.literal(false)
      }).strict()
    });
    sessionOwnershipRpc = defineContract({
      // NOT "organization.sessionOwnership": @getpaseo/plugin validates method names against
      // /^[a-z][a-z0-9._-]*$/ and refuses any uppercase character at registration time. The app seam
      // must call this kebab-case name; see project-orchestrator-wiring.md.
      name: "organization.session-ownership",
      input: z4.object({ agentIds: z4.array(z4.string().max(64)).max(128) }).strict(),
      output: z4.object({ ownership: z4.record(z4.string(), appOwnershipRecord.nullable()) }).strict()
    });
    CONTROLLER_METHOD = {
      directory: "bindings-status",
      project: "bindings-project",
      assign: "bindings-assign",
      unassign: "bindings-unassign",
      requestSession: "roles-request-session",
      sessionRequests: "roles-session-requests",
      ownership: "roles-ownership",
      adopt: "roles-adopt",
      allowances: "roles-allowances",
      allowanceSet: "roles-allowance-set"
    };
  }
});

// shared/projects.ts
import { z as z5 } from "zod";
var projectSummary, projectDirectory, projectsRpc;
var init_projects = __esm({
  "shared/projects.ts"() {
    "use strict";
    init_rpc_contract();
    projectSummary = z5.object({
      id: z5.string().uuid(),
      name: z5.string().min(1).max(160),
      description: z5.string().max(2e3).nullable(),
      status: z5.string().min(1).max(64)
    });
    projectDirectory = z5.object({
      observedAt: z5.string().datetime(),
      available: z5.boolean(),
      partial: z5.boolean(),
      projects: z5.array(projectSummary).max(64),
      membership: z5.array(
        z5.object({ taskId: z5.string().uuid(), projectId: z5.string().uuid().nullable() }).strict()
      ).max(1e3),
      note: z5.string().max(512)
    }).strict();
    projectsRpc = defineContract({
      name: "organization.projects",
      input: z5.object({}).strict(),
      output: projectDirectory
    });
  }
});

// shared/tasks.ts
import { z as z6 } from "zod";
var id4, percent, usageSchema, taskCatalogRpc, usageRpc;
var init_tasks = __esm({
  "shared/tasks.ts"() {
    "use strict";
    init_rpc_contract();
    id4 = z6.string().uuid();
    percent = z6.number().finite().min(0).max(100).nullable();
    usageSchema = z6.object({
      observedAt: z6.string(),
      fetchedAt: z6.string().nullable(),
      available: z6.boolean(),
      truncated: z6.boolean(),
      providers: z6.array(
        z6.object({
          id: z6.string().max(128),
          name: z6.string().max(128),
          status: z6.enum(["available", "unavailable", "error"]),
          fetchedAt: z6.string().max(128).nullable(),
          source: z6.string().max(128).nullable(),
          error: z6.string().max(512).nullable(),
          windows: z6.array(
            z6.object({
              label: z6.string().max(128),
              used: percent,
              remaining: percent,
              resetsAt: z6.string().max(128).nullable()
            }).strict()
          ).max(16),
          balances: z6.array(
            z6.object({
              label: z6.string().max(128),
              remaining: z6.number().finite().nullable(),
              unit: z6.enum(["usd", "credits", "requests", "tokens"])
            }).strict()
          ).max(16)
        }).strict()
      ).max(16)
    }).strict();
    taskCatalogRpc = defineContract({
      name: "organization.tasks",
      input: z6.object({ cursor: z6.number().int().min(0).max(4096).default(0) }).strict(),
      output: z6.object({
        observedAt: z6.string(),
        available: z6.boolean(),
        partial: z6.boolean(),
        total: z6.number().int().nonnegative(),
        nextCursor: z6.number().int().nullable(),
        tasks: z6.array(
          z6.object({
            id: id4,
            identifier: z6.string().max(64).nullable(),
            title: z6.string().max(160),
            status: z6.string().max(64).nullable(),
            retained: z6.boolean(),
            eligibleHint: z6.boolean()
          }).strict()
        ).max(32),
        note: z6.string().max(512)
      }).strict()
    });
    usageRpc = defineContract({
      name: "organization.usage",
      input: z6.object({}).strict(),
      output: usageSchema
    });
  }
});

// shared/cc/radius-workflow.mjs
function exact(value, keys2) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value)) || Object.keys(value).some((k) => !keys2.includes(k)) || keys2.some((k) => !Object.hasOwn(value, k)))
    refuse();
}
function name(value) {
  if (typeof value !== "string" || !NAME.test(value)) refuse();
  return value;
}
function port(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) refuse();
  return value;
}
function list(value, parse, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > 16) refuse();
  const result = value.map(parse).sort((a, b) => a.id.localeCompare(b.id));
  if (new Set(result.map((v) => v.id)).size !== result.length) refuse();
  return result;
}
function resource(value) {
  exact(value, ["id", "image", "port"]);
  if (typeof value.image !== "string" || !IMAGE.test(value.image) || value.image.includes("..") || value.image.endsWith(":latest"))
    refuse();
  return { id: name(value.id), image: value.image, port: port(value.port) };
}
function requirement(value) {
  exact(value, ["id", "resourceId", "port"]);
  return { id: name(value.id), resourceId: name(value.resourceId), port: port(value.port) };
}
function draft(value) {
  exact(value, ["application", "requirements", "current", "proposed"]);
  return {
    application: name(value.application),
    requirements: list(value.requirements, requirement, 1),
    current: list(value.current, resource),
    proposed: list(value.proposed, resource, 1)
  };
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function planRadiusChange(input) {
  const definition = draft(input), old = new Map(definition.current.map((r) => [r.id, r])), next = new Map(definition.proposed.map((r) => [r.id, r]));
  const changes = [.../* @__PURE__ */ new Set([...old.keys(), ...next.keys()])].sort().flatMap((id6) => {
    const before = old.get(id6) ?? null, after2 = next.get(id6) ?? null;
    if (JSON.stringify(before) === JSON.stringify(after2)) return [];
    let kind = "update";
    if (before === null) kind = "add";
    else if (after2 === null) kind = "remove";
    return [{ id: id6, kind, before, after: after2 }];
  });
  return freeze({
    target: RADIUS_TARGET,
    definition,
    revision: JSON.stringify(definition),
    changes
  });
}
function validateRadiusPlan(plan, expectedRevision) {
  exact(plan, ["target", "definition", "revision", "changes"]);
  const rebuilt = planRadiusChange(plan.definition);
  if (plan.target !== RADIUS_TARGET || plan.revision !== expectedRevision || JSON.stringify(plan) !== JSON.stringify(rebuilt))
    refuse();
  const requirements = rebuilt.definition.requirements.map((r) => ({
    id: r.id,
    state: rebuilt.definition.proposed.some((v) => v.id === r.resourceId && v.port === r.port) ? "pass" : "fail"
  }));
  return freeze({
    kind: requirements.every((r) => r.state === "pass") ? "valid" : "blocked",
    requirements,
    basis: "local-structural-validation",
    nativeCompilation: "not_run",
    environmentDeployment: "held"
  });
}
var RADIUS_TARGET, NAME, IMAGE, refuse;
var init_radius_workflow = __esm({
  "shared/cc/radius-workflow.mjs"() {
    "use strict";
    RADIUS_TARGET = "0.61.x";
    NAME = /^[a-z][a-z0-9-]{0,39}$/;
    IMAGE = /^[a-z0-9][a-z0-9./_-]{0,180}(?::[A-Za-z0-9_.-]{1,40}|@sha256:[a-f0-9]{64})$/;
    refuse = () => {
      throw new Error("Radius scratch input is invalid or exceeds its limits.");
    };
  }
});

// shared/cc/refs.mjs
function parseRef(value) {
  if (typeof value !== "string" || value.length > REF_MAX) return null;
  const kind = kindOf(value);
  if (!kind || !REF_PATTERNS[kind].test(value)) return null;
  const body = value.slice(kind.length + 1);
  switch (kind) {
    case "seat":
      return { kind, seat: body };
    case "turn": {
      const slash = body.indexOf("/");
      return { kind, sessionId: body.slice(0, slash), turnId: body.slice(slash + 1) };
    }
    case "repo":
      return { kind, repoKey: body };
    case "commit": {
      const g = split(body, `@(?<sha>${SHA40})`);
      return { kind, repoKey: g.repoKey, sha: g.sha };
    }
    case "pr": {
      const g = split(body, "#(?<n>[1-9][0-9]{0,9})");
      return { kind, repoKey: g.repoKey, number: Number(g.n) };
    }
    case "file": {
      const g = split(body, `:(?<path>${REL_PATH})`);
      return { kind, repoKey: g.repoKey, path: g.path };
    }
    case "archmap": {
      const g = split(body, `@(?<sha>${SHA40}):(?<map>[A-Za-z0-9][A-Za-z0-9._-]{0,63})`);
      return { kind, repoKey: g.repoKey, sha: g.sha, mapName: g.map };
    }
    case "issue": {
      const g = new RegExp(
        `^(?<connector>${CONNECTOR})(?:@(?<site>${SITE}))?:(?<remoteId>[A-Za-z0-9._-]{1,64}):(?<ref>[A-Za-z0-9-]{1,32})$`
      ).exec(body).groups;
      return {
        kind,
        connector: g.connector,
        site: g.site ?? null,
        remoteId: g.remoteId,
        ref: g.ref
      };
    }
    case "brief": {
      const at2 = body.indexOf("@");
      return { kind, projectId: body.slice(0, at2), revision: Number(body.slice(at2 + 1)) };
    }
    default:
      return { kind, id: body };
  }
}
function personalMatch(text6) {
  if (typeof text6 !== "string") return null;
  for (const [what, re] of PERSONAL) if (re.test(text6)) return what;
  return null;
}
var UUID, SLUG, SHA40, CONNECTOR, LABEL, SITE, SEGMENT, REMOTE_PATH, REPO_KEY, REL_SEGMENT, REL_PATH, ISSUE, BODIES, REF_KINDS, REF_MAX, REF_PATTERNS, kindOf, split, PERSONAL, PERSONAL_PATTERNS, noPersonal, JARGON, escape, JARGON_RE, CODE_EXT, TECHNICAL;
var init_refs = __esm({
  "shared/cc/refs.mjs"() {
    "use strict";
    UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
    SLUG = "[a-z0-9][a-z0-9-]{0,63}";
    SHA40 = "[0-9a-f]{40}";
    CONNECTOR = "(?!local(?:[@:]|$))[a-z][a-z0-9-]{1,31}";
    LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
    SITE = `${LABEL}(?:\\.${LABEL})*`;
    SEGMENT = "(?!\\.\\.?(?:/|$|[:@#]))[A-Za-z0-9._-]{1,100}";
    REMOTE_PATH = `${SEGMENT}(?:/${SEGMENT}){0,7}`;
    REPO_KEY = `(?:local:${UUID}/${SLUG}|${CONNECTOR}(?:@${SITE})?:${REMOTE_PATH})`;
    REL_SEGMENT = "(?!\\.\\.?(?:/|$))[^/\\\\\\u0000-\\u001f\\u007f]{1,255}";
    REL_PATH = `${REL_SEGMENT}(?:/${REL_SEGMENT}){0,31}`;
    ISSUE = `${CONNECTOR}(?:@${SITE})?:[A-Za-z0-9._-]{1,64}:[A-Za-z0-9-]{1,32}`;
    BODIES = {
      project: UUID,
      task: UUID,
      session: UUID,
      seat: SLUG,
      turn: `${UUID}/[A-Za-z0-9._:-]{1,128}`,
      repo: REPO_KEY,
      commit: `${REPO_KEY}@${SHA40}`,
      pr: `${REPO_KEY}#[1-9][0-9]{0,9}`,
      issue: ISSUE,
      file: `${REPO_KEY}:${REL_PATH}`,
      decision: UUID,
      brief: `${UUID}@[1-9][0-9]{0,9}`,
      env: UUID,
      deploy: UUID,
      promotion: UUID,
      archmap: `${REPO_KEY}@${SHA40}:[A-Za-z0-9][A-Za-z0-9._-]{0,63}`,
      outcome: UUID
    };
    REF_KINDS = Object.freeze(Object.keys(BODIES));
    REF_MAX = 300;
    REF_PATTERNS = Object.freeze(
      Object.fromEntries(REF_KINDS.map((kind) => [kind, new RegExp(`^${kind}:${BODIES[kind]}$`)]))
    );
    kindOf = (value) => {
      const kind = value.slice(0, value.indexOf(":"));
      return Object.hasOwn(REF_PATTERNS, kind) ? kind : null;
    };
    split = (body, tail) => new RegExp(`^(?<repoKey>${REPO_KEY})${tail}$`).exec(body)?.groups;
    PERSONAL = Object.freeze(
      [
        ["a home or volume path", /\/Users\/|\/Volumes\/|\/home\/|~\//],
        // v1.9: a whole hostname only. "config.local.json" and "notes.example.md" are file names, not hosts.
        [
          "a private host name",
          /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:ts\.net|local)(?![a-z0-9-]|\.[a-z0-9])/i
        ],
        ["an email address", /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/i],
        ["a secret token", /(?<![A-Za-z0-9])(ghp_|gho_|github_pat_|sk-|xox[bp]-)[A-Za-z0-9_-]{8,}/]
      ].map(([what, re]) => Object.freeze([what, re]))
    );
    PERSONAL_PATTERNS = Object.freeze(
      PERSONAL.map(([name2, re]) => Object.freeze({ name: name2, re }))
    );
    noPersonal = (text6) => personalMatch(text6) === null;
    JARGON = Object.freeze([
      "IR",
      "RPC",
      "journal",
      "seat generation",
      "digest",
      "webhook",
      "OAuth",
      "PKCE",
      "Kubernetes",
      "recipe",
      "schema",
      "worktree",
      "idempotent",
      "blast radius"
    ]);
    escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    JARGON_RE = JARGON.map((term) => [
      term,
      term === term.toUpperCase() ? new RegExp(`(?<![A-Za-z0-9])${escape(term)}s?(?![A-Za-z0-9])`) : new RegExp(`(?<![A-Za-z0-9])${escape(term).replace(/ /g, "\\s+")}s?(?![A-Za-z0-9])`, "i")
    ]);
    CODE_EXT = "(?:m?js|cjs|jsx?|tsx?|json|py|sh|ya?ml|toml|sql|md)";
    TECHNICAL = [
      ["an id", /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
      // A commit or content hash: 7-64 hex characters with at least one digit and one letter, so words and plain
      // numbers are not mistaken for one. Never a block of a hyphenated uuid, which is reported as an id.
      [
        "a hash",
        /(?<![A-Za-z0-9-])(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,64}(?![A-Za-z0-9-])/i
      ],
      // A path: rooted, relative or home-relative, or segments with a file at the end. "and/or" and "24/7" are fine.
      [
        "a file path",
        new RegExp(
          `(?:^|(?<=[\\s("']))(?:~|\\.{1,2})?/[\\w.-]+(?:/[\\w.-]*)*|[\\w.-]+(?:/[\\w.-]+)+\\.${CODE_EXT}\\b|(?<![\\w.-])[a-z0-9][\\w-]*\\.${CODE_EXT}(?![\\w-])`
        )
      ],
      [
        "code formatting",
        /`[^`]+`|\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(\)|\b[a-z][a-z0-9]*_[a-z0-9_]+\b/
      ]
    ];
  }
});

// shared/cc/decision-rules.mjs
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value))
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
var KINDS, STATES, REVERSIBILITY, CONFIDENCE, APP_VIA, VIA, LIMITS, ASK_FIELDS, isObject;
var init_decision_rules = __esm({
  "shared/cc/decision-rules.mjs"() {
    "use strict";
    init_refs();
    KINDS = Object.freeze(["decision", "approval", "question"]);
    STATES = Object.freeze(["open", "chosen", "withdrawn", "superseded", "expired"]);
    REVERSIBILITY = Object.freeze([
      "reversible",
      "reversible-with-effort",
      "irreversible"
    ]);
    CONFIDENCE = Object.freeze(["low", "medium", "high"]);
    APP_VIA = Object.freeze([
      "app-mac",
      "app-ios",
      "app-android",
      "app-windows",
      "app-linux",
      "app-web"
    ]);
    VIA = Object.freeze([
      "app-mac",
      "app-ios",
      "app-android",
      "app-windows",
      "app-linux",
      "app-web",
      "discord-openclaw",
      "session",
      "cli"
    ]);
    LIMITS = Object.freeze({
      title: 120,
      situation: 600,
      optionTitle: 80,
      optionSummary: 400,
      example: 300,
      benefit: 300,
      cost: 200,
      time: 120,
      risk: 300,
      why: 400,
      wouldChangeIf: 300,
      evidence: 16,
      evidenceLabel: 120,
      note: 500,
      options: 3,
      situationSentences: 3,
      summarySentences: 2
    });
    ASK_FIELDS = Object.freeze([
      "kind",
      "level",
      "projectId",
      "taskId",
      "askedOf",
      "title",
      "situation",
      "options",
      "recommendation",
      "evidence",
      "action",
      "expiresAt"
    ]);
    isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
  }
});

// shared/tracker-refs.mjs
function validMapping(m) {
  if (!m || typeof m !== "object" || !TRACKERS.includes(m.tracker)) return false;
  const r = RULES[m.tracker];
  return AUTH[m.tracker].includes(m.auth) && str(m.site) && r.site(m.site) && str(m.remoteId) && r.remoteId.test(m.remoteId) && str(m.remoteName) && r.remoteName(m.remoteName);
}
var TRACKERS, AUTH, JIRA_KEY, RULES, str;
var init_tracker_refs = __esm({
  "shared/tracker-refs.mjs"() {
    "use strict";
    TRACKERS = Object.freeze(["github", "jira", "bitbucket"]);
    AUTH = Object.freeze({
      github: Object.freeze(["keychain", "gh-cli"]),
      jira: Object.freeze(["keychain"]),
      bitbucket: Object.freeze(["keychain"])
    });
    JIRA_KEY = /^[A-Z][A-Z0-9_]{1,9}$/;
    RULES = {
      github: {
        site: (s) => s === "github.com",
        remoteId: /^[1-9][0-9]{0,11}$/,
        remoteName: (n) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(n) && ![".", ".."].includes(n.split("/")[1]),
        itemRef: (ref2) => /^[1-9][0-9]{0,9}$/.test(ref2)
      },
      jira: {
        site: (s) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.atlassian\.net$/.test(s),
        remoteId: /^[1-9][0-9]{0,11}$/,
        remoteName: (n) => JIRA_KEY.test(n),
        // An issue key must belong to the mapped project key: ORCA-12 under ORCA, never OTHER-12.
        itemRef: (ref2, name2) => typeof name2 === "string" && ref2.startsWith(name2 + "-") && /^[1-9][0-9]{0,9}$/.test(ref2.slice(name2.length + 1))
      },
      bitbucket: {
        site: (s) => s === "bitbucket.org",
        remoteId: /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/,
        remoteName: (n) => /^[a-z0-9][a-z0-9_-]{0,61}\/[a-z0-9._-]{1,62}$/.test(n) && ![".", ".."].includes(n.split("/")[1]),
        itemRef: (ref2) => /^[1-9][0-9]{0,9}$/.test(ref2)
      }
    };
    str = (v) => typeof v === "string";
  }
});

// shared/history.mjs
var exact2, epoch, seq, validCursor;
var init_history = __esm({
  "shared/history.mjs"() {
    "use strict";
    exact2 = (v, keys2) => v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join() === keys2;
    epoch = (s) => typeof s === "string" && s.length > 0 && s.length <= 256 && !/[\uD800-\uDFFF]/u.test(s) && !Array.from(s).some((c) => c.codePointAt(0) < 32 || c.codePointAt(0) === 127);
    seq = (n) => Number.isSafeInteger(n) && n >= 0;
    validCursor = (c) => exact2(c, "epoch,scope,seq") && typeof c.scope === "string" && /^[a-f0-9]{64}$/.test(c.scope) && epoch(c.epoch) && seq(c.seq);
  }
});

// shared/cc/environment-rules.mjs
function relpath(v, where = "script") {
  if (typeof v !== "string" || !v || v.length > 255)
    refuse2(`${where} must be a file path inside the repository`);
  if (v.startsWith("/") || v.includes("\\") || v.startsWith("~"))
    refuse2(`${where} must be relative to the repository, not an absolute path`);
  const parts = v.split("/");
  if (parts.some((p) => p === "." || p === "..")) refuse2(`${where} may not leave the repository`);
  if (!parts.every((p) => SEGMENT2.test(p)))
    refuse2(`${where} must be a plain file path inside the repository`);
  return v;
}
function step(v, where) {
  exactKeys(v, ["script", "args", "timeoutS", "destructive"], where);
  if (typeof v.destructive !== "boolean") refuse2(`${where}.destructive must be true or false`);
  return {
    script: relpath(v.script, `${where}.script`),
    args: args(v.args, `${where}.args`),
    timeoutS: int(v.timeoutS, 1, LIMITS2.stepTimeout, `${where}.timeoutS`),
    destructive: v.destructive
  };
}
function check(v, where) {
  if (!plainObject(v)) refuse2(`${where} must be an object`);
  if (v.kind === "manual") {
    exactKeys(v, ["kind"], where);
    return { kind: "manual" };
  }
  if (v.kind !== "script") refuse2(`${where}.kind must be script or manual`);
  exactKeys(v, ["kind", "script", "args", "timeoutS"], where);
  return {
    kind: "script",
    script: relpath(v.script, `${where}.script`),
    args: args(v.args, `${where}.args`),
    timeoutS: int(v.timeoutS, 1, LIMITS2.checkTimeout, `${where}.timeoutS`)
  };
}
function target(v) {
  if (!plainObject(v)) refuse2("target must be an object");
  if (v.kind === "fulcra-host") {
    exactKeys(v, ["kind", "hostId"], "target");
    if (typeof v.hostId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v.hostId))
      refuse2("target.hostId must be a Fulcra host id");
    return { kind: "fulcra-host", hostId: v.hostId };
  }
  if (v.kind !== "external") refuse2("target.kind must be fulcra-host or external");
  exactKeys(v, ["kind", "label", "site"], "target");
  const site = v.site === null ? null : typeof v.site === "string" && v.site.length <= LIMITS2.site && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
    v.site
  ) && noPersonal(v.site) ? v.site : refuse2("target.site must be a public host name or null");
  return { kind: "external", label: text3(v.label, LIMITS2.targetLabel, "target.label"), site };
}
function validateDefinition(d) {
  exactKeys(d, DEFINITION_KEYS, "environment");
  if (typeof d.key !== "string" || !KEY.test(d.key))
    refuse2("key must be a short lowercase name such as next");
  if (!Array.isArray(d.requirements) || d.requirements.length > LIMITS2.requirements)
    refuse2(`requirements must be a list of at most ${LIMITS2.requirements}`);
  const requirements = d.requirements.map((r, i) => {
    exactKeys(r, ["id", "label", "check"], `requirements[${i}]`);
    if (typeof r.id !== "string" || !KEY.test(r.id))
      refuse2(`requirements[${i}].id must be a short lowercase name`);
    return {
      id: r.id,
      label: text3(r.label, LIMITS2.requirementLabel, `requirements[${i}].label`),
      check: check(r.check, `requirements[${i}].check`)
    };
  });
  if (new Set(requirements.map((r) => r.id)).size !== requirements.length)
    refuse2("requirement ids must be unique");
  exactKeys(d.steps, STEP_NAMES, "steps");
  if (!ENVIRONMENT_STATES.includes(d.state)) refuse2("state must be active or retired");
  return {
    key: d.key,
    label: text3(d.label, LIMITS2.label, "label"),
    order: int(d.order, 0, 9, "order"),
    target: target(d.target),
    repo: repoKey(d.repo),
    requirements,
    steps: {
      deploy: step(d.steps.deploy, "steps.deploy"),
      verify: step(d.steps.verify, "steps.verify"),
      rollback: step(d.steps.rollback, "steps.rollback")
    },
    state: d.state
  };
}
var KEY, LIMITS2, ENVIRONMENT_STATES, PROMOTION_STATES, DEPLOYMENT_STATUS, STEP_NAMES, FINISHED, EnvironmentRefused, refuse2, plainObject, exactKeys, text3, int, SEGMENT2, args, repoKey, DEFINITION_KEYS;
var init_environment_rules = __esm({
  "shared/cc/environment-rules.mjs"() {
    "use strict";
    init_refs();
    KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
    LIMITS2 = Object.freeze({
      label: 40,
      targetLabel: 80,
      site: 253,
      hostId: 64,
      requirements: 32,
      requirementLabel: 120,
      args: 8,
      arg: 120,
      checkTimeout: 600,
      stepTimeout: 3600,
      detail: 300,
      impact: 8,
      readiness: 32,
      rollbackPlan: 600,
      log: 200,
      logLine: 300,
      deploymentNote: 300,
      tag: 64
    });
    ENVIRONMENT_STATES = Object.freeze(["active", "retired"]);
    PROMOTION_STATES = Object.freeze([
      "proposed",
      "awaiting-approval",
      "approved",
      "running",
      "verifying",
      "succeeded",
      "failed",
      "rolling-back",
      "rolled-back",
      "cancelled"
    ]);
    DEPLOYMENT_STATUS = Object.freeze(["succeeded", "failed", "rolled-back", "unknown"]);
    STEP_NAMES = Object.freeze(["deploy", "verify", "rollback"]);
    FINISHED = Object.freeze(["succeeded", "failed", "rolled-back", "cancelled"]);
    EnvironmentRefused = class extends Error {
    };
    refuse2 = (message) => {
      throw new EnvironmentRefused(message);
    };
    plainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    exactKeys = (v, keys2, where) => {
      if (!plainObject(v)) refuse2(`${where} must be an object`);
      const extra = Object.keys(v).filter((k) => !keys2.includes(k));
      if (extra.length) refuse2(`${where} has unknown fields: ${extra.join(", ")}`);
    };
    text3 = (v, max, where, { empty: empty2 = false } = {}) => {
      if (typeof v !== "string" || v.length > max || !empty2 && !v.trim())
        refuse2(`${where} must be text of at most ${max} characters`);
      if (!noPersonal(v)) refuse2(`${where} contains a personal path, host name, email or token`);
      return v;
    };
    int = (v, min, max, where) => {
      if (!Number.isInteger(v) || v < min || v > max)
        refuse2(`${where} must be a whole number from ${min} to ${max}`);
      return v;
    };
    SEGMENT2 = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
    args = (v, where) => {
      if (!Array.isArray(v) || v.length > LIMITS2.args)
        refuse2(`${where} must be a list of at most ${LIMITS2.args} arguments`);
      return v.map((a, i) => text3(a, LIMITS2.arg, `${where}[${i}]`, { empty: true }));
    };
    repoKey = (v) => typeof v === "string" && parseRef(`repo:${v}`)?.kind === "repo" && noPersonal(v) ? v : refuse2("repo must be a repository key such as github:acme/app");
    DEFINITION_KEYS = Object.freeze([
      "key",
      "label",
      "order",
      "target",
      "repo",
      "requirements",
      "steps",
      "state"
    ]);
  }
});

// shared/cc/remit-rules.mjs
function remitScope(scope2) {
  if (keys(scope2, "kind,projectId") && scope2.kind === "project" && typeof scope2.projectId === "string" && UUID2.test(scope2.projectId))
    return { kind: "project", projectId: scope2.projectId };
  if (keys(scope2, "domain,kind,label") && scope2.kind === "domain" && typeof scope2.domain === "string" && KEY2.test(scope2.domain) && typeof scope2.label === "string" && scope2.label.trim() && scope2.label.length <= REMIT_LIMITS.label) {
    const personal = personalMatch(scope2.label);
    if (personal) throw new RemitRefused(`The area name contains ${personal}`);
    return { kind: "domain", domain: scope2.domain, label: scope2.label.trim() };
  }
  throw new RemitRefused("A remit covers one project, or one named area of work");
}
var KEY2, UUID2, REMIT_STATES, REMIT_ACTIONS, REMIT_LIMITS, RemitRefused, keys;
var init_remit_rules = __esm({
  "shared/cc/remit-rules.mjs"() {
    "use strict";
    init_refs();
    KEY2 = /^[a-z0-9][a-z0-9-]{0,63}$/;
    UUID2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    REMIT_STATES = Object.freeze(["active", "ended"]);
    REMIT_ACTIONS = Object.freeze(["assigned", "moved", "ended", "domain-set"]);
    REMIT_LIMITS = Object.freeze({ noteMin: 12, note: 500, label: 80 });
    RemitRefused = class extends Error {
    };
    keys = (a, names) => a && typeof a === "object" && !Array.isArray(a) && Object.keys(a).sort().join() === names;
  }
});

// shared/cc/connector-rules.mjs
function itemProblem(it) {
  if (!it || typeof it !== "object") return "not an object";
  const k = parseRef(it.key)?.kind;
  if (k !== "issue" && k !== "pr") return "key";
  if (typeof it.connector !== "string" || !CONNECTOR_ID.test(it.connector)) return "connector";
  if (!ITEM_KINDS.includes(it.kind) || it.kind === "pr" !== (k === "pr")) return "kind";
  if (!str2(it.ref, 40) || !str2(it.title, 256, 0) || !ITEM_STATES.includes(it.state) || !https(it.url))
    return "fields";
  if (typeof it.updatedAt !== "string" || Number.isNaN(Date.parse(it.updatedAt)))
    return "updatedAt";
  if (it.assignee !== null && !str2(it.assignee, 80)) return "assignee";
  if (!Array.isArray(it.labels) || it.labels.length > 8 || !it.labels.every((l) => str2(l, 50)))
    return "labels";
  if (!noPersonal(it.title) || !noPersonal(it.url) || it.assignee !== null && !noPersonal(it.assignee) || !it.labels.every((l) => noPersonal(l)))
    return "personal data";
  const extra = Object.keys(it).filter(
    (key2) => ![
      "key",
      "connector",
      "kind",
      "ref",
      "title",
      "state",
      "url",
      "updatedAt",
      "assignee",
      "labels"
    ].includes(key2)
  );
  return extra.length ? "unknown keys" : null;
}
function mappingProblem(m) {
  if (!m || typeof m !== "object") return "Invalid tracker mapping";
  if (typeof m.connector !== "string" || !CONNECTOR_ID.test(m.connector)) return "Unknown tracker";
  if (m.accountId === null ? m.connector !== "github" : !(typeof m.accountId === "string" && UUID3.test(m.accountId)))
    return "Choose a connected account";
  if (!str2(m.remoteId, 64) || !/^[A-Za-z0-9._{}/-]+$/.test(m.remoteId))
    return "Invalid tracker project id";
  if (!str2(m.remoteName, 200) || !noPersonal(m.remoteName)) return "Invalid tracker project name";
  if (m.site !== null && !(typeof m.site === "string" && HOSTNAME.test(m.site)))
    return "Invalid site";
  if (typeof m.note !== "string" || m.note.length > 500 || !noPersonal(m.note))
    return "The note must be short and contain no personal data";
  return null;
}
var CONNECTOR_ID, AUTH_METHODS, ITEM_KINDS, ITEM_STATES, HEALTH, MAPPING_STATES, HOSTNAME, UUID3, str2, https;
var init_connector_rules = __esm({
  "shared/cc/connector-rules.mjs"() {
    "use strict";
    init_refs();
    CONNECTOR_ID = /^[a-z][a-z0-9-]{1,31}$/;
    AUTH_METHODS = Object.freeze(["browser", "device", "token", "cli"]);
    ITEM_KINDS = Object.freeze(["issue", "ticket", "pr"]);
    ITEM_STATES = Object.freeze(["open", "in-progress", "closed", "merged", "unknown"]);
    HEALTH = Object.freeze([
      "ok",
      "auth-required",
      "expired",
      "forbidden",
      "rate-limited",
      "offline"
    ]);
    MAPPING_STATES = Object.freeze(["mapped", "unmapped"]);
    HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
    UUID3 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    str2 = (v, max, min = 1) => typeof v === "string" && v.length >= min && v.length <= max;
    https = (v) => {
      try {
        const u = new URL(v);
        return u.protocol === "https:" && !u.username && !u.password;
      } catch {
        return false;
      }
    };
  }
});

// shared/cc/link-rules.mjs
function pairProblem(from, relation, to) {
  const f = parseRef(from), t = parseRef(to);
  if (!f || !t) return "That link names something Fulcra cannot identify";
  if (!Object.hasOwn(ALLOWED_PAIRS, relation)) return NOT_ALLOWED;
  const [froms, tos] = ALLOWED_PAIRS[relation];
  if (!froms.includes(f.kind) || !tos.includes(t.kind)) return NOT_ALLOWED;
  if (from === to) return NOT_ALLOWED;
  return null;
}
function evidenceProblem(evidence) {
  if (typeof evidence !== "string" || !evidence.trim() || evidence.length > EVIDENCE_MAX)
    return "Evidence must be a short sentence";
  if (!noPersonal(evidence)) return "Evidence contains personal or host-specific data";
  return null;
}
var RELATIONS, PROVENANCE, CONFIDENCE2, LINK_STATES, EVIDENCE_MAX, ALLOWED_PAIRS, NOT_ALLOWED;
var init_link_rules = __esm({
  "shared/cc/link-rules.mjs"() {
    "use strict";
    init_refs();
    RELATIONS = Object.freeze([
      "worked-by",
      "produced",
      "fixes",
      "implements",
      "reviewed-by",
      "deployed",
      "decided-by",
      "supersedes"
    ]);
    PROVENANCE = Object.freeze(["manual", "reported", "inferred"]);
    CONFIDENCE2 = Object.freeze(["high", "medium", "low"]);
    LINK_STATES = Object.freeze(["active", "removed"]);
    EVIDENCE_MAX = 300;
    ALLOWED_PAIRS = Object.freeze({
      "worked-by": [
        ["issue", "pr"],
        ["session", "task"]
      ],
      produced: [
        ["session", "task"],
        ["commit", "pr", "archmap", "deploy"]
      ],
      fixes: [["pr"], ["issue"]],
      implements: [
        ["pr", "commit"],
        ["decision", "task"]
      ],
      "reviewed-by": [["pr", "commit", "task"], ["session"]],
      deployed: [["deploy"], ["commit"]],
      "decided-by": [["task", "promotion", "env"], ["decision"]],
      supersedes: [["session"], ["session"]]
    });
    NOT_ALLOWED = "That kind of link is not allowed";
  }
});

// shared/command-parser.mjs
function methods(names, schema) {
  for (const name2 of names.split(" ")) {
    if (Object.hasOwn(schemas, name2)) throw Error("Duplicate command schema");
    schemas[name2] = schema;
  }
}
function dataOnly(value, seen = /* @__PURE__ */ new Set(), depth = 0) {
  if (depth > 32 || seen.has(value)) fail();
  if (value === null || ["string", "boolean"].includes(typeof value) || typeof value === "number" && Number.isFinite(value))
    return value;
  if (!value || typeof value !== "object" || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value)))
    fail();
  seen.add(value);
  const result = Array.isArray(value) ? [] : /* @__PURE__ */ Object.create(null);
  for (const key2 of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key2 === "length") continue;
    if (typeof key2 !== "string" || ["__proto__", "prototype", "constructor"].includes(key2)) fail();
    const descriptor = Object.getOwnPropertyDescriptor(value, key2);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail();
    result[key2] = dataOnly(descriptor.value, seen, depth + 1);
  }
  seen.delete(value);
  return result;
}
function parseControllerCommand(value) {
  value = dataOnly(value);
  if (new TextEncoder().encode(JSON.stringify(value)).length > 32768) fail();
  const command = object2({ method: str3(100), input: opt((v) => v) })(value);
  if (!Object.hasOwn(schemas, command.method)) throw Error("Unknown controller method");
  const input = schemas[command.method](command.input);
  return Object.freeze({ method: command.method, ...input === void 0 ? {} : { input } });
}
var fail, check2, str3, num, one, opt, nullable, either, array, object2, refinement, uuid2, stamp2, bool, none, ref, revision, generation2, reason, note2, key, primeSeat, role, seat, provider, text4, common, change, worker, workers, defaults, sessionRole, create, resume, leadership, signature, device, proof, signed, scope, channel, choice, choiceProof, link, validLink, seatCommand, roleChange, schemas, OWNED_CHANNEL_METHODS, NATIVE_OWNER_STATUS_METHODS, NATIVE_OWNER_METHODS, radiusPlan, radiusInput, reportIdentity, reportScopes, projectChanges, lineRef, MANAGEMENT_METHODS, READ_METHODS;
var init_command_parser = __esm({
  "shared/command-parser.mjs"() {
    "use strict";
    init_radius_workflow();
    init_decision_rules();
    init_tracker_refs();
    init_history();
    init_refs();
    init_environment_rules();
    init_remit_rules();
    init_connector_rules();
    init_link_rules();
    fail = () => {
      throw Error("Invalid controller command input");
    };
    check2 = (predicate) => (value) => {
      if (!predicate(value)) fail();
      return value;
    };
    str3 = (max, min = 1) => check2(
      (v) => typeof v === "string" && v.isWellFormed() && v.trim().length >= min && v.length <= max
    );
    num = (min = 0, max = Number.MAX_SAFE_INTEGER - 1) => check2((v) => Number.isSafeInteger(v) && v >= min && v <= max);
    one = (...values) => check2((v) => values.includes(v));
    opt = (schema) => Object.assign((v) => v === void 0 ? void 0 : schema(v), { optional: true });
    nullable = (schema) => (v) => v === null ? null : schema(v);
    either = (...schemas2) => (value) => {
      for (const schema of schemas2) {
        try {
          return schema(value);
        } catch {
        }
      }
      fail();
    };
    array = (schema, max, min = 0) => (v) => {
      if (!Array.isArray(v) || v.length < min || v.length > max) fail();
      return v.map(schema);
    };
    object2 = (shape) => (v) => {
      if (!v || typeof v !== "object" || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v)))
        fail();
      if (Object.keys(v).some((k) => !Object.hasOwn(shape, k))) fail();
      const result = {};
      for (const [k, schema] of Object.entries(shape)) {
        if (!Object.hasOwn(v, k) && !schema.optional) fail();
        if (Object.hasOwn(v, k)) result[k] = schema(v[k]);
      }
      return result;
    };
    refinement = (schema, predicate) => (v) => {
      const result = schema(v);
      if (!predicate(result)) fail();
      return result;
    };
    uuid2 = check2(
      (v) => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v)
    );
    stamp2 = check2(
      (v) => typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v))
    );
    bool = check2((v) => typeof v === "boolean");
    none = check2((v) => v == null);
    ref = check2((v) => typeof v === "string" && !!parseRef(v));
    revision = num();
    generation2 = num(1);
    reason = str3(2e3, 12);
    note2 = str3(500, 0);
    key = check2((v) => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(v));
    primeSeat = check2(
      (v) => typeof v === "string" && /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(v)
    );
    role = one("prime", "project-orchestrator");
    seat = either(uuid2, primeSeat);
    provider = one("claude", "codex");
    text4 = refinement(str3(16384), (v) => new TextEncoder().encode(v).length <= 16384);
    common = { sessionId: uuid2, expectedGeneration: generation2 };
    change = { expectedRevision: revision, note: note2 };
    worker = object2(common);
    workers = array(worker, 6);
    defaults = object2({
      modeId: opt(str3(64)),
      thinkingOptionId: opt(one("off", "minimal", "low", "medium", "high", "xhigh", "max")),
      model: opt(str3(200)),
      ask: opt(
        nullable(
          array(
            check2((v) => typeof v === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(v)),
            64
          )
        )
      )
    });
    sessionRole = one(
      "planning",
      "orchestration",
      "implementation",
      "review",
      "research",
      "light"
    );
    create = {
      messageId: uuid2,
      taskId: uuid2,
      provider: opt(provider),
      title: str3(120, 3),
      host: opt(str3(120)),
      defaults: opt(defaults),
      projectId: opt(uuid2),
      role: opt(sessionRole)
    };
    resume = { ...common, messageId: uuid2, reason, workers };
    leadership = {
      ...common,
      messageId: uuid2,
      destinationId: uuid2,
      destinationGeneration: generation2,
      maxWorkers: num(1, 6),
      context: str3(8e3, 12),
      workers
    };
    signature = check2(
      (v) => typeof v === "string" && v.length <= 200 && /^[A-Za-z0-9+/]+={0,2}$/.test(v)
    );
    device = object2({
      label: str3(80),
      platform: one("macos", "ios", "android", "windows", "linux"),
      publicKey: str3(400),
      keyStorage: one(
        "secure-enclave",
        "keychain-biometric",
        "android-keystore",
        "os-protected",
        "software"
      ),
      userPresence: bool
    });
    proof = (payload) => object2({ alg: one("ES256"), deviceId: uuid2, payload, signature });
    signed = { messageId: uuid2, at: stamp2 };
    scope = object2({
      canAnswer: bool,
      levels: array(one(1, 2, 3), 3, 1),
      projects: either(one("all"), array(uuid2, 64))
    });
    channel = { kind: one("discord-openclaw", "session", "cli"), label: str3(80), scope };
    choice = {
      confirmDestructive: bool,
      expectedRevision: generation2,
      id: uuid2,
      messageId: uuid2,
      note: note2,
      optionId: str3(64)
    };
    choiceProof = proof(
      object2({
        ...signed,
        confirmDestructive: bool,
        decisionId: uuid2,
        digest: check2((v) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)),
        note: note2,
        optionId: str3(64),
        revision: generation2
      })
    );
    link = {
      from: ref,
      relation: one(
        "worked-by",
        "produced",
        "fixes",
        "implements",
        "reviewed-by",
        "deployed",
        "decided-by",
        "supersedes"
      ),
      to: ref,
      evidence: nullable(str3(300, 0))
    };
    validLink = (shape) => refinement(
      object2(shape),
      (a) => !pairProblem(a.from, a.relation, a.to) && !evidenceProblem(a.evidence)
    );
    seatCommand = (shape) => refinement(object2(shape), (a) => {
      try {
        (a.role === "prime" ? primeSeat : uuid2)(a.seat);
        return !a.manager || a.role === "project-orchestrator";
      } catch {
        return false;
      }
    });
    roleChange = { expectedRevision: revision, note: reason };
    schemas = /* @__PURE__ */ Object.create(null);
    OWNED_CHANNEL_METHODS = Object.freeze([
      "controller-status",
      "controller-retry",
      "health"
    ]);
    methods(OWNED_CHANNEL_METHODS.join(" "), none);
    NATIVE_OWNER_STATUS_METHODS = Object.freeze([
      "intercom-receipt-maintenance",
      "intercom-rate-settings-get"
    ]);
    NATIVE_OWNER_METHODS = Object.freeze([
      ...NATIVE_OWNER_STATUS_METHODS,
      "radius-scratch-simulate",
      "radius-scratch-prune-and-simulate",
      "report-prime-register",
      "report-prime-promote",
      "report-prime-demote",
      "report-project-transfer",
      "report-parent-adopt",
      "report-registration-revoke",
      "intercom-rate-settings-set",
      "intercom-status",
      "report-inbox-owner-read",
      "evidence-index-owner-read",
      "artifact-tool-owner-set",
      "artifact-content-owner-set",
      "artifact-content-owner-list",
      "artifact-content-owner-read",
      "managed-artifact-index-owner-read"
    ]);
    methods(NATIVE_OWNER_STATUS_METHODS.join(" "), none);
    methods(
      "intercom-rate-settings-set",
      object2({
        messageId: uuid2,
        settings: object2({
          report: num(0, 12),
          followup: num(0, 64),
          channel: num(0, 64),
          seat: num(0, 32)
        })
      })
    );
    methods("intercom-status", object2({ agentId: uuid2 }));
    radiusPlan = (value) => {
      const rebuilt = planRadiusChange(value?.definition);
      if (canonicalJson(value) !== canonicalJson(rebuilt)) fail();
      validateRadiusPlan(rebuilt, value?.revision);
      return rebuilt;
    };
    radiusInput = { attemptId: uuid2, plan: radiusPlan, expectedRevision: str3(16384) };
    methods(
      "radius-scratch-simulate",
      refinement(object2(radiusInput), (input) => input.expectedRevision === input.plan.revision)
    );
    methods(
      "radius-scratch-prune-and-simulate",
      refinement(
        object2({ ...radiusInput, confirmDestructive: one(true) }),
        (input) => input.expectedRevision === input.plan.revision
      )
    );
    reportIdentity = object2({ agentId: uuid2, instanceId: uuid2, sessionId: str3(200), boot: uuid2 });
    methods(
      "artifact-content-owner-list",
      object2({
        identity: reportIdentity,
        expectedEpoch: uuid2,
        scope: object2({ projectId: uuid2, taskId: uuid2 })
      })
    );
    methods(
      "artifact-content-owner-set",
      object2({
        messageId: uuid2,
        grantId: uuid2,
        identity: reportIdentity,
        expectedEpoch: uuid2,
        scope: object2({ projectId: uuid2, taskId: uuid2 }),
        artifactIds: array(uuid2, 24, 1),
        byteBudget: num(1, 131072),
        expiresAt: num(),
        expectedGrantRevision: nullable(uuid2),
        enabled: one(true, false)
      })
    );
    methods(
      "artifact-content-owner-read",
      object2({
        requestId: uuid2,
        grantId: uuid2,
        grantRevision: uuid2,
        artifactId: uuid2,
        identity: reportIdentity,
        expectedEpoch: uuid2,
        scope: object2({ projectId: uuid2, taskId: uuid2 }),
        offset: num(),
        length: num(1, 8192)
      })
    );
    methods(
      "artifact-tool-owner-set",
      object2({
        messageId: uuid2,
        identity: reportIdentity,
        expectedEpoch: uuid2,
        scope: object2({ projectId: uuid2, taskId: uuid2 }),
        enabled: one(true, false),
        expiresAt: num()
      })
    );
    methods(
      "report-inbox-owner-read evidence-index-owner-read managed-artifact-index-owner-read",
      object2({
        identity: reportIdentity,
        expectedEpoch: uuid2,
        scope: object2({ projectId: uuid2, taskId: uuid2 })
      })
    );
    reportScopes = array(object2({ projectId: uuid2, taskId: uuid2 }), 16, 1);
    methods(
      "report-prime-register",
      object2({
        messageId: uuid2,
        identity: reportIdentity,
        scopes: reportScopes,
        expectedEpoch: nullable(uuid2)
      })
    );
    projectChanges = array(object2({ projectId: uuid2, expectedOwnerEpoch: nullable(uuid2) }), 16);
    methods(
      "report-prime-promote",
      object2({
        messageId: uuid2,
        identity: reportIdentity,
        expectedEpoch: nullable(uuid2),
        scopes: reportScopes,
        projects: projectChanges
      })
    );
    methods(
      "report-prime-demote",
      object2({
        messageId: uuid2,
        identity: reportIdentity,
        expectedEpoch: uuid2,
        parent: reportIdentity,
        expectedParentEpoch: uuid2,
        projects: projectChanges
      })
    );
    methods(
      "report-project-transfer",
      object2({
        messageId: uuid2,
        projectId: uuid2,
        from: nullable(reportIdentity),
        expectedFromEpoch: nullable(uuid2),
        to: reportIdentity,
        expectedToEpoch: uuid2,
        expectedOwnerEpoch: nullable(uuid2)
      })
    );
    methods(
      "report-parent-adopt",
      object2({
        messageId: uuid2,
        child: reportIdentity,
        parent: reportIdentity,
        scopes: reportScopes,
        expectedEpoch: nullable(uuid2)
      })
    );
    methods(
      "report-registration-revoke",
      object2({ messageId: uuid2, identity: reportIdentity, expectedEpoch: uuid2 })
    );
    methods(
      "bindings-activation bindings-status recovery-status wakes-status channels-status channels-requests roles-session-requests roles-allowances trackers-status trackers-directory cc-tracker-legacy-pending decisions-inbox decisions-digest-run cc-channels-list devices-list devices-pair-open remits-list manager-summary events-status list task-index quota-status leadership-status permissions-status",
      none
    );
    methods(
      "bindings-project roles-ownership trackers-project trackers-history cc-link-history cc-tracker-mapping-history task-authority history management-ack recover observe",
      uuid2
    );
    methods("task-allowance", uuid2);
    methods(
      "bindings-assign",
      seatCommand({
        ...roleChange,
        expectedSessionGeneration: generation2,
        role,
        seat,
        sessionId: uuid2,
        manager: opt(object2({ maxWorkers: num(1, 6), reason }))
      })
    );
    methods(
      "bindings-unassign",
      seatCommand({ ...roleChange, expectedRevision: generation2, role, seat })
    );
    methods(
      "seat-unhold",
      object2({ ...roleChange, expectedRevision: generation2, role: one("prime"), seat: primeSeat })
    );
    methods("bindings-route", seatCommand({ role, seat }));
    methods("seat-inbox", object2({ role: one("prime"), seat: primeSeat }));
    methods("bindings-grant sessions-refresh-tools", object2(common));
    methods("sessions-tool-surface", object2({ sessionId: uuid2 }));
    methods(
      "seat-hold",
      object2({
        ...roleChange,
        expectedRevision: generation2,
        expectedSessionGeneration: generation2,
        role: one("prime"),
        seat: primeSeat
      })
    );
    methods("seat-receipt", object2({ channelId: uuid2, messageId: uuid2, note: str3(2e3, 8) }));
    methods(
      "seat-reply",
      object2({
        channelId: uuid2,
        expectedHolderGeneration: generation2,
        expectedSeatRevision: generation2,
        inReplyTo: uuid2,
        messageId: uuid2,
        text: text4
      })
    );
    methods("seat-reply-reconcile disposition", object2({ messageId: uuid2, reason }));
    methods(
      "channels-open",
      object2({
        expectedPrimeRevision: generation2,
        expectedProjectRevision: generation2,
        expiresAt: stamp2,
        maxMessages: num(1, 64),
        primeSeat,
        projectSeat: uuid2,
        purpose: reason
      })
    );
    methods("channels-close", object2({ channelId: uuid2, note: reason }));
    methods("channels-request-decline", object2({ note: reason, requestId: uuid2 }));
    methods(
      "worktree-lifecycle-settings",
      object2({
        archiveFinished: opt(bool),
        idleMinutes: opt(either(one("never"), num(1, 10080))),
        retentionDays: opt(either(one("never"), num(0, 36500)))
      })
    );
    methods(
      "worktree-lifecycle-now",
      either(
        object2({ requestId: uuid2 }),
        either(object2({ previewId: uuid2, requestId: uuid2 }), object2({ operationId: uuid2 }))
      )
    );
    methods("worktree-lifecycle-preview", either(none, object2({ operationId: opt(uuid2) })));
    methods("worktree-lifecycle-apply", object2({ confirm: one(true), planId: uuid2 }));
    methods(
      "worktree-lifecycle-retention",
      object2({ retentionDays: either(one("never"), num(0, 36500)) })
    );
    methods("session-defaults", either(none, object2({ claude: opt(defaults), codex: opt(defaults) })));
    methods(
      "roles-request-session",
      object2({ ...roleChange, provider, seat: uuid2, taskId: uuid2, title: str3(120, 3) })
    );
    methods("roles-adopt", object2({ ...roleChange, request: uuid2, seat: uuid2 }));
    methods("team-enrol", object2({ note: reason, sessionId: uuid2, taskId: uuid2 }));
    methods(
      "team-project-create",
      object2({ description: opt(nullable(str3(2e3))), name: str3(160), note: reason })
    );
    methods("team-project-anchor team-project-archive", object2({ note: reason, projectId: uuid2 }));
    methods("team-history", either(none, object2({ limit: num(1, 200) })));
    lineRef = check2(
      (v) => typeof v === "string" && /^(owner|role:main-assistant|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(@[A-Za-z0-9._:-]{1,120})?)$/.test(
        v
      )
    );
    methods(
      "team-line",
      refinement(
        object2({
          directLink: opt(either(one(""), uuid2)),
          note: reason,
          reportsTo: opt(either(one(""), lineRef)),
          seat: opt(one("", "main-assistant")),
          sessionId: uuid2
        }),
        (v) => v.reportsTo !== void 0 || v.seat !== void 0 || v.directLink !== void 0
      )
    );
    methods("roles-allowance-set", seatCommand({ ...roleChange, maxSessions: num(0, 32), role, seat }));
    methods(
      "trackers-map",
      refinement(
        object2({
          ...change,
          auth: one("keychain", "gh-cli"),
          project: uuid2,
          remoteId: str3(256),
          remoteName: str3(256),
          site: str3(253),
          tracker: one("github", "jira", "bitbucket"),
          validatedAt: stamp2
        }),
        validMapping
      )
    );
    methods("trackers-unmap", object2({ ...change, expectedRevision: generation2, project: uuid2 }));
    methods(
      "trackers-link",
      object2({
        expectedMappingRevision: generation2,
        itemRef: str3(256),
        project: uuid2,
        subject: object2({ kind: one("session", "task"), id: uuid2 })
      })
    );
    methods("trackers-unlink", object2({ expectedRevision: generation2, link: uuid2 }));
    methods("trackers-links-for", object2({ subjects: array(uuid2, 64) }));
    methods(
      "cc-tracker-map",
      refinement(
        object2({
          ...change,
          accountId: nullable(uuid2),
          connector: key,
          messageId: uuid2,
          projectId: uuid2,
          remoteId: str3(256),
          remoteName: str3(256),
          site: nullable(str3(253))
        }),
        (a) => !mappingProblem(a)
      )
    );
    methods(
      "cc-tracker-unmap",
      object2({ ...change, expectedRevision: generation2, id: uuid2, messageId: uuid2 })
    );
    methods("cc-tracker-mappings", either(none, object2({ projectId: uuid2 })));
    methods(
      "cc-tracker-import-legacy",
      object2({ accountId: nullable(uuid2), messageId: uuid2, projectId: uuid2 })
    );
    methods(
      "cc-tracker-items-put",
      object2({
        items: array(
          check2((v) => !itemProblem(v)),
          200
        ),
        mappingId: uuid2,
        observedAt: stamp2,
        observation: opt(object2({ id: uuid2, partial: bool, final: bool }))
      })
    );
    methods("cc-tracker-items environments-view briefs-read", object2({ projectId: uuid2 }));
    methods("cc-links-set", validLink({ ...link, expectedRevision: revision, messageId: uuid2 }));
    methods("cc-links-remove", object2({ expectedRevision: generation2, id: uuid2, messageId: uuid2 }));
    methods(
      "cc-links-observe",
      object2({
        messageId: uuid2,
        links: array(
          validLink({
            ...link,
            provenance: one("reported", "inferred"),
            confidence: one("high", "medium", "low")
          }),
          500
        )
      })
    );
    methods("cc-links-for", object2({ refs: array(ref, 128), includeRemoved: opt(bool) }));
    methods("decisions-get decisions-digest", object2({ id: uuid2 }));
    methods(
      "decisions-record-review",
      object2({
        workspace: str3(1024),
        repo: str3(140),
        number: num(1, 2147483647),
        headSha: check2((v) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v)),
        choice: one("approve", "request_changes", "comment"),
        note: note2,
        projectId: opt(nullable(uuid2)),
        via: opt(one("app-mac", "app-ios", "app-android", "app-windows", "app-linux", "app-web"))
      })
    );
    methods(
      "decisions-choose",
      object2({
        ...choice,
        via: opt(one("app-mac", "app-ios", "app-android", "app-windows", "app-linux", "app-web")),
        proof: opt(choiceProof)
      })
    );
    methods("decisions-held-message", object2({ channelId: uuid2, messageId: uuid2 }));
    methods(
      "environments-propose",
      object2({
        messageId: uuid2,
        projectId: uuid2,
        environmentId: nullable(uuid2),
        expectedRevision: revision,
        definition: validateDefinition,
        note: note2
      })
    );
    methods(
      "promotions-create",
      object2({
        messageId: uuid2,
        projectId: uuid2,
        from: uuid2,
        to: uuid2,
        commit: ref,
        expectedRevision: revision
      })
    );
    methods(
      "promotions-cancel",
      object2({ messageId: uuid2, id: uuid2, expectedRevision: revision, note: note2 })
    );
    methods(
      "devices-pair-complete",
      object2({
        payload: object2({
          ...signed,
          purpose: one("fulcra.device.pair"),
          windowId: uuid2,
          code: check2((v) => typeof v === "string" && /^\d{6}$/.test(v)),
          device
        }),
        signature
      })
    );
    methods(
      "devices-pair-approve",
      object2({
        approval: proof(object2({ ...signed, purpose: one("fulcra.device.approve"), device })),
        device,
        signature
      })
    );
    methods(
      "devices-revoke",
      object2({
        proof: proof(object2({ ...signed, purpose: one("fulcra.device.revoke"), deviceId: uuid2 }))
      })
    );
    methods(
      "cc-channel-pair-open",
      object2({
        ...channel,
        proof: opt(proof(object2({ ...signed, ...channel, purpose: one("fulcra.channel.pair-open") })))
      })
    );
    methods(
      "cc-channel-pause cc-channel-resume cc-channel-revoke",
      object2({ id: uuid2, expectedRevision: generation2 })
    );
    methods(
      "remits-assign",
      object2({ ...change, note: str3(500, 12), messageId: uuid2, primeSeat: key, scope: remitScope })
    );
    methods(
      "remits-move",
      object2({ ...change, note: str3(500, 12), messageId: uuid2, remitId: uuid2, toPrimeSeat: key })
    );
    methods("remits-end", object2({ ...change, note: str3(500, 12), messageId: uuid2, remitId: uuid2 }));
    methods(
      "remits-domain-set",
      object2({
        ...change,
        note: str3(500, 12),
        messageId: uuid2,
        projectId: uuid2,
        domain: nullable(key)
      })
    );
    methods("manager-promote", object2({ ...common, maxWorkers: num(1, 6), reason }));
    methods(
      "manager-grant",
      object2({ ...common, maxWorkers: num(1, 6), reason, capability: str3(512) })
    );
    methods("manager-resume", object2(resume));
    methods("leadership-transfer", object2(leadership));
    methods(
      "events-attach",
      object2({ capability: str3(512), reason, supervisorId: uuid2, workerId: uuid2 })
    );
    methods("events-resume", object2({ reason, workerId: uuid2 }));
    methods("operator-send", object2({ ...common, messageId: uuid2, text: text4 }));
    methods("operator-native-queue", object2({ ...common, messageId: uuid2, text: text4 }));
    methods("create", object2(create));
    methods("takeover reestablish", object2({ sessionId: uuid2, reason }));
    methods("handback", object2({ sessionId: uuid2, reason, expectedGeneration: opt(generation2) }));
    methods("permissions-grant permissions-revoke", object2({ ...common, reason }));
    methods("session-takeover", object2({ session: uuid2, accountId: uuid2, reason: opt(one("manual")) }));
    methods(
      "session-resume",
      object2({
        ...common,
        interruptionId: uuid2,
        messageId: uuid2,
        reason,
        continuation: opt(str3(4e3, 0))
      })
    );
    methods(
      "session-resume-batch",
      object2({
        items: array(object2({ ...common, interruptionId: uuid2 }), 8, 1),
        messageId: uuid2,
        reason
      })
    );
    methods("session-interruption-dismiss", object2({ interruptionId: uuid2, reason }));
    methods("session-fresh-start", object2({ messageId: uuid2, sessionId: uuid2, reason }));
    methods("wakes-heartbeat-set", object2({ minutes: num(0, 1440), note: reason }));
    methods(
      "task-allowance-set",
      object2({
        expectedRevision: revision,
        maxInstructions: nullable(num(0, 1e3)),
        reason,
        taskId: uuid2
      })
    );
    methods("operator-artifacts", object2({ ...common, taskId: uuid2 }));
    methods("activity-receipts", object2({ sessionId: uuid2, taskId: uuid2 }));
    methods("book-activity", object2({ sessionId: uuid2, taskId: uuid2 }));
    methods(
      "book-activity-page",
      object2({
        sessionId: uuid2,
        taskId: uuid2,
        cursor: nullable(check2(validCursor)),
        includeMessages: opt(one(true))
      })
    );
    methods("management-prepare", (value) => {
      const a = object2({
        kind: one("create", "send", "resume", "leadership"),
        messageId: uuid2,
        body: check2((v) => v && typeof v === "object" && !Array.isArray(v))
      })(value);
      const shape = { create, send: { ...common, messageId: uuid2, text: text4 }, resume, leadership }[a.kind];
      const { messageId: _, ...body } = shape;
      return { ...a, body: object2(body)(a.body) };
    });
    MANAGEMENT_METHODS = Object.freeze(Object.keys(schemas));
    READ_METHODS = Object.freeze([
      "team-history",
      "worktree-lifecycle-preview",
      "controller-status",
      "health",
      "bindings-activation",
      "bindings-status",
      "bindings-project",
      "bindings-route",
      "sessions-tool-surface",
      "seat-inbox",
      "recovery-status",
      "wakes-status",
      "channels-status",
      "channels-requests",
      "session-defaults",
      "roles-session-requests",
      "roles-allowances",
      "roles-ownership",
      "trackers-project",
      "trackers-links-for",
      "trackers-status",
      "trackers-history",
      "trackers-directory",
      "cc-tracker-mappings",
      "cc-tracker-legacy-pending",
      "cc-tracker-items",
      "cc-tracker-mapping-history",
      "cc-links-for",
      "cc-link-history",
      "decisions-inbox",
      "environments-view",
      "decisions-get",
      "cc-channels-list",
      "devices-list",
      "decisions-held-message",
      "decisions-digest",
      "remits-list",
      "briefs-read",
      "manager-summary",
      "events-status",
      "list",
      "task-index",
      "task-authority",
      "history",
      "book-activity",
      "book-activity-page",
      "activity-receipts",
      "quota-status",
      "task-allowance",
      "permissions-status",
      "leadership-status",
      "operator-artifacts"
    ]);
  }
});

// server/management-context.mjs
var management_context_exports = {};
__export(management_context_exports, {
  ManagementUnavailableError: () => ManagementUnavailableError,
  currentManagement: () => currentManagement,
  invocationReadOnly: () => invocationReadOnly,
  invokeManagement: () => invokeManagement,
  isReadCommand: () => isReadCommand,
  withManagementInvocation: () => withManagementInvocation
});
import { AsyncLocalStorage } from "node:async_hooks";
function withManagementInvocation(context, readOnly, run) {
  if (typeof context?.management?.invoke !== "function") throw new ManagementUnavailableError();
  const invocation = { management: context?.management, readOnly, active: true };
  return invocations.run(invocation, async () => {
    try {
      return await run();
    } finally {
      invocation.active = false;
      invocation.management = void 0;
    }
  });
}
function invokeManagement(method, input) {
  const invocation = invocations.getStore();
  if (!invocation?.active || invocation.readOnly && !READ_METHODS.includes(method) || typeof invocation.management?.invoke !== "function")
    throw new ManagementUnavailableError();
  const command = parseControllerCommand({ method, ...input === void 0 ? {} : { input } });
  return invocation.management.invoke({
    ...command,
    input: command.input === void 0 ? null : command.input
  });
}
function currentManagement() {
  const invocation = invocations.getStore();
  return invocation?.active ? invocation.management : void 0;
}
var invocations, ManagementUnavailableError, isReadCommand, invocationReadOnly;
var init_management_context = __esm({
  "server/management-context.mjs"() {
    "use strict";
    init_command_parser();
    invocations = new AsyncLocalStorage();
    ManagementUnavailableError = class extends Error {
      constructor() {
        super("Management unavailable");
        this.name = "ManagementUnavailableError";
        this.code = "management_unavailable";
      }
    };
    isReadCommand = (method) => READ_METHODS.includes(method);
    invocationReadOnly = (declared, context) => declared === true || context?.management?.readOnly === true;
  }
});

// server/installation.ts
var init_installation = __esm({
  "server/installation.ts"() {
    "use strict";
    init_config();
  }
});

// server/supervisors.ts
function readSupervisors(value, limit = 32) {
  const issues = { unreadable: 0, ids: [], truncated: 0 };
  if (!Array.isArray(value)) return { available: false, supervisors: [], issues };
  const seen = /* @__PURE__ */ new Set(), supervisors = [];
  for (const entry of value) {
    const parsed = supervisorSchema.safeParse(entry);
    if (!parsed.success || seen.has(parsed.data.id)) {
      issues.unreadable += 1;
      const id6 = entry?.id;
      if (typeof id6 === "string" && UUID4.test(id6) && issues.ids.length < 8 && !issues.ids.includes(id6))
        issues.ids.push(id6);
      continue;
    }
    seen.add(parsed.data.id);
    if (supervisors.length < limit) supervisors.push(parsed.data);
    else issues.truncated += 1;
  }
  return { available: true, supervisors, issues };
}
var UUID4;
var init_supervisors = __esm({
  "server/supervisors.ts"() {
    "use strict";
    init_management();
    UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  }
});

// server/management.ts
function localCall(method, input) {
  return Promise.resolve(invokeManagement(method, input));
}
var TASK;
var init_management2 = __esm({
  "server/management.ts"() {
    "use strict";
    init_management_context();
    init_portable();
    init_installation();
    init_supervisors();
    init_management();
    TASK = portable.programme;
  }
});

// server/tasks.ts
function eligibleHint(id6, issues) {
  const seen = /* @__PURE__ */ new Set();
  for (let depth = 0; depth < 8; depth++) {
    if (seen.has(id6)) return false;
    seen.add(id6);
    const row = issues.get(id6);
    if (!row || row.companyId !== COMPANY || row.assigneeUserId !== "local-board" || row.assigneeAgentId || !["todo", "in_progress"].includes(row.status))
      return false;
    if (id6 === PROGRAMME) return true;
    if (!uuid3(row.parentId)) return false;
    id6 = row.parentId;
  }
  return false;
}
async function readIssues(fetcher = fetch) {
  if (portable.authority.issueApi === null) return localIssues();
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 4e3);
  try {
    const response = await fetcher(
      `${portable.authority.issueApi}/api/companies/${COMPANY}/issues`,
      { redirect: "error", signal: abort.signal }
    );
    if (!response.ok || !response.body) throw new Error("Task board unavailable");
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      for (; ; ) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1048576) throw new Error("Task list exceeds limit");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => void 0);
    }
    const rows = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(rows)) throw new Error("Invalid task list");
    return rows;
  } finally {
    clearTimeout(timer);
  }
}
function projectTasks(raw, index, boardAvailable) {
  const issues = /* @__PURE__ */ new Map(), duplicates = /* @__PURE__ */ new Set();
  let partial = index.partial || raw.length > 1e3;
  for (const item of raw.slice(0, 1e3)) {
    const r = item;
    if (!r || !uuid3(r.id) || r.companyId !== COMPANY || typeof r.title !== "string" || typeof r.status !== "string") {
      partial = true;
      continue;
    }
    if (issues.has(r.id) || duplicates.has(r.id)) {
      partial = true;
      duplicates.add(r.id);
      issues.delete(r.id);
      continue;
    }
    issues.set(r.id, r);
  }
  const retained = new Set(index.taskIds.filter(uuid3));
  const ids = [
    .../* @__PURE__ */ new Set([
      PROGRAMME,
      ...retained,
      ...[...issues.keys()].filter((id6) => eligibleHint(id6, issues))
    ])
  ];
  ids.sort(
    (a, b) => a === PROGRAMME ? -1 : b === PROGRAMME ? 1 : Number(retained.has(b)) - Number(retained.has(a)) || a.localeCompare(b)
  );
  return {
    observedAt: (/* @__PURE__ */ new Date()).toISOString(),
    available: true,
    partial,
    tasks: ids.map((id6) => {
      const r = issues.get(id6);
      return {
        id: id6,
        identifier: typeof r?.identifier === "string" ? r.identifier.slice(0, 64) : null,
        title: r?.title.slice(0, 160) ?? "Retained task",
        status: r?.status.slice(0, 64) ?? null,
        retained: retained.has(id6),
        eligibleHint: boardAvailable && eligibleHint(id6, issues)
      };
    }),
    note: boardAvailable ? "Selecting a task does not give Fulcra control. Fulcra checks who controls it before each action." : "Task board unavailable. Retained work remains visible for inspection and human control."
  };
}
async function readTaskCatalog(read = readIssues, call = localCall) {
  const [board, journal] = await Promise.allSettled([read(), call("task-index")]);
  if (journal.status !== "fulfilled" || !journal.value || !Array.isArray(journal.value.taskIds) || journal.value.taskIds.length > 2048 || journal.value.taskIds.some((id6) => !uuid3(id6)) || typeof journal.value.partial !== "boolean")
    throw new Error("Retained task index unavailable; task coverage cannot be established");
  return projectTasks(
    board.status === "fulfilled" ? board.value : [],
    journal.value,
    board.status === "fulfilled"
  );
}
var COMPANY, PROGRAMME, uuid3;
var init_tasks2 = __esm({
  "server/tasks.ts"() {
    "use strict";
    init_portable();
    init_tasks();
    init_management2();
    COMPANY = portable.company;
    PROGRAMME = portable.programme;
    uuid3 = (value) => typeof value === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
  }
});

// server/projects.ts
import { z as z7 } from "zod";
function isArchivedProject(raw) {
  if (!raw || typeof raw !== "object") return false;
  const row = raw;
  return row.archivedAt !== void 0 && row.archivedAt !== null || row.status === "archived";
}
function localProjectDirectory(read, readProjectRows = null) {
  const observedAt = (/* @__PURE__ */ new Date()).toISOString();
  try {
    const rows = read();
    if (!Array.isArray(rows) || rows.length > 1e3)
      throw new Error("Local task coverage exceeds bound");
    let partial = false;
    const known = /* @__PURE__ */ new Map(), archived = /* @__PURE__ */ new Set();
    if (readProjectRows) {
      const projectRows = readProjectRows();
      if (!Array.isArray(projectRows) || projectRows.length > 64)
        throw new Error("Local project coverage exceeds bound");
      for (const id6 of archivedIds(projectRows)) archived.add(id6);
      const seen = /* @__PURE__ */ new Set();
      for (const raw of projectRows.filter((r) => !isArchivedProject(r))) {
        const parsed = project.safeParse(raw);
        if (!parsed.success) {
          partial = true;
          continue;
        }
        if (seen.has(parsed.data.id)) {
          partial = true;
          known.delete(parsed.data.id);
          continue;
        }
        seen.add(parsed.data.id);
        known.set(parsed.data.id, parsed.data);
      }
    }
    const tasks = /* @__PURE__ */ new Map(), dropped = /* @__PURE__ */ new Set();
    for (const raw of rows) {
      const parsed = localTask.safeParse(raw);
      if (!parsed.success) {
        partial = true;
        continue;
      }
      const { id: id6, projectId } = parsed.data;
      if (tasks.has(id6) || dropped.has(id6)) {
        partial = true;
        dropped.add(id6);
        tasks.delete(id6);
        continue;
      }
      if (projectId != null && known.has(projectId)) tasks.set(id6, projectId);
      else {
        if (projectId != null && !archived.has(projectId)) partial = true;
        tasks.set(id6, null);
      }
    }
    const projects = [...known.values()].map(({ companyId: _company, ...summary }) => summary);
    return projectDirectory.parse({
      observedAt,
      available: true,
      partial,
      projects,
      membership: [...tasks].map(([taskId, projectId]) => ({ taskId, projectId })),
      note: projects.length ? partial ? "Local project catalog. Some records could not be confirmed and their membership is unknown. Recorded work remains available." : "Local project catalog with explicit task membership. Recorded Fulcra leaders come from the session controller; project grouping grants no control." : partial ? "This installation records tasks only; project grouping is not supported here. Some local task records could not be read and their membership is unknown. Recorded work remains available." : "This installation records tasks only; project grouping is not supported here. No project membership is claimed for local work. Recorded work remains available."
    });
  } catch {
    return projectDirectory.parse({
      observedAt,
      available: false,
      partial: true,
      projects: [],
      membership: [],
      note: "Local task catalog unavailable or beyond its read limits. Recorded work remains available; project membership is unknown."
    });
  }
}
async function readProjectList(resource2, fetcher = fetch, timeout = 4e3) {
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), timeout);
  try {
    const response = await fetcher(
      `${portable.authority.issueApi}/api/companies/${COMPANY}/${resource2}`,
      { signal: abort.signal, redirect: "error" }
    );
    if (!response.ok || !response.body) throw new Error("Project source unavailable");
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      for (; ; ) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1048576) throw new Error("Project source exceeds bound");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => void 0);
    }
    const rows = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(rows) || rows.length > (resource2 === "projects" ? 64 : 1e3))
      throw new Error("Project coverage exceeds bound");
    return rows;
  } finally {
    clearTimeout(timer);
  }
}
async function readProjects(read = readProjectList, local = portable.authority.issueApi === null ? localIssues : null, localProjectRows = portable.authority.issueApi === null ? localProjects : null) {
  if (local) return localProjectDirectory(local, localProjectRows);
  const observedAt = (/* @__PURE__ */ new Date()).toISOString();
  try {
    let unique2 = function(rows, schema) {
      const found = /* @__PURE__ */ new Map(), seen = /* @__PURE__ */ new Set();
      for (const raw of rows) {
        const id6 = raw && typeof raw === "object" && "id" in raw ? raw.id : null;
        if (typeof id6 === "string") {
          if (seen.has(id6)) {
            found.delete(id6);
            partial = true;
            continue;
          }
          seen.add(id6);
        }
        const parsed = schema.safeParse(raw);
        if (!parsed.success) {
          partial = true;
          continue;
        }
        found.set(parsed.data.id, parsed.data);
      }
      return found;
    };
    var unique = unique2;
    const [allProjects, allIssues] = await Promise.all([read("projects"), read("issues")]);
    if (allProjects.length > 64 || allIssues.length > 1e3)
      throw new Error("Project coverage exceeds bound");
    const archived = archivedIds(allProjects);
    const rawProjects = allProjects.filter((r) => !isArchivedProject(r));
    const rawIssues = allIssues.filter(
      (r) => !archived.has(r?.projectId)
    );
    let partial = false;
    const projects = unique2(rawProjects, project), issues = unique2(rawIssues, issue);
    const membership2 = [...issues.values()].flatMap((row) => {
      if (row.projectId && !projects.has(row.projectId)) {
        partial = true;
        return [];
      }
      return [{ taskId: row.id, projectId: row.projectId }];
    });
    return projectDirectory.parse({
      observedAt,
      available: true,
      partial,
      projects: [...projects.values()].map(({ companyId: _company, ...summary }) => summary),
      membership: membership2,
      note: partial ? "Some project records or task memberships could not be verified. Missing links are unknown; recorded work remains available." : "Registered projects and explicit task membership. Recorded Fulcra leaders come from the session controller; project grouping grants no control."
    });
  } catch {
    return projectDirectory.parse({
      observedAt,
      available: false,
      partial: true,
      projects: [],
      membership: [],
      note: "Project directory unavailable or beyond its read limits. Recorded work remains available; project membership is unknown."
    });
  }
}
var project, issue, archivedIds, localTask;
var init_projects2 = __esm({
  "server/projects.ts"() {
    "use strict";
    init_projects();
    init_portable();
    init_tasks2();
    project = projectSummary.extend({ companyId: z7.literal(COMPANY) });
    issue = z7.object({
      id: z7.string().uuid(),
      companyId: z7.literal(COMPANY),
      projectId: z7.string().uuid().nullable()
    });
    archivedIds = (rows) => new Set(
      rows.filter(isArchivedProject).map((r) => r.id).filter((id6) => typeof id6 === "string")
    );
    localTask = z7.object({
      id: z7.string().uuid(),
      companyId: z7.literal(COMPANY),
      projectId: z7.string().uuid().nullable().optional()
    });
  }
});

// server/organization.ts
import http from "node:http";
function readBoard(request = http.get, issueId = ISSUE2) {
  if (portable.authority.issueApi === null) {
    try {
      const row = localIssues().find((r) => r.id === issueId && r.companyId === COMPANY2);
      if (!row || typeof row.title !== "string" || typeof row.status !== "string")
        throw Error("Unknown task");
      return Promise.resolve({
        available: true,
        identifier: String(row.identifier ?? issueId).slice(0, 64),
        title: row.title.slice(0, 512),
        status: row.status.slice(0, 64),
        owner: row.assigneeUserId ?? null,
        error: null
      });
    } catch {
      return Promise.resolve({
        available: false,
        identifier: issueId,
        title: null,
        status: null,
        owner: null,
        error: "Local task unavailable"
      });
    }
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        clearTimeout(deadline);
        resolve(value);
      }
    };
    const fail2 = () => finish({
      available: false,
      identifier: issueId === ISSUE2 ? "AIN-73" : issueId,
      title: null,
      status: null,
      owner: null,
      error: "Task authority unavailable"
    });
    const req = request(`${portable.authority.issueApi}/api/issues/${issueId}`, (res) => {
      let bytes = 0;
      const chunks = [];
      if (res.statusCode !== 200) {
        res.destroy();
        fail2();
        return;
      }
      res.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 131072) {
          res.destroy();
          fail2();
        } else chunks.push(chunk);
      });
      res.on("error", fail2);
      res.on("end", () => {
        try {
          const d = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (d.id !== issueId || d.companyId !== COMPANY2 || typeof d.identifier !== "string" || issueId === ISSUE2 && d.identifier !== "AIN-73" || typeof d.title !== "string" || typeof d.status !== "string")
            throw new Error("Wrong issue");
          const owner = d.assigneeUserId ?? d.assigneeAgentId;
          finish({
            available: true,
            identifier: d.identifier.slice(0, 64),
            title: d.title.slice(0, 512),
            status: d.status.slice(0, 64),
            owner: typeof owner === "string" ? owner.slice(0, 128) : null,
            error: null
          });
        } catch {
          fail2();
        }
      });
    });
    const deadline = setTimeout(() => {
      req.destroy();
      fail2();
    }, 4e3);
    req.on("error", fail2);
  });
}
var ISSUE2, COMPANY2, artifacts;
var init_organization = __esm({
  "server/organization.ts"() {
    "use strict";
    init_portable();
    init_installation();
    ISSUE2 = portable.programme;
    COMPANY2 = portable.company;
    artifacts = portable.artifacts;
  }
});

// server/host-binding.ts
var host_binding_exports = {};
__export(host_binding_exports, {
  readNativeHostBindings: () => readNativeHostBindings
});
function readNativeHostBindings() {
  return nativeHostBindings.parse(
    Object.fromEntries([portable.localHost, ...portable.hosts].map((h) => [h.name, h.serverId]))
  );
}
var init_host_binding2 = __esm({
  "server/host-binding.ts"() {
    "use strict";
    init_portable();
    init_host_binding();
  }
});

// server/native-scope.ts
async function readOnlyNativeScope(paseo, row) {
  const refreshed = await paseo.agents.ref(row.id).refresh();
  const agent = refreshed?.agent;
  const task2 = agent?.labels?.task;
  if (!agent || agent.id !== row.id || typeof task2 === "string" && task2 !== row.task)
    throw new Error("Native activity identity unavailable");
  return {
    identity: [
      agent.id,
      agent.provider ?? null,
      agent.createdAt ?? null,
      agent.persistence?.sessionId ?? null,
      agent.runtimeInstanceId ?? null
    ],
    lastUserAt: agent.lastUserMessageAt ?? null
  };
}
var init_native_scope = __esm({
  "server/native-scope.ts"() {
    "use strict";
  }
});

// server/remote-observation.ts
function createRemoteObserver(call, budgetMs = 12e3) {
  const flights = /* @__PURE__ */ new Map();
  let lastStarted;
  return async (rows, budget = budgetMs) => {
    const deadline = Date.now() + Math.min(budget, budgetMs), values = /* @__PURE__ */ new Map(), requested = /* @__PURE__ */ new Set();
    const offset = rows.findIndex((row) => remoteIdentity(row) === lastStarted) + 1;
    const ordered = [...rows.slice(offset), ...rows.slice(0, offset)];
    let open2 = true;
    try {
      while (Date.now() < deadline && values.size < rows.length) {
        for (const row of ordered) {
          const key2 = remoteIdentity(row);
          if (requested.has(key2) || Date.now() >= deadline) continue;
          let flight = flights.get(key2);
          if (!flight && flights.size < 4) {
            flight = Promise.resolve().then(() => call("observe", row.id)).catch(() => null).finally(() => flights.delete(key2));
            flights.set(key2, flight);
            lastStarted = key2;
          }
          if (flight) {
            requested.add(key2);
            void flight.then((value) => {
              if (open2) values.set(row.id, value);
            });
          }
        }
        if (values.size === rows.length || !flights.size) break;
        let timer;
        try {
          await Promise.race([
            Promise.race(flights.values()),
            new Promise((resolve) => {
              timer = setTimeout(resolve, Math.max(0, deadline - Date.now()));
            })
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
    } finally {
      open2 = false;
    }
    return {
      values: new Map(values),
      pending: new Set(
        rows.filter((row) => requested.has(remoteIdentity(row)) && !values.has(row.id)).map((row) => row.id)
      )
    };
  };
}
function observeRemotes(call, rows, budget) {
  let observe = observers.get(call);
  if (!observe) {
    observe = createRemoteObserver(call);
    observers.set(call, observe);
  }
  return observe(rows, budget);
}
var remoteIdentity, observers;
var init_remote_observation = __esm({
  "server/remote-observation.ts"() {
    "use strict";
    remoteIdentity = (row) => JSON.stringify([
      row.id,
      row.task,
      row.host,
      row.generation,
      row.remote?.host,
      row.remote?.agentId,
      row.remote?.generation
    ]);
    observers = /* @__PURE__ */ new WeakMap();
  }
});

// server/fleet.ts
var fleet_exports2 = {};
__export(fleet_exports2, {
  FLEET_BUDGET_MS: () => FLEET_BUDGET_MS,
  FLEET_NODE_LIMIT: () => FLEET_NODE_LIMIT,
  attachOwnership: () => attachOwnership,
  backgroundWork: () => backgroundWork,
  bounded: () => bounded,
  chooseRows: () => chooseRows,
  enrollment: () => enrollment,
  labelLine: () => labelLine,
  labelParent: () => labelParent,
  leadSessions: () => leadSessions,
  listAgents: () => listAgents,
  projectActivity: () => projectActivity,
  readActivity: () => readActivity,
  readFleet: () => readFleet,
  readFleetHosts: () => readFleetHosts
});
function bounded(work, ms = 12e3) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Observation timed out")), ms);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
async function enrollment(call, ms = 12e3) {
  const rows = await bounded(call("list"), ms);
  if (!Array.isArray(rows) || rows.length > 2048 || rows.some((r) => !uuid4(r?.id) || !uuid4(r?.task)) || new Set(rows.map((r) => r.id)).size !== rows.length)
    throw Error("Enrollment unavailable");
  return rows;
}
function backgroundWork(agent) {
  const count = agent?.backgroundWork?.count;
  return typeof count === "number" && Number.isInteger(count) && count > 0 && count <= 999 ? { backgroundWork: { count } } : {};
}
function readFleetHosts() {
  const bindings = readNativeHostBindings();
  return fleetHostsSchema.parse({
    local: portable.localHost.name,
    hosts: [portable.localHost, ...portable.hosts].map((h) => ({
      name: h.name,
      serverId: bindings[h.name] ?? null
    }))
  });
}
function projectActivity(entries) {
  return entries.slice(-50).map((e, i) => {
    const item = e.item ?? {}, tool = item.type === "tool_call", detail = item.detail ?? {};
    const files = tool && ["read", "edit", "write"].includes(detail.type) && typeof detail.filePath === "string" ? [text5(detail.filePath)] : [];
    return {
      id: text5(e.id ?? String(e.seqStart ?? i)),
      kind: text5(item.type),
      label: tool ? text5(item.name) : item.type === "user_message" ? "User instruction" : item.type === "assistant_message" ? "Assistant response" : text5(item.type),
      state: tool ? text5(item.status) : null,
      files
    };
  });
}
function labelLine(labels) {
  const line = labels?.["fulcra.reports-to"]?.trim();
  const link2 = labels?.["fulcra.direct-link"]?.trim();
  return {
    reportsTo: line ? line.slice(0, 200) : null,
    directLink: link2 && UUID5.test(link2) ? link2 : null
  };
}
function labelParent(labels) {
  const p = labels?.["fulcra.parent-session"] ?? labels?.["paseo.parent-agent-id"];
  return typeof p === "string" && UUID5.test(p) ? p : null;
}
function attachOwnership(nodes, edges, entries, localHost, accountOf2, limit = 64) {
  const accountLabel = (id6) => {
    const account = accountOf2(id6);
    return account ? { name: account.name, provider: account.provider } : null;
  };
  const byId = new Map(nodes.map((n) => [n.id, n])), agents = new Map(
    entries.filter((e) => typeof e?.agent?.id === "string").map((e) => [e.agent.id, e.agent])
  );
  for (const n of nodes) {
    const a = n.host === localHost ? agents.get(n.id) : null;
    n.origin ??= "enrolled";
    if (a) {
      n.parent ??= labelParent(a.labels);
      n.project ??= UUID5.test(a.labels?.["fulcra.project"] ?? "") ? a.labels["fulcra.project"] : null;
      n.role ??= typeof a.labels?.["fulcra.role"] === "string" ? a.labels["fulcra.role"].slice(0, 40) : null;
      n.account = accountLabel(n.id);
      Object.assign(n, labelLine(a.labels));
    }
    if (n.parent && byId.has(n.parent) && !edges.some((e) => e.from === n.parent && e.to === n.id) && edges.length < 128)
      edges.push({
        from: n.parent,
        to: n.id,
        active: ["running", "initializing"].includes(n.status),
        state: "owned",
        event: null
      });
  }
  for (let pass = 0; pass < 3; pass++) {
    for (const a of agents.values()) {
      if (nodes.length >= limit) return;
      const parent = labelParent(a.labels);
      if (!parent || byId.has(a.id) || !byId.has(parent) || a.archivedAt) continue;
      const p = byId.get(parent);
      const n = {
        id: a.id,
        task: p.task,
        host: localHost,
        serverId: p.host === localHost ? p.serverId ?? null : null,
        agentId: a.id,
        title: String(a.title ?? "Worker").slice(0, 200),
        provider: String(a.provider ?? "unknown").slice(0, 40),
        model: typeof a.model === "string" ? a.model.slice(0, 200) : null,
        effort: typeof (a.effectiveThinkingOptionId ?? a.thinkingOptionId) === "string" ? String(a.effectiveThinkingOptionId ?? a.thinkingOptionId).slice(0, 40) : null,
        mode: "spawned",
        status: String(a.status ?? "unknown").slice(0, 40),
        pending: Array.isArray(a.pendingPermissions) ? a.pendingPermissions.length : null,
        observedAt: (/* @__PURE__ */ new Date()).toISOString(),
        updatedAt: a.updatedAt ?? null,
        error: null,
        parent,
        project: UUID5.test(a.labels?.["fulcra.project"] ?? "") ? a.labels["fulcra.project"] : p.project ?? null,
        role: typeof a.labels?.["fulcra.role"] === "string" ? a.labels["fulcra.role"].slice(0, 40) : null,
        origin: "spawned",
        account: accountLabel(a.id),
        ...labelLine(a.labels)
      };
      nodes.push(n);
      byId.set(n.id, n);
      if (edges.length < 128)
        edges.push({
          from: parent,
          to: n.id,
          active: ["running", "initializing"].includes(n.status),
          state: "spawned",
          event: null
        });
    }
  }
}
async function listAgents(paseo, ms, pages = 5) {
  const deadline = Date.now() + ms, entries = [];
  let cursor, complete = false;
  for (let page = 0; page < pages; page++) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const r = await bounded(
      paseo.agents.list({
        filter: { includeArchived: true },
        page: cursor ? { limit: 100, cursor } : { limit: 100 }
      }),
      left
    );
    entries.push(...Array.isArray(r?.entries) ? r.entries : []);
    const next = r?.pageInfo?.hasMore === true && typeof r.pageInfo.nextCursor === "string" ? r.pageInfo.nextCursor : void 0;
    if (!next) {
      complete = true;
      break;
    }
    cursor = next;
  }
  return { entries, complete };
}
function chooseRows(all, entries, limit = FLEET_NODE_LIMIT, pinned = /* @__PURE__ */ new Set()) {
  if (all.length <= limit) return all;
  const localHost = portable.localHost.name;
  const native = new Map(entries.map((e) => [e.agent.id, e.agent]));
  const rank = all.map((row, index) => {
    const a = row.host === localHost ? native.get(row.id) : void 0;
    return {
      index,
      lead: pinned.has(row.id) ? 0 : 1,
      working: a && ["running", "initializing"].includes(a.status ?? "") ? 0 : 1,
      active: Date.parse(a?.updatedAt ?? "") || 0
    };
  }).sort(
    (x, y) => x.lead - y.lead || x.working - y.working || y.active - x.active || y.index - x.index
  );
  return rank.slice(0, limit).map((r) => r.index).sort((a, b) => a - b).map((i) => all[i]);
}
function leadSessions(read) {
  if (read.status !== "fulfilled") return /* @__PURE__ */ new Set();
  const bindings = Array.isArray(read.value?.bindings) ? read.value.bindings.slice(0, 512) : [];
  return new Set(
    bindings.filter(
      (b) => (b?.role === "prime" || b?.role === "project-orchestrator") && b?.state === "assigned" && typeof b?.sessionId === "string"
    ).map((b) => b.sessionId)
  );
}
async function readFleet(paseo, call = localCall, catalog = readTaskCatalog, details = (id6) => readBoard(void 0, id6), budgetMs = FLEET_BUDGET_MS, input = {}, directory = readProjects) {
  const deadline = Date.now() + budgetMs, left = () => Math.max(0, Math.min(12e3, deadline - Date.now()));
  const bindings = readNativeHostBindings();
  const all = await enrollment(call, left());
  const stage = left();
  const [native, roles, board, quotaRead, seats] = await Promise.allSettled([
    listAgents(paseo, stage),
    bounded(call("manager-summary"), stage),
    bounded(catalog(), stage),
    bounded(call("quota-status"), stage),
    bounded(call(CONTROLLER_METHOD.directory), stage)
  ]);
  let quota = null;
  try {
    if (quotaRead.status === "fulfilled") {
      const value = quotaStatusSchema.parse(quotaRead.value), age = Date.now() - Date.parse(value.observedAt);
      if (age < -5e3 || age > 45e3 || new Set(value.entries.map((e) => e.sessionId)).size !== value.entries.length)
        throw Error("Quota observation invalid");
      quota = value;
    }
  } catch {
  }
  const quotaNote = quota ? `${quota.partial ? "Partial quota queue observation. " : ""}Saved quota waits; capacity and control are checked again before work resumes. Scheduled checks are not promised restart times.` : "Quota queue unavailable or unsupported; no capacity or readiness is inferred.";
  const entries = native.status === "fulfilled" ? native.value.entries : [];
  const projects = input.projectId || input.search?.trim() ? await bounded(directory(), left()).catch(() => null) : null;
  const query = input.search?.trim().toLowerCase() ?? "";
  const eligible = all.filter((row) => {
    const agent = entries.find((e) => e.agent.id === row.id)?.agent;
    const projectId = projects?.membership.find((m) => m.taskId === row.task)?.projectId;
    const task2 = board.status === "fulfilled" ? board.value.tasks.find((t) => t.id === row.task) : null;
    return (!input.host || input.host === "all" || row.host === input.host) && (!input.projectId || projectId === input.projectId) && (!query || [
      row.id,
      row.task,
      row.provider,
      row.title,
      agent?.title,
      agent?.provider,
      task2?.title,
      task2?.identifier,
      projects?.projects.find((p) => p.id === projectId)?.name
    ].filter(Boolean).join(" ").toLowerCase().includes(query));
  });
  const first = chooseRows(eligible, entries, FLEET_NODE_LIMIT, leadSessions(seats)), firstIds = new Set(first.map((r) => r.id));
  const ordered = [...first, ...eligible.filter((r) => !firstIds.has(r.id))];
  const offset = input.offset ?? 0, rows = ordered.slice(offset, offset + FLEET_NODE_LIMIT);
  const nextOffset = offset + rows.length < eligible.length ? offset + rows.length : null;
  const nodes = [];
  const remotes = rows.filter((r) => r.host !== portable.localHost.name);
  const { values: remote, pending } = await observeRemotes(call, remotes, left());
  for (const row of rows) {
    const host = Object.hasOwn(bindings, row.host) ? row.host : "unknown";
    const a = host === portable.localHost.name ? entries.find((e) => e.agent.id === row.id)?.agent : null;
    const raw = remote.get(row.id), identityMatches = raw && Number.isSafeInteger(row.generation) && uuid4(row.remote?.agentId) && remoteIdentity(raw) === remoteIdentity(row);
    const response = identityMatches ? raw : null, observation = response?.observed;
    const malformed = !!observation && (!["initializing", "idle", "running", "error", "closed"].includes(observation.status) || !Number.isSafeInteger(observation.pending) || observation.pending < 0);
    const o = malformed ? null : observation;
    const age = Date.now() - Date.parse(o?.observedAt), staleRemote = !!o && (!Number.isFinite(age) || age > 45e3 || age < -5e3), known = a || o && !staleRemote;
    nodes.push({
      id: row.id,
      task: row.task,
      host,
      serverId: host === "unknown" ? null : bindings[host],
      quotaObservedAt: quota?.observedAt ?? null,
      quotaWait: quota?.entries.find((e) => e.sessionId === row.id && e.taskId === row.task) ?? void 0,
      agentId: host === portable.localHost.name ? row.id : uuid4(row.remote?.agentId) ? row.remote.agentId : null,
      title: text5(
        a?.title ?? o?.title,
        host !== portable.localHost.name ? "Remote conversation" : "Saved conversation"
      ),
      provider: text5(a?.provider ?? o?.provider ?? row.provider),
      model: typeof (a?.model ?? o?.model) === "string" ? text5(a?.model ?? o?.model) : null,
      // U5-D10: the session's reasoning effort as the host reports it (its thinking option); null when not reported.
      effort: typeof (a?.effectiveThinkingOptionId ?? a?.thinkingOptionId ?? o?.thinkingOptionId) === "string" ? text5(a?.effectiveThinkingOptionId ?? a?.thinkingOptionId ?? o?.thinkingOptionId) : null,
      mode: text5(response?.mode ?? row.mode),
      status: known ? text5(a?.status ?? o?.status) : "unavailable",
      pending: a ? a.pendingPermissions.length : Number.isSafeInteger(o?.pending) && o.pending >= 0 ? o.pending : null,
      observedAt: a ? (/* @__PURE__ */ new Date()).toISOString() : o ? text5(o.observedAt) : null,
      updatedAt: a?.updatedAt ?? o?.lastUserAt ?? null,
      ...backgroundWork(a),
      error: raw && !identityMatches ? "Remote session route changed during observation; refresh to inspect current state" : malformed ? "Remote observation invalid; current state unavailable" : staleRemote ? "Remote observation is stale or has an invalid timestamp; current state unavailable" : known ? a?.lastError || o?.lastError ? text5(plainReason(a?.lastError ?? o?.lastError)) : null : host !== portable.localHost.name && pending.has(row.id) ? "Remote observation still in progress; current state unavailable" : host !== portable.localHost.name && !remote.has(row.id) ? "Remote observation not started within this refresh budget; refresh or inspect this session" : "Native observation unavailable; session retained"
    });
  }
  const byId = new Map(nodes.map((n) => [n.id, n])), edges = [];
  const roleRead = readSupervisors(roles.status === "fulfilled" ? roles.value : null);
  const supervisionAvailable = roleRead.available, parsedRoles = { data: roleRead.supervisors };
  const supervisors = parsedRoles.data.filter((s) => byId.get(s.id)?.task === s.task).map((s) => ({
    ...s,
    workers: s.workers.filter((w) => !w.workerId || byId.get(w.workerId)?.task === s.task)
  }));
  const supervisionIssues = roleRead.issues;
  const roleCoveragePartial = supervisionAvailable && (supervisionIssues.unreadable > 0 || supervisionIssues.truncated > 0 || supervisors.length !== parsedRoles.data.length || supervisors.some(
    (s) => s.workers.length !== parsedRoles.data.find((r) => r.id === s.id).workers.length
  ));
  if (roles.status === "fulfilled" && Array.isArray(roles.value))
    for (const s of roles.value.slice(0, 32))
      for (const w of (Array.isArray(s.workers) ? s.workers : []).slice(0, 32)) {
        const parent = byId.get(s.id), child = byId.get(w.workerId);
        if (parent && child && parent.id !== child.id && parent.task === child.task && parent.task === s.task && edges.length < 128)
          edges.push({
            from: parent.id,
            to: child.id,
            active: s.active === true && w.phase === "attached" && w.ownership === "linked" && parent.mode === "delegated" && child.mode === "delegated",
            state: text5(w.ownership ?? w.phase),
            event: w.lastEvent ? text5(
              w.lastEvent.kind + " \xB7 " + w.lastEvent.state + (w.lastEvent.consumed ? " \xB7 consumed" : "")
            ) : null
          });
      }
  let pool = null;
  try {
    pool = readAccounts(loadConfig().home);
  } catch {
    pool = null;
  }
  attachOwnership(
    nodes,
    edges,
    entries,
    portable.localHost.name,
    (id6) => pool ? accountOf(pool, id6) : null,
    FLEET_NODE_LIMIT
  );
  const taskIds = [
    .../* @__PURE__ */ new Set([
      ...nodes.map((n) => n.task),
      ...board.status === "fulfilled" ? board.value.tasks.map((t) => t.id) : []
    ])
  ];
  const tasks = taskIds.slice(0, 64).map((id6) => {
    const b = board.status === "fulfilled" ? board.value.tasks.find((t) => t.id === id6) : null;
    return {
      id: id6,
      title: b?.title ? text5(b.title) : "Task name unavailable",
      identifier: b?.identifier ?? null
    };
  });
  if (left() >= 1e3)
    await Promise.all(
      tasks.filter((t) => !t.identifier).slice(0, 4).map(async (t) => {
        try {
          const b = await bounded(details(t.id), left());
          if (b.available && b.title) {
            t.title = text5(b.title);
            t.identifier = b.identifier;
          }
        } catch {
        }
      })
    );
  const partial = Boolean((input.projectId || query) && (!projects?.available || projects.partial)) || eligible.length > rows.length || native.status === "fulfilled" && !native.value.complete || taskIds.length > tasks.length || roleCoveragePartial || nodes.some((n) => n.status === "unavailable") || !supervisionAvailable || board.status === "rejected" || board.status === "fulfilled" && board.value.partial === true;
  return fleetSchema.parse({
    observedAt: (/* @__PURE__ */ new Date()).toISOString(),
    hosts: [portable.localHost.name, ...portable.hosts.map((h) => h.name)],
    total: all.length,
    matching: eligible.length,
    nextOffset,
    partial,
    quotaNote,
    nodes,
    edges,
    tasks,
    supervisors,
    supervisionAvailable,
    supervisionIssues,
    note: `${partial ? "Partial observation. " : ""}Enrolled sessions; 64 per page; Book reads use four concurrent slots and a 12-second refresh budget. ${!supervisionAvailable ? "Supervision unavailable. " : ""}Saved relationships do not imply active delegation. Observations do not wake models.`
  });
}
async function readActivity(input, paseo, call = localCall) {
  const row = (await enrollment(call)).find(
    (r) => r.id === input.sessionId && r.task === input.taskId
  );
  if (!row) throw Error("Session is not enrolled in this task");
  if (row.host === portable.localHost.name)
    await bounded(readOnlyNativeScope(paseo, row)).catch(() => {
      throw Error("Session membership changed");
    });
  let receiptNote = "";
  const receipts = await bounded(call("activity-receipts", input)).catch(() => {
    receiptNote = "Receipt metadata unavailable. ";
    return [];
  });
  let activity = [], observedAt = (/* @__PURE__ */ new Date()).toISOString(), note3 = "Remote activity unavailable; receipt metadata retained without a native timeline claim.";
  if (row.host === portable.localHost.name) {
    try {
      const p = await bounded(
        paseo.agents.ref(row.id).timeline.refetch({ limit: 50, projection: "canonical" })
      );
      if (p.error || p.gap || p.reset || p.staleCursor) throw Error("Timeline gap");
      activity = projectActivity(p.entries ?? []);
      note3 = `${p.hasOlder ? "Latest 50 timeline entries; older history exists. " : ""}${activity.some((e) => e.kind === "tool_call") ? "" : "No tool events in this window; full history coverage is unverified. "}Original native timeline. Tool file paths show reported touches, not independently verified changes. Delivery is not task acceptance.`;
    } catch {
      note3 = "Native timeline unavailable; receipts retained. No activity is inferred.";
    }
  }
  if (row.host !== portable.localHost.name) {
    try {
      const p = bookActivitySchema.parse(await bounded(call("book-activity", input))), age = Date.now() - Date.parse(p.observedAt);
      if (p.sessionId !== row.id || p.taskId !== row.task || p.agentId !== row.remote?.agentId)
        throw Error("Remote activity identity changed");
      if (!Number.isFinite(age) || age < -5e3 || age > 45e3)
        throw Error("Remote activity observation is stale");
      activity = p.activity;
      observedAt = p.observedAt;
      note3 = `${!activity.length ? "No summarizable activity in this window; coverage unverified. " : ""}${activity.length && !activity.some((a) => a.kind === "tool_call") ? "No tool events in this window; coverage unverified. " : ""}${p.skippedCount ? `${p.skippedCount} entries excluded from this metadata view. ` : ""}${p.withheldPaths ? `${p.withheldPaths} paths outside the task or display bounds omitted. ` : ""}${p.hasOlder ? "Latest 50 entries; older history exists. " : ""}Tool paths are reported touches, not verified changes. Delivery is not task acceptance.`;
    } catch (error) {
      note3 = error instanceof Error && error.message === "Remote activity observation is stale" ? "Remote activity unavailable: clock skew or stale observation; receipts retained. No current activity is inferred." : "Book tool activity unavailable or unsupported; receipts retained. No current activity is inferred.";
    }
  }
  const fresh = (await enrollment(call)).find((r) => r.id === row.id && r.task === row.task);
  if (!fresh) throw Error("Session membership changed during observation");
  if (row.host !== portable.localHost.name && (fresh.host !== row.host || fresh.generation !== row.generation || fresh.remote?.agentId !== row.remote?.agentId))
    throw Error("Remote session route changed during observation");
  return activityRpc.output.parse({
    observedAt,
    sessionId: row.id,
    taskId: row.task,
    note: receiptNote + note3,
    receipts,
    activity
  });
}
var text5, uuid4, FLEET_BUDGET_MS, FLEET_NODE_LIMIT, UUID5;
var init_fleet2 = __esm({
  "server/fleet.ts"() {
    "use strict";
    init_accounts();
    init_config();
    init_portable();
    init_plain_reason();
    init_fleet();
    init_roles();
    init_projects2();
    init_management2();
    init_organization();
    init_tasks2();
    init_host_binding2();
    init_supervisors();
    init_native_scope();
    init_remote_observation();
    text5 = (v, fallback = "unknown") => typeof v === "string" ? v.slice(0, 512) : fallback;
    uuid4 = (v) => typeof v === "string" && /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(v);
    FLEET_BUDGET_MS = 16e3;
    FLEET_NODE_LIMIT = 64;
    UUID5 = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  }
});

// server/fleet.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import fs3 from "node:fs";
import os from "node:os";
import path4 from "node:path";
import { after } from "node:test";

// ../src/config.mjs
init_config();

// server/fleet.test.ts
var home = fs3.mkdtempSync(path4.join(fs3.realpathSync(os.tmpdir()), "fleet-portable-"));
var previousHome = process.env.ORCA_HOME;
process.env.ORCA_HOME = home;
firstRun();
var configFile = path4.join(home, "config.json");
var config = JSON.parse(fs3.readFileSync(configFile, "utf8"));
config.localHost = { name: "Desk", serverId: "srv_example_desk" };
config.hosts = [{ name: "Studio", serverId: "srv_example_studio" }];
fs3.writeFileSync(configFile, JSON.stringify(config));
after(() => {
  fs3.rmSync(home, { recursive: true, force: true });
  if (previousHome === void 0) delete process.env.ORCA_HOME;
  else process.env.ORCA_HOME = previousHome;
});
var { readFleet: readFleet2, readActivity: readActivity2, projectActivity: projectActivity2, readFleetHosts: readFleetHosts2, chooseRows: chooseRows2, leadSessions: leadSessions2 } = await Promise.resolve().then(() => (init_fleet2(), fleet_exports2));
var { readNativeHostBindings: readNativeHostBindings2 } = await Promise.resolve().then(() => (init_host_binding2(), host_binding_exports));
var id5 = (n) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
var task = id5(9);
var other = id5(8);
var at = (/* @__PURE__ */ new Date()).toISOString();
test("portfolio includes recorded leaders without workers and workstreams without sessions", async () => {
  const f = fixture();
  f.roles.splice(0, f.roles.length, {
    id: id5(1),
    task,
    active: false,
    maxWorkers: 2,
    reserved: 0,
    workers: []
  });
  const catalog = async () => ({
    partial: false,
    tasks: [
      { id: task, title: "Delivery project", identifier: "AIN-103" },
      { id: other, title: "Product research", identifier: "AIN-104" }
    ]
  });
  const result = await readFleet2(f.paseo, f.call, catalog);
  assert.equal(result.supervisionAvailable, true);
  assert.deepEqual(result.supervisors, f.roles);
  assert.equal(result.edges.length, 0);
  assert.deepEqual(
    result.tasks.map((t) => t.title),
    ["Delivery project", "Product research"]
  );
  assert(
    f.methods.every(
      (m) => ["list", "observe", "manager-summary", "quota-status", "bindings-status"].includes(m)
    )
  );
});
test("invalid or unavailable leadership is unknown; foreign roles and workers do not become owners", async () => {
  const f = fixture(), role2 = { id: id5(1), task, active: true, maxWorkers: 2, reserved: 0, workers: [] };
  f.roles.splice(0, f.roles.length, role2, { ...role2 });
  let result = await readFleet2(f.paseo, f.call, f.catalog);
  assert.equal(result.supervisionAvailable, true);
  assert.equal(result.supervisors?.length, 1);
  assert.deepEqual(result.supervisionIssues, { unreadable: 1, ids: [id5(1)], truncated: 0 });
  assert.equal(result.partial, true);
  f.roles.splice(0, f.roles.length, { ...role2, task: other });
  result = await readFleet2(f.paseo, f.call, f.catalog);
  assert.deepEqual(result.supervisors, []);
  assert.equal(result.partial, true);
  f.roles.splice(0, f.roles.length, {
    ...role2,
    workers: [
      {
        requestId: id5(7),
        workerId: id5(55),
        phase: "attached",
        ownership: "linked",
        fault: null,
        lastEvent: null
      }
    ]
  });
  result = await readFleet2(f.paseo, f.call, f.catalog);
  assert.equal(result.supervisors?.[0].workers.length, 0);
  assert.equal(result.partial, true);
  const offline = await readFleet2(
    f.paseo,
    (m, a) => m === "manager-summary" ? Promise.reject(Error("offline")) : f.call(m, a),
    f.catalog
  );
  assert.equal(offline.supervisionAvailable, false);
});
test("fresh fleet assembly never launders stale, missing or future Book observation times", async () => {
  for (const observedAt of [
    new Date(Date.now() - 6e5).toISOString(),
    void 0,
    "invalid",
    new Date(Date.now() + 6e5).toISOString()
  ]) {
    const f = fixture(), call = async (m, a) => m === "observe" ? { ...await f.call(m, a), observed: { status: "running", pending: 0, observedAt } } : f.call(m, a);
    const result = await readFleet2(f.paseo, call, f.catalog), book = result.nodes.find((n) => n.host === "Studio");
    assert.equal(book.status, "unavailable");
    assert.match(book.error, /stale|invalid/);
    assert(result.partial);
  }
});
function fixture() {
  const rows = [
    { id: id5(1), task, host: "Desk", mode: "human" },
    { id: id5(2), task, host: "Studio", mode: "human", generation: 1, remote: { agentId: id5(3) } }
  ];
  const methods2 = [];
  const roles = [
    {
      id: id5(1),
      task,
      active: false,
      workers: [
        {
          workerId: id5(2),
          phase: "attached",
          ownership: "human",
          lastEvent: { kind: "turn-ended", state: "delivered", consumed: true }
        }
      ]
    }
  ];
  const call = async (m, input) => {
    methods2.push(m);
    if (m === "list") return rows;
    if (m === "manager-summary") return roles;
    if (m === "activity-receipts")
      return [
        {
          id: id5(7),
          kind: "send",
          state: "delivered",
          notification: "consumed",
          evidenceHash: null
        }
      ];
    if (m === "observe")
      return {
        ...rows.find((r) => r.id === input),
        id: input,
        task,
        mode: "human",
        observed: { status: "idle", pending: 0, provider: "codex", observedAt: at },
        deliveries: [
          {
            id: id5(7),
            kind: "send",
            state: "delivered",
            result: JSON.stringify({
              secret: "never expose",
              notification: { state: "consumed", instruction: "never expose" }
            })
          }
        ]
      };
    throw Error("Unexpected mutation " + m);
  };
  const paseo = {
    agents: {
      list: async () => ({
        entries: [
          {
            agent: {
              id: id5(1),
              title: "Mini author",
              provider: "codex",
              model: "model",
              status: "idle",
              pendingPermissions: [],
              updatedAt: at
            }
          }
        ],
        pageInfo: {}
      }),
      ref: (rid) => ({
        refresh: async () => ({ agent: { id: rid ?? id5(1), labels: { task } }, project: null }),
        timeline: {
          refetch: async (options) => {
            assert.equal(options.projection, "canonical");
            return {
              entries: [
                {
                  seqStart: 1,
                  item: {
                    type: "tool_call",
                    name: "Read",
                    status: "completed",
                    detail: { type: "read", filePath: "/owned/a.txt", content: "never expose" }
                  }
                }
              ],
              hasOlder: true
            };
          }
        }
      })
    }
  };
  const catalog = async () => ({
    tasks: [{ id: task, title: "One task", identifier: "AIN-103" }]
  });
  return { rows, roles, methods: methods2, call, paseo, catalog };
}
test("both hosts remain bound to task and real native IDs; inactive relationships are not active supervision", async () => {
  const f = fixture(), r = await readFleet2(f.paseo, f.call, f.catalog);
  assert.equal(r.total, 2);
  assert.deepEqual(
    r.nodes.map((n) => n.host),
    ["Desk", "Studio"]
  );
  assert.equal(r.nodes[1].agentId, id5(3));
  assert.equal(r.edges[0].active, false);
  assert.equal(r.nodes[1].observedAt, at);
  assert(!JSON.stringify(r).includes("never expose"));
  assert(
    f.methods.every(
      (m) => ["list", "observe", "manager-summary", "quota-status", "bindings-status"].includes(m)
    )
  );
});
test("active supervision uses current controller linked ownership and both delegated modes", async () => {
  const f = fixture();
  f.roles[0].active = true;
  f.roles[0].workers[0].ownership = "linked";
  f.rows.forEach((r) => r.mode = "delegated");
  let bookMode = "delegated";
  const call = async (m, a) => {
    const result = await f.call(m, a);
    return m === "observe" ? { ...result, mode: bookMode } : result;
  };
  assert.equal((await readFleet2(f.paseo, call, f.catalog)).edges[0].active, true);
  for (const field of ["parent", "worker", "role", "ownership", "phase"]) {
    if (field === "parent") f.rows[0].mode = "human";
    if (field === "worker") bookMode = "human";
    if (field === "role") f.roles[0].active = false;
    if (field === "ownership") f.roles[0].workers[0].ownership = "orphaned";
    if (field === "phase") f.roles[0].workers[0].phase = "reserved";
    assert.equal((await readFleet2(f.paseo, call, f.catalog)).edges[0].active, false, field);
    f.rows[0].mode = "delegated";
    bookMode = "delegated";
    f.roles[0].active = true;
    f.roles[0].workers[0].ownership = "linked";
    f.roles[0].workers[0].phase = "attached";
  }
});
test("Book outage and missing native Mini listing retain unavailable nodes, not idle or disappearance", async () => {
  const f = fixture();
  f.paseo.agents.list = async () => {
    throw Error("offline");
  };
  const r = await readFleet2(
    f.paseo,
    async (m, a) => {
      if (m === "observe") throw Error("offline");
      return f.call(m, a);
    },
    f.catalog
  );
  assert.equal(r.nodes.length, 2);
  assert(r.nodes.every((n) => n.status === "unavailable" && n.observedAt === null));
  assert(r.partial);
});
test("foreign/cyclic-self relationships are not exposed; malformed enrollment fails closed", async () => {
  const f = fixture();
  f.roles.push(
    { id: id5(1), task: other, workers: [{ workerId: id5(2) }] },
    { id: id5(1), task, workers: [{ workerId: id5(1) }] }
  );
  assert.equal((await readFleet2(f.paseo, f.call, f.catalog)).edges.length, 1);
  f.rows.push({ ...f.rows[0] });
  await assert.rejects(readFleet2(f.paseo, f.call, f.catalog), /Enrollment/);
});
test("bounded remote observations cover every healthy Book route beyond the fourth", async () => {
  const f = fixture();
  f.roles.splice(0);
  for (let i = 10; i < 14; i++)
    f.rows.push({
      id: id5(i),
      task,
      host: "Studio",
      mode: "human",
      generation: 1,
      remote: { agentId: id5(i + 100) }
    });
  const r = await readFleet2(f.paseo, f.call, f.catalog);
  assert.equal(f.methods.filter((m) => m === "observe").length, 5);
  assert(r.nodes.every((n) => n.status === "idle"));
  assert.equal(r.partial, false);
});
test("activity validates task before read and strips prompts, contents, commands and raw results", async () => {
  const f = fixture();
  await assert.rejects(
    readActivity2({ sessionId: id5(1), taskId: other }, f.paseo, f.call),
    /not enrolled/
  );
  assert.deepEqual(f.methods, ["list"]);
  const r = await readActivity2({ sessionId: id5(1), taskId: task }, f.paseo, f.call);
  assert.equal(r.activity[0].files[0], "/owned/a.txt");
  assert.equal(r.receipts[0].notification, "consumed");
  assert(!JSON.stringify(r).includes("never expose"));
  assert(r.note.includes("older history"));
});
test("older or unavailable Book receiver retains receipts with explicit unavailable activity", async () => {
  const f = fixture(), r = await readActivity2({ sessionId: id5(2), taskId: task }, f.paseo, f.call);
  assert.equal(r.activity.length, 0);
  assert(r.note.includes("unavailable or unsupported"));
  const old = await readActivity2({ sessionId: id5(2), taskId: task }, f.paseo, async (m, a) => {
    if (m === "activity-receipts") throw Error("unsupported");
    return f.call(m, a);
  });
  assert(old.note.includes("Receipt metadata unavailable"));
  assert.deepEqual(old.receipts, []);
});
test("Book canonical activity is bounded and bound to task, route and current observation", async () => {
  const f = fixture(), response = {
    sessionId: id5(2),
    taskId: task,
    agentId: id5(3),
    nativeId: id5(4),
    observedAt: (/* @__PURE__ */ new Date()).toISOString(),
    hasOlder: true,
    skippedCount: 0,
    withheldPaths: 0,
    activity: [
      { id: "1", kind: "tool_call", label: "Read", state: "completed", files: ["/owned/file"] }
    ]
  };
  const read = (r2) => readActivity2(
    { sessionId: id5(2), taskId: task },
    f.paseo,
    (m, a) => m === "book-activity" ? Promise.resolve(r2) : f.call(m, a)
  );
  const r = await read(response);
  assert.equal(r.activity[0].label, "Read");
  assert(r.note.includes("older history"));
  assert(r.note.includes("not verified changes"));
  for (const change2 of [
    { sessionId: id5(9) },
    { taskId: other },
    { agentId: id5(9) },
    { observedAt: "2000-01-01" },
    { extra: "PRIVATE" },
    { activity: Array(51).fill(response.activity[0]) }
  ]) {
    const bad = await read({ ...response, ...change2 });
    assert.equal(bad.activity.length, 0);
    assert(bad.note.includes("unavailable"));
    assert(!JSON.stringify(bad).includes("PRIVATE"));
  }
  for (const change2 of [
    { kind: "thinking" },
    { label: "PRIVATE\ncommand" },
    { state: "PRIVATE" },
    { files: ["PRIVATE\ncontent"] }
  ])
    assert.equal(
      (await read({ ...response, activity: [{ ...response.activity[0], ...change2 }] })).activity.length,
      0
    );
  const older = { ...response, observedAt: new Date(Date.now() - 4e4).toISOString() };
  assert.equal((await read(older)).observedAt, older.observedAt);
  assert(
    (await read({ ...response, observedAt: new Date(Date.now() + 6e3).toISOString() })).note.includes("clock skew")
  );
  const empty2 = await read({ ...response, activity: [], skippedCount: 50 });
  assert(empty2.note.includes("No summarizable activity"));
  assert(empty2.note.includes("50 entries excluded"));
  assert(!f.methods.includes("observe"));
  const messages = await read({
    ...response,
    activity: [
      { id: "1", kind: "user_message", label: "User instruction", state: null, files: [] }
    ]
  });
  assert(messages.note.includes("No tool events in this window"));
  let lists = 0;
  await assert.rejects(
    readActivity2(
      { sessionId: id5(2), taskId: task },
      f.paseo,
      (m, a) => m === "book-activity" ? Promise.resolve(response) : m === "list" && ++lists > 1 ? Promise.resolve(f.rows.map((r2) => ({ ...r2, remote: { agentId: id5(9) } }))) : f.call(m, a)
    ),
    /Remote session route changed/
  );
});
test("membership change during observation refuses result; timeline gap returns only receipts", async () => {
  const f = fixture();
  f.paseo.agents.ref = (rid) => ({
    refresh: async () => ({ agent: { id: rid ?? id5(1), labels: { task } }, project: null }),
    timeline: { refetch: async () => ({ gap: true, entries: [] }) }
  });
  assert(
    (await readActivity2({ sessionId: id5(1), taskId: task }, f.paseo, f.call)).note.includes(
      "unavailable"
    )
  );
  let lists = 0;
  await assert.rejects(
    readActivity2(
      { sessionId: id5(1), taskId: task },
      f.paseo,
      async (m, a) => m === "list" && ++lists > 1 ? [] : f.call(m, a)
    ),
    /membership changed/
  );
});
test("activity bound and unknown event kinds never copy arbitrary provider payload", () => {
  const r = projectActivity2(
    Array.from({ length: 80 }, (_, i) => ({
      seqStart: i,
      item: { type: "user_message", text: "secret" }
    }))
  );
  assert.equal(r.length, 50);
  assert(r.every((e) => e.label === "User instruction"));
  assert(!JSON.stringify(r).includes("secret"));
});
test("closed task labels are read only by retained ID with fallback on outage", async () => {
  const f = fixture();
  const catalog = async () => ({ tasks: [] });
  const r = await readFleet2(f.paseo, f.call, catalog, async (id6) => {
    assert.equal(id6, task);
    return {
      available: true,
      title: "Finished work",
      identifier: "AIN-101",
      status: "done",
      owner: "local-board",
      error: null
    };
  });
  assert.equal(r.tasks[0].title, "Finished work");
  const unavailable = await readFleet2(f.paseo, f.call, catalog, async () => {
    throw Error("offline");
  });
  assert.equal(unavailable.tasks[0].title, "Task name unavailable");
});
test("fleet shows only fresh task-bound quota waits, without changing native idle status or making mutations", async () => {
  const f = fixture(), wait = {
    messageId: id5(7),
    sessionId: id5(1),
    taskId: task,
    state: "waiting",
    reason: "provider-limit",
    since: at,
    checkedAt: null,
    nextCheckAt: at
  };
  const value = {
    version: 1,
    observedAt: (/* @__PURE__ */ new Date()).toISOString(),
    partial: false,
    entries: [wait]
  };
  const read = (quota) => readFleet2(
    f.paseo,
    (m, a) => m === "quota-status" ? Promise.resolve(quota) : f.call(m, a),
    f.catalog
  );
  const good = await read(value);
  assert.equal(good.nodes[0].quotaWait?.messageId, id5(7));
  assert.equal(good.nodes[0].status, "idle");
  assert.equal(good.nodes[1].quotaWait, void 0);
  assert.match(good.quotaNote, /not promised/);
  for (const bad of [
    { ...value, observedAt: "2000-01-01T00:00:00.000Z" },
    { ...value, version: 2 },
    { ...value, entries: [wait, wait] },
    { ...value, entries: [{ ...wait, reason: "PRIVATE raw error" }] },
    { ...value, entries: [{ ...wait, secret: "PRIVATE" }] }
  ]) {
    const result = await read(bad);
    assert.equal(result.nodes[0].quotaWait, void 0);
    assert.match(result.quotaNote, /unavailable/);
    assert(!JSON.stringify(result).includes("PRIVATE"));
  }
  assert.equal(
    (await read({ ...value, entries: [{ ...wait, taskId: other }] })).nodes[0].quotaWait,
    void 0
  );
  const unavailable = await readFleet2(f.paseo, f.call, f.catalog);
  assert.match(unavailable.quotaNote, /unsupported/);
  assert.equal(unavailable.nodes[0].status, "idle");
});
test("host bindings come from the portable config, including hosts absent from the page", async () => {
  assert.deepEqual(readNativeHostBindings2(), {
    Desk: "srv_example_desk",
    Studio: "srv_example_studio"
  });
  const f = fixture();
  f.rows.splice(1);
  const fleet = await readFleet2(f.paseo, f.call, f.catalog);
  assert.deepEqual(fleet.hosts, ["Desk", "Studio"]);
  assert.equal(fleet.nodes[0].serverId, "srv_example_desk");
});
test("fleet projects configured host IDs alongside original native agent identities", async () => {
  const f = fixture(), fleet = await readFleet2(f.paseo, f.call, f.catalog);
  assert.deepEqual(
    fleet.nodes.map((n) => [n.host, n.serverId, n.agentId]),
    [
      ["Desk", "srv_example_desk", id5(1)],
      ["Studio", "srv_example_studio", id5(3)]
    ]
  );
});
test("fleet withholds mismatched remote identity and malformed native observations", async () => {
  const f = fixture();
  for (const change2 of [
    { id: id5(99) },
    { task: other },
    { generation: 2 },
    { host: "Desk" },
    { remote: { agentId: id5(99) } },
    { observed: { status: "invented", pending: 0, observedAt: at } },
    { observed: { status: "running", pending: -1, observedAt: at } }
  ]) {
    const r = await readFleet2(
      f.paseo,
      async (m, a) => {
        const v = await f.call(m, a);
        return m === "observe" ? { ...v, ...change2 } : v;
      },
      f.catalog
    );
    assert.equal(r.nodes[1].status, "unavailable");
    assert.equal(r.nodes[1].pending, null);
    assert(r.partial);
    assert.match(r.nodes[1].error, /changed|invalid/);
  }
});
test("fleet distinguishes in-progress reads from routes not admitted before the deadline", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const f = fixture();
  for (let i = 10; i < 14; i++)
    f.rows.push({
      id: id5(i),
      task,
      host: "Studio",
      mode: "human",
      generation: 1,
      remote: { agentId: id5(i + 100) }
    });
  const result = readFleet2(
    f.paseo,
    (m, a) => m === "observe" ? new Promise(() => {
    }) : f.call(m, a),
    f.catalog
  );
  for (let i = 0; i < 40; i++) await Promise.resolve();
  t.mock.timers.tick(12e3);
  for (let i = 0; i < 40; i++) await Promise.resolve();
  const r = await result, book = r.nodes.filter((n) => n.host === "Studio");
  assert(book.every((n) => n.status === "unavailable" && n.pending === null));
  assert.equal(book.filter((n) => n.error?.includes("still in progress")).length, 4);
  assert.equal(book.filter((n) => n.error?.includes("not started")).length, 1);
  assert(r.partial);
});
test("Book native names are bounded and identity-bound; old receivers keep explicit unknown labels", async () => {
  const f = fixture();
  const read = (extra) => readFleet2(
    f.paseo,
    async (m, a) => {
      const result = await f.call(m, a);
      return m === "observe" ? { ...result, ...extra, observed: { ...result.observed, ...extra.observed } } : result;
    },
    f.catalog
  );
  const named = await read({
    observed: { title: "Review phone pairing", model: "reported-model" }
  });
  assert.equal(named.nodes[1].title, "Review phone pairing");
  assert.equal(named.nodes[1].model, "reported-model");
  assert.equal(
    (await read({ observed: { title: "x".repeat(900), model: "y".repeat(900) } })).nodes[1].title.length,
    512
  );
  assert.equal(
    (await read({ observed: { title: { private: "payload" }, model: 42 } })).nodes[1].title,
    "Remote conversation"
  );
  assert.equal(
    (await read({ id: id5(99), observed: { title: "Wrong route" } })).nodes[1].title,
    "Remote conversation"
  );
  assert.equal(
    (await readFleet2(
      f.paseo,
      f.call,
      async () => ({
        tasks: [{ id: task, title: "Task without board identifier", identifier: null }]
      }),
      async () => {
        throw Error("offline");
      }
    )).tasks[0].title,
    "Task without board identifier"
  );
});
test("a stalled controller yields a partial fleet within the read budget, never a host timeout", async () => {
  const f = fixture(), hang = () => new Promise(() => {
  });
  const call = async (m, a) => m === "list" ? f.call(m, a) : hang();
  const paseo = { ...f.paseo, agents: { ...f.paseo.agents, list: hang } };
  const out = await Promise.race([
    readFleet2(paseo, call, hang, hang, 300),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 1500))
  ]);
  assert.notEqual(out, "hung", "the fleet must come back within its budget");
  const r = out;
  assert.equal(r.partial, true);
  assert.equal(r.nodes.length, 2);
  assert(r.nodes.every((n) => n.status === "unavailable"));
});
test("the node cap keeps a working session enrolled after the 64th; the chosen rows keep enrollment order", async () => {
  const f = fixture();
  for (let i = 100; i < 170; i++)
    f.rows.splice(f.rows.length - 1, 0, { id: id5(i), task, host: "Desk", mode: "human" });
  const late = id5(169), idle = {
    provider: "codex",
    model: "model",
    pendingPermissions: [],
    title: "Mini",
    updatedAt: new Date(Date.now() - 36e5).toISOString()
  };
  f.paseo.agents.list = async () => ({
    entries: f.rows.filter((r2) => r2.host === "Desk").map((r2) => ({
      agent: {
        ...idle,
        id: r2.id,
        status: r2.id === late ? "running" : "idle",
        updatedAt: r2.id === late ? at : idle.updatedAt
      }
    })),
    pageInfo: {}
  });
  const r = await readFleet2(f.paseo, f.call, f.catalog);
  assert.equal(r.total, f.rows.length);
  assert.equal(r.nodes.length, 64);
  assert.equal(
    r.nodes.filter((n) => n.status === "running").length,
    1,
    "the working session is in the fleet"
  );
  assert(r.nodes.some((n) => n.id === late));
  const order = r.nodes.map((n) => f.rows.findIndex((row) => row.id === n.id));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    "chosen rows keep enrollment order"
  );
});
test("the daemon agent listing follows its cursor; a session on page two is observed", async () => {
  const f = fixture(), pages = [];
  f.paseo.agents.list = async (o) => {
    pages.push(o.page);
    return o.page.cursor === "p2" ? {
      entries: [
        {
          agent: {
            id: id5(1),
            title: "Mini author",
            provider: "codex",
            model: "model",
            status: "running",
            pendingPermissions: [],
            updatedAt: at
          }
        }
      ],
      pageInfo: { hasMore: false, nextCursor: null }
    } : {
      entries: [
        {
          agent: {
            id: id5(50),
            title: "Other",
            provider: "codex",
            model: "model",
            status: "idle",
            pendingPermissions: [],
            updatedAt: at
          }
        }
      ],
      pageInfo: { hasMore: true, nextCursor: "p2" }
    };
  };
  const r = await readFleet2(f.paseo, f.call, f.catalog);
  assert.deepEqual(pages, [{ limit: 100 }, { limit: 100, cursor: "p2" }]);
  assert.equal(r.nodes.find((n) => n.id === id5(1)).status, "running");
});
test("server search and paging reach an idle session outside the first 64, including project scope", async () => {
  const f = fixture();
  const rows = Array.from({ length: 100 }, (_, i) => ({
    id: id5(100 + i),
    task,
    host: "Desk",
    provider: "codex",
    mode: "human"
  }));
  const entries = rows.map((r, i) => ({
    agent: {
      id: r.id,
      title: i === 0 ? "Quiet lead" : `Fixture ${i}`,
      provider: "codex",
      status: "idle",
      pendingPermissions: [],
      updatedAt: new Date(i * 1e3).toISOString()
    }
  }));
  const paseo = { agents: { list: async () => ({ entries, pageInfo: {} }) } };
  const call = async (method) => method === "list" ? rows : method === "manager-summary" ? [] : null;
  const directory = async () => ({
    available: true,
    partial: false,
    membership: [{ taskId: task, projectId: other }],
    projects: [{ id: other, name: "Fixture project" }]
  });
  const read = (input) => readFleet2(
    paseo,
    call,
    f.catalog,
    async () => ({ available: false }),
    1e3,
    input,
    directory
  );
  const first = await read({});
  assert.equal(first.nodes.length, 64);
  assert.ok(!first.nodes.some((n) => n.id === rows[0].id));
  const second = await read({ offset: first.nextOffset });
  assert.equal(second.nodes.length, 36);
  assert.ok(second.nodes.some((n) => n.id === rows[0].id));
  assert.equal(new Set([...first.nodes, ...second.nodes].map((n) => n.id)).size, 100);
  const found = await read({ search: "Quiet lead" });
  assert.deepEqual(
    found.nodes.map((n) => n.id),
    [rows[0].id]
  );
  assert.equal(found.matching, 1);
  assert.equal(found.nextOffset, null);
  assert.equal((await read({ projectId: other, offset: 64 })).nodes.length, 36);
  const empty2 = await read({ projectId: id5(777) });
  assert.equal(empty2.nodes.length, 0);
  assert.equal(empty2.partial, false);
  assert.equal((await read({ host: "Studio" })).nodes.length, 0);
});
test("a local session carries its host's background-job count for display, and nothing when absent or malformed", async () => {
  for (const [reported, expected] of [
    [{ count: 2 }, { count: 2 }],
    [void 0, void 0],
    [{ count: 0 }, void 0],
    [{ count: 1.5 }, void 0],
    [{ count: "3" }, void 0],
    [{ count: 5e3 }, void 0]
  ]) {
    const f = fixture();
    const list2 = f.paseo.agents.list;
    f.paseo.agents.list = async (o) => {
      const r2 = await list2(o);
      r2.entries[0].agent.backgroundWork = reported;
      return r2;
    };
    const r = await readFleet2(f.paseo, f.call, f.catalog), desk = r.nodes.find((n) => n.host === "Desk");
    assert.deepEqual(desk.backgroundWork, expected);
    assert.equal(desk.status, "idle", "background work never changes the recorded native status");
    assert.equal("backgroundWork" in r.nodes.find((n) => n.host === "Studio"), false);
  }
});
test("the configured Macs and their bindings come from the portable config alone (MH4)", () => {
  assert.deepEqual(readFleetHosts2(), {
    local: "Desk",
    hosts: [
      { name: "Desk", serverId: "srv_example_desk" },
      { name: "Studio", serverId: "srv_example_studio" }
    ]
  });
});
test("U5-D04 live shape: one supervisor with 7 worker rows (history included) does not blank supervision; a truly invalid record is flagged, the rest shown", async () => {
  const f = fixture(), w = (n, o = "orphaned") => ({
    requestId: id5(100 + n),
    workerId: null,
    phase: "attached",
    ownership: o,
    fault: null,
    lastEvent: null
  });
  const busy = {
    id: id5(1),
    task,
    active: false,
    maxWorkers: 2,
    reserved: 7,
    workers: [w(1, "linked"), w(2), w(3), w(4), w(5), w(6), w(7)]
  }, plain = { id: id5(2), task, active: false, maxWorkers: 1, reserved: 0, workers: [] };
  f.roles.splice(0, f.roles.length, busy, plain);
  let r = await readFleet2(f.paseo, f.call, f.catalog);
  assert.equal(r.supervisionAvailable, true);
  assert.deepEqual(
    r.supervisors?.map((s) => s.id),
    [id5(1), id5(2)]
  );
  assert.equal(r.supervisors?.[0].workers.length, 7);
  assert.deepEqual(r.supervisionIssues, { unreadable: 0, ids: [], truncated: 0 });
  f.roles.splice(0, f.roles.length, { ...busy, maxWorkers: 7 }, plain);
  r = await readFleet2(f.paseo, f.call, f.catalog);
  assert.equal(r.supervisionAvailable, true);
  assert.deepEqual(
    r.supervisors?.map((s) => s.id),
    [id5(2)]
  );
  assert.deepEqual(r.supervisionIssues, { unreadable: 1, ids: [id5(1)], truncated: 0 });
  assert.equal(r.partial, true);
});
test("U5-D10: a session's reasoning effort is reported next to its model; absent effort stays null", async () => {
  const f = fixture();
  const r0 = await readFleet2(f.paseo, f.call, f.catalog);
  assert.equal(r0.nodes[0].effort ?? null, null);
  const list2 = f.paseo.agents.list;
  f.paseo.agents.list = async (...args2) => {
    const v = await list2(...args2);
    for (const e of v.entries ?? v) (e.agent ?? e).thinkingOptionId = "high";
    return v;
  };
  const r = await readFleet2(f.paseo, f.call, f.catalog);
  assert.equal(r.nodes.find((n) => n.host === "Desk")?.effort, "high");
});
test("U5-D09: under the real read-only management gate, a local session's activity read answers with native activity (no controller observe)", async () => {
  const { withManagementInvocation: withManagementInvocation2 } = await Promise.resolve().then(() => (init_management_context(), management_context_exports));
  const f = fixture(), invoked = [];
  const context = {
    management: {
      invoke: async (command) => {
        invoked.push(command.method);
        return f.call(command.method, command.input ?? void 0);
      }
    }
  };
  const r = await withManagementInvocation2(
    context,
    true,
    () => readActivity2({ sessionId: id5(1), taskId: task }, f.paseo)
  );
  assert(r.activity.length > 0);
  assert(!invoked.includes("observe"));
  assert.equal(r.receipts[0].notification, "consumed");
});
test("update-7: a local node carries its parent, project, role and account; sessions a node started are shown under it (and their workers), never beyond the limit", async () => {
  const { attachOwnership: attachOwnership2, labelParent: labelParent2 } = await Promise.resolve().then(() => (init_fleet2(), fleet_exports2));
  const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const lead = {
    id: U(1),
    task: U(90),
    host: "This Mac",
    serverId: null,
    status: "running",
    mode: "delegated"
  };
  const remote = { id: U(2), task: U(91), host: "Book", status: "idle", mode: "delegated" };
  const nodes = [lead, remote], edges = [];
  const agent = (id6, labels, extra = {}) => ({
    agent: {
      id: id6,
      labels,
      title: `S ${id6.slice(-2)}`,
      provider: "claude",
      model: "claude-sonnet-5-5",
      thinkingOptionId: "medium",
      status: "running",
      ...extra
    }
  });
  const entries = [
    agent(U(1), { "fulcra.role": "orchestration", "fulcra.project": U(80) }),
    agent(U(3), { "paseo.parent-agent-id": U(1), "fulcra.role": "implementation", task: U(90) }),
    // paseo run from the lead
    agent(U(4), { "paseo.parent-agent-id": U(3) }),
    // its own worker
    agent(
      U(5),
      { "fulcra.parent-session": U(1), "fulcra.role": "review" },
      { archivedAt: "2026-10-01T00:00:00Z" }
    ),
    // archived: not shown
    agent(U(6), { "paseo.parent-agent-id": U(77) })
    // parent not here: not shown
  ];
  attachOwnership2(
    nodes,
    edges,
    entries,
    "This Mac",
    (id6) => id6 === U(3) ? { name: "Work", provider: "claude" } : null
  );
  assert.equal(labelParent2({ "paseo.parent-agent-id": "nope" }), null);
  assert.deepEqual(
    [lead.role, lead.project, lead.origin, remote.origin],
    ["orchestration", U(80), "enrolled", "enrolled"]
  );
  const child = nodes.find((n) => n.id === U(3)), grandchild = nodes.find((n) => n.id === U(4));
  assert.deepEqual(
    [
      child.parent,
      child.task,
      child.project,
      child.role,
      child.origin,
      child.account?.name,
      child.effort
    ],
    [U(1), U(90), U(80), "implementation", "spawned", "Work", "medium"]
  );
  assert.equal(grandchild.parent, U(3));
  assert.equal(grandchild.task, U(90));
  assert.equal(
    nodes.some((n) => n.id === U(5) || n.id === U(6)),
    false
  );
  assert.deepEqual(
    edges.map((e) => [e.from.slice(-1), e.to.slice(-1), e.state]),
    [
      ["1", "3", "spawned"],
      ["3", "4", "spawned"]
    ]
  );
  const full = Array.from({ length: 64 }, (_, i) => ({
    id: U(100 + i),
    task: U(90),
    host: "This Mac",
    status: "idle"
  }));
  full[0] = { ...lead };
  attachOwnership2(full, [], entries, "This Mac", () => null);
  assert.equal(full.length, 64, "never beyond the node limit");
});
test("Sessions account labels survive strict fleet projection and follow A to B to A", async () => {
  const { attachOwnership: attachOwnership2 } = await Promise.resolve().then(() => (init_fleet2(), fleet_exports2));
  const { fleetNode: fleetNode2 } = await Promise.resolve().then(() => (init_fleet(), fleet_exports));
  const node = {
    id: id5(1),
    task,
    host: "This Mac",
    agentId: id5(1),
    title: "Chat",
    provider: "claude",
    model: null,
    mode: "human",
    status: "idle",
    pending: 0,
    observedAt: at,
    updatedAt: at,
    error: null
  };
  for (const provider2 of ["claude", "codex"]) {
    for (const name2 of ["Alpha", "Beta", "Alpha"]) {
      attachOwnership2([node], [], [{ agent: { id: node.id } }], "This Mac", () => ({
        id: id5(2),
        name: name2,
        provider: provider2
      }));
      assert.deepEqual(fleetNode2.parse(node).account, { name: name2, provider: provider2 });
    }
    attachOwnership2([node], [], [{ agent: { id: node.id } }], "This Mac", () => null);
    assert.equal(fleetNode2.parse(node).account, null, "removed assignments clear the old label");
  }
});
test("lead sessions stay in the capped fleet when nothing is working or recently active", () => {
  const rows = Array.from({ length: 70 }, (_, i) => ({ id: `s${i}` }));
  const ids = (picked) => new Set(picked.map((r) => r.id));
  const plain = ids(chooseRows2(rows, []));
  assert.equal(plain.size, 64);
  assert.equal(plain.has("s0"), false, "without pinning, the oldest session drops out");
  const pinned = ids(chooseRows2(rows, [], 64, /* @__PURE__ */ new Set(["s0", "s3"])));
  assert.equal(pinned.size, 64);
  assert.ok(pinned.has("s0") && pinned.has("s3"), "lead sessions are always kept");
  assert.deepEqual(
    [
      ...leadSessions2({
        status: "fulfilled",
        value: {
          bindings: [
            { role: "prime", state: "assigned", sessionId: "s0" },
            { role: "project-orchestrator", state: "assigned", sessionId: "s3" },
            { role: "project-orchestrator", state: "vacant", sessionId: null },
            { role: "manager", state: "assigned", sessionId: "s9" }
          ]
        }
      })
    ],
    ["s0", "s3"]
  );
  assert.equal(leadSessions2({ status: "rejected", reason: new Error("down") }).size, 0);
});
