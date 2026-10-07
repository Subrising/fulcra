import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  parseControllerCommand,
  MANAGEMENT_METHODS,
  READ_METHODS,
  OWNED_CHANNEL_METHODS,
  NATIVE_OWNER_METHODS,
} from "./command-parser.mjs";
const id = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
test("parser covers every operator dispatcher case and excludes delegated capability lanes", () => {
  const source = fs.readFileSync(new URL("./rpc.mjs", import.meta.url), "utf8");
  const cases = [
    ...source.slice(source.indexOf("switch (request.method)")).matchAll(/case ['"]([^'"]+)['"]/g),
  ].map((m) => m[1]);
  assert.deepEqual(
    [...MANAGEMENT_METHODS].sort(),
    [...cases, ...OWNED_CHANNEL_METHODS, ...NATIVE_OWNER_METHODS].sort(),
  );
  for (const method of [
    "send",
    "manager-create",
    "cc-inbox-answer",
    "__proto__",
    "constructor",
    "unknown",
  ])
    assert.throws(() => parseControllerCommand({ method }), /Unknown controller method/);
});
test("strict method and input envelopes refuse authority injection and malformed nested commands", () => {
  assert.throws(() => parseControllerCommand({ method: "list", principal: { kind: "human" } }));
  assert.throws(() =>
    parseControllerCommand({
      method: "create",
      input: { messageId: id, taskId: id, provider: "claude", title: "Task", principal: "human" },
    }),
  );
  assert.throws(() =>
    parseControllerCommand({
      method: "management-prepare",
      input: {
        kind: "send",
        messageId: id,
        body: { sessionId: id, expectedGeneration: 1, text: "hello", principal: "human" },
      },
    }),
  );
  assert.throws(() =>
    parseControllerCommand({
      method: "manager-resume",
      input: {
        sessionId: id,
        messageId: id,
        expectedGeneration: 1,
        reason: "Explicit handback",
        workers: [{ sessionId: id, expectedGeneration: 1, operator: "secret" }],
      },
    }),
  );
  for (const method of MANAGEMENT_METHODS)
    assert.throws(() => parseControllerCommand({ method, input: { unexpected: "value" } }), method);
});
test("parser accepts supported values without reading configuration and returns detached data", () => {
  assert.deepEqual(parseControllerCommand({ method: "list" }), { method: "list" });
  const command = {
    method: "operator-send",
    input: { sessionId: id, messageId: id, expectedGeneration: 1, text: "Continue the owned task" },
  };
  const parsed = parseControllerCommand(command);
  command.input.text = "changed";
  assert.equal(parsed.input.text, "Continue the owned task");
  assert.deepEqual(
    parseControllerCommand({
      method: "worktree-lifecycle-retention",
      input: { retentionDays: "never" },
    }).input,
    { retentionDays: "never" },
  );
  assert.throws(() =>
    parseControllerCommand({ ...command, input: { ...command.input, expectedGeneration: "1" } }),
  );
  assert.throws(() =>
    parseControllerCommand({ ...command, input: { ...command.input, text: "a".repeat(16385) } }),
  );
  for (const method of READ_METHODS) assert.ok(MANAGEMENT_METHODS.includes(method));
  // R13-V1 option (a): the lifecycle preview is an operator-authenticated read; apply and retention stay writes.
  assert.ok(READ_METHODS.includes("worktree-lifecycle-preview"));
  assert.ok(!READ_METHODS.includes("worktree-lifecycle-apply"));
  assert.ok(!READ_METHODS.includes("worktree-lifecycle-retention"));
  assert.ok(!READ_METHODS.includes("observe"));
});
test("parser rejects getters and non-data objects without invoking them", () => {
  let calls = 0;
  const input = {};
  Object.defineProperty(input, "method", {
    enumerable: true,
    get() {
      calls++;
      return "list";
    },
  });
  assert.throws(() => parseControllerCommand(input));
  assert.equal(calls, 0);
  for (const value of [
    { method: "list", input: new Date() },
    { method: "list", input: NaN },
    Object.assign(Object.create({ method: "list" }), {}),
  ])
    assert.throws(() => parseControllerCommand(value));
});
test("representative nested management payloads preserve existing portable provider and tracker choices", () => {
  const examples = [
    {
      method: "create",
      input: {
        messageId: id,
        taskId: id,
        provider: "claude",
        title: "Owned task",
        host: "This Mac",
        defaults: { modeId: "auto", thinkingOptionId: "medium", model: "claude", ask: ["Bash"] },
      },
    },
    {
      method: "trackers-map",
      input: {
        project: id,
        expectedRevision: 0,
        note: "Read-only tracker mapping",
        auth: "gh-cli",
        tracker: "github",
        site: "github.com",
        remoteId: "123",
        remoteName: "example/project",
        validatedAt: "2026-09-27T00:00:00Z",
      },
    },
    {
      method: "management-prepare",
      input: {
        kind: "send",
        messageId: id,
        body: { sessionId: id, expectedGeneration: 1, text: "Owned instruction" },
      },
    },
    {
      method: "book-activity-page",
      input: { sessionId: id, taskId: id, cursor: null, includeMessages: true },
    },
    {
      method: "cc-channel-pair-open",
      input: {
        kind: "cli",
        label: "Operator console",
        scope: { canAnswer: false, levels: [1], projects: "all" },
      },
    },
  ];
  for (const command of examples)
    assert.deepEqual(JSON.parse(JSON.stringify(parseControllerCommand(command))), command);
});

