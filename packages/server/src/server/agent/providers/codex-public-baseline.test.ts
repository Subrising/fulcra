import { expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { CodexAppServerAgentClient } from "./codex-app-server-agent.js";
import { createFakeCodexAppServer } from "./codex/test-utils/fake-app-server.js";
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
function fixture(loaded = false) {
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
