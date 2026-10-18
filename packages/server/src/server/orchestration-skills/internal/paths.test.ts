import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveBundledSkillsDir, resolveSkillTargets } from "./paths.js";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("orchestration skill paths", () => {
  it("finds the repository catalog from the source module", () => {
    const repositoryRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../../../..",
    );

    expect(resolveBundledSkillsDir()).toBe(path.join(repositoryRoot, "skills"));
  });

  it("finds the catalog beside the actual emitted server layout", async () => {
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-built-skills-"));
    roots.push(packageRoot);
    const catalog = path.join(packageRoot, "dist", "server", "skills");
    await mkdir(catalog, { recursive: true });
    const emittedModule = path.join(
      packageRoot,
      "dist",
      "server",
      "server",
      "orchestration-skills",
      "internal",
      "paths.js",
    );

    expect(resolveBundledSkillsDir(pathToFileURL(emittedModule))).toBe(catalog);
  });

  it("keeps the original fixed managed directories under the daemon user's home", () => {
    vi.stubEnv("PASEO_SKILLS_HOME", undefined);
    const home = os.homedir();

    expect(resolveSkillTargets()).toMatchObject({
      agentsDir: path.join(home, ".agents", "skills"),
      claudeDir: path.join(home, ".claude", "skills"),
      codexDir: path.join(home, ".codex", "skills"),
    });
  });
});

it("keeps scratch daemon skill targets inside its selected user home", () => {
  const home = path.join(os.tmpdir(), "scratch-skills-home");
  vi.stubEnv("PASEO_SKILLS_HOME", home);
  expect(resolveSkillTargets()).toMatchObject({
    agentsDir: path.join(home, ".agents", "skills"),
    claudeDir: path.join(home, ".claude", "skills"),
    codexDir: path.join(home, ".codex", "skills"),
  });
  const explicit = path.join(home, "explicit");
  expect(resolveSkillTargets(explicit).agentsDir).toBe(path.join(explicit, ".agents", "skills"));
});
