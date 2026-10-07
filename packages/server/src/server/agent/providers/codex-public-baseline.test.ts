import { expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";
import { createFakeCodexAppServer, waitForNextEvent } from "./codex/test-utils/fake-app-server.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import {
  composeHostPublicBaseline,
  type HostPublicBaseline,
  type PublicBaselineTransport,
} from "../host-public-baseline.js";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function baseline(): HostPublicBaseline {
  const files = (["common", "codex", "router"] as const).map((id) => ({
    id,
    text: `FIXTURE-${id}`,
    sha256: sha(`FIXTURE-${id}`),
  }));
  return {
    version: 1,
    files,
    digest: sha(JSON.stringify(files.map(({ id, sha256 }) => ({ id, sha256 })))),
  };
}
function fixture(loaded = false, overrides: Record<string, (params: unknown) => unknown> = {}) {
  const app = createFakeCodexAppServer({
    "thread/start": () => ({
      thread: { id: "new-thread", turns: [] },
      modelProvider: "openai",
      model: "gpt-6.1-sol",
    }),
    "thread/resume": () => ({
      thread: { id: "old-thread", turns: [] },
      modelProvider: "openai",
      model: "gpt-6.1-sol",
    }),
    "thread/loaded/list": () => ({ data: loaded ? ["old-thread"] : [] }),
    ...overrides,
  });
  const client = new CodexAppServerAgentClient(createTestLogger());
  Reflect.set(client, "goalsEnabledPromise", Promise.resolve(false));
  Reflect.set(client, "autoReviewEnabledPromise", Promise.resolve(false));
  const spawn = vi
    .spyOn(
      client as unknown as { spawnAppServer(...args: unknown[]): Promise<typeof app.child> },
      "spawnAppServer",
    )
    .mockResolvedValue(app.child);
  const config = {
    provider: "codex" as const,
    cwd: tmpdir(),
    model: "gpt-6.1-sol",
    thinkingOptionId: "high",
    modeId: "full-access",
    systemPrompt: "SESSION",
    daemonAppendSystemPrompt: "DAEMON",
    providerOptions: { approval_policy: "never", sandbox_mode: "danger-full-access" },
  };
  const launch = {
    agentId: "fixture-agent",
    env: { CODEX_HOME: "/fixture-public-profile", FULCRA_ACCOUNT_ID: "fixture-account" },
    publicBaseline: baseline(),
  };
  return { app, client, spawn, config, launch };
}
test("real client captures independent text/config/env before awaits and submits exact thread start composition", async () => {
  const f = fixture();
  let release = (_v: boolean) => {};
  Reflect.set(
    f.client,
    "goalsEnabledPromise",
    new Promise<boolean>((r) => {
      release = r;
    }),
  );
  const expected = composeHostPublicBaseline(
    f.launch.publicBaseline,
    f.config.systemPrompt,
    f.config.daemonAppendSystemPrompt,
  );
  const pending = f.client.createSession(f.config, f.launch);
  f.launch.publicBaseline.files[0].text = "caller mutated";
  f.launch.env.CODEX_HOME = "/changed";
  f.launch.env.FULCRA_ACCOUNT_ID = "changed-account";
  f.config.providerOptions.approval_policy = "on-request";
  f.config.providerOptions.sandbox_mode = "read-only";
  f.config.systemPrompt = "changed";
  release(false);
  const session = await pending;
  try {
    const info = await session.getRuntimeInfo();
    const start = f.app.requests().find((r) => r.method === "thread/start")!;
    expect((start.params as Record<string, unknown>).developerInstructions).toBe(expected.text);
    expect(start.params).toMatchObject({
      model: "gpt-6.1-sol",
      cwd: tmpdir(),
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(f.spawn.mock.calls[0][0]).toMatchObject({
      CODEX_HOME: "/fixture-public-profile",
      FULCRA_ACCOUNT_ID: "fixture-account",
    });
    expect(info.extra?.hostPublicBaselineTransport).toEqual({
      ...expected.receipt,
      state: "SUBMITTED",
    });
    const receipt = JSON.stringify(info.extra?.hostPublicBaselineTransport);
    expect(receipt).not.toContain("FIXTURE-");
    expect(receipt).not.toContain("/fixture");
    expect(receipt).not.toContain("consumed");
    (info.extra!.hostPublicBaselineTransport as PublicBaselineTransport).files[0].sha256 =
      "mutated readback";
    expect((await session.getRuntimeInfo()).extra?.hostPublicBaselineTransport).toEqual({
      ...expected.receipt,
      state: "SUBMITTED",
    });
    expect(session.describePersistence()?.metadata).not.toHaveProperty("publicBaseline");
    expect(JSON.stringify(session.describePersistence())).not.toContain("FIXTURE-common");
    expect(f.app.requests().filter((r) => r.method === "turn/start")).toHaveLength(0);
  } finally {
    await session.close();
  }
});
test.each([false, true])(
  "ordinary resume loaded=%s retains exact thread/history and never fabricates submission on loaded skip",
  async (loaded) => {
    const f = fixture(loaded),
      expected = composeHostPublicBaseline(f.launch.publicBaseline, "SESSION", "DAEMON");
    const session = await f.client.resumeSession(
      { sessionId: "old-thread", metadata: { cwd: tmpdir(), model: "gpt-6.1-sol" } },
      f.config,
      f.launch,
    );
    try {
      const resumes = f.app.requests().filter((r) => r.method === "thread/resume");
      expect(resumes).toHaveLength(loaded ? 0 : 1);
      if (!loaded)
        expect(resumes[0].params).toMatchObject({
          threadId: "old-thread",
          developerInstructions: expected.text,
        });
      expect((await session.getRuntimeInfo()).extra?.hostPublicBaselineTransport).toEqual({
        ...expected.receipt,
        state: loaded ? "INJECTED" : "SUBMITTED",
      });
      expect(
        f.app.requests().filter((r) => r.method === "thread/start" || r.method === "turn/start"),
      ).toHaveLength(0);
    } finally {
      await session.close();
    }
  },
);
test("history resume and internal helpers never transport the host baseline", async () => {
  const h = fixture();
  const historical = await h.client.resumeSession(
    { sessionId: "old-thread", metadata: { cwd: tmpdir(), model: "gpt-6.1-sol" } },
    h.config,
    h.launch,
    { purpose: "history" },
  );
  try {
    expect(h.app.requests().some((r) => JSON.stringify(r.params).includes("FIXTURE-common"))).toBe(
      false,
    );
  } finally {
    await historical.close();
  }
  const f = fixture();
  const internal = await f.client.createSession({ ...f.config, internal: true }, f.launch);
  try {
    const info = await internal.getRuntimeInfo();
    expect(info.extra?.hostPublicBaselineTransport).toBeUndefined();
    expect(f.app.requests().find((r) => r.method === "thread/start")?.params).toMatchObject({
      developerInstructions: "SESSION\n\nDAEMON",
    });
  } finally {
    await internal.close();
  }
});

test("ordinary turn composition retains baseline, while native queued preparation refuses revocation and introduces no new instructions/receipt", async () => {
  const { createNativeQueuedDispatch } = await import("../native-queued-dispatch.js");
  const { NATIVE_QUEUED_FINAL, CODEX_TURN_ADMISSION } = await import("../agent-sdk-types.js");
  const f = fixture(true);
  const session = await f.client.resumeSession(
    { sessionId: "old-thread", metadata: { cwd: tmpdir(), model: "gpt-6.1-sol" } },
    f.config,
    f.launch,
  );
  try {
    const expected = composeHostPublicBaseline(f.launch.publicBaseline, "SESSION", "DAEMON");
    const build = Reflect.get(session, "buildTurnStartParams").bind(session);
    const ordinary = await build("normal");
    expect(ordinary.params.developerInstructions).toBe(expected.text);
    const before = (await session.getRuntimeInfo()).extra?.hostPublicBaselineTransport;
    let valid = true;
    const handle = createNativeQueuedDispatch(() => {
      if (!valid) throw Error("fixture source revoked");
    });
    const queued = await build("queued", { [NATIVE_QUEUED_FINAL]: handle });
    expect(queued.params.developerInstructions).toBe("SESSION\n\nDAEMON");
    const load = Reflect.get(session, "ensureThreadLoaded").bind(session);
    await load(handle);
    expect((await session.getRuntimeInfo()).extra?.hostPublicBaselineTransport).toEqual(before);
    expect(
      f.app.requests().filter((r) => r.method === "thread/resume" || r.method === "thread/start"),
    ).toHaveLength(0);
    const count = f.app.requests().length;
    valid = false;
    await expect(load(handle)).rejects.toThrow(/revoked/);
    expect(f.app.requests()).toHaveLength(count);
    // Actual ordinary start through native admission, with a disposable resolved-account observation.
    vi.spyOn(session, "getQuota").mockResolvedValue({
      provider: "codex",
      sessionId: "old-thread",
      model: "gpt-6.1-sol",
      serviceTier: null,
      accountScope: "fixture-account",
      observedAt: new Date().toISOString(),
      ordinaryUsageAllowed: true,
      limits: [],
    });
    Reflect.set(session, "quotaModelProvider", "openai");
    await session.startTurn("normal", { [CODEX_TURN_ADMISSION]: () => true });
    const turn = f.app.requests().find((r) => r.method === "turn/start")!;
    expect(turn.params).toMatchObject({
      threadId: "old-thread",
      model: "gpt-6.1-sol",
      effort: "high",
      approvalPolicy: "never",
      developerInstructions: expected.text,
    });
    expect((await session.getRuntimeInfo()).extra?.hostPublicBaselineTransport).toEqual({
      ...expected.receipt,
      state: "SUBMITTED",
    });
  } finally {
    await session.close();
  }
});

function heldReply() {
  let release = (_value: unknown) => {},
    reject = (_error: Error) => {},
    entered = () => {};
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const response = new Promise<unknown>((r, j) => {
    release = r;
    reject = j;
  });
  return {
    started,
    release,
    reject,
    handle: () => {
      entered();
      return response;
    },
  };
}
async function rewindSameClient(
  f: ReturnType<typeof fixture>,
  session: Awaited<ReturnType<CodexAppServerAgentClient["resumeSession"]>>,
) {
  const seen = waitForNextEvent(session, "timeline");
  f.app.child.stdout.write(
    JSON.stringify({
      method: "item/started",
      params: {
        threadId: "old-thread",
        item: {
          type: "userMessage",
          id: "f20-user",
          content: [{ type: "text", text: "fixture saved context" }],
        },
      },
    }) + "\n",
  );
  await seen;
  await session.revertConversation!({ messageId: "f20-user" });
  expect(session.id).toBe("forked-thread");
}
function resolvedAccount(session: Awaited<ReturnType<CodexAppServerAgentClient["resumeSession"]>>) {
  Reflect.set(session, "quotaModelProvider", "openai");
  vi.spyOn(session, "getQuota").mockResolvedValue({
    provider: "codex",
    sessionId: "old-thread",
    model: "gpt-6.1-sol",
    serviceTier: null,
    accountScope: "fixture-account",
    observedAt: new Date().toISOString(),
    ordinaryUsageAllowed: true,
    limits: [],
  });
}
test.each(["thread/resume", "turn/start"] as const)(
  "F20 late %s acknowledgment cannot mark the public-rewound thread SUBMITTED",
  async (method) => {
    const reply = heldReply();
    let loaded = true;
    const f = fixture(true, {
      "thread/loaded/list": () => ({ data: loaded ? ["old-thread"] : [] }),
      [method]: reply.handle,
    });
    const session = await f.client.resumeSession(
      { sessionId: "old-thread", metadata: { cwd: tmpdir(), model: "gpt-6.1-sol" } },
      f.config,
      f.launch,
    );
    const events: Array<{ nativeSessionId: string; state: string }> = [];
    const off = session.subscribe((event) => {
      if (event.type === "host_public_baseline_transport")
        events.push({ nativeSessionId: event.nativeSessionId, state: event.receipt.state });
    });
    try {
      const { CODEX_TURN_ADMISSION } = await import("../agent-sdk-types.js");
      if (method === "thread/resume") loaded = false;
      else resolvedAccount(session);
      const pending =
        method === "thread/resume"
          ? Reflect.get(session, "ensureThreadLoaded").call(session)
          : session.startTurn("fixture continuation", { [CODEX_TURN_ADMISSION]: () => true });
      await reply.started;
      loaded = true;
      // Use the actual public rewind and real fake-native fork/rollback/setThreadId boundary.
      await rewindSameClient(f, session);
      reply.release(
        method === "thread/resume"
          ? {
              thread: { id: "old-thread", turns: [] },
              modelProvider: "openai",
              model: "gpt-6.1-sol",
            }
          : {},
      );
      await pending;
      expect(session.id).toBe("forked-thread");
      expect((await session.getRuntimeInfo()).extra?.hostPublicBaselineTransport).toBeUndefined();
      expect(events).toEqual([]);
      expect(f.app.requests().filter((r) => r.method === method)).toHaveLength(1);
      f.app.assertNoErrors();
    } finally {
      off();
      reply.release({});
      await session.close();
    }
  },
);
test.each(["current", "failed", "client-replaced", "closed"] as const)(
  "F20 held resume %s preserves completion guard without replay",
  async (outcome) => {
    const reply = heldReply();
    let loaded = true;
    const f = fixture(true, {
      "thread/loaded/list": () => ({ data: loaded ? ["old-thread"] : [] }),
      "thread/resume": reply.handle,
    });
    const session = await f.client.resumeSession(
      { sessionId: "old-thread", metadata: { cwd: tmpdir(), model: "gpt-6.1-sol" } },
      f.config,
      f.launch,
    );
    const events: string[] = [];
    const off = session.subscribe((event) => {
      if (event.type === "host_public_baseline_transport") events.push(event.nativeSessionId);
    });
    const originalClient = Reflect.get(session, "client");
    try {
      loaded = false;
      const pending = Reflect.get(session, "ensureThreadLoaded").call(session) as Promise<void>;
      void pending.catch(() => {});
      await reply.started;
      if (outcome === "client-replaced") Reflect.set(session, "client", {});
      if (outcome === "closed") await session.close();
      if (outcome === "failed") reply.reject(Error("fixture failed acknowledgment"));
      else
        reply.release({
          thread: { id: "old-thread", turns: [] },
          modelProvider: "openai",
          model: "gpt-6.1-sol",
        });
      await pending.catch(() => {});
      const readback = Reflect.get(session, "baselineReadback").call(session);
      if (outcome === "current") {
        expect(readback.hostPublicBaselineTransport?.state).toBe("SUBMITTED");
        expect(events).toEqual(["old-thread"]);
      } else {
        expect(readback.hostPublicBaselineTransport?.state).not.toBe("SUBMITTED");
        expect(events).toEqual([]);
      }
      expect(f.app.requests().filter((r) => r.method === "thread/resume")).toHaveLength(1);
    } finally {
      off();
      Reflect.set(session, "client", originalClient);
      reply.release({});
      await session.close();
    }
  },
);
test("F20 thread/start uses the correlated returned thread ID, not a guessed request thread", async () => {
  const f = fixture(false, {
    "thread/start": () => ({
      thread: { id: "returned-thread", turns: [] },
      modelProvider: "openai",
      model: "gpt-6.1-sol",
    }),
  });
  const session = await f.client.createSession(f.config, f.launch);
  const ids: string[] = [];
  const off = session.subscribe((event) => {
    if (event.type === "host_public_baseline_transport") ids.push(event.nativeSessionId);
  });
  try {
    const info = await session.getRuntimeInfo();
    expect(info.sessionId).toBe("returned-thread");
    expect(info.extra?.hostPublicBaselineTransport).toMatchObject({ state: "SUBMITTED" });
    expect(ids).toEqual(["returned-thread"]);
    expect(f.app.requests().find((r) => r.method === "thread/start")?.params).not.toHaveProperty(
      "threadId",
    );
  } finally {
    off();
    await session.close();
  }
});

test("F20 timed-out real resume request never upgrades or replays its receipt", async () => {
  const reply = heldReply();
  let loaded = true;
  const f = fixture(true, {
    "thread/loaded/list": () => ({ data: loaded ? ["old-thread"] : [] }),
    "thread/resume": reply.handle,
  });
  const session = await f.client.resumeSession(
    { sessionId: "old-thread", metadata: { cwd: tmpdir(), model: "gpt-6.1-sol" } },
    f.config,
    f.launch,
  );
  const ids: string[] = [];
  const off = session.subscribe((event) => {
    if (event.type === "host_public_baseline_transport") ids.push(event.nativeSessionId);
  });
  try {
    vi.useFakeTimers();
    loaded = false;
    const pending = Reflect.get(session, "ensureThreadLoaded").call(session) as Promise<void>;
    void pending.catch(() => {});
    await reply.started;
    // Exercise the actual app-server timeout at its original default; only fixture time advances.
    await vi.advanceTimersByTimeAsync(14 * 24 * 60 * 60 * 1000 + 1);
    await expect(pending).rejects.toThrow(/timed out/i);
    expect(
      Reflect.get(session, "baselineReadback").call(session).hostPublicBaselineTransport?.state,
    ).not.toBe("SUBMITTED");
    expect(ids).toEqual([]);
    expect(f.app.requests().filter((r) => r.method === "thread/resume")).toHaveLength(1);
  } finally {
    vi.useRealTimers();
    off();
    reply.release({});
    await session.close();
  }
});
