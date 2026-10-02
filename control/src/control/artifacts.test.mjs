import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { operatorArtifacts, validateArtifacts } from "./artifacts.mjs";
// V2 portability: the local host is the configured name, not a built-in machine identity.
import { portable } from "../portable-config.mjs";
const hash = (t) => createHash("sha256").update(t).digest("hex");
test("local operator artifacts retain generation and native input boundary without accepting outputs", async (t) => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-artifacts-")));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const row = { id: randomUUID(), task: randomUUID(), generation: 3, mode: "human", cwd },
    id = randomUUID();
  let humans = 0;
  const c = {
    store: { get: () => ({ ...row }) },
    native: {
      snapshot: async () => ({
        id: row.id,
        cwd,
        status: "idle",
        labels: { owner: "orca-control", task: row.task },
        runtimeInfo: { provider: "claude", sessionId: id },
        provider: "claude",
      }),
      inspect: async () => ({ boot: "boot", humanAt: humans, nativeId: id, lastPromptId: null }),
    },
  };
  fs.writeFileSync(cwd + "/output.md", "Actual output");
  fs.writeFileSync(
    cwd + "/.orca-artifacts.json",
    JSON.stringify({ version: 1, files: [{ path: "output.md", sha256: hash("Actual output") }] }),
  );
  const a = { sessionId: row.id, taskId: row.task, expectedGeneration: 3 },
    r = await operatorArtifacts(c, a);
  assert.equal(r.artifacts.files[0].text, "Actual output");
  assert.equal(r.accepted, false);
  assert.equal(r.host, portable.localHost.name);
  const inspect = c.native.inspect;
  c.native.inspect = async () => {
    const o = await inspect();
    humans++;
    return o;
  };
  await assert.rejects(operatorArtifacts(c, a), /state changed/);
});
test("artifact validator rejects altered hash, path, duplicate name, size and untrusted marker", () => {
  const cwd = "/owned",
    text = "content",
    file = {
      path: "a.md",
      sourcePath: "/owned/a.md",
      bytes: 7,
      text,
      sha256: hash(text),
      untrusted: true,
    };
  const base = {
    state: "available",
    untrusted: true,
    manifest: { sourcePath: "/owned/.orca-artifacts.json", sha256: "a".repeat(64) },
    files: [file],
  };
  assert.equal(validateArtifacts(base, cwd).files.length, 1);
  for (const patch of [
    { sha256: "b".repeat(64) },
    { sourcePath: "/other/a.md" },
    { path: "../a.md" },
    { bytes: 8 },
    { untrusted: false },
    { text: "\ud800" },
  ])
    assert.throws(
      () => validateArtifacts({ ...base, files: [{ ...file, ...patch }] }, cwd),
      /Invalid artifact/,
    );
  assert.throws(() => validateArtifacts({ ...base, files: [file, file] }, cwd), /Invalid artifact/);
  assert.throws(
    () =>
      validateArtifacts(
        {
          ...base,
          files: [
            { ...file, text: "a".repeat(65537), bytes: 65537, sha256: hash("a".repeat(65537)) },
          ],
        },
        cwd,
      ),
    /exceeds bound/,
  );
});
