import { describe, expect, it, vi } from "vitest";
import { PROVIDERS, methodAvailability, type ProviderDefinition } from "./providers.js";
import { SignInFlows, pkceChallenge, type LoopbackListener } from "./sign-in-flows.js";

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

// Mocked provider HTTP: each handler answers one URL; anything else is a test failure.
function mockFetch(routes: Record<string, (init: RequestInit | undefined) => Response>) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = Object.keys(routes).find((prefix) => url.startsWith(prefix));
    if (!route) throw new Error(`Unexpected request: ${url}`);
    return routes[route](init);
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function form(init: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(String(init?.body ?? ""));
}

function header(init: RequestInit | undefined, name: string): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.[name];
}

// A provider that accepts a public PKCE client, so the browser machinery can be exercised. No v1
// provider qualifies today (see docs/integrations-auth.md).
const PUBLIC_BROWSER_PROVIDER: ProviderDefinition = {
  ...PROVIDERS.find((provider) => provider.id === "github")!,
  id: "publicforge",
  label: "Public Forge",
  methods: ["browser", "token"],
  browser: {
    authorizeUrl: "https://auth.example.test/authorize",
    tokenUrl: "https://auth.example.test/token",
    scopes: ["read"],
    publicClient: true,
  },
  identity: ({ authorization }) => ({
    url: "https://api.example.test/me",
    headers: { Authorization: authorization },
  }),
  readIdentity: () => ({ name: "octo (Public Forge)" }),
};

function flowsWith(options: {
  routes?: Record<string, (init: RequestInit | undefined) => Response>;
  clientIds?: Record<string, string>;
  now?: { value: number };
  providers?: readonly ProviderDefinition[];
  openLoopback?: (onCallback: (url: string) => void) => Promise<LoopbackListener>;
}) {
  const http = mockFetch(options.routes ?? {});
  const clock = options.now ?? { value: 1_000_000 };
  const flows = new SignInFlows({
    providers: options.providers ?? [...PROVIDERS, PUBLIC_BROWSER_PROVIDER],
    clientIds: () => options.clientIds ?? {},
    fetch: http.fetch,
    now: () => clock.value,
    openLoopback: options.openLoopback,
  });
  return { flows, http, clock };
}

describe("method availability", () => {
  it("always offers token, hides OAuth methods without a client id, and never offers a secret-bound browser flow", () => {
    const github = PROVIDERS.find((provider) => provider.id === "github")!;
    expect(methodAvailability(github, {})).toEqual([
      { method: "device", status: "unavailable", reason: "no-client-id" },
      { method: "token", status: "available" },
      { method: "cli", status: "unavailable", reason: "host-only" },
    ]);
    expect(methodAvailability(github, { github: "Iv1.abc" })[0]).toEqual({
      method: "device",
      status: "available",
    });
    for (const id of ["jira", "bitbucket"]) {
      const provider = PROVIDERS.find((entry) => entry.id === id)!;
      expect(methodAvailability(provider, { [id]: "client" })[0]).toEqual({
        method: "browser",
        status: "needs-broker",
      });
    }
    for (const provider of PROVIDERS) expect(provider.methods).toContain("token");
  });

  it("refuses to begin a method that is not available", async () => {
    const { flows } = flowsWith({});
    await expect(flows.begin({ connector: "github", method: "device" })).rejects.toThrow(
      "not available",
    );
    await expect(
      flows.begin({ connector: "jira", method: "browser", site: "acme.atlassian.net" }),
    ).rejects.toThrow("not available");
    await expect(flows.begin({ connector: "nope", method: "token" })).rejects.toThrow(
      "Unknown connector",
    );
  });
});

