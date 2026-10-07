import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { WorktreeLifecycle, contained, lifecycleSettings } from "./worktree-lifecycle.mjs";
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
async function fixture(t, state = "archived", { keepDays = 7 } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "wl-test-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, "home"),
    dir = path.join(home, "tasks", "job-one"),
    repo = path.join(base, "repo"),
    remote = path.join(base, "remote.git"),
    wt = path.join(dir, "checkout");
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(repo);
  await fs.mkdir(remote);
  git(remote, "init", "--bare");
  git(repo, "init");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture");
  await fs.writeFile(path.join(repo, ".gitignore"), "node_modules/\ndist/\n");
  await fs.writeFile(path.join(repo, "REPORT.md"), "Fixture evidence");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "fixture");
  git(repo, "remote", "add", "origin", remote);
  git(repo, "push", "origin", "HEAD");
  git(repo, "worktree", "add", "-b", "job-one", wt);
  await fs.mkdir(path.join(wt, "node_modules"));
  await fs.writeFile(path.join(wt, "node_modules", "large"), "fixture");
  await fs.mkdir(path.join(dir, "node_modules"));
  await fs.writeFile(path.join(dir, "node_modules", "bundle"), "fixture");
  await fs.writeFile(path.join(dir, "REPORT.md"), "Keep me");
  await fs.writeFile(path.join(dir, "SESSION-ID"), "fixture");
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const session = { state, at: "2020-01-01T00:00:00Z" },
    pr = { state: "open" };
  const service = new WorktreeLifecycle({
    home,
    db,
    session: async () => session,
    pr: async () => pr,
  });
  // An unset keep-time reads as "never", which removes nothing; these fixtures use seven days.
  if (keepDays !== null) await service.settings.set(keepDays);
  return { base, home, dir, repo, wt, remote, db, service, session, pr };
}
test("clean pushed worktree and outputs removed; branch, reports, inputs and journal kept", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.dir, "inputs"));
  await fs.writeFile(path.join(f.dir, "inputs", "brief"), "keep");
  const plan = await f.service.dryRun();
  assert.equal(plan.jobs[0].eligible, true);
  const r = await f.service.apply({ planId: plan.planId, confirm: true });
  assert.equal(r.results[0].state, "complete");
  await assert.rejects(fs.stat(f.wt));
  await assert.rejects(fs.stat(path.join(f.dir, "node_modules")));
  assert.equal(await fs.readFile(path.join(f.dir, "REPORT.md"), "utf8"), "Keep me");
  assert.ok(git(f.repo, "branch", "--list", "job-one"));
  assert.ok(await fs.stat(path.join(f.dir, "inputs", "brief")));
  const receipts = f.db.prepare("SELECT * FROM cc_job_cleanup").all();
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, "complete");
  assert.ok(receipts[0].bytes > 0);
  assert.ok(await fs.stat(path.join(f.dir, "kept-files", receipts[0].id, "checkout", "REPORT.md")));
});
for (const mode of ["dirty", "untracked", "unpushed", "live", "unknown", "open"])
  test(`${mode} remains intact`, async (t) => {
    const f = await fixture(t);
    if (mode === "dirty") await fs.appendFile(path.join(f.wt, "REPORT.md"), "change");
    if (mode === "untracked") await fs.writeFile(path.join(f.wt, "new"), "change");
    if (mode === "unpushed") {
      await fs.writeFile(path.join(f.wt, "new"), "change");
      git(f.wt, "add", ".");
      git(f.wt, "commit", "-m", "unpushed");
    }
    if (["live", "unknown"].includes(mode)) f.session.state = mode;
    if (mode === "open") f.session.state = "idle";
    const plan = await f.service.dryRun();
    assert.equal(plan.jobs[0].eligible, false, mode);
    assert.ok(plan.jobs[0].blockers.length);
    if (mode === "unpushed") assert.match(plan.jobs[0].blockers.join(), /1 unpushed commit/);
    await f.service.apply({ planId: plan.planId, confirm: true });
    assert.ok(await fs.stat(f.wt));
    assert.ok(await fs.stat(path.join(f.dir, "node_modules")));
  });
