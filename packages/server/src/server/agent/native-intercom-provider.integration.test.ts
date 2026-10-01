import { Bindings } from "../../../../../control/src/control/bindings.mjs";
import { RoleSessions } from "../../../../../control/src/control/role-sessions.mjs";
import { hash } from "../../../../../control/src/control/store.mjs";
import { Controller } from "../../../../../control/src/control/controller.mjs";
import { boundNativeInputs } from "../../../../../control/src/control/trusted-native-input.mjs";
import {
  canonicalTrustedPayload,
  type IssueProvenanceV11,
  type Sha256,
} from "@getpaseo/protocol/trusted-input";
import { SessionAuthorization } from "../authorization/index.js";
import { SessionDelivery } from "../session/owned-subscriptions/index.js";
import {
  SessionInboundMessageSchema,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import { setupFinishNotification } from "./agent-prompt.js";
import { createPaseoToolCatalog } from "./tools/paseo-tools.js";
import { AgentStorage } from "./agent-storage.js";
import { ProviderSnapshotManager } from "./provider-snapshot-manager.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, mkdir as createDirectory, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { CodexAppServerAgentClient } from "./providers/codex-app-server-agent.js";
import { createFakeCodexAppServer } from "./providers/codex/test-utils/fake-app-server.js";
import { TrustedPlugins } from "../plugins/trusted.js";
import { MessageReceipts } from "../message-receipts/index.js";
import { consumeManagementDispatch } from "../plugins/management.js";
import { OWNER_PERMISSIONS } from "../authorization/index.js";
import { promptPayload } from "./trusted-operation.js";
import { Manager } from "../../../../../control/src/control/manager.mjs";
import { Events } from "../../../../../control/src/control/events.mjs";
import { Permissions } from "../../../../../control/src/control/permissions.mjs";
import { journalPolicy } from "../../../../../control/src/control/hook-journal-policy.mjs";
import { ControlStore } from "../../../../../control/src/control/store.mjs";
import {
  createTrustedContribution,
  OWN_ID,
} from "../../../../../control/src/control/trusted-contribution.mjs";
import { parseControllerCommand } from "../../../../../control/orca-organization/shared/command-parser.mjs";

// The read-only tool lease predates upstream's named TTLCache export. Keep the real
// cache constructor under its source name for unrelated Git module initialization only;
// this is NOT installed/package dependency compatibility evidence.
vi.mock("@isaacs/ttlcache", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, TTLCache: actual.TTLCache ?? actual.default };
});

// This matrix never opens the separate controller client transport. Schema-owning
// constructors are real; any accidental client effect fails rather than loading AOT/build output.
vi.mock("../../../../../control/src/control/client-sdk.mjs", () => ({
  DaemonClient: function RefusedControllerTransport() {
    throw new Error("Controller client transport outside native fake matrix");
  },
  DaemonRpcError: class extends Error {},
  createPaseoApi: () => {
    throw new Error("Controller client transport outside native fake matrix");
  },
}));

