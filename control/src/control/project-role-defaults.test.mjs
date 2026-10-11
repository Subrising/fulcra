// FU-114: a project can override the provider, model and effort of a role for its own sessions only.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionDefaults, roleProvider } from "./provider-mode.mjs";
import {
  readRoleDefaults,
  writeRoleDefaults,
  configuredRoleProvider,
  projectRoleOverrides,
} from "../../orca-organization/server/role-defaults-store.mjs";

const FULCRA = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const home = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "fulcra-project-roles-")));
const CODEX_HIGH = {
  provider: "codex",
  codex: { model: "codex/gpt-6.1-sol", thinkingOptionId: "high" },
};

test("a project's role entry changes that project's provider, model and effort, and no other project's", async () => {
  const root = home();
  const config = { home: root, defaults: {} };
  const before = sessionDefaults("claude", {}, config, "implementation", OTHER);
  await writeRoleDefaults(root, { project: FULCRA, role: "implementation", defaults: CODEX_HIGH });
  // Fulcra: Codex by default, with its model and effort.
  assert.equal(roleProvider("implementation", config, FULCRA), "codex");
  const mine = sessionDefaults("codex", {}, config, "implementation", FULCRA);
  assert.deepEqual([mine.model, mine.thinkingOptionId], ["codex/gpt-6.1-sol", "high"]);
  assert.equal(mine.source.model, "role");
  // Another project, and a create with no project, keep the installation's answer.
  assert.equal(roleProvider("implementation", config, OTHER), null);
  assert.equal(roleProvider("implementation", config, null), null);
  assert.deepEqual(sessionDefaults("claude", {}, config, "implementation", OTHER), before);
  assert.deepEqual(sessionDefaults("claude", {}, config, "implementation"), before);
  assert.equal(readRoleDefaults(root).roles.implementation.provider, "claude");
  // A role the project does not name keeps the installation's answer inside that project.
  assert.equal(roleProvider("planning", config, FULCRA), null);
  assert.deepEqual(
    sessionDefaults("claude", {}, config, "planning", FULCRA),
    sessionDefaults("claude", {}, config, "planning"),
  );
});

test("an explicit model or effort on a create still wins over the project's entry", async () => {
  const root = home();
  const config = { home: root, defaults: {} };
  await writeRoleDefaults(root, { project: FULCRA, role: "implementation", defaults: CODEX_HIGH });
  const d = sessionDefaults("codex", { thinkingOptionId: "low" }, config, "implementation", FULCRA);
  assert.deepEqual([d.thinkingOptionId, d.source.thinkingOptionId], ["low", "override"]);
});

test("clearing a project's role restores the installation's answer, and the file keeps no empty project", async () => {
  const root = home();
  const config = { home: root, defaults: {} };
  await writeRoleDefaults(root, { project: FULCRA, role: "implementation", defaults: CODEX_HIGH });
  assert.deepEqual(Object.keys(projectRoleOverrides(root)), [FULCRA]);
  await writeRoleDefaults(root, { project: FULCRA, role: "implementation", defaults: null });
  assert.equal(roleProvider("implementation", config, FULCRA), null);
  assert.deepEqual(projectRoleOverrides(root), {});
  const stored = JSON.parse(fs.readFileSync(path.join(root, "accounts", "defaults.json"), "utf8"));
  assert.equal(Object.hasOwn(stored, "projects"), false);
});

test("a project override survives an installation-wide save, and the installation save does not leak into it", async () => {
  const root = home();
  await writeRoleDefaults(root, { project: FULCRA, role: "review", defaults: CODEX_HIGH });
  await writeRoleDefaults(root, {
    role: "review",
    defaults: {
      provider: "claude",
      claude: { model: "claude/claude-opus-5-5", thinkingOptionId: "low" },
    },
  });
  assert.equal(configuredRoleProvider(root, null, "review", FULCRA), "codex");
  assert.equal(configuredRoleProvider(root, null, "review", OTHER), "claude");
  assert.equal(
    readRoleDefaults(root, null, null, OTHER).roles.review.claude.thinkingOptionId,
    "low",
  );
});

test("a project id must be a UUID and the role a known one; nothing is written otherwise", async () => {
  const root = home();
  for (const bad of [
    { project: "__proto__", role: "review", defaults: CODEX_HIGH },
    { project: "not-a-uuid", role: "review", defaults: CODEX_HIGH },
    { project: FULCRA, role: "wizard", defaults: CODEX_HIGH },
  ])
    await assert.rejects(writeRoleDefaults(root, bad));
  assert.deepEqual(projectRoleOverrides(root), {});
  // A hand-edited file with a prototype-named project is ignored by the readers.
  fs.mkdirSync(path.join(root, "accounts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "accounts", "defaults.json"),
    JSON.stringify({ v: 1, projects: { constructor: { roles: { review: CODEX_HIGH } } } }),
  );
  assert.equal(configuredRoleProvider(root, null, "review", "constructor"), null);
});
