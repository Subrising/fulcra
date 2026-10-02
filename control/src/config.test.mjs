import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  firstRun,
  loadConfig,
  stateRoot,
  validateConfig,
  requiredSetting,
  worktreeLifecycleSettings,
} from "./config.mjs";
const temporary = (run) => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cc-config-"));
  try {
    run(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
};
test("first run is private, portable, stable and does not overwrite configuration", () =>
  temporary((home) => {
    const env = { PASEO_HOME: home },
      c = firstRun(env);
    assert.equal(c.home, path.join(home, "command-centre"));
    assert.equal(c.controller, c.home);
    assert.equal(fs.statSync(path.join(c.home, "config.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(c.home).mode & 0o777, 0o700);
    assert.deepEqual(firstRun(env), loadConfig(env));
    assert.equal(c.daemon.url, null);
    assert.deepEqual(c.hosts, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(c.tasks)), {
      version: 1,
      issues: [],
      projects: [],
    });
  }));
test("missing root and endpoint name the required setting; no machine fallback", () => {
  assert.throws(() => stateRoot({}), /ORCA_HOME.*PASEO_HOME/);
  assert.throws(() => stateRoot({ ORCA_HOME: "" }), /ORCA_HOME/);
  assert.throws(() => requiredSetting(null, "daemon.url"), /daemon.url/);
  assert.throws(() => loadConfig({ ORCA_CONTROLLER_HOME: "/not-used" }), /ORCA_HOME/);
});
test("named hosts support zero, one and many, and reject duplicate identities", () =>
  temporary((home) => {
    const env = { ORCA_HOME: home },
      c = JSON.parse(JSON.stringify(firstRun(env)));
    for (const k of ["home", "controller", "daemonHome", "memoryRoot", "tasks", "url"]) delete c[k];
    for (const hosts of [
      [],
      [{ name: "Studio", serverId: null }],
      [
        { name: "Studio", serverId: "srv_abcdefgh", sshTarget: "user@studio.example" },
        { name: "Build server", serverId: "srv_ijklmnop" },
      ],
    ]) {
      c.hosts = hosts;
      assert.deepEqual(validateConfig(c).hosts, hosts);
    }
    c.hosts.push({ name: "Studio", serverId: null });
    assert.throws(() => validateConfig(c), /hosts.2.name/);
    // L44: a setting from a newer build is ignored and kept, never thrown (it stopped older tool servers on 29 Sep).
    c.hosts = [];
    c.unknown = true;
    assert.equal(validateConfig(c).unknown, true);
  }));
test("unsafe configuration and symlinks are refused", () =>
  temporary((home) => {
    firstRun({ ORCA_HOME: home });
    const file = path.join(home, "config.json");
    fs.chmodSync(file, 0o644);
    assert.throws(() => loadConfig({ ORCA_HOME: home }), /Private/);
    fs.chmodSync(file, 0o600);
    fs.renameSync(file, file + ".target");
    fs.symlinkSync(file + ".target", file);
    assert.throws(() => loadConfig({ ORCA_HOME: home }), /Canonical/);
  }));

test("required settings cannot be supplied through inherited properties", () =>
  temporary((home) => {
    firstRun({ ORCA_HOME: home });
    const c = JSON.parse(fs.readFileSync(path.join(home, "config.json")));
    c.daemon = Object.create({ url: "ws://localhost:12345/ws" });
    assert.throws(() => validateConfig(c), /Missing setting daemon.url/);
  }));

test("memory entry paths work when the installed package directory contains spaces", async () => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cc space ")),
    old = process.env.ORCA_HOME;
  try {
    firstRun({ ORCA_HOME: home });
    process.env.ORCA_HOME = home;
    const source = path.join(home, "src");
    fs.mkdirSync(source);
    for (const name of ["canonical-memory-route.mjs", "portable-config.mjs", "config.mjs"])
      fs.copyFileSync(new URL(name, import.meta.url), path.join(source, name));
    const server = path.join(home, "orca-organization/server");
    fs.mkdirSync(server, { recursive: true });
    fs.copyFileSync(
      new URL("../orca-organization/server/config.mjs", import.meta.url),
      path.join(server, "config.mjs"),
    );
    const { canonicalMemoryConfig } = await import(
      pathToFileURL(path.join(source, "canonical-memory-route.mjs")).href
    );
    assert.equal(canonicalMemoryConfig("claude").env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(
      canonicalMemoryConfig("claude").args[0],
      path.join(source, "portable-memory", "entry.mjs"),
    );
  } finally {
    if (old === undefined) delete process.env.ORCA_HOME;
    else process.env.ORCA_HOME = old;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("lifecycle retention uses V2 config, defaults off and preserves other settings", async () => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cc-retention-"));
  try {
    const env = { ORCA_HOME: home };
    firstRun(env);
    const file = path.join(home, "config.json"),
      before = JSON.parse(fs.readFileSync(file));
    delete before.worktreeLifecycle;
    fs.writeFileSync(file, JSON.stringify(before));
    const settings = worktreeLifecycleSettings(env);
    assert.equal(await settings.get(), "never");
    assert.equal(await settings.set(7), 7);
    assert.equal(await settings.get(), 7);
    const after = JSON.parse(fs.readFileSync(file));
    delete after.worktreeLifecycle;
    assert.deepEqual(after, before);
    await settings.set("never");
    assert.equal(await settings.get(), "never");
    for (const value of [-1, 1.5, 36501, null, "7"])
      await assert.rejects(settings.set(value), /retentionDays/);
    assert.equal(fs.existsSync(path.join(home, "worktree-lifecycle.json")), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
