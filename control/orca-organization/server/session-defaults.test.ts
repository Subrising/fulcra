// DESIGN-NEXT-BUILD A3.3/A3.4 (C12): the desktop path. A creation labelled with a role and no model / effort of its own
// gets the role's configured values when the installed provider offers them; explicit form values, unlabelled
// creations, an unavailable model list and anything unreadable leave the request exactly as it came.
import test from "node:test";
import assert from "node:assert/strict";
import { applyRoleDefaults, createSessionDefaultsReader, projectRoleDefaults, roleDefaultsHook } from "./session-defaults";
import { SESSION_ROLE_LABEL, sessionDefaultsRpc } from "../shared/session-defaults";

const effort = ["low", "medium", "high", "max"].map(id => ({ id }));
const OPUS = { id: "claude-opus-5-5", provider: "claude", isDefault: true, thinkingOptions: [...effort, { id: "xhigh" }] };
const SONNET = { id: "claude-sonnet-5-5", provider: "claude", thinkingOptions: effort };
const ROLES = {
  planning: { claude: { model: "claude/claude-opus-5-5", thinkingOptionId: "high" } },
  orchestration: { claude: { model: "claude/claude-opus-5-5", thinkingOptionId: "medium" } },
  implementation: { provider: "claude", claude: { model: "claude/claude-sonnet-5-5", thinkingOptionId: "high" } },
};
type Req = { config: { provider: string; cwd?: string; model?: string | null; thinkingOptionId?: string | null; modeId?: string | null }; env?: Record<string, string>; labels?: Record<string, string> };
const request = (labels?: Record<string, string>, config: Partial<Req["config"]> = {}): Req => ({ config: { provider: "claude", cwd: "/project", ...config }, env: {}, ...(labels ? { labels } : {}) });
const listing = (models: unknown[]) => { const calls: string[] = []; return { calls, list: async (p: string) => { calls.push(p); return { provider: p, models } as any; } }; };

test("a role-labelled creation with no model or effort gets the role's values", async () => {
  const { list } = listing([OPUS, SONNET]);
  const out = await applyRoleDefaults(request({ [SESSION_ROLE_LABEL]: "implementation" }), ROLES, list);
  assert.deepEqual([out.config.model, out.config.thinkingOptionId], ["claude-sonnet-5-5", "high"]);
  const lead = await applyRoleDefaults(request({ [SESSION_ROLE_LABEL]: "orchestration" }), ROLES, list);
  assert.deepEqual([lead.config.model, lead.config.thinkingOptionId], ["claude-opus-5-5", "medium"]);
  assert.deepEqual(out.labels, { [SESSION_ROLE_LABEL]: "implementation" }, "labels pass through untouched");
});

test("explicit values are never replaced; no label, an unknown role or a provider without an entry is exactly as before", async () => {
  const { list, calls } = listing([OPUS, SONNET]);
  const explicit = request({ [SESSION_ROLE_LABEL]: "implementation" }, { model: "claude-opus-5-5", thinkingOptionId: "low" });
  assert.equal(await applyRoleDefaults(explicit, ROLES, list), explicit);
  const partial = await applyRoleDefaults(request({ [SESSION_ROLE_LABEL]: "implementation" }, { model: "claude-opus-5-5" }), ROLES, list);
  assert.deepEqual([partial.config.model, partial.config.thinkingOptionId], ["claude-opus-5-5", "high"], "only the absent field is filled");
  for (const r of [request(), request({ [SESSION_ROLE_LABEL]: "reviewer" }), request({ other: "x" })]) assert.equal(await applyRoleDefaults(r, ROLES, list), r);
  const codex: Req = { config: { provider: "codex", cwd: "/project" }, labels: { [SESSION_ROLE_LABEL]: "implementation" } };
  assert.equal(await applyRoleDefaults(codex, ROLES, list), codex);
  assert.deepEqual(calls, ["claude"], "no provider call where no role value applies");
});

