import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PooledAccount } from "../account-usage-types.js";
import {
  CodexAccountUsageReader,
  codexUsageCredentialFromEnv,
  mergeCodexRateLimits,
  readingFromRateLimitsNotification,
  readingFromCodexUsage,
} from "./codex-account-usage.js";

const NOW = Date.parse("2026-09-30T00:00:00Z");
const ACCESS = "codex-access-" + "a".repeat(40);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const sec = (ms: number) => Math.floor(ms / 1000);

function pooledHome(auth: unknown = { tokens: { access_token: ACCESS, account_id: "acct-1" } }) {
  const home = mkdtempSync(path.join(tmpdir(), "u7c-codex-"));
  dirs.push(home);
  if (auth) writeFileSync(path.join(home, "auth.json"), JSON.stringify(auth));
  const account: PooledAccount = {
    id: "33333333-3333-4333-8333-333333333333",
    provider: "codex",
    name: "Codex A",
    credential: { kind: "codexHome", home },
  };
  return { home, account };
}

const body = (over: Record<string, unknown> = {}) => ({
  plan_type: "pro",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 30,
      reset_at: sec(NOW + 3 * 3600_000),
      limit_window_seconds: 18000,
    },
    secondary_window: {
      used_percent: 55,
      reset_at: sec(NOW + 4 * 86_400_000),
      limit_window_seconds: 604800,
    },
  },
  ...over,
});

describe("readingFromCodexUsage", () => {
  it("maps the 5-hour and weekly windows by their length, with resets", () => {
    const r = readingFromCodexUsage(body() as never, NOW);
    expect(r).toMatchObject({ state: "allowed", source: "api", observedAtMs: NOW });
    expect(r?.windows).toEqual([
      { id: "five_hour", usedPct: 30, resetsAtMs: sec(NOW + 3 * 3600_000) * 1000 },
      { id: "weekly", usedPct: 55, resetsAtMs: sec(NOW + 4 * 86_400_000) * 1000 },
    ]);
  });

  it("marks a reached limit as limited", () => {
    const r = readingFromCodexUsage(
      body({
        rate_limit: {
          allowed: false,
          limit_reached: true,
          primary_window: {
            used_percent: 100,
            reset_at: sec(NOW + 600_000),
            limit_window_seconds: 18000,
          },
        },
      }) as never,
      NOW,
    );
    expect(r?.state).toBe("limited");
  });

  it("returns null when the reply has no window", () => {
    expect(readingFromCodexUsage({ plan_type: "pro" } as never, NOW)).toBeNull();
  });
});

describe("mergeCodexRateLimits (the running session's own account/rateLimits, free)", () => {
  it("reads primary/secondary by window minutes and marks source session", () => {
    const r = mergeCodexRateLimits(
      null,
      {
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: sec(NOW + 3600_000) },
        secondary: { usedPercent: 70, windowDurationMins: 10080, resetsAt: sec(NOW + 86_400_000) },
        rateLimitReachedType: null,
      },
      NOW,
    );
    expect(r?.source).toBe("session");
    expect(r?.windows.map((w) => [w.id, w.usedPct])).toEqual([
      ["five_hour", 12],
      ["weekly", 70],
    ]);
    expect(r?.state).toBe("allowed");
  });

  it("a reached limit type means limited", () => {
    const r = mergeCodexRateLimits(
      null,
      {
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: sec(NOW + 600_000) },
        rateLimitReachedType: "primary",
      },
      NOW,
    );
    expect(r?.state).toBe("limited");
  });
});

describe("CodexAccountUsageReader.probe", () => {
  const logger = pino({ level: "silent" });

  it("reads the pooled home's own auth (not the Mac's), one GET, no model tokens", async () => {
    const { account } = pooledHome();
    const fetchApi = vi.fn(async () => new Response(JSON.stringify(body()), { status: 200 }));
    const reader = new CodexAccountUsageReader({
      logger,
      fetch: fetchApi as never,
      now: () => NOW,
    });
    const reading = await reader.probe(account);
    expect(reading?.windows.find((w) => w.id === "weekly")?.usedPct).toBe(55);
    const [url, init] = fetchApi.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(init.method ?? "GET").toBe("GET");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe(`Bearer ${ACCESS}`);
    expect(headers.get("ChatGPT-Account-Id")).toBe("acct-1");
  });

  it("returns null without a request when the home has no sign-in, on a refusal, an HTML page or a failure", async () => {
    const none = pooledHome(null);
    const fetchNone = vi.fn();
    expect(
      await new CodexAccountUsageReader({
        logger,
        fetch: fetchNone as never,
        now: () => NOW,
      }).probe(none.account),
    ).toBeNull();
    expect(fetchNone).not.toHaveBeenCalled();
    const { account } = pooledHome();
    for (const make of [
      () => new Response("{}", { status: 401 }),
      () => new Response("{}", { status: 403 }),
      () => new Response("{}", { status: 500 }),
      () => new Response("<html>login</html>", { status: 200 }),
    ]) {
      expect(
        await new CodexAccountUsageReader({
          logger,
          fetch: (async () => make()) as never,
          now: () => NOW,
        }).probe(account),
      ).toBeNull();
    }
    const boom = new CodexAccountUsageReader({
      logger,
      fetch: (async () => {
        throw new Error(`net ${ACCESS}`);
      }) as never,
      now: () => NOW,
    });
    expect(await boom.probe(account)).toBeNull();
  });

  it("does not probe an account that is not a Codex home", async () => {
    const fetchApi = vi.fn();
    const reader = new CodexAccountUsageReader({
      logger,
      fetch: fetchApi as never,
      now: () => NOW,
    });
    expect(
      await reader.probe({
        id: null,
        provider: "codex",
        name: "x",
        credential: { kind: "token", token: "t".repeat(30) },
      }),
    ).toBeNull();
    expect(fetchApi).not.toHaveBeenCalled();
  });
});

describe("a running Codex session on a pooled home", () => {
  it("names the pooled account from the launch environment, and only a pooled launch", () => {
    expect(
      codexUsageCredentialFromEnv({
        CODEX_HOME: "/homes/acct",
        FULCRA_ACCOUNT_ID: "id-1",
        FULCRA_ACCOUNT_NAME: "Codex A",
      }),
    ).toEqual({
      credential: { kind: "codexHome", home: "/homes/acct" },
      label: "Codex A",
      accountId: "id-1",
    });
    expect(codexUsageCredentialFromEnv({ CODEX_HOME: "/homes/acct" })).toBeNull(); // the Mac's own home
    expect(codexUsageCredentialFromEnv({ FULCRA_ACCOUNT_ID: "id-1" })).toBeNull();
    expect(
      codexUsageCredentialFromEnv({ CODEX_HOME: "relative", FULCRA_ACCOUNT_ID: "id-1" }),
    ).toBeNull();
    expect(codexUsageCredentialFromEnv(undefined)).toBeNull();
  });

  it("folds an account/rateLimits/updated notification into the reading, and ignores a malformed one", () => {
    const first = readingFromRateLimitsNotification(
      null,
      {
        rateLimits: {
          primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: sec(NOW + 3600_000) },
        },
      },
      NOW,
    );
    expect(first?.windows).toEqual([
      { id: "five_hour", usedPct: 25, resetsAtMs: sec(NOW + 3600_000) * 1000 },
    ]);
    expect(readingFromRateLimitsNotification(first, { nope: 1 }, NOW + 1)).toBe(first);
    expect(
      readingFromRateLimitsNotification(
        first,
        { rateLimits: { primary: { usedPercent: 500 } } },
        NOW + 1,
      ),
    ).toBe(first);
  });
});
