import { expect, test } from "vitest";
import { CODEX_TURN_ADMISSION, type AgentRunOptions } from "../../agent-sdk-types.js";
import { CodexAppServerAgentSession } from "../codex-app-server-agent.js";
import { createFakeCodexAppServer } from "./test-utils/fake-app-server.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";

function fixture(
  quota: () => unknown = () => ({
    accountId: "owned-account",
    ordinaryUsageAllowed: true,
    rateLimits: {},
  }),
) {
  const server = createFakeCodexAppServer({
    "thread/start": () => ({
      thread: { id: "owned-thread" },
      modelProvider: "openai",
      model: "gpt-5.6-sol",
    }),
    "thread/loaded/list": () => ({ data: ["owned-thread"] }),
    "account/rateLimits/read": quota,
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: "/tmp/owned-turn-fence", model: "gpt-5.6-sol", modeId: "read-only" },
    null,
    createTestLogger(),
    async () => server.child,
  );
  return {
    session,
    server,
    submissions: () => server.requests().filter((r) => r.method === "turn/start"),
  };
}

test("revoked daemon authority refuses submission after native preparation", async () => {
  const f = fixture();
  try {
    await expect(
      f.session.startTurn("Owned work", {
        [CODEX_TURN_ADMISSION]: () => {
          throw Error("Authority revoked");
        },
      }),
    ).rejects.toThrow("Authority revoked");
    expect(f.submissions()).toEqual([]);
    f.server.assertNoErrors();
  } finally {
    await f.session.close();
  }
});

test("fresh bound quota and synchronous authority check precede exactly one submission", async () => {
  const f = fixture(),
    order: string[] = [];
  try {
    await f.session.startTurn("Owned work", {
      [CODEX_TURN_ADMISSION]: (quota) => {
        expect(f.submissions()).toEqual([]);
        expect(quota).toMatchObject({
          provider: "codex",
          sessionId: "owned-thread",
          model: "gpt-5.6-sol",
          serviceTier: null,
          ordinaryUsageAllowed: true,
        });
        expect(quota.accountScope).toMatch(/^codex:[a-f0-9]{64}$/);
        order.push("admitted");
        return true;
      },
    });
    expect(order).toEqual(["admitted"]);
    expect(f.submissions()).toHaveLength(1);
    const methods = f.server.requests().map((r) => r.method);
    expect(methods.slice(-2)).toEqual(["account/rateLimits/read", "turn/start"]);
    expect(JSON.stringify(f.submissions())).not.toContain("codex-turn-admission");
    f.server.assertNoErrors();
  } finally {
    await f.session.close();
  }
});

test("ordinary human turns have no extra quota request or serializable admission capability", async () => {
  const f = fixture();
  try {
    const options = JSON.parse('{"CODEX_TURN_ADMISSION":true,"codex-turn-admission":true}');
    await f.session.startTurn("Human work", options);
    expect(f.submissions()).toHaveLength(1);
    expect(f.server.requests().filter((r) => r.method === "account/rateLimits/read")).toEqual([]);
  } finally {
    await f.session.close();
  }
});

