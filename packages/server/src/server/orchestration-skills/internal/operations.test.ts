import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  autoUpdateInstalledSkills,
  getSkillsStatus,
  installSkills,
  LEGACY_SKILL_NAMES,
  type SkillSelection,
  type SkillTargets,
  uninstallSkills,
  updateSkills,
} from "./operations";
import { resolveBundledSkillsDir } from "./paths";

const ALL_SKILLS: SkillSelection = { mode: "all" };

describe("shipped Fulcra skill", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    await fs.cp(resolveBundledSkillsDir(), sandbox.targets.sourceDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true });
  });

  it("installs the shipped skill for Claude and shared Codex discovery without a duplicate", async () => {
    const status = await installSkills(sandbox.targets, ALL_SKILLS);

    expect(status.available).toContain("fulcra");
    expect(status.state).toBe("up-to-date");
    expect(status.ops).toEqual([]);
    const bundled = await fs.readFile(path.join(sandbox.targets.sourceDir, "fulcra", "SKILL.md"));
    for (const dir of [sandbox.targets.agentsDir, sandbox.targets.claudeDir]) {
      expect(await fs.readFile(path.join(dir, "fulcra", "SKILL.md"))).toEqual(bundled);
    }
    expect(await installedIn(sandbox.targets, "fulcra")).toEqual([true, true, false]);
    expect(await installedIn(sandbox.targets, "paseo")).toEqual([true, true, false]);
    expect(await getSkillsStatus(sandbox.targets, ALL_SKILLS)).toEqual(status);
  });

  it("detects and updates an untracked shipped version", async () => {
    await installSkills(sandbox.targets, ALL_SKILLS);
    const file = path.join(sandbox.targets.agentsDir, "fulcra/SKILL.md");
    await fs.writeFile(file, "old released version");
    await fs.rm(path.join(path.dirname(file), ".paseo-managed-files.json"));
    const historyPath = path.join(sandbox.targets.sourceDir, ".bundled-skill-hashes.json");
    const history = JSON.parse(await fs.readFile(historyPath, "utf8"));
    history.files["fulcra/SKILL.md"].push(
      createHash("sha256").update("old released version").digest("hex"),
    );
    await fs.writeFile(historyPath, JSON.stringify(history));
    expect((await getSkillsStatus(sandbox.targets, ALL_SKILLS)).ops).toEqual([
      { kind: "update", name: "fulcra" },
    ]);
    expect((await autoUpdateInstalledSkills(sandbox.targets, ALL_SKILLS)).state).toBe("up-to-date");
    expect(await fs.readFile(file)).toEqual(
      await fs.readFile(path.join(sandbox.targets.sourceDir, "fulcra/SKILL.md")),
    );
  });

  it("repairs the shared Codex copy on startup without creating a dedicated copy", async () => {
    await installSkills(sandbox.targets, ALL_SKILLS);
    await fs.rm(path.join(sandbox.targets.agentsDir, "fulcra"), { recursive: true });
    expect((await getSkillsStatus(sandbox.targets, ALL_SKILLS)).ops).toEqual([
      { kind: "add", name: "fulcra" },
    ]);

    expect((await autoUpdateInstalledSkills(sandbox.targets, ALL_SKILLS)).state).toBe("up-to-date");
    expect(await installedIn(sandbox.targets, "fulcra")).toEqual([true, true, false]);
    expect((await autoUpdateInstalledSkills(sandbox.targets, ALL_SKILLS)).ops).toEqual([]);
  });

  it("retires a managed dedicated Codex copy from the earlier slice and preserves user files", async () => {
    await installSkills(sandbox.targets, ALL_SKILLS);
    const codexSkill = path.join(sandbox.targets.codexDir, "fulcra");
    const bundled = await fs.readFile(
      path.join(sandbox.targets.sourceDir, "fulcra", "SKILL.md"),
      "utf8",
    );
    await writeFiles(codexSkill, {
      "SKILL.md": bundled,
      "my-notes.md": "keep",
      ".paseo-managed-files.json": JSON.stringify({
        version: 1,
        files: { "SKILL.md": createHash("sha256").update(bundled).digest("hex") },
      }),
    });
    expect((await getSkillsStatus(sandbox.targets, ALL_SKILLS)).ops).toEqual([
      { kind: "update", name: "fulcra" },
    ]);

    expect((await updateSkills(sandbox.targets, ALL_SKILLS)).state).toBe("up-to-date");
    expect(await pathExists(path.join(codexSkill, "SKILL.md"))).toBe(false);
    expect(await pathExists(path.join(codexSkill, ".paseo-managed-files.json"))).toBe(false);
    for (const dir of [sandbox.targets.agentsDir, sandbox.targets.claudeDir]) {
      expect(await fs.readFile(path.join(dir, "fulcra", "SKILL.md"), "utf8")).toBe(bundled);
    }
    expect(await fs.readFile(path.join(codexSkill, "my-notes.md"), "utf8")).toBe("keep");
    expect((await autoUpdateInstalledSkills(sandbox.targets, ALL_SKILLS)).ops).toEqual([]);
  });

  it("respects custom selection and removes the shared and Claude copies on explicit deselection", async () => {
    await installSkills(sandbox.targets, only("paseo"));
    expect(await installedIn(sandbox.targets, "fulcra")).toEqual([false, false, false]);
    await installSkills(sandbox.targets, only("fulcra"));
    expect(await installedIn(sandbox.targets, "fulcra")).toEqual([true, true, false]);

    expect((await installSkills(sandbox.targets, only("paseo"))).ops).toEqual([]);
    expect(await installedIn(sandbox.targets, "fulcra")).toEqual([false, false, false]);
    expect(await installedIn(sandbox.targets, "paseo")).toEqual([true, true, false]);
  });
});

