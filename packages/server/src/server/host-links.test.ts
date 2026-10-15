import express from "express";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import {
  watch,
  utimesSync,
  realpathSync,
  fsyncSync,
  fstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterEach, expect, test, vi } from "vitest";
import {
  HostLinks,
  type HostLinkChat,
  type HostLinkCreate,
  type HostLinkRoleNotice,
} from "./host-links.js";
import { startHostLimitSharing } from "./host-limit-sharing.js";
import { mountHostLinkRoutes } from "./host-link-routes.js";
import { HostLinkReceiptSchema, type HostLinkConfig } from "./host-link-contracts.js";
import {
  accountStatus,
  addAccount,
  assign,
  choose,
  markAccountLimited,
  publicView,
  readAccounts,
  rotate,
  setAccount,
  update,
} from "../../../../control/orca-organization/server/accounts.mjs";
import { createPoolUsage } from "../../../../control/orca-organization/server/pool-usage.js";
import { writePrivateFileAtomicSync } from "./private-files.js";
import {
  isAgentMcpRequestAuthorized,
  isBearerTokenValidAsync,
  isBearerTokenValidSync,
  createRequireBearerMiddleware,
} from "./auth.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fsyncSync: vi.fn(fs.fsyncSync), renameSync: vi.fn(fs.renameSync) };
});

const linkToken = `hlink1.${"A".repeat(43)}`;
const chatToken = `hchat1.${"B".repeat(43)}`;
const messageId = "11111111-1111-4111-8111-111111111111";
const spawn = {
  kind: "spawn",
  messageId,
  workload: "standard",
  workspace: "job",
  profile: "worker",
  title: "Worker",
  prompt: "Do this task.",
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.mocked(fsyncSync).mockRestore();
  vi.mocked(renameSync).mockRestore();
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});
function emptyConfig(): HostLinkConfig {
  return { version: 1, machine: "mac", chats: [], outgoing: [], incoming: [], routes: {} };
}
async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test listener.");
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  );
  return { server, url: `http://127.0.0.1:${address.port}` };
}
async function fixture() {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "host-links-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const created: HostLinkCreate[] = [];
  const notices: string[] = [];
  const prompts: string[] = [];
  const chats = new Map<string, HostLinkChat>([
    [
      "lead",
      {
        id: "lead",
        provider: "codex",
        modeId: "auto",
        model: "gpt-test",
        reportsTo: "role:main-assistant",
        archived: false,
        isLead: false,
      },
    ],
  ]);
  const state = {
    holder: "main",
    protected: true,
    now: Date.parse("2026-10-15T12:00:00Z"),
    failCreate: false,
    beforeNotice: () => {},
    afterCreate: () => {},
  };
  const deps = {
    home: path.join(root, "target"),
    now: () => state.now,
    serverId: "target",
    protected: () => state.protected,
    chat: async (id: string) => chats.get(id) ?? null,
    mainAssistant: () => state.holder || null,
    create: async (input: HostLinkCreate) => {
      input.check();
      if (state.failCreate) throw new Error("Creation reply lost.");
      created.push(input);
      chats.set(input.agentId, {
        id: input.agentId,
        provider: input.profile.provider,
        modeId: input.profile.modeId,
        model: input.profile.model,
        reportsTo: input.parent,
        archived: false,
        isLead: false,
      });
      state.afterCreate();
    },
    notice: async (input: HostLinkRoleNotice) => {
      state.beforeNotice();
      const target = input.currentTarget();
      if (!target) throw new Error("No role holder.");
      input.checkTarget(target);
      notices.push(`${target}:${input.text}`);
      return target;
    },
    prompt: async (input: { check: () => void; text: string }) => {
      input.check();
      prompts.push(input.text);
    },
    inspect: async (id: string) => ({ agentId: id, status: "idle", lastMessage: "Done." }),
    workerCurrent: (id: string, profile: { provider: string; modeId: string }, parent: string) => {
      const chat = chats.get(id);
      if (
        !chat ||
        chat.provider !== profile.provider ||
        chat.modeId !== profile.modeId ||
        chat.reportsTo !== parent
      )
        throw new Error("Worker changed.");
    },
  };
  const target = new HostLinks(deps);
  const targetApp = express();
  mountHostLinkRoutes(targetApp, () => target);
  const targetListener = await listen(targetApp);
  const targetConfig = emptyConfig();
  targetConfig.incoming.push({
    id: "link",
    serverId: "source",
    token: linkToken,
    revoked: false,
    expiresAt: 2000000000000,
    leads: ["lead"],
    operations: ["spawn", "notice"],
    workloads: ["standard", "gpu", "heavy"],
    maxWorkers: 10,
    workspaces: { job: root },
    profiles: {
      worker: { provider: "codex", model: "gpt-test", modeId: "auto", parents: ["codex:auto"] },
    },
  });
  const sourceConfig = emptyConfig();
  sourceConfig.chats.push({
    agentId: "lead",
    token: chatToken,
    revoked: false,
    expiresAt: 2000000000000,
    operations: ["spawn", "notice"],
    links: ["link"],
  });
  sourceConfig.outgoing.push({
    id: "link",
    serverId: "target",
    url: targetListener.url,
    token: linkToken,
    revoked: false,
    expiresAt: 2000000000000,
    machine: "pc",
    reporters: ["lead"],
  });
  sourceConfig.routes = { standard: "link", gpu: "link", heavy: "link", mainAssistant: "link" };
  const sourceHome = path.join(root, "source");
  const source = new HostLinks({
    ...deps,
    home: sourceHome,
    serverId: "source",
    mainAssistant: () => null,
  });
  const sourceApp = express();
  mountHostLinkRoutes(sourceApp, () => source);
  const sourceListener = await listen(sourceApp);
  const save = () => {
    writePrivateFileAtomicSync(
      path.join(deps.home, "host-links.json"),
      JSON.stringify(targetConfig),
    );
    writePrivateFileAtomicSync(
      path.join(sourceHome, "host-links.json"),
      JSON.stringify(sourceConfig),
    );
  };
  save();
  const post = async (url: string, token: string, body: unknown) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const reply: unknown = await response.json();
    return { status: response.status, body: reply };
  };
  const dispatch = (body: unknown, token = chatToken) =>
    post(`${sourceListener.url}/api/host-links/dispatch`, token, body);
  const wire = {
    ...spawn,
    destination: "target",
    sender: "lead",
    sourceProvider: "codex",
    sourceMode: "auto",
  };
  return {
    root,
    deps,
    source,
    target,
    targetConfig,
    sourceConfig,
    sourceListener,
    targetListener,
    created,
    notices,
    prompts,
    chats,
    state,
    save,
    post,
    dispatch,
    wire,
  };
}

