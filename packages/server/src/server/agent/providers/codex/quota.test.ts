import { describe, expect, test } from "vitest";
import { readCodexQuota, type CodexQuotaBinding } from "./quota.js";

function fixture(response: unknown = { rateLimits: {} }) {
  const requests: unknown[] = [];
  let finish!: (value: unknown) => void;
  let fail!: (error: Error) => void;
  const pending = new Promise<unknown>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  const client = {
    request(method: string, params?: unknown, timeoutMs?: number) {
      requests.push({ method, params, timeoutMs });
      return pending;
    },
  };
  const initial: CodexQuotaBinding = {
    client,
    sessionId: "owned-thread",
    model: "selected-model",
    serviceTier: null,
    revision: 0,
  };
  let binding: CodexQuotaBinding | null = initial;
  return {
    initial,
    requests,
    read: () => readCodexQuota(() => binding),
    finish: () => finish(response),
    fail,
    change: (next: CodexQuotaBinding | null) => {
      binding = next;
    },
  };
}

describe("attached Codex quota", () => {
  test("does not connect or resume a missing session", async () => {
    const getBinding = (): CodexQuotaBinding | null => null;
    await expect(readCodexQuota(getBinding)).rejects.toMatchObject({ code: "unavailable" });
  });

  test("binds one bounded native read without exposing the account or enabling reserve", async () => {
    const f = fixture({
      accountId: "private-account",
      ordinaryUsageAllowed: true,
      rateLimits: {},
      rateLimitsByLimitId: { codex: { normalModelSlug: "other-model", spendControlReached: true } },
      rateLimitResetCredits: { secret: "not-returned" },
    });
    const start = Date.now();
    const read = f.read();
    f.finish();
    const result = await read;
    expect(result).toEqual({
      provider: "codex",
      sessionId: "owned-thread",
      model: "selected-model",
      serviceTier: null,
      accountScope: "codex:12619ae3f5495d5f22fb9a1dff90d7ba41b0163f835114e5e9d3b16d781226d5",
      observedAt: result.observedAt,
      ordinaryUsageAllowed: true,
      limits: [
        {
          id: "codex",
          model: "other-model",
          primary: null,
          secondary: null,
          spendControlReached: true,
          rateLimitReachedType: null,
        },
      ],
    });
    expect(Date.parse(result.observedAt)).toBeGreaterThanOrEqual(start);
    expect(Date.parse(result.observedAt)).toBeLessThanOrEqual(Date.now());
    expect(f.requests).toEqual([
      {
        method: "account/rateLimits/read",
        params: { supportsLunaReserve: false, excludeResetCreditDetails: true },
        timeoutMs: 15_000,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("private-account");
    expect(JSON.stringify(result)).not.toContain("not-returned");
  });

  test.each([true, false, null, undefined])(
    "preserves explicit ordinary permission %s",
    async (allowed) => {
      const f = fixture({ accountId: "account", ordinaryUsageAllowed: allowed, rateLimits: {} });
      const read = f.read();
      f.finish();
      expect((await read).ordinaryUsageAllowed).toBe(allowed ?? null);
    },
  );

  test("does not infer permission from zero usage, an elapsed reset or an unbound account", async () => {
    const primary = { usedPercent: 0, windowDurationMins: 300, resetsAt: 1 };
    const f = fixture({ ordinaryUsageAllowed: true, rateLimits: { primary } });
    const read = f.read();
    f.finish();
    expect(await read).toMatchObject({
      accountScope: null,
      ordinaryUsageAllowed: null,
      limits: [
        {
          id: null,
          model: null,
          primary,
          secondary: null,
          spendControlReached: null,
          rateLimitReachedType: null,
        },
      ],
    });
  });

  test.each([
    null,
    {},
    { rateLimits: {}, ordinaryUsageAllowed: "true" },
    { rateLimits: {}, accountId: "" },
    { rateLimits: { primary: { usedPercent: false, windowDurationMins: 300, resetsAt: null } } },
  ])("rejects malformed responses without disclosing values %#", async (response) => {
    const f = fixture(response);
    const read = f.read();
    f.finish();
    await expect(read).rejects.toMatchObject({
      code: "invalid_reply",
      message: expect.not.stringContaining("invalid_reply"),
    });
  });

  test.each(["sessionId", "model", "serviceTier", "revision", "client", "closed"])(
    "rejects a changed %s binding during the read",
    async (field) => {
      const f = fixture();
      const read = f.read();
      const next = { ...f.initial };
      if (field === "sessionId") next.sessionId = "replacement";
      if (field === "model") next.model = "replacement";
      if (field === "serviceTier") next.serviceTier = "fast";
      if (field === "revision") next.revision++;
      if (field === "client") next.client = { ...next.client };
      f.change(field === "closed" ? null : next);
      f.finish();
      await expect(read).rejects.toMatchObject({ code: "session_changed" });
    },
  );

  test("a stale read reports the account it observed so callers can detect a switch", async () => {
    const f = fixture({ accountId: "private-account", rateLimits: {} });
    const read = f.read();
    f.change({ ...f.initial, revision: 1 });
    f.finish();
    await expect(read).rejects.toMatchObject({
      code: "session_changed",
      staleAccountScope: expect.stringMatching(/^codex:[a-f0-9]{64}$/),
    });
  });

  test("sanitizes native failures and does not retry", async () => {
    const f = fixture();
    const read = f.read();
    f.fail(new Error("private-account unauthorized"));
    await expect(read).rejects.toMatchObject({
      code: "read_failed",
      message: "Couldn't verify the Codex account: the usage check failed. Try again.",
    });
    expect(f.requests).toHaveLength(1);
  });
});
