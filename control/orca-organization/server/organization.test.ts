import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type http from "node:http";
import type { PaseoApi, PaseoAgent } from "@getpaseo/client";
// Private test configuration first: some plugin modules read it when they load.
import { FIXTURE_COMPANY, FIXTURE_PROGRAMME } from "./portable.fixture";
import { readBoard, inspectArtifact, organizationSnapshot, createSnapshotReader } from "./organization";
import { snapshotRpc } from "../shared/organization";
import { CONTROLLER_METHOD, appOwnershipRecord, projectRequestSessionRpc, roleAdoptRpc, roleAllowanceSetRpc, roleAllowancesRpc, roleAssignRpc, roleDirectoryRpc, roleProjectRpc, sessionOwnershipRpc, sessionRequestsRpc } from "../shared/roles";
const board = { available: true, identifier: "AIN-73", title: "Actual task", status: "in_progress", owner: "local-board", error: null };
test('selected task uses actual enrollment rather than labels, including human-started sessions', async () => {
  const human = { id: "enrolled-human", labels: { owner: "Operator" }, title: "Human session", provider: "claude", model: "test", status: "idle", updatedAt: "now", pendingPermissions: [] } as unknown as PaseoAgent;
  const foreign = { ...human, id: "foreign", labels: { owner: "orca-control" } };
  const read: string[] = [];
  const api = { agents: { list: async () => ({ entries: [{ agent: human }, { agent: foreign }], pageInfo: { hasMore: false } }), ref: (id: string) => ({ refresh: async () => { read.push(id); return { agent: human }; } }) } } as unknown as PaseoApi;
  const result = await organizationSnapshot(api, async () => board, new Set([human.id]));
  assert.deepEqual(read, [human.id]); assert.deepEqual(result.sessions.map(s => s.id), [human.id]);
});
function fakeHttp(statusCode: number, body: string) {
  return ((_url: string, callback: (r: unknown) => void) => {
    const req = Object.assign(new EventEmitter(), { destroy() {} });
    queueMicrotask(() => { const res = Object.assign(new EventEmitter(), { statusCode, destroy() {} }); callback(res); res.emit("data", Buffer.from(body)); res.emit("end"); });
    return req;
  }) as unknown as typeof http.get;
}
test("fixed board validates identity, refuses error and oversized responses", async () => {
  const issue = { id: FIXTURE_PROGRAMME, companyId: FIXTURE_COMPANY, identifier: "AIN-73", title: "Real outcome", status: "in_progress", assigneeUserId: "local-board" };
  const good = await readBoard(fakeHttp(200, JSON.stringify(issue))); assert.equal(good.available, true); assert.equal(good.title, "Real outcome"); assert.equal(good.owner, "local-board");
  const childId = '11111111-1111-4111-8111-111111111111';
  const child = await readBoard(fakeHttp(200, JSON.stringify({ ...issue, id: childId, identifier: 'AIN-74' })), childId);
  assert.equal(child.available, true); assert.equal(child.identifier, 'AIN-74');
  const missing = await readBoard(fakeHttp(404, '{}'), childId); assert.equal(missing.identifier, childId);
  assert.equal((await readBoard(fakeHttp(404, '{}'))).identifier, 'AIN-73');
  for (const fields of [{ companyId: 'foreign' }, { identifier: null }, { identifier: 'AIN-99' }, { title: null }, { status: null }]) assert.equal((await readBoard(fakeHttp(200, JSON.stringify({ ...issue, ...fields })))).available, false);
  for (const [status, body] of [[503, "failure"], [200, "bad json"], [200, JSON.stringify({ ...issue, id: "wrong" })], [200, "x".repeat(131073)]] as const) {
    const result = await readBoard(fakeHttp(status, body)); assert.equal(result.available, false); assert.equal(result.title, null); assert.equal(result.owner, null);
  }
});
test("artifact reads are fixed-scope bounded hashes and reject symlinks", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "orca-artifact-")));
  try { fs.mkdirSync(path.join(root, "claude")); const f = path.join(root, "claude/leadership-brief.md");
    fs.writeFileSync(f, "first"); const a = inspectArtifact("claude/leadership-brief.md", root); assert.match(a.sha256!, /^[a-f0-9]{64}$/);
    fs.writeFileSync(f, "second"); assert.notEqual(inspectArtifact("claude/leadership-brief.md", root).sha256, a.sha256);
    fs.writeFileSync(f, "x".repeat(65537)); assert.equal(inspectArtifact("claude/leadership-brief.md", root).sha256, null);
    fs.unlinkSync(f); fs.symlinkSync("/etc/hosts", f); assert.equal(inspectArtifact("claude/leadership-brief.md", root).sha256, null);
    assert.equal(inspectArtifact("../../etc/hosts", root).sha256, null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test("observation filters owners and does not treat idle as acceptance", async () => {
  const agent = { id: "owned", labels: { owner: "orca-test" }, title: "Saved worker", provider: "codex", model: "test-model", persistence: { sessionId: "native-resume" }, status: "idle", updatedAt: "2026-09-11T00:00:00Z", pendingPermissions: [{ id: "one" }, { id: "two" }] } as unknown as PaseoAgent;
  const called: string[] = [];
  const api = { agents: { list: async () => ({ entries: [{ agent }, { agent: { ...agent, id: "human", labels: { owner: "Operator" } } }], pageInfo: { hasMore: true } }), ref: (id: string) => { called.push(id); return { refresh: async () => ({ agent }) }; } } } as unknown as PaseoApi;
  const result = await organizationSnapshot(api, async () => board); assert.deepEqual(called, ["owned"]); assert.equal(result.sessions[0].nativeId, "native-resume"); assert.equal(result.sessions[0].pending, 2); assert.equal(result.sessions[0].status, "idle"); assert.deepEqual(result.sessions[0].artifacts, []); assert.match(result.coverage, /Partial/); assert.match(result.remote, /not observed/);
});
test("board and session outages are separate explicit unknown states", async () => {
  const api = { agents: { list: async () => { throw new Error("offline"); } } } as unknown as PaseoApi;
  const result = await organizationSnapshot(api, async () => ({ ...board, available: false, title: null, status: null, owner: null, error: "Task authority unavailable" }));
  assert.equal(result.sessionsAvailable, false); assert.equal(result.board.available, false); assert.deepEqual(result.sessions, []);
  assert.throws(() => snapshotRpc.input.parse({ issue: "another issue", path: "/private" }));
});

test("two viewers coalesce and never relabel cached observations as fresh", async () => {
  let calls = 0, clock = 0;
  const api = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } } as unknown as PaseoApi;
  const initial = await organizationSnapshot(api, async () => board);
  const read = createSnapshotReader(async () => { calls++; return initial; }, () => clock);
  const [one, two] = await Promise.all([read(), read()]); assert.equal(calls, 1); assert.equal(one, two);
  for (clock = 1000; clock < 300000; clock += 1000) await Promise.all([read(), read()]);
  assert.equal(calls, 10); assert.equal((await read()).observedAt, initial.observedAt);
});