test("real HTTP spawn retains one worker, restriction, parent, and per-worker control credential", async () => {
  const f = await fixture();
  const response = await f.dispatch(spawn);
  expect(response.status).toBe(200);
  const receipt = HostLinkReceiptSchema.parse(response.body);
  expect(receipt).toEqual({
    serverId: "target",
    messageId,
    state: "created",
    agentId: f.created[0]!.agentId,
    token: expect.stringMatching(/^hworker1\.[A-Za-z0-9_-]{43}$/),
    endpoint: f.targetListener.url,
  });
  expect(f.created).toHaveLength(1);
  expect(f.created[0]!.parent).toBe("lead@source");
  expect(f.created[0]!.profile.modeId).toBe("auto");
  expect(f.created[0]!.prompt).toBe("Do this task.");
  expect(await f.dispatch(spawn)).toEqual(response);
  expect(f.created).toHaveLength(1);
  const workerUrl = `${f.targetListener.url}/api/host-links/worker`;
  expect(
    await f.post(workerUrl, receipt.token!, { kind: "inspect", agentId: receipt.agentId }),
  ).toEqual({
    status: 200,
    body: { agentId: receipt.agentId, status: "idle", lastMessage: "Done." },
  });
  expect(
    (await f.post(workerUrl, receipt.token!, { kind: "inspect", agentId: "foreign" })).status,
  ).toBe(403);
  expect(
    (
      await f.dispatch(
        { ...spawn, messageId: "22222222-2222-4222-8222-222222222222" },
        receipt.token!,
      )
    ).status,
  ).toBe(403);
  const prompt = {
    kind: "prompt",
    agentId: receipt.agentId,
    messageId: "33333333-3333-4333-8333-333333333333",
    prompt: "Check the result.",
  };
  expect(
    HostLinkReceiptSchema.parse((await f.post(workerUrl, receipt.token!, prompt)).body).state,
  ).toBe("admitted");
  await f.post(workerUrl, receipt.token!, prompt);
  expect(f.prompts).toEqual(["Check the result."]);
  expect((await f.post(workerUrl, receipt.token!, { ...prompt, prompt: "Changed." })).status).toBe(
    409,
  );
});

