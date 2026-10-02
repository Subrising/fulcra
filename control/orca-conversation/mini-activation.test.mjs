import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { verifyKnownActivation } from "./mini-activation.mjs";
const sha = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-probe-pair-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const active = dir + "/active.json";
  const releases = ["old", "new"].map((name) => {
    const entry = dir + "/" + name + ".mjs",
      helper = dir + "/" + name + "-helper.mjs";
    fs.writeFileSync(helper, "export const boot=" + JSON.stringify(name) + ";");
    fs.writeFileSync(
      entry,
      `import{boot}from'./${name}-helper.mjs';export const verifyActivation=()=>boot;`,
    );
    return { guard: name, entry, files: { [entry]: sha(entry), [helper]: sha(helper) } };
  });
  const select = (guard) =>
    fs.writeFileSync(active, JSON.stringify({ guard: { sha256: guard } }), { mode: 0o600 });
  select("old");
  return { dir, active, releases, select };
}
test("selects the exact old/new verifier and retains both directions", async (t) => {
  const f = fixture(t);
  for (const name of ["old", "new", "old", "new"]) {
    f.select(name);
    assert.equal(await verifyKnownActivation(f.active, f.releases), name);
  }
});
test("unknown or ambiguous guard refuses before import without fallback", async (t) => {
  const f = fixture(t);
  f.select("unknown");
  await assert.rejects(verifyKnownActivation(f.active, f.releases), /Unknown/);
  f.select("old");
  await assert.rejects(
    verifyKnownActivation(f.active, [f.releases[0], f.releases[0]]),
    /ambiguous/,
  );
});
test("drift in the entrypoint or a local dependency refuses even after a cached import", async (t) => {
  for (const which of [0, 1]) {
    const f = fixture(t);
    assert.equal(await verifyKnownActivation(f.active, f.releases), "old");
    const file = Object.keys(f.releases[0].files)[which];
    fs.appendFileSync(file, "\n// changed");
    await assert.rejects(verifyKnownActivation(f.active, f.releases), /closure changed/);
  }
});
test("a replaced alias, writable active selector, or unpinned entrypoint refuses", async (t) => {
  const f = fixture(t);
  fs.chmodSync(f.active, 0o666);
  await assert.rejects(verifyKnownActivation(f.active, f.releases), /ownership/);
  fs.chmodSync(f.active, 0o600);
  const entry = f.releases[0].entry;
  fs.renameSync(entry, entry + ".copy");
  fs.symlinkSync(entry + ".copy", entry);
  await assert.rejects(verifyKnownActivation(f.active, f.releases), /ownership/);
  fs.unlinkSync(entry);
  fs.renameSync(entry + ".copy", entry);
  await assert.rejects(
    verifyKnownActivation(f.active, [{ ...f.releases[0], files: {} }]),
    /not pinned/,
  );
});
test("a selected verifier rejection is propagated; the other verifier is never tried", async (t) => {
  const f = fixture(t);
  const r = f.releases[0];
  fs.writeFileSync(
    r.entry,
    "export function verifyActivation(){throw Error('Live loaded guard mismatch')}",
  );
  r.files[r.entry] = sha(r.entry);
  await assert.rejects(verifyKnownActivation(f.active, f.releases), /Live loaded guard mismatch/);
});
test("generated unknown guards and malformed selectors cannot choose a release", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 200; i++) {
    f.select("foreign-" + i);
    await assert.rejects(verifyKnownActivation(f.active, f.releases), /Unknown/);
  }
  for (const v of [{}, [], { guard: {} }, { guard: { sha256: null } }]) {
    fs.writeFileSync(f.active, JSON.stringify(v));
    await assert.rejects(verifyKnownActivation(f.active, f.releases), /Unknown/);
  }
});
