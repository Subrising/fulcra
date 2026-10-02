// DESIGN-NEXT-BUILD A2 (C6): the optional defaults.roles setting. Structural checks in validateConfig, value checks in
// provider-mode's configuredDefaults, and a config without it loads exactly as before.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { firstRun, loadConfig, validateConfig, SESSION_ROLES } from "./config.mjs";
import { configuredDefaults } from "./control/provider-mode.mjs";

const temporary = (run) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-roles-")));
  try {
    return run(base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
};
const plain = (c) => {
  const v = JSON.parse(JSON.stringify(c));
  for (const k of ["home", "controller", "daemonHome", "memoryRoot", "tasks", "url"]) delete v[k];
  if (v.outcomesRoot === path.join(c.home, "memory")) delete v.outcomesRoot;
  return v;
};
// The owner's table (prime 29 Sep): the value the migration writes.
export const OWNER_ROLES = {
  planning: { claude: { model: "claude/claude-opus-5-5", thinkingOptionId: "high" } },
  orchestration: { claude: { model: "claude/claude-opus-5-5", thinkingOptionId: "medium" } },
  implementation: {
    provider: "claude",
    claude: { model: "claude/claude-sonnet-5-5", thinkingOptionId: "high" },
  },
};

test("the three roles are a closed set", () =>
  assert.deepEqual([...SESSION_ROLES], ["planning", "orchestration", "implementation"]));

test("defaults.roles in the approved shape is accepted by both validators", () =>
  temporary((base) => {
    const c = {
      ...plain(firstRun({ ORCA_HOME: path.join(base, "cc") })),
      defaults: { thinkingOptionId: "medium", roles: OWNER_ROLES },
    };
    assert.deepEqual(validateConfig(c).defaults.roles, OWNER_ROLES);
    assert.deepEqual(configuredDefaults(c).roles, OWNER_ROLES);
    const withMode = {
      ...c,
      defaults: {
        roles: {
          planning: {
            codex: { model: "codex/gpt-6-astra", thinkingOptionId: "high", modeId: "auto-review" },
          },
        },
      },
    };
    assert.equal(
      configuredDefaults(validateConfig(withMode)).roles.planning.codex.modeId,
      "auto-review",
    );
  }));

test("unknown roles, keys, providers, families, thinking levels and refused modes are refused", () =>
  temporary((base) => {
    const c = plain(firstRun({ ORCA_HOME: path.join(base, "cc") }));
    const bad = (roles) => ({ ...c, defaults: { roles } });
    // Structural (validateConfig; loadConfig would refuse to start on these).
    assert.throws(
      () => validateConfig(bad({ reviewer: {} })),
      /Unknown setting defaults.roles.reviewer/,
    );
    assert.throws(
      () => validateConfig(bad({ planning: { gemini: {} } })),
      /Unknown setting defaults.roles.planning.gemini/,
    );
    assert.throws(
      () => validateConfig(bad({ planning: { provider: "gemini" } })),
      /defaults.roles.planning.provider/,
    );
    assert.throws(
      () => validateConfig(bad({ planning: { claude: { effort: "high" } } })),
      /Unknown setting defaults.roles.planning.claude.effort/,
    );
    assert.throws(
      () => validateConfig(bad({ planning: { claude: { thinkingOptionId: "extreme" } } })),
      /defaults.roles.planning.claude.thinkingOptionId/,
    );
    assert.throws(() => validateConfig(bad([])), /Invalid setting defaults.roles/);
    // Values (configuredDefaults, at spawn).
    assert.throws(
      () => configuredDefaults(bad({ planning: { claude: { model: "codex/gpt-6-astra" } } })),
      /must name the claude family/,
    );
    assert.throws(
      () => configuredDefaults(bad({ planning: { claude: { model: "claude/x; rm -rf /" } } })),
      /Invalid model selection/,
    );
    assert.throws(
      () => configuredDefaults(bad({ planning: { claude: { modeId: "bypassPermissions" } } })),
      /Refused mode for claude/,
    );
    // Update-7 W3: Codex full-access is owner-approved, so a role may name it.
    assert.equal(
      configuredDefaults(bad({ planning: { codex: { modeId: "full-access" } } })).roles.planning
        .codex.modeId,
      "full-access",
    );
    assert.throws(
      () => configuredDefaults(bad({ planning: { claude: { modeId: "autoo" } } })),
      /Unsupported mode for claude/,
    );
    assert.throws(
      () => configuredDefaults(bad(JSON.parse('{"planning":{"__proto__":{}}}'))),
      /Refused key __proto__/,
    );
  }));

test("a config without roles loads exactly as before", () =>
  temporary((base) => {
    const env = { ORCA_HOME: path.join(base, "cc") },
      first = firstRun(env);
    assert.equal(Object.hasOwn(first.defaults, "roles"), false);
    assert.deepEqual(loadConfig(env), first);
    assert.deepEqual(configuredDefaults(first), {});
  }));