describe("token flow", () => {
  it("validates a GitHub token against the provider and returns the account", async () => {
    const { flows, http } = flowsWith({
      routes: {
        "https://api.github.com/user": (init) =>
          header(init, "Authorization") === "Bearer ghp_valid"
            ? json({ login: "octocat" })
            : json({}, 401),
      },
    });
    const begun = await flows.begin({ connector: "github", method: "token" });
    expect(begun).toMatchObject({ method: "token" });
    expect(begun.authUrl).toBeUndefined();

    await expect(
      flows.complete(begun.flowId, { kind: "token", token: "ghp_wrong" }),
    ).rejects.toThrow("refused");
    // A refused token leaves the flow open for another try.
    const result = await flows.complete(begun.flowId, { kind: "token", token: " ghp_valid " });
    expect(result).toMatchObject({
      status: "connected",
      connector: "github",
      site: null,
      method: "token",
      displayName: "octocat (GitHub)",
      secret: { accessToken: "ghp_valid", scheme: "bearer" },
    });
    expect(http.calls).toHaveLength(2);
    await expect(
      flows.complete(begun.flowId, { kind: "token", token: "ghp_valid" }),
    ).rejects.toThrow("finished or expired");
  });

  it("sends Jira Cloud tokens with the account email over https to the named site only", async () => {
    const expected = `Basic ${Buffer.from("me@example.test:atl-token").toString("base64")}`;
    const { flows, http } = flowsWith({
      routes: {
        "https://acme.atlassian.net/rest/api/3/myself": (init) =>
          header(init, "Authorization") === expected ? json({ displayName: "Ada" }) : json({}, 401),
      },
    });
    await expect(flows.begin({ connector: "jira", method: "token" })).rejects.toThrow(
      "needs a site",
    );
    await expect(
      flows.begin({ connector: "jira", method: "token", site: "https://evil.test/path" }),
    ).rejects.toThrow("host name");
    const begun = await flows.begin({
      connector: "jira",
      method: "token",
      site: "https://Acme.atlassian.net/",
    });
    await expect(
      flows.complete(begun.flowId, { kind: "token", token: "atl-token" }),
    ).rejects.toThrow("email");
    const result = await flows.complete(begun.flowId, {
      kind: "token",
      token: "atl-token",
      email: "me@example.test",
    });
    expect(result).toMatchObject({
      status: "connected",
      site: "acme.atlassian.net",
      displayName: "Ada (Jira)",
      secret: { accessToken: "atl-token", email: "me@example.test", scheme: "basic" },
    });
    expect(http.calls.map((call) => call.url)).toEqual([
      "https://acme.atlassian.net/rest/api/3/myself",
    ]);
    expect(http.calls[0].init?.redirect).toBe("error");
  });

  it("sends Bitbucket Data Center tokens as Bearer, or as Basic with a username for a personal token", async () => {
    const seen: string[] = [];
    const { flows } = flowsWith({
      routes: {
        "https://git.example.test/rest/api/1.0/profile/recent/repos": (init) => {
          seen.push(header(init, "Authorization") ?? "");
          return new Response("{}", { status: 200, headers: { "X-AUSERNAME": "ada" } });
        },
      },
    });
    const bearer = await flows.begin({
      connector: "bitbucket-dc",
      method: "token",
      site: "git.example.test",
    });
    await expect(
      flows.complete(bearer.flowId, { kind: "token", token: "bbdc-token" }),
    ).resolves.toMatchObject({
      displayName: "ada (Bitbucket Data Center)",
      secret: { accessToken: "bbdc-token", scheme: "bearer" },
    });
    const basic = await flows.begin({
      connector: "bitbucket-dc",
      method: "token",
      site: "git.example.test",
    });
    await expect(
      flows.complete(basic.flowId, { kind: "token", token: "bbdc-token", email: "ada" }),
    ).resolves.toMatchObject({ secret: { scheme: "basic", email: "ada" } });
    expect(seen).toEqual([
      "Bearer bbdc-token",
      `Basic ${Buffer.from("ada:bbdc-token").toString("base64")}`,
    ]);

    const github = await flows.begin({ connector: "github", method: "token" });
    await expect(
      flows.complete(github.flowId, { kind: "token", token: "ghp_x", email: "me@example.test" }),
    ).rejects.toThrow("without an email");
  });

  it("expires after ten minutes", async () => {
    const { flows, clock } = flowsWith({});
    const begun = await flows.begin({ connector: "github", method: "token" });
    clock.value += 10 * 60 * 1000 + 1;
    await expect(flows.complete(begun.flowId, { kind: "token", token: "x" })).rejects.toThrow(
      "expired",
    );
  });
});