function only(...skills: string[]): SkillSelection {
  return { mode: "custom", skills };
}

interface Sandbox {
  root: string;
  targets: SkillTargets;
}

async function makeSandbox(): Promise<Sandbox> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-skills-"));
  const targets: SkillTargets = {
    sourceDir: path.join(root, "bundle"),
    agentsDir: path.join(root, "home", ".agents", "skills"),
    claudeDir: path.join(root, "home", ".claude", "skills"),
    codexDir: path.join(root, "home", ".codex", "skills"),
  };
  await fs.mkdir(targets.sourceDir, { recursive: true });
  return { root, targets };
}

async function writeFiles(rootDir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(rootDir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

async function writeBundleSkill(
  sourceDir: string,
  name: string,
  files: Record<string, string>,
): Promise<void> {
  await writeFiles(path.join(sourceDir, name), files);
}

async function writeOnDiskSkill(
  agentsDir: string,
  name: string,
  files: Record<string, string>,
): Promise<void> {
  await writeFiles(path.join(agentsDir, name), files);
}

async function writeOnDiskSkillToAllTargets(
  targets: SkillTargets,
  name: string,
  files: Record<string, string>,
): Promise<void> {
  await Promise.all([
    writeOnDiskSkill(targets.agentsDir, name, files),
    writeOnDiskSkill(targets.claudeDir, name, files),
    writeOnDiskSkill(targets.codexDir, name, files),
  ]);
}

async function writeCurrentBundle(sourceDir: string): Promise<void> {
  await writeBundleSkill(sourceDir, "paseo", { "SKILL.md": "paseo-v1" });
  await writeBundleSkill(sourceDir, "paseo-loop", { "SKILL.md": "loop-v1" });
}

async function pathExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

async function installedIn(targets: SkillTargets, name: string): Promise<boolean[]> {
  return Promise.all(
    [targets.agentsDir, targets.claudeDir, targets.codexDir].map((dir) =>
      pathExists(path.join(dir, name)),
    ),
  );
}

describe("getSkillsStatus", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true });
  });

  it("returns not-installed with add ops for every bundled skill when nothing is on disk", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);

    const status = await getSkillsStatus(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("not-installed");
    expect(status.ops).toEqual([
      { kind: "add", name: "paseo" },
      { kind: "add", name: "paseo-loop" },
    ]);
  });

  it("reports every bundled skill as available", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo-advisor", {
      "SKILL.md": "advisor-v1",
    });

    const status = await getSkillsStatus(sandbox.targets, only("paseo"));

    expect(status.available).toEqual(["paseo", "paseo-advisor", "paseo-loop"]);
  });

  it("reports a skill present in only one target as installed", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.claudeDir, "paseo", { "SKILL.md": "paseo-v1" });

    const status = await getSkillsStatus(sandbox.targets, ALL_SKILLS);

    // `add` means "missing from at least one target", so it cannot answer
    // "is there a directory here to delete". `installed` answers that.
    expect(status.installed).toEqual(["paseo"]);
    expect(status.ops).toEqual([
      { kind: "add", name: "paseo" },
      { kind: "add", name: "paseo-loop" },
    ]);
  });

  it("reports legacy skill directories left on disk as installed", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo-chat", { "SKILL.md": "chat-old" });

    expect((await getSkillsStatus(sandbox.targets, ALL_SKILLS)).installed).toEqual(["paseo-chat"]);
  });

  it("returns not-installed when only user-personal skill dirs exist (the live bug)", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    for (const name of ["unslop", "tdd", "devbox"]) {
      await writeOnDiskSkill(sandbox.targets.agentsDir, name, { "SKILL.md": `user-${name}` });
    }

    const status = await getSkillsStatus(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("not-installed");
    expect(status.ops).toEqual([
      { kind: "add", name: "paseo" },
      { kind: "add", name: "paseo-loop" },
    ]);
  });

  it("returns up-to-date when every bundled skill matches on disk", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo-loop", { "SKILL.md": "loop-v1" });

    const status = await getSkillsStatus(sandbox.targets, ALL_SKILLS);

    expect(status).toEqual({
      state: "up-to-date",
      ops: [],
      available: ["paseo", "paseo-loop"],
      installed: ["paseo", "paseo-loop"],
    });
  });

  it("ignores user-added files inside current managed skill dirs in every target", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo-loop", { "SKILL.md": "loop-v1" });
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", {
      "SKILL.md": "paseo-v1",
      "my-context.md": "user context",
    });
    await writeOnDiskSkill(sandbox.targets.claudeDir, "paseo", {
      "SKILL.md": "paseo-v1",
      "commands/local.md": "user command",
    });
    await writeOnDiskSkill(sandbox.targets.codexDir, "paseo", {
      "SKILL.md": "paseo-v1",
      "hooks/guard.sh": "user guard",
    });

    const status = await getSkillsStatus(sandbox.targets, ALL_SKILLS);

    expect(status).toEqual({
      state: "up-to-date",
      ops: [],
      available: ["paseo", "paseo-loop"],
      installed: ["paseo", "paseo-loop"],
    });
  });

  it("treats an untracked local file as an intentional override", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", { "SKILL.md": "stale" });
    await writeOnDiskSkill(sandbox.targets.claudeDir, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkill(sandbox.targets.codexDir, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo-loop", { "SKILL.md": "loop-v1" });

    const status = await getSkillsStatus(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("up-to-date");
    expect(status.ops).toEqual([]);
  });

  it("preserves a local override in a secondary agent target", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo-loop", { "SKILL.md": "loop-v1" });
    await writeOnDiskSkill(sandbox.targets.claudeDir, "paseo", { "SKILL.md": "stale" });
    await writeOnDiskSkill(sandbox.targets.claudeDir, "paseo-loop", { "SKILL.md": "loop-v1" });
    await writeOnDiskSkill(sandbox.targets.codexDir, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkill(sandbox.targets.codexDir, "paseo-loop", { "SKILL.md": "loop-v1" });

    const status = await getSkillsStatus(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("up-to-date");
    expect(status.ops).toEqual([]);
  });

  it("returns drift with add ops for the bundled skills missing from disk", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo", { "SKILL.md": "paseo-v1" });

    const status = await getSkillsStatus(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("drift");
    expect(status.ops).toEqual([{ kind: "add", name: "paseo-loop" }]);
  });

  it("returns drift with a delete op for a legacy skill name still on disk", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo-loop", { "SKILL.md": "loop-v1" });
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo-chat", { "SKILL.md": "chat-old" });

    const status = await getSkillsStatus(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("drift");
    expect(status.ops).toEqual([{ kind: "delete", name: "paseo-chat" }]);
  });

  it("emits add and delete ops while preserving a local file override", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", { "SKILL.md": "stale" });
    await writeOnDiskSkill(sandbox.targets.claudeDir, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkill(sandbox.targets.codexDir, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo-chat", { "SKILL.md": "chat-old" });

    const status = await getSkillsStatus(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("drift");
    expect(status.ops).toEqual([
      { kind: "delete", name: "paseo-chat" },
      { kind: "add", name: "paseo-loop" },
    ]);
  });
});

describe("custom skill selection", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo-advisor", {
      "SKILL.md": "advisor-v1",
    });
  });

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true });
  });

  it("installs only the selected skills", async () => {
    const status = await installSkills(sandbox.targets, only("paseo", "paseo-loop"));

    expect(status).toEqual({
      state: "up-to-date",
      ops: [],
      available: ["paseo", "paseo-advisor", "paseo-loop"],
      installed: ["paseo", "paseo-loop"],
    });
    expect(await installedIn(sandbox.targets, "paseo")).toEqual([true, true, false]);
    expect(await installedIn(sandbox.targets, "paseo-loop")).toEqual([true, true, false]);
    expect(await installedIn(sandbox.targets, "paseo-advisor")).toEqual([false, false, false]);
  });

  it("reports up-to-date while an unselected bundled skill is absent", async () => {
    await installSkills(sandbox.targets, only("paseo"));

    const status = await getSkillsStatus(sandbox.targets, only("paseo"));

    expect(status).toEqual({
      state: "up-to-date",
      ops: [],
      available: ["paseo", "paseo-advisor", "paseo-loop"],
      installed: ["paseo"],
    });
  });

  it("removes a previously installed skill once it leaves the selection", async () => {
    await installSkills(sandbox.targets, ALL_SKILLS);

    const status = await installSkills(sandbox.targets, only("paseo"));

    expect(status.state).toBe("up-to-date");
    expect(await installedIn(sandbox.targets, "paseo")).toEqual([true, true, false]);
    expect(await installedIn(sandbox.targets, "paseo-loop")).toEqual([false, false, false]);
    expect(await installedIn(sandbox.targets, "paseo-advisor")).toEqual([false, false, false]);
  });

  it("reports a delete op for a deselected skill before it is applied", async () => {
    await installSkills(sandbox.targets, ALL_SKILLS);

    const status = await getSkillsStatus(sandbox.targets, only("paseo", "paseo-advisor"));

    expect(status.state).toBe("drift");
    expect(status.ops).toEqual([{ kind: "delete", name: "paseo-loop" }]);
  });

  it("leaves unrelated user skills untouched", async () => {
    await writeOnDiskSkill(sandbox.targets.agentsDir, "unslop", { "SKILL.md": "user-unslop" });

    await installSkills(sandbox.targets, only("paseo"));

    expect(
      await fs.readFile(path.join(sandbox.targets.agentsDir, "unslop", "SKILL.md"), "utf-8"),
    ).toBe("user-unslop");
  });

  it("treats an empty custom selection as no managed skills installed", async () => {
    await installSkills(sandbox.targets, ALL_SKILLS);

    const status = await installSkills(sandbox.targets, only());

    expect(status).toEqual({
      state: "not-installed",
      ops: [],
      available: ["paseo", "paseo-advisor", "paseo-loop"],
      installed: [],
    });
    expect(await installedIn(sandbox.targets, "paseo")).toEqual([false, false, false]);
    expect(await installedIn(sandbox.targets, "paseo-loop")).toEqual([false, false, false]);
  });

  it("ignores selected names that the bundle does not ship", async () => {
    const status = await installSkills(sandbox.targets, only("paseo", "not-a-skill"));

    expect(status).toEqual({
      state: "up-to-date",
      ops: [],
      available: ["paseo", "paseo-advisor", "paseo-loop"],
      installed: ["paseo"],
    });
    expect(await installedIn(sandbox.targets, "not-a-skill")).toEqual([false, false, false]);
  });

  it("still deletes legacy skill names that are not selectable", async () => {
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo-orchestrator", {
      "SKILL.md": "orchestrator-old",
    });

    await installSkills(sandbox.targets, only("paseo"));

    expect(await installedIn(sandbox.targets, "paseo-orchestrator")).toEqual([false, false, false]);
  });
});

