import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CredentialAccountSchema,
  createFileAccountsStore,
  createMemoryAccountsStore,
} from "./accounts-store.js";
import { CREDENTIALS_SERVICE, createMemoryCredentialBackend } from "./credential-backend.js";
import { CredentialService } from "./credential-service.js";

const GITHUB_TOKEN = "ghp_CANARY_github_0123456789";
const JIRA_TOKEN = "atl_CANARY_jira_0123456789";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function providerFetch(overrides: Record<string, () => Response> = {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    const override = Object.keys(overrides).find((prefix) => url.startsWith(prefix));
    if (override) return overrides[override]();
    if (url === "https://api.github.com/user") return json({ login: "octocat" });
    if (url === "https://acme.atlassian.net/rest/api/3/myself") return json({ displayName: "Ada" });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
}

function service(
  options: {
    now?: { value: number };
    fetch?: typeof fetch;
    clientIds?: Record<string, string>;
    backendItems?: Record<string, string>;
  } = {},
) {
  const backend = createMemoryCredentialBackend(options.backendItems);
  const accounts = createMemoryAccountsStore();
  const clock = options.now ?? { value: Date.parse("2026-09-24T10:00:00Z") };
  let changes = 0;
  const credentials = new CredentialService({
    accounts,
    backend,
    fetch: options.fetch ?? providerFetch(),
    clientIds: () => options.clientIds ?? {},
    now: () => clock.value,
    onAccountsChanged: () => (changes += 1),
  });
  return { credentials, backend, accounts, clock, changes: () => changes };
}

async function connectToken(
  credentials: CredentialService,
  input: { connector: string; token: string; site?: string; email?: string },
) {
  const begun = await credentials.begin({
    connector: input.connector,
    method: "token",
    site: input.site,
  });
  const outcome = await credentials.complete(begun.flowId, {
    kind: "token",
    token: input.token,
    email: input.email,
  });
  if (outcome.status !== "connected") throw new Error("expected a connected account");
  return outcome.account;
}

describe("credential store", () => {
  it("keeps metadata in the accounts file and the secret only in the OS store", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "fulcra-accounts-"));
    try {
      const filePath = path.join(directory, "integrations", "accounts.json");
      const backend = createMemoryCredentialBackend();
      const credentials = new CredentialService({
        accounts: createFileAccountsStore(filePath),
        backend,
        fetch: providerFetch(),
      });
      const account = await connectToken(credentials, { connector: "github", token: GITHUB_TOKEN });
      expect(account).toMatchObject({
        version: 1,
        connector: "github",
        site: null,
        displayName: "octocat (GitHub)",
        method: "token",
        state: "connected",
        expiresAt: null,
      });
      const onDisk = readFileSync(filePath, "utf8");
      expect(onDisk).toContain(account.id);
      expect(onDisk).not.toContain("CANARY");
      expect(JSON.parse(backend.items.get(`${CREDENTIALS_SERVICE}/${account.id}`)!)).toEqual({
        accessToken: GITHUB_TOKEN,
        scheme: "bearer",
      });
      const listed = await credentials.list();
      expect(listed.accounts).toEqual([account]);
      expect(JSON.stringify(listed)).not.toContain("CANARY");
      expect(listed.providers.map((provider) => provider.connector)).toEqual([
        "github",
        "jira",
        "jira-dc",
        "bitbucket",
        "bitbucket-dc",
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("removes the secret together with the account", async () => {
    const { credentials, backend } = service();
    const account = await connectToken(credentials, { connector: "github", token: GITHUB_TOKEN });
    await expect(credentials.remove(account.id)).resolves.toBe(true);
    expect(backend.items.size).toBe(0);
    await expect(credentials.list()).resolves.toMatchObject({ accounts: [] });
    await expect(credentials.remove(account.id)).resolves.toBe(false);
  });

  it("reconnect replaces the secret but keeps the account id and creation time", async () => {
    const { credentials, backend, clock } = service();
    const account = await connectToken(credentials, { connector: "github", token: GITHUB_TOKEN });
    clock.value += 60_000;
    const begun = await credentials.reconnect(account.id);
    expect(begun.method).toBe("token");
    const outcome = await credentials.complete(begun.flowId, {
      kind: "token",
      token: "ghp_second_token_value",
    });
    expect(outcome).toMatchObject({
      status: "connected",
      account: { id: account.id, createdAt: account.createdAt },
    });
    expect(JSON.parse(backend.items.get(`${CREDENTIALS_SERVICE}/${account.id}`)!).accessToken).toBe(
      "ghp_second_token_value",
    );
    expect((await credentials.list()).accounts).toHaveLength(1);
  });
});

// A fake provider API that echoes the credential back in every way it could leak: body, JSON
// string, URL-encoded form and a response header. The host must scrub all of them.
function echoingApi(calls: Array<{ url: string; init: RequestInit | undefined }>) {
  return (url: string, init: RequestInit | undefined) => {
    calls.push({ url, init });
    const authorization = (init?.headers as Record<string, string>)?.Authorization ?? "";
    const token = authorization.slice(authorization.indexOf(" ") + 1);
    return new Response(
      JSON.stringify({
        seen: authorization,
        token,
        encoded: encodeURIComponent(token),
        issues: [{ title: "Fix the build" }],
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ETag: `"${token}"`,
          "Set-Cookie": `session=${token}`,
          "X-RateLimit-Remaining": "4999",
        },
      },
    );
  };
}

function apiFetch(handler: (url: string, init: RequestInit | undefined) => Response): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://api.github.com/user" && !init?.method) return json({ login: "octocat" });
    if (url === "https://acme.atlassian.net/rest/api/3/myself") return json({ displayName: "Ada" });
    return handler(url, init);
  }) as typeof fetch;
}