test("server entry obeys host cleanup contract and registers explicit management alongside observation", async () => {
  const { default: contribute } = await import("../index.server");
  const names: string[] = [];
  const server = new Proxy({ handle(contract: { name: string }) { names.push(contract.name); return undefined; } }, { get(target, name) { if (name === "secrets" || name === "notify" || name === "device" || name === "credentials") return undefined; /* the sanctioned structural reads: ctx.secrets (J3 trackers), ctx.notify (J3b push), ctx.device (J5b pairing) and ctx.credentials (J4, host-mediated requests, CONTRACTS v1.7); absent here, so push, pairing and host credentials stay off */ if (name !== "handle") throw new Error("Unexpected hook or action"); return target.handle; } });
  const cleanup = contribute(server as unknown as Parameters<typeof contribute>[0]);
  // C1 integration: the union of every job's registered methods (J0, J3, J1, J4, J6, J8), in registration order.
  // WL (d6cd5164) registers its worktree Clean-up methods first.
  assert.equal(typeof cleanup, "function"); assert.deepEqual(names, ["organization.cleanup-preview", "organization.cleanup-apply", "organization.cleanup-retention", "organization.projects", "organization.fleet", "organization.activity", "organization.fleet-hosts", "organization.activity-history", "organization.session-turns", "organization.session-step", "organization.session-file-history", "organization.project-briefing", "organization.role-directory", "organization.role-project", "organization.role-assign", "organization.project-session-requests", "organization.role-allowances", "organization.role-adopt", "organization.role-allowance-set", "organization.project-request-session", "organization.work-map", "organization.work-map-project", "organization.session-ownership", "organization.session-defaults", "organization.outcome", "organization.outcome-artifact", "organization.manage", "organization.recovery", "organization.recovery-act", "organization.task-manage", "organization.tasks", "organization.usage", "organization.trackers", "organization.trackers.directory", "organization.trackers.resolve", "organization.trackers.map", "organization.trackers.unmap", "organization.trackers.link", "organization.trackers.unlink", "organization.integrations", "organization.tracker-mappings", "organization.tracker-mappings.resolve", "organization.tracker-mappings.map", "organization.tracker-mappings.unmap", "organization.tracker-view", "organization.tracker-refresh", "organization.links.set", "organization.links.remove", "organization.links", "organization.inbox", "organization.decision", "organization.decision-choose", "organization.review-record", "organization.held-message", "organization.held-read", "organization.held-reply", "organization.held-release", "organization.digest", "organization.environments", "organization.environment-propose", "organization.promotion-create", "organization.promotion-cancel", "organization.devices", "organization.device-pair-open", "organization.device-pair-complete", "organization.device-pair-approve", "organization.device-revoke", "organization.channels", "organization.channel-pair-open", "organization.channel-pause", "organization.channel-revoke", "organization.remits", "organization.remit-assign", "organization.remit-move", "organization.remit-end", "organization.project-domain-set", "organization.project-brief", "organization.snapshot"]); cleanup();
});