describe("installSkills / updateSkills", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true });
  });

  it("installs into shared and Claude roots without duplicating Codex discovery", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "unslop", { "SKILL.md": "user-unslop" });

    const status = await installSkills(sandbox.targets, ALL_SKILLS);

    expect(status).toEqual({
      state: "up-to-date",
      ops: [],
      available: ["paseo", "paseo-loop"],
      installed: ["paseo", "paseo-loop"],
    });
    for (const name of ["paseo", "paseo-loop"]) {
      expect(
        await fs.readFile(path.join(sandbox.targets.agentsDir, name, "SKILL.md"), "utf-8"),
      ).toBe(name === "paseo" ? "paseo-v1" : "loop-v1");
      expect(await pathExists(path.join(sandbox.targets.codexDir, name, "SKILL.md"))).toBe(false);
      expect(await pathExists(path.join(sandbox.targets.claudeDir, name))).toBe(true);
    }
    expect(
      await fs.readFile(path.join(sandbox.targets.agentsDir, "unslop", "SKILL.md"), "utf-8"),
    ).toBe("user-unslop");
  });

  it("retires unchanged managed Codex copies while preserving personal files", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await installSkills(sandbox.targets, ALL_SKILLS);
    const legacy = path.join(sandbox.targets.codexDir, "paseo");
    const managed = { "SKILL.md": "paseo-v1", "references/old.md": "bundled reference" };
    const hashes = Object.fromEntries(
      Object.entries(managed).map(([name, content]) => [
        name,
        createHash("sha256").update(content).digest("hex"),
      ]),
    );
    await writeFiles(legacy, {
      ...managed,
      "notes/mine.md": "personal notes",
      ".paseo-managed-files.json": JSON.stringify({ version: 1, files: hashes }),
    });
    const status = await autoUpdateInstalledSkills(sandbox.targets, ALL_SKILLS);
    expect(status.state).toBe("up-to-date");
    expect(status.ops).toEqual([]);
    expect(await pathExists(path.join(legacy, "SKILL.md"))).toBe(false);
    expect(await pathExists(path.join(legacy, "references/old.md"))).toBe(false);
    expect(await fs.readFile(path.join(legacy, "notes/mine.md"), "utf8")).toBe("personal notes");
    expect(await autoUpdateInstalledSkills(sandbox.targets, ALL_SKILLS)).toEqual(status);
  });

  it("keeps edited or untracked Codex skill definitions", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await installSkills(sandbox.targets, ALL_SKILLS);
    const originalHash = createHash("sha256").update("paseo-v1").digest("hex");
    await writeOnDiskSkill(sandbox.targets.codexDir, "paseo", {
      "SKILL.md": "personalized skill",
      ".paseo-managed-files.json": JSON.stringify({
        version: 1,
        files: { "SKILL.md": originalHash },
      }),
    });
    await writeOnDiskSkill(sandbox.targets.codexDir, "paseo-loop", {
      "SKILL.md": "untracked skill",
    });
    expect((await autoUpdateInstalledSkills(sandbox.targets, ALL_SKILLS)).state).toBe("up-to-date");
    expect(
      await fs.readFile(path.join(sandbox.targets.codexDir, "paseo", "SKILL.md"), "utf8"),
    ).toBe("personalized skill");
    expect(
      await fs.readFile(path.join(sandbox.targets.codexDir, "paseo-loop", "SKILL.md"), "utf8"),
    ).toBe("untracked skill");
  });

  it("offers an update when the edited Codex copy links to shared skills", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await installSkills(sandbox.targets, ALL_SKILLS);
    await fs.mkdir(path.dirname(sandbox.targets.codexDir), { recursive: true });
    await fs.symlink(sandbox.targets.agentsDir, sandbox.targets.codexDir, "dir");
    const file = path.join(sandbox.targets.agentsDir, "paseo", "SKILL.md");
    await fs.writeFile(file, "user instructions");
    expect((await autoUpdateInstalledSkills(sandbox.targets, ALL_SKILLS)).state).toBe("up-to-date");
    expect(await fs.readFile(file, "utf8")).toBe("user instructions");
    expect(await fs.readFile(`${file}.new`, "utf8")).toBe("paseo-v1");
  });

  it.each([
    { alias: "codex", target: "agents" },
    { alias: "codex", target: "claude" },
  ] as const)(
    "keeps installed skills when the $alias root links to the $target root",
    async ({ alias, target }) => {
      await writeCurrentBundle(sandbox.targets.sourceDir);
      const rootOf = { agents: "agentsDir", claude: "claudeDir", codex: "codexDir" } as const;
      const aliasRoot = sandbox.targets[rootOf[alias]];
      const targetRoot = sandbox.targets[rootOf[target]];
      await fs.mkdir(targetRoot, { recursive: true });
      await fs.mkdir(path.dirname(aliasRoot), { recursive: true });
      await fs.symlink(targetRoot, aliasRoot, "dir");

      const installed = await installSkills(sandbox.targets, ALL_SKILLS);
      const updated = await autoUpdateInstalledSkills(sandbox.targets, ALL_SKILLS);

      expect(installed.state).toBe("up-to-date");
      expect(updated.state).toBe("up-to-date");
      for (const name of ["paseo", "paseo-loop"]) {
        expect(await installedIn(sandbox.targets, name)).toEqual([true, true, true]);
      }
    },
  );

  it("refuses to write through a linked Claude skill root", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await fs.mkdir(sandbox.targets.codexDir, { recursive: true });
    await fs.mkdir(path.dirname(sandbox.targets.claudeDir), { recursive: true });
    await fs.symlink(sandbox.targets.codexDir, sandbox.targets.claudeDir, "dir");
    await expect(installSkills(sandbox.targets, ALL_SKILLS)).rejects.toThrow(/symbolic link/);
    expect(await fs.readdir(sandbox.targets.codexDir)).toEqual([]);
  });

  it("keeps an installed skill when its Codex directory links to the shared copy", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await fs.mkdir(path.join(sandbox.targets.agentsDir, "paseo"), { recursive: true });
    await fs.mkdir(sandbox.targets.codexDir, { recursive: true });
    await fs.symlink(
      path.join(sandbox.targets.agentsDir, "paseo"),
      path.join(sandbox.targets.codexDir, "paseo"),
      "dir",
    );

    const installed = await installSkills(sandbox.targets, ALL_SKILLS);
    const updated = await autoUpdateInstalledSkills(sandbox.targets, ALL_SKILLS);

    expect(installed.state).toBe("up-to-date");
    expect(updated.state).toBe("up-to-date");
    expect(
      await fs.readFile(path.join(sandbox.targets.agentsDir, "paseo", "SKILL.md"), "utf8"),
    ).toBe("paseo-v1");
  });

  it("repairs missing skills while keeping local edits and legacy directories", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", { "SKILL.md": "stale" });
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo-chat", { "SKILL.md": "chat-old" });
    await writeOnDiskSkill(sandbox.targets.claudeDir, "paseo-chat", { "SKILL.md": "chat-old" });
    await writeOnDiskSkill(sandbox.targets.codexDir, "paseo-chat", { "SKILL.md": "chat-old" });

    const status = await updateSkills(sandbox.targets, ALL_SKILLS);

    expect(status).toEqual({
      state: "drift",
      ops: [{ kind: "delete", name: "paseo-chat" }],
      available: ["paseo", "paseo-loop"],
      installed: ["paseo", "paseo-chat", "paseo-loop"],
    });
    expect(
      await fs.readFile(path.join(sandbox.targets.agentsDir, "paseo", "SKILL.md"), "utf-8"),
    ).toBe("stale");
    expect(
      await fs.readFile(path.join(sandbox.targets.agentsDir, "paseo-loop", "SKILL.md"), "utf-8"),
    ).toBe("loop-v1");
    for (const dir of [
      sandbox.targets.agentsDir,
      sandbox.targets.claudeDir,
      sandbox.targets.codexDir,
    ]) {
      expect(await pathExists(path.join(dir, "paseo-chat"))).toBe(true);
    }
  });

  it("defines updated as the state reached after preserving user files", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkillToAllTargets(sandbox.targets, "paseo-loop", { "SKILL.md": "loop-v1" });
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", {
      "SKILL.md": "stale",
      "hooks/guard.sh": "user guard",
    });
    await writeOnDiskSkill(sandbox.targets.claudeDir, "paseo", {
      "SKILL.md": "paseo-v1",
      "notes/local.md": "claude notes",
    });
    await writeOnDiskSkill(sandbox.targets.codexDir, "paseo", {
      "SKILL.md": "paseo-v1",
      "prompts/local.md": "codex prompt",
    });

    const status = await updateSkills(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("up-to-date");
    expect(await getSkillsStatus(sandbox.targets, ALL_SKILLS)).toEqual({
      state: "up-to-date",
      ops: [],
      available: ["paseo", "paseo-loop"],
      installed: ["paseo", "paseo-loop"],
    });
    expect(
      await fs.readFile(
        path.join(sandbox.targets.agentsDir, "paseo", "hooks", "guard.sh"),
        "utf-8",
      ),
    ).toBe("user guard");
    expect(
      await fs.readFile(
        path.join(sandbox.targets.claudeDir, "paseo", "notes", "local.md"),
        "utf-8",
      ),
    ).toBe("claude notes");
    expect(
      await fs.readFile(
        path.join(sandbox.targets.codexDir, "paseo", "prompts", "local.md"),
        "utf-8",
      ),
    ).toBe("codex prompt");
  });

  it("repairs secondary agent targets even when agents skills are current", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo-loop", { "SKILL.md": "loop-v1" });
    await writeOnDiskSkill(sandbox.targets.claudeDir, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkill(sandbox.targets.codexDir, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkill(sandbox.targets.codexDir, "paseo-loop", { "SKILL.md": "loop-v1" });

    const status = await updateSkills(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("up-to-date");
    expect(
      await fs.readFile(path.join(sandbox.targets.claudeDir, "paseo-loop", "SKILL.md"), "utf-8"),
    ).toBe("loop-v1");
  });

  it("auto-installs missing skills while keeping locally edited files", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", {
      "SKILL.md": "stale",
      "hooks/guard.sh": "user guard",
    });

    const status = await autoUpdateInstalledSkills(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("up-to-date");
    expect((await getSkillsStatus(sandbox.targets, ALL_SKILLS)).state).toBe("up-to-date");
    expect(
      await fs.readFile(path.join(sandbox.targets.agentsDir, "paseo", "SKILL.md"), "utf-8"),
    ).toBe("stale");
    expect(
      await fs.readFile(
        path.join(sandbox.targets.agentsDir, "paseo", "hooks", "guard.sh"),
        "utf-8",
      ),
    ).toBe("user guard");
  });

  it("keeps edited managed files across startup and selection saves", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await installSkills(sandbox.targets, ALL_SKILLS);
    const local = path.join(sandbox.targets.agentsDir, "paseo", "SKILL.md");
    await fs.writeFile(local, "local rules");
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo", { "SKILL.md": "bundle-v2" });
    expect((await autoUpdateInstalledSkills(sandbox.targets, ALL_SKILLS)).ops).toEqual([]);
    expect((await installSkills(sandbox.targets, ALL_SKILLS)).ops).toEqual([]);
    expect(await fs.readFile(local, "utf8")).toBe("local rules");
    expect(await fs.readFile(`${local}.new`, "utf8")).toBe("bundle-v2");
    expect(
      await fs.readFile(path.join(sandbox.targets.claudeDir, "paseo", "SKILL.md"), "utf8"),
    ).toBe("bundle-v2");
  });

  it("offers an update at startup when only user overrides differ", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await installSkills(sandbox.targets, ALL_SKILLS);
    for (const root of [sandbox.targets.agentsDir, sandbox.targets.claudeDir]) {
      await fs.writeFile(path.join(root, "paseo", "SKILL.md"), "user instructions");
    }
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo", { "SKILL.md": "bundle-v2" });
    expect((await getSkillsStatus(sandbox.targets, ALL_SKILLS)).state).toBe("up-to-date");
    for (const root of [sandbox.targets.agentsDir, sandbox.targets.claudeDir]) {
      await expect(fs.access(path.join(root, "paseo", "SKILL.md.new"))).rejects.toThrow();
    }
    await autoUpdateInstalledSkills(sandbox.targets, ALL_SKILLS);
    await autoUpdateInstalledSkills(sandbox.targets, ALL_SKILLS);
    for (const root of [sandbox.targets.agentsDir, sandbox.targets.claudeDir]) {
      expect(await fs.readFile(path.join(root, "paseo", "SKILL.md"), "utf8")).toBe(
        "user instructions",
      );
      expect(await fs.readFile(path.join(root, "paseo", "SKILL.md.new"), "utf8")).toBe("bundle-v2");
    }
  });

  it("updates a nested managed file recorded with Windows path separators", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo", {
      "SKILL.md": "paseo-v1",
      "references/guide.md": "guide-v1",
    });
    await installSkills(sandbox.targets, ALL_SKILLS);
    const skill = path.join(sandbox.targets.agentsDir, "paseo");
    const manifestPath = path.join(skill, ".paseo-managed-files.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.files["references\\guide.md"] = manifest.files["references/guide.md"];
    delete manifest.files["references/guide.md"];
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await fs.writeFile(
      path.join(sandbox.targets.sourceDir, "paseo", "references", "guide.md"),
      "guide-v2",
    );
    expect((await getSkillsStatus(sandbox.targets, ALL_SKILLS)).state).toBe("drift");
    expect((await autoUpdateInstalledSkills(sandbox.targets, ALL_SKILLS)).state).toBe("up-to-date");
    expect(await fs.readFile(path.join(skill, "references", "guide.md"), "utf8")).toBe("guide-v2");
    const updated = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    expect(Object.keys(updated.files)).toEqual(["SKILL.md", "references/guide.md"]);
  });

  it("does not auto-install skills on a clean machine", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);

    const status = await autoUpdateInstalledSkills(sandbox.targets, ALL_SKILLS);

    expect(status).toEqual({
      state: "not-installed",
      ops: [
        { kind: "add", name: "paseo" },
        { kind: "add", name: "paseo-loop" },
      ],
      available: ["paseo", "paseo-loop"],
      installed: [],
    });
    expect(await installedIn(sandbox.targets, "paseo")).toEqual([false, false, false]);
  });

  it("is idempotent — running install twice keeps state at up-to-date", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);

    const first = await installSkills(sandbox.targets, ALL_SKILLS);
    const second = await installSkills(sandbox.targets, ALL_SKILLS);

    expect(first.state).toBe("up-to-date");
    expect(second.state).toBe("up-to-date");
  });
});