describe("plugin access: host-mediated requests (CONTRACTS §7.2 v1.7)", () => {
  it("attaches the credential itself and returns an answer with every form of it scrubbed", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const { credentials } = service({ fetch: apiFetch(echoingApi(calls)) });
    const account = await connectToken(credentials, { connector: "github", token: GITHUB_TOKEN });
    const response = await credentials.request({
      grants: ["github"],
      writeGranted: false,
      accountId: account.id,
      connector: "github",
      request: {
        method: "GET",
        path: "/repos/acme/app/issues",
        query: { state: "open", per_page: 5 },
      },
    });
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/app/issues?state=open&per_page=5");
    expect(calls[0].init?.redirect).toBe("manual");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ issues: [{ title: "Fix the build" }] });
    expect(response.headers).toEqual({
      "content-type": "application/json",
      etag: '"[redacted]"',
      "x-ratelimit-remaining": "4999",
    });
    expect(JSON.stringify(response)).not.toContain("CANARY");
  });

  it("scrubs a Basic credential and its base64 form for Jira Cloud", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const { credentials } = service({ fetch: apiFetch(echoingApi(calls)) });
    const account = await connectToken(credentials, {
      connector: "jira",
      token: JIRA_TOKEN,
      site: "acme.atlassian.net",
      email: "fixture@example.test",
    });
    const response = await credentials.request({
      grants: ["jira"],
      writeGranted: false,
      accountId: account.id,
      connector: "jira",
      request: { method: "GET", path: "/rest/api/3/search", query: { jql: "project = APP" } },
    });
    expect(calls[0].url).toBe("https://acme.atlassian.net/rest/api/3/search?jql=project+%3D+APP");
    const encoded = Buffer.from(`fixture@example.test:${JIRA_TOKEN}`).toString("base64");
    expect(JSON.stringify(response)).not.toContain(encoded);
    expect(JSON.stringify(response)).not.toContain("CANARY");
  });

  it("refuses undeclared connectors, other connectors' accounts, writes, auth headers and unsafe paths", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const { credentials } = service({ fetch: apiFetch(echoingApi(calls)) });
    const github = await connectToken(credentials, { connector: "github", token: GITHUB_TOKEN });
    const jira = await connectToken(credentials, {
      connector: "jira",
      token: JIRA_TOKEN,
      site: "acme.atlassian.net",
      email: "fixture@example.test",
    });
    const get = (
      request: unknown,
      extra: Partial<{
        grants: string[];
        accountId: string;
        connector: string;
        writeGranted: boolean;
      }> = {},
    ) =>
      credentials.request({
        grants: ["github"],
        writeGranted: false,
        accountId: github.id,
        connector: "github",
        request,
        ...extra,
      });
    await expect(
      get({ method: "GET", path: "/rest/api/3/myself" }, { accountId: jira.id, connector: "jira" }),
    ).rejects.toThrow('did not declare "jira"');
    await expect(get({ method: "GET", path: "/user" }, { accountId: jira.id })).rejects.toThrow(
      "No github account with that id",
    );
    await expect(
      get({ method: "POST", path: "/repos/a/b/issues", body: { title: "x" } }),
    ).rejects.toThrow("credentialsWrite");
    await expect(
      get({ method: "GET", path: "/user", headers: { Authorization: "Bearer mine" } }),
    ).rejects.toThrow("set by the host");
    await expect(get({ method: "GET", path: "/user", headers: { Cookie: "a=b" } })).rejects.toThrow(
      "set by the host",
    );
    for (const unsafePath of [
      "//evil.test/x",
      "/../x",
      "/repos/%2e%2e/x",
      "/a?x=1",
      "/a#b",
      "user",
      "/@evil.test",
    ]) {
      await expect(get({ method: "GET", path: unsafePath })).rejects.toThrow();
    }
    await expect(
      get(
        { method: "GET", path: "/wiki/x" },
        { grants: ["jira"], accountId: jira.id, connector: "jira" },
      ),
    ).rejects.toThrow("/rest/api/");
    expect(calls).toEqual([]);
  });

  it("allows Jira's dev-status and agile paths for GET only, even with write permission", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const { credentials } = service({ fetch: apiFetch(echoingApi(calls)) });
    const jira = await connectToken(credentials, {
      connector: "jira",
      token: JIRA_TOKEN,
      site: "acme.atlassian.net",
      email: "fixture@example.test",
    });
    const request = (method: "GET" | "POST", apiPath: string) =>
      credentials.request({
        grants: ["jira"],
        writeGranted: true,
        accountId: jira.id,
        connector: "jira",
        request: { method, path: apiPath, ...(method === "POST" ? { body: {} } : {}) },
      });
    await expect(request("GET", "/rest/dev-status/latest/issue/detail")).resolves.toMatchObject({
      status: 200,
    });
    await expect(request("GET", "/rest/agile/1.0/board")).resolves.toMatchObject({ status: 200 });
    await expect(request("POST", "/rest/agile/1.0/sprint")).rejects.toThrow("read-only");
    await expect(request("POST", "/rest/dev-status/x")).rejects.toThrow("read-only");
    await expect(request("GET", "/rest/agile/2.0/board")).rejects.toThrow();
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/rest/dev-status/latest/issue/detail",
      "/rest/agile/1.0/board",
    ]);
  });

  it("follows a same-API redirect with the credential but stops at another origin", async () => {
    const seen: string[] = [];
    const { credentials } = service({
      fetch: apiFetch((url, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seen.push(`${url} ${headers.Authorization ? "auth" : "none"}`);
        if (url.endsWith("/moved")) {
          return new Response(null, { status: 301, headers: { Location: "/repos/acme/app" } });
        }
        if (url.endsWith("/away")) {
          return new Response(null, {
            status: 302,
            headers: { Location: "https://evil.test/steal" },
          });
        }
        return json({ ok: true });
      }),
    });
    const account = await connectToken(credentials, { connector: "github", token: GITHUB_TOKEN });
    const request = (apiPath: string) =>
      credentials.request({
        grants: ["github"],
        writeGranted: false,
        accountId: account.id,
        connector: "github",
        request: { method: "GET", path: apiPath },
      });
    await expect(request("/moved")).resolves.toMatchObject({ status: 200, body: { ok: true } });
    await expect(request("/away")).rejects.toThrow("another site");
    expect(seen).toEqual([
      "https://api.github.com/moved auth",
      "https://api.github.com/repos/acme/app auth",
      "https://api.github.com/away auth",
    ]);
  });

  it("limits requests per account", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const { credentials, clock } = service({ fetch: apiFetch(echoingApi(calls)) });
    const account = await connectToken(credentials, { connector: "github", token: GITHUB_TOKEN });
    const request = () =>
      credentials.request({
        grants: ["github"],
        writeGranted: false,
        accountId: account.id,
        connector: "github",
        request: { method: "GET", path: "/user/issues" },
      });
    for (let index = 0; index < 120; index += 1) await request();
    await expect(request()).rejects.toThrow("Too many requests");
    clock.value += 60_000;
    await expect(request()).resolves.toMatchObject({ status: 200 });
  });

  it("marks an account whose secret disappeared as needs-reconnect", async () => {
    const { credentials, backend } = service({ fetch: apiFetch(echoingApi([])) });
    const account = await connectToken(credentials, { connector: "github", token: GITHUB_TOKEN });
    backend.items.clear();
    await expect(
      credentials.request({
        grants: ["github"],
        writeGranted: false,
        accountId: account.id,
        connector: "github",
        request: { method: "GET", path: "/user" },
      }),
    ).rejects.toThrow("reconnected");
    expect((await credentials.list()).accounts[0].state).toBe("needs-reconnect");
  });
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// A device-flow GitHub account that is about to expire, with the refresh answer under test control.
async function deviceAccount(refresh: () => Response | Promise<Response>) {
  const clock = { value: Date.parse("2026-09-24T10:00:00Z") };
  const deviceAnswers = [
    json({ access_token: "gho_first", refresh_token: "ghr_1", expires_in: 3600 }),
  ];
  let refreshCalls = 0;
  const setup = service({
    now: clock,
    clientIds: { github: "Iv1.public" },
    fetch: providerFetch({
      "https://github.com/login/device/code": () =>
        json({
          device_code: "d",
          user_code: "U",
          verification_uri: "https://github.com/login/device",
          interval: 5,
        }),
      "https://github.com/login/oauth/access_token": () => {
        const first = deviceAnswers.shift();
        if (first) return first;
        refreshCalls += 1;
        return refresh() as Response;
      },
    }),
  });
  const begun = await setup.credentials.begin({ connector: "github", method: "device" });
  clock.value += 5000;
  const outcome = await setup.credentials.complete(begun.flowId, { kind: "poll" });
  if (outcome.status !== "connected") throw new Error("expected connected");
  clock.value += 3600_000;
  return { ...setup, clock, id: outcome.account.id, refreshCalls: () => refreshCalls };
}