test("the app-facing seam method name is pinned to an exact literal and is registered", async () => {
  // CROSS-TREE CONTRACT. The app calls this method by literal string in
  // packages/app/src/sessions/session-ownership-store.ts. Neither tree can import from the other,
  // so the only honest defence is that each side asserts the exact literal it uses.
  //
  // A mismatch is SILENT by design: an unknown method rejects, the app's store swallows it and
  // renders every row unassigned, which is byte-for-byte what a correctly refusing controller
  // produces. Both suites stay green and the seam looks healthy while being dead. So this literal
  // must never be changed without changing the app's literal in the same breath.
  const SEAM = "organization.session-ownership";
  assert.equal(sessionOwnershipRpc.name, SEAM);

  // It must be registered, not merely defined.
  const { default: contribute } = await import("../index.server");
  const names: string[] = [];
  const server = new Proxy({ handle(contract: { name: string }) { names.push(contract.name); return undefined; } },
    { get(target, name) { return name in target ? (target as Record<string, unknown>)[name as string] : () => undefined; } });
  contribute(server as unknown as Parameters<typeof contribute>[0])();
  assert.ok(names.includes(SEAM), `${SEAM} must be registered by index.server`);

  // @getpaseo/plugin validates method names against this pattern and THROWS at registration on any
  // uppercase character. So the camelCase spelling the app currently uses cannot be registered at
  // all - "fixing" this literal to match the app would break the plugin rather than the seam.
  const RPC_NAME = /^[a-z][a-z0-9._-]*$/;
  assert.ok(RPC_NAME.test(SEAM), "the seam name must be registrable");
  assert.equal(RPC_NAME.test("organization.sessionOwnership"), false,
    "the camelCase spelling is unregistrable; the app must use the kebab-case name");
});

test("every registered role method name is pinned and registrable", () => {
  // Same reasoning, one level wider: these are the names the controller and the app agree on.
  const pinned: Array<[{ name: string }, string]> = [
    [roleDirectoryRpc, "organization.role-directory"],
    [roleProjectRpc, "organization.role-project"],
    [roleAssignRpc, "organization.role-assign"],
    [projectRequestSessionRpc, "organization.project-request-session"],
    [sessionRequestsRpc, "organization.project-session-requests"],
    [roleAdoptRpc, "organization.role-adopt"],
    [roleAllowancesRpc, "organization.role-allowances"],
    [roleAllowanceSetRpc, "organization.role-allowance-set"],
    [sessionOwnershipRpc, "organization.session-ownership"],
  ];
  const RPC_NAME = /^[a-z][a-z0-9._-]*$/;
  for (const [contract, expected] of pinned) {
    assert.equal(contract.name, expected);
    assert.ok(RPC_NAME.test(contract.name), `${contract.name} must be registrable`);
  }
});

test("the controller methods this plugin calls are pinned to exact literals", () => {
  // The other half of the same class: these strings are the contract with the controller, and a
  // wrong one refuses wholesale rather than failing loudly, so they are asserted rather than trusted.
  assert.deepEqual({ ...CONTROLLER_METHOD }, {
    directory: "bindings-status",
    project: "bindings-project",
    assign: "bindings-assign",
    unassign: "bindings-unassign",
    requestSession: "roles-request-session",
    sessionRequests: "roles-session-requests",
    ownership: "roles-ownership",
    adopt: "roles-adopt",
    allowances: "roles-allowances",
    allowanceSet: "roles-allowance-set",
  });
});

test("the seam payload keys are pinned, since the protocol package cannot be imported", () => {
  // THIRD CROSS-TREE PAIR. The fork declares these in packages/protocol/src/session-ownership.ts
  // as SessionOwnershipRequest { agentIds } and SessionOwnershipResponse { ownership }. I cannot
  // import them: the vendored @getpaseo/protocol 0.8.0 ships no session-ownership module, and the
  // fork's build carries the SAME version string, so a version check would not reveal the gap.
  // See payload-key-divergence.md. Until a published protocol ships dist/session-ownership.d.ts,
  // the honest defence is that each side asserts its own literals.
  assert.deepEqual(Object.keys(sessionOwnershipRpc.input.shape), ["agentIds"]);
  assert.deepEqual(Object.keys(sessionOwnershipRpc.output.shape), ["ownership"]);

  // The record the app destructures, field for field, in the agreed order.
  assert.deepEqual(Object.keys(appOwnershipRecord.shape), [
    "projectId", "projectName", "taskId", "taskTitle",
    "leaderAgentId", "leaderTitle", "state", "detail",
  ]);

  // The fork's own SESSION_OWNERSHIP_RPC constant is this same kebab-case string. Restated here
  // rather than imported, for the reason above; if these ever disagree the seam is dead silently.
  assert.equal(sessionOwnershipRpc.name, "organization.session-ownership");
});
