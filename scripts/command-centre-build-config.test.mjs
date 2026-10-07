import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { createPackage, extractFile, listPackage } from "@electron/asar";
import { getFileMatchers } from "app-builder-lib/out/fileMatcher.js";
import { computeFileSets, copyAppFiles } from "app-builder-lib/out/util/appFileCopier.js";
import { CancellationToken } from "builder-util-runtime";
import { commandCentreBuildConfig } from "./command-centre-build-config.mjs";
test("scratch config replaces resource sources without inheriting stale arrays", () => {
  const base = load(
    fs.readFileSync(new URL("../packages/desktop/electron-builder.yml", import.meta.url), "utf8"),
  );
  const config = commandCentreBuildConfig(base, {
    desktop: "/source/desktop",
    pluginOutput: "/scratch/plugins",
    webOutput: "/scratch/web",
  });
  assert.equal(Object.hasOwn(config, "extends"), false);
  assert.deepEqual(config.extraResources, [
    { from: "/scratch/plugins", to: "bundled-plugins" },
    // Paseo v0.11's built-in plugins (the usage reporters) ship from the source server build.
    { from: "/source/server/dist/server/builtin-plugins", to: "builtin-plugins" },
    { from: "/scratch/web", to: "app-dist" },
    { from: "/source/desktop/assets/editor-targets", to: "editor-target-icons" },
  ]);
  assert.deepEqual(config.mac, base.mac);
  assert.deepEqual(
    config.files,
    base.files.map((item) =>
      typeof item === "string"
        ? item
        : { ...item, from: path.resolve("/source/desktop", item.from) },
    ),
  );
  assert.equal(config.afterPack, base.afterPack);
  assert.equal(base.extraResources[0].from, "bundled-plugins");
});

test("generated builder fileset carries every source skill byte into the server ASAR catalog", async () => {
  const product = fileURLToPath(new URL("../", import.meta.url));
  const desktop = path.join(product, "packages/desktop");
  const source = path.join(product, "skills");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "fulcra-skill-asar-"));
  try {
    const stage = path.join(scratch, "app");
    const config = commandCentreBuildConfig(
      load(fs.readFileSync(path.join(desktop, "electron-builder.yml"), "utf8")),
      {
        desktop,
        pluginOutput: path.join(scratch, "plugins"),
        webOutput: path.join(scratch, "web"),
      },
    );
    const matchers = getFileMatchers(config, "files", stage, {
      defaultSrc: desktop,
      macroExpander: (value) => value,
      customBuildOptions: {},
      globalOutDir: path.join(scratch, "output"),
    }).filter((matcher) => matcher.from === source);
    assert.equal(matchers.length, 1, "generated config must explicitly carry the skill catalog");
    const info = {
      areNodeModulesHandledExternally: false,
      cancellationToken: new CancellationToken(),
    };
    const sets = await computeFileSets(matchers, null, { info }, false);
    assert.equal(sets.length, 1);
    await copyAppFiles(sets[0], info, null);
    const archive = path.join(scratch, "app.asar");
    await createPackage(stage, archive);
    const prefix = "node_modules/@getpaseo/server/dist/server/skills/";
    const listing = listPackage(archive);
    assert.equal(listing.filter((entry) => entry === `/${prefix}fulcra/SKILL.md`).length, 1);
    const entries = fs.readdirSync(source, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      const member = prefix + path.relative(source, file).split(path.sep).join("/");
      assert.deepEqual(extractFile(archive, member), fs.readFileSync(file), member);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
test("unexpected nested base inheritance refuses rather than merging output trees", () => {
  assert.throws(() => commandCentreBuildConfig({ extends: "another-config" }, {}), /standalone/);
});