test("role schemas preserve existing note limits and validate seat identities", () => {
  const input = {
    expectedRevision: 0,
    expectedSessionGeneration: 1,
    role: "prime",
    seat: "operations",
    sessionId: id,
    note: "A".repeat(1500),
  };
  assert.deepEqual(parseControllerCommand({ method: "bindings-assign", input }).input, input);
  assert.throws(() =>
    parseControllerCommand({
      method: "bindings-assign",
      input: { ...input, role: "project-orchestrator" },
    }),
  );
  assert.throws(() =>
    parseControllerCommand({
      method: "bindings-unassign",
      input: { role: "prime", seat: "operations", expectedRevision: 0, note: "Explicit removal" },
    }),
  );
  assert.throws(() =>
    parseControllerCommand({
      method: "seat-inbox",
      input: { role: "project-orchestrator", seat: id },
    }),
  );
  assert.equal(
    parseControllerCommand({
      method: "seat-receipt",
      input: { channelId: id, messageId: id, note: "A".repeat(1500) },
    }).input.note.length,
    1500,
  );
});

test("native receipt maintenance parser exposes status only without promoting a read principal", () => {
  assert.deepEqual(
    parseControllerCommand({ method: "intercom-receipt-maintenance", input: null }),
    { method: "intercom-receipt-maintenance", input: null },
  );
  assert.equal(READ_METHODS.includes("intercom-receipt-maintenance"), false);
  for (const input of [
    { owner: true },
    { authentication: "protected-local-ipc" },
    { reportKind: "owner" },
    { prune: true },
    { maxIds: 20000 },
  ])
    assert.throws(() => parseControllerCommand({ method: "intercom-receipt-maintenance", input }));
});

test("native report registration parser validates exact identities and refuses credential/label shortcuts", () => {
  const identity = { agentId: id, instanceId: id, sessionId: id, boot: id };
  const scopes = [{ projectId: id, taskId: id }];
  const prime = {
    method: "report-prime-register",
    input: { messageId: id, identity, scopes, expectedEpoch: null },
  };
  assert.deepEqual(JSON.parse(JSON.stringify(parseControllerCommand(prime))), prime);
  for (const input of [
    { ...prime.input, owner: true },
    { ...prime.input, reportKind: "owner" },
    { ...prime.input, identity: { ...identity, label: "prime" } },
    { ...prime.input, scopes: [{ projectId: "all", taskId: id }] },
  ])
    assert.throws(() => parseControllerCommand({ ...prime, input }));
  for (const method of NATIVE_OWNER_METHODS) assert.equal(READ_METHODS.includes(method), false);
});