test("merged idle job and zero retention; recent archive respects seven days", async (t) => {
  const f = await fixture(t, "idle");
  f.pr.state = "merged";
  f.pr.at = new Date().toISOString();
  assert.equal((await f.service.dryRun()).jobs[0].eligible, false);
  await f.service.settings.set(0);
  assert.equal((await f.service.dryRun()).jobs[0].eligible, true);
  f.session.state = "live";
  assert.equal((await f.service.dryRun()).jobs[0].eligible, false);
});
test("dirty or live after preview is rechecked", async (t) => {
  const f = await fixture(t);
  const p = await f.service.dryRun();
  await fs.appendFile(path.join(f.wt, "REPORT.md"), "change");
  assert.equal(
    (await f.service.apply({ planId: p.planId, confirm: true })).results[0].state,
    "skipped",
  );
  assert.ok(await fs.stat(f.wt));
  git(f.wt, "restore", "REPORT.md");
  const p2 = await f.service.dryRun();
  f.session.state = "live";
  assert.equal(
    (await f.service.apply({ planId: p2.planId, confirm: true })).results[0].state,
    "skipped",
  );
});
test("escaped symlink and direct root containment are refused", async (t) => {
  const f = await fixture(t);
  await fs.symlink(f.repo, path.join(f.dir, "escape"));
  const p = await f.service.dryRun();
  assert.equal(p.jobs[0].eligible, false);
  assert.match(p.jobs[0].blockers.join(), /escapes/);
  await assert.rejects(contained(path.join(f.home, "tasks"), f.repo), /escapes/);
  await assert.rejects(
    contained(path.join(f.home, "tasks"), path.join(f.home, "tasks")),
    /escapes/,
  );
  await f.service.apply({ planId: p.planId, confirm: true });
  assert.ok(await fs.stat(f.repo));
});
test("never disables automatic cleanup; candidates only listed; settings persist", async (t) => {
  const f = await fixture(t);
  const candidate = path.join(f.home, "admission", "candidate-example");
  await fs.mkdir(candidate, { recursive: true });
  await fs.writeFile(path.join(candidate, "asset"), "keep");
  await f.service.settings.set("never");
  assert.equal(await lifecycleSettings(f.home).get(), "never");
  await f.service.automatic();
  assert.ok(await fs.stat(f.wt));
  const p = await f.service.dryRun();
  assert.equal(p.candidates.length, 1);
  assert.ok(p.candidates[0].bytes > 0);
  await f.service.apply({ planId: p.planId, confirm: true });
  assert.ok(await fs.stat(candidate));
});
test("remote branch removed after pushing blocks cleanup despite stale tracking refs", async (t) => {
  const f = await fixture(t);
  const branch = git(f.repo, "symbolic-ref", "--short", "HEAD");
  git(f.remote, "config", "receive.denyDeleteCurrent", "ignore");
  git(f.repo, "push", "origin", "--delete", branch);
  const p = await f.service.dryRun();
  assert.equal(p.jobs[0].eligible, false);
  assert.match(p.jobs[0].blockers.join(), /unpushed/);
});
test("fresh branch at the same path requires another preview", async (t) => {
  const f = await fixture(t);
  const p = await f.service.dryRun();
  git(f.wt, "switch", "-c", "replacement");
  const result = await f.service.apply({ planId: p.planId, confirm: true });
  assert.equal(result.results[0].state, "skipped");
  assert.ok(await fs.stat(f.wt));
});
test("preview expires and confirmation is required", async (t) => {
  const f = await fixture(t);
  let clock = Date.now();
  f.service.now = () => clock;
  const p = await f.service.dryRun();
  await assert.rejects(f.service.apply({ planId: p.planId, confirm: false }));
  clock += 900001;
  await assert.rejects(f.service.apply({ planId: p.planId, confirm: true }), /expired/);
  assert.ok(await fs.stat(f.wt));
});
test("reports inside generated output are copied to kept files before removal", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.wt, "dist"));
  await fs.writeFile(path.join(f.wt, "dist", "REPORT.md"), "Evidence");
  const p = await f.service.dryRun();
  assert.ok(p.jobs[0].keep.includes("checkout/dist/REPORT.md"));
  await f.service.apply({ planId: p.planId, confirm: true });
  const receipt = f.db.prepare("SELECT id FROM cc_job_cleanup").get();
  assert.equal(
    await fs.readFile(
      path.join(f.dir, "kept-files", receipt.id, "checkout", "dist", "REPORT.md"),
      "utf8",
    ),
    "Evidence",
  );
});
test("ignored signing material is not treated as disposable build output", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.wt, "node_modules", "signing.keystore"), "valuable");
  const p = await f.service.dryRun();
  assert.equal(p.jobs[0].eligible, false);
  assert.match(p.jobs[0].blockers.join(), /signing/);
});
test("long previews and applies are polled; apply retries return the original result", async (t) => {
  const f = await fixture(t);
  const first = f.service.previewRequest();
  assert.equal(first.pending, true);
  await f.service.requests.get(first.operationId).promise;
  const ready = f.service.previewRequest({ operationId: first.operationId });
  assert.equal(ready.pending, false);
  const input = { planId: ready.value.planId, confirm: true };
  assert.equal(f.service.applyRequest(input).pending, true);
  await f.service.requests.get(input.planId).promise;
  const result = f.service.applyRequest(input);
  assert.equal(result.value.results[0].state, "complete");
  assert.deepEqual(f.service.applyRequest(input), result);
  assert.equal(f.db.prepare("SELECT count(*) n FROM cc_job_cleanup").get().n, 1);
  assert.throws(() => f.service.previewRequest({ operationId: input.planId }), /expired/);
});
test("contained dependency executable links do not prevent safe worktree removal", async (t) => {
  const f = await fixture(t);
  await fs.symlink("large", path.join(f.wt, "node_modules", "executable"));
  const p = await f.service.dryRun();
  assert.equal(p.jobs[0].eligible, true);
  const r = await f.service.apply({ planId: p.planId, confirm: true });
  assert.equal(r.results[0].state, "complete");
});
test("keep-time never blocks every removal, manual included; Clean up now previews before acting", async (t) => {
  const f = await fixture(t);
  await f.service.settings.set("never");
  const blocked = await f.service.dryRun();
  assert.equal(blocked.jobs[0].eligible, false);
  assert.match(blocked.jobs[0].blockers.join(), /never/);
  await f.service.apply({ planId: blocked.planId, confirm: true });
  assert.ok(await fs.stat(f.wt));

  await f.service.settings.set(7);
  const settle = async (out) => {
    while (out.pending) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      out = f.service.cleanupRequest({ operationId: out.operationId });
    }
    return out.value;
  };
  const preview = await settle(f.service.cleanupRequest({ requestId: crypto.randomUUID() }));
  assert.ok(preview.previewId);
  assert.deepEqual(
    preview.results.map((r) => [r.action, r.state]),
    [["worktree", "planned"]],
  );
  assert.ok(await fs.stat(f.wt), "a preview removes nothing");
  await assert.rejects(
    async () =>
      f.service.cleanupRequest({ requestId: crypto.randomUUID(), previewId: crypto.randomUUID() }),
    /Preview expired/,
  );
  const done = await settle(
    f.service.cleanupRequest({ requestId: crypto.randomUUID(), previewId: preview.previewId }),
  );
  assert.equal(done.results[0].action, "worktree");
  await assert.rejects(fs.stat(f.wt));
  await assert.rejects(
    async () =>
      f.service.cleanupRequest({ requestId: crypto.randomUUID(), previewId: preview.previewId }),
    /Preview expired/,
  );
});
test("turning automatic cleanup off after preview preserves the job", async (t) => {
  const f = await fixture(t);
  const p = await f.service.dryRun();
  await f.service.settings.set("never");
  const r = await f.service.apply({ planId: p.planId, confirm: true }, { automatic: true });
  assert.equal(r.results[0].state, "skipped");
  assert.ok(await fs.stat(f.wt));
});
test("evidence links require attention before any removal", async (t) => {
  const f = await fixture(t);
  await fs.symlink("REPORT.md", path.join(f.dir, "linked.md"));
  const p = await f.service.dryRun();
  assert.equal(p.jobs[0].eligible, false);
  assert.match(p.jobs[0].blockers.join(), /Evidence symlink/);
});
test("a stale tracking ref outside a custom fetch refspec cannot hide unpushed work", async (t) => {
  const f = await fixture(t);
  const main = git(f.repo, "symbolic-ref", "--short", "HEAD");
  git(f.repo, "config", "remote.origin.fetch", `+refs/heads/${main}:refs/remotes/origin/${main}`);
  await fs.writeFile(path.join(f.wt, "new"), "not on the remote");
  git(f.wt, "add", ".");
  git(f.wt, "commit", "-m", "private work");
  git(f.wt, "update-ref", "refs/remotes/origin/stale", "HEAD");
  const p = await f.service.dryRun();
  assert.equal(p.jobs[0].eligible, false);
  assert.match(p.jobs[0].blockers.join(), /1 unpushed commit/);
});
test("merged idle jobs remove loose output before losing their last PR lookup", async (t) => {
  const f = await fixture(t, "idle");
  f.service.pr = async () => {
    try {
      await fs.stat(f.wt);
      return { state: "merged", at: "2020-01-01T00:00:00Z" };
    } catch {
      return null;
    }
  };
  const p = await f.service.dryRun();
  const r = await f.service.apply({ planId: p.planId, confirm: true });
  assert.equal(r.results[0].state, "complete");
  await assert.rejects(fs.stat(f.wt));
  await assert.rejects(fs.stat(path.join(f.dir, "node_modules")));
});
test("partial cleanup records removed paths and reclaimed bytes before a later live-state stop", async (t) => {
  const f = await fixture(t);
  f.service.session = async () => {
    try {
      await fs.stat(path.join(f.dir, "node_modules"));
      return { state: "archived", at: "2020-01-01T00:00:00Z" };
    } catch {
      return { state: "live" };
    }
  };
  const p = await f.service.dryRun();
  const r = await f.service.apply({ planId: p.planId, confirm: true });
  assert.equal(r.results[0].state, "needs-attention");
  assert.ok(r.results[0].bytes > 0);
  assert.ok(await fs.stat(f.wt));
  const row = f.db.prepare("SELECT * FROM cc_job_cleanup").get();
  assert.deepEqual(JSON.parse(row.paths), ["node_modules"]);
  assert.ok(row.bytes > 0);
  assert.equal(row.state, "needs-attention");
});
test("an installation inside an otherwise finished job is protected", async (t) => {
  const f = await fixture(t);
  f.service.protectedPaths = [f.wt];
  const p = await f.service.dryRun();
  assert.equal(p.jobs[0].eligible, false);
  assert.match(p.jobs[0].blockers.join(), /Installation files are protected/);
  await f.service.apply({ planId: p.planId, confirm: true });
  assert.ok(await fs.stat(f.wt));
  assert.ok(await fs.stat(path.join(f.dir, "node_modules")));
});