test("a model or effort the provider does not offer, or an unavailable list, falls back to the daemon's own default", async () => {
  const withoutSonnet = await applyRoleDefaults(request({ [SESSION_ROLE_LABEL]: "implementation" }), ROLES, listing([OPUS]).list);
  assert.deepEqual([withoutSonnet.config.model, withoutSonnet.config.thinkingOptionId], [undefined, "high"], "model dropped; the effort still applies to the default model");
  const xhigh = { planning: { claude: { model: "claude/claude-sonnet-5-5", thinkingOptionId: "xhigh" } } };
  const noEffort = await applyRoleDefaults(request({ [SESSION_ROLE_LABEL]: "planning" }), xhigh, listing([OPUS, SONNET]).list);
  assert.deepEqual([noEffort.config.model, noEffort.config.thinkingOptionId], ["claude-sonnet-5-5", undefined]);
  const r = request({ [SESSION_ROLE_LABEL]: "planning" });
  assert.equal(await applyRoleDefaults(r, ROLES, async () => { throw new Error("probe timed out"); }), r);
  assert.equal(await applyRoleDefaults(r, ROLES, async () => ({ provider: "claude", error: "unavailable" }) as any), r);
  const wrongFamily = { planning: { claude: { model: "codex/gpt-6-astra" } } };
  assert.equal(await applyRoleDefaults(r, wrongFamily, listing([OPUS]).list), r);
});

test("the registered hook never refuses: unreadable config or a failing host leaves the request as it came", async () => {
  const r = request({ [SESSION_ROLE_LABEL]: "planning" });
  // No stored modes here (the mode default has its own test below), so only the role values are under test.
  const noModes = () => ({});
  assert.equal(await roleDefaultsHook(() => { throw new Error("not configured"); }, noModes)({ request: r }, { paseo: {} }), r);
  assert.equal(await roleDefaultsHook(() => undefined, noModes)({ request: r }, { paseo: {} }), r);
  assert.equal(await roleDefaultsHook(() => ROLES, noModes)({ request: r }, { paseo: { providers: { listModels: () => { throw new Error("gone"); } } } }), r);
  const seen: unknown[] = [];
  const out = await roleDefaultsHook(() => ROLES, noModes)({ request: r }, { paseo: { providers: { listModels: async (p: string, o: unknown) => { seen.push([p, o]); return { provider: p, models: [OPUS] }; } } } });
  assert.deepEqual([out.config.model, out.config.thinkingOptionId], ["claude-opus-5-5", "high"]);
  assert.deepEqual(seen, [["claude", { cwd: "/project" }]]);
});

test("the picker table is the controller's session-defaults roles, bare model ids, nothing else", async () => {
  const controller = {
    providers: { claude: { model: "claude/claude-opus-5-5" } }, refused: {}, settings: {},
    roles: {
      implementation: { provider: "claude", providers: { claude: { configured: { model: "claude/claude-sonnet-5-5", thinkingOptionId: "high", source: "role" }, effective: { model: "claude", thinkingOptionId: "high", source: "product-default" }, status: "falls-back", fallback: [{ field: "model", requested: "claude/claude-sonnet-5-5", used: "claude", reason: "model-not-offered" }] } } },
      planning: { provider: null, providers: { claude: { configured: { model: "claude/claude-opus-5-5", thinkingOptionId: "high" }, effective: null, status: "unknown", error: "/private/path detail" } } },
    },
  };
  const calls: unknown[] = [];
  const table = await createSessionDefaultsReader(async (m, i) => { calls.push([m, i]); return controller; }, () => { throw Error("no store in this test"); })();
  assert.deepEqual(calls, [["session-defaults", null]]);
  assert.deepEqual(table, { roles: {
    implementation: { provider: "claude", providers: { claude: { status: "falls-back", configured: { model: "claude-sonnet-5-5", thinkingOptionId: "high" }, effective: { model: "claude", thinkingOptionId: "high" } } } },
    planning: { provider: null, providers: { claude: { status: "unknown", configured: { model: "claude-opus-5-5", thinkingOptionId: "high" }, effective: null } } },
  } });
  assert.doesNotMatch(JSON.stringify(table), /private|fallback|source/);
  assert.deepEqual(projectRoleDefaults(undefined), { roles: {} }, "a controller without roles answers an empty table");
});

test("the app-facing names are pinned: the RPC method and the label", () => {
  // CROSS-TREE CONTRACT, as for organization.session-ownership: the app states these literals in
  // packages/protocol/src/session-roles.ts and neither tree can import the other.
  assert.equal(sessionDefaultsRpc.name, "organization.session-defaults");
  assert.equal(SESSION_ROLE_LABEL, "fulcra.role");
  // Update-7 W3: `modes` (optional), mirrored in packages/protocol/src/session-roles.ts.
  assert.deepEqual(Object.keys(sessionDefaultsRpc.output.shape), ["roles", "modes"]);
});

