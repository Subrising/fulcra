import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { AgentManager } from "../agent/agent-manager.js";
import { AgentStorage } from "../agent/agent-storage.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { TrustedPlugins } from "../plugins/trusted.js";
import { Controller } from "../../../../../control/src/control/controller.mjs";
import { ControlStore } from "../../../../../control/src/control/store.mjs";
import { UsageLimits } from "../../../../../control/src/control/usage-limits.mjs";
import { boundNativeInputs } from "../../../../../control/src/control/trusted-native-input.mjs";
import {
  createTrustedContribution,
  OWN_ID,
} from "../../../../../control/src/control/trusted-contribution.mjs";
import { FENCE_PROTOCOL } from "../../../../../control/src/control/native-fence.mjs";

// Schema-owning native constructors are real. No installed client transport/provider binary is opened.
vi.mock("../../../../../control/src/control/client-sdk.mjs", () => ({
  DaemonClient: function RefusedTransport() {
    throw Error("no external transport");
  },
  DaemonRpcError: class extends Error {},
  createPaseoApi: () => {
    throw Error("no external transport");
  },
}));

async function fixture(terminalFailure = false) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), "owner-limit-route-")));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(home, "agents"), logger);
  await storage.initialize();
  let store = new ControlStore(path.join(home, "journal.sqlite"));
  const host = new TrustedPlugins();
  host.initializeKnownAgents([]);
  let issue!: Parameters<Parameters<TrustedPlugins["registerV11"]>[2]>[0]["issueProvenance"];
  host.registerV11(OWN_ID, true, (hooks) => {
    issue = hooks.issueProvenance;
    return createTrustedContribution({ home })(hooks);
  });
  const nativeId = randomUUID();
  const resetSeconds = Math.floor(Date.now() / 1000) + 600;
  const inputs: SDKUserMessage[] = [];
  let limited = false;
  const queryFactory = ({ prompt }: { prompt: AsyncIterable<SDKUserMessage> }) => {
    const iterator = (async function* () {
      yield {
        type: "system",
        subtype: "init",
        session_id: nativeId,
        permissionMode: "bypassPermissions",
      } as SDKMessage;
      for await (const input of prompt) {
        inputs.push(input);
        const text = limited ? `Claude AI usage limit reached|${resetSeconds}` : "fixture response";
        yield {
          type: "assistant",
          uuid: randomUUID(),
          session_id: nativeId,
          message: {
            id: randomUUID(),
            role: "assistant",
            content: [{ type: "text", text }],
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        } as SDKMessage;
        yield {
          type: "result",
          subtype: limited && terminalFailure ? "error_during_execution" : "success",
          errors: limited ? [text] : undefined,
          result: text,
          is_error: limited && terminalFailure,
          usage: { input_tokens: 0, output_tokens: 0 },
          modelUsage: {},
          permission_denials: [],
          uuid: randomUUID(),
          session_id: nativeId,
          duration_ms: 0,
          duration_api_ms: 0,
          num_turns: 1,
          total_cost_usd: 0,
        } as unknown as SDKMessage;
      }
    })();
    return Object.assign(iterator, {
      close: () => {},
      interrupt: async () => {},
      setModel: async () => {},
      setPermissionMode: async () => {},
      applyFlagSettings: async () => {},
      getContextUsage: async () => undefined,
      supportedModels: async () => [],
      supportedCommands: async () => [],
    });
  };
  const sdk = new ClaudeAgentClient({
    logger,
    queryFactory: queryFactory as never,
    resolveBinary: async () => "/disposable-fixture/provider",
    resolveVersion: async () => "fixture",
    modelProbe: async () => {
      throw Error("probes forbidden");
    },
  });
  const client = createTestAgentClient("claude");
  client.createSession = (config, launch) =>
    sdk.createSession(config, {
      ...launch,
      env: { FULCRA_ACCOUNT_ID: "fixture-selected-account" },
    });
  const manager = new AgentManager({
    clients: { claude: client },
    registry: storage,
    trustedPlugins: host,
    logger,
  });
  const agent = await manager.createAgent(
    { provider: "claude", cwd: home, model: "fixture-model", modeId: "bypassPermissions" },
    undefined,
    {},
  );
  const task = randomUUID();
  store.created(agent.id, task, home);
  const inspect = async () => {
    const live = manager.getAgent(agent.id)!;
    const sequence = host.requireSequence(agent.id);
    const users = manager.getTimeline(agent.id).filter((item) => item.type === "user_message");
    const last = users.at(-1);
    const raw =
      last?.type === "user_message" ? (last.clientMessageId ?? last.messageId ?? null) : null;
    return {
      boot: sequence.boot,
      fenceProtocol: FENCE_PROTOCOL,
      saturated: false,
      humanAt: sequence.humanAt,
      status: manager.hasInFlightRun(agent.id) ? "running" : "idle",
      pending: live.pendingPermissions.size,
      nativeId: live.persistence?.sessionId,
      runtimeInstanceId: live.instanceId,
      model: live.config.model,
      lastPromptId: raw?.startsWith("orca-control:") ? raw.slice("orca-control:".length) : raw,
      promptClaimsControl: Boolean(raw?.startsWith("orca-control:")),
      lastUserAt: live.lastUserMessageAt?.toISOString() ?? null,
      archivedAt: live.archivedAt ?? null,
    };
  };
  const native = boundNativeInputs({
    verifyActivation: () => {},
    issueProvenance: (args: Parameters<typeof issue>[0]) => issue(args),
    daemon: {
      invokeRawInput: async (message: {
        agentId: string;
        text: string;
        messageId: string;
        inputProvenance: string;
      }) => {
        await host.rpc(message.inputProvenance, () =>
          sendPromptToAgent({
            agentManager: manager,
            agentStorage: storage,
            logger,
            agentId: message.agentId,
            prompt: message.text,
            messageId: message.messageId,
            clearPendingPermissions: true,
            activeTurnBehavior: "interrupt",
          }),
        );
        await manager.waitForFailedRunSettlement(agent.id);
        return { accepted: true };
      },
    },
  });
  const limitTail = async () => {
    await manager.waitForFailedRunSettlement(agent.id);
    const live = manager.getAgent(agent.id)!;
    const page = manager.fetchTimeline(agent.id, { limit: 4 });
    return {
      provider: live.provider,
      status: manager.hasInFlightRun(agent.id) ? "running" : "idle",
      updatedAt: live.updatedAt.toISOString(),
      lastUserMessageAt: live.lastUserMessageAt?.toISOString() ?? null,
      entries: page.rows,
      maxSeq: page.window?.maxSeq,
    };
  };
  let now = Date.now();
  const notices: unknown[] = [];
  const makeControl = () => {
    const control = new Controller({
      store,
      native: { inspect, send: native.send, limitTail },
      authority: async () => ({ delegationAuthority: [task] }),
    });
    control.poolRoot = home; // Only this disposable account root; never installation/global account storage.
    control.limitNotifier = async (notice: unknown) => {
      notices.push(notice);
    };
    control.usageLimits = new UsageLimits(control, { now: () => now, random: () => 0 });
    return control;
  };
  let control = makeControl();
  const humanTurn = async () => {
    await host.rpc(undefined, () => manager.runAgent(agent.id, "fixture human task"));
  };
  await humanTurn(); // Real SDK init/native identity before legitimate owner handback.
  return {
    home,
    agent,
    manager,
    host,
    inputs,
    notices,
    inspect,
    get store() {
      return store;
    },
    get control() {
      return control;
    },
    humanTurn,
    limitTail,
    limit: () => {
      limited = true;
    },
    unlimit: () => {
      limited = false;
    },
    due: () => {
      now = resetSeconds * 1000 + 30001;
    },
    restartController() {
      store.close();
      store = new ControlStore(path.join(home, "journal.sqlite"));
      control = makeControl();
    },
    cleanup: async () => {
      await host.shutdownClosure(() => manager.closeAgent(agent.id));
      await manager.flush();
      host.close();
      store.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test.each([false, true])(
  "existing owner route: synthetic CLI limit stop/real SQLite/native contribution resumes once; controller restart=%s",
  async (restart) => {
    const f = await fixture();
    try {
      await f.control.handback(f.agent.id, "fixture operator authorized existing task");
      f.limit();
      const original = randomUUID();
      expect(
        (
          await f.control.send(
            { sessionId: f.agent.id, messageId: original, text: "fixture delegated task" },
            undefined,
            f.store.get(f.agent.id).generation,
          )
        ).state,
      ).toBe("delivered");
      await vi.waitFor(() => expect(f.manager.hasInFlightRun(f.agent.id)).toBe(false));
      const stop = await f.control.usageLimits.observe(f.agent.id);
      expect(
        stop,
        JSON.stringify({ tail: await f.limitTail(), error: f.control.usageLimits.lastError }),
      ).toMatchObject({
        state: "waiting",
        lastInstruction: original,
        mode: "delegated",
      });
      expect(stop.turnId).toBeTruthy();
      expect(stop.seq).toBeGreaterThan(0);
      // Honest gap: the existing owner journal captures turn/generation, not original model/account/intent.
      expect(Object.keys(stop)).not.toContain("binding");
      await f.control.usageLimits.tick();
      expect(f.inputs).toHaveLength(2);
      if (restart) f.restartController();
      f.unlimit();
      f.due();
      await f.control.usageLimits.tick();
      await vi.waitFor(() => expect(f.inputs).toHaveLength(3));
      const resumed = f.control.usageLimits.row(stop.id);
      expect(resumed.state).toBe("resumed");
      expect(f.store.delivery(resumed.continuation).state).toBe("delivered");
      const prior = f.store.delivery(resumed.continuation);
      f.restartController();
      expect(
        (
          await f.control.send(
            JSON.parse(prior.body),
            undefined,
            f.store.get(f.agent.id).generation,
          )
        ).state,
      ).toBe("delivered");
      expect(f.inputs).toHaveLength(3); // Actual controller receipt retry, not only the stop's terminal-state check.
      await f.control.usageLimits.tick();
      expect(f.inputs).toHaveLength(3);
      // Interrupted delivery receipt before stop bookkeeping: retry returns journaled delivery, no native replay.
      f.store.db.prepare("UPDATE usage_limit_stops SET state='waiting' WHERE id=?").run(stop.id);
      f.restartController();
      await f.control.usageLimits.tick();
      expect(f.inputs).toHaveLength(3);
    } finally {
      await f.cleanup();
    }
  },
);

test.each(["human", "takeover", "model-configure", "revoked-generation"] as const)(
  "existing owner route: %s has no automatic provider input",
  async (kind) => {
    const f = await fixture();
    try {
      if (kind !== "human")
        await f.control.handback(f.agent.id, "fixture operator authorized existing task");
      f.limit();
      if (kind === "human") await f.humanTurn();
      else
        await f.control.send(
          { sessionId: f.agent.id, messageId: randomUUID(), text: "fixture task" },
          undefined,
          f.store.get(f.agent.id).generation,
        );
      await vi.waitFor(() => expect(f.manager.hasInFlightRun(f.agent.id)).toBe(false));
      const stop = await f.control.usageLimits.observe(f.agent.id);
      expect(
        stop,
        JSON.stringify({ tail: await f.limitTail(), error: f.control.usageLimits.lastError }),
      ).toBeTruthy();
      if (kind === "takeover") f.control.takeover(f.agent.id, "fixture human took over");
      if (kind === "model-configure")
        await f.host.rpc(undefined, () => f.manager.setAgentModel(f.agent.id, "fixture-model-B"));
      if (kind === "revoked-generation") {
        f.control.takeover(f.agent.id, "fixture original delegation revoked");
        await f.control.handback(f.agent.id, "new task authorization");
      }
      f.restartController();
      f.due();
      await f.control.usageLimits.tick();
      expect(f.inputs).toHaveLength(2);
      expect(["notified", "superseded"]).toContain(f.control.usageLimits.row(stop.id).state);
    } finally {
      await f.cleanup();
    }
  },
);

test("existing owner route gap: real failed SDK stop ends with host System Error and is not detected or replayed", async () => {
  const f = await fixture(true);
  try {
    await f.control.handback(f.agent.id, "fixture operator authorized original task");
    f.limit();
    const original = randomUUID();
    await f.control.send(
      { sessionId: f.agent.id, messageId: original, text: "fixture original task" },
      undefined,
      f.store.get(f.agent.id).generation,
    );
    await vi.waitFor(() => expect(f.manager.hasInFlightRun(f.agent.id)).toBe(false));
    const tail = await f.limitTail();
    expect(tail.entries.at(-1)?.item).toMatchObject({
      type: "assistant_message",
      text: expect.stringMatching(/^\[System Error\] Claude AI usage limit reached\|/),
    });
    expect(await f.control.usageLimits.observe(f.agent.id)).toBeNull();
    expect(f.store.db.prepare("SELECT count(*) n FROM usage_limit_stops").get().n).toBe(0);
    f.restartController();
    f.due();
    await f.control.usageLimits.tick();
    expect(f.inputs).toHaveLength(2);
    expect(f.store.delivery(original).state).toBe("delivered");
  } finally {
    await f.cleanup();
  }
});

test("existing owner route: unknown native tail refuses automatic send while retaining waiting evidence", async () => {
  const f = await fixture();
  try {
    await f.control.handback(f.agent.id, "fixture operator authorized original task");
    f.limit();
    await f.control.send(
      { sessionId: f.agent.id, messageId: randomUUID(), text: "fixture task" },
      undefined,
      f.store.get(f.agent.id).generation,
    );
    await vi.waitFor(() => expect(f.manager.hasInFlightRun(f.agent.id)).toBe(false));
    const stop = await f.control.usageLimits.observe(f.agent.id);
    expect(stop.state).toBe("waiting");
    f.control.native.limitTail = async () => {
      throw Error("incomplete native timeline fixture");
    };
    f.due();
    await f.control.usageLimits.tick();
    expect(f.inputs).toHaveLength(2);
    expect(f.control.usageLimits.row(stop.id).state).toBe("waiting");
    expect(f.control.usageLimits.lastError.message).toBe("incomplete native timeline fixture");
  } finally {
    await f.cleanup();
  }
});

test("existing owner route: native input followed by journal acknowledgment failure remains uncertain and never replays", async () => {
  const f = await fixture();
  let receiptFailure: ReturnType<typeof vi.spyOn> | undefined;
  try {
    await f.control.handback(f.agent.id, "fixture operator authorized original task");
    f.limit();
    const original = randomUUID();
    await f.control.send(
      { sessionId: f.agent.id, messageId: original, text: "fixture task" },
      undefined,
      f.store.get(f.agent.id).generation,
    );
    await vi.waitFor(() => expect(f.manager.hasInFlightRun(f.agent.id)).toBe(false));
    const stop = await f.control.usageLimits.observe(f.agent.id);
    const finish = f.store.finish.bind(f.store);
    let failOnce = true;
    receiptFailure = vi.spyOn(f.store, "finish").mockImplementation((id, state, result) => {
      if (state === "delivered" && id !== original && failOnce) {
        failOnce = false;
        throw Error("disposable journal acknowledgment failure");
      }
      return finish(id, state, result);
    });
    f.unlimit();
    f.due();
    await f.control.usageLimits.tick();
    await vi.waitFor(() => expect(f.inputs).toHaveLength(3));
    const stopped = f.control.usageLimits.row(stop.id);
    expect(stopped.state).toBe("uncertain");
    const prior = f.store.delivery(stopped.continuation);
    expect(prior.state).toBe("uncertain");
    receiptFailure.mockRestore();
    receiptFailure = undefined;
    f.restartController();
    await f.control.usageLimits.tick();
    expect(
      (await f.control.send(JSON.parse(prior.body), undefined, f.store.get(f.agent.id).generation))
        .state,
    ).toBe("uncertain");
    expect(f.inputs).toHaveLength(3);
  } finally {
    receiptFailure?.mockRestore();
    await f.cleanup();
  }
});