async function fixture(
  reply: "valid" | "malformed" = "valid",
  reports = false,
  relaunch = false,
  journalHooks = false,
  installedQueue = false,
) {
  const directory = await mkdtemp(path.join(tmpdir(), "native-provider-integration-"));
  let turn = 0;
  let thread = 0;
  let usageAllowed = true;
  let onChildStart: (() => void) | undefined;
  const servers: ReturnType<typeof createFakeCodexAppServer>[] = [];
  const threads = new Map<string, ReturnType<typeof createFakeCodexAppServer>>();
  const makeServer = () => {
    let created: ReturnType<typeof createFakeCodexAppServer>;
    created = createFakeCodexAppServer({
      "thread/start": () => {
        const id = `thread-${reports ? ++thread : 1}`;
        threads.set(id, created);
        if (thread > 1) onChildStart?.();
        return { thread: { id }, modelProvider: "openai", model: "gpt-5.4" };
      },
      "thread/resume": (params) => {
        const id = (params as { threadId: string }).threadId;
        threads.set(id, created);
        return { thread: { id }, modelProvider: "openai", model: "gpt-5.4" };
      },
      "thread/loaded/list": () => ({ data: [...threads.keys()] }),
      "account/rateLimits/read": () => ({
        accountId: "fixture-account",
        ordinaryUsageAllowed: usageAllowed,
        rateLimits: {},
      }),
      "turn/start": () => {
        turn++;
        return reply === "valid"
          ? { turn: { id: `native-${turn}`, status: "inProgress", error: null } }
          : {};
      },
    });
    servers.push(created);
    return created;
  };
  const first = makeServer();
  let spawned = false;
  const server = Object.assign({}, first, {
    completeTurn(params: Parameters<typeof first.completeTurn>[0] = {}) {
      (threads.get(params.threadId ?? "thread-1") ?? first).completeTurn(params);
    },
    requests: () => servers.flatMap((process) => process.requests()),
  });
  const provider = new CodexAppServerAgentClient(createTestLogger());
  Reflect.set(provider, "goalsEnabledPromise", Promise.resolve(false));
  Reflect.set(provider, "autoReviewEnabledPromise", Promise.resolve(false));
  Reflect.set(provider, "spawnAppServer", async () => {
    if (!spawned) {
      spawned = true;
      return first.child;
    }
    return makeServer().child;
  });
  const authority = new TrustedPlugins(
    reports
      ? {
          enabled: () => true,
          validate: (command) => parseControllerCommand(command),
        }
      : undefined,
  );
  authority.initializeKnownAgents([]);
  const controlStore =
    journalHooks || relaunch || installedQueue
      ? new ControlStore(path.join(directory, "journal.sqlite"))
      : undefined;
  let controlIssue!: IssueProvenanceV11;
  if (controlStore)
    authority.registerV11(OWN_ID, true, (hooks) => {
      controlIssue = hooks.issueProvenance;
      return createTrustedContribution({ home: directory })(hooks);
    });
  let authorized = true;
  let issueProvenance!: IssueProvenanceV11;
  const attemptId = randomUUID();
  authority.registerV11("native-provider-fixture", true, (hooks) => {
    issueProvenance = hooks.issueProvenance;
    hooks.admission.onInput(() => (authorized ? "allow" : "deny"));
    if (relaunch) {
      const control = { store: controlStore! };
      Object.assign(control, {
        manager: new Manager(control, path.join(directory, "control-grants", "manager")),
        events: new Events(control, path.join(directory, "control-grants", "events")),
        permissions: new Permissions(control, directory),
      });
      const policy = journalPolicy(hooks.inputObservations);
      hooks.admission.mcpRefresh((agent) =>
        policy.mcpRefreshAdmissionInStore(controlStore!.db, agent),
      );
    }
  });
  const manager = new AgentManager({
    clients: { codex: provider },
    trustedPlugins: authority,
    logger: createTestLogger(),
    ...(relaunch ? { mcpRefreshAdmission: (agent) => authority.mcpRefresh(agent) } : {}),
    ...(reports
      ? {
          mcpBaseUrl: "http://127.0.0.1:1/mcp/agents",
          mcpAuthToken: "throwaway-action-mcp-token",
          reportRegistryFile: path.join(directory, "reports.json"),
          reportGrantDirectory: path.join(directory, "grants", "report"),
        }
      : {}),
  });
  manager.setNativeMessageReceipts(new MessageReceipts(path.join(directory, "receipts")));
  const createSession = vi.spyOn(provider, "createSession");
  const agent = await manager.createAgent(
    { provider: "codex", cwd: directory, model: "gpt-5.4" },
    undefined,
    { workspaceId: reports ? randomUUID() : undefined },
  );
  const messageId = randomUUID();
  return {
    manager,
    controlStore,
    controlIssue: (binding: Parameters<IssueProvenanceV11>[0]) => controlIssue(binding),
    directory,
    authority,
    agent,
    messageId,
    server,
    token(text = "fixture instruction", id = messageId) {
      const payload = promptPayload(text, { clientMessageId: id });
      return issueProvenance({
        agentId: agent.id,
        kind: "prompt",
        messageId: id,
        attemptId,
        payloadDigest: createHash("sha256")
          .update(
            canonicalTrustedPayload({ agentId: agent.id, kind: "prompt", messageId: id, payload }),
          )
          .digest("hex") as Sha256,
      });
    },
    queue() {
      return authority.daemon(() =>
        manager.queueNativePrompt(
          agent.id,
          "fixture instruction",
          messageId,
          promptPayload("fixture instruction", { clientMessageId: messageId }),
        ),
      );
    },
    revoke() {
      authorized = false;
    },
    denyUsage() {
      usageAllowed = false;
    },
    nativeOrigin(id = agent.id) {
      const launch = Reflect.get(manager, "reportLaunches").get(id);
      return manager.nativeReportMcpOrigin(id, launch?.witness)!;
    },
    launchConfig: () => createSession.mock.calls[0]![0],
    onChildStart(callback: () => void) {
      onChildStart = callback;
    },
    switchAccount: (value: string) => {
      if (!controlStore) throw new Error("Native switch journal unavailable");
      const sequence = authority.requireSequence(agent.id);
      controlStore.db
        .prepare(
          "UPDATE deliveries SET state='delivered' WHERE session=? AND kind='account-switch' AND state='intent'",
        )
        .run(agent.id);
      controlStore.db
        .prepare("INSERT INTO deliveries VALUES (?,?,'account-switch',?,'intent',?)")
        .run(
          randomUUID(),
          agent.id,
          JSON.stringify({
            generation: controlStore.get(agent.id)?.generation ?? null,
            boot: sequence.boot,
            humanAt: sequence.humanAt,
            accountId: value,
          }),
          JSON.stringify({ fixture: true }),
        );
    },
    turnCount() {
      return turn;
    },
    async metadata() {
      const key = createHash("sha256")
        .update(JSON.stringify(["send", agent.id, messageId]))
        .digest("hex");
      const value = await readFile(path.join(directory, "receipts", `${key}.json`), "utf8");
      expect(value).not.toContain("fixture instruction");
      expect(value).not.toContain(directory);
      return JSON.parse(value);
    },
    async cleanup() {
      authorized = true;
      server.completeTurn();
      await manager.closeAgent(agent.id);
      controlStore?.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("native provider integration: busy native ticket settles then one correlated dispatch, duplicate stays fenced", async () => {
  const f = await fixture();
  const foreground = (async () => {
    for await (const event of f.manager.streamAgent(f.agent.id, "foreground fixture")) void event;
  })();
  await f.manager.waitForAgentRunStart(f.agent.id);
  try {
    expect(await f.queue()).toMatchObject({ state: "queued", pendingCount: 1 });
    expect(await f.queue()).toMatchObject({ state: "queued", pendingCount: 1 });
    expect(f.turnCount()).toBe(1);
    f.server.completeTurn();
    await foreground;
    await vi.waitFor(async () =>
      expect(await f.queue()).toMatchObject({
        state: "delivered",
        pendingCount: 0,
        providerTurnId: "native-2",
      }),
    );
    expect(f.turnCount()).toBe(2);
    expect(await f.metadata()).toMatchObject({ state: "delivered", providerTurnId: "native-2" });
    expect(await f.queue()).toMatchObject({ state: "delivered", providerTurnId: "native-2" });
    expect(f.turnCount()).toBe(2);
  } finally {
    await f.cleanup();
  }
});

test.each(["source", "native-id"])(
  "native provider integration: post-preparation %s replacement has no turn/start write",
  async (mutation) => {
    const f = await fixture();
    const session = f.agent.session;
    if (!session) throw new Error("Native fixture session unavailable");
    const instanceId = f.agent.instanceId;
    const storedId = f.agent.persistence?.sessionId;
    const build = Reflect.get(session, "buildTurnStartParams").bind(session);
    vi.spyOn(
      session as unknown as { buildTurnStartParams(): Promise<unknown> },
      "buildTurnStartParams",
    ).mockImplementation(async (...args) => {
      const prepared = await build(...args);
      if (mutation === "source") f.revoke();
      else Reflect.set(session, "currentThreadId", "external-native-replacement");
      return prepared;
    });
    try {
      expect(await f.queue()).toMatchObject({ state: "queued" });
      await vi.waitFor(async () => expect(await f.metadata()).toMatchObject({ state: "refused" }));
      expect(f.turnCount()).toBe(0);
      expect(f.agent.session).toBe(session);
      expect(f.agent.instanceId).toBe(instanceId);
      expect(f.agent.persistence?.sessionId).toBe(storedId);
    } finally {
      await f.cleanup();
    }
  },
);

test("native report provider integration: human-held parent reads two metadata events and receives one authenticated idle wake", async () => {
  const f = await fixture("valid", true);
  f.authority.management.register(
    "orca-organization-next",
    vi.fn(async () => null),
  );
  const child = await f.manager.createAgent(
    { provider: "codex", cwd: f.directory, model: "gpt-5.4" },
    undefined,
    { workspaceId: undefined },
  );
  const identity = (id: string) =>
    Reflect.get(f.manager, "currentReportIdentity").call(f.manager, id);
  const call = async (method: string, input: object) => {
    const owner = f.authority.management.open(
      {
        pluginId: "orca-organization-next",
        bundleDirectory: "/fixture/bundle",
        isCurrent: () => true,
      },
      () => ({
        id: "fixture-owner",
        authentication: "protected-local-ipc",
        deviceId: null,
        permissions: ["command-centre.manage", "daemon.manage", "accounts.manage"],
      }),
    )!;
    try {
      return await owner.invoke(randomUUID(), { method, input });
    } finally {
      owner.close();
    }
  };
  const scope = { projectId: randomUUID(), taskId: randomUUID() };
  await call("intercom-rate-settings-set", {
    messageId: randomUUID(),
    settings: { report: 12, followup: 32, channel: 8, seat: 8 },
  });
  await call("report-prime-register", {
    messageId: randomUUID(),
    identity: identity(f.agent.id),
    scopes: [scope],
    expectedEpoch: null,
  });
  await call("report-parent-adopt", {
    messageId: randomUUID(),
    child: identity(child.id),
    parent: identity(f.agent.id),
    scopes: [scope],
    expectedEpoch: null,
  });
  const grant = JSON.parse(
    await readFile(path.join(f.directory, "grants", "report", `${f.agent.id}.json`), "utf8"),
  );
  const inbox = () =>
    f.manager.reportInboxRequest({
      method: "events-inbox",
      input: { sessionId: f.agent.id },
      capability: grant.capability,
    });
  const human = (async () => {
    for await (const event of f.manager.streamAgent(f.agent.id, "human-held foreground"))
      void event;
  })();
  await f.manager.waitForAgentRunStart(f.agent.id);
  const humanAt = f.authority.requireSequence(f.agent.id).humanAt;
  const registry = Reflect.get(f.manager, "reportRegistry");
  const batches = [
    ...registry.captureLifecycleReports(identity(child.id), "needs-you", "host-need", Date.now()),
  ];
  try {
    for (const batch of batches)
      await Reflect.get(f.manager, "collectNativeReport").call(f.manager, batch);
    const childWork = (async () => {
      for await (const event of f.manager.streamAgent(child.id, "child foreground fixture"))
        void event;
    })();
    await f.manager.waitForAgentRunStart(child.id);
    f.server.completeTurn({ threadId: "thread-2" });
    await childWork;
    await vi.waitFor(
      async () => {
        expect(await inbox()).toMatchObject({
          metadataCount: 2,
          wakePendingCount: 1,
          events: [
            { wakeState: "queued", providerAccepted: false },
            { wakeState: "queued", providerAccepted: false },
          ],
        });
      },
      { timeout: 4000 },
    );
    expect(f.turnCount()).toBe(2);
    f.server.completeTurn({ threadId: "thread-1" });
    await human;
    await vi.waitFor(async () => {
      expect(await inbox()).toMatchObject({
        wakePendingCount: 0,
        events: [
          { wakeState: "delivered", providerAccepted: true },
          { wakeState: "delivered", providerAccepted: true },
        ],
      });
    });
    expect(f.turnCount()).toBe(3);
    expect(f.authority.requireSequence(f.agent.id).humanAt).toBe(humanAt);
    expect(f.server.requests().filter((request) => request.method === "turn/start")).toHaveLength(
      3,
    );
  } finally {
    f.server.completeTurn({ threadId: "thread-1" });
    await f.manager.closeAgent(child.id);
    await f.cleanup();
  }
});

test("native provider integration: missing native acknowledgement remains uncertain and never retries", async () => {
  const f = await fixture("malformed");
  try {
    expect(await f.queue()).toMatchObject({ state: "queued" });
    await vi.waitFor(async () =>
      expect(await f.queue()).toMatchObject({ state: "uncertain", pendingCount: 0 }),
    );
    expect(f.turnCount()).toBe(1);
    expect(await f.queue()).toMatchObject({ state: "uncertain" });
    expect(f.turnCount()).toBe(1);
  } finally {
    await f.cleanup();
  }
});

async function registerPrime(f: Awaited<ReturnType<typeof fixture>>) {
  f.authority.management.register(
    "orca-organization-next",
    vi.fn(async (command, principal) => {
      if (command.method === "leadership-transfer") {
        consumeManagementDispatch(command, principal);
        return {
          ownershipTransferred: true,
          handoffId: command.input.messageId,
        };
      }
      return null;
    }),
  );
  const owner = f.authority.management.open(
    {
      pluginId: "orca-organization-next",
      bundleDirectory: "/fixture/bundle",
      isCurrent: () => true,
    },
    () => ({
      id: "fixture-owner",
      authentication: "protected-local-ipc",
      deviceId: null,
      permissions: ["command-centre.manage", "daemon.manage", "accounts.manage"],
    }),
  )!;
  const scope = { projectId: randomUUID(), taskId: randomUUID() };
  try {
    await owner.invoke(randomUUID(), {
      method: "intercom-rate-settings-set",
      input: {
        messageId: randomUUID(),
        settings: { report: 12, followup: 32, channel: 8, seat: 8 },
      },
    });
    const receipt = await owner.invoke(randomUUID(), {
      method: "report-prime-register",
      input: {
        messageId: randomUUID(),
        identity: Reflect.get(f.manager, "currentReportIdentity").call(f.manager, f.agent.id),
        scopes: [scope],
        expectedEpoch: null,
      },
    });
    return { scope, receipt };
  } finally {
    owner.close();
  }
}

test("native report end-to-end: actual MCP launch witness creates a scoped child, retires it, projects and consumes metadata with one human idle wake", async () => {
  const f = await fixture("valid", true);
  const { scope } = await registerPrime(f);
  const origin = f.nativeOrigin();
  const snapshots = Object.create(ProviderSnapshotManager.prototype) as ProviderSnapshotManager;
  vi.spyOn(snapshots, "resolveCreateConfig").mockResolvedValue({
    modeId: undefined,
    featureValues: undefined,
  });
  const catalog = createPaseoToolCatalog({
    agentManager: f.manager,
    agentStorage: new AgentStorage(path.join(f.directory, "agents"), createTestLogger()),
    providerSnapshotManager: snapshots,
    logger: createTestLogger(),
    callerAgentId: f.agent.id,
    nativeReportOrigin: origin,
    ensureWorkspaceForCreate: async () => randomUUID(),
  });
  let childId: string | undefined;
  try {
    expect(f.launchConfig().mcpServers?.paseo).toMatchObject({
      headers: { "X-Paseo-Report-Origin": expect.any(String) },
    });
    expect(f.agent.config.mcpServers).toBeUndefined();
    expect(() => f.manager.nativeReportMcpOrigin(f.agent.id, "forged")).toThrow("refused");
    expect(() =>
      f.manager.nativeReportMcpOrigin(
        randomUUID(),
        Reflect.get(f.manager, "reportLaunches").get(f.agent.id).witness,
      ),
    ).toThrow("refused");
    expect(() => f.manager.captureNativeReportCreation({ nativeReportOrigin: true })).toThrow(
      "Host-issued",
    );
    const created = await catalog.executeTool("create_agent", {
      provider: "codex",
      title: "Fixture child",
      initialPrompt: "fixture child work",
      notifyOnFinish: true,
    });
    expect(created.isError).not.toBe(true);
    childId = (created.structuredContent as { agentId: string }).agentId;
    const child = f.manager.getAgent(childId)!;
    const registry = Reflect.get(f.manager, "reportRegistry");
    expect(
      registry.requireParent(
        Reflect.get(f.manager, "currentReportIdentity").call(f.manager, childId),
        scope,
      ).parent.agentId,
    ).toBe(f.agent.id);
    f.server.completeTurn({ threadId: child.persistence!.sessionId });
    await vi.waitFor(() => expect(f.manager.getAgent(childId!)?.lifecycle).toBe("idle"));
    const human = (async () => {
      for await (const event of f.manager.streamAgent(f.agent.id, "human held work")) void event;
    })();
    await f.manager.waitForAgentRunStart(f.agent.id);
    const humanAt = f.authority.requireSequence(f.agent.id).humanAt;
    await f.manager.closeAgent(childId);
    await vi.waitFor(
      async () =>
        expect(await f.manager.nativeReportInbox(origin)).toMatchObject({ metadataCount: 1 }),
      { timeout: 4000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(f.turnCount()).toBe(2);
    f.server.completeTurn({ threadId: f.agent.persistence!.sessionId });
    await human;
    await vi.waitFor(async () =>
      expect(await f.manager.nativeReportInbox(origin)).toMatchObject({
        events: [{ kind: "ended", providerAccepted: true }],
      }),
    );
    expect(f.turnCount()).toBe(3);
    expect(f.authority.requireSequence(f.agent.id).humanAt).toBe(humanAt);
    const projection = await catalog.executeTool("supervisor_inbox", {});
    const events = (projection.structuredContent as { events: { eventId: string }[] }).events;
    const ack = await catalog.executeTool("supervisor_acknowledge", {
      eventId: events[0]!.eventId,
    });
    expect(ack.structuredContent).toMatchObject({ consumed: true });
    await expect(
      catalog.executeTool("supervisor_acknowledge", {
        eventId: events[0]!.eventId,
        handoff: true,
      }),
    ).rejects.toThrow();
    expect(f.authority.requireSequence(f.agent.id).humanAt).toBe(humanAt);
    expect(f.manager.getAgent(childId)).toBeFalsy();
  } finally {
    if (childId && f.manager.getAgent(childId)) {
      f.server.completeTurn({ threadId: f.manager.getAgent(childId)?.persistence?.sessionId });
      await f.manager.closeAgent(childId);
    }

    await f.cleanup();
  }
});

test("native report relaunch: authenticated refresh A-B-A rotates credential domain once, while external native replacement refuses old origin", async () => {
  const f = await fixture("valid", true, true);
  await registerPrime(f);
  f.controlStore!.created(f.agent.id, randomUUID(), f.directory);
  f.controlStore!.db.prepare(
    "UPDATE sessions SET mode='delegated',boot=?,grantedAt=1 WHERE id=?",
  ).run(f.authority.boot, f.agent.id);
  const originalGeneration = f.controlStore!.get(f.agent.id).generation;
  try {
    const oldOrigin = f.nativeOrigin();
    const oldInstance = f.manager.getAgent(f.agent.id)!.instanceId;
    for (const account of ["fixture-account-b", "fixture-account-a"]) {
      f.switchAccount(account);
      const expected = await f.manager.getAgentMcpRefreshState(f.agent.id);
      if (!expected) throw new Error("Refresh state unavailable");
      expect(
        await f.manager.refreshAgentMcp({
          agentId: f.agent.id,
          expected: {
            provider: expected.provider,
            sessionId: expected.sessionId,
            configRevision: expected.configRevision,
          },
          changes: {},
          reconnect: true,
        }),
      ).toMatchObject({ outcome: "refreshed" });
      expect(await f.manager.nativeReportInbox(f.nativeOrigin())).toMatchObject({
        metadataCount: 0,
      });
      expect(f.controlStore!.get(f.agent.id)).toMatchObject({
        mode: "delegated",
        generation: originalGeneration,
      });
      f.controlStore!.db.prepare(
        "UPDATE deliveries SET state='delivered' WHERE session=? AND kind='account-switch' AND state='intent'",
      ).run(f.agent.id);
    }
    expect(f.manager.getAgent(f.agent.id)!.instanceId).not.toBe(oldInstance);
    await expect(f.manager.nativeReportInbox(oldOrigin)).rejects.toThrow("replaced");
    const origin = f.nativeOrigin();
    Reflect.set(f.manager.getAgent(f.agent.id)!.session!, "currentThreadId", "external-native-id");
    await expect(f.manager.nativeReportInbox(origin)).rejects.toThrow("replaced");
  } finally {
    await f.cleanup();
  }
});

test("native report wake preserves delegated journal generation through actual W3 daemon-only admission", async () => {
  const f = await fixture("valid", true, false, true);
  await registerPrime(f);
  const failures: string[] = [];
  const stream = f.manager.streamAgent.bind(f.manager);
  vi.spyOn(f.manager, "streamAgent").mockImplementation(async function* (...args) {
    try {
      yield* stream(...args);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "unknown");
      throw error;
    }
  });
  const store = f.controlStore!;
  store.created(f.agent.id, randomUUID(), f.directory);
  store.db
    .prepare("UPDATE sessions SET mode='delegated',boot=?,grantedAt=1 WHERE id=?")
    .run(f.authority.boot, f.agent.id);
  const before = store.get(f.agent.id);
  const snapshots = Object.create(ProviderSnapshotManager.prototype) as ProviderSnapshotManager;
  vi.spyOn(snapshots, "resolveCreateConfig").mockResolvedValue({
    modeId: undefined,
    featureValues: undefined,
  });
  const catalog = createPaseoToolCatalog({
    agentManager: f.manager,
    agentStorage: new AgentStorage(path.join(f.directory, "agents"), createTestLogger()),
    providerSnapshotManager: snapshots,
    logger: createTestLogger(),
    callerAgentId: f.agent.id,
    nativeReportOrigin: f.nativeOrigin(),
    ensureWorkspaceForCreate: async () => randomUUID(),
  });
  try {
    const result = await catalog.executeTool("create_agent", {
      provider: "codex",
      title: "Fixture child",
      initialPrompt: "fixture child work",
    });
    expect(result.isError).not.toBe(true);
    const childId = (result.structuredContent as { agentId: string }).agentId;
    const child = f.manager.getAgent(childId)!;
    f.server.completeTurn({ threadId: child.persistence!.sessionId });
    await vi.waitFor(() => expect(f.manager.getAgent(childId)?.lifecycle).toBe("idle"));
    await f.manager.closeAgent(childId);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(failures).toEqual([]);
    await vi.waitFor(
      async () =>
        expect(await f.manager.nativeReportInbox(f.nativeOrigin())).toMatchObject({
          events: [{ kind: "ended", providerAccepted: true }],
        }),
      { timeout: 4000 },
    );
    expect(store.get(f.agent.id)).toMatchObject({
      mode: "delegated",
      generation: before.generation,
    });
    expect(store.db.prepare("SELECT count(*) n FROM transfers").get().n).toBe(0);
    expect(f.turnCount()).toBe(2);
  } finally {
    await f.cleanup();
  }
});

test("native authenticated creation refuses replaced parent during child launch and closes the unlinked captured child", async () => {
  const f = await fixture("valid", true);
  await registerPrime(f);
  const snapshots = Object.create(ProviderSnapshotManager.prototype) as ProviderSnapshotManager;
  vi.spyOn(snapshots, "resolveCreateConfig").mockResolvedValue({
    modeId: undefined,
    featureValues: undefined,
  });
  const catalog = createPaseoToolCatalog({
    agentManager: f.manager,
    agentStorage: new AgentStorage(path.join(f.directory, "agents"), createTestLogger()),
    providerSnapshotManager: snapshots,
    logger: createTestLogger(),
    callerAgentId: f.agent.id,
    nativeReportOrigin: f.nativeOrigin(),
    ensureWorkspaceForCreate: async () => randomUUID(),
  });
  f.onChildStart(() =>
    Reflect.set(
      f.manager.getAgent(f.agent.id)!.session!,
      "currentThreadId",
      "external-replacement",
    ),
  );
  try {
    await expect(
      catalog.executeTool("create_agent", {
        provider: "codex",
        title: "Fixture child",
        initialPrompt: "must not run",
      }),
    ).rejects.toThrow("Native report child enrollment refused");
    expect(f.manager.listAgents().map((agent) => agent.id)).toEqual([f.agent.id]);
    expect(f.turnCount()).toBe(0);
    expect(f.server.requests().filter((request) => request.method === "thread/start")).toHaveLength(
      2,
    );
  } finally {
    await f.cleanup();
  }
});

function nativeOwner(f: Awaited<ReturnType<typeof fixture>>, paired = false) {
  return f.authority.management.open(
    {
      pluginId: "orca-organization-next",
      bundleDirectory: "/fixture/bundle",
      isCurrent: () => true,
    },
    () => ({
      id: "fixture-owner",
      authentication: paired ? "paired-device" : "protected-local-ipc",
      deviceId: paired ? "paired" : null,
      permissions: OWNER_PERMISSIONS,
    }),
  )!;
}

async function nativeScopedChild(f: Awaited<ReturnType<typeof fixture>>) {
  return f.manager.createAgent(
    { provider: "codex", cwd: f.directory, model: "gpt-5.4" },
    undefined,
    {
      workspaceId: randomUUID(),
      reportCreation: f.manager.captureNativeReportCreation(f.nativeOrigin()),
    },
  );
}

test("native activation integration: protected current status and explicit legacy adoption never infer label authority", async () => {
  const f = await fixture("valid", true);
  const { scope } = await registerPrime(f);
  const owner = nativeOwner(f);
  let childId: string | undefined;
  try {
    const child = await f.manager.createAgent(
      {
        provider: "codex",
        cwd: f.directory,
        model: "gpt-5.4",
        labels: { "paseo.parent-agent-id": f.agent.id },
      },
      undefined,
      { workspaceId: randomUUID() },
    );
    childId = child.id;
    const status = await owner.invoke(randomUUID(), {
      method: "intercom-status",
      input: { agentId: child.id },
    });
    expect(status).toMatchObject({
      version: 1,
      identity: { agentId: child.id },
      registration: null,
      queueAvailable: true,
      reportLinked: false,
      settingsInitialized: true,
      supportedProviders: ["codex"],
    });
    expect(f.manager.nativeReportOwnsFinish(child.id, f.agent.id)).toBe(false);
    const identity = Reflect.get(f.manager, "currentReportIdentity").call(f.manager, child.id);
    const parent = Reflect.get(f.manager, "currentReportIdentity").call(f.manager, f.agent.id);
    await owner.invoke(randomUUID(), {
      method: "report-parent-adopt",
      input: {
        messageId: randomUUID(),
        child: identity,
        parent,
        scopes: [scope],
        expectedEpoch: null,
      },
    });
    const current = await owner.invoke(randomUUID(), {
      method: "intercom-status",
      input: { agentId: child.id },
    });
    expect(current).toMatchObject({
      reportLinked: true,
      registration: { parent, scopes: [scope] },
    });
    expect(f.manager.nativeReportOwnsFinish(child.id, f.agent.id)).toBe(true);
    expect(f.manager.nativeReportOwnsFinish(child.id, randomUUID())).toBe(false);
    const json = JSON.stringify(current);
    expect(json).not.toContain("report1.");
    expect(json).not.toContain(f.directory);
    expect(json).not.toContain("throwaway-action-mcp-token");
    const paired = nativeOwner(f, true);
    await expect(
      paired.invoke(randomUUID(), {
        method: "intercom-rate-settings-get",
        input: null,
      }),
    ).rejects.toThrow("owner authority");
    await expect(
      paired.invoke(randomUUID(), {
        method: "intercom-status",
        input: { agentId: child.id },
      }),
    ).rejects.toThrow("owner authority");
    paired.close();
    const check = f.manager.captureFinishNotificationCheck(child.id, f.agent.id);
    check();
    Reflect.set(
      Reflect.get(f.manager, "agents").get(f.agent.id).session,
      "currentThreadId",
      "replaced-native-thread",
    );
    expect(check).toThrow("identity changed");
    expect(f.manager.nativeReportOwnsFinish(child.id, f.agent.id)).toBe(false);
    expect(f.turnCount()).toBe(0);
  } finally {
    owner.close();
    if (childId) await f.manager.closeAgent(childId);
    await f.cleanup();
  }
});

test("native activation integration: same-instance native replacement during protected status await refuses publication", async () => {
  const f = await fixture("valid", true);
  await registerPrime(f);
  const owner = nativeOwner(f);
  const rates = Reflect.get(f.manager, "intercomRates");
  const original = rates.snapshot.bind(rates);
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const spy = vi.spyOn(rates, "snapshot").mockImplementation(async (guard: () => void) => {
    entered();
    await held;
    return original(guard);
  });
  try {
    const pending = owner.invoke(randomUUID(), {
      method: "intercom-status",
      input: { agentId: f.agent.id },
    });
    const refusal = expect(pending).rejects.toThrow("identity changed");
    await started;
    Reflect.set(
      Reflect.get(f.manager, "agents").get(f.agent.id).session,
      "currentThreadId",
      "replaced-native-thread",
    );
    release();
    await refusal;
    expect(f.turnCount()).toBe(0);
  } finally {
    spy.mockRestore();
    owner.close();
    await f.cleanup();
  }
});

test("native activation integration: actual quota reads commit one scoped limit episode and successful host handoff uses the same ledger", async () => {
  const f = await fixture("valid", true);
  await registerPrime(f);
  const origin = f.nativeOrigin();
  const child = await nativeScopedChild(f);
  const owner = nativeOwner(f);
  try {
    const humanAt = f.authority.requireSequence(f.agent.id).humanAt;
    f.denyUsage();
    await f.manager.getAgentQuota(child.id);
    await f.manager.getAgentQuota(child.id);
    await vi.waitFor(async () =>
      expect(await f.manager.nativeReportInbox(origin)).toMatchObject({
        metadataCount: 1,
        events: [{ kind: "usage-limit", providerAccepted: false }],
      }),
    );
    const before = f.turnCount();
    const result = await owner.invoke(randomUUID(), {
      method: "leadership-transfer",
      input: {
        sessionId: child.id,
        expectedGeneration: 1,
        messageId: randomUUID(),
        destinationId: f.agent.id,
        destinationGeneration: 1,
        maxWorkers: 1,
        context: "fixture handoff context",
        workers: [],
      },
    });
    expect(result).toMatchObject({ ownershipTransferred: true });
    await vi.waitFor(async () => {
      const view = (await f.manager.nativeReportInbox(origin)) as {
        events: { kind: string }[];
        metadataCount: number;
      };
      expect(view.metadataCount).toBe(2);
      expect(view.events.map((event) => event.kind).sort()).toEqual(["handoff", "usage-limit"]);
      expect(JSON.stringify(view)).not.toContain("fixture-account");
      expect(JSON.stringify(view)).not.toContain("fixture handoff context");
    });
    expect(f.turnCount()).toBe(before); // Metadata admission is not a provider write.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await vi.waitFor(async () =>
      expect(await f.manager.nativeReportInbox(origin)).toMatchObject({
        events: [{ providerAccepted: true }, { providerAccepted: true }],
      }),
    );
    expect(f.turnCount()).toBe(before + 1);
    expect(f.authority.requireSequence(f.agent.id).humanAt).toBe(humanAt);
  } finally {
    owner.close();
    f.server.completeTurn({ threadId: f.agent.persistence!.sessionId });
    await f.manager.closeAgent(child.id);
    await f.cleanup();
  }
});

for (const mode of ["rearm", "native-link", "normal-terminal"] as const) {
  test(`NC2 final native preparation: ${mode}`, async () => {
    const f = await fixture("valid", true);
    const child = await f.manager.createAgent(
      { provider: "codex", cwd: f.directory, model: "gpt-5.4" },
      undefined,
      { workspaceId: undefined },
    );
    const storage = new AgentStorage(f.directory, createTestLogger());
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = f.agent.session!;
    const build = Reflect.get(provider, "buildTurnStartParams").bind(provider);
    vi.spyOn(
      provider as unknown as { buildTurnStartParams(): Promise<unknown> },
      "buildTurnStartParams",
    ).mockImplementation(async (...args) => {
      const params = await build(...args);
      entered();
      await held;
      return params;
    });
    const arm = () =>
      setupFinishNotification({
        agentManager: f.manager,
        agentStorage: storage,
        childAgentId: child.id,
        callerAgentId: f.agent.id,
        logger: createTestLogger(),
      });
    try {
      arm();
      const childRun = (async () => {
        for await (const event of f.manager.streamAgent(child.id, "child fixture")) void event;
      })();
      await f.manager.waitForAgentRunStart(child.id);
      f.server.completeTurn({ threadId: child.session!.id });
      await childRun;
      await waiting;
      if (mode === "rearm") arm();
      if (mode === "native-link")
        vi.spyOn(f.manager, "nativeReportOwnsFinish").mockReturnValue(true);
      release();
      if (mode === "normal-terminal") await vi.waitFor(() => expect(f.turnCount()).toBe(2));
      else {
        await vi.waitFor(() => expect(f.manager.hasInFlightRun(f.agent.id)).toBe(false));
        expect(
          f.server
            .requests()
            .filter(
              (r) =>
                r.method === "turn/start" &&
                (r.params as { threadId?: string }).threadId === f.agent.session!.id,
            ),
        ).toHaveLength(0);
      }
    } finally {
      release();
      await f.manager.closeAgent(child.id);
      await f.cleanup();
    }
  });
}

async function sessionWire(f: Awaited<ReturnType<typeof fixture>>) {
  const { Session } = await import("../session.js");
  const session: InstanceType<typeof Session> = Object.create(Session.prototype);
  const replies: SessionOutboundMessage[] = [];
  const source = {};
  const delivery = new SessionDelivery((_source, message) => replies.push(message));
  const authorization = new SessionAuthorization(OWNER_PERMISSIONS);
  for (const [key, value] of Object.entries({
    agentManager: f.manager,
    agentStorage: { list: async () => [] },
    sessionLogger: createTestLogger(),
    delivery,
    authorization,
    nativeMessagePermissionEpoch: 0,
    inflightRequests: 0,
    peakInflightRequests: 0,
    managementInvocations: new Map(),
    isCleanedUp: false,
  }))
    Reflect.set(session, key, value);
  // Native message dispatch/reply owner are production; unrelated event projections are outside this fake.
  Reflect.set(session, "emit", (message: SessionOutboundMessage) => {
    if (authorization.allowsOutbound(message)) delivery.reply(message);
  });
  const request = (extra: Record<string, unknown> = {}) =>
    SessionInboundMessageSchema.parse({
      type: "send_agent_message_request",
      requestId: randomUUID(),
      agentId: f.agent.id,
      messageId: f.messageId,
      text: "fixture instruction",
      nativeQueue: true,
      inputProvenance: f.token(),
      ...extra,
    });
  return { session, replies, source, delivery, request };
}

test("native Session wire: authenticated busy admission, physical disconnect, one boundary write and protected same-ID receipt", async () => {
  const f = await fixture("valid", true);
  await registerPrime(f);
  const wire = await sessionWire(f);
  const foreground = (async () => {
    for await (const event of f.manager.streamAgent(f.agent.id, "foreground fixture")) void event;
  })();
  await f.manager.waitForAgentRunStart(f.agent.id);
  try {
    const humanAt = f.authority.requireSequence(f.agent.id).humanAt;
    await wire.session.handleMessage(wire.request(), wire.source);
    expect(wire.replies).toContainEqual(
      expect.objectContaining({
        type: "send_agent_message_response",
        payload: expect.objectContaining({
          accepted: true,
          error: null,
          nativeReceipt: { messageId: f.messageId, state: "queued", pendingCount: 1 },
        }),
      }),
    );
    expect(f.turnCount()).toBe(1);
    expect(f.authority.requireSequence(f.agent.id).humanAt).toBe(humanAt);
    await wire.delivery.detach(wire.source);
    f.server.completeTurn();
    await foreground;
    await vi.waitFor(async () =>
      expect(await f.metadata()).toMatchObject({ state: "delivered", providerTurnId: "native-2" }),
    );
    await wire.session.handleMessage(wire.request(), {});
    expect(wire.replies.at(-1)).toMatchObject({
      type: "send_agent_message_response",
      payload: {
        accepted: true,
        nativeReceipt: { state: "delivered", providerTurnId: "native-2" },
      },
    });
    expect(f.turnCount()).toBe(2);
  } finally {
    await wire.delivery.close();
    await f.cleanup();
  }
});

for (const mutation of ["permission", "source", "body", "spoof", "attachments", "slash"] as const) {
  test(`native Session wire refuses ${mutation} without second provider write`, async () => {
    const f = await fixture("valid", true);
    await registerPrime(f);
    const wire = await sessionWire(f);
    const foreground = (async () => {
      for await (const event of f.manager.streamAgent(f.agent.id, "foreground fixture")) void event;
    })();
    await f.manager.waitForAgentRunStart(f.agent.id);
    try {
      if (mutation === "attachments")
        await wire.session.handleMessage(
          wire.request({ images: [{ data: "YWJj", mimeType: "image/png" }] }),
          wire.source,
        );
      else if (mutation === "slash")
        await wire.session.handleMessage(
          wire.request({ text: "/help", inputProvenance: f.token("/help") }),
          wire.source,
        );
      else if (mutation === "spoof")
        await wire.session.handleMessage(
          wire.request({ inputProvenance: randomUUID() }),
          wire.source,
        );
      else {
        await wire.session.handleMessage(wire.request(), wire.source);
        if (mutation === "permission") {
          wire.session.setPermissions(["daemon.read"]);
          wire.session.setPermissions(OWNER_PERMISSIONS);
        }
        if (mutation === "source") f.revoke();
        if (mutation === "body") {
          await wire.session.handleMessage(
            wire.request({ text: "different body", inputProvenance: f.token("different body") }),
            wire.source,
          );
          expect(wire.replies.at(-1)).toMatchObject({
            type: "send_agent_message_response",
            payload: { accepted: false },
          });
        }
      }
      f.server.completeTurn();
      await foreground;
      if (["permission", "source"].includes(mutation))
        await vi.waitFor(async () =>
          expect(await f.metadata()).toMatchObject({ state: "refused" }),
        );
      if (mutation === "body")
        await vi.waitFor(async () =>
          expect(await f.metadata()).toMatchObject({ state: "delivered" }),
        );
      expect(f.turnCount()).toBe(mutation === "body" ? 2 : 1);
    } finally {
      await wire.delivery.close();
      await f.cleanup();
    }
  });
}

test("native Session wire: unverified human request does not mint action rights", async () => {
  const f = await fixture("valid", true);
  await registerPrime(f);
  const wire = await sessionWire(f);
  try {
    const before = f.authority.requireSequence(f.agent.id).humanAt;
    await wire.session.handleMessage(wire.request({ inputProvenance: undefined }), wire.source);
    expect(wire.replies.at(-1)).toMatchObject({
      type: "send_agent_message_response",
      payload: { accepted: false, error: expect.stringContaining("authenticated delegated") },
    });
    expect(f.authority.requireSequence(f.agent.id).humanAt).toBe(before + 1);
    expect(f.turnCount()).toBe(0);
  } finally {
    await wire.delivery.close();
    await f.cleanup();
  }
});

test("native Session wire: owner initialization missing refuses, lowering limit fences a queued dispatch", async () => {
  const f = await fixture("valid", true);
  const wire = await sessionWire(f);
  try {
    await wire.session.handleMessage(wire.request(), wire.source);
    expect(wire.replies.at(-1)).toMatchObject({
      type: "send_agent_message_response",
      payload: { accepted: false, error: expect.stringContaining("initialization") },
    });
    await registerPrime(f);
    const foreground = (async () => {
      for await (const event of f.manager.streamAgent(f.agent.id, "foreground fixture")) void event;
    })();
    await f.manager.waitForAgentRunStart(f.agent.id);
    await wire.session.handleMessage(wire.request(), wire.source);
    expect(wire.replies.at(-1)).toMatchObject({
      payload: { accepted: true, nativeReceipt: { state: "queued" } },
    });
    const owner = f.authority.management.open(
      {
        pluginId: "orca-organization-next",
        bundleDirectory: "/fixture/bundle",
        isCurrent: () => true,
      },
      () => ({
        id: "fixture-owner",
        authentication: "protected-local-ipc",
        deviceId: null,
        permissions: ["command-centre.manage", "daemon.manage", "accounts.manage"],
      }),
    )!;
    try {
      await owner.invoke(randomUUID(), {
        method: "intercom-rate-settings-set",
        input: {
          messageId: randomUUID(),
          settings: { report: 12, followup: 32, channel: 0, seat: 8 },
        },
      });
    } finally {
      owner.close();
    }
    f.server.completeTurn();
    await foreground;
    await vi.waitFor(async () => expect(await f.metadata()).toMatchObject({ state: "refused" }));
    expect(f.turnCount()).toBe(1);
  } finally {
    await wire.delivery.close();
    await f.cleanup();
  }
});

test.each(["steerAgentRun", "steerOrReplaceActiveTurn"] as const)(
  "private finish unsupported steer: %s refuses before held provider invocation",
  async (method) => {
    const f = await fixture("valid");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let effects = 0;
    const run = (async () => {
      for await (const event of f.manager.streamAgent(f.agent.id, "fixture running work"))
        void event;
    })();
    try {
      await f.manager.waitForAgentRunStart(f.agent.id);
      const target = Reflect.get(f.manager, "agents").get(f.agent.id);
      Reflect.set(target, "provider", "opencode");
      const steer = vi.spyOn(target.session, "steerActiveTurn").mockImplementation(async () => {
        await gate;
        effects++;
        return { status: "accepted" };
      });
      const { createFinalInputCheck } = await import("./final-input-check.js");
      const { FINAL_INPUT_CHECK } = await import("./agent-sdk-types.js");
      const attempt = f.manager[method](f.agent.id, "private finish notice", {
        [FINAL_INPUT_CHECK]: createFinalInputCheck(() => {}),
      });
      const rejected = expect(attempt).rejects.toThrow(
        "Final-checked notification provider unavailable",
      );
      release();
      await rejected;
      expect(steer).not.toHaveBeenCalled();
      expect(effects).toBe(0);
      await f.manager[method](f.agent.id, "ordinary steer without private purpose");
      expect(steer).toHaveBeenCalledTimes(1);
      expect(effects).toBe(1);
    } finally {
      release();
      Reflect.set(Reflect.get(f.manager, "agents").get(f.agent.id), "provider", "codex");
      f.server.completeTurn({ threadId: f.agent.persistence!.sessionId });
      await run;
      await f.cleanup();
    }
  },
);

test.each([
  "valid",
  "metadata",
  "paired",
  "report",
  "unknown-scope",
  "wrong-epoch",
  "unadmitted",
  "source-revoke",
  "permissions",
  "native-replace",
  "disconnect",
] as const)(
  "native owner report read: %s uses actual Session admission and protected ledger projection",
  async (mutation) => {
    const f = await fixture("valid", true);
    const { scope, receipt } = await registerPrime(f);
    if (mutation === "metadata") {
      const child = await f.manager.createAgent(
        { provider: "codex", cwd: f.directory, model: "gpt-5.4" },
        undefined,
        { workspaceId: undefined },
      );
      const parentIdentity = Reflect.get(f.manager, "currentReportIdentity").call(
        f.manager,
        f.agent.id,
      );
      const childIdentity = Reflect.get(f.manager, "currentReportIdentity").call(
        f.manager,
        child.id,
      );
      const owner = f.authority.management.open(
        {
          pluginId: "orca-organization-next",
          bundleDirectory: "/fixture/bundle",
          isCurrent: () => true,
        },
        () => ({
          id: "fixture-owner",
          authentication: "protected-local-ipc",
          deviceId: null,
          permissions: OWNER_PERMISSIONS,
        }),
      )!;
      try {
        await owner.invoke(randomUUID(), {
          method: "report-parent-adopt",
          input: {
            messageId: randomUUID(),
            child: childIdentity,
            parent: parentIdentity,
            scopes: [scope],
            expectedEpoch: null,
          },
        });
      } finally {
        owner.close();
      }
      const registry = Reflect.get(f.manager, "reportRegistry");
      for (const batch of registry.captureLifecycleReports(
        childIdentity,
        "needs-you",
        "fixture-host-event",
        Date.now(),
      ))
        await Reflect.get(f.manager, "collectNativeReport").call(f.manager, batch);
    }
    const wire = await sessionWire(f);
    const target = {
      pluginId: "orca-organization-next",
      bundleDirectory: "/fixture/bundle",
      isCurrent: () => true,
    };
    Reflect.set(wire.session, "pluginRuntime", { managementTarget: () => target });
    Reflect.set(wire.session, "managementSources", new Map());
    const identity = Reflect.get(f.manager, "currentReportIdentity").call(f.manager, f.agent.id);
    const epoch = (receipt as { epoch: string }).epoch;
    wire.session.admitManagementSource(wire.source, {
      id: "fixture-owner",
      authentication: mutation === "report" ? ("report" as never) : "protected-local-ipc",
      deviceId: mutation === "paired" ? randomUUID() : null,
    });
    if (mutation === "unadmitted") wire.session.revokeManagementSource(wire.source);
    const message = SessionInboundMessageSchema.parse({
      type: "native.report.inbox.request",
      requestId: randomUUID(),
      identity,
      expectedEpoch: mutation === "wrong-epoch" ? randomUUID() : epoch,
      scope:
        mutation === "unknown-scope" ? { projectId: randomUUID(), taskId: randomUUID() } : scope,
    });
    const ledger = Reflect.get(f.manager, "nativeReceipts");
    const original = ledger.reportInbox.bind(ledger);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waits = ["source-revoke", "permissions", "native-replace", "disconnect"].includes(
      mutation,
    );
    if (waits)
      vi.spyOn(ledger, "reportInbox").mockImplementation(async (reader: unknown) => {
        const result = await original(reader);
        entered();
        await held;
        return result;
      });
    try {
      const pending = wire.session.handleMessage(message, wire.source);
      if (waits) {
        await waiting;
        if (mutation === "disconnect") await wire.delivery.detach(wire.source);
        if (mutation === "source-revoke") wire.session.revokeManagementSource(wire.source);
        if (mutation === "permissions") wire.session.setPermissions(["workspace.read"]);
        if (mutation === "native-replace")
          Reflect.set(
            Reflect.get(f.manager, "agents").get(f.agent.id).session,
            "currentThreadId",
            "replaced-native",
          );
        release();
      }
      await pending;
      const response = wire.replies.find((r) => r.type === "native.report.inbox.response");
      if (mutation === "valid")
        expect(response).toMatchObject({
          payload: {
            output: { scope, visibleMetadataCount: 0, events: [], overflow: [], bounded: true },
          },
        });
      else if (mutation === "metadata")
        expect(response).toMatchObject({
          payload: {
            output: {
              scope,
              visibleMetadataCount: 1,
              events: [
                {
                  kind: "needs-you",
                  metadataCommitted: true,
                  providerAccepted: false,
                  consumed: false,
                },
              ],
              bounded: true,
            },
          },
        });
      else expect(response).toBeUndefined();
      expect(JSON.stringify(wire.replies)).not.toContain("report1.");
      expect(f.turnCount()).toBe(0);
    } finally {
      release();
      await wire.delivery.close();
      await f.cleanup();
    }
  },
);

test("native owner report read strict wire denies caller authentication, credentials and recipient shortcuts", () => {
  const identity = {
    agentId: randomUUID(),
    instanceId: randomUUID(),
    sessionId: "fixture-native",
    boot: randomUUID(),
  };
  const input = {
    type: "native.report.inbox.request",
    requestId: randomUUID(),
    identity,
    expectedEpoch: randomUUID(),
    scope: { projectId: randomUUID(), taskId: randomUUID() },
  };
  for (const extra of [
    { owner: true },
    { authentication: "protected-local-ipc" },
    { capability: "report1.forged" },
    { reportKind: "report" },
    { recipient: randomUUID() },
  ])
    expect(() => SessionInboundMessageSchema.parse({ ...input, ...extra })).toThrow();
});

test("native evidence end-to-end: actual manager parent/source and provider completion feeds protected Session index, no artifact content grant", async () => {
  const f = await fixture("valid", true);
  const { scope, receipt } = await registerPrime(f);
  const child = await f.manager.createAgent(
    { provider: "codex", cwd: f.directory, model: "gpt-5.4" },
    undefined,
    {},
  );
  const identity = (id: string) =>
    Reflect.get(f.manager, "currentReportIdentity").call(f.manager, id);
  const owner = f.authority.management.open(
    {
      pluginId: "orca-organization-next",
      bundleDirectory: "/fixture/bundle",
      isCurrent: () => true,
    },
    () => ({
      id: "fixture-owner",
      authentication: "protected-local-ipc",
      deviceId: null,
      permissions: OWNER_PERMISSIONS,
    }),
  )!;
  try {
    await owner.invoke(randomUUID(), {
      method: "report-parent-adopt",
      input: {
        messageId: randomUUID(),
        child: identity(child.id),
        parent: identity(f.agent.id),
        scopes: [scope],
        expectedEpoch: null,
      },
    });
    const provider = Reflect.get(f.manager, "agents").get(child.id).session;
    const client = Reflect.get(provider, "client");
    Reflect.set(provider, "currentTurnId", "evidence-turn");
    const threadId = identity(child.id).sessionId;
    const items = [
      {
        id: "native-command",
        type: "commandExecution",
        status: "completed",
        command: "THROWAWAY_PRIVATE_COMMAND",
        aggregatedOutput: "THROWAWAY_PRIVATE_OUTPUT",
        exitCode: 0,
      },
      {
        id: "native-touch",
        type: "fileChange",
        status: "completed",
        changes: [
          { path: "THROWAWAY_PRIVATE_PATH", kind: "update", diff: "THROWAWAY_PRIVATE_DIFF" },
        ],
      },
      {
        id: "native-produced",
        type: "imageGeneration",
        status: "completed",
        result: "data:image/png;base64,aGVsbG8=",
      },
      { id: "native-view", type: "imageView", path: "/throwaway/viewed-image.png" },
      {
        id: "native-markdown",
        type: "agentMessage",
        text: "![claimed output](file:///throwaway/claim.png)",
      },
    ];
    for (const item of items)
      Reflect.get(provider, "handleNotification").call(
        provider,
        "item/completed",
        { threadId, turnId: "evidence-turn", item },
        client,
      );
    const wire = await sessionWire(f);
    Reflect.set(wire.session, "pluginRuntime", {
      managementTarget: () => ({
        pluginId: "orca-organization-next",
        bundleDirectory: "/fixture/bundle",
        isCurrent: () => true,
      }),
    });
    Reflect.set(wire.session, "managementSources", new Map());
    wire.session.admitManagementSource(wire.source, {
      id: "fixture-owner",
      authentication: "protected-local-ipc",
      deviceId: null,
    });
    const input = {
      type: "native.evidence.index.request",
      requestId: randomUUID(),
      identity: identity(f.agent.id),
      expectedEpoch: (receipt as { epoch: string }).epoch,
      scope,
    };
    await vi.waitFor(async () => {
      wire.replies.length = 0;
      await wire.session.handleMessage(SessionInboundMessageSchema.parse(input), wire.source);
      const response = wire.replies.find((r) => r.type === "native.evidence.index.response");
      expect(response).toBeDefined();
      expect(response).toMatchObject({
        payload: {
          output: {
            entries: expect.arrayContaining([
              expect.objectContaining({
                fact: expect.objectContaining({ kind: "command_result" }),
              }),
              expect.objectContaining({ fact: expect.objectContaining({ kind: "file_touch" }) }),
              expect.objectContaining({
                fact: expect.objectContaining({
                  kind: "produced_artifact",
                  contentAvailable: false,
                }),
              }),
            ]),
            contentReadAvailable: false,
          },
        },
      });
      const body = JSON.stringify(response);
      expect(body).not.toContain("THROWAWAY_PRIVATE");
      expect(body).not.toContain(f.directory);
      expect(body).not.toContain("native-command");
      expect(
        (response as { payload: { output: { entries: unknown[] } } }).payload.output.entries,
      ).toHaveLength(3);
    });
    // A mirrored/same completion must neither rematerialize nor create another record.
    Reflect.get(provider, "handleNotification").call(
      provider,
      "item/completed",
      { threadId, turnId: "evidence-turn", item: items[2] },
      client,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const ledger = Reflect.get(f.manager, "nativeReceipts");
    const before = await ledger.evidenceIndex(
      f.agent.id,
      (receipt as { epoch: string }).epoch,
      scope,
      () => {},
      () => {},
    );
    expect(before).toHaveLength(3);
    await f.manager.closeAgent(child.id);
    const registry = Reflect.get(f.manager, "reportRegistry");
    for (const record of before)
      registry.requireCommittedEvidence(
        record.source,
        record.sourceEpoch,
        record.recipient,
        record.recipientEpoch,
        scope,
        record.entry.at,
      );
    wire.session.revokeManagementSource(wire.source);
    wire.replies.length = 0;
    await wire.session.handleMessage(
      SessionInboundMessageSchema.parse({ ...input, requestId: randomUUID() }),
      wire.source,
    );
    expect(wire.replies.some((r) => r.type === "native.evidence.index.response")).toBe(false);
  } finally {
    owner.close();
    await f.cleanup();
  }
});

test.each(["valid", "paired", "wrong-epoch", "unknown-scope", "disconnect", "owner-revoke"])(
  "native evidence owner wire %s never derives grants from index feature or parent labels",
  async (mutation) => {
    const f = await fixture("valid", true);
    const { scope, receipt } = await registerPrime(f);
    const wire = await sessionWire(f);
    Reflect.set(wire.session, "pluginRuntime", {
      managementTarget: () => ({
        pluginId: "orca-organization-next",
        bundleDirectory: "/fixture/bundle",
        isCurrent: () => true,
      }),
    });
    Reflect.set(wire.session, "managementSources", new Map());
    wire.session.admitManagementSource(wire.source, {
      id: "fixture-owner",
      authentication: "protected-local-ipc",
      deviceId: mutation === "paired" ? randomUUID() : null,
    });
    const input = SessionInboundMessageSchema.parse({
      type: "native.evidence.index.request",
      requestId: randomUUID(),
      identity: Reflect.get(f.manager, "currentReportIdentity").call(f.manager, f.agent.id),
      expectedEpoch:
        mutation === "wrong-epoch" ? randomUUID() : (receipt as { epoch: string }).epoch,
      scope:
        mutation === "unknown-scope" ? { projectId: randomUUID(), taskId: randomUUID() } : scope,
    });
    const ledger = Reflect.get(f.manager, "nativeReceipts");
    const original = ledger.evidenceIndex.bind(ledger);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (mutation === "disconnect" || mutation === "owner-revoke")
      vi.spyOn(ledger, "evidenceIndex").mockImplementation(async (...args: unknown[]) => {
        const result = await original(...args);
        entered();
        await held;
        return result;
      });
    try {
      const pending = wire.session.handleMessage(input, wire.source);
      if (mutation === "disconnect" || mutation === "owner-revoke") {
        await waiting;
        if (mutation === "disconnect") await wire.delivery.detach(wire.source);
        else wire.session.revokeManagementSource(wire.source);
        release();
      }
      await pending;
      const response = wire.replies.find((r) => r.type === "native.evidence.index.response");
      if (mutation === "valid")
        expect(response).toMatchObject({
          payload: { output: { scope, entries: [], bounded: true, contentReadAvailable: false } },
        });
      else expect(response).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  },
);

test.each(["native-replace", "parent-revoke"])(
  "native evidence actual manager %s after held durable reservation refuses artifact effect",
  async (mutation) => {
    const f = await fixture("valid", true);
    const { scope, receipt } = await registerPrime(f);
    const child = await f.manager.createAgent(
      { provider: "codex", cwd: f.directory, model: "gpt-5.4" },
      undefined,
      {},
    );
    const identity = (id: string) =>
      Reflect.get(f.manager, "currentReportIdentity").call(f.manager, id);
    const owner = f.authority.management.open(
      {
        pluginId: "orca-organization-next",
        bundleDirectory: "/fixture/bundle",
        isCurrent: () => true,
      },
      () => ({
        id: "fixture-owner",
        authentication: "protected-local-ipc",
        deviceId: null,
        permissions: OWNER_PERMISSIONS,
      }),
    )!;
    let release!: () => void;
    try {
      await owner.invoke(randomUUID(), {
        method: "report-parent-adopt",
        input: {
          messageId: randomUUID(),
          child: identity(child.id),
          parent: identity(f.agent.id),
          scopes: [scope],
          expectedEpoch: null,
        },
      });
      const provider = Reflect.get(f.manager, "agents").get(child.id).session;
      const client = Reflect.get(provider, "client");
      Reflect.set(provider, "currentTurnId", "evidence-held-turn");
      const threadId = identity(child.id).sessionId;
      const events: unknown[] = [];
      provider.subscribe((event: unknown) => events.push(event));
      const ledger = Reflect.get(f.manager, "nativeReceipts");
      const original = ledger.prepareEvidence.bind(ledger);
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.spyOn(ledger, "prepareEvidence").mockImplementation(async (...args: unknown[]) => {
        const result = await original(...args);
        entered();
        await held;
        return result;
      });
      Reflect.get(provider, "handleNotification").call(
        provider,
        "item/completed",
        {
          threadId,
          turnId: "evidence-held-turn",
          item: {
            id: "held-generation",
            type: "imageGeneration",
            status: "completed",
            result: "data:image/png;base64,aGVsbG8=",
          },
        },
        client,
      );
      await waiting;
      if (mutation === "native-replace")
        Reflect.set(provider, "currentThreadId", "external-native-replacement");
      else
        await owner.invoke(randomUUID(), {
          method: "report-registration-revoke",
          input: {
            messageId: randomUUID(),
            identity: identity(f.agent.id),
            expectedEpoch: (receipt as { epoch: string }).epoch,
          },
        });
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(events.some((event) => JSON.stringify(event).includes("![Image]"))).toBe(false);
      expect(
        await ledger.evidenceIndex(
          f.agent.id,
          (receipt as { epoch: string }).epoch,
          scope,
          () => {},
          () => {},
        ),
      ).toEqual([]);
    } finally {
      release?.();
      owner.close();
      await f.cleanup();
    }
  },
);

test("managed artifact actual owner opt-in, native tool origin and protected Session namespace", async () => {
  const f = await fixture("valid", true);
  const { scope, receipt } = await registerPrime(f);
  const child = await f.manager.createAgent(
    { provider: "codex", cwd: f.directory, model: "gpt-5.4" },
    undefined,
    {},
  );
  const identity = (id: string) =>
    Reflect.get(f.manager, "currentReportIdentity").call(f.manager, id);
  const owner = f.authority.management.open(
    {
      pluginId: "orca-organization-next",
      bundleDirectory: "/fixture/bundle",
      isCurrent: () => true,
    },
    () => ({
      id: "fixture-owner",
      authentication: "protected-local-ipc",
      deviceId: null,
      permissions: OWNER_PERMISSIONS,
    }),
  )!;
  let foreground: Promise<void> | undefined;
  const wire = await sessionWire(f);
  try {
    const adoption = (await owner.invoke(randomUUID(), {
      method: "report-parent-adopt",
      input: {
        messageId: randomUUID(),
        child: identity(child.id),
        parent: identity(f.agent.id),
        scopes: [scope],
        expectedEpoch: null,
      },
    })) as { epoch: string };
    foreground = (async () => {
      for await (const event of f.manager.streamAgent(child.id, "managed fixture foreground"))
        void event;
    })();
    await f.manager.waitForAgentRunStart(child.id);
    const snapshots = Object.create(ProviderSnapshotManager.prototype) as ProviderSnapshotManager;
    const catalog = createPaseoToolCatalog({
      agentManager: f.manager,
      agentStorage: new AgentStorage(path.join(f.directory, "agents"), createTestLogger()),
      providerSnapshotManager: snapshots,
      logger: createTestLogger(),
      callerAgentId: child.id,
      nativeReportOrigin: f.nativeOrigin(child.id),
    });
    const input = { operationId: randomUUID(), scope, text: "throwaway managed private body" };
    await expect(catalog.executeTool("produce_artifact", input)).rejects.toThrow();
    await owner.invoke(randomUUID(), {
      method: "artifact-tool-owner-set",
      input: {
        messageId: randomUUID(),
        identity: identity(child.id),
        expectedEpoch: adoption.epoch,
        scope,
        enabled: true,
        expiresAt: Date.now() + 60000,
      },
    });
    const result = await catalog.executeTool("produce_artifact", input);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      basis: "host_materialized_declared_output",
      metadataCommitted: true,
      contentReadAvailable: false,
    });
    await expect(catalog.executeTool("produce_artifact", input)).rejects.toThrow(
      "already attempted",
    );
    await expect(
      catalog.executeTool("produce_artifact", { ...input, text: "changed private body" }),
    ).rejects.toThrow("already attempted");
    await expect(
      f.manager.produceManagedArtifact({ nativeArtifactInvocation: true }),
    ).rejects.toThrow();
    Reflect.set(wire.session, "pluginRuntime", {
      managementTarget: () => ({
        pluginId: "orca-organization-next",
        bundleDirectory: "/fixture/bundle",
        isCurrent: () => true,
      }),
    });
    Reflect.set(wire.session, "managementSources", new Map());
    wire.session.admitManagementSource(wire.source, {
      id: "fixture-owner",
      authentication: "protected-local-ipc",
      deviceId: null,
    });
    const query = {
      requestId: randomUUID(),
      identity: identity(f.agent.id),
      expectedEpoch: (receipt as { epoch: string }).epoch,
      scope,
    };
    await wire.session.handleMessage(
      SessionInboundMessageSchema.parse({
        type: "native.managed-artifacts.index.request",
        ...query,
      }),
      wire.source,
    );
    const response = wire.replies.find((r) => r.type === "native.managed-artifacts.index.response");
    expect(response).toMatchObject({
      payload: {
        output: {
          contentReadAvailable: false,
          entries: [
            { fact: { kind: "managed_artifact", basis: "host_materialized_declared_output" } },
          ],
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain(input.text);
    expect(JSON.stringify(response)).not.toContain(f.directory);
    wire.replies.length = 0;
    await wire.session.handleMessage(
      SessionInboundMessageSchema.parse({
        type: "native.evidence.index.request",
        ...query,
        requestId: randomUUID(),
      }),
      wire.source,
    );
    expect(wire.replies.find((r) => r.type === "native.evidence.index.response")).toMatchObject({
      payload: { output: { entries: [] } },
    });
    const captured = f.manager.captureManagedArtifactInvocation(f.nativeOrigin(child.id), {
      ...input,
      operationId: randomUUID(),
    });
    await owner.invoke(randomUUID(), {
      method: "artifact-tool-owner-set",
      input: {
        messageId: randomUUID(),
        identity: identity(child.id),
        expectedEpoch: adoption.epoch,
        scope,
        enabled: false,
        expiresAt: Date.now() + 60000,
      },
    });
    await expect(f.manager.produceManagedArtifact(captured)).rejects.toThrow();
  } finally {
    owner.close();
    f.server.completeTurn({ threadId: f.manager.getAgent(child.id)?.persistence?.sessionId });
    await foreground;
    await wire.delivery.close();
    await f.manager.closeAgent(child.id);
    await f.cleanup();
  }
});

test.each(["abort", "native-replacement", "human-input"] as const)(
  "managed artifact captured private invocation refuses %s without materialization",
  async (change) => {
    const f = await fixture("valid", true);
    const { scope } = await registerPrime(f);
    const child = await f.manager.createAgent(
      { provider: "codex", cwd: f.directory, model: "gpt-5.4" },
      undefined,
      {},
    );
    const identity = (id: string) =>
      Reflect.get(f.manager, "currentReportIdentity").call(f.manager, id);
    const target = {
      pluginId: "orca-organization-next",
      bundleDirectory: "/fixture/bundle",
      isCurrent: () => true,
    };
    const owner = f.authority.management.open(target, () => ({
      id: "fixture-owner",
      authentication: "protected-local-ipc",
      deviceId: null,
      permissions: OWNER_PERMISSIONS,
    }))!;
    const paired = f.authority.management.open(target, () => ({
      id: "fixture-paired",
      authentication: "protected-local-ipc",
      deviceId: randomUUID(),
      permissions: OWNER_PERMISSIONS,
    }))!;
    let foreground: Promise<void> | undefined;
    try {
      const adoption = (await owner.invoke(randomUUID(), {
        method: "report-parent-adopt",
        input: {
          messageId: randomUUID(),
          child: identity(child.id),
          parent: identity(f.agent.id),
          scopes: [scope],
          expectedEpoch: null,
        },
      })) as { epoch: string };
      const enable = {
        messageId: randomUUID(),
        identity: identity(child.id),
        expectedEpoch: adoption.epoch,
        scope,
        enabled: true,
        expiresAt: Date.now() + 60000,
      };
      await expect(
        paired.invoke(randomUUID(), { method: "artifact-tool-owner-set", input: enable }),
      ).rejects.toThrow();
      await owner.invoke(randomUUID(), { method: "artifact-tool-owner-set", input: enable });
      foreground = (async () => {
        for await (const event of f.manager.streamAgent(child.id, "managed guarded foreground"))
          void event;
      })();
      await f.manager.waitForAgentRunStart(child.id);
      const controller = new AbortController();
      const input = { operationId: randomUUID(), scope, text: "captured private bytes" };
      const captured = f.manager.captureManagedArtifactInvocation(
        f.nativeOrigin(child.id),
        input,
        controller.signal,
      );
      input.text = "caller mutation cannot replace captured bytes";
      if (change === "abort") controller.abort();
      else if (change === "native-replacement")
        Reflect.set(
          Reflect.get(f.manager, "agents").get(child.id).session,
          "currentThreadId",
          "external-replacement",
        );
      else
        f.authority.rpc(undefined, () =>
          f.authority.input(
            f.manager.getAgent(child.id)!,
            "prompt",
            undefined,
            () => {},
            promptPayload("human fixture input"),
          ),
        );
      await expect(f.manager.produceManagedArtifact(captured)).rejects.toThrow();
      const ledger = Reflect.get(f.manager, "nativeReceipts");
      expect(Reflect.get(ledger, "managedClaims").size).toBe(0);
      expect(Reflect.get(ledger, "managedArtifacts").size).toBe(0);
    } finally {
      paired.close();
      owner.close();
      f.server.completeTurn();
      await f.manager.closeAgent(child.id);
      await foreground;
      await f.cleanup();
    }
  },
);

async function nativeContentFixture() {
  const f = await fixture("valid", true);
  const { scope, receipt } = await registerPrime(f);
  const child = await f.manager.createAgent(
    { provider: "codex", cwd: f.directory, model: "gpt-5.4" },
    undefined,
    {},
  );
  const identity = (id: string) =>
    Reflect.get(f.manager, "currentReportIdentity").call(f.manager, id);
  const target = {
    pluginId: "orca-organization-next",
    bundleDirectory: "/fixture/bundle",
    isCurrent: () => true,
  };
  const owner = f.authority.management.open(target, () => ({
    id: "fixture-owner",
    authentication: "protected-local-ipc",
    deviceId: null,
    permissions: OWNER_PERMISSIONS,
  }))!;
  const adopted = (await owner.invoke(randomUUID(), {
    method: "report-parent-adopt",
    input: {
      messageId: randomUUID(),
      child: identity(child.id),
      parent: identity(f.agent.id),
      scopes: [scope],
      expectedEpoch: null,
    },
  })) as { epoch: string };
  await owner.invoke(randomUUID(), {
    method: "artifact-tool-owner-set",
    input: {
      messageId: randomUUID(),
      identity: identity(child.id),
      expectedEpoch: adopted.epoch,
      scope,
      enabled: true,
      expiresAt: Date.now() + 60000,
    },
  });
  const foreground = (async () => {
    for await (const event of f.manager.streamAgent(child.id, "content fixture foreground"))
      void event;
  })();
  await f.manager.waitForAgentRunStart(child.id);
  const bytes = "abcdefghijklmnopqrstuvwx";
  const produced = await f.manager.produceManagedArtifact(
    f.manager.captureManagedArtifactInvocation(f.nativeOrigin(child.id), {
      operationId: randomUUID(),
      scope,
      text: bytes,
    }),
  );
  const select = {
    identity: identity(f.agent.id),
    expectedEpoch: (receipt as { epoch: string }).epoch,
    scope,
  };
  const issue = {
    ...select,
    messageId: randomUUID(),
    grantId: randomUUID(),
    expectedGrantRevision: null,
    artifactIds: [produced.id],
    byteBudget: 8,
    expiresAt: Date.now() + 60000,
    enabled: true,
  };
  const wire = await sessionWire(f);
  Reflect.set(wire.session, "checkoutWriteAdmissionEpoch", 0);
  Reflect.set(wire.session, "pluginRuntime", { managementTarget: () => target });
  Reflect.set(wire.session, "managementSources", new Map());
  wire.session.admitManagementSource(wire.source, {
    id: "fixture-owner",
    authentication: "protected-local-ipc",
    deviceId: null,
  });
  const ledger = Reflect.get(f.manager, "nativeReceipts");
  return {
    f,
    owner,
    wire,
    issue,
    select,
    ledger,
    bytes,
    produced,
    async cleanup() {
      owner.close();
      // Failed guarded durability deliberately poisons the ledger. Fixture teardown must not
      // ask that ledger to cancel reports; this is not a production recovery path.
      if (Reflect.get(ledger, "unhealthy")) Reflect.set(f.manager, "nativeReceipts", undefined);
      f.server.completeTurn({ threadId: f.manager.getAgent(child.id)?.persistence?.sessionId });
      await foreground;
      await wire.delivery.close();
      await f.manager.closeAgent(child.id);
      await f.cleanup();
    },
  };
}

test.each(["valid", "no-grant", "paired", "human-typing", "lowered"] as const)(
  "content purpose actual owner grant/protected Session %s",
  async (mode) => {
    const c = await nativeContentFixture();
    try {
      const response =
        mode === "no-grant"
          ? undefined
          : ((await c.owner.invoke(randomUUID(), {
              method: "artifact-content-owner-set",
              input: c.issue,
            })) as { grants: { revision: string }[] });
      const revision = response?.grants[0]?.revision ?? randomUUID();
      if (mode === "paired") {
        const paired = c.f.authority.management.open(
          {
            pluginId: "orca-organization-next",
            bundleDirectory: "/fixture/bundle",
            isCurrent: () => true,
          },
          () => ({
            id: "paired",
            authentication: "protected-local-ipc",
            deviceId: randomUUID(),
            permissions: OWNER_PERMISSIONS,
          }),
        )!;
        try {
          await expect(
            paired.invoke(randomUUID(), {
              method: "artifact-content-owner-set",
              input: { ...c.issue, messageId: randomUUID(), grantId: randomUUID() },
            }),
          ).rejects.toThrow();
        } finally {
          paired.close();
        }
        c.wire.session.revokeManagementSource(c.wire.source);
        c.wire.session.admitManagementSource(c.wire.source, {
          id: "paired",
          authentication: "protected-local-ipc",
          deviceId: randomUUID(),
        });
      }
      if (mode === "human-typing")
        c.f.authority.rpc(undefined, () =>
          c.f.authority.input(
            c.f.manager.getAgent(c.f.agent.id)!,
            "prompt",
            undefined,
            () => {},
            promptPayload("human content recipient input"),
          ),
        );
      const request = {
        type: "native.managed-artifacts.content.request",
        ...c.select,
        requestId: randomUUID(),
        grantId: c.issue.grantId,
        grantRevision: revision,
        artifactId: c.produced.id,
        offset: 0,
        length: 8,
      };
      await c.wire.session.handleMessage(SessionInboundMessageSchema.parse(request), c.wire.source);
      const message = c.wire.replies.find(
        (r) => r.type === "native.managed-artifacts.content.response",
      );
      if (mode === "no-grant" || mode === "paired") {
        expect(message).toBeUndefined();
        expect(Reflect.get(c.ledger, "contentDebits").size).toBe(0);
      } else {
        expect(message).toMatchObject({
          payload: {
            requestId: request.requestId,
            output: {
              grantId: c.issue.grantId,
              length: 8,
              contentType: "text/plain",
              encoding: "base64",
              data: Buffer.from(c.bytes.slice(0, 8)).toString("base64"),
            },
          },
        });
        expect(Reflect.get(c.ledger, "contentDebits").size).toBe(1);
        if (mode === "lowered") {
          const next = (await c.owner.invoke(randomUUID(), {
            method: "artifact-content-owner-set",
            input: {
              ...c.issue,
              messageId: randomUUID(),
              expectedGrantRevision: revision,
              byteBudget: 4,
            },
          })) as { grants: { revision: string }[] };
          c.wire.replies.length = 0;
          await c.wire.session.handleMessage(
            SessionInboundMessageSchema.parse({
              ...request,
              requestId: randomUUID(),
              grantRevision: next.grants[0]!.revision,
              length: 1,
            }),
            c.wire.source,
          );
          expect(
            c.wire.replies.find((r) => r.type === "native.managed-artifacts.content.response"),
          ).toBeUndefined();
          expect(Reflect.get(c.ledger, "contentDebits").size).toBe(1);
        }
      }
    } finally {
      await c.cleanup();
    }
  },
);

test.each(["grant-revoke", "permission-regain", "disconnect", "recipient-replacement"] as const)(
  "content purpose held durable preparation fences %s before disclosure",
  async (mutation) => {
    const c = await nativeContentFixture();
    const response = (await c.owner.invoke(randomUUID(), {
      method: "artifact-content-owner-set",
      input: c.issue,
    })) as { grants: { revision: string }[] };
    const request = SessionInboundMessageSchema.parse({
      type: "native.managed-artifacts.content.request",
      ...c.select,
      requestId: randomUUID(),
      grantId: c.issue.grantId,
      grantRevision: response.grants[0]!.revision,
      artifactId: c.produced.id,
      offset: 0,
      length: 8,
    });
    const { promises: files } = await import("node:fs");
    const mkdir = files.mkdir;
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(files, "mkdir").mockImplementation(async (...args) => {
      const result = await mkdir(...args);
      if (String(args[0]) === path.join(c.f.directory, "receipts")) {
        entered();
        await held;
      }
      return result;
    });
    try {
      const pending = c.wire.session.handleMessage(request, c.wire.source);
      await waiting;
      if (mutation === "grant-revoke")
        await c.owner.invoke(randomUUID(), {
          method: "artifact-content-owner-set",
          input: {
            ...c.issue,
            messageId: randomUUID(),
            expectedGrantRevision: response.grants[0]!.revision,
            enabled: false,
          },
        });
      else if (mutation === "permission-regain") {
        c.wire.session.setPermissions(OWNER_PERMISSIONS.filter((p) => p !== "workspace.read"));
        c.wire.session.setPermissions(OWNER_PERMISSIONS);
      } else if (mutation === "disconnect") await c.wire.delivery.detach(c.wire.source);
      else
        Reflect.set(
          Reflect.get(c.f.manager, "agents").get(c.f.agent.id).session,
          "currentThreadId",
          "external-content-recipient",
        );
      release();
      await pending;
      expect(
        c.wire.replies.find((r) => r.type === "native.managed-artifacts.content.response"),
      ).toBeUndefined();
      expect(Reflect.get(c.ledger, "contentDebits").size).toBe(0);
    } finally {
      release();
      spy.mockRestore();
      await c.cleanup();
    }
  },
);

test.each(["disconnect", "owner-revoke"] as const)(
  "content purpose after byte preparation fences late %s without refund or delivery claim",
  async (mutation) => {
    const c = await nativeContentFixture();
    const granted = (await c.owner.invoke(randomUUID(), {
      method: "artifact-content-owner-set",
      input: c.issue,
    })) as { grants: { revision: string }[] };
    const input = SessionInboundMessageSchema.parse({
      type: "native.managed-artifacts.content.request",
      ...c.select,
      requestId: randomUUID(),
      grantId: c.issue.grantId,
      grantRevision: granted.grants[0]!.revision,
      artifactId: c.produced.id,
      offset: 0,
      length: 8,
    });
    const read = c.ledger.readManagedArtifactContent.bind(c.ledger);
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    const spy = vi
      .spyOn(c.ledger, "readManagedArtifactContent")
      .mockImplementation(async (...args: unknown[]) => {
        const output = await read(...args);
        entered();
        await held;
        return output;
      });
    try {
      const pending = c.wire.session.handleMessage(input, c.wire.source);
      await waiting;
      if (mutation === "disconnect") await c.wire.delivery.detach(c.wire.source);
      else c.wire.session.revokeManagementSource(c.wire.source);
      release();
      await pending;
      expect(
        c.wire.replies.find((r) => r.type === "native.managed-artifacts.content.response"),
      ).toBeUndefined();
      expect(Reflect.get(c.ledger, "contentDebits").size).toBe(1);
    } finally {
      release();
      spy.mockRestore();
      await c.cleanup();
    }
  },
);

test("content purpose finite grant-store capacity refuses before publication and keeps scoped owner view", async () => {
  const c = await nativeContentFixture();
  try {
    for (let n = 0; n < 64; n++) {
      const owner = c.f.authority.management.open(
        {
          pluginId: "orca-organization-next",
          bundleDirectory: "/fixture/bundle",
          isCurrent: () => true,
        },
        () => ({
          id: "fixture-owner",
          authentication: "protected-local-ipc",
          deviceId: null,
          permissions: OWNER_PERMISSIONS,
        }),
      )!;
      try {
        await owner.invoke(randomUUID(), {
          method: "artifact-content-owner-set",
          input: { ...c.issue, messageId: randomUUID(), grantId: randomUUID() },
        });
      } finally {
        owner.close();
      }
    }
    await expect(
      c.owner.invoke(randomUUID(), {
        method: "artifact-content-owner-set",
        input: { ...c.issue, messageId: randomUUID(), grantId: randomUUID() },
      }),
    ).rejects.toThrow("capacity exhausted");
    const status = (await c.owner.invoke(randomUUID(), {
      method: "artifact-content-owner-list",
      input: c.select,
    })) as { grants: unknown[] };
    expect(status.grants).toHaveLength(64);
    expect(JSON.stringify(status)).not.toContain(c.bytes);
    expect(JSON.stringify(status)).not.toContain(c.f.directory);
  } finally {
    await c.cleanup();
  }
});

async function installedLauncherFixture() {
  const f = await fixture("valid", true, false, false, true);
  const { scope } = await registerPrime(f);
  const wire = await sessionWire(f);
  const foreground = (async () => {
    for await (const event of f.manager.streamAgent(f.agent.id, "foreground fixture")) void event;
  })();
  await f.manager.waitForAgentRunStart(f.agent.id);
  const sequence = f.authority.requireSequence(f.agent.id);
  const store = f.controlStore!;
  store.created(f.agent.id, scope.taskId, f.directory);
  const grant = store.transfer(f.agent.id, "delegated", "throwaway verified operator handback");
  const current = (id = f.agent.id) => {
    const agent = f.manager.getAgent(id)!;
    const identity = Reflect.get(f.manager, "currentReportIdentity").call(f.manager, id);
    const seq = f.authority.requireSequence(id);
    return {
      id: agent.id,
      status: agent.activeForegroundTurnId ? "running" : "idle",
      pending: agent.pendingPermissions.size,
      boot: seq.boot,
      humanAt: seq.humanAt,
      runtimeInstanceId: agent.instanceId,
      nativeId: identity?.sessionId,
      model: agent.runtimeInfo?.model ?? agent.config.model,
      serviceTier: null,
      lastUserAt: agent.lastUserMessageAt?.toISOString() ?? null,
      lastPromptId: null,
      promptClaimsControl: false,
      archivedAt: null,
      timelineCursor: { epoch: randomUUID(), seq: 0 },
    };
  };
  store.db
    .prepare("UPDATE sessions SET authority=?,boot=?,grantedAt=?,expectedAt=? WHERE id=?")
    .run(
      JSON.stringify([scope.taskId]),
      sequence.boot,
      sequence.humanAt + 1,
      current().lastUserAt,
      f.agent.id,
    );
  let sends = 0;
  const inputs = boundNativeInputs({
    verifyActivation: () => {},
    issueProvenance: f.controlIssue,
    daemon: {
      invokeRawInput: async (message: SessionInboundMessage) => {
        sends++;
        const before = wire.replies.length;
        await wire.delivery.request(wire.source, message.requestId, () =>
          wire.session.handleMessage(message),
        );
        const reply = wire.replies
          .slice(before)
          .find((value) => value.type === "send_agent_message_response");
        if (!reply || reply.type !== "send_agent_message_response")
          throw Error("native reply missing");
        return reply.payload;
      },
    },
  });
  const control = new Controller({
    store,
    native: { inspect: async (id: string) => current(id), sendQueued: inputs.sendQueued },
    authority: async () => ({ delegationAuthority: [scope.taskId] }),
    humanLogDir: f.directory,
  });
  return { f, wire, store, grant, control, foreground, sends: () => sends, current };
}

test("installed queued launcher: actual private provenance/journal to busy Session/ledger/Codex, one write and native fact observer", async () => {
  const x = await installedLauncherFixture();
  const message = {
    sessionId: x.f.agent.id,
    messageId: randomUUID(),
    text: "installed instruction",
  };
  try {
    const before = x.f.turnCount();
    const accepted = await x.control.sendQueued(message, undefined, x.grant.generation);
    expect(accepted.state).toBe("queued");
    expect(accepted.result.nativeReceipt).toMatchObject({
      messageId: "orca-control:" + message.messageId,
      state: "queued",
      pendingCount: 1,
    });
    expect(x.f.turnCount()).toBe(before);
    expect((await x.control.sendQueued(message, undefined, x.grant.generation)).state).toBe(
      "queued",
    );
    expect(x.sends()).toBe(1);
    x.f.server.completeTurn({ threadId: "thread-1", turnId: "native-1" });
    await x.foreground;
    await vi.waitFor(() => expect(x.store.delivery(message.messageId)?.state).toBe("delivered"));
    expect(x.f.turnCount()).toBe(before + 1);
    expect(x.store.delivery(message.messageId)?.result.nativeReceipt).toMatchObject({
      state: "delivered",
      providerTurnId: "native-2",
    });
    expect(x.store.get(x.f.agent.id)?.expected).toBe(message.messageId);
    expect(x.sends()).toBe(1);
    x.f.server.completeTurn({ threadId: "thread-1", turnId: "native-2" });
  } finally {
    await x.f.cleanup();
  }
});

for (const mutation of ["human", "generation", "runtime", "body"] as const) {
  test(`installed queued launcher: ${mutation} before settlement refuses without a second native write`, async () => {
    const x = await installedLauncherFixture();
    const message = {
      sessionId: x.f.agent.id,
      messageId: randomUUID(),
      text: "installed instruction",
    };
    try {
      expect((await x.control.sendQueued(message, undefined, x.grant.generation)).state).toBe(
        "queued",
      );
      const before = x.f.turnCount();
      if (mutation === "human")
        x.f.authority.rpc(undefined, () =>
          x.f.manager.withInput(
            x.f.agent.id,
            "prompt",
            randomUUID(),
            () => {},
            promptPayload("human input"),
          ),
        );
      if (mutation === "generation")
        x.store.db
          .prepare("UPDATE sessions SET generation=generation+1 WHERE id=?")
          .run(x.f.agent.id);
      if (mutation === "runtime")
        Reflect.set(
          Reflect.get(x.f.manager, "agents").get(x.f.agent.id),
          "instanceId",
          randomUUID(),
        );
      if (mutation === "body")
        x.store.db
          .prepare("UPDATE deliveries SET body=? WHERE id=?")
          .run(JSON.stringify({ ...message, text: "changed" }), message.messageId);
      x.f.server.completeTurn({ threadId: "thread-1", turnId: "native-1" });
      await x.foreground;
      await vi.waitFor(() =>
        expect(["refused", "cancelled"]).toContain(x.store.delivery(message.messageId)?.state),
      );
      expect(x.f.turnCount()).toBe(before);
      expect(x.sends()).toBe(1);
    } finally {
      await x.f.cleanup();
    }
  });
}

test("installed queued launcher: forged operation observer and ordinary busy send never gain queued purpose", async () => {
  const x = await installedLauncherFixture();
  try {
    expect(() =>
      x.f.authority.nativeQueuedReceipt(
        x.f.agent,
        { operation: { agentId: x.f.agent.id } } as never,
        {
          messageId: "orca-control:forged",
          state: "delivered",
          pendingCount: 0,
          providerTurnId: "forged",
        },
      ),
    ).toThrow();
    await expect(
      x.control.send(
        { sessionId: x.f.agent.id, messageId: randomUUID(), text: "ordinary instruction" },
        undefined,
        x.grant.generation,
      ),
    ).rejects.toThrow(/busy/);
    expect(x.sends()).toBe(0);
    x.f.server.completeTurn({ threadId: "thread-1", turnId: "native-1" });
    await x.foreground;
  } finally {
    await x.f.cleanup();
  }
});

async function roleLauncherFixture() {
  const x = await installedLauncherFixture();
  const sourceDirectory = path.join(x.f.directory, randomUUID());
  await createDirectory(sourceDirectory);
  const source = await x.f.manager.createAgent(
    { provider: "codex", cwd: sourceDirectory, model: "gpt-5.4" },
    undefined,
    {},
  );
  const started = (async () => {
    for await (const event of x.f.manager.streamAgent(source.id, "source fixture")) void event;
  })();
  await x.f.manager.waitForAgentRunStart(source.id);
  x.f.server.completeTurn({ threadId: x.current(source.id).nativeId });
  await started;
  const task = randomUUID(),
    project = randomUUID(),
    creation = randomUUID(),
    token = "throwaway role fixture";
  x.store.created(source.id, task, sourceDirectory);
  const grant = x.store.transfer(source.id, "delegated", "throwaway source handback");
  const seq = x.f.authority.requireSequence(source.id);
  x.store.db
    .prepare("UPDATE sessions SET authority=?,boot=?,grantedAt=?,expectedAt=? WHERE id=?")
    .run(
      JSON.stringify([task]),
      seq.boot,
      seq.humanAt + 1,
      x.current(source.id).lastUserAt,
      source.id,
    );
  x.control.bindings = new Bindings(
    x.control,
    () => [],
    path.join(await realpath(x.f.directory), "role-grants"),
  );
  x.control.roleSessions = new RoleSessions(x.control);
  x.store.db
    .prepare("INSERT INTO role_bindings VALUES (?,?,?,?,?,?,1,'assigned',?,?,?)")
    .run(
      "project-orchestrator",
      project,
      project,
      task,
      source.id,
      grant.generation,
      "fixture seat",
      new Date().toISOString(),
      new Date().toISOString(),
    );
  x.store.db
    .prepare("INSERT INTO role_credentials VALUES (?,?,?)")
    .run(source.id, grant.generation, hash(token));
  x.store.admit(creation, x.f.agent.id, "create", {}, () => {});
  x.store.finish(creation, "delivered", { id: x.f.agent.id });
  x.store.db
    .prepare("INSERT INTO session_ownership VALUES (?,?,?,'project-orchestrator',?,?,1,?,?)")
    .run(
      creation,
      project,
      x.store.get(x.f.agent.id).task,
      "project-orchestrator",
      project,
      source.id,
      new Date().toISOString(),
    );
  return { ...x, source, project, token };
}
for (const mutation of [
  "none",
  "source-human",
  "source-native",
  "source-generation",
  "seat",
  "ownership",
  "credential",
  "credential-rotation",
  "rate",
] as const) {
  test(`installed queued launcher: actual role followup ${mutation} source fence across distinct project tasks`, async () => {
    const x = await roleLauncherFixture();
    const id = randomUUID();
    try {
      const result = await x.control.roleSessions.sendOwned(
        {
          sessionId: x.source.id,
          targetSessionId: x.f.agent.id,
          messageId: id,
          text: "role instruction",
        },
        x.token,
      );
      expect(result.state).toBe("queued");
      if (mutation === "source-human")
        x.f.authority.rpc(undefined, () =>
          x.f.manager.withInput(
            x.source.id,
            "prompt",
            randomUUID(),
            () => {},
            promptPayload("source human"),
          ),
        );
      if (mutation === "source-native")
        Reflect.set(
          Reflect.get(x.f.manager, "agents").get(x.source.id).session,
          "currentThreadId",
          "replaced-native",
        );
      if (mutation === "source-generation")
        x.store.db
          .prepare("UPDATE sessions SET generation=generation+1 WHERE id=?")
          .run(x.source.id);
      if (mutation === "seat")
        x.store.db
          .prepare("UPDATE role_bindings SET revision=revision+1 WHERE seat=?")
          .run(x.project);
      if (mutation === "ownership")
        x.store.db.prepare("UPDATE session_ownership SET projectId=?").run(randomUUID());
      if (mutation === "credential")
        x.store.db.prepare("DELETE FROM role_credentials WHERE session=?").run(x.source.id);
      if (mutation === "credential-rotation") {
        const original = x.store.db
          .prepare("SELECT generation,token FROM role_credentials WHERE session=?")
          .get(x.source.id);
        x.control.bindings.issueRole(x.store.get(x.source.id));
        const rotated = x.store.db
          .prepare("SELECT generation,token FROM role_credentials WHERE session=?")
          .get(x.source.id);
        expect(rotated.generation).toBe(original.generation);
        expect(rotated.token).not.toBe(original.token);
        expect(() => x.control.bindings.checkRole(x.source.id, x.token)).toThrow();
      }
      if (mutation === "rate")
        x.store.db
          .prepare("INSERT OR REPLACE INTO intercom_rate_settings VALUES ('followup',0)")
          .run();
      const count = x.f.turnCount();
      x.f.server.completeTurn({ threadId: "thread-1", turnId: "native-1" });
      await x.foreground;
      await vi.waitFor(() =>
        expect(["delivered", "refused", "cancelled"]).toContain(x.store.delivery(id)?.state),
      );
      expect(x.store.delivery(id)?.state === "delivered").toBe(mutation === "none");
      expect(x.f.turnCount()).toBe(count + (mutation === "none" ? 1 : 0));
      expect(x.sends()).toBe(1);
    } finally {
      await x.f.cleanup();
    }
  });
}

test("multi-prime actual manager: human prime receive-only inbox, native owner rollup and one wake per burst without action cursor change", async () => {
  const f = await fixture("valid", true);
  const { scope, receipt } = await registerPrime(f);
  const create = () =>
    f.manager.createAgent({ provider: "codex", cwd: f.directory, model: "gpt-5.4" }, undefined, {});
  const peer = await create(),
    orchestrator = await create(),
    worker = await create();
  const identity = (id: string) =>
    Reflect.get(f.manager, "currentReportIdentity").call(f.manager, id);
  const registry = Reflect.get(f.manager, "reportRegistry");
  const owner = f.authority.management.open(
    {
      pluginId: "orca-organization-next",
      bundleDirectory: "/fixture/bundle",
      isCurrent: () => true,
    },
    () => ({
      id: "fixture-owner",
      authentication: "protected-local-ipc",
      deviceId: null,
      permissions: OWNER_PERMISSIONS,
    }),
  )!;
  const call = (method: string, input: unknown) =>
    owner.invoke(randomUUID(), { method, input: input as never });
  let primeWork: Promise<void> | undefined, orchWork: Promise<void> | undefined;
  try {
    await call("report-prime-register", {
      messageId: randomUUID(),
      identity: identity(peer.id),
      scopes: [scope],
      expectedEpoch: null,
    });
    await call("report-parent-adopt", {
      messageId: randomUUID(),
      child: identity(orchestrator.id),
      parent: identity(f.agent.id),
      scopes: [scope],
      expectedEpoch: null,
    });
    await call("report-parent-adopt", {
      messageId: randomUUID(),
      child: identity(worker.id),
      parent: identity(orchestrator.id),
      scopes: [scope],
      expectedEpoch: null,
    });
    await call("report-project-transfer", {
      messageId: randomUUID(),
      projectId: scope.projectId,
      from: null,
      expectedFromEpoch: null,
      to: identity(f.agent.id),
      expectedToEpoch: (receipt as { epoch: string }).epoch,
      expectedOwnerEpoch: null,
    });
    const reader = registry.readerForNativeIdentity(identity(f.agent.id));
    primeWork = (async () => {
      for await (const event of f.manager.streamAgent(f.agent.id, "human prime foreground"))
        void event;
    })();
    orchWork = (async () => {
      for await (const event of f.manager.streamAgent(
        orchestrator.id,
        "human orchestrator foreground",
      ))
        void event;
    })();
    await f.manager.waitForAgentRunStart(f.agent.id);
    await f.manager.waitForAgentRunStart(orchestrator.id);
    const humanAt = f.authority.requireSequence(f.agent.id).humanAt;
    const ledger = Reflect.get(f.manager, "nativeReceipts");
    expect(await ledger.reportInbox(reader)).toMatchObject({ events: [] });
    for (const kind of ["needs-you", "blocked", "usage-limit", "handoff"] as const)
      for (const batch of registry.captureLifecycleReports(
        identity(worker.id),
        kind,
        randomUUID(),
        Date.now(),
      ))
        await Reflect.get(f.manager, "collectNativeReport").call(f.manager, batch);
    await vi.waitFor(
      async () => {
        expect(await ledger.reportInbox(reader)).toMatchObject({
          metadataCount: 4,
          wakePendingCount: 1,
        });
        expect(
          await ledger.reportInbox(registry.readerForNativeIdentity(identity(orchestrator.id))),
        ).toMatchObject({ metadataCount: 4, wakePendingCount: 1 });
      },
      { timeout: 6000 },
    );
    expect(
      await ledger.reportInbox(registry.readerForNativeIdentity(identity(peer.id))),
    ).toMatchObject({ events: [] });
    const before = f.turnCount();
    f.server.completeTurn({ threadId: identity(f.agent.id).sessionId });
    await primeWork;
    await vi.waitFor(async () =>
      expect(await ledger.reportInbox(reader)).toMatchObject({
        wakePendingCount: 0,
        events: [
          { providerAccepted: true, routing: "owning-prime-rollup" },
          { providerAccepted: true },
          { providerAccepted: true },
          { providerAccepted: true },
        ],
      }),
    );
    expect(f.turnCount()).toBe(before + 1);
    f.server.completeTurn({ threadId: identity(orchestrator.id).sessionId });
    await orchWork;
    await vi.waitFor(async () =>
      expect(
        await ledger.reportInbox(registry.readerForNativeIdentity(identity(orchestrator.id))),
      ).toMatchObject({
        wakePendingCount: 0,
        events: [
          { providerAccepted: true },
          { providerAccepted: true },
          { providerAccepted: true },
          { providerAccepted: true },
        ],
      }),
    );
    expect(f.turnCount()).toBe(before + 2);
    expect(f.authority.requireSequence(f.agent.id).humanAt).toBe(humanAt);
  } finally {
    owner.close();
    await f.cleanup();
  }
});