describe("device flow (GitHub)", () => {
  it("starts with a user code, stays pending, honours slow_down, and connects without a client secret", async () => {
    const tokenAnswers = [
      json({ error: "authorization_pending" }),
      json({ error: "slow_down", interval: 10 }),
      json({
        access_token: "gho_device",
        refresh_token: "ghr_refresh",
        expires_in: 28800,
        scope: "repo,read:org",
      }),
    ];
    const { flows, http, clock } = flowsWith({
      clientIds: { github: "Iv1.public" },
      routes: {
        "https://github.com/login/device/code": () =>
          json({
            device_code: "dev-123",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          }),
        "https://github.com/login/oauth/access_token": () => tokenAnswers.shift()!,
        "https://api.github.com/user": () => json({ login: "octocat" }),
      },
    });
    const begun = await flows.begin({ connector: "github", method: "device" });
    expect(begun).toMatchObject({
      method: "device",
      userCode: "ABCD-1234",
      verifyUrl: "https://github.com/login/device",
    });
    expect(form(http.calls[0].init).get("client_id")).toBe("Iv1.public");

    // Too early: no request is made.
    await expect(flows.complete(begun.flowId, { kind: "poll" })).resolves.toEqual({
      status: "pending",
      retryAfterSeconds: 5,
    });
    expect(http.calls).toHaveLength(1);

    clock.value += 5000;
    await expect(flows.complete(begun.flowId, { kind: "poll" })).resolves.toMatchObject({
      status: "pending",
    });
    clock.value += 5000;
    await expect(flows.complete(begun.flowId, { kind: "poll" })).resolves.toEqual({
      status: "pending",
      retryAfterSeconds: 10,
    });
    clock.value += 10_000;
    const result = await flows.complete(begun.flowId, { kind: "poll" });
    expect(result).toMatchObject({
      status: "connected",
      method: "device",
      displayName: "octocat (GitHub)",
      scopes: ["repo", "read:org"],
      expiresAt: new Date(clock.value + 28_800_000).toISOString(),
      secret: { accessToken: "gho_device", refreshToken: "ghr_refresh", scheme: "bearer" },
    });
    for (const call of http.calls) {
      expect(form(call.init).has("client_secret")).toBe(false);
    }
    const pollBody = form(http.calls[1].init);
    expect(pollBody.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(pollBody.get("device_code")).toBe("dev-123");
  });

  it("ends the flow when the user declines", async () => {
    const { flows, clock } = flowsWith({
      clientIds: { github: "Iv1.public" },
      routes: {
        "https://github.com/login/device/code": () =>
          json({
            device_code: "d",
            user_code: "U",
            verification_uri: "https://github.com/login/device",
            interval: 5,
          }),
        "https://github.com/login/oauth/access_token": () => json({ error: "access_denied" }),
      },
    });
    const begun = await flows.begin({ connector: "github", method: "device" });
    clock.value += 5000;
    await expect(flows.complete(begun.flowId, { kind: "poll" })).rejects.toThrow("declined");
    await expect(flows.complete(begun.flowId, { kind: "poll" })).rejects.toThrow(
      "finished or expired",
    );
  });

  it("refuses a verification page that is not https", async () => {
    const { flows } = flowsWith({
      clientIds: { github: "Iv1.public" },
      routes: {
        "https://github.com/login/device/code": () =>
          json({ device_code: "d", user_code: "U", verification_uri: "http://phish.test/" }),
      },
    });
    await expect(flows.begin({ connector: "github", method: "device" })).rejects.toThrow(
      "did not start",
    );
  });
});

describe("browser flow (authorization code + PKCE, public client)", () => {
  const routes = {
    "https://auth.example.test/token": () =>
      json({ access_token: "at-browser", refresh_token: "rt-browser", expires_in: 3600 }),
    "https://api.example.test/me": () => json({}),
  };

  async function beginApp() {
    const setup = flowsWith({ routes, clientIds: { publicforge: "public-client" } });
    const begun = await setup.flows.begin({ connector: "publicforge", method: "browser" });
    const authUrl = new URL(begun.authUrl!);
    return { ...setup, begun, authUrl };
  }

  it("issues an S256 challenge for the fulcra:// redirect and exchanges the code with the verifier and no secret", async () => {
    const { flows, http, begun, authUrl } = await beginApp();
    expect(authUrl.origin + authUrl.pathname).toBe("https://auth.example.test/authorize");
    expect(authUrl.searchParams.get("redirect_uri")).toBe(`fulcra://oauth/${begun.flowId}`);
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const state = authUrl.searchParams.get("state")!;
    expect(state.length).toBeGreaterThanOrEqual(43);

    const callback = `fulcra://oauth/${begun.flowId}?code=the-code&state=${state}`;
    expect(flows.flowIdForCallback(callback)).toBe(begun.flowId);
    const result = await flows.complete(begun.flowId, { kind: "callback", url: callback });
    expect(result).toMatchObject({
      status: "connected",
      method: "browser",
      displayName: "octo (Public Forge)",
      secret: { accessToken: "at-browser", refreshToken: "rt-browser" },
    });
    const exchange = form(http.calls[0].init);
    expect(exchange.get("grant_type")).toBe("authorization_code");
    expect(exchange.get("code")).toBe("the-code");
    expect(exchange.get("redirect_uri")).toBe(`fulcra://oauth/${begun.flowId}`);
    expect(exchange.has("client_secret")).toBe(false);
    expect(pkceChallenge(exchange.get("code_verifier")!)).toBe(
      authUrl.searchParams.get("code_challenge"),
    );
  });

  it("rejects a callback with the wrong state and ends the flow without exchanging", async () => {
    const { flows, http, begun } = await beginApp();
    await expect(
      flows.complete(begun.flowId, {
        kind: "callback",
        url: `fulcra://oauth/${begun.flowId}?code=c&state=forged`,
      }),
    ).rejects.toThrow("does not belong");
    expect(http.calls).toHaveLength(0);
    await expect(
      flows.complete(begun.flowId, {
        kind: "callback",
        url: `fulcra://oauth/${begun.flowId}?code=c`,
      }),
    ).rejects.toThrow("finished or expired");
  });

  it("rejects a callback for another flow's path, and a replayed callback", async () => {
    const { flows, begun, authUrl } = await beginApp();
    const state = authUrl.searchParams.get("state")!;
    const other = "00000000-0000-4000-8000-000000000000";
    await expect(
      flows.complete(begun.flowId, {
        kind: "callback",
        url: `fulcra://oauth/${other}?code=c&state=${state}`,
      }),
    ).rejects.toThrow("does not belong");

    const second = await flows.begin({ connector: "publicforge", method: "browser" });
    const secondState = new URL(second.authUrl!).searchParams.get("state")!;
    const good = `fulcra://oauth/${second.flowId}?code=c&state=${secondState}`;
    await expect(
      flows.complete(second.flowId, { kind: "callback", url: good }),
    ).resolves.toMatchObject({
      status: "connected",
    });
    await expect(flows.complete(second.flowId, { kind: "callback", url: good })).rejects.toThrow(
      "finished or expired",
    );
  });

  it("reports a provider-side refusal and ignores non-callback URLs", async () => {
    const { flows, begun, authUrl } = await beginApp();
    const state = authUrl.searchParams.get("state")!;
    await expect(
      flows.complete(begun.flowId, {
        kind: "callback",
        url: `fulcra://oauth/${begun.flowId}?error=access_denied&state=${state}`,
      }),
    ).rejects.toThrow("declined");
    expect(() => flows.flowIdForCallback("https://evil.test/oauth/x")).toThrow(
      "Not a sign-in callback",
    );
    expect(() => flows.flowIdForCallback("fulcra://settings/x")).toThrow("Not a sign-in callback");
  });

  it("uses a loopback redirect on desktop and finishes when the listener receives the callback", async () => {
    let deliver: ((url: string) => void) | null = null;
    let closed = false;
    const inFlight: Promise<unknown>[] = [];
    const http = mockFetch(routes);
    const flows = new SignInFlows({
      providers: [PUBLIC_BROWSER_PROVIDER],
      clientIds: () => ({ publicforge: "public-client" }),
      fetch: http.fetch,
      openLoopback: async (onCallback) => {
        deliver = onCallback;
        return { origin: "http://127.0.0.1:49152", close: () => (closed = true) };
      },
      onLoopbackCallback: (_flowId, result) => inFlight.push(result),
    });
    const begun = await flows.begin({
      connector: "publicforge",
      method: "browser",
      redirect: "loopback",
    });
    const authUrl = new URL(begun.authUrl!);
    expect(authUrl.searchParams.get("redirect_uri")).toBe(
      `http://127.0.0.1:49152/oauth/${begun.flowId}`,
    );
    deliver!(
      `http://127.0.0.1:49152/oauth/${begun.flowId}?code=c&state=${authUrl.searchParams.get("state")}`,
    );
    await expect(inFlight[0]).resolves.toMatchObject({ status: "connected" });
    expect(closed).toBe(true);
  });
});

describe("single-flight and expiry", () => {
  function deferred<Value>() {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it("lets only one of two concurrent token completions run, and connects once", async () => {
    const identity = deferred<Response>();
    let calls = 0;
    const { flows } = flowsWith({
      routes: {
        "https://api.github.com/user": () => {
          calls += 1;
          return identity.promise as unknown as Response;
        },
      },
    });
    const begun = await flows.begin({ connector: "github", method: "token" });
    const first = flows.complete(begun.flowId, { kind: "token", token: "ghp_one" });
    const second = flows.complete(begun.flowId, { kind: "token", token: "ghp_two" });
    await expect(second).rejects.toThrow("already being finished");
    identity.resolve(json({ login: "octocat" }));
    await expect(first).resolves.toMatchObject({ status: "connected" });
    expect(calls).toBe(1);
    await expect(flows.complete(begun.flowId, { kind: "token", token: "ghp_one" })).rejects.toThrow(
      "finished or expired",
    );
  });

  it("refuses a second device poll while a slow one is in flight, and discards a result that lands after expiry", async () => {
    const slow = deferred<Response>();
    const { flows, clock } = flowsWith({
      clientIds: { github: "Iv1.public" },
      routes: {
        "https://github.com/login/device/code": () =>
          json({
            device_code: "d",
            user_code: "U",
            verification_uri: "https://github.com/login/device",
            expires_in: 600,
            interval: 5,
          }),
        "https://github.com/login/oauth/access_token": () => slow.promise as unknown as Response,
        "https://api.github.com/user": () => json({ login: "octocat" }),
      },
    });
    const begun = await flows.begin({ connector: "github", method: "device" });
    clock.value += 5000;
    const poll = flows.complete(begun.flowId, { kind: "poll" });
    clock.value += 10_000;
    await expect(flows.complete(begun.flowId, { kind: "poll" })).rejects.toThrow(
      "already being finished",
    );
    clock.value += 600_000;
    slow.resolve(json({ access_token: "gho_late" }));
    await expect(poll).rejects.toThrow("expired or was cancelled");
  });

  it("counts flows that are still starting against the limit", async () => {
    const hold = deferred<Response>();
    const { flows } = flowsWith({
      clientIds: { github: "Iv1.public" },
      routes: { "https://github.com/login/device/code": () => hold.promise as unknown as Response },
    });
    const starting = Array.from({ length: 16 }, () =>
      flows.begin({ connector: "github", method: "device" }),
    );
    await expect(flows.begin({ connector: "github", method: "token" })).rejects.toThrow(
      "Too many sign-ins",
    );
    hold.resolve(json({}));
    await Promise.allSettled(starting);
  });

  it("closes an abandoned loopback listener when the flow's expiry timer fires", async () => {
    vi.useFakeTimers();
    try {
      let closed = false;
      const flows = new SignInFlows({
        providers: [PUBLIC_BROWSER_PROVIDER],
        clientIds: () => ({ publicforge: "public-client" }),
        fetch: mockFetch({}).fetch,
        openLoopback: async () => ({
          origin: "http://127.0.0.1:49152",
          close: () => (closed = true),
        }),
      });
      await flows.begin({ connector: "publicforge", method: "browser", redirect: "loopback" });
      expect(flows.activeFlowCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 10);
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a reconnect in progress for a disconnected account", async () => {
    const { flows } = flowsWith({});
    const begun = await flows.begin({
      connector: "github",
      method: "token",
      replaceAccountId: "00000000-0000-4000-8000-000000000009",
      replaceGeneration: 1,
    });
    flows.cancelForAccount("00000000-0000-4000-8000-000000000009");
    await expect(flows.complete(begun.flowId, { kind: "token", token: "x" })).rejects.toThrow(
      "finished or expired",
    );
  });
});