// Update-7 W3: the desktop new-session flow and `paseo run` from a session (labelled implementation by the daemon) get
// the owner's rule from the store with nothing chosen in Settings; an explicit form value still wins.
test("W3: the create hook applies the stored rule: leads Opus medium, implementers Sonnet medium or gpt-6.1-sol medium", async () => {
  const { readRoleDefaults, hookRoles } = await import("./role-defaults-store.mjs");
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const roles = hookRoles(readRoleDefaults(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fulcra-hook-rule-")))));
  const SOL = { id: "gpt-6.1-sol", provider: "codex", thinkingOptions: effort };
  const lead = await applyRoleDefaults(request({ [SESSION_ROLE_LABEL]: "orchestration" }), roles, listing([OPUS, SONNET]).list);
  assert.deepEqual([lead.config.model, lead.config.thinkingOptionId], ["claude-opus-5-5", "medium"]);
  const review = await applyRoleDefaults(request({ [SESSION_ROLE_LABEL]: "review" }), roles, listing([OPUS, SONNET]).list);
  assert.deepEqual([review.config.model, review.config.thinkingOptionId], ["claude-opus-5-5", "medium"]);
  const worker = await applyRoleDefaults(request({ [SESSION_ROLE_LABEL]: "implementation" }), roles, listing([OPUS, SONNET]).list);
  assert.deepEqual([worker.config.model, worker.config.thinkingOptionId], ["claude-sonnet-5-5", "medium"]);
  const codex = await applyRoleDefaults(request({ [SESSION_ROLE_LABEL]: "implementation" }, { provider: "codex" }), roles, listing([SOL]).list);
  assert.deepEqual([codex.config.model, codex.config.thinkingOptionId], ["gpt-6.1-sol", "medium"]);
  const chosen = await applyRoleDefaults(request({ [SESSION_ROLE_LABEL]: "implementation" }, { model: "claude-opus-5-5", thinkingOptionId: "high" }), roles, listing([OPUS, SONNET]).list);
  assert.deepEqual([chosen.config.model, chosen.config.thinkingOptionId], ["claude-opus-5-5", "high"]);
});

// Update-7 W3 (owner, 01:29Z): every daemon create that names no mode (`paseo run`, agent-tools create_agent, a phone or
// remote create) gets the stored per-provider default -- Claude auto, Codex full-access unless changed in Settings. An
// explicit mode wins; a provider the store has no mode for is left alone.
test("W3: the create hook applies the default permission mode when the request names none", async () => {
  const { applyModeDefault, roleDefaultsHook } = await import("./session-defaults");
  const modes = { claude: "auto", codex: "full-access" };
  assert.equal(applyModeDefault(request(undefined, { provider: "codex" }), modes).config.modeId, "full-access");
  assert.equal(applyModeDefault(request(undefined, { provider: "claude" }), modes).config.modeId, "auto");
  const explicit = { ...request(undefined, { provider: "codex" }), config: { provider: "codex", cwd: "/project", modeId: "auto-review" } } as any;
  assert.equal(applyModeDefault(explicit, modes).config.modeId, "auto-review");
  const other = request(undefined, { provider: "opencode" });
  assert.equal(applyModeDefault(other, modes), other);
  // Registered hook: role defaults and the mode together; unreadable modes leave the mode to the daemon.
  const hook = roleDefaultsHook(() => ROLES, () => ({ claude: "acceptEdits", codex: "auto" }));
  const out = await hook({ request: request({ [SESSION_ROLE_LABEL]: "implementation" }) as any }, { paseo: { providers: { listModels: listing([OPUS, SONNET]).list } } });
  assert.deepEqual([out.config.model, out.config.modeId], ["claude-sonnet-5-5", "acceptEdits"]);
  const broken = roleDefaultsHook(() => ROLES, () => { throw Error("unreadable"); });
  const kept = await broken({ request: request(undefined, { provider: "codex" }) as any }, { paseo: { providers: { listModels: listing([]).list } } });
  assert.equal(kept.config.modeId, undefined);
});

test("W3: the session-defaults read carries the default modes, for the app form to pre-fill", async () => {
  const read = createSessionDefaultsReader(async () => ({ roles: {} }), () => ({ claude: "auto", codex: "full-access" }));
  assert.deepEqual((await read()).modes, { claude: "auto", codex: "full-access" });
  const noModes = createSessionDefaultsReader(async () => ({ roles: {} }), () => { throw Error("unreadable"); });
  assert.equal((await noModes()).modes, undefined);
});

// R1 P-3 seam (owner decision pending): the daemon shows the hook the caller's mode class on a child create
// (automatic / restricted / unknown). A restricted caller's child already arrives with a restricted mode (the daemon
// inherits the restriction class), so only automatic-caller and caller-less creates reach the default unset.
// childModeDefault is the one place a child policy goes; today it is the stored default, unchanged.
test("P-3 seam: the hook passes the caller's mode class to childModeDefault, which today keeps the stored default", async () => {
  const { childModeDefault, roleDefaultsHook } = await import("./session-defaults");
  const modes = { claude: "auto", codex: "full-access" };
  assert.equal(childModeDefault(modes, "codex", undefined), "full-access");
  // Interim conservative rule (COORD 04:0xZ): a Claude-auto caller's Codex child is capped at reviewed.
  assert.equal(childModeDefault(modes, "codex", { provider: "claude", modeId: "auto", modeClass: "automatic" }), "auto-review");
  const calls: unknown[] = [];
  const hook = roleDefaultsHook(() => undefined, () => modes, (m, p, caller) => { calls.push([p, caller]); return childModeDefault(m, p, caller); });
  const caller = { provider: "claude", modeId: "auto", modeClass: "automatic" as const };
  const out = await hook({ request: { ...request(undefined, { provider: "codex" }), caller } as any }, { paseo: {} });
  assert.equal(out.config.modeId, "auto-review");
  assert.deepEqual(calls, [["codex", caller]]);
});

// Orchestrator rule until the owner decides P-3 (COORD 04:0xZ): a child's mode is the MORE RESTRICTIVE of its own
// provider's stored default and its caller's class (ask/plan < reviewed < unattended). Top-level creates keep the owner's
// defaults; an explicit mode chosen by the owner or a lead still wins.
test("P-3 interim: a child never gets a more permissive class than its caller", async () => {
  const { childModeDefault, applyModeDefault } = await import("./session-defaults");
  const modes = { claude: "auto", codex: "full-access" };
  const from = (provider: string, modeId: string, modeClass: "automatic" | "restricted" | "unknown" = "automatic") => ({ provider, modeId, modeClass });
  assert.equal(childModeDefault(modes, "codex", from("claude", "auto")), "auto-review", "Claude auto -> Codex child: reviewed");
  assert.equal(childModeDefault(modes, "claude", from("codex", "full-access")), "auto", "Codex full-access -> Claude child: Claude's own default");
  assert.equal(childModeDefault(modes, "codex", from("codex", "full-access")), "full-access", "an unattended caller's same-class child");
  assert.equal(childModeDefault(modes, "codex", undefined), "full-access", "top-level Codex keeps the owner's default");
  assert.equal(childModeDefault(modes, "claude", undefined), "auto");
  // R1 P-8 (b): a restricted or unknown caller's child gets NO owner default here, so the daemon's conservative default
  // applies (the daemon already inherited the caller's restriction class on every create path that passes a parent).
  assert.equal(childModeDefault(modes, "codex", from("claude", "plan", "restricted")), undefined, "a plan caller");
  assert.equal(childModeDefault(modes, "claude", from("codex", "auto-review", "restricted")), undefined);
  assert.equal(childModeDefault(modes, "codex", from("opencode", "build", "unknown")), undefined, "an unknown caller");
  assert.equal(applyModeDefault({ config: { provider: "codex", cwd: "/p" }, caller: from("claude", "default", "restricted") } as any, modes).config.modeId, undefined);
  assert.equal(childModeDefault({ claude: "default", codex: "auto" }, "codex", from("claude", "auto")), "auto", "a stricter stored default is kept");
  // An explicit mode on a child is honoured (the owner or a lead asked for it); the hook never replaces it.
  const explicit = { config: { provider: "codex", cwd: "/project", modeId: "full-access" }, caller: from("claude", "auto") } as any;
  assert.equal(applyModeDefault(explicit, modes).config.modeId, "full-access");
});
