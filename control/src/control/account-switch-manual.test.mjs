// Update-7 W1 x W2: the owner's "Switch account…" / `/account` reaches W2's session-takeover command end to end.
// The plugin's switch (switchSession + controllerTakeOver) calls the controller the way the plugin host does -- a
// management invocation of `session-takeover` -- and the controller's real dispatcher runs W2's fenced takeover.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { FENCE_PROTOCOL } from "./native-fence.mjs";
import { ControlStore } from "./store.mjs";
import { Controller } from "./controller.mjs";
import { Recovery } from "./recovery.mjs";
import { COMPANY, PROGRAMME } from "./authority.mjs";
import { managementDispatcher } from "./rpc.mjs";
import {
  withManagementInvocation,
  invokeManagement,
} from "../../orca-organization/server/management-context.mjs";
import {
  addAccount,
  assign,
  readAccounts,
  accountOf,
  switchSession,
  controllerTakeOver,
  publicView,
} from "../../orca-organization/server/accounts.mjs";

const T = (n) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
const issue = (id) => ({
  id,
  companyId: COMPANY,
  parentId: id === PROGRAMME ? null : PROGRAMME,
  assigneeUserId: "local-board",
  assigneeAgentId: null,
  status: "in_progress",
});
const owner = {
  id: "owner",
  authentication: "daemon-password",
  permissions: ["command-centre.manage", "daemon.manage"],
};

async function world(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-manual-switch-")));
  const store = new ControlStore(path.join(dir, "journal.sqlite"));
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sent = [],
    snaps = new Map(),
    recovers = [];
  const native = {
    route: () => undefined,
    inspect: async () => ({
      boot: "boot-1",
      fenceProtocol: FENCE_PROTOCOL,
      saturated: false,
      humanAt: 0,
      status: "idle",
      pending: 0,
      lastPromptId: null,
      timelineCursor: { epoch: "e", seq: 1 },
    }),
    send: async (id, text, messageId) => {
      sent.push({ id, text, messageId });
    },
    snapshot: async (id) => ({
      id,
      provider: "claude",
      status: "idle",
      lastError: null,
      pendingPermissions: [],
      ...snaps.get(id),
    }),
    completion: async () => ({ ended: false, progress: {} }),
    quota: async () => null,
    recover: async (id) => {
      recovers.push(id);
      return { outcome: "refreshed", reason: null };
    },
  };
  const control = new Controller({ store, native, authority: async (id) => issue(id) });
  control.poolRoot = path.join(dir, "home");
  fs.mkdirSync(control.poolRoot);
  control.recovery = new Recovery(control, {});
  const id = randomUUID();
  store.created(id, T(1), path.join(dir, id));
  await control.handback(id, "Delegated for the manual switch verification");
  const a = await addAccount(control.poolRoot, { provider: "claude", name: "Work" }),
    b = await addAccount(control.poolRoot, { provider: "claude", name: "Personal" });
  await assign(control.poolRoot, id, "claude");
  // What the plugin host's localCall does: a management invocation, answered by the controller's dispatcher.
  const call = (method, input) =>
    withManagementInvocation(
      { management: { invoke: (command) => managementDispatcher(control)(command, owner) } },
      false,
      () => invokeManagement(method, input),
    );
  const sw = (account) =>
    switchSession(
      control.poolRoot,
      { sessionId: id, provider: "claude", account },
      { takeOver: controllerTakeOver(call) },
    );
  return { store, control, native, sent, snaps, recovers, id, a, b, sw, root: control.poolRoot };
}