test.each([
  "revoked",
  "expired",
  "notice-only",
  "foreign-lead",
  "wider-mode",
  "workspace",
  "profile",
  "capacity",
  "unprotected",
])("refuses %s before creation", async (reason) => {
  const f = await fixture();
  const grant = f.targetConfig.incoming[0]!;
  if (reason === "revoked") grant.revoked = true;
  if (reason === "expired") grant.expiresAt = 0;
  if (reason === "notice-only") grant.operations = ["notice"];
  if (reason === "foreign-lead") grant.leads = ["other"];
  if (reason === "wider-mode") grant.profiles.worker!.modeId = "full-access";
  if (reason === "workspace") grant.workspaces = {};
  if (reason === "profile") grant.profiles = {};
  if (reason === "capacity") grant.maxWorkers = 0;
  if (reason === "unprotected") f.state.protected = false;
  f.save();
  expect((await f.dispatch(spawn)).status).toBe(403);
  expect(f.created).toEqual([]);
});
test.each(["sender", "cwd", "env", "role", "mode", "command"])(
  "refuses caller-supplied %s",
  async (field) => {
    const f = await fixture();
    expect((await f.dispatch({ ...spawn, [field]: "forged" })).status).toBe(400);
    expect(f.created).toEqual([]);
  },
);
test("refuses wrong-link, foreign-chat, and wrong-destination credentials", async () => {
  const f = await fixture();
  expect((await f.dispatch(spawn, `hchat1.${"C".repeat(43)}`)).status).toBe(403);
  expect(
    (
      await f.post(
        `${f.targetListener.url}/api/host-links/receive`,
        `hlink1.${"D".repeat(43)}`,
        f.wire,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.post(`${f.targetListener.url}/api/host-links/receive`, linkToken, {
        ...f.wire,
        destination: "other",
      })
    ).status,
  ).toBe(403);
  expect(f.created).toEqual([]);
});
test("GPU and heavy requests select only the configured PC and destination workload grant", async () => {
  const f = await fixture();
  expect((await f.dispatch({ ...spawn, workload: "gpu" })).status).toBe(403);
  f.targetConfig.machine = "pc";
  f.save();
  const result = await f.dispatch({ ...spawn, workload: "gpu" });
  expect(result.status).toBe(200);
  expect(f.created).toHaveLength(1);
  f.sourceConfig.outgoing[0]!.machine = "mac";
  f.save();
  expect(
    (
      await f.dispatch({
        ...spawn,
        workload: "heavy",
        messageId: "44444444-4444-4444-8444-444444444444",
      })
    ).status,
  ).toBe(403);
  expect(f.created).toHaveLength(1);
});
test("changed retry bodies and destination routes cannot create a second worker", async () => {
  const f = await fixture();
  await f.dispatch(spawn);
  expect((await f.dispatch({ ...spawn, prompt: "Changed." })).status).toBe(409);
  f.sourceConfig.outgoing[0]!.serverId = "other";
  f.save();
  expect((await f.dispatch(spawn)).status).toBe(409);
  expect(f.created).toHaveLength(1);
});
test("pending creation after a lost reply and restart requires reconciliation", async () => {
  const f = await fixture();
  f.state.failCreate = true;
  await expect(f.target.receive(linkToken, f.wire)).rejects.toThrow("Creation reply lost.");
  f.state.failCreate = false;
  const restarted = new HostLinks(f.deps);
  const receipt = await restarted.receive(linkToken, f.wire);
  expect(receipt.state).toBe("pending");
  expect(receipt.token).toBe(null);
  expect(f.created).toEqual([]);
});
test("a crash after durable pending save never starts a second worker", async () => {
  const f = await fixture();
  const inbox = path.join(f.deps.home, "host-links-inbox.json");
  let durable = "{}";
  const events: string[] = [];
  const realFsync = vi.mocked(fsyncSync).getMockImplementation()!;
  vi.mocked(fsyncSync).mockImplementation((fd) => {
    realFsync(fd);
    if (fstatSync(fd).isDirectory()) {
      events.push("directory flush");
      durable = readFileSync(inbox, "utf8");
    } else events.push("file flush");
  });
  const realRename = vi.mocked(renameSync).getMockImplementation()!;
  vi.mocked(renameSync).mockImplementation((from, to) => {
    events.push("rename");
    realRename(from, to);
  });
  const crashed = new HostLinks({
    ...f.deps,
    create: async () => {
      events.push("provider boundary");
      throw new Error("Simulated crash before provider call");
    },
  });
  await expect(crashed.receive(linkToken, f.wire)).rejects.toThrow("Simulated crash");
  // Restore only bytes committed by a file flush followed by the directory flush.
  writeFileSync(inbox, durable, { mode: 0o600 });
  expect(events).toEqual(["file flush", "rename", "directory flush", "provider boundary"]);
  events.length = 0;
  const receipt = await new HostLinks(f.deps).receive(linkToken, f.wire);
  expect(f.created).toEqual([]);
  expect(receipt.state).toBe("pending");
  expect(events).toEqual(["file flush", "rename", "directory flush"]);
});

test("a directory flush failure stops effects and receipt acknowledgement", async () => {
  const f = await fixture();
  const realFsync = vi.mocked(fsyncSync).getMockImplementation()!;
  vi.mocked(fsyncSync).mockImplementation((fd) => {
    if (fstatSync(fd).isDirectory()) throw new Error("Directory flush failed");
    realFsync(fd);
  });
  await expect(f.target.receive(linkToken, f.wire)).rejects.toThrow("Directory flush failed");
  await expect(f.target.receive(linkToken, f.wire)).rejects.toThrow("Directory flush failed");
  expect(f.created).toEqual([]);
  vi.mocked(fsyncSync).mockImplementation(realFsync);
  expect((await f.target.receive(linkToken, f.wire)).state).toBe("pending");
  expect(f.created).toEqual([]);
});

test("Windows refuses host-link effects without a durable journal", async () => {
  const f = await fixture();
  const platform = process.platform;
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    await expect(f.target.receive(linkToken, f.wire)).rejects.toThrow(
      "Durable host-link operations are unavailable on Windows.",
    );
    expect(f.created).toEqual([]);
    expect(f.notices).toEqual([]);
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
  }
});

