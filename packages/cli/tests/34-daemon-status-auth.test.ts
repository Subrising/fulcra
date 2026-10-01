#!/usr/bin/env npx tsx

import assert from "node:assert";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLocalPaseo } from "./helpers/local-cli.ts";
import { startTestDaemon } from "./helpers/test-daemon.ts";

console.log("=== Daemon Status Auth ===\n");

const daemon = await startTestDaemon({
  env: { PASEO_PASSWORD: "shared-secret" },
});

try {
  {
    console.log("Test 1: local status uses the daemon's local credential");
    const result = await runLocalPaseo(["daemon", "status", "--json"], {
      PASEO_HOME: daemon.paseoHome,
      PASEO_HOST: "",
      PASEO_PASSWORD: "",
    });

    assert.strictEqual(result.exitCode, 0, "status should still succeed");
    const status = JSON.parse(result.stdout);

    assert.strictEqual(status.localDaemon, "running");
    assert.strictEqual(status.connectedDaemon, "reachable");
    assert(!("runningAgents" in status), "status should not fetch agent counts");
    assert(!("idleAgents" in status), "status should not fetch agent counts");
    assert.doesNotMatch(status.note ?? "", /Password required|not reachable/i);
    console.log("✓ missing password uses local credential\n");
  }

  {
    console.log("Test 2: status reports rejected supplied password separately");
    const result = await runLocalPaseo(["daemon", "status", "--json"], {
      PASEO_HOME: daemon.paseoHome,
      PASEO_HOST: "",
      PASEO_PASSWORD: "wrong-secret",
    });

    assert.strictEqual(result.exitCode, 0, "status should still succeed");
    const status = JSON.parse(result.stdout);

    assert.strictEqual(status.localDaemon, "running");
    assert.strictEqual(status.connectedDaemon, "auth_failed");
    assert.match(status.note, /Incorrect password/i);
    assert.doesNotMatch(status.note, /not reachable/i);
    console.log("✓ wrong password reports auth_failed\n");
  }

  {
    console.log("Test 3: status reaches the same daemon when password is supplied");
    const result = await runLocalPaseo(["daemon", "status", "--json"], {
      PASEO_HOME: daemon.paseoHome,
      PASEO_HOST: "",
      PASEO_PASSWORD: "shared-secret",
    });

    assert.strictEqual(result.exitCode, 0, "status should succeed with password");
    const status = JSON.parse(result.stdout);

    assert.strictEqual(status.localDaemon, "running");
    assert.strictEqual(status.connectedDaemon, "reachable");
    assert(!("runningAgents" in status), "status should not fetch agent counts");
    assert(!("idleAgents" in status), "status should not fetch agent counts");
    console.log("✓ password-authenticated status remains reachable\n");
  }
} finally {
  await daemon.stop();
}

// POSIX executable probing executes --version; Windows resolves executables differently.
if (process.platform !== "win32") {
  const root = await mkdtemp(join(tmpdir(), "paseo status slow provider "));
  const home = join(root, "daemon");
  const workDir = join(root, "work");
  const provider = join(root, "slow-provider");
  const marker = join(root, "availability.log");
  let slowDaemon: Awaited<ReturnType<typeof startTestDaemon>> | undefined;
  try {
    await mkdir(home);
    await mkdir(workDir);
    await writeFile(
      provider,
      `#!${process.execPath}
import('node:fs').then(({appendFileSync}) => {
  appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)) + "\\n");
  setTimeout(() => console.log('provider 1.0.0'), 1800);
});
`,
      { mode: 0o700 },
    );
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        version: 1,
        agents: { providers: { claude: { command: { mode: "replace", argv: [provider] } } } },
      }),
    );
    slowDaemon = await startTestDaemon({
      paseoHome: home,
      workDir,
      env: { PASEO_PASSWORD: "shared-secret" },
    });
    // The daemon bounds this optional probe to 1000ms, inside the CLI's 1500ms
    // deadline, so a provider slower than the budget no longer costs the caller
    // its status. Whether the surrounding handler also lands inside 1500ms is
    // load-dependent — the pid lock read ahead of it retries for up to 500ms —
    // so this asserts what holds either way. The details-timeout branch itself
    // is pinned deterministically in src/commands/daemon/status.test.ts.
    console.log("Test 4: a slow provider leaves local status useful and free of invented facts");
    const local = await runLocalPaseo(["daemon", "status", "--home", home, "--json"], {
      PASEO_PASSWORD: "shared-secret",
    });
    assert.strictEqual(local.exitCode, 0, local.stderr);
    const status = JSON.parse(local.stdout);
    assert.strictEqual(status.localDaemon, "running");
    assert.strictEqual(status.connectedDaemon, "reachable", JSON.stringify(status));
    assert.strictEqual(typeof status.serverId, "string");
    // Either the bounded probe answered with nothing established, or the details
    // never arrived. Neither may claim the provider is available.
    assert.deepStrictEqual(
      status.providers ?? [],
      [],
      `a probe that never answered must not be reported as available: ${local.stdout}`,
    );
    assert.match(
      await readFile(marker, "utf8"),
      /\["--version"\]/,
      "the public provider executable was actually probed",
    );
    console.log("✓ slow optional probe keeps local status useful without provider facts\n");

    console.log("Test 5: an explicit endpoint observation claims no local ownership");
    const remote = await runLocalPaseo(
      ["daemon", "status", "--host", `127.0.0.1:${slowDaemon.port}`, "--json"],
      { PASEO_PASSWORD: "shared-secret" },
    );
    // An endpoint target reports the status it obtained, or fails when the
    // details time out. Both are intended; what must hold in either case is
    // that an endpoint never reports ownership of a local daemon.
    const observation =
      remote.exitCode === 0 ? JSON.parse(remote.stdout) : JSON.parse(remote.stderr).error.details;
    assert.strictEqual(observation.connectedDaemon, "reachable", remote.stderr || remote.stdout);
    assert.strictEqual(observation.serverId, status.serverId);
    assert.deepStrictEqual(observation.providers ?? [], []);
    assert(!("home" in observation), "endpoint observation must not invent local ownership");
    assert(!("localDaemon" in observation), "endpoint observation owns no local daemon state");
    console.log("✓ endpoint reachability recorded without inventing local ownership\n");
  } finally {
    await slowDaemon?.stop();
    await rm(root, { recursive: true, force: true });
  }
}

console.log("=== Daemon Status Auth Tests Passed ===");