test("switch -> the controller takeover moves the session with its history: one canonical entry, delegation and input identity untouched, no prompt", async (t) => {
  const w = await world(t),
    before = { ...w.store.get(w.id) },
    inputBefore = await w.native.inspect(w.id);
  const r = await w.sw("Personal");
  assert.equal(r.ok, true);
  assert.match(r.message, /Continued on account "Personal"/);
  assert.equal(accountOf(readAccounts(w.root), w.id).id, w.b.id);
  assert.deepEqual(w.recovers, [w.id]); // the quiet in-place reconnect
  const entries = w.store.db
    .prepare("SELECT id,body FROM deliveries WHERE session=? AND kind='account-switch'")
    .all(w.id);
  assert.equal(entries.length, 1);
  assert.equal(JSON.parse(entries[0].body).reason, "manual");
  // One pool row per move: W2's projection of the journal switch, keyed by its switchId (R1 re-check 3). The plugin
  // writes none of its own. That row is what Settings "Recent moves" labels "(your switch)".
  const rows = readAccounts(w.root).rotations;
  assert.equal(rows.length, 1);
  assert.deepEqual(
    [rows[0].reason, rows[0].switchId, rows[0].fromName, rows[0].toName],
    ["manual", entries[0].id, "Work", "Personal"],
  );
  assert.deepEqual(
    publicView(readAccounts(w.root)).rotations.map((r) => [r.from, r.to, r.reason]),
    [["Work", "Personal", "manual"]],
  );
  // COORD hazard: an owner's switch is never human input and never revokes a delegation.
  assert.deepEqual({ ...w.store.get(w.id) }, before);
  assert.deepEqual(await w.native.inspect(w.id), inputBefore);
  assert.equal(w.sent.length, 0, "no prompt is sent into the session");
});
test("switch -> a running turn is refused by the controller, and the session is still on its old account", async (t) => {
  const w = await world(t),
    before = { ...w.store.get(w.id) };
  w.snaps.set(w.id, { status: "running" });
  const r = await w.sw("Personal");
  assert.equal(r.ok, false);
  assert.match(r.message, /turn|finish|running/i);
  assert.equal(accountOf(readAccounts(w.root), w.id).id, w.a.id);
  assert.equal(
    w.store.db
      .prepare(
        "SELECT count(*) n FROM deliveries WHERE session=? AND kind='account-switch' AND state='delivered'",
      )
      .get(w.id).n,
    0,
  );
  assert.deepEqual({ ...w.store.get(w.id) }, before);
  assert.deepEqual(w.recovers, []);
  assert.equal(JSON.stringify(r).includes("sk-ant-"), false);
});

// ---- accounts.manage (U7 W1-REMOTE-ACCOUNTS, control side): session-takeover through the controller's management
// dispatcher accepts a paired device ONLY when the host admitted it with accounts.manage; never the read tier.
const device = (extra = []) => ({
  id: "iphone",
  authentication: "paired-device",
  deviceId: "dev_ABCDEFGHIJKLMNOP",
  permissions: ["command-centre.manage", "daemon.manage", ...extra],
});
const takeover = (w, principal) =>
  managementDispatcher(w.control)(
    { method: "session-takeover", input: { session: w.id, accountId: w.b.id } },
    principal,
  );
test("accounts-manage: device WITH capability can take over (controller)", async (t) => {
  const w = await world(t);
  const r = await takeover(w, device(["accounts.manage"]));
  assert.equal(r.state, "delivered");
  assert.equal(accountOf(readAccounts(w.root), w.id).id, w.b.id);
  assert.equal(
    w.store.db
      .prepare(
        "SELECT authentication, deviceId FROM management_calls WHERE method='session-takeover'",
      )
      .get().deviceId,
    "dev_ABCDEFGHIJKLMNOP",
  );
});
test("accounts-manage: full-management device WITHOUT capability is refused (controller)", async (t) => {
  const w = await world(t);
  await assert.rejects(
    () => Promise.resolve().then(() => takeover(w, device())),
    /account management/i,
  );
  assert.equal(accountOf(readAccounts(w.root), w.id).id, w.a.id);
  assert.deepEqual(w.recovers, []);
});
test("accounts-manage: read-tier (D13) device is refused (controller)", async (t) => {
  const w = await world(t);
  await assert.rejects(
    () =>
      Promise.resolve().then(() =>
        takeover(w, {
          ...device(),
          permissions: ["daemon.read", "workspace.read", "accounts.manage"],
        }),
      ),
    /refused|unauthor/i,
  );
  assert.equal(accountOf(readAccounts(w.root), w.id).id, w.a.id);
  assert.deepEqual(w.recovers, []);
});
test("accounts-manage: local owner still works (controller)", async (t) => {
  const w = await world(t);
  assert.equal((await takeover(w, owner)).state, "delivered");
});