test("an actual lost HTTP reply reuses the committed worker receipt", async () => {
  const f = await fixture();
  f.state.afterCreate = () => f.targetListener.server.closeAllConnections();
  const lost = await f.dispatch(spawn);
  expect(lost.status).toBe(409);
  expect(f.created).toHaveLength(1);
  f.state.afterCreate = () => {};
  const retry = await f.dispatch(spawn);
  expect(retry.status).toBe(200);
  expect(HostLinkReceiptSchema.parse(retry.body).agentId).toBe(f.created[0]!.agentId);
  expect(f.created).toHaveLength(1);
});
test("offline destinations fail without local substitution", async () => {
  const f = await fixture();
  f.sourceConfig.outgoing[0]!.url = "http://127.0.0.1:1";
  f.save();
  const result = await f.dispatch(spawn);
  expect(result.status).toBe(409);
  expect(result.body).toEqual({
    code: "uncertain",
    error: `Host-link delivery is uncertain. Retain message ${messageId}.`,
  });
  expect(f.created).toEqual([]);
});
test("a remote notice resolves the current main assistant again before input", async () => {
  const f = await fixture();
  const notice = { kind: "notice", messageId, text: "Worker finished." };
  expect(HostLinkReceiptSchema.parse((await f.dispatch(notice)).body).state).toBe("delivered");
  expect(f.notices).toEqual(["main:Host notice from lead@source:\nWorker finished."]);
  await f.dispatch(notice);
  expect(f.notices).toHaveLength(1);
  f.state.beforeNotice = () => {
    f.state.holder = "new-main";
  };
  const later = { ...notice, messageId: "55555555-5555-4555-8555-555555555555" };
  expect(HostLinkReceiptSchema.parse((await f.dispatch(later)).body).agentId).toBe("new-main");
  expect(f.notices).toHaveLength(2);
  f.state.beforeNotice = () => {};
  expect(
    HostLinkReceiptSchema.parse(
      (await f.dispatch({ ...notice, messageId: "66666666-6666-4666-8666-666666666666" })).body,
    ).state,
  ).toBe("delivered");
  expect(f.notices[2]).toBe("new-main:Host notice from lead@source:\nWorker finished.");
});
test("lead success suppression remains in force while failed lead notices cross the link", async () => {
  const f = await fixture();
  f.chats.get("lead")!.isLead = true;
  expect(await f.source.remoteNotice("lead", "Finished.", "finished")).toBe(true);
  expect(f.notices).toEqual([]);
  expect(await f.source.remoteNotice("lead", "Failed.", "failed")).toBe(true);
  expect(f.notices).toEqual(["main:Host notice from lead@source:\nFailed."]);
});
test("a lead with a retained remote child also suppresses automatic success notices", async () => {
  const f = await fixture();
  await f.dispatch(spawn);
  expect(await f.source.remoteNotice("lead", "Finished.", "finished")).toBe(true);
  expect(f.notices).toEqual([]);
});
test("revocation and worker mode changes refuse subsequent per-chat prompts", async () => {
  const f = await fixture();
  const result = await f.dispatch(spawn);
  const receipt = HostLinkReceiptSchema.parse(result.body);
  f.chats.get(receipt.agentId!)!.modeId = "full-access";
  const body = {
    kind: "prompt",
    agentId: receipt.agentId,
    messageId: "77777777-7777-4777-8777-777777777777",
    prompt: "Next task.",
  };
  expect(
    (await f.post(`${f.targetListener.url}/api/host-links/worker`, receipt.token!, body)).status,
  ).toBe(403);
  f.chats.get(receipt.agentId!)!.modeId = "auto";
  f.targetConfig.incoming[0]!.revoked = true;
  f.save();
  expect(
    (await f.post(`${f.targetListener.url}/api/host-links/worker`, receipt.token!, body)).status,
  ).toBe(403);
  expect(f.prompts).toEqual([]);
});
test("a worker credential cannot control a replacement model", async () => {
  const f = await fixture();
  const receipt = HostLinkReceiptSchema.parse((await f.dispatch(spawn)).body);
  f.chats.get(receipt.agentId!)!.model = "another-model";
  const result = await f.post(`${f.targetListener.url}/api/host-links/worker`, receipt.token!, {
    kind: "prompt",
    agentId: receipt.agentId,
    messageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    prompt: "Next task.",
  });
  expect(result.status).toBe(403);
  expect(f.prompts).toEqual([]);
});
test.skipIf(process.platform === "win32")("refuses a public credential file", async () => {
  const f = await fixture();
  await chmod(path.join(f.deps.home, "host-links.json"), 0o644);
  expect((await f.dispatch(spawn)).status).toBe(403);
  expect(f.created).toEqual([]);
});
test("host-link credentials cannot authenticate to general HTTP, WebSocket, or MCP controls", async () => {
  for (const token of [linkToken, chatToken, `hworker1.${"E".repeat(43)}`]) {
    expect(isBearerTokenValidSync({ password: undefined, token })).toBe(false);
    expect(await isBearerTokenValidAsync({ password: undefined, token })).toBe(false);
    expect(
      await isAgentMcpRequestAuthorized({
        password: undefined,
        capabilityToken: token,
        authorizationHeader: `Bearer ${token}`,
      }),
    ).toBe(false);
  }
  const app = express();
  app.use(createRequireBearerMiddleware({}));
  app.post("/api/control", (_req, res) => res.json({ accepted: true }));
  const listener = await listen(app);
  const response = await fetch(`${listener.url}/api/control`, {
    method: "POST",
    headers: { authorization: `Bearer ${linkToken}` },
  });
  expect(response.status).toBe(401);
});

