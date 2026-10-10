import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { installGitHooks } from "./install-git-hooks.mjs";

const script = fileURLToPath(new URL("./install-git-hooks.mjs", import.meta.url));

// A fake runner: records each command and answers from a table.
function fake(answers) {
  const calls = [];
  const run = (command, args) => {
    calls.push([command, ...args].join(" "));
    return answers[[command, ...args].join(" ")] ?? { status: 0, stdout: "" };
  };
  return { calls, run };
}

test("skips lefthook install when core.hooksPath is set", () => {
  const lines = [];
  const { calls, run } = fake({
    "git config core.hooksPath": { status: 0, stdout: "/guards/git\n" },
  });
  assert.equal(installGitHooks({ run, log: (l) => lines.push(l) }), 0);
  assert.deepEqual(calls, ["git rev-parse --git-dir", "git config core.hooksPath"]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /core\.hooksPath is set/);
});

test("runs plain lefthook install (no --force) when core.hooksPath is unset", () => {
  const { calls, run } = fake({ "git config core.hooksPath": { status: 1, stdout: "" } });
  assert.equal(installGitHooks({ run, log() {} }), 0);
  assert.equal(calls.at(-1), "lefthook install");
  assert.ok(!calls.some((c) => c.includes("--force")));
});

test("passes on a failure of lefthook install, and skips when lefthook is missing", () => {
  const failing = fake({
    "git config core.hooksPath": { status: 1 },
    "lefthook install": { status: 3 },
  });
  assert.equal(installGitHooks({ run: failing.run, log() {} }), 3);
  const missing = fake({
    "git config core.hooksPath": { status: 1 },
    "lefthook install": { error: new Error("ENOENT") },
  });
  assert.equal(installGitHooks({ run: missing.run, log() {} }), 0);
});

test("does nothing, and exits 0, outside a git checkout", () => {
  const { calls, run } = fake({ "git rev-parse --git-dir": { status: 128 } });
  assert.equal(installGitHooks({ run, log() {} }), 0);
  assert.deepEqual(calls, ["git rev-parse --git-dir"]);
});

test("real git: a global-style hooksPath is kept, and a non-checkout exits 0", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "install-hooks-")));
  try {
    const repo = path.join(root, "repo");
    const guards = path.join(root, "guards");
    fs.mkdirSync(repo);
    fs.mkdirSync(guards);
    fs.writeFileSync(path.join(guards, "pre-commit"), "#!/bin/sh\n# guard\n", { mode: 0o755 });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["config", "core.hooksPath", guards], { cwd: repo });
    const result = spawnSync("node", [script], { cwd: repo, encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /core\.hooksPath is set/);
    assert.equal(fs.readFileSync(path.join(guards, "pre-commit"), "utf8"), "#!/bin/sh\n# guard\n");
    assert.equal(fs.existsSync(path.join(repo, ".git", "hooks", "pre-commit")), false);
    const outside = path.join(root, "tarball");
    fs.mkdirSync(outside);
    const plain = spawnSync("node", [script], { cwd: outside, encoding: "utf8" });
    assert.equal(plain.status, 0);
    assert.match(plain.stdout, /not a git checkout/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