describe("refresh and lifecycle (R-J5b-4/-5)", () => {
  it("refreshes an expiring device-flow token without a secret, and falls back to needs-reconnect", async () => {
    let answer = json({ access_token: "gho_refreshed", refresh_token: "ghr_2", expires_in: 3600 });
    const { credentials, backend, clock, id } = await deviceAccount(() => answer);
    await expect(credentials.githubTokenForHost("github.com")).resolves.toBe("gho_refreshed");
    expect(JSON.parse(backend.items.get(`${CREDENTIALS_SERVICE}/${id}`)!).refreshToken).toBe(
      "ghr_2",
    );
    clock.value += 3600_000;
    answer = json({ error: "bad_refresh_token" }, 400);
    // The forge token cache (60 s) has long expired at this clock.
    await expect(credentials.githubTokenForHost("github.com")).resolves.toBeNull();
    expect((await credentials.list()).accounts[0].state).toBe("needs-reconnect");
  });

  it("shares one refresh between concurrent callers", async () => {
    const answer = deferred<Response>();
    const { credentials, refreshCalls, id } = await deviceAccount(
      () => answer.promise as unknown as Response,
    );
    const secretFor = () =>
      credentials.request({
        grants: ["github"],
        writeGranted: false,
        accountId: id,
        connector: "github",
        request: { method: "GET", path: "/user" },
      });
    const first = secretFor();
    const second = secretFor();
    answer.resolve(json({ access_token: "gho_new", refresh_token: "ghr_new", expires_in: 3600 }));
    await Promise.allSettled([first, second]);
    expect(refreshCalls()).toBe(1);
  });

  it("does not let an in-flight refresh resurrect a disconnected account", async () => {
    const answer = deferred<Response>();
    const { credentials, backend, id } = await deviceAccount(
      () => answer.promise as unknown as Response,
    );
    const pending = credentials.githubTokenForHost("github.com");
    await expect(credentials.remove(id)).resolves.toBe(true);
    answer.resolve(json({ access_token: "gho_late", refresh_token: "ghr_late", expires_in: 3600 }));
    await expect(pending).resolves.toBeNull();
    expect(backend.items.size).toBe(0);
    await expect(credentials.list()).resolves.toMatchObject({ accounts: [] });
  });

  // A GitHub fake whose device polls and refreshes are answered separately, each by a deferred
  // the test releases, so refresh and reconnect can be interleaved exactly.
  function interleavingHarness() {
    const clock = { value: Date.parse("2026-09-24T10:00:00Z") };
    const refreshes: Array<ReturnType<typeof deferred<Response>>> = [];
    const polls: Response[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.github.com/user") return json({ login: "octocat" });
      if (url === "https://github.com/login/device/code") {
        return json({
          device_code: "d",
          user_code: "U",
          verification_uri: "https://github.com/login/device",
          interval: 5,
        });
      }
      if (url === "https://github.com/login/oauth/access_token") {
        const grant = new URLSearchParams(String(init?.body ?? "")).get("grant_type");
        if (grant === "refresh_token") {
          const pending = deferred<Response>();
          refreshes.push(pending);
          return pending.promise;
        }
        return polls.shift() ?? json({ error: "authorization_pending" });
      }
      if (url.startsWith("https://api.github.com/")) {
        const authorization = ((init?.headers ?? {}) as Record<string, string>).Authorization;
        return json({ usedToken: authorization });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const setup = service({ now: clock, clientIds: { github: "Iv1.public" }, fetch: fetchImpl });
    async function connectDevice(accountId?: string) {
      const begun = accountId
        ? await setup.credentials.reconnect(accountId, { method: "device" })
        : await setup.credentials.begin({ connector: "github", method: "device" });
      clock.value += 5000;
      const outcome = await setup.credentials.complete(begun.flowId, { kind: "poll" });
      if (outcome.status !== "connected") throw new Error("expected connected");
      return outcome.account;
    }
    const call = (accountId: string) =>
      setup.credentials.request({
        grants: ["github"],
        writeGranted: false,
        accountId,
        connector: "github",
        request: { method: "GET", path: "/user/issues" },
      });
    return { ...setup, clock, refreshes, polls, connectDevice, call };
  }

  it("a refresh that started before a reconnect cannot replace the reconnected token (R-D-2)", async () => {
    const h = interleavingHarness();
    h.polls.push(json({ access_token: "gho_old", refresh_token: "ghr_old", expires_in: 3600 }));
    const account = await h.connectDevice();
    h.clock.value += 3600_000;
    const staleCall = h.call(account.id); // starts a refresh of the old identity
    await vi.waitFor(() => expect(h.refreshes).toHaveLength(1));

    const reconnect = await h.credentials.reconnect(account.id, { method: "token" });
    await h.credentials.complete(reconnect.flowId, { kind: "token", token: "ghp_new_identity" });

    h.refreshes[0].resolve(
      json({ access_token: "gho_old_refreshed", refresh_token: "ghr_2", expires_in: 3600 }),
    );
    await expect(staleCall).rejects.toThrow("reconnected or disconnected");
    const stored = JSON.parse(h.backend.items.get(`${CREDENTIALS_SERVICE}/${account.id}`)!);
    expect(stored.accessToken).toBe("ghp_new_identity");
    expect((await h.credentials.list()).accounts[0]).toMatchObject({
      method: "token",
      state: "connected",
    });
    await expect(h.call(account.id)).resolves.toMatchObject({
      body: { usedToken: "[redacted]" },
    });
  });

  it("a failing refresh that started before a reconnect does not mark the new account for reconnection", async () => {
    const h = interleavingHarness();
    h.polls.push(json({ access_token: "gho_old", refresh_token: "ghr_old", expires_in: 3600 }));
    const account = await h.connectDevice();
    h.clock.value += 3600_000;
    const staleCall = h.call(account.id);
    await vi.waitFor(() => expect(h.refreshes).toHaveLength(1));
    const reconnect = await h.credentials.reconnect(account.id, { method: "token" });
    await h.credentials.complete(reconnect.flowId, { kind: "token", token: "ghp_new_identity" });

    h.refreshes[0].resolve(json({ error: "bad_refresh_token" }, 400));
    await expect(staleCall).rejects.toThrow();
    expect((await h.credentials.list()).accounts[0]).toMatchObject({
      state: "connected",
      method: "token",
    });
  });

  it("a request after a reconnect starts its own refresh instead of joining the stale one", async () => {
    const h = interleavingHarness();
    h.polls.push(json({ access_token: "gho_old", refresh_token: "ghr_old", expires_in: 3600 }));
    const account = await h.connectDevice();
    h.clock.value += 3600_000;
    const staleCall = h.call(account.id);
    await vi.waitFor(() => expect(h.refreshes).toHaveLength(1));

    h.polls.push(json({ access_token: "gho_new", refresh_token: "ghr_new", expires_in: 3600 }));
    await h.connectDevice(account.id); // reconnect with a new device-flow identity
    h.clock.value += 3600_000; // the new identity now needs a refresh too
    const freshCall = h.call(account.id);
    await vi.waitFor(() => expect(h.refreshes).toHaveLength(2));

    h.refreshes[1].resolve(
      json({ access_token: "gho_new_refreshed", refresh_token: "ghr_n2", expires_in: 3600 }),
    );
    await expect(freshCall).resolves.toMatchObject({ status: 200 });
    h.refreshes[0].resolve(
      json({ access_token: "gho_old_refreshed", refresh_token: "ghr_o2", expires_in: 3600 }),
    );
    await expect(staleCall).rejects.toThrow("reconnected or disconnected");
    const stored = JSON.parse(h.backend.items.get(`${CREDENTIALS_SERVICE}/${account.id}`)!);
    expect(stored.accessToken).toBe("gho_new_refreshed");
  });

  it("keeps a revoked, retryable row when the OS store cannot confirm deletion", async () => {
    const { credentials, backend } = service();
    const account = await connectToken(credentials, { connector: "github", token: GITHUB_TOKEN });
    const realDelete = backend.delete;
    backend.delete = async () => {
      throw new Error("store unavailable");
    };
    await expect(credentials.remove(account.id)).rejects.toThrow("Couldn't remove");
    const [row] = (await credentials.list()).accounts;
    expect(row).toMatchObject({ id: account.id, state: "revoked" });
    // A revoked account is never used again, by plugins or the forge layer.
    await expect(credentials.githubTokenForHost("github.com")).resolves.toBeNull();
    await expect(credentials.reconnect(account.id)).rejects.toThrow("Couldn't remove");
    backend.delete = realDelete;
    await expect(credentials.remove(account.id)).resolves.toBe(true);
    expect(backend.items.size).toBe(0);
    await expect(credentials.list()).resolves.toMatchObject({ accounts: [] });
  });

  it("cancels a reconnect in progress when the account is disconnected", async () => {
    const { credentials, backend } = service();
    const account = await connectToken(credentials, { connector: "github", token: GITHUB_TOKEN });
    const begun = await credentials.reconnect(account.id);
    await credentials.remove(account.id);
    await expect(
      credentials.complete(begun.flowId, { kind: "token", token: "ghp_replacement" }),
    ).rejects.toThrow();
    expect(backend.items.size).toBe(0);
    await expect(credentials.list()).resolves.toMatchObject({ accounts: [] });
  });
});

describe("forge layer", () => {
  it("supplies the oldest connected github.com account token, and nothing for other hosts", async () => {
    const { credentials } = service();
    await expect(credentials.githubTokenForHost("github.com")).resolves.toBeNull();
    await connectToken(credentials, { connector: "github", token: GITHUB_TOKEN });
    await expect(credentials.githubTokenForHost("github.com")).resolves.toBe(GITHUB_TOKEN);
    await expect(credentials.githubTokenForHost(null)).resolves.toBe(GITHUB_TOKEN);
    await expect(credentials.githubTokenForHost("ghe.example.test")).resolves.toBeNull();
    // Cached between calls, and cleared the moment the account goes away.
    const [account] = (await credentials.list()).accounts;
    await credentials.remove(account.id);
    await expect(credentials.githubTokenForHost("github.com")).resolves.toBeNull();
  });
});

describe("migration from the plugin keychain namespace", () => {
  it("imports a J3 tracker token once and leaves the old item untouched", async () => {
    const legacyKey = "ai.fulcra.plugin.orca-organization/jira.acme:token";
    const { credentials, backend } = service({ backendItems: { [legacyKey]: `${JIRA_TOKEN}\n` } });
    const input = {
      pluginId: "orca-organization",
      secretName: "jira.acme:token",
      connector: "jira",
      site: "acme.atlassian.net",
      email: "me@example.test",
      grants: ["jira"],
    };
    const first = await credentials.importLegacy(input);
    expect(first).toMatchObject({
      imported: true,
      account: {
        connector: "jira",
        site: "acme.atlassian.net",
        method: "token",
        state: "connected",
      },
    });
    expect(backend.items.get(legacyKey)).toBe(`${JIRA_TOKEN}\n`);
    expect(JSON.parse(backend.items.get(`${CREDENTIALS_SERVICE}/${first.account.id}`)!)).toEqual({
      accessToken: JIRA_TOKEN,
      email: "me@example.test",
      scheme: "basic",
    });

    const second = await credentials.importLegacy(input);
    expect(second).toEqual({ imported: false, account: first.account });
    expect((await credentials.list()).accounts).toHaveLength(1);

    // Disconnecting the imported account does not let the old item be imported again.
    await credentials.remove(first.account.id);
    await expect(credentials.importLegacy(input)).rejects.toThrow("imported before");
    expect(backend.items.get(legacyKey)).toBe(`${JIRA_TOKEN}\n`);
  });

  it("imports only from the calling plugin's namespace and a declared connector", async () => {
    const { credentials } = service({
      backendItems: { "ai.fulcra.plugin.other-plugin/github:token": GITHUB_TOKEN },
    });
    await expect(
      credentials.importLegacy({
        pluginId: "orca-organization",
        secretName: "github:token",
        connector: "github",
        grants: ["github"],
      }),
    ).rejects.toThrow("no stored token");
    await expect(
      credentials.importLegacy({
        pluginId: "other-plugin",
        secretName: "github:token",
        connector: "github",
        grants: [],
      }),
    ).rejects.toThrow("did not declare");
    await expect(
      credentials.importLegacy({
        pluginId: "../escape",
        secretName: "github:token",
        connector: "github",
        grants: ["github"],
      }),
    ).rejects.toThrow("Invalid plugin id");
  });
});

describe("this Mac's GitHub sign-in (U7 W4)", () => {
  const signedIn = (...identities: { site: string | null; login: string; id: number }[]) => ({
    read: async () => ({ status: "signed-in" as const, identities }),
  });

  function withSignIn(
    hostSignIn: ConstructorParameters<typeof CredentialService>[0]["hostSignIn"],
  ) {
    const backend = createMemoryCredentialBackend();
    const accounts = createMemoryAccountsStore();
    const credentials = new CredentialService({
      accounts,
      backend,
      fetch: providerFetch(),
      now: () => Date.parse("2026-09-30T10:00:00Z"),
      hostSignIn,
    });
    return { credentials, accounts, backend };
  }

  it("lists the detected login as a connected GitHub account from this Mac's sign-in", async () => {
    const { credentials, accounts } = withSignIn(signedIn({ site: null, login: "example-user", id: 42 }));
    const listed = (await credentials.list()).accounts;
    expect(listed).toEqual([
      {
        version: 1,
        id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
        connector: "github",
        site: null,
        displayName: "example-user",
        method: "cli",
        scopes: [],
        state: "connected",
        expiresAt: null,
        lastCheckedAt: "2026-09-30T10:00:00.000Z",
        createdAt: "2026-09-30T10:00:00.000Z",
      },
    ]);
    // Stable across reads, valid under the stored-account schema, and never written to the store.
    expect((await credentials.list()).accounts[0].id).toBe(listed[0].id);
    expect(() => CredentialAccountSchema.parse(listed[0])).not.toThrow();
    expect(await accounts.list()).toEqual([]);
  });

  it("keeps an Enterprise sign-in on its own site", async () => {
    const { credentials } = withSignIn(
      signedIn(
        { site: null, login: "example-user", id: 42 },
        { site: "ghe.corp.example", login: "example-owner", id: 7 },
      ),
    );
    const listed = (await credentials.list()).accounts;
    expect(listed.map((a) => [a.site, a.displayName])).toEqual([
      [null, "example-user"],
      ["ghe.corp.example", "example-owner"],
    ]);
    expect(listed[0].id).not.toBe(listed[1].id);
  });

  it("a manually connected account for the same site wins", async () => {
    const { credentials } = withSignIn(
      signedIn(
        { site: null, login: "example-user", id: 42 },
        { site: "ghe.corp.example", login: "example-owner", id: 7 },
      ),
    );
    await connectToken(credentials, { connector: "github", token: GITHUB_TOKEN });
    const listed = (await credentials.list()).accounts;
    expect(listed.map((a) => [a.site, a.displayName, a.method])).toEqual([
      [null, "octocat (GitHub)", "token"],
      ["ghe.corp.example", "example-owner", "cli"],
    ]);
  });

  it("is only a name: no request, disconnect, reconnect or forge token uses it", async () => {
    const { credentials, accounts } = withSignIn(signedIn({ site: null, login: "example-user", id: 42 }));
    const [detected] = (await credentials.list()).accounts;
    await expect(
      credentials.request({
        grants: ["github"],
        writeGranted: false,
        accountId: detected.id,
        connector: "github",
        request: { method: "GET", path: "/user" },
      }),
    ).rejects.toThrow("No github account with that id");
    await expect(credentials.remove(detected.id)).resolves.toBe(false);
    await expect(credentials.reconnect(detected.id)).rejects.toThrow("No account with that id");
    // The PR panels keep using gh's own login exactly as before, and no needs-reconnect row appears.
    await expect(credentials.githubTokenForHost("github.com")).resolves.toBeNull();
    expect(await accounts.list()).toEqual([]);
    expect((await credentials.list()).accounts.map((a) => a.state)).toEqual(["connected"]);
  });

  it("lists nothing extra when gh is missing, signed out or failing, and never fails the list", async () => {
    for (const hostSignIn of [
      { read: async () => ({ status: "no-cli" as const }) },
      { read: async () => ({ status: "signed-out" as const }) },
      {
        read: async (): Promise<never> => {
          throw new Error("boom");
        },
      },
    ]) {
      const { credentials } = withSignIn(hostSignIn);
      await expect(credentials.list()).resolves.toMatchObject({ accounts: [] });
    }
  });

  it("keeps no token anywhere: the accounts file stays empty and the list carries none", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "fulcra-accounts-"));
    try {
      const filePath = path.join(directory, "integrations", "accounts.json");
      const credentials = new CredentialService({
        accounts: createFileAccountsStore(filePath),
        backend: createMemoryCredentialBackend(),
        fetch: providerFetch(),
        hostSignIn: signedIn({ site: null, login: "example-user", id: 42 }),
      });
      const listed = JSON.stringify(await credentials.list());
      expect(listed).toContain('"displayName":"example-user"');
      expect(listed).not.toMatch(/gh[opsu]_|github_pat_/);
      expect(() => readFileSync(filePath, "utf8")).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