const sharedAccount = "55555555-5555-4555-8555-555555555555";
async function limitFixture() {
  const f = await fixture();
  const sourcePool = path.join(f.root, "source", "command-centre");
  const targetPool = path.join(f.root, "target", "command-centre");
  for (const pool of [sourcePool, targetPool]) {
    await addAccount(pool, { provider: "claude", name: "Work" }, f.state.now);
    await update(pool, (s) => {
      s.accounts[0].id = sharedAccount;
    });
  }
  f.sourceConfig.outgoing[0].shareLimits = true;
  f.targetConfig.incoming[0].operations.push("limits");
  f.save();
  return { ...f, sourcePool, targetPool };
}

for (const limitKind of ["session", "weekly"] as const) {
  test(`shares a ${limitKind} pool limit over HTTP and expires at the reset`, async () => {
    const f = await limitFixture();
    const resetAt = new Date(f.state.now + 3600000).toISOString();
    await assign(f.sourcePool, "pooled-session", "claude", f.state.now);
    await rotate(
      f.sourcePool,
      "pooled-session",
      "claude",
      { kind: limitKind, resetAt },
      f.state.now,
    );
    expect(await f.source.shareAccountLimits()).toEqual({ delivered: 1, failed: 0 });
    expect(await f.source.shareAccountLimits()).toEqual({ delivered: 0, failed: 0 });
    expect(publicView(readAccounts(f.sourcePool), f.state.now).accounts[0].status).toEqual({
      state: "limited",
      until: resetAt,
      source: "local",
    });
    const target = readAccounts(f.targetPool);
    expect(publicView(target, f.state.now).accounts[0]).toMatchObject({
      limitKind,
      status: { state: "limited", until: resetAt, source: "source" },
    });
    expect(choose(target, "claude", f.state.now)).toBeNull();
    const launch = await assign(f.targetPool, "new-session", "claude", f.state.now);
    expect(launch).toMatchObject({ allLimited: true, earliestReset: resetAt });
    const persisted = readFileSync(path.join(f.targetPool, "accounts", "accounts.json"), "utf8");
    expect(persisted).not.toContain("remoteLimits");
    expect(persisted).not.toContain("usageObservedAt");
    expect(readAccounts(f.targetPool).accounts[0].limitedUntil).toBeNull();
    // A new service instance reads the same retained remote state.
    expect(accountStatus(readAccounts(f.targetPool).accounts[0], f.state.now)).toMatchObject({
      source: "source",
    });
    f.state.now = Date.parse(resetAt);
    expect(accountStatus(readAccounts(f.targetPool).accounts[0], f.state.now)).toEqual({
      state: "ok",
    });
    expect(choose(readAccounts(f.targetPool), "claude", f.state.now)?.id).toBe(sharedAccount);
    expect(await f.source.shareAccountLimits()).toEqual({ delivered: 0, failed: 0 });
  });
}

