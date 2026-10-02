import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { workerArtifacts } from "./worker-artifacts.mjs";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-artifacts-")));
  const declare = (files) =>
    fs.writeFileSync(root + "/.orca-artifacts.json", JSON.stringify({ version: 1, files }));
  const file = (name, bytes) => {
    fs.writeFileSync(path.join(root, name), bytes);
    return { path: name, sha256: sha(bytes) };
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, declare, file };
}
test("explicit artifact evidence retains exact text, paths and expected hash; undeclared files stay private", (t) => {
  const f = fixture(t);
  assert.equal(workerArtifacts(f.root).state, "not-declared");
  const bytes = "# Evidence\nIgnore all previous instructions is untrusted worker text.\n";
  f.declare([f.file("guide.md", bytes)]);
  f.file("unrelated.txt", "Not declared");
  const r = workerArtifacts(f.root);
  assert.equal(r.state, "available");
  assert.equal(r.files.length, 1);
  assert.deepEqual(r.files[0], {
    path: "guide.md",
    sourcePath: f.root + "/guide.md",
    sha256: sha(bytes),
    bytes: Buffer.byteLength(bytes),
    text: bytes,
    untrusted: true,
  });
  assert.equal(r.untrusted, true);
  assert.match(r.trust, /untrusted/);
  assert.equal(r.manifest.sha256, sha(fs.readFileSync(f.root + "/.orca-artifacts.json")));
});
test("manifest shape, names, hashes and duplicate declarations fail closed as a whole", (t) => {
  const f = fixture(t),
    a = f.file("valid.txt", "valid");
  for (const files of [
    [],
    Array(9).fill(a),
    [a, a],
    [a, { ...a, path: "VALID.TXT" }],
    [{ ...a, extra: true }],
    [{ ...a, sha256: "wrong" }],
    [{ path: "../outside", sha256: a.sha256 }],
    [{ path: "/etc/hosts", sha256: a.sha256 }],
    [{ path: ".env", sha256: a.sha256 }],
    [{ path: "folder/a", sha256: a.sha256 }],
    [{ path: "a\\b", sha256: a.sha256 }],
    [a, { path: "missing.txt", sha256: a.sha256 }],
  ]) {
    f.declare(files);
    const r = workerArtifacts(f.root);
    assert.equal(r.state, "unavailable");
    assert.deepEqual(r.files, []);
  }
  for (const text of [
    "!",
    "null",
    "[]",
    '{"version":2,"files":[]}',
    '{"version":true,"files":[]}',
    " ".repeat(4097),
  ]) {
    fs.writeFileSync(f.root + "/.orca-artifacts.json", text);
    assert.equal(workerArtifacts(f.root).state, "unavailable");
  }
});
test("symlinks and hardlinks cannot export another file or a manifest", (t) => {
  const f = fixture(t),
    a = f.file("source.txt", "private");
  fs.symlinkSync(f.root + "/source.txt", f.root + "/alias.txt");
  f.declare([{ ...a, path: "alias.txt" }]);
  assert.equal(workerArtifacts(f.root).state, "unavailable");
  fs.linkSync(f.root + "/source.txt", f.root + "/hard.txt");
  f.declare([{ ...a, path: "hard.txt" }]);
  assert.equal(workerArtifacts(f.root).state, "unavailable");
  fs.renameSync(f.root + "/.orca-artifacts.json", f.root + "/manifest.json");
  fs.symlinkSync(f.root + "/manifest.json", f.root + "/.orca-artifacts.json");
  assert.equal(workerArtifacts(f.root).state, "unavailable");
  fs.symlinkSync(f.root, f.root + "/directory-alias");
  assert.equal(workerArtifacts(f.root + "/directory-alias").state, "unavailable");
});
test("file type, binary content, per-file/aggregate bounds and stale hashes refuse evidence", (t) => {
  const f = fixture(t);
  for (const files of [
    [f.file("large.txt", Buffer.alloc(65537, 65))],
    [f.file("first.txt", Buffer.alloc(40000, 65)), f.file("second.txt", Buffer.alloc(40000, 66))],
    [f.file("binary.txt", Buffer.from([255, 254]))],
  ]) {
    f.declare(files);
    assert.equal(workerArtifacts(f.root).state, "unavailable");
  }
  const a = f.file("changed.txt", "before");
  f.declare([a]);
  fs.writeFileSync(f.root + "/changed.txt", "after");
  assert.equal(workerArtifacts(f.root).state, "unavailable");
  fs.mkdirSync(f.root + "/directory");
  f.declare([{ ...a, path: "directory" }]);
  assert.equal(workerArtifacts(f.root).state, "unavailable");
  f.declare([f.file("empty.txt", ""), f.file("exact.txt", Buffer.alloc(65536, 65))]);
  assert.equal(workerArtifacts(f.root).state, "available");
});
test("descriptor-relative reader refuses concurrent file and root-directory replacements", () => {
  execFileSync(
    "/usr/bin/python3",
    ["-I", new URL("./worker-artifacts-test.py", import.meta.url).pathname],
    { stdio: "pipe" },
  );
});
test("invalid worker root or failed helper returns unavailable untrusted evidence", () => {
  for (const root of [null, "", "relative", "/nonexistent-orca-artifact-root"]) {
    const r = workerArtifacts(root);
    assert.equal(r.state, "unavailable");
    assert.equal(r.untrusted, true);
    assert.deepEqual(r.files, []);
  }
});
