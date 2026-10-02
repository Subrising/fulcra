// Cutover A3: owned task roots are an explicit list -- <ORCA_HOME>/tasks plus the legacy controller's tasks directory,
// set by the migration in <ORCA_HOME>/task-roots.json -- so running sessions keep their cwd. Nothing is moved; symlinks stay refused.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { CONTROLLER_HOME } from "./installation-settings.mjs";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "task-roots-")));
const legacy = path.join(tmp, "legacy", "tasks"),
  own = path.join(CONTROLLER_HOME, "tasks"),
  elsewhere = path.join(tmp, "elsewhere");
for (const d of [legacy, own, elsewhere]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
const write = (file, value, mode = 0o600) => {
  fs.writeFileSync(file, JSON.stringify(value));
  fs.chmodSync(file, mode);
};
write(path.join(CONTROLLER_HOME, "task-roots.json"), { version: 1, roots: [legacy] });
// The module reads the list once, at load, from the installation's ORCA_HOME -- as the controller does at startup.
const { TASK_ROOTS, ownedRoot, evaluatePermission, taskRoots } =
  await import("./permission-policy.mjs");
const job = (base) => {
  const d = path.join(base, randomUUID());
  fs.mkdirSync(d, { mode: 0o700 });
  return d;
};
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("the controller owns <ORCA_HOME>/tasks and the migrated legacy tasks directory, in that order", () => {
  assert.deepEqual(TASK_ROOTS, [own, legacy]);
});

test("the owned-root check passes a legacy-directory job and a new ORCA_HOME/tasks job, and refuses outside both", () => {
  const legacyJob = job(legacy),
    newJob = job(own),
    outside = job(elsewhere);
  assert.equal(ownedRoot(legacyJob), legacyJob);
  assert.equal(ownedRoot(newJob), newJob);
  assert.throws(() => ownedRoot(outside), /Unique canonical owned task folder required/);
  assert.throws(
    () => ownedRoot(legacy),
    /Unique canonical owned task folder required/,
    "the root itself is not a job",
  );
  const nested = path.join(legacyJob, randomUUID());
  fs.mkdirSync(nested);
  assert.throws(
    () => ownedRoot(nested),
    /Unique canonical owned task folder required/,
    "only direct job folders",
  );
  const link = path.join(legacy, randomUUID());
  fs.symlinkSync(outside, link);
  assert.throws(
    () => ownedRoot(link),
    /Unique canonical owned task folder required/,
    "a symlinked job is refused",
  );
});

test("routine Write evaluation uses the same roots: allowed in a legacy job, refused outside both", () => {
  const request = (root, name) => ({
    provider: "claude",
    kind: "tool",
    name: "Write",
    metadata: { toolUseId: "toolu_1" },
    input: { file_path: path.join(root, name), content: "x" },
  });
  const legacyJob = job(legacy),
    outside = job(elsewhere);
  assert.doesNotThrow(() => evaluatePermission(request(legacyJob, "a.txt"), legacyJob));
  assert.throws(
    () => evaluatePermission(request(outside, "a.txt"), outside),
    /Unique canonical owned task folder required/,
  );
});

test("a task-root list that fails any check extends nothing (never widens)", () => {
  const home = path.join(tmp, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const file = path.join(home, "task-roots.json"),
    base = [path.join(home, "tasks")];
  assert.deepEqual(taskRoots(home), base, "absent file: own root only");
  const cases = [
    [{ version: 1, roots: [legacy] }, 0o644], // readable by others
    [{ version: 1, roots: ["relative/tasks"] }, 0o600], // not absolute
    [{ version: 1, roots: [legacy + "/"] }, 0o600], // not canonical
    [{ version: 1, roots: [path.join(tmp, "missing")] }, 0o600], // does not exist
    [{ version: 2, roots: [legacy] }, 0o600], // unknown version
    [{ version: 1, roots: [legacy], extra: true }, 0o600], // unknown field
  ];
  const link = path.join(tmp, "link-to-legacy");
  fs.symlinkSync(legacy, link);
  cases.push([{ version: 1, roots: [link] }, 0o600]); // symlinked root
  for (const [value, mode] of cases) {
    write(file, value, mode);
    assert.deepEqual(taskRoots(home), base, JSON.stringify(value));
  }
  write(file, { version: 1, roots: [legacy] });
  assert.deepEqual(taskRoots(home), [...base, legacy]);
});

test("agents are denied the new controller configuration files like every other private entry", async () => {
  const { privateDenyRules } = await import("./trusted-contribution.mjs");
  const rules = privateDenyRules(CONTROLLER_HOME);
  for (const name of ["task-roots.json", "book-transport.json"])
    for (const tool of ["Read", "Edit", "Write"])
      assert.ok(rules.includes(`${tool}(/${path.join(CONTROLLER_HOME, name)})`), `${tool} ${name}`);
});