test("fresh local limits and cleared limits win over an older remote observation", async () => {
  const f = await limitFixture();
  const remoteReset = new Date(f.state.now + 7 * 86400000).toISOString();
  await markAccountLimited(
    f.sourcePool,
    sharedAccount,
    { kind: "weekly", resetAt: remoteReset },
    f.state.now,
  );
  f.state.now += 1000;
  const localReset = new Date(f.state.now + 3600000).toISOString();
  await markAccountLimited(
    f.targetPool,
    sharedAccount,
    { kind: "session", resetAt: localReset },
    f.state.now,
  );
  expect(await f.source.shareAccountLimits()).toEqual({ delivered: 1, failed: 0 });
  expect(accountStatus(readAccounts(f.targetPool).accounts[0], f.state.now)).toEqual({
    state: "limited",
    until: localReset,
    source: "local",
  });
  // The same remote observation can arrive late or repeat after a local clear.
  await setAccount(f.targetPool, sharedAccount, { clearLimit: true });
  expect(accountStatus(readAccounts(f.targetPool).accounts[0], f.state.now)).toEqual({
    state: "ok",
  });
  // The reset of the older remote window cannot bring the cleared limit back.
  f.state.now = Date.parse(localReset);
  expect(accountStatus(readAccounts(f.targetPool).accounts[0], f.state.now)).toEqual({
    state: "ok",
  });
});