// R-WL P1–P4/P13 regressions: only temporary repositories and homes.
for (const flag of ["--skip-worktree", "--assume-unchanged"])
  test(`hidden tracked edits ${flag} block removal`, async (t) => {
    const f = await fixture(t);
    git(f.wt, "update-index", flag, "REPORT.md");
    await fs.writeFile(path.join(f.wt, "REPORT.md"), "hidden local edits");
    const p = await f.service.dryRun();
    assert.equal(p.jobs[0].eligible, false);
    assert.match(p.jobs[0].blockers.join(), /Hidden index/);
    await f.service.apply({ planId: p.planId, confirm: true });
    assert.equal(await fs.readFile(path.join(f.wt, "REPORT.md"), "utf8"), "hidden local edits");
  });
test("large ignored evidence is preserved without a size cutoff", async (t) => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.repo, ".git", "info", "exclude"), "\nnotes.txt\nsession.log\n");
  const data = "x".repeat(2 * 1048576);
  for (const name of ["notes.txt", "session.log"]) await fs.writeFile(path.join(f.wt, name), data);
  const p = await f.service.dryRun();
  assert.equal(p.jobs[0].eligible, true);
  const r = await f.service.apply({ planId: p.planId, confirm: true });
  assert.equal(r.results[0].state, "complete");
  const row = f.db.prepare("SELECT id FROM cc_job_cleanup").get();
  for (const name of ["notes.txt", "session.log"])
    assert.equal(
      await fs.readFile(path.join(f.dir, "kept-files", row.id, "checkout", name), "utf8"),
      data,
    );
});
test("loose signed artefacts and databases remain in place", async (t) => {
  const f = await fixture(t);
  for (const file of ["evidence/build/signed-release.ipa", "cache/decisions.sqlite"]) {
    await fs.mkdir(path.dirname(path.join(f.dir, file)), { recursive: true });
    await fs.writeFile(path.join(f.dir, file), "irreplaceable");
  }
  const p = await f.service.dryRun();
  assert.equal(p.jobs[0].eligible, true);
  assert.deepEqual(p.jobs[0].remove, ["node_modules", "checkout"]);
  await f.service.apply({ planId: p.planId, confirm: true });
  for (const file of ["evidence/build/signed-release.ipa", "cache/decisions.sqlite"])
    assert.equal(await fs.readFile(path.join(f.dir, file), "utf8"), "irreplaceable");
});
test("three passes do not recycle kept files or dependency Markdown", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.wt, "node_modules", "README.md"), "dependency");
  const saved = path.join(f.dir, "kept-files", "old", "node_modules");
  await fs.mkdir(saved, { recursive: true });
  await fs.writeFile(path.join(saved, "README.md"), "old evidence");
  let listing;
  for (let i = 0; i < 3; i++) {
    const p = await f.service.dryRun();
    await f.service.apply({ planId: p.planId, confirm: true });
    const next = (await fs.readdir(path.join(f.dir, "kept-files"), { recursive: true })).sort();
    if (listing) assert.deepEqual(next, listing);
    listing = next;
  }
  assert.equal(f.db.prepare("SELECT count(*) n FROM cc_job_cleanup").get().n, 1);
  assert.equal(listing.filter((x) => x.endsWith("README.md")).length, 1);
  assert.equal(await fs.readFile(path.join(saved, "README.md"), "utf8"), "old evidence");
});
test("cleanup leaves another unavailable detached worktree registered and reachable", async (t) => {
  const f = await fixture(t),
    other = path.join(f.base, "other-job"),
    parked = path.join(f.base, "parked");
  git(f.repo, "worktree", "add", "--detach", other);
  await fs.writeFile(path.join(other, "private"), "unpushed");
  git(other, "add", ".");
  git(other, "commit", "-m", "private detached commit");
  const sha = git(other, "rev-parse", "HEAD");
  await fs.rename(other, parked);
  const p = await f.service.dryRun();
  await f.service.apply({ planId: p.planId, confirm: true });
  assert.ok(
    git(f.repo, "worktree", "list", "--porcelain").includes(`worktree ${other}\nHEAD ${sha}`),
  );
  await fs.rename(parked, other);
  assert.equal(git(other, "rev-parse", "HEAD"), sha);
  assert.equal(git(other, "show", "HEAD:private"), "unpushed");
});
test("unrecognised ignored files block the entire job", async (t) => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.repo, ".git", "info", "exclude"), "\nprivate.dat\n");
  await fs.writeFile(path.join(f.wt, "private.dat"), "unique");
  const p = await f.service.dryRun();
  assert.equal(p.jobs[0].eligible, false);
  assert.match(p.jobs[0].blockers.join(), /Unrecognised ignored/);
  await f.service.apply({ planId: p.planId, confirm: true });
  assert.equal(await fs.readFile(path.join(f.wt, "private.dat"), "utf8"), "unique");
});
test("detached HEAD with unpushed work has an explicit detached blocker", async (t) => {
  const f = await fixture(t);
  git(f.wt, "checkout", "--detach");
  await fs.writeFile(path.join(f.wt, "private"), "work");
  git(f.wt, "add", ".");
  git(f.wt, "commit", "-m", "private");
  const p = await f.service.dryRun();
  assert.equal(p.jobs[0].eligible, false);
  assert.match(p.jobs[0].blockers.join(), /Detached worktree/);
  assert.match(p.jobs[0].blockers.join(), /unpushed/);
});
test("nested ignored repository has an explicit nested blocker", async (t) => {
  const f = await fixture(t);
  const nested = path.join(f.wt, "dist", "nested");
  git(f.repo, "worktree", "add", "-b", "nested", nested);
  const p = await f.service.dryRun();
  assert.equal(p.jobs[0].eligible, false);
  assert.match(p.jobs[0].blockers.join(), /Nested repository/);
});
test("internal symlink alias is refused", async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.home, "tasks", "alias");
  await fs.symlink(f.dir, alias);
  await assert.rejects(contained(path.join(f.home, "tasks"), alias), /Symlink/);
  const p = await f.service.dryRun();
  assert.equal(p.jobs.find((j) => j.id === "alias").eligible, false);
});
test("loose dist signing key blocks the job", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.dir, "dist"));
  await fs.writeFile(path.join(f.dir, "dist", "release.jks"), "secret");
  const p = await f.service.dryRun();
  assert.equal(p.jobs[0].eligible, false);
  assert.match(p.jobs[0].blockers.join(), /Signing/);
});
test("automatic cleanup defaults off until an operator saves days", async (t) => {
  const f = await fixture(t, "archived", { keepDays: null });
  assert.equal(await f.service.settings.get(), "never");
  assert.equal(await f.service.automatic(), undefined);
  assert.ok(await fs.stat(f.wt));
  assert.equal(f.db.prepare("SELECT count(*) n FROM cc_job_cleanup").get().n, 0);
  await f.service.settings.set(7);
  assert.equal((await f.service.automatic()).results[0].state, "complete");
  await assert.rejects(fs.stat(f.wt));
});
test("latest finish and locked worktrees block early cleanup", async (t) => {
  const f = await fixture(t);
  f.pr.state = "merged";
  f.pr.at = new Date().toISOString();
  assert.match((await f.service.dryRun()).jobs[0].blockers.join(), /Retention/);
  f.pr.at = "2020-01-01T00:00:00Z";
  git(f.repo, "worktree", "lock", f.wt);
  assert.match((await f.service.dryRun()).jobs[0].blockers.join(), /Locked/);
});
test("busy apply does not poison the manual token", async (t) => {
  const f = await fixture(t);
  const p = await f.service.dryRun();
  f.service.busy = true;
  assert.throws(
    () => f.service.applyRequest({ planId: p.planId, confirm: true }),
    /already running/,
  );
  assert.equal(f.service.requests.has(p.planId), false);
  f.service.busy = false;
  f.service.applyRequest({ planId: p.planId, confirm: true });
  await f.service.stop();
  assert.equal(f.service.applyRequest({ planId: p.planId, confirm: true }).pending, false);
});
test("sparse checkout is conservatively blocked", async (t) => {
  const f = await fixture(t);
  git(f.wt, "sparse-checkout", "init", "--cone");
  assert.match((await f.service.dryRun()).jobs[0].blockers.join(), /Sparse checkout/);
});
test("kept files inside a worktree block removal even when ignored", async (t) => {
  const f = await fixture(t);
  await fs.appendFile(path.join(f.repo, ".git", "info", "exclude"), "\nkept-files/\n");
  await fs.mkdir(path.join(f.wt, "kept-files"));
  await fs.writeFile(path.join(f.wt, "kept-files", "notes.md"), "saved");
  const p = await f.service.dryRun();
  assert.equal(p.jobs[0].eligible, false);
  assert.match(p.jobs[0].blockers.join(), /Preserved files/);
});
test("a loose dependency directory containing a worktree is never recursively deleted", async (t) => {
  const f = await fixture(t);
  const nested = path.join(f.dir, "node_modules", "nested");
  git(f.repo, "worktree", "add", "-b", "second", nested);
  await fs.appendFile(path.join(f.repo, ".git", "info", "exclude"), "\nnotes.txt\n");
  await fs.writeFile(path.join(nested, "notes.txt"), "unique notes");
  const p = await f.service.dryRun();
  assert.equal(p.jobs[0].eligible, true);
  assert.equal(p.jobs[0].remove.includes("node_modules"), false);
  await f.service.apply({ planId: p.planId, confirm: true });
  assert.ok(await fs.stat(path.join(f.dir, "node_modules")));
  assert.equal(
    git(f.repo, "worktree", "list", "--porcelain").includes(`worktree ${nested}\n`),
    false,
  );
  const row = f.db.prepare("SELECT id FROM cc_job_cleanup").get();
  assert.equal(
    await fs.readFile(
      path.join(f.dir, "kept-files", row.id, "node_modules", "nested", "notes.txt"),
      "utf8",
    ),
    "unique notes",
  );
});
test("kept files inside loose dependencies block recursive removal", async (t) => {
  const f = await fixture(t);
  const saved = path.join(f.dir, "node_modules", "kept-files");
  await fs.mkdir(saved);
  await fs.writeFile(path.join(saved, "notes.md"), "saved");
  const p = await f.service.dryRun();
  assert.equal(p.jobs[0].eligible, false);
  assert.match(p.jobs[0].blockers.join(), /Preserved files/);
  await f.service.apply({ planId: p.planId, confirm: true });
  assert.equal(await fs.readFile(path.join(saved, "notes.md"), "utf8"), "saved");
});
