import {
  createNativeQueuedDispatch,
  nativeQueuedAcceptance,
  isNativeQueuedRefusal,
  validateNativeQueuedDispatch,
} from "../../native-queued-dispatch.js";
import { CodexQuotaError } from "./quota.js";
import { expect, test, vi } from "vitest";
import {
  CODEX_TURN_ADMISSION,
  NATIVE_QUEUED_FINAL,
  type AgentRunOptions,
} from "../../agent-sdk-types.js";
import { CodexAppServerAgentSession } from "../codex-app-server-agent.js";
import { createFakeCodexAppServer } from "./test-utils/fake-app-server.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";

function fixture(
  quota: () => unknown = () => ({
    accountId: "owned-account",
    ordinaryUsageAllowed: true,
    rateLimits: {},
  }),
  turnStart?: () => unknown,
) {
  const server = createFakeCodexAppServer({
    "thread/start": () => ({
      thread: { id: "owned-thread" },
      modelProvider: "openai",
      model: "gpt-5.6-sol",
    }),
    "thread/loaded/list": () => ({ data: ["owned-thread"] }),
    "account/rateLimits/read": quota,
    ...(turnStart ? { "turn/start": turnStart } : {}),
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

test.each(["model", "fast", "disconnect"])(
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
      const failed = expect(turn).rejects.toBeInstanceOf(CodexQuotaError);
      await f.server.waitForRequest("account/rateLimits/read");
      if (kind === "model") await f.session.setModel("gpt-5.5");
      if (kind === "fast") await f.session.setFeature("fast_mode", true);
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
    await expect(f.session.startTurn("Owned work", options)).rejects.toMatchObject({
      code: "admission_refused",
    });
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
    ).rejects.toMatchObject({ code: "session_changed" });
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

function capturedAdmission(
  overrides: Partial<import("../../agent-sdk-types.js").CapturedCodexAdmission> = {},
): import("../../agent-sdk-types.js").CapturedCodexAdmission {
  return {
    operation: Object.freeze({
      operationId: "11111111-1111-4111-8111-111111111111",
      agentId: "22222222-2222-4222-8222-222222222222",
      kind: "prompt",
      messageId: "orca-control:example",
      payloadDigest: "a".repeat(64) as import("@getpaseo/protocol/trusted-input").Sha256,
      attemptId: "33333333-3333-4333-8333-333333333333",
      pluginId: "orca-organization-next",
    }),
    instanceId: "44444444-4444-4444-8444-444444444444",
    validate: () => undefined,
    check: () => true,
    onQuotaReadFailure: () => undefined,
    ...overrides,
  };
}

test.each(["unavailable", "read_failed", "invalid_reply"] as const)(
  "P5: %s calls the bound failure callback and always refuses transport",
  async (code) => {
    const f = fixture();
    const failures: unknown[] = [];
    const admission = capturedAdmission({
      onQuotaReadFailure: (turn, failure) => {
        failures.push({ turn, failure });
      },
    });
    vi.spyOn(f.session, "getQuota").mockRejectedValue(new CodexQuotaError(code));
    try {
      await expect(
        f.session.startTurn("work", { [CODEX_TURN_ADMISSION]: admission }),
      ).rejects.toMatchObject({
        code: "admission_refused",
        readFailure: code,
        message: expect.stringMatching(/^The Codex turn wasn't sent: /),
      });
      expect(failures).toEqual([
        {
          turn: {
            operation: admission.operation,
            instanceId: admission.instanceId,
            nativeSessionId: "owned-thread",
            model: "gpt-5.6-sol",
            serviceTier: null,
          },
          failure: { code, nativeDispatched: false },
        },
      ]);
      expect(f.submissions()).toEqual([]);
    } finally {
      await f.session.close();
    }
  },
);

test("P5: callback throw or attempted allow cannot turn a quota failure into dispatch", async () => {
  for (const callback of [
    () => {
      throw new Error("receipt write failed");
    },
    () => true,
  ]) {
    const f = fixture();
    vi.spyOn(f.session, "getQuota").mockRejectedValue(new CodexQuotaError("read_failed"));
    try {
      await expect(
        f.session.startTurn("work", {
          [CODEX_TURN_ADMISSION]: capturedAdmission({ onQuotaReadFailure: callback }),
        }),
      ).rejects.toMatchObject({ code: "admission_refused", readFailure: "read_failed" });
      expect(f.submissions()).toEqual([]);
    } finally {
      await f.session.close();
    }
  }
});

test("P5: instance or journal-attempt replacement during quota await refuses before callbacks", async () => {
  for (const reason of ["instance", "attempt"]) {
    let valid = true;
    let checks = 0;
    let failures = 0;
    const f = fixture(() => {
      valid = false;
      return { accountId: "owned-account", ordinaryUsageAllowed: true, rateLimits: {} };
    });
    const admission = capturedAdmission({
      validate: () => {
        if (!valid) throw Error(reason + " changed");
      },
      check: () => {
        checks++;
        return true;
      },
      onQuotaReadFailure: () => {
        failures++;
      },
    });
    try {
      await expect(
        f.session.startTurn("work", { [CODEX_TURN_ADMISSION]: admission }),
      ).rejects.toThrow(reason + " changed");
      expect(checks).toBe(0);
      expect(failures).toBe(0);
      expect(f.submissions()).toEqual([]);
    } finally {
      await f.session.close();
    }
  }
});

test("P5: admission re-entrancy invalidates live identity immediately before transport", async () => {
  const f = fixture();
  let valid = true;
  try {
    await expect(
      f.session.startTurn("work", {
        [CODEX_TURN_ADMISSION]: capturedAdmission({
          validate: () => {
            if (!valid) throw Error("instance changed");
          },
          check: () => {
            valid = false;
            return true;
          },
        }),
      }),
    ).rejects.toThrow("instance changed");
    expect(f.submissions()).toEqual([]);
  } finally {
    await f.session.close();
  }
});

test("P5: lost acknowledgement after submission is never reported as no-dispatch quota failure", async () => {
  let failureCallbacks = 0;
  let admissionChecks = 0;
  const f = fixture(undefined, () => {
    queueMicrotask(() => f.server.disconnect());
    return new Promise(() => {});
  });
  try {
    await expect(
      f.session.startTurn("work", {
        [CODEX_TURN_ADMISSION]: capturedAdmission({
          check: () => {
            admissionChecks++;
            return true;
          },
          onQuotaReadFailure: () => {
            failureCallbacks++;
          },
        }),
      }),
    ).rejects.toThrow();
    expect(f.submissions()).toHaveLength(1);
    expect(admissionChecks).toBe(1);
    expect(failureCallbacks).toBe(0);
  } finally {
    await f.session.close();
  }
});

test("local reprepare: stable account epoch permits one same-intent quota refresh and real first-create", async () => {
  let reads = 0;
  const check = vi.fn(() => true as const);
  const f = fixture(async () => {
    if (++reads === 1) await f.session.setModel("gpt-5.6-sol");
    return allowed;
  });
  try {
    await f.session.startTurn("Same original text", {
      [CODEX_TURN_ADMISSION]: capturedAdmission({ check }),
    });
    expect(reads).toBe(2);
    expect(check).toHaveBeenCalledTimes(1);
    expect(f.submissions()).toHaveLength(1);
    expect(f.server.requests().filter((r) => r.method === "thread/start")).toHaveLength(1);
    expect(f.submissions()[0].params).toMatchObject({
      threadId: "owned-thread",
      model: "gpt-5.6-sol",
    });
    f.server.assertNoErrors();
  } finally {
    await f.session.close();
  }
});

test("local reprepare: repeated stale preparation refuses after a bounded number of reads", async () => {
  let reads = 0;
  const check = vi.fn(() => true as const);
  const f = fixture(async () => {
    reads++;
    await f.session.setModel("gpt-5.6-sol");
    return allowed;
  });
  try {
    await expect(
      f.session.startTurn("Same text", { [CODEX_TURN_ADMISSION]: capturedAdmission({ check }) }),
    ).rejects.toMatchObject({ code: "session_changed" });
    expect(reads).toBe(3);
    expect(check).not.toHaveBeenCalled();
    expect(f.submissions()).toEqual([]);
  } finally {
    await f.session.close();
  }
});

function notifyAccountUpdated(f: ReturnType<typeof fixture>) {
  f.server.child.stdout.write(JSON.stringify({ method: "account/updated", params: {} }) + "\n");
}

test("a new agent's first turn admits despite Codex announcing the account during startup", async () => {
  const check = vi.fn(() => true as const);
  const server = createFakeCodexAppServer({
    "thread/start": () => {
      server.child.stdout.write(JSON.stringify({ method: "account/updated", params: {} }) + "\n");
      return { thread: { id: "owned-thread" }, modelProvider: "openai", model: "gpt-5.6-sol" };
    },
    "account/rateLimits/read": () => allowed,
  });
  const session = new CodexAppServerAgentSession(
    { provider: "codex", cwd: "/tmp/owned-turn-fence", model: "gpt-5.6-sol", modeId: "read-only" },
    null,
    createTestLogger(),
    async () => server.child,
  );
  try {
    await session.startTurn("First work", { [CODEX_TURN_ADMISSION]: capturedAdmission({ check }) });
    expect(check).toHaveBeenCalledTimes(1);
    expect(server.requests().filter((r) => r.method === "turn/start")).toHaveLength(1);
    server.assertNoErrors();
  } finally {
    await session.close();
  }
});

test("local reprepare: a same-account notification during the read retries and admits", async () => {
  let reads = 0;
  const check = vi.fn(() => true as const);
  const f = fixture(() => {
    if (++reads === 1) notifyAccountUpdated(f);
    return allowed;
  });
  try {
    await f.session.startTurn("Same text", {
      [CODEX_TURN_ADMISSION]: capturedAdmission({ check }),
    });
    expect(reads).toBe(2);
    expect(check).toHaveBeenCalledTimes(1);
    expect(f.submissions()).toHaveLength(1);
    f.server.assertNoErrors();
  } finally {
    await f.session.close();
  }
});

test("local reprepare: an account switch announced during the read fails closed", async () => {
  let reads = 0,
    accountId = "original-account";
  const check = vi.fn(() => true as const);
  const failure = vi.fn();
  const f = fixture(() => {
    if (++reads === 1) {
      notifyAccountUpdated(f);
      const observed = accountId;
      accountId = "replacement-account";
      return { ...allowed, accountId: observed };
    }
    return { ...allowed, accountId };
  });
  try {
    const error = await f.session
      .startTurn("Same text", {
        [CODEX_TURN_ADMISSION]: capturedAdmission({ check, onQuotaReadFailure: failure }),
      })
      .catch((rejection) => rejection);
    expect(error).toMatchObject({ code: "account_changed" });
    expect(error.message).toMatch(/Codex account changed/);
    expect(reads).toBe(2);
    expect(check).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    expect(f.submissions()).toEqual([]);
  } finally {
    await f.session.close();
  }
});

test("local reprepare: an account switch after an earlier turn's read fails closed", async () => {
  let reads = 0,
    accountId = "original-account";
  const check = vi.fn(() => true as const);
  const f = fixture(() => {
    // The second read is this turn's first: the switch lands while it is in flight.
    if (++reads === 2) {
      accountId = "replacement-account";
      notifyAccountUpdated(f);
    }
    return { ...allowed, accountId };
  });
  try {
    await f.session.getRuntimeInfo();
    await f.session.getQuota();
    await expect(
      f.session.startTurn("Same text", { [CODEX_TURN_ADMISSION]: capturedAdmission({ check }) }),
    ).rejects.toMatchObject({ code: "account_changed" });
    expect(reads).toBe(3);
    expect(check).not.toHaveBeenCalled();
    expect(f.submissions()).toEqual([]);
  } finally {
    await f.session.close();
  }
});

test("local reprepare: account churn on every read refuses after bounded reads", async () => {
  let reads = 0;
  const check = vi.fn(() => true as const);
  const f = fixture(() => {
    reads++;
    notifyAccountUpdated(f);
    return allowed;
  });
  try {
    await expect(
      f.session.startTurn("Same text", { [CODEX_TURN_ADMISSION]: capturedAdmission({ check }) }),
    ).rejects.toMatchObject({ code: "session_changed" });
    expect(reads).toBe(3);
    expect(check).not.toHaveBeenCalled();
    expect(f.submissions()).toEqual([]);
  } finally {
    await f.session.close();
  }
});

test("a transient quota read failure retries before reporting a failure", async () => {
  const check = vi.fn(() => true as const);
  const failure = vi.fn();
  const f = fixture();
  const real = f.session.getQuota.bind(f.session);
  const getQuota = vi
    .spyOn(f.session, "getQuota")
    .mockRejectedValueOnce(new CodexQuotaError("read_failed"))
    .mockImplementation(real);
  try {
    await f.session.startTurn("work", {
      [CODEX_TURN_ADMISSION]: capturedAdmission({ check, onQuotaReadFailure: failure }),
    });
    expect(getQuota).toHaveBeenCalledTimes(2);
    expect(failure).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(1);
    expect(f.submissions()).toHaveLength(1);
  } finally {
    await f.session.close();
  }
});

test("local reprepare: fresh authority revocation after stale read prevents another read", async () => {
  let reads = 0,
    valid = true;
  const f = fixture(async () => {
    reads++;
    await f.session.setModel("gpt-5.6-sol");
    valid = false;
    return allowed;
  });
  try {
    await expect(
      f.session.startTurn("Same text", {
        [CODEX_TURN_ADMISSION]: capturedAdmission({
          validate: () => {
            if (!valid) throw Error("Fresh authority revoked");
          },
        }),
      }),
    ).rejects.toThrow("Fresh authority revoked");
    expect(reads).toBe(1);
    expect(f.submissions()).toEqual([]);
  } finally {
    await f.session.close();
  }
});

test("local reprepare: genuine policy refusal never re-enters quota preparation", async () => {
  let reads = 0;
  const f = fixture(() => {
    reads++;
    return allowed;
  });
  const check = vi.fn(() => false as const);
  try {
    await expect(
      f.session.startTurn("Same text", { [CODEX_TURN_ADMISSION]: capturedAdmission({ check }) }),
    ).rejects.toThrow();
    expect(reads).toBe(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(f.submissions()).toEqual([]);
  } finally {
    await f.session.close();
  }
});

test("local reprepare: existing queued thread retains the original one-use capability", async () => {
  let reads = 0;
  const f = fixture(
    async () => {
      if (++reads === 1) await f.session.setModel("gpt-5.6-sol");
      return allowed;
    },
    () => ({
      threadId: "owned-thread",
      turn: { id: "native-owned-turn", status: "inProgress", error: null },
    }),
  );
  const capability = createNativeQueuedDispatch(() => undefined);
  try {
    await f.session.getRuntimeInfo();
    await f.session.startTurn("Same queued text", {
      [CODEX_TURN_ADMISSION]: capturedAdmission(),
      [NATIVE_QUEUED_FINAL]: capability,
    });
    expect(reads).toBe(2);
    expect(f.submissions()).toHaveLength(1);
    expect(nativeQueuedAcceptance(capability)).toBe("native-owned-turn");
    expect(() => validateNativeQueuedDispatch(capability)).toThrow("already attempted");
    expect(f.server.requests().filter((r) => r.method === "thread/start")).toHaveLength(1);
  } finally {
    await f.session.close();
  }
});

test("local reprepare: queued missing-thread creation stays refused before any preparation", async () => {
  const f = fixture();
  const capability = createNativeQueuedDispatch(() => undefined);
  try {
    const error = await f.session
      .startTurn("Queued text", {
        [CODEX_TURN_ADMISSION]: capturedAdmission(),
        [NATIVE_QUEUED_FINAL]: capability,
      })
      .catch((rejection) => rejection);
    expect(isNativeQueuedRefusal(error)).toBe(true);
    expect(f.server.requests()).toEqual([]);
    expect(nativeQueuedAcceptance(capability)).toBeUndefined();
    expect(() => validateNativeQueuedDispatch(capability)).not.toThrow();
  } finally {
    await f.session.close();
  }
});

test("local reprepare: queued source revocation before refresh preserves true refusal and zero write", async () => {
  let valid = true,
    reads = 0;
  const f = fixture(async () => {
    reads++;
    await f.session.setModel("gpt-5.6-sol");
    valid = false;
    return allowed;
  });
  const capability = createNativeQueuedDispatch(() => {
    if (!valid) throw Error("source revoked");
  });
  try {
    await f.session.getRuntimeInfo();
    const error = await f.session
      .startTurn("Queued text", {
        [CODEX_TURN_ADMISSION]: capturedAdmission(),
        [NATIVE_QUEUED_FINAL]: capability,
      })
      .catch((rejection) => rejection);
    expect(isNativeQueuedRefusal(error)).toBe(true);
    expect(reads).toBe(1);
    expect(f.submissions()).toEqual([]);
    expect(nativeQueuedAcceptance(capability)).toBeUndefined();
  } finally {
    await f.session.close();
  }
});

test("local reprepare: refreshed queued lost acknowledgement remains ambiguous with one write", async () => {
  let reads = 0;
  const failure = vi.fn();
  const f = fixture(
    async () => {
      if (++reads === 1) await f.session.setModel("gpt-5.6-sol");
      return allowed;
    },
    () => {
      queueMicrotask(() => f.server.disconnect());
      return new Promise(() => {});
    },
  );
  const capability = createNativeQueuedDispatch(() => undefined);
  try {
    await f.session.getRuntimeInfo();
    const error = await f.session
      .startTurn("Queued text", {
        [CODEX_TURN_ADMISSION]: capturedAdmission({ onQuotaReadFailure: failure }),
        [NATIVE_QUEUED_FINAL]: capability,
      })
      .catch((rejection) => rejection);
    expect(error).toBeInstanceOf(Error);
    expect(isNativeQueuedRefusal(error)).toBe(false);
    expect(reads).toBe(2);
    expect(f.submissions()).toHaveLength(1);
    expect(failure).not.toHaveBeenCalled();
    expect(nativeQueuedAcceptance(capability)).toBeUndefined();
    expect(() => validateNativeQueuedDispatch(capability)).toThrow("already attempted");
  } finally {
    await f.session.close();
  }
});

test("local reprepare: pending native permission prevents a refresh", async () => {
  let reads = 0;
  const f = fixture(async () => {
    reads++;
    await f.session.setModel("gpt-5.6-sol");
    f.server.requestCommandApproval({
      itemId: "approval",
      threadId: "owned-thread",
      turnId: "pending",
      command: "fixture",
      cwd: "/tmp/owned-turn-fence",
      reason: "fixture approval",
    });
    return allowed;
  });
  try {
    await expect(
      f.session.startTurn("Text", { [CODEX_TURN_ADMISSION]: capturedAdmission() }),
    ).rejects.toThrow(/permission attention/);
    expect(reads).toBe(1);
    expect(f.submissions()).toEqual([]);
    expect(f.session.getPendingPermissions()).toHaveLength(1);
  } finally {
    await f.session.close();
  }
});

test.each(["model", "tier", "options"] as const)(
  "local reprepare: %s retarget refuses without a second quota read",
  async (kind) => {
    let reads = 0;
    const options: AgentRunOptions = {
      outputSchema: { type: "object" },
      [CODEX_TURN_ADMISSION]: capturedAdmission(),
    };
    const f = fixture(async () => {
      reads++;
      if (kind === "model") await f.session.setModel("gpt-5.5");
      if (kind === "tier") await f.session.setFeature("fast_mode", true);
      if (kind === "options") {
        await f.session.setModel("gpt-5.6-sol");
        options.outputSchema = { type: "string" };
      }
      return allowed;
    });
    try {
      await expect(f.session.startTurn("Original text", options)).rejects.toMatchObject({
        code: "session_changed",
      });
      expect(reads).toBe(1);
      expect(f.submissions()).toEqual([]);
    } finally {
      await f.session.close();
    }
  },
);

test("local reprepare: account notification from the policy callback refuses final submission without retry", async () => {
  let reads = 0;
  const f = fixture(() => {
    reads++;
    return allowed;
  });
  const check = vi.fn(() => {
    f.server.child.stdout.write(JSON.stringify({ method: "account/updated", params: {} }) + "\n");
    return true as const;
  });
  try {
    await expect(
      f.session.startTurn("Text", { [CODEX_TURN_ADMISSION]: capturedAdmission({ check }) }),
    ).rejects.toMatchObject({ code: "session_changed" });
    expect(reads).toBe(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(f.submissions()).toEqual([]);
  } finally {
    await f.session.close();
  }
});

test("local reprepare: refreshed read failure reports genuine refusal without another preparation", async () => {
  let reads = 0;
  const failure = vi.fn();
  const check = vi.fn(() => true as const);
  const f = fixture(async () => {
    if (++reads === 1) {
      await f.session.setModel("gpt-5.6-sol");
      return allowed;
    }
    return { malformed: true };
  });
  try {
    await expect(
      f.session.startTurn("Original text", {
        [CODEX_TURN_ADMISSION]: capturedAdmission({ check, onQuotaReadFailure: failure }),
      }),
    ).rejects.toMatchObject({ code: "admission_refused" });
    expect(reads).toBe(2);
    expect(check).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledTimes(1);
    expect(f.submissions()).toEqual([]);
  } finally {
    await f.session.close();
  }
});

test("local reprepare: a genuine validation refusal using session_changed is never swallowed", async () => {
  let reads = 0;
  const f = fixture(() => {
    reads++;
    return { malformed: true };
  });
  const check = vi.fn(() => true as const);
  const admission = capturedAdmission({
    check,
    validate: () => {
      if (reads > 0) {
        void f.session.setModel("gpt-5.6-sol");
        throw new CodexQuotaError("session_changed");
      }
    },
  });
  try {
    await expect(
      f.session.startTurn("Original text", { [CODEX_TURN_ADMISSION]: admission }),
    ).rejects.toMatchObject({ code: "session_changed" });
    expect(reads).toBe(1);
    expect(check).not.toHaveBeenCalled();
    expect(f.submissions()).toEqual([]);
  } finally {
    await f.session.close();
  }
});