test("a fresh local usage reading overrides an older remote limit and reports its source in usage", async () => {
  const f = await limitFixture();
  const resetAt = new Date(f.state.now + 3600000).toISOString();
  await markAccountLimited(f.sourcePool, sharedAccount, { kind: "session", resetAt }, f.state.now);
  await f.source.shareAccountLimits();
  const usage = createPoolUsage(
    () => f.targetPool,
    () => f.state.now,
  );
  expect(await usage.fetch({ accountId: sharedAccount, provider: "claude" })).toMatchObject({
    status: "unavailable",
    problem: { detail: expect.stringContaining("Source: remote host source") },
  });
  f.state.now += 1000;
  writePrivateFileAtomicSync(
    path.join(f.targetPool, "accounts", "usage-reports.json"),
    JSON.stringify({
      v: 1,
      reports: [
        {
          accountId: sharedAccount,
          provider: "claude",
          status: "ok",
          observedAt: new Date(f.state.now).toISOString(),
          fiveHour: { usedPct: 20, resetsAt: resetAt },
          weekly: null,
        },
      ],
    }),
  );
  expect(accountStatus(readAccounts(f.targetPool).accounts[0], f.state.now)).toEqual({
    state: "ok",
  });
  expect(await usage.fetch({ accountId: sharedAccount, provider: "claude" })).toMatchObject({
    status: "available",
  });
});

test("limit sharing retries an offline link without changing local limits", async () => {
  const f = await limitFixture();
  const resetAt = new Date(f.state.now + 3600000).toISOString();
  await markAccountLimited(f.sourcePool, sharedAccount, { kind: "session", resetAt }, f.state.now);
  const url = f.sourceConfig.outgoing[0].url;
  f.sourceConfig.outgoing[0].url = "http://127.0.0.1:1";
  f.save();
  expect(await f.source.shareAccountLimits()).toEqual({ delivered: 0, failed: 1 });
  expect(accountStatus(readAccounts(f.sourcePool).accounts[0], f.state.now).state).toBe("limited");
  expect(accountStatus(readAccounts(f.targetPool).accounts[0], f.state.now).state).toBe("ok");
  f.sourceConfig.outgoing[0].url = url;
  f.save();
  expect(await f.source.shareAccountLimits()).toEqual({ delivered: 1, failed: 0 });
  expect(accountStatus(readAccounts(f.targetPool).accounts[0], f.state.now).source).toBe("source");
  expect(await f.target.shareAccountLimits()).toEqual({ delivered: 0, failed: 0 });
});

test("limit sharing requires link authority and ignores unknown, expired, and invalid observations", async () => {
  const f = await limitFixture();
  const wire = {
    kind: "account_limit",
    messageId,
    destination: "target",
    accountId: sharedAccount,
    limitKind: "weekly",
    resetAt: new Date(f.state.now + 86400000).toISOString(),
    observedAt: new Date(f.state.now).toISOString(),
  };
  const receive = (body: unknown, token = linkToken) =>
    f.post(`${f.targetListener.url}/api/host-links/receive`, token, body);
  expect((await receive(wire, chatToken)).status).toBe(403);
  expect((await receive({ ...wire, token: "synthetic-secret" })).status).toBe(400);
  expect((await receive({ ...wire, destination: "other" })).status).toBe(403);
  expect(
    (await receive({ ...wire, accountId: "66666666-6666-4666-8666-666666666666" })).body,
  ).toMatchObject({ state: "suppressed" });
  expect(
    (await receive({ ...wire, resetAt: new Date(f.state.now).toISOString() })).body,
  ).toMatchObject({ state: "suppressed" });
  expect(
    (await receive({ ...wire, resetAt: new Date(f.state.now + 9 * 86400000).toISOString() })).body,
  ).toMatchObject({ state: "suppressed" });
  expect(
    (await receive({ ...wire, observedAt: new Date(f.state.now + 120000).toISOString() })).body,
  ).toMatchObject({ state: "suppressed" });
  f.targetConfig.incoming[0].operations = ["spawn", "notice"];
  f.save();
  expect((await receive(wire)).status).toBe(403);
  f.targetConfig.incoming[0].operations.push("limits");
  f.targetConfig.incoming[0].revoked = true;
  f.save();
  expect((await receive(wire)).status).toBe(403);
  expect(accountStatus(readAccounts(f.targetPool).accounts[0], f.state.now).state).toBe("ok");
});