function deferred() {
  let release!: (value: unknown) => void;
  const promise = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const allowed = { accountId: "owned-account", ordinaryUsageAllowed: true, rateLimits: {} };

test("authority revoked while quota is pending cannot submit", async () => {
  const quota = deferred(),
    f = fixture(() => quota.promise);
  let authority = true;
  try {
    const turn = f.session.startTurn("Owned work", {
      [CODEX_TURN_ADMISSION]: () => {
        if (!authority) throw Error("Revoked during read");
        return true;
      },
    });
    const failed = expect(turn).rejects.toThrow("Revoked during read");
    await f.server.waitForRequest("account/rateLimits/read");
    authority = false;
    quota.release(allowed);
    await failed;
    expect(f.submissions()).toEqual([]);
  } finally {
    quota.release(allowed);
    await f.session.close();
  }
});

test.each(["model", "fast", "account", "disconnect"])(
  "changed %s during quota read cannot submit",
  async (kind) => {
    const quota = deferred(),
      f = fixture(() => quota.promise);
    let checks = 0;
    try {
      const turn = f.session.startTurn("Owned work", {
        [CODEX_TURN_ADMISSION]: () => {
          checks++;
          return true;
        },
      });
      const failed = expect(turn).rejects.toThrow(/quota/);
      await f.server.waitForRequest("account/rateLimits/read");
      if (kind === "model") await f.session.setModel("gpt-5.5");
      if (kind === "fast") await f.session.setFeature("fast_mode", true);
      if (kind === "account")
        f.server.child.stdout.write(
          JSON.stringify({ method: "account/updated", params: {} }) + "\n",
        );
      if (kind === "disconnect") f.server.disconnect();
      quota.release(allowed);
      await failed;
      expect(f.submissions()).toEqual([]);
      expect(checks).toBe(0);
    } finally {
      quota.release(allowed);
      await f.session.close();
    }
  },
);

test("cancellation during quota read cannot submit even when quota permits", async () => {
  const quota = deferred(),
    f = fixture(() => quota.promise);
  try {
    const turn = f.session.startTurn("Owned work", { [CODEX_TURN_ADMISSION]: () => true });
    const failed = expect(turn).rejects.toThrow(/interrupted/);
    await f.server.waitForRequest("account/rateLimits/read");
    const interrupted = f.session.interrupt();
    quota.release(allowed);
    await failed;
    await interrupted;
    expect(f.submissions()).toEqual([]);
  } finally {
    quota.release(allowed);
    await f.session.close();
  }
});

test.each([
  false,
  null,
  "true",
  () => Promise.resolve(true),
  () => Promise.reject(Error("Invalid async policy")),
  async () => true,
])("invalid or asynchronous callback cannot authorize %#", async (invalid) => {
  const f = fixture(),
    options: AgentRunOptions = {};
  Reflect.set(options, CODEX_TURN_ADMISSION, invalid);
  try {
    await expect(f.session.startTurn("Owned work", options)).rejects.toThrow(/admission_refused/);
    expect(f.submissions()).toEqual([]);
  } finally {
    await f.session.close();
  }
});

test("a configuration change inside the synchronous callback cannot submit stale parameters", async () => {
  const f = fixture();
  try {
    await expect(
      f.session.startTurn("Owned work", {
        [CODEX_TURN_ADMISSION]: () => {
          void f.session.setFeature("fast_mode", true);
          return true;
        },
      }),
    ).rejects.toThrow(/session_changed/);
    expect(f.submissions()).toEqual([]);
  } finally {
    await f.session.close();
  }
});

test.each([false, null])(
  "fresh nonpermission %s remains available to a refusing authority check",
  async (permission) => {
    const f = fixture(() => ({ ...allowed, ordinaryUsageAllowed: permission }));
    try {
      await expect(
        f.session.startTurn("Owned work", {
          [CODEX_TURN_ADMISSION]: (q) => {
            if (q.ordinaryUsageAllowed !== true) throw Error("No ordinary permission");
            return true;
          },
        }),
      ).rejects.toThrow("No ordinary permission");
      expect(f.submissions()).toEqual([]);
    } finally {
      await f.session.close();
    }
  },
);

test("a refused submission leaves the same session usable for an explicit later turn", async () => {
  const f = fixture();
  try {
    await expect(
      f.session.startTurn("Revoked work", {
        [CODEX_TURN_ADMISSION]: () => {
          throw Error("Revoked");
        },
      }),
    ).rejects.toThrow("Revoked");
    expect(f.submissions()).toEqual([]);
    await f.session.startTurn("Human explicitly continues");
    expect(f.submissions()).toHaveLength(1);
    expect(f.submissions()[0]).toMatchObject({
      params: {
        threadId: "owned-thread",
        input: [{ type: "text", text: "Human explicitly continues" }],
      },
    });
  } finally {
    await f.session.close();
  }
});

test("account replacement between observation and turn is freshly exposed to admission", async () => {
  let accountId = "original-account";
  const f = fixture(() => ({ ...allowed, accountId }));
  try {
    await f.session.connect();
    await f.session.getRuntimeInfo();
    const original = await f.session.getQuota();
    accountId = "replacement-account";
    await expect(
      f.session.startTurn("Owned work", {
        [CODEX_TURN_ADMISSION]: (quota) => {
          if (quota.accountScope !== original.accountScope) throw Error("Account replaced");
          return true;
        },
      }),
    ).rejects.toThrow("Account replaced");
    expect(f.submissions()).toEqual([]);
    expect(f.server.requests().filter((r) => r.method === "account/rateLimits/read")).toHaveLength(
      2,
    );
  } finally {
    await f.session.close();
  }
});

test("cancellation inside admission is checked before the synchronous transport write", async () => {
  const f = fixture();
  let interrupted: Promise<void> | undefined;
  try {
    await expect(
      f.session.startTurn("Owned work", {
        [CODEX_TURN_ADMISSION]: () => {
          interrupted = f.session.interrupt();
          return true;
        },
      }),
    ).rejects.toThrow(/interrupted/);
    await interrupted;
    expect(f.submissions()).toEqual([]);
  } finally {
    await f.session.close();
  }
});
