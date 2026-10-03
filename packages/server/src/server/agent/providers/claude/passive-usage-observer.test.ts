import { createServer } from "node:http";
import { once } from "node:events";
import { expect, test, vi } from "vitest";
import { ClaudeAgentClient } from "./agent.js";
import { createPassiveClaudeUsageObserver } from "./passive-usage-observer.js";
import { mergeRateLimitEvent } from "../../../../services/quota-fetcher/providers/claude-account-usage.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";

const host = "a".repeat(64),
  scope = "b".repeat(64);
const env = {
  FULCRA_PASSIVE_USAGE_ENDPOINT: `http://127.0.0.1:12345/fulcra/passive-usage/${scope}`,
  FULCRA_PASSIVE_USAGE_HOST: host,
  FULCRA_PASSIVE_USAGE_SCOPE: scope,
  FULCRA_ACCOUNT_ID: "fixture-pool-selection",
};
const event = (rateLimitType = "five_hour", utilization = 0.25) => ({
  status: "allowed" as const,
  rateLimitType,
  utilization,
  resetsAt: 1000,
});
const reading = () => mergeRateLimitEvent(null, event(), 100)!;

test("absent launch configuration is no-op and does not examine account or credentials", () => {
  const launch = new Proxy(
    {},
    {
      get: (_value, key) => {
        expect(String(key)).toMatch(/^FULCRA_PASSIVE_USAGE_/);
        return undefined;
      },
    },
  );
  expect(createPassiveClaudeUsageObserver(launch)).toBeNull();
  expect(createPassiveClaudeUsageObserver(undefined)).toBeNull();
});

test.each([
  { FULCRA_PASSIVE_USAGE_ENDPOINT: `http://localhost:12345/fulcra/passive-usage/${scope}` },
  { FULCRA_PASSIVE_USAGE_ENDPOINT: `https://127.0.0.1:12345/fulcra/passive-usage/${scope}` },
  { FULCRA_PASSIVE_USAGE_ENDPOINT: `http://127.0.0.2:12345/fulcra/passive-usage/${scope}` },
  {
    FULCRA_PASSIVE_USAGE_ENDPOINT: `http://user:secret@127.0.0.1:12345/fulcra/passive-usage/${scope}`,
  },
  {
    FULCRA_PASSIVE_USAGE_ENDPOINT: `http://127.0.0.1:12345/fulcra/passive-usage/${scope}?redirect=yes`,
  },
  { FULCRA_PASSIVE_USAGE_SCOPE: "c".repeat(64) },
  { FULCRA_PASSIVE_USAGE_HOST: "unverified hostname" },
  { FULCRA_ACCOUNT_ID: "" },
  { CLAUDE_CODE_ENABLE_TELEMETRY: "false" },
  { OTEL_LOGS_EXPORTER: "console,none" },
])("unbound/non-pinned endpoint or identity refuses %j", (patch) => {
  const post = vi.fn();
  expect(createPassiveClaudeUsageObserver({ ...env, ...patch }, post)).toBeNull();
  expect(post).not.toHaveBeenCalled();
});

test("only headline normal-traffic windows publish; retained window keeps its original sample age", async () => {
  const post = vi.fn(async (_url: URL, _body: string, _scope: string) => {});
  const observer = createPassiveClaudeUsageObserver(env, post)!;
  const first = reading();
  observer.publish(first, "five_hour");
  await Promise.resolve();
  await Promise.resolve();
  const second = mergeRateLimitEvent(first, event("seven_day", 0.6), 400)!;
  observer.publish(second, "seven_day");
  const a = JSON.parse(post.mock.calls[0]![1]);
  const b = JSON.parse(post.mock.calls[1]![1]);
  expect(a.seven_day).toBeNull();
  expect(b).toEqual({
    version: 1,
    provider: "claude",
    host_opaque: host,
    account_opaque: expect.stringMatching(/^[a-f0-9]{64}$/),
    source: "normal-sdk-rate-limit-event",
    observed_at_ms: 400,
    five_hour: { used_percentage: 25, resets_at_ms: 1000000, sample_at_ms: 100, age_ms: 300 },
    seven_day: { used_percentage: 60, resets_at_ms: 1000000, sample_at_ms: 400, age_ms: 0 },
  });
  expect(post.mock.calls[1]![2]).toBe(scope);
  observer.publish({ ...second, source: "probe" }, "seven_day");
  observer.publish(second, "seven_day_opus");
  expect(post).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(b)).not.toContain(env.FULCRA_ACCOUNT_ID);
});

