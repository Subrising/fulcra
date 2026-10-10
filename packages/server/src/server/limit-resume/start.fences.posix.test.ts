import { mkdtemp, readFile, rm, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { MutableDaemonConfigSchema } from "@getpaseo/protocol/messages";
import { AgentManager } from "../agent/agent-manager.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { CodexAppServerAgentSession } from "../agent/providers/codex-app-server-agent.js";
import { createFakeCodexAppServer } from "../agent/providers/codex/test-utils/fake-app-server.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { DaemonConfigStore } from "../daemon-config-store.js";
import { TrustedPlugins } from "../plugins/trusted.js";
import { startLimitResume } from "./start.js";
import {
  INTERRUPTED_RESUME_PROMPT,
  LIMIT_RESUME_AT_LABEL,
  LIMIT_RESUME_OPT_OUT_LABEL,
  limitResumeFilePath,
} from "./service.js";
import { ControlStore } from "../../../../../control/src/control/store.mjs";
import {
  createTrustedContribution,
  OWN_ID,
  payloadDigest,
  sendPayload,
} from "../../../../../control/src/control/trusted-contribution.mjs";
import { randomUUID } from "node:crypto";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((yes) => (resolve = yes));
  return { promise, resolve };
}
async function fixture() {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "limit-native-fence-")));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(home, "agents"), logger);
  await storage.initialize();
  const host = new TrustedPlugins();
  host.initializeKnownAgents([]);
  let ordinal = 0;
  const servers: ReturnType<typeof createFakeCodexAppServer>[] = [];
  const makeServer = () => {
    const value = createFakeCodexAppServer({
      "thread/start": () => ({
        thread: { id: "limit-thread" },
        modelProvider: "openai",
        model: "gpt-6.1-sol",
      }),
      "thread/resume": (params) => ({
        thread: { id: "limit-thread" },
        modelProvider: "openai",
        model: (params as { model?: string }).model ?? "gpt-6.1-sol",
      }),
      "thread/loaded/list": () => ({ data: ["limit-thread"] }),
      "turn/start": () => ({ turn: { id: `limit-turn-${++ordinal}` } }),
      "account/rateLimits/read": () => ({
        accountId: "fixture-account",
        ordinaryUsageAllowed: true,
        rateLimits: {},
      }),
    });
    servers.push(value);
    return value;
  };
  let server = makeServer();
  let session!: CodexAppServerAgentSession;
  const accountEnv = { FULCRA_ACCOUNT_ID: "fixture-account-A" };
  const client = createTestAgentClient("codex");
  client.createSession = async (config) => {
    session = new CodexAppServerAgentSession(
      config,
      null,
      logger,
      async () => server.child,
      {},
      false,
      false,
      false,
      undefined,
      "interactive",
      null,
      accountEnv,
    );
    await session.connect();
    return session;
  };
  client.resumeSession = async (handle, overrides) => {
    server = makeServer();
    session = new CodexAppServerAgentSession(
      { provider: "codex", cwd: home, ...overrides },
      handle,
      logger,
      async () => server.child,
      {},
      false,
      false,
      false,
      undefined,
      "interactive",
      null,
      accountEnv,
    );
    await session.connect();
    return session;
  };
  const manager = new AgentManager({
    registry: storage,
    logger,
    trustedPlugins: host,
    clients: { codex: client },
  });
  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: home,
      modeId: "full-access",
      model: "gpt-6.1-sol",
      thinkingOptionId: "high",
    },
    undefined,
    {},
  );
  const config = new DaemonConfigStore(
    home,
    MutableDaemonConfigSchema.parse({ mcp: { injectIntoAgents: false }, autoResumeOnLimit: true }),
    logger,
  );
  return {
    home,
    logger,
    storage,
    host,
    get server() {
      return server;
    },
    turnStarts: () =>
      servers
        .flatMap((item) => item.requests())
        .filter((request) => request.method === "turn/start"),
    manager,
    client,
    agent,
    get session() {
      return session;
    },
    accountEnv,
    config,
    start: () =>
      startLimitResume({
        paseoHome: home,
        agentManager: manager,
        agentStorage: storage,
        daemonConfigStore: config,
        logger,
      }),
    cleanup: async () => {
      await host.shutdownClosure(() => manager.closeAgent(agent.id));
      await manager.flush();
      host.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
async function queueActualLimit(f: Awaited<ReturnType<typeof fixture>>) {
  const marked = deferred();
  const off = f.manager.subscribe(
    (event) => {
      if (
        event.type === "agent_state" &&
        event.agent.id === f.agent.id &&
        event.agent.labels[LIMIT_RESUME_AT_LABEL]
      )
        marked.resolve();
    },
    { replayState: false },
  );
  const run = f.manager.runAgent(f.agent.id, "limited task");
  const failed = expect(run).rejects.toThrow("usage limit reached");
  await f.server.waitForTurnStart();
  f.server.completeTurn({
    threadId: "limit-thread",
    status: "failed",
    error: { message: "usage limit reached" },
  });
  await failed;
  await marked.promise;
  off();
}
async function makeDue(home: string) {
  const file = limitResumeFilePath(home);
  const data = JSON.parse(await readFile(file, "utf8"));
  expect(data.entries).toHaveLength(1);
  data.entries[0].resumeAt = Date.now() - 1;
  await writeFile(file, JSON.stringify(data));
}

test.each(["disable", "opt-out", "stop"])(
  "real native provider preparation observes %s without consuming/sending",
  async (kind) => {
    const f = await fixture();
    let service = f.start();
    const entered = deferred(),
      release = deferred(),
      refused = deferred();
    let off = () => {};
    try {
      await queueActualLimit(f);
      service.stop();
      await makeDue(f.home);
      const original = Reflect.get(f.session, "buildTurnStartParams").bind(f.session);
      const spy = vi
        .spyOn(f.session as never, "buildTurnStartParams" as never)
        .mockImplementation(async (...args: unknown[]) => {
          entered.resolve();
          await release.promise;
          return original(...args);
        });
      off = f.manager.subscribe(
        (event) => {
          if (
            event.type === "agent_stream" &&
            event.agentId === f.agent.id &&
            event.event.type === "turn_failed"
          )
            refused.resolve();
        },
        { replayState: false },
      );
      service = f.start();
      await entered.promise;
      expect(JSON.parse(await readFile(limitResumeFilePath(f.home), "utf8")).entries).toHaveLength(
        1,
      );
      if (kind === "disable") f.config.patch({ autoResumeOnLimit: false });
      if (kind === "opt-out")
        await f.manager.setLabels(f.agent.id, { [LIMIT_RESUME_OPT_OUT_LABEL]: "off" });
      if (kind === "stop") service.stop();
      release.resolve();
      await refused.promise;
      expect(f.server.requests().filter((request) => request.method === "turn/start")).toHaveLength(
        1,
      );
      if (kind === "stop")
        expect(
          JSON.parse(await readFile(limitResumeFilePath(f.home), "utf8")).entries,
        ).toHaveLength(1);
      spy.mockRestore();
    } finally {
      release.resolve();
      off();
      service.stop();
      await f.cleanup();
    }
  },
  15_000,
);

test("native continuation checks can repeat, consumes once at actual write and survives restart without replay", async () => {
  const f = await fixture();
  let service = f.start();
  try {
    await queueActualLimit(f);
    service.stop();
    await makeDue(f.home);
    const accepted = deferred();
    const original = Reflect.get(f.session, "buildTurnStartParams").bind(f.session);
    const entered = deferred(),
      release = deferred();
    const spy = vi
      .spyOn(f.session as never, "buildTurnStartParams" as never)
      .mockImplementation(async (...args: unknown[]) => {
        entered.resolve();
        await release.promise;
        return original(...args);
      });
    const off = f.manager.subscribe(
      (event) => {
        if (
          event.type === "agent_stream" &&
          event.agentId === f.agent.id &&
          event.event.type === "turn_started"
        )
          accepted.resolve();
      },
      { replayState: false },
    );
    service = f.start();
    await entered.promise;
    expect(JSON.parse(await readFile(limitResumeFilePath(f.home), "utf8")).entries).toHaveLength(1);
    release.resolve();
    await accepted.promise;
    off();
    expect(f.server.requests().filter((request) => request.method === "turn/start")).toHaveLength(
      2,
    );
    expect(JSON.parse(await readFile(limitResumeFilePath(f.home), "utf8")).entries).toEqual([]);
    f.server.completeTurn({ threadId: "limit-thread" });
    await f.manager.waitForAgentEvent(f.agent.id);
    spy.mockRestore();
    service.stop();
    service = f.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(f.server.requests().filter((request) => request.method === "turn/start")).toHaveLength(
      2,
    );
  } finally {
    service.stop();
    await f.cleanup();
  }
}, 15_000);

test("actual controller journal survives status marker; human takeover without a turn refuses fallback", async () => {
  const f = await fixture();
  const store = new ControlStore(path.join(f.home, "journal.sqlite"));
  let issueProvenance!: Parameters<
    Parameters<TrustedPlugins["registerV11"]>[2]
  >[0]["issueProvenance"];
  f.host.registerV11(OWN_ID, true, (server) => {
    issueProvenance = server.issueProvenance;
    createTrustedContribution({ home: f.home })(server);
  });
  store.created(f.agent.id, randomUUID(), f.home);
  store.db
    .prepare("UPDATE sessions SET mode='delegated',boot=?,grantedAt=1 WHERE id=?")
    .run(f.host.boot, f.agent.id);
  const message = randomUUID(),
    attempt = randomUUID(),
    prompt = "limited task";
  const result = {
    generation: store.get(f.agent.id).generation,
    nativeAttemptId: attempt,
    expectedLastUserAt: null,
  };
  store.db
    .prepare("INSERT INTO deliveries VALUES (?,?,'send',?,'intent',?)")
    .run(
      message,
      f.agent.id,
      JSON.stringify({ sessionId: f.agent.id, messageId: message, text: prompt }),
      JSON.stringify(result),
    );
  const observe = () => ({
    nativeMode: f.manager.getAgent(f.agent.id)?.currentModeId,
    nativeSession: f.manager.getAgent(f.agent.id)?.persistence?.sessionId,
    session: store.db
      .prepare("SELECT mode,generation,token,expected FROM sessions WHERE id=?")
      .get(f.agent.id),
    delivery: store.db.prepare("SELECT state,result FROM deliveries WHERE id=?").get(message),
  });
  const markerSeen = deferred();
  const writeMarker = f.manager.updateLimitResumeMarker.bind(f.manager);
  let before: unknown, after: unknown;
  const spy = vi.spyOn(f.manager, "updateLimitResumeMarker").mockImplementation(async (id, at) => {
    before = observe();
    await writeMarker(id, at);
    after = observe();
    markerSeen.resolve();
  });
  let service = f.start();
  try {
    const token = issueProvenance({
      agentId: f.agent.id,
      kind: "prompt",
      messageId: "orca-control:" + message,
      attemptId: attempt,
      payloadDigest: payloadDigest(
        f.agent.id,
        "prompt",
        "orca-control:" + message,
        sendPayload(prompt),
      ),
    });
    await f.host.rpc(token, () =>
      sendPromptToAgent({
        agentManager: f.manager,
        agentStorage: f.storage,
        agentId: f.agent.id,
        logger: f.logger,
        prompt,
        messageId: "orca-control:" + message,
        clearPendingPermissions: true,
        activeTurnBehavior: "interrupt",
      }),
    );
    await f.server.waitForTurnStart();
    f.server.completeTurn({
      threadId: "limit-thread",
      status: "failed",
      error: { message: "usage limit reached" },
    });
    await f.manager.waitForAgentEvent(f.agent.id);
    await service.onAgentEvent({
      type: "agent_stream",
      agentId: f.agent.id,
      event: { type: "turn_failed", error: "usage limit reached" },
    });
    expect(service.pendingResumeAt(f.agent.id)).toBeNull();
    expect(f.manager.getAgent(f.agent.id)?.labels[LIMIT_RESUME_AT_LABEL]).toBeFalsy();
    await f.manager.updateLimitResumeMarker(f.agent.id, null);
    await markerSeen.promise;
    expect(after).toEqual(before);
    expect(store.get(f.agent.id).mode).toBe("delegated");
    service.stop();
    await f.host.rpc(undefined, () =>
      f.manager.updateAgentMetadata(f.agent.id, { title: "Human takeover" }),
    );
    expect(store.get(f.agent.id).mode).toBe("human");
    const takenOver = observe();
    service = f.start();
    await service.onAgentEvent({
      type: "agent_stream",
      agentId: f.agent.id,
      event: { type: "turn_failed", error: "usage limit reached" },
    });
    expect(service.pendingResumeAt(f.agent.id)).toBeNull();
    expect(f.server.requests().filter((request) => request.method === "turn/start")).toHaveLength(
      1,
    );
    expect(observe()).toEqual(takenOver);
    expect(f.manager.getAgent(f.agent.id)?.persistence?.sessionId).toBe("limit-thread");
  } finally {
    spy.mockRestore();
    service.stop();
    await f.cleanup();
    store.close();
  }
}, 15_000);

test.each([false, true])(
  "original model A stop refuses model B without a turn, service/agent restart=%s",
  async (restart) => {
    const f = await fixture();
    let service = f.start();
    try {
      await queueActualLimit(f);
      service.stop();
      const original = JSON.parse(await readFile(limitResumeFilePath(f.home), "utf8")).entries[0]
        .binding;
      await f.manager.setAgentModel(f.agent.id, "fixture-model-B");
      expect(f.manager.getLimitResumeBinding(f.agent.id)).not.toBe(original);
      if (restart) await f.host.shutdownClosure(() => f.manager.closeAgent(f.agent.id));
      await makeDue(f.home);
      const cleared = deferred();
      const off = f.manager.subscribe(
        (event) => {
          if (
            event.type === "agent_state" &&
            event.agent.id === f.agent.id &&
            event.agent.labels[LIMIT_RESUME_AT_LABEL] === ""
          )
            cleared.resolve();
        },
        { replayState: false },
      );
      service = f.start();
      await cleared.promise;
      off();
      expect(f.turnStarts()).toHaveLength(1);
      expect(service.pendingResumeAt(f.agent.id)).toBeNull();
    } finally {
      service.stop();
      await f.cleanup();
    }
  },
  15_000,
);

test.each(["thinking", "mode", "intent", "account", "account-unknown", "account-notification"])(
  "original stop refuses observable %s change before due",
  async (kind) => {
    const f = await fixture();
    let service = f.start();
    try {
      await queueActualLimit(f);
      service.stop();
      if (kind === "thinking") await f.manager.setAgentThinkingOption(f.agent.id, "low");
      if (kind === "mode") await f.manager.setAgentMode(f.agent.id, "read-only");
      if (kind === "intent") f.manager.setAppendSystemPrompt("different instructions");
      if (kind === "account") f.accountEnv.FULCRA_ACCOUNT_ID = "fixture-account-B";
      if (kind === "account-unknown") f.accountEnv.FULCRA_ACCOUNT_ID = "";
      if (kind === "account-notification") {
        f.server.child.stdout.write(
          JSON.stringify({ method: "account/updated", params: {} }) + "\n",
        );
        await Promise.resolve();
        expect(f.session.limitResumeAccountBinding()).toBeNull();
      }
      await makeDue(f.home);
      const cleared = deferred();
      const off = f.manager.subscribe(
        (event) => {
          if (
            event.type === "agent_state" &&
            event.agent.id === f.agent.id &&
            event.agent.labels[LIMIT_RESUME_AT_LABEL] === ""
          )
            cleared.resolve();
        },
        { replayState: false },
      );
      service = f.start();
      await cleared.promise;
      off();
      expect(f.turnStarts()).toHaveLength(1);
    } finally {
      service.stop();
      await f.cleanup();
    }
  },
  15_000,
);

test("unchanged original stop binding survives provider rehydrate and consumes once", async () => {
  const f = await fixture();
  let service = f.start();
  try {
    await queueActualLimit(f);
    service.stop();
    const captured = JSON.parse(await readFile(limitResumeFilePath(f.home), "utf8")).entries[0]
      .binding;
    await f.host.shutdownClosure(() => f.manager.closeAgent(f.agent.id));
    await makeDue(f.home);
    const accepted = deferred();
    const off = f.manager.subscribe(
      (event) => {
        if (
          event.type === "agent_stream" &&
          event.agentId === f.agent.id &&
          event.event.type === "turn_started"
        )
          accepted.resolve();
      },
      { replayState: false },
    );
    service = f.start();
    await accepted.promise;
    off();
    expect(f.turnStarts()).toHaveLength(2);
    const queue = JSON.parse(await readFile(limitResumeFilePath(f.home), "utf8"));
    expect(queue.entries).toEqual([]);
    expect(captured).toMatch(/^v1:[a-f0-9]{64}$/);
    f.server.completeTurn({ threadId: "limit-thread" });
    await f.manager.waitForAgentEvent(f.agent.id);
    service.stop();
    service = f.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.turnStarts()).toHaveLength(2);
  } finally {
    service.stop();
    await f.cleanup();
  }
}, 15_000);

test("native-owned ineligible stop has no advertised automatic schedule", async () => {
  const f = await fixture();
  const service = f.start();
  try {
    // Host-native owner metadata, not a label or a fabricated controller capability.
    Reflect.get(f.manager, "agents").get(f.agent.id).owner = {
      kind: "daemon",
      daemonId: "fixture-owner",
      executionId: "fixture-execution",
    };
    await service.onAgentEvent({
      type: "agent_stream",
      agentId: f.agent.id,
      event: { type: "turn_failed", error: "usage limit reached" },
    });
    expect(service.pendingResumeAt(f.agent.id)).toBeNull();
    expect(f.manager.getAgent(f.agent.id)?.labels[LIMIT_RESUME_AT_LABEL]).toBeFalsy();
    expect(f.turnStarts()).toHaveLength(0);
  } finally {
    service.stop();
    await f.cleanup();
  }
});

test.each(["standalone", "delegated", "no-answer"] as const)(
  "a restart mid-turn resumes only sessions no trusted input authority claims: %s",
  async (kind) => {
    const f = await fixture();
    const store = new ControlStore(path.join(f.home, "journal.sqlite"));
    if (kind === "no-answer")
      f.host.registerV11("fixture-input-authority", true, (server) =>
        server.admission.onInput(() => "allow"),
      );
    else
      f.host.registerV11(OWN_ID, true, (server) =>
        createTrustedContribution({ home: f.home })(server),
      );
    const readQueue = async () => JSON.parse(await readFile(limitResumeFilePath(f.home), "utf8"));
    let service = f.start();
    try {
      const run = f.manager.runAgent(f.agent.id, "long task").catch(() => undefined);
      await f.server.waitForTurnStart();
      await vi.waitFor(async () => expect((await readQueue()).running[f.agent.id]).toBeTruthy());
      // The daemon stops in the middle of the turn; the next boot finds the turn cut off.
      service.stop();
      if (kind === "delegated") {
        store.created(f.agent.id, randomUUID(), f.home);
        store.db
          .prepare("UPDATE sessions SET mode='delegated',boot=?,grantedAt=1 WHERE id=?")
          .run(f.host.boot, f.agent.id);
      }
      f.server.completeTurn({ threadId: "limit-thread", status: "interrupted" });
      await run;
      await new Promise((resolve) => setTimeout(resolve, 5));
      service = f.start();
      await service.enqueueInterrupted(randomUUID());
      const queued = (await readQueue()).entries;
      if (kind !== "standalone") {
        expect(queued).toEqual([]);
        expect(f.manager.getAgent(f.agent.id)?.labels[LIMIT_RESUME_AT_LABEL]).toBeFalsy();
        expect(f.turnStarts()).toHaveLength(1);
        return;
      }
      expect(queued).toHaveLength(1);
      expect(queued[0].source).toBe("interrupted");
      await makeDue(f.home);
      service.stop();
      service = f.start();
      await vi.waitFor(() => expect(f.turnStarts()).toHaveLength(2), { timeout: 5_000 });
      expect(JSON.stringify(f.turnStarts()[1])).toContain(INTERRUPTED_RESUME_PROMPT.slice(0, 40));
    } finally {
      service.stop();
      await f.cleanup();
      store.close();
    }
  },
  15_000,
);

test.each(["standalone", "delegated", "no-answer", "setting off"] as const)(
  "a cold boot after a restart mid-turn queues the session and checks the owner when it loads: %s",
  async (kind) => {
    const f = await fixture();
    const store = new ControlStore(path.join(f.home, "journal.sqlite"));
    const registerPlugin = (host: TrustedPlugins) => {
      if (kind === "no-answer")
        host.registerV11("fixture-input-authority", true, (server) =>
          server.admission.onInput(() => "allow"),
        );
      else
        host.registerV11(OWN_ID, true, (server) =>
          createTrustedContribution({ home: f.home })(server),
        );
    };
    registerPlugin(f.host);
    const readQueue = async () => JSON.parse(await readFile(limitResumeFilePath(f.home), "utf8"));
    let service = f.start();
    // The next daemon process: a new plugin host and a new AgentManager on the same storage, with no session loaded.
    const bootHost = new TrustedPlugins();
    bootHost.initializeKnownAgents([f.agent.id]);
    registerPlugin(bootHost);
    const booted = new AgentManager({
      registry: f.storage,
      logger: f.logger,
      trustedPlugins: bootHost,
      clients: { codex: f.client },
    });
    const startBooted = () =>
      startLimitResume({
        paseoHome: f.home,
        agentManager: booted,
        agentStorage: f.storage,
        daemonConfigStore: f.config,
        logger: f.logger,
      });
    const skipped = vi.spyOn(f.logger, "info");
    try {
      const run = f.manager.runAgent(f.agent.id, "long task").catch(() => undefined);
      await f.server.waitForTurnStart();
      await vi.waitFor(async () => expect((await readQueue()).running[f.agent.id]).toBeTruthy());
      service.stop();
      if (kind === "delegated") {
        store.created(f.agent.id, randomUUID(), f.home);
        store.db
          .prepare("UPDATE sessions SET mode='delegated',boot=?,grantedAt=1 WHERE id=?")
          .run(bootHost.boot, f.agent.id);
      }
      if (kind === "setting off") f.config.patch({ autoResumeOnLimit: false });
      f.server.completeTurn({ threadId: "limit-thread", status: "interrupted" });
      await run;
      await new Promise((resolve) => setTimeout(resolve, 5));
      service = startBooted();
      expect(booted.getAgent(f.agent.id)).toBeNull();
      await service.enqueueInterrupted(randomUUID());
      const queued = (await readQueue()).entries;
      if (kind === "setting off") {
        expect(queued).toEqual([]);
        expect(f.turnStarts()).toHaveLength(1);
        return;
      }
      // Ownership is not known before the session loads, so every interrupted session is queued once.
      expect(queued).toHaveLength(1);
      expect(queued[0].source).toBe("interrupted");
      expect(skipped.mock.calls.some((call) => call[1] === "Auto-resume skipped")).toBe(false);
      await makeDue(f.home);
      service.stop();
      service = startBooted();
      // Due time: the session loads and is checked; a refusal sends nothing and removes the entry. A cold Codex
      // session knows its account only after its thread loads in a turn, so its binding cannot match yet and it
      // fails closed. The Claude binding has no such part; the scratch-daemon restart test covers that resume.
      const reason = kind === "standalone" ? "binding changed" : "owned by a trusted plugin";
      await vi.waitFor(async () => expect((await readQueue()).entries).toEqual([]), {
        timeout: 5_000,
      });
      expect(
        skipped.mock.calls.some(
          (call) =>
            call[1] === "Auto-resume skipped" && (call[0] as { reason?: string }).reason === reason,
        ),
      ).toBe(true);
      expect(booted.getAgent(f.agent.id)?.labels[LIMIT_RESUME_AT_LABEL]).toBeFalsy();
      expect(f.turnStarts()).toHaveLength(1);
    } finally {
      service.stop();
      await bootHost.shutdownClosure(() => booted.closeAgent(f.agent.id)).catch(() => undefined);
      await booted.flush();
      bootHost.close();
      await f.cleanup();
      store.close();
    }
  },
  20_000,
);
