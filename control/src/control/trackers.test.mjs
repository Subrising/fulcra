// J3 issue trackers: controller mapping and link records (J3-DESIGN.md §3.5, §5, mutations §9).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import { Trackers, TRACKER_LIMITS } from "./trackers.mjs";
import { rpc } from "./rpc.mjs";

const P = (n) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;
const T = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const CANARY = "CANARY-" + randomUUID();
function directory({
  projects = [P(1), P(2)],
  membership = [
    { taskId: T(1), projectId: P(1) },
    { taskId: T(2), projectId: P(2) },
  ],
  available = true,
} = {}) {
  return {
    observedAt: "2026-09-23T00:00:00.000Z",
    available,
    partial: false,
    projects: projects.map((id, n) => ({
      id,
      name: `Project ${n}`,
      description: null,
      status: "in_progress",
    })),
    membership,
    note: "test",
  };
}
function open(file, source) {
  const store = new ControlStore(file);
  const native = new Proxy(
    {},
    {
      get: () => () => {
        throw Error("Trackers must not invoke the native runtime");
      },
    },
  );
  const control = new Controller({
    store,
    native,
    authority: async () => ({ id: "task", delegationAuthority: [] }),
  });
  control.trackers = new Trackers(control, async () => source.value);
  return { store, control, request: rpc(control, "test-operator") };
}
function setup(t, source = { value: directory() }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-trackers-"))),
    file = path.join(dir, "journal.sqlite");
  const opened = open(file, source);
  t.after(() => {
    try {
      opened.store.close?.();
      opened.store.db.close();
    } catch {
      /* closed by a reopen case */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { ...opened, file, dir, source };
}
const GH = {
  tracker: "github",
  auth: "keychain",
  site: "github.com",
  remoteId: "123456",
  remoteName: "Subrising/scratch",
};
const mapInput = (extra = {}) => ({
  project: P(1),
  expectedRevision: 0,
  note: "scratch repo",
  validatedAt: new Date().toISOString(),
  ...GH,
  ...extra,
});
const op = (request, method, input) => request({ method, input, operator: "test-operator" });
const enrol = (store, task) => {
  const id = randomUUID();
  store.created(id, task, `/owned/${id}`);
  return id;
};

test("C1: every tracker method is operator-only; a capability or a missing secret is refused", async (t) => {
  const { request } = setup(t);
  for (const method of [
    "trackers-map",
    "trackers-unmap",
    "trackers-link",
    "trackers-unlink",
    "trackers-project",
    "trackers-links-for",
    "trackers-status",
    "trackers-history",
    "trackers-directory",
  ]) {
    await assert.rejects(
      request({ method, input: mapInput(), capability: "a".repeat(43) }),
      /Operator authorization required/,
      method,
    );
    await assert.rejects(
      request({ method, input: mapInput() }),
      /Operator authorization required/,
      method,
    );
    await assert.rejects(
      request({ method, input: mapInput(), operator: "wrong" }),
      /Operator authorization required/,
      method,
    );
  }
  const done = await op(request, "trackers-map", mapInput());
  assert.equal(done.mapping.revision, 1);
  assert.equal(done.grantsAuthority, false);
});

test("C2: a mapping needs a project the current directory confirms; an unavailable source refuses", async (t) => {
  const { control, source } = setup(t);
  await assert.rejects(control.trackers.map(mapInput({ project: P(9) })), /Unknown project/);
  source.value = directory({ available: false });
  await assert.rejects(control.trackers.map(mapInput()), /Project directory unavailable/);
  assert.equal(control.trackers.row(P(1)), null);
});

test("C3: expectedRevision pins every write, and the counter survives an unmap", async (t) => {
  const { control } = setup(t);
  await control.trackers.map(mapInput());
  await assert.rejects(
    control.trackers.map(mapInput({ expectedRevision: 0, remoteId: "999" })),
    /revision changed/,
  );
  const remapped = await control.trackers.map(
    mapInput({ expectedRevision: 1, remoteId: "999", remoteName: "Subrising/other" }),
  );
  assert.equal(remapped.mapping.revision, 2);
  assert.throws(
    () => control.trackers.unmap({ project: P(1), expectedRevision: 1, note: "" }),
    /revision changed/,
  );
  const unmapped = control.trackers.unmap({ project: P(1), expectedRevision: 2, note: "done" });
  assert.equal(unmapped.mapping.state, "unmapped");
  assert.equal(unmapped.mapping.revision, 3);
  await assert.rejects(control.trackers.map(mapInput({ expectedRevision: 0 })), /revision changed/);
  assert.equal((await control.trackers.map(mapInput({ expectedRevision: 3 }))).mapping.revision, 4);
});

test("C4: history is append-only and records before and after for map, remap and unmap", async (t) => {
  const { control } = setup(t);
  await control.trackers.map(mapInput());
  await control.trackers.map(
    mapInput({ expectedRevision: 1, remoteId: "777", remoteName: "Subrising/b" }),
  );
  control.trackers.unmap({ project: P(1), expectedRevision: 2, note: "x" });
  const h = control.trackers.history(P(1)).mappings;
  assert.deepEqual(
    h.map((r) => r.action),
    ["map", "remap", "unmap"],
  );
  assert.equal(h[0].before, null);
  assert.equal(h[0].after.remoteId, "123456");
  assert.equal(h[1].before.remoteId, "123456");
  assert.equal(h[1].after.remoteId, "777");
  assert.equal(h[2].before.state, "mapped");
  assert.equal(h[2].after.state, "unmapped");
  assert.deepEqual(
    h.map((r) => [r.previousRevision, r.revision]),
    [
      [0, 1],
      [1, 2],
      [2, 3],
    ],
  );
  assert.ok(h.every((r) => r.actor === "operator"));
});

test("C5: identities are validated, no credential-shaped input is accepted and the journal has no credential column", async (t) => {
  const { control, file } = setup(t);
  for (const bad of [
    { tracker: "gitlab" },
    { auth: "token" },
    { site: "evil.example" },
    { remoteId: "Subrising/scratch" },
    { remoteId: "0" },
    { remoteName: "Subrising/.." },
    { remoteName: "../x" },
    {
      tracker: "jira",
      auth: "gh-cli",
      site: "acme.atlassian.net",
      remoteId: "10001",
      remoteName: "ORCA",
    },
    { validatedAt: "yesterday" },
    { validatedAt: new Date(Date.now() + 86400000).toISOString() },
  ]) {
    await assert.rejects(
      control.trackers.map(mapInput(bad)),
      /Invalid tracker mapping/,
      JSON.stringify(bad),
    );
  }
  for (const extra of [{ token: CANARY }, { credential: CANARY }, { url: "https://evil.example" }])
    await assert.rejects(control.trackers.map(mapInput(extra)), /Invalid tracker mapping/);
  await control.trackers.map(mapInput());
  const columns = (table) =>
    control.store.db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((r) => r.name)
      .join(",");
  assert.equal(
    columns("tracker_mappings"),
    "project,tracker,auth,site,remoteId,remoteName,state,revision,validatedAt,note,at",
  );
  assert.equal(
    columns("tracker_links"),
    "id,project,subjectKind,subjectId,tracker,site,remoteId,remoteName,itemRef,url,state,revision,createdAt,at",
  );
  for (const f of [file, file + "-wal"])
    if (fs.existsSync(f)) assert.equal(fs.readFileSync(f).includes(CANARY), false, f);
});

test("C6: a link subject must be an explicit member of the project; unavailable membership refuses", async (t) => {
  const { control, store, source } = setup(t);
  const { mapping } = await control.trackers.map(mapInput());
  const link = (subject) =>
    control.trackers.link({
      project: P(1),
      subject,
      itemRef: "7",
      expectedMappingRevision: mapping.revision,
    });
  assert.equal((await link({ kind: "task", id: T(1) })).link.subject.id, T(1));
  await assert.rejects(link({ kind: "task", id: T(2) }), /not an explicitly recorded member/);
  await assert.rejects(link({ kind: "task", id: T(3) }), /not an explicitly recorded member/);
  const member = enrol(store, T(1)),
    outsider = enrol(store, T(2));
  assert.equal((await link({ kind: "session", id: member })).link.subject.kind, "session");
  await assert.rejects(
    link({ kind: "session", id: outsider }),
    /not an explicitly recorded member/,
  );
  await assert.rejects(link({ kind: "session", id: randomUUID() }), /saved session identity/);
  source.value = directory({ available: false });
  await assert.rejects(
    control.trackers.link({
      project: P(1),
      subject: { kind: "task", id: T(1) },
      itemRef: "8",
      expectedMappingRevision: 1,
    }),
    /Project directory unavailable/,
  );
});

test("C7: the stored URL is constructed from the mapping; no URL or repo is accepted from input", async (t) => {
  const { control, request } = setup(t);
  await control.trackers.map(mapInput());
  for (const extra of [
    { url: "https://evil.example/x" },
    { remoteId: "999" },
    { repo: "evil/repo" },
  ]) {
    await assert.rejects(
      control.trackers.link({
        project: P(1),
        subject: { kind: "task", id: T(1) },
        itemRef: "7",
        expectedMappingRevision: 1,
        ...extra,
      }),
      /Invalid tracker link/,
    );
  }
  for (const itemRef of ["0", "7/../../x", "-1", "12a", "ORCA-1"]) {
    await assert.rejects(
      control.trackers.link({
        project: P(1),
        subject: { kind: "task", id: T(1) },
        itemRef,
        expectedMappingRevision: 1,
      }),
      /Invalid tracker item/,
    );
  }
  const { link } = await op(request, "trackers-link", {
    project: P(1),
    subject: { kind: "task", id: T(1) },
    itemRef: "42",
    expectedMappingRevision: 1,
  });
  assert.equal(link.url, "https://github.com/Subrising/scratch/issues/42");
  assert.equal(
    control.store.db.prepare("SELECT url FROM tracker_links").get().url,
    "https://github.com/Subrising/scratch/issues/42",
  );
  await control.trackers.map(
    mapInput({
      project: P(2),
      expectedRevision: 0,
      tracker: "jira",
      auth: "keychain",
      site: "acme.atlassian.net",
      remoteId: "10001",
      remoteName: "ORCA",
    }),
  );
  await assert.rejects(
    control.trackers.link({
      project: P(2),
      subject: { kind: "task", id: T(2) },
      itemRef: "OTHER-3",
      expectedMappingRevision: 1,
    }),
    /Invalid tracker item/,
  );
  assert.equal(
    (
      await control.trackers.link({
        project: P(2),
        subject: { kind: "task", id: T(2) },
        itemRef: "ORCA-3",
        expectedMappingRevision: 1,
      })
    ).link.url,
    "https://acme.atlassian.net/browse/ORCA-3",
  );
});

test("C8: linking sends nothing: no delivery row is written for the subject session", async (t) => {
  const { control, store } = setup(t);
  await control.trackers.map(mapInput());
  const session = enrol(store, T(1)),
    count = () => store.db.prepare("SELECT count(*) n FROM deliveries").get().n;
  const before = count();
  await control.trackers.link({
    project: P(1),
    subject: { kind: "session", id: session },
    itemRef: "5",
    expectedMappingRevision: 1,
  });
  assert.equal(count(), before);
  assert.equal(store.get(session).generation, 1);
});

test("C9: a remap keeps old links as from a previous mapping and refuses a stale mapping revision", async (t) => {
  const { control } = setup(t);
  await control.trackers.map(mapInput());
  await control.trackers.link({
    project: P(1),
    subject: { kind: "task", id: T(1) },
    itemRef: "5",
    expectedMappingRevision: 1,
  });
  await control.trackers.map(
    mapInput({ expectedRevision: 1, remoteId: "999", remoteName: "Subrising/other" }),
  );
  await assert.rejects(
    control.trackers.link({
      project: P(1),
      subject: { kind: "task", id: T(1) },
      itemRef: "6",
      expectedMappingRevision: 1,
    }),
    /mapping changed/,
  );
  const view = control.trackers.project(P(1));
  assert.equal(view.links.length, 1);
  assert.equal(view.links[0].fromPreviousMapping, true);
  assert.equal(view.links[0].url, "https://github.com/Subrising/scratch/issues/5");
  await control.trackers.link({
    project: P(1),
    subject: { kind: "task", id: T(1) },
    itemRef: "5",
    expectedMappingRevision: 2,
  });
  const fresh = control.trackers.project(P(1)).links.find((l) => l.remoteId === "999");
  assert.equal(fresh.fromPreviousMapping, false);
  assert.equal(fresh.url, "https://github.com/Subrising/other/issues/5");
});

test("C10: unlink and relink are revisioned and recorded; linksFor reads active links only", async (t) => {
  const { control } = setup(t);
  await control.trackers.map(mapInput());
  const { link } = await control.trackers.link({
    project: P(1),
    subject: { kind: "task", id: T(1) },
    itemRef: "5",
    expectedMappingRevision: 1,
  });
  await assert.rejects(
    control.trackers.link({
      project: P(1),
      subject: { kind: "task", id: T(1) },
      itemRef: "5",
      expectedMappingRevision: 1,
    }),
    /already linked/,
  );
  assert.throws(
    () => control.trackers.unlink({ link: link.id, expectedRevision: 2 }),
    /revision changed/,
  );
  control.trackers.unlink({ link: link.id, expectedRevision: 1 });
  assert.deepEqual(control.trackers.linksFor({ subjects: [T(1)] }).links, []);
  const again = await control.trackers.link({
    project: P(1),
    subject: { kind: "task", id: T(1) },
    itemRef: "5",
    expectedMappingRevision: 1,
  });
  assert.equal(again.link.id, link.id);
  assert.equal(again.link.revision, 3);
  assert.deepEqual(
    control.trackers.history(P(1)).links.map((h) => h.action),
    ["link", "unlink", "relink"],
  );
  assert.equal(control.trackers.linksFor({ subjects: [T(1), T(2)] }).links.length, 1);
  assert.throws(
    () => control.trackers.linksFor({ subjects: Array.from({ length: 65 }, () => T(1)) }),
    /Invalid tracker link read/,
  );
});

test("C11: per-subject link capacity is enforced", async (t) => {
  const { control } = setup(t);
  await control.trackers.map(mapInput());
  for (let n = 1; n <= TRACKER_LIMITS.linksPerSubject; n++)
    await control.trackers.link({
      project: P(1),
      subject: { kind: "task", id: T(1) },
      itemRef: String(n),
      expectedMappingRevision: 1,
    });
  await assert.rejects(
    control.trackers.link({
      project: P(1),
      subject: { kind: "task", id: T(1) },
      itemRef: "999",
      expectedMappingRevision: 1,
    }),
    /capacity reached for this subject/,
  );
});

test("C13: the directory view lists projects, member tasks, their sessions and mappings, and nothing else", async (t) => {
  const { request, store } = setup(t);
  await op(request, "trackers-map", mapInput());
  const s = enrol(store, T(1));
  enrol(store, T(9));
  const view = await op(request, "trackers-directory");
  assert.deepEqual(
    view.projects.map((p) => [
      p.id,
      p.tasks,
      p.sessions.map((x) => x.id),
      p.mapping?.remoteId ?? null,
    ]),
    [
      [P(1), [T(1)], [s], "123456"],
      [P(2), [T(2)], [], null],
    ],
  );
  await assert.rejects(op(request, "trackers-directory", {}), /takes no input/);
});

test("C12: mappings and links survive a controller restart; tracker item data is never stored", async (t) => {
  const ctx = setup(t);
  await ctx.control.trackers.map(mapInput());
  await ctx.control.trackers.link({
    project: P(1),
    subject: { kind: "task", id: T(1) },
    itemRef: "5",
    expectedMappingRevision: 1,
  });
  ctx.store.db.close();
  const reopened = open(ctx.file, ctx.source);
  t.after(() => {
    try {
      reopened.store.db.close();
    } catch {
      /* already closed */
    }
  });
  const view = reopened.control.trackers.project(P(1));
  assert.equal(view.mapping.remoteId, "123456");
  assert.equal(view.links.length, 1);
  assert.equal(Object.hasOwn(view.links[0], "title"), false);
  assert.equal(reopened.control.trackers.status().mappings.length, 1);
});

// Structural guard (mutation M21): nothing but the operator-gated RPC branch and the controller's own wiring
// may reach the tracker records, so no channel message, seat lane or delegated tool can create a link.
test("C14: tracker records are reachable only from the operator-gated RPC branch and controller wiring", () => {
  const root = path.dirname(new URL(import.meta.url).pathname),
    files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".mjs") && !p.includes(".test.") && !p.includes(".mutations."))
        files.push(p);
    }
  };
  walk(path.resolve(root, ".."));
  const touching = files
    .filter((f) => {
      const s = fs.readFileSync(f, "utf8");
      return (
        s.includes("control.trackers") ||
        s.includes("trackers(control)") ||
        s.includes("from './trackers.mjs'")
      );
    })
    .map((f) => path.relative(root, f))
    .sort();
  assert.deepEqual(touching, ["rpc.mjs", "server.mjs"]);
  const rpcSource = fs.readFileSync(path.join(root, "rpc.mjs"), "utf8"),
    gate = rpcSource.indexOf("throw new Error('Operator authorization required')");
  assert.ok(gate > 0);
  for (
    let i = rpcSource.indexOf("trackers(control)");
    i >= 0;
    i = rpcSource.indexOf("trackers(control)", i + 1)
  )
    assert.ok(i > gate, "a trackers call precedes the operator gate");
});