test("local quota windows share only known account IDs and do not forward remote observations", async () => {
  const f = await limitFixture();
  const resetAt = new Date(f.state.now + 3600000).toISOString();
  writePrivateFileAtomicSync(
    path.join(f.sourcePool, "accounts", "usage-reports.json"),
    JSON.stringify({
      v: 1,
      reports: [
        {
          accountId: sharedAccount,
          provider: "claude",
          status: "limited",
          observedAt: new Date(f.state.now).toISOString(),
          fiveHour: { usedPct: 100, resetsAt: resetAt },
          weekly: null,
        },
      ],
    }),
  );
  expect(await f.source.shareAccountLimits()).toEqual({ delivered: 1, failed: 0 });
  f.targetConfig.outgoing.push({
    ...f.sourceConfig.outgoing[0],
    id: "reverse",
    serverId: "source",
    url: f.sourceListener.url,
  });
  f.save();
  expect(await f.target.shareAccountLimits()).toEqual({ delivered: 0, failed: 0 });
  const stored = JSON.parse(
    readFileSync(path.join(f.targetPool, "accounts", "remote-limits.json"), "utf8"),
  );
  expect(stored.observations).toEqual([
    {
      accountId: sharedAccount,
      limitKind: "session",
      resetAt,
      observedAt: new Date(f.state.now).toISOString(),
      source: "source",
    },
  ]);
});

test("the running exchange sends startup limits and later file changes", async () => {
  const f = await limitFixture();
  const resetAt = new Date(f.state.now + 3600000).toISOString();
  const waitForObservation = () =>
    new Promise<void>((resolve) => {
      const watcher = watch(path.join(f.targetPool, "accounts"), (_event, file) => {
        if (file === "remote-limits.json") {
          watcher.close();
          resolve();
        }
      });
      cleanups.push(async () => {
        watcher.close();
      });
    });
  await markAccountLimited(f.sourcePool, sharedAccount, { kind: "session", resetAt }, f.state.now);
  const startup = waitForObservation();
  const warnings: string[] = [];
  const close = startHostLimitSharing(f.source, path.join(f.root, "source"), () =>
    warnings.push("failed"),
  );
  cleanups.push(async () => close());
  await startup;
  expect(accountStatus(readAccounts(f.targetPool).accounts[0], f.state.now).until).toBe(resetAt);
  const later = waitForObservation();
  f.state.now += 1000;
  const weeklyReset = new Date(f.state.now + 86400000).toISOString();
  await markAccountLimited(
    f.sourcePool,
    sharedAccount,
    { kind: "weekly", resetAt: weeklyReset },
    f.state.now,
  );
  await later;
  expect(accountStatus(readAccounts(f.targetPool).accounts[0], f.state.now).until).toBe(
    weeklyReset,
  );
  close();
  expect(warnings).toEqual([]);
});

test("editing a legacy account cannot make its old limit override a newer local observation", async () => {
  const f = await limitFixture();
  const createdAt = new Date(f.state.now).toISOString();
  const remoteReset = new Date(f.state.now + 86400000).toISOString();
  await update(f.sourcePool, (s) => {
    s.accounts[0].limitedUntil = remoteReset;
    s.accounts[0].limitKind = "weekly";
  });
  f.state.now += 1000;
  const localReset = new Date(f.state.now + 3600000).toISOString();
  await markAccountLimited(
    f.targetPool,
    sharedAccount,
    { kind: "session", resetAt: localReset },
    f.state.now,
  );
  await setAccount(f.sourcePool, sharedAccount, { name: "Renamed" });
  const mtime = new Date(f.state.now + 1000);
  utimesSync(path.join(f.sourcePool, "accounts", "accounts.json"), mtime, mtime);
  expect(await f.source.shareAccountLimits()).toEqual({ delivered: 1, failed: 0 });
  expect(accountStatus(readAccounts(f.targetPool).accounts[0], f.state.now)).toEqual({
    state: "limited",
    until: localReset,
    source: "local",
  });
  const stored = JSON.parse(
    readFileSync(path.join(f.targetPool, "accounts", "remote-limits.json"), "utf8"),
  );
  expect(stored.observations[0].observedAt).toBe(createdAt);
});