test("native intercom owner Settings and capability reads are strict and never delegated READ methods", () => {
  assert.deepEqual(
    parseControllerCommand({
      method: "intercom-rate-settings-get",
      input: null,
    }),
    { method: "intercom-rate-settings-get", input: null },
  );
  assert.deepEqual(
    parseControllerCommand({
      method: "intercom-status",
      input: { agentId: id },
    }),
    { method: "intercom-status", input: { agentId: id } },
  );
  for (const method of ["intercom-rate-settings-get", "intercom-status"]) {
    assert.equal(READ_METHODS.includes(method), false);
    assert.equal(NATIVE_OWNER_METHODS.includes(method), true);
  }
  for (const input of [
    { agentId: id, reportKind: true },
    { agentId: id, owner: true },
    { agentId: id, authentication: "protected-local-ipc" },
  ])
    assert.throws(() => parseControllerCommand({ method: "intercom-status", input }));
  assert.throws(() =>
    parseControllerCommand({
      method: "intercom-rate-settings-get",
      input: { settings: {} },
    }),
  );
});

test("managed artifact namespaces use strict owner-only setters and metadata reads", () => {
  const identity = { agentId: id, instanceId: id, sessionId: "native-fixture", boot: id };
  const scope = { projectId: id, taskId: id };
  const enable = {
    messageId: id,
    identity,
    expectedEpoch: id,
    scope,
    enabled: true,
    expiresAt: 1234,
  };
  const read = { identity, expectedEpoch: id, scope };
  for (const [method, input] of [
    ["artifact-tool-owner-set", enable],
    ["managed-artifact-index-owner-read", read],
  ]) {
    assert.deepEqual(parseControllerCommand({ method, input }), { method, input });
    assert.equal(READ_METHODS.includes(method), false);
    assert.equal(NATIVE_OWNER_METHODS.includes(method), true);
    for (const extra of [
      { owner: true },
      { authentication: "protected-local-ipc" },
      { reportKind: "owner" },
      { path: "/throwaway/private" },
    ])
      assert.throws(() => parseControllerCommand({ method, input: { ...input, ...extra } }));
  }
});

test("content purpose strict owner routes refuse flags, paths and invalid chunk bounds", () => {
  const identity = { agentId: id, instanceId: id, sessionId: "native-fixture", boot: id };
  const scope = { projectId: id, taskId: id };
  const set = {
    messageId: id,
    grantId: id,
    identity,
    expectedEpoch: id,
    scope,
    artifactIds: [id],
    byteBudget: 8,
    expiresAt: 1234,
    expectedGrantRevision: null,
    enabled: true,
  };
  const read = {
    requestId: id,
    grantId: id,
    grantRevision: id,
    artifactId: id,
    identity,
    expectedEpoch: id,
    scope,
    offset: 0,
    length: 8,
  };
  for (const [method, input] of [
    ["artifact-content-owner-set", set],
    ["artifact-content-owner-list", { identity, expectedEpoch: id, scope }],
    ["artifact-content-owner-read", read],
  ]) {
    assert.deepEqual(parseControllerCommand({ method, input }), { method, input });
    assert.equal(READ_METHODS.includes(method), false);
    assert.equal(NATIVE_OWNER_METHODS.includes(method), true);
    for (const extra of [
      { owner: true },
      { reportKind: "owner" },
      { authentication: "protected-local-ipc" },
      { path: "/throwaway/path" },
    ])
      assert.throws(() => parseControllerCommand({ method, input: { ...input, ...extra } }));
  }
  for (const patch of [{ length: 8193 }, { offset: -1 }, { length: 0 }])
    assert.throws(() =>
      parseControllerCommand({
        method: "artifact-content-owner-read",
        input: { ...read, ...patch },
      }),
    );
});

test("cleanup settings and now accept no caller paths or runtime identities", () => {
  assert.deepEqual(
    parseControllerCommand({ method: "worktree-lifecycle-settings", input: {} }).input,
    {},
  );
  assert.deepEqual(
    parseControllerCommand({ method: "worktree-lifecycle-now", input: { requestId: id } }).input,
    { requestId: id },
  );
  assert.throws(() =>
    parseControllerCommand({
      method: "worktree-lifecycle-now",
      input: { requestId: id, path: ".." },
    }),
  );
  assert.deepEqual(
    parseControllerCommand({
      method: "worktree-lifecycle-now",
      input: { requestId: id, previewId: id },
    }).input,
    { requestId: id, previewId: id },
  );
  assert.throws(() =>
    parseControllerCommand({ method: "worktree-lifecycle-settings", input: { idleMinutes: 0 } }),
  );
});
