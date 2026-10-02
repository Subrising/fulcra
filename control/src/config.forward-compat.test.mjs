// L44: a config written for a newer build must not stop an older build. At the top level and directly under
// `defaults`, keys this build does not know are ignored and kept (a write-back never drops them); every key it knows is
// validated exactly as before, and deeper objects stay closed.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  firstRun,
  loadConfig,
  validateConfig,
  unknownSettings,
  worktreeLifecycleSettings,
} from "./config.mjs";
import { configuredDefaults } from "./control/provider-mode.mjs";

const ROLES = {
  implementation: {
    provider: "claude",
    claude: { model: "claude/claude-sonnet-5-5", thinkingOptionId: "high" },
  },
};
function home(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-forward-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const env = { ORCA_HOME: path.join(base, "cc") };
  firstRun(env);
  const file = path.join(env.ORCA_HOME, "config.json");
  const write = (c) => {
    fs.writeFileSync(file, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  };
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  return { env, base, write, read };
}
const future = (c, base) => ({
  ...c,
  memoryRoot: base,
  futureSetting: { anything: [1, 2] },
  defaults: { ...c.defaults, roles: ROLES, futureDefault: "x" },
});

test("memoryRoot, defaults.roles and settings from a newer build load; the unknown ones are reported, not thrown", (t) => {
  const h = home(t);
  h.write(future(h.read(), h.base));
  const c = loadConfig(h.env);
  assert.equal(c.memoryRoot, h.base);
  assert.deepEqual(c.defaults.roles, ROLES);
  assert.deepEqual(unknownSettings(h.read()), ["futureSetting", "defaults.futureDefault"]);
  assert.deepEqual(
    configuredDefaults(c).roles,
    ROLES,
    "the session-defaults reader ignores the unknown default and still reads roles",
  );
});

test("a write-back keeps every setting, known or not", async (t) => {
  const h = home(t);
  const before = future(h.read(), h.base);
  h.write(before);
  await worktreeLifecycleSettings(h.env).set(30);
  assert.deepEqual(h.read(), { ...before, worktreeLifecycle: { retentionDays: 30 } });
});

test("known settings are validated exactly as before, and deeper objects stay closed", (t) => {
  const h = home(t);
  const c = h.read();
  for (const [bad, message] of [
    [{ ...c, memoryRoot: "relative/path" }, /Invalid setting memoryRoot/],
    [
      { ...c, defaults: { thinkingOptionId: "extreme" } },
      /Invalid setting defaults.thinkingOptionId/,
    ],
    [{ ...c, defaults: { roles: { reviewer: {} } } }, /Unknown setting defaults.roles.reviewer/],
    [{ ...c, daemon: { url: null, extra: 1 } }, /Unknown setting daemon.extra/],
    [{ ...c, version: 3 }, /Invalid setting version/],
    [(({ authority, ...rest }) => rest)(c), /Missing setting config.authority/],
    [{ ...c, defaults: [] }, /Invalid setting defaults/],
  ])
    assert.throws(() => validateConfig(bad), message);
  assert.throws(
    () => configuredDefaults({ defaults: { thinkingOptionId: "extreme", futureDefault: 1 } }),
    /Unsupported thinking option/,
  );
});