describe("uninstallSkills", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true });
  });

  it("removes every Paseo skill from all three targets and preserves user dirs", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await installSkills(sandbox.targets, ALL_SKILLS);
    for (const name of ["unslop", "tdd", "devbox"]) {
      await writeOnDiskSkill(sandbox.targets.agentsDir, name, { "SKILL.md": `user-${name}` });
    }

    const status = await uninstallSkills(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("not-installed");
    for (const name of ["paseo", "paseo-loop", ...LEGACY_SKILL_NAMES]) {
      expect(await installedIn(sandbox.targets, name)).toEqual([false, false, false]);
    }
    for (const name of ["unslop", "tdd", "devbox"]) {
      expect(
        await fs.readFile(path.join(sandbox.targets.agentsDir, name, "SKILL.md"), "utf-8"),
      ).toBe(`user-${name}`);
    }
  });

  it("is a no-op when nothing is installed", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);

    const status = await uninstallSkills(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("not-installed");
  });

  it("cleans up legacy skill names that linger in agents, claude, and codex", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    for (const dir of [
      sandbox.targets.agentsDir,
      sandbox.targets.claudeDir,
      sandbox.targets.codexDir,
    ]) {
      await writeOnDiskSkill(dir, "paseo-chat", { "SKILL.md": "chat-old" });
    }

    const status = await uninstallSkills(sandbox.targets, ALL_SKILLS);

    expect(status.state).toBe("not-installed");
    expect(await installedIn(sandbox.targets, "paseo-chat")).toEqual([false, false, false]);
  });
});
