import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { Team } from "./team.mjs";
import { RENAME_BACKOFF_MS, renameReplacing } from "./rename-retry.mjs";
import { describeWriteFailure } from "./management-refusal.mjs";

// FU-444b: on Windows a rename over a file that another process has open fails for a short time.
function catalogTeam() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rename-retry-")));
  const tasks = path.join(dir, "tasks.json");
  fs.writeFileSync(tasks, JSON.stringify({ version: 1, issues: [] }), { mode: 0o600 });
  const team = new Team(
    { store: { db: { exec() {} } } },
    { config: { tasks, authority: { issueApi: null } } },
  );
  // The private-file ACL check is not under test here (a temp folder on Windows fails it); the write path is.
  team.catalog = () => JSON.parse(fs.readFileSync(tasks, "utf8"));
  return { dir, tasks, team };
}
const busy = (code) => Object.assign(Error(`${code}: operation not permitted, rename`), { code });

test("a catalog write survives a target that is busy for a moment (EPERM, EBUSY, EACCES)", () => {
  const { dir, tasks, team } = catalogTeam();
  const real = fs.renameSync;
  const codes = ["EPERM", "EBUSY", "EACCES"];
  const rename = mock.method(fs, "renameSync", (...args) => {
    if (codes.length) throw busy(codes.shift());
    return real(...args);
  });
  try {
    team.writeCatalog((data) => data.issues.push({ id: "row" }));
    assert.equal(rename.mock.callCount(), 4);
    assert.ok(JSON.parse(fs.readFileSync(tasks, "utf8")).issues.some((row) => row.id === "row"));
    assert.deepEqual(fs.readdirSync(dir), ["tasks.json"]);
  } finally {
    rename.mock.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a target that stays busy throws the last error after the back-off and leaves no temporary file", () => {
  const { dir, tasks, team } = catalogTeam();
  const rename = mock.method(fs, "renameSync", () => {
    throw busy("EPERM");
  });
  try {
    assert.throws(() => team.writeCatalog(() => undefined), { code: "EPERM" });
    assert.equal(rename.mock.callCount(), RENAME_BACKOFF_MS.length + 1);
    assert.deepEqual(fs.readdirSync(dir), ["tasks.json"]);
    assert.deepEqual(JSON.parse(fs.readFileSync(tasks, "utf8")).issues, []);
  } finally {
    rename.mock.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("other rename errors are not retried", () => {
  const waits = [];
  const rename = mock.method(fs, "renameSync", () => {
    throw busy("ENOENT");
  });
  try {
    assert.throws(() => renameReplacing("a", "b", (ms) => waits.push(ms)), { code: "ENOENT" });
    assert.equal(rename.mock.callCount(), 1);
    assert.deepEqual(waits, []);
  } finally {
    rename.mock.restore();
  }
});

test("describeWriteFailure gives the class, the system code and a location, never the message", () => {
  const error = busy("EPERM");
  const text = describeWriteFailure(error);
  assert.match(text, /^Error at .+:\d+:\d+ code EPERM$/);
  assert.ok(!text.includes("operation not permitted"));
  assert.equal(
    describeWriteFailure(Object.assign(Error("x"), { code: "secret value" })).includes("secret"),
    false,
  );
});

test("a plain catalog write works (Windows refuses fsync on a read-only handle)", () => {
  const { dir, tasks, team } = catalogTeam();
  try {
    team.writeCatalog((data) => data.issues.push({ id: "plain" }));
    assert.ok(JSON.parse(fs.readFileSync(tasks, "utf8")).issues.some((row) => row.id === "plain"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