test("account comparison is opaque and host scoped, never touches credential-bearing env", () => {
  const bodies: string[] = [];
  for (const h of [host, "c".repeat(64)]) {
    const safe = new Proxy(
      { ...env, FULCRA_PASSIVE_USAGE_HOST: h },
      {
        get: (value, key) => {
          if (
            !String(key).startsWith("FULCRA_PASSIVE_USAGE_") &&
            key !== "FULCRA_ACCOUNT_ID" &&
            key !== "CLAUDE_CODE_ENABLE_TELEMETRY" &&
            key !== "OTEL_LOGS_EXPORTER"
          )
            throw Error("credential/property inspection forbidden");
          return Reflect.get(value, key);
        },
      },
    );
    createPassiveClaudeUsageObserver(safe, async (_url, body) => {
      bodies.push(body);
    })!.publish(reading(), "five_hour");
  }
  expect(JSON.parse(bodies[0]!).account_opaque).not.toBe(JSON.parse(bodies[1]!).account_opaque);
});

test("a stalled sink never queues normal traffic; failed publication is silent and the cache remains reusable", async () => {
  let release!: () => void;
  const post = vi.fn(
    () =>
      new Promise<void>((done) => {
        release = done;
      }),
  );
  const observer = createPassiveClaudeUsageObserver(env, post)!;
  observer.publish(reading(), "five_hour");
  observer.publish(reading(), "five_hour");
  expect(post).toHaveBeenCalledTimes(1);
  release();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  observer.publish(reading(), "five_hour");
  expect(post).toHaveBeenCalledTimes(2);
  release();
  const throws = createPassiveClaudeUsageObserver(env, () => {
    throw Error("sink diagnostic must stay private");
  })!;
  expect(() => throws.publish(reading(), "five_hour")).not.toThrow();
});

test("actual SDK note seam merges first, publishes only usable normal events and never starts a provider", async () => {
  const query = vi.fn(() => {
    throw Error("provider launch forbidden");
  });
  const probe = vi.fn(async () => {
    throw Error("probe forbidden");
  });
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory: query,
    resolveBinary: probe,
    resolveVersion: probe,
    modelProbe: probe,
  });
  const session = await client.createSession(
    { provider: "claude", cwd: process.cwd(), model: "fixture-model" },
    { env },
  );
  const observer = Reflect.get(session, "passiveUsageObserver");
  const publish = vi.spyOn(observer, "publish").mockImplementation((value) => {
    expect(Reflect.get(session, "accountUsageObservation")).toBe(value);
  });
  const note = Reflect.get(session, "noteRateLimitEvent").bind(session);
  try {
    note({ type: "rate_limit_event", rate_limit_info: event() });
    note({ type: "rate_limit_event", rate_limit_info: event("seven_day") });
    note({ type: "rate_limit_event", rate_limit_info: event("seven_day_opus") });
    note({
      type: "rate_limit_event",
      rate_limit_info: { status: "allowed", rateLimitType: "five_hour" },
    });
    expect(publish).toHaveBeenCalledTimes(2);
    expect(query).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  } finally {
    await session.close();
  }
});

test("real disposable receiver gets only the pinned scoped POST and cannot redirect publication", async () => {
  let redirected = 0;
  const server = createServer();
  const captured = new Promise<{
    path: string;
    body: string;
    scope: string | string[] | undefined;
    authorization: unknown;
  }>((resolve) => {
    server.on("request", (req, res) => {
      if (req.url === "/redirect") redirected++;
      let body = "";
      req.on("data", (data) => {
        body += data;
      });
      req.on("end", () => {
        resolve({
          path: req.url!,
          body,
          scope: req.headers["x-fulcra-observation-scope"],
          authorization: req.headers.authorization,
        });
        res.writeHead(302, { location: "/redirect" });
        res.end("discarded private response");
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = (server.address() as { port: number }).port;
    createPassiveClaudeUsageObserver({
      ...env,
      FULCRA_PASSIVE_USAGE_ENDPOINT: `http://127.0.0.1:${port}/fulcra/passive-usage/${scope}`,
    })!.publish(reading(), "five_hour");
    const got = await captured;
    expect(got.path).toBe(`/fulcra/passive-usage/${scope}`);
    expect(got.scope).toBe(scope);
    expect(got.authorization).toBeUndefined();
    expect(Object.keys(JSON.parse(got.body))).toEqual([
      "version",
      "provider",
      "host_opaque",
      "account_opaque",
      "source",
      "observed_at_ms",
      "five_hour",
      "seven_day",
    ]);
    expect(redirected).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("real stalled disposable receiver is disconnected by the write budget", async () => {
  const server = createServer();
  const disconnected = new Promise<void>((resolve) => {
    server.on("request", (req) => {
      req.resume();
      req.socket.once("close", () => resolve());
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = (server.address() as { port: number }).port;
    const start = performance.now();
    createPassiveClaudeUsageObserver({
      ...env,
      FULCRA_PASSIVE_USAGE_ENDPOINT: `http://127.0.0.1:${port}/fulcra/passive-usage/${scope}`,
    })!.publish(reading(), "five_hour");
    await disconnected;
    expect(performance.now() - start).toBeLessThan(1000);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
