import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { PooledAccount } from "../account-usage-types.js";
import {
  CLAUDE_PROBE_MODEL,
  ClaudeAccountUsageReader,
  mergeRateLimitEvent,
  readingFromRateLimitHeaders,
} from "./claude-account-usage.js";

const TOKEN = "sk-ant-oat01-" + "w".repeat(60);
const NOW = Date.parse("2026-09-30T00:00:00Z");
const account: PooledAccount = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "claude",
  name: "Work",
  credential: { kind: "token", token: TOKEN },
};
const epoch = (ms: number) => String(Math.floor(ms / 1000));
const headers = (h: Record<string, string>) => new Headers(h);

describe("readingFromRateLimitHeaders", () => {
  it("reads 5h and 7d utilisation (a fraction), resets (epoch seconds) and status", () => {
    const reading = readingFromRateLimitHeaders(
      headers({
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-5h-utilization": "0.4",
        "anthropic-ratelimit-unified-5h-reset": epoch(NOW + 3 * 3600_000),
        "anthropic-ratelimit-unified-7d-utilization": "0.97",
        "anthropic-ratelimit-unified-7d-reset": epoch(NOW + 4 * 86_400_000),
      }),
      NOW,
    );
    expect(reading).toEqual({
      state: "allowed",
      observedAtMs: NOW,
      source: "probe",
      windows: [
        {
          id: "five_hour",
          usedPct: 40,
          resetsAtMs: Math.floor((NOW + 3 * 3600_000) / 1000) * 1000,
        },
        { id: "weekly", usedPct: 97, resetsAtMs: Math.floor((NOW + 4 * 86_400_000) / 1000) * 1000 },
      ],
    });
  });

  it("maps allowed_warning to warning and rejected to limited", () => {
    const base = { "anthropic-ratelimit-unified-5h-utilization": "1" };
    expect(
      readingFromRateLimitHeaders(
        headers({ ...base, "anthropic-ratelimit-unified-status": "allowed_warning" }),
        NOW,
      )?.state,
    ).toBe("warning");
    expect(
      readingFromRateLimitHeaders(
        headers({ ...base, "anthropic-ratelimit-unified-status": "rejected" }),
        NOW,
      )?.state,
    ).toBe("limited");
  });

  it("returns null when the response carries no unified figures", () => {
    expect(
      readingFromRateLimitHeaders(headers({ "content-type": "application/json" }), NOW),
    ).toBeNull();
    expect(
      readingFromRateLimitHeaders(
        headers({ "anthropic-ratelimit-unified-5h-utilization": "banana" }),
        NOW,
      ),
    ).toBeNull();
  });
});

describe("mergeRateLimitEvent (the CLI's own rate_limit_event, free)", () => {
  it("records the window the event names and keeps the other window from before", () => {
    const first = mergeRateLimitEvent(
      null,
      {
        status: "allowed",
        rateLimitType: "seven_day",
        utilization: 0.61,
        resetsAt: Math.floor(NOW / 1000) + 86_400,
      },
      NOW,
    );
    const second = mergeRateLimitEvent(
      first,
      {
        status: "allowed_warning",
        rateLimitType: "five_hour",
        utilization: 0.9,
        resetsAt: Math.floor(NOW / 1000) + 3600,
      },
      NOW + 1000,
    );
    expect(second?.source).toBe("session");
    expect(second?.state).toBe("warning");
    expect(second?.windows.map((w) => [w.id, w.usedPct])).toEqual([
      ["five_hour", 90],
      ["weekly", 61],
    ]);
  });

  it("ignores a model-scoped weekly window and an event with no figure", () => {
    expect(
      mergeRateLimitEvent(
        null,
        { status: "allowed", rateLimitType: "seven_day_opus", utilization: 0.5 },
        NOW,
      ),
    ).toBeNull();
    expect(
      mergeRateLimitEvent(null, { status: "allowed", rateLimitType: "five_hour" }, NOW),
    ).toBeNull();
  });

  it("a rejected event means limited", () => {
    const r = mergeRateLimitEvent(
      null,
      {
        status: "rejected",
        rateLimitType: "five_hour",
        utilization: 1,
        resetsAt: Math.floor(NOW / 1000) + 600,
      },
      NOW,
    );
    expect(r?.state).toBe("limited");
  });
});

describe("ClaudeAccountUsageReader.probe", () => {
  const logger = pino({ level: "silent" });
  const okHeaders = {
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.25",
    "anthropic-ratelimit-unified-5h-reset": epoch(NOW + 3600_000),
    "anthropic-ratelimit-unified-7d-utilization": "0.5",
    "anthropic-ratelimit-unified-7d-reset": epoch(NOW + 86_400_000),
  };

  it("sends the cheapest possible request: one output token on the smallest model, with the account's own token", async () => {
    const fetchApi = vi.fn(async () => new Response("{}", { status: 200, headers: okHeaders }));
    const reader = new ClaudeAccountUsageReader({
      logger,
      fetch: fetchApi as never,
      now: () => NOW,
    });
    const reading = await reader.probe(account);
    expect(reading?.windows.find((w) => w.id === "weekly")?.usedPct).toBe(50);
    const [url, init] = fetchApi.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(String(init.body));
    expect(body.max_tokens).toBe(1);
    expect(body.model).toBe(CLAUDE_PROBE_MODEL);
    expect(body.stream).toBeUndefined();
    expect(fetchApi).toHaveBeenCalledTimes(1);
  });

  it("reads the headers of a 429 too: a rejected account is limited, not unreadable", async () => {
    const fetchApi = vi.fn(
      async () =>
        new Response("{}", {
          status: 429,
          headers: {
            ...okHeaders,
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-5h-utilization": "1",
          },
        }),
    );
    const reader = new ClaudeAccountUsageReader({
      logger,
      fetch: fetchApi as never,
      now: () => NOW,
    });
    expect((await reader.probe(account))?.state).toBe("limited");
  });

  it("returns null on an auth refusal, a server error, missing headers or a network failure, and never throws the token", async () => {
    for (const make of [
      () => new Response("{}", { status: 401 }),
      () => new Response("{}", { status: 403 }),
      () => new Response("{}", { status: 500 }),
      () => new Response("{}", { status: 200 }),
    ]) {
      const reader = new ClaudeAccountUsageReader({
        logger,
        fetch: (async () => make()) as never,
        now: () => NOW,
      });
      expect(await reader.probe(account)).toBeNull();
    }
    const failing = new ClaudeAccountUsageReader({
      logger,
      fetch: (async () => {
        throw new Error(`socket hang up ${TOKEN}`);
      }) as never,
      now: () => NOW,
    });
    expect(await failing.probe(account)).toBeNull();
  });

  it("does not probe an account that carries no token", async () => {
    const fetchApi = vi.fn();
    const reader = new ClaudeAccountUsageReader({
      logger,
      fetch: fetchApi as never,
      now: () => NOW,
    });
    expect(
      await reader.probe({ ...account, credential: { kind: "codexHome", home: "/x" } }),
    ).toBeNull();
    expect(fetchApi).not.toHaveBeenCalled();
  });
});
