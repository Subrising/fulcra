import { loadAgentPolicy } from "./limit-resume/policy.js";
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
  HostLinkError,
  HostLinkStorageError,
  HostLinks,
  type HostLinkChat,
  type HostLinkCreate,
  type HostLinkRoleNotice,
  type HostLinkFinishDelivery,
} from "./host-links.js";
import { startHostLimitSharing } from "./host-limit-sharing.js";
import { mountHostLinkRoutes } from "./host-link-routes.js";
import {
  HostLinkReceiptSchema,
  HostLinkJournalSchema,
  type HostLinkConfig,
} from "./host-link-contracts.js";
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
import { windowsAclIsSafe } from "./plugins/trusted-ownership.js";
import {
  writeWindowsPrivateFileAtomicSync,
  WindowsPrivateFileReconciliationError,
} from "./windows-private-file.js";
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

vi.mock("./windows-private-file.js", async (importOriginal) => {
  const windows = await importOriginal<typeof import("./windows-private-file.js")>();
  return {
    ...windows,
    assertWindowsPrivateFilesSettled: vi.fn(),
    writeWindowsPrivateFileAtomicSync: vi.fn(windows.writeWindowsPrivateFileAtomicSync),
  };
});

vi.mock("./plugins/trusted-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugins/trusted-ownership.js")>()),
  windowsAclIsSafe: vi.fn(() => true),
}));

const linkToken = `hlink1.${"A".repeat(43)}`;
const chatToken = `hchat1.${"B".repeat(43)}`;
const messageId = "11111111-1111-4111-8111-111111111111";
const spawn = {
  kind: "spawn",
  issuedAt: Date.parse("2026-10-15T12:00:00Z"),
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
  const finishNotices: Array<{ agentId: string; messageId: string; text: string }> = [];
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
    linkDown: false,
    noticeReads: 0,
    deliveryDown: false,
    failAfterHandoff: false,
    beforeFinish: async () => {},
    protected: true,
    now: Date.parse("2026-10-15T12:00:00Z"),
    failCreate: false,
    beforeNotice: () => {},
    afterCreate: () => {},
  };
  const deps = {
    home: path.join(root, "target"),
    now: () => state.now,
    finish: async (input: HostLinkFinishDelivery): Promise<void | "suppressed"> => {
      input.check();
      if (state.deliveryDown) throw new Error("Local delivery is unavailable.");
      await state.beforeFinish();
      if (input.prepare && !(await input.prepare())) return "suppressed";
      input.check();
      input.beforeHandoff();
      finishNotices.push({ agentId: input.agentId, messageId: input.messageId, text: input.text });
      if (state.failAfterHandoff) throw new Error("Provider acknowledgement lost.");
    },
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
    prompt: async (input: { check: () => void; text: string; beforeSend?: () => void }) => {
      input.check();
      input.beforeSend?.();
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
  let target = new HostLinks(deps);
  const targetApp = express();
  targetApp.use((req, res, next) => {
    if (req.path === "/api/host-links/worker") state.noticeReads++;
    if (state.linkDown && req.path === "/api/host-links/worker") {
      res.status(503).json({ error: "Link offline" });
      return;
    }
    next();
  });
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
  const sourceDeps = { ...deps, home: sourceHome, serverId: "source", mainAssistant: () => null };
  let source = new HostLinks(sourceDeps);
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
    finishNotices,
    sourceHome,
    restartSource: () => {
      source.stopNotifications();
      source = new HostLinks(sourceDeps);
      return source;
    },
    restartTarget: () => {
      target.stopNotifications();
      target = new HostLinks(deps);
      return target;
    },
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
    issuedAt: spawn.issuedAt,
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
  await expect(f.target.receive(linkToken, f.wire)).rejects.toThrow("receipt write failed");
  await expect(f.target.receive(linkToken, f.wire)).rejects.toThrow("receipt write failed");
  expect(f.created).toEqual([]);
  vi.mocked(fsyncSync).mockImplementation(realFsync);
  expect((await f.target.receive(linkToken, f.wire)).state).toBe("pending");
  expect(f.created).toEqual([]);
});

test("Windows commits a worker receipt before provider input and returns it on retry", async () => {
  const f = await fixture();
  const platform = process.platform;
  const writes: string[] = [];
  vi.mocked(writeWindowsPrivateFileAtomicSync).mockImplementation((file, data) => {
    // Use real private files on this POSIX host; the PC proof checks the Windows primitive.
    writes.push(file);
    writeFileSync(file, data, { mode: 0o600 });
  });
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    const request = { ...spawn, notifyOnFinish: true };
    const receipt = await f.source.spawnForAgent("lead", "target", request);
    expect(receipt.state).toBe("created");
    expect(writes.length).toBeGreaterThan(0);
    expect(f.created).toHaveLength(1);
    f.target.recordWorkerNotice(receipt.agentId!, "finished", "windows-turn", "Task complete.");
    await f.source.syncNotifications();
    await f.source.flushNotificationDeliveries();
    expect(f.finishNotices).toHaveLength(1);
    expect(f.finishNotices[0]).toMatchObject({
      agentId: "lead",
      text: expect.stringContaining("Task complete."),
    });
    expect(await f.source.spawnForAgent("lead", "target", request)).toEqual(receipt);
    expect(f.created).toHaveLength(1);
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
    vi.mocked(writeWindowsPrivateFileAtomicSync).mockRestore();
  }
});

test("Windows write-through failure stops provider input and acknowledgement", async () => {
  const f = await fixture();
  const platform = process.platform;
  vi.mocked(writeWindowsPrivateFileAtomicSync).mockImplementation(() => {
    throw new Error("Windows durable file commit failed.");
  });
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    await expect(f.target.receive(linkToken, f.wire)).rejects.toThrow("receipt write failed");
    expect(f.created).toEqual([]);
    expect(f.notices).toEqual([]);
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
    vi.mocked(writeWindowsPrivateFileAtomicSync).mockRestore();
  }
});

test.each([
  ["win32", 1024 * 1024, true],
  ["win32", 512 * 1024, true],
  ["win32", 512 * 1024 - 4096, false],
  ["darwin", 1024 * 1024, false],
] as const)(
  "%s receipt capacity with %i bytes of retained data",
  async (platform, padding, full) => {
    const f = await fixture();
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    const file = path.join(f.deps.home, "host-links-inbox.json");
    const original = JSON.stringify({
      retained: {
        hash: "x".repeat(padding),
        grant: "fixture",
        sender: "lead",
        linkId: "link",
        sourceServerId: "source",
        profile: null,
        cwd: null,
        receipt: {
          serverId: "target",
          messageId,
          state: "pending",
          agentId: null,
          token: null,
          endpoint: null,
        },
      },
    });
    writeFileSync(file, original, { mode: 0o600 });
    vi.mocked(writeWindowsPrivateFileAtomicSync).mockImplementation((target, data) =>
      writeFileSync(target, data, { mode: 0o600 }),
    );
    try {
      Object.defineProperty(process, "platform", { value: platform });
      if (full) {
        await expect(f.target.receive(linkToken, f.wire).then(() => "admitted")).rejects.toThrow(
          "receipt storage is full",
        );
        expect(writeWindowsPrivateFileAtomicSync).not.toHaveBeenCalled();
        expect(readFileSync(file, "utf8")).toBe(original);
        expect(f.created).toHaveLength(0);
      } else {
        expect((await f.target.receive(linkToken, f.wire)).state).toBe("created");
        expect(f.created).toHaveLength(1);
      }
    } finally {
      Object.defineProperty(process, "platform", descriptor);
      vi.mocked(writeWindowsPrivateFileAtomicSync).mockRestore();
    }
  },
);

test("Windows starts the retained return-notice scheduler", async () => {
  const f = await fixture();
  const platform = process.platform;
  const sync = vi.spyOn(f.source, "syncNotifications").mockResolvedValue();
  try {
    vi.useFakeTimers();
    Object.defineProperty(process, "platform", { value: "win32" });
    f.source.startNotifications();
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledOnce();
  } finally {
    f.source.stopNotifications();
    vi.useRealTimers();
    Object.defineProperty(process, "platform", { value: platform });
    sync.mockRestore();
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
    issuedAt: spawn.issuedAt,
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
    issuedAt: spawn.issuedAt,
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

test("FU-170 bound native creation selects the requested host and retains one HTTP worker", async () => {
  const f = await fixture();
  // Explicit host choice does not depend on workload routes.
  f.sourceConfig.routes = {};
  f.save();
  const first = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    expected: { provider: "codex", model: "gpt-test", modeId: "auto" },
  });
  expect(first.state).toBe("created");
  expect(f.created).toHaveLength(1);
  expect(f.created[0]?.parent).toBe("lead@source");
  const second = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    expected: { provider: "codex", model: "gpt-test", modeId: "auto" },
  });
  expect(second).toEqual(first);
  expect(f.created).toHaveLength(1);
});

test.each([
  ["unknown-host", "The requested host has no unique host link."],
  ["unknown-caller", "This chat has no host-link spawn grant."],
  ["missing-link", "This chat cannot use the requested host link."],
  ["revoked", "The host-link grant is inactive."],
  ["expired", "The host-link grant is inactive."],
  ["ambiguous", "The requested host has no unique host link."],
  ["no-spawn", "This chat cannot create remote workers."],
  ["wrong-profile", "The destination refused the host-link request."],
  ["wrong-model", "The destination refused the host-link request."],
  ["wrong-mode", "The destination refused the host-link request."],
])("FU-170 native remote creation refuses %s without provider input", async (kind, message) => {
  const f = await fixture();
  if (kind === "missing-link") f.sourceConfig.chats[0]!.links = [];
  if (kind === "revoked") f.sourceConfig.chats[0]!.revoked = true;
  if (kind === "expired") f.sourceConfig.chats[0]!.expiresAt = 1;
  if (kind === "ambiguous")
    f.sourceConfig.outgoing.push({
      ...f.sourceConfig.outgoing[0]!,
      id: "other",
      token: `hlink1.${"D".repeat(43)}`,
    });
  if (kind === "no-spawn") f.sourceConfig.chats[0]!.operations = ["notice"];
  f.save();
  const result = f.source.spawnForAgent(
    kind === "unknown-caller" ? "other" : "lead",
    kind === "unknown-host" ? "missing" : "target",
    {
      ...spawn,
      expected: {
        provider: kind === "wrong-profile" ? "claude" : "codex",
        model: kind === "wrong-model" ? "other" : "gpt-test",
        modeId: kind === "wrong-mode" ? "full-access" : "auto",
      },
    },
  );
  await expect(result).rejects.toBeInstanceOf(HostLinkError);
  await expect(result).rejects.toMatchObject({ code: "refused", message });
  expect(f.created).toHaveLength(0);
});

function retainedReturn(fixtureHome: string) {
  return Object.values(
    JSON.parse(readFileSync(path.join(fixtureHome, "host-links-outbox.json"), "utf8")) as Record<
      string,
      {
        watch?: { failures: number; nextAt: number };
        receivedNotices?: Array<{ id: string; state: string; text: string }>;
      }
    >,
  )[0]!;
}

test.each(["finished", "failed"] as const)(
  "FU-170 returns one durable %s notice to the calling lead",
  async (kind) => {
    const f = await fixture();
    const receipt = await f.source.spawnForAgent("lead", "target", {
      ...spawn,
      notifyOnFinish: true,
    });
    f.target.recordWorkerStarted(receipt.agentId!);
    f.target.recordWorkerNotice(
      receipt.agentId!,
      kind,
      "turn-1",
      kind === "failed" ? "Fixture tool failed" : "Fixture task completed",
    );
    f.target.recordWorkerNotice(receipt.agentId!, kind, "turn-1", "Duplicate event");
    await f.source.syncNotifications();
    await f.source.flushNotificationDeliveries();
    expect(f.finishNotices).toHaveLength(1);
    expect(f.finishNotices[0]).toMatchObject({
      agentId: "lead",
      text: expect.stringContaining(kind),
    });
    expect(retainedReturn(f.sourceHome).receivedNotices?.[0]?.state).toBe("delivered");
    const source = f.restartSource();
    f.restartTarget();
    f.state.now += 10000;
    await source.syncNotifications();
    await source.flushNotificationDeliveries();
    expect(f.finishNotices).toHaveLength(1);
  },
);

test("FU-170 permission checkpoints do not consume the final notice", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerNotice(
    receipt.agentId!,
    "permission",
    "permission-1",
    "Approve fixture permission-1",
  );
  f.state.now += 2001;
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(1);
  expect(f.finishNotices[0]?.text).toContain("permission-1");
  f.target.recordWorkerNotice(
    receipt.agentId!,
    "permission",
    "permission-1",
    "Approve fixture permission-1",
  );
  f.state.now += 10000;
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(1);
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "turn-1", "Fixture task completed");
  f.state.now += 10000;
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(2);
  expect(f.finishNotices[1]?.text).toContain("finished");
  expect(f.finishNotices[0]?.messageId).not.toBe(f.finishNotices[1]?.messageId);
});

test("FU-170 retains a notice while the link is down and resumes after restart", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "turn-1", "Retained result");
  f.state.linkDown = true;
  await f.source.syncNotifications();
  expect(f.finishNotices).toHaveLength(0);
  expect(retainedReturn(f.sourceHome).watch?.failures).toBe(1);
  f.restartTarget();
  const source = f.restartSource();
  f.state.linkDown = false;
  f.state.now += 60001;
  await source.syncNotifications();
  await source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(1);
  expect(f.finishNotices[0]?.text).toContain("Retained result");
  expect(retainedReturn(f.sourceHome).watch?.failures).toBe(0);
});

test("FU-170 retries a home notice that never reached the provider across restart", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "turn-1", "Home queue result");
  f.state.deliveryDown = true;
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(retainedReturn(f.sourceHome).receivedNotices?.[0]?.state).toBe("queued");
  expect(f.finishNotices).toHaveLength(0);
  const source = f.restartSource();
  f.state.deliveryDown = false;
  f.state.now += 60001;
  await source.syncNotifications();
  await source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(1);
  expect(retainedReturn(f.sourceHome).receivedNotices?.[0]?.state).toBe("delivered");
});

test("FU-170 retains an uncertain native handoff without replay after restart", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "turn-1", "Uncertain receipt result");
  f.state.failAfterHandoff = true;
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(1);
  expect(retainedReturn(f.sourceHome).receivedNotices?.[0]).toMatchObject({
    state: "uncertain",
    text: "Uncertain receipt result",
  });
  const source = f.restartSource();
  f.state.failAfterHandoff = false;
  f.state.now += 60001;
  await source.syncNotifications();
  await source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(1);
});

test("FU-170 keeps a bounded retry count across source restarts", async () => {
  const f = await fixture();
  const request = { ...spawn, notifyOnFinish: true };
  const receipt = await f.source.spawnForAgent("lead", "target", request);
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "turn-1", "Retry budget result");
  f.state.linkDown = true;
  let source = f.source;
  for (let attempt = 1; attempt <= 8; attempt++) {
    await source.syncNotifications();
    expect(retainedReturn(f.sourceHome).watch?.failures).toBe(attempt);
    source = f.restartSource();
    f.state.now += 60001;
  }
  f.state.linkDown = false;
  await source.syncNotifications();
  expect(retainedReturn(f.sourceHome).watch?.failures).toBe(8);
  expect(f.finishNotices).toHaveLength(0);
  expect(f.created).toHaveLength(1);
  await source.spawnForAgent("lead", "target", request);
  await source.syncNotifications();
  await source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(1);
  expect(f.created).toHaveLength(1);
});

test.each([
  "grant",
  "lead-session",
  "grant-links",
  "grant-operations",
  "link-revoked",
  "incoming-revoked",
])("FU-170 refuses changed %s before home provider input", async (kind) => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "turn-1", "Retained restricted result");
  if (kind === "grant") {
    f.sourceConfig.chats[0]!.revoked = true;
    f.save();
  } else if (kind === "grant-links") {
    f.sourceConfig.chats[0]!.links = [];
    f.save();
  } else if (kind === "grant-operations") {
    f.sourceConfig.chats[0]!.operations = ["notice"];
    f.save();
  } else if (kind === "link-revoked") {
    f.sourceConfig.outgoing[0]!.revoked = true;
    f.save();
  } else if (kind === "incoming-revoked") {
    f.targetConfig.incoming[0]!.revoked = true;
    f.save();
  } else f.chats.get("lead")!.sessionId = "replacement-session";
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(0);
});

test.each(["before-read", "before-handoff"])(
  "FU-170 delivers after chat and link renewal %s",
  async (when) => {
    const f = await fixture();
    const receipt = await f.source.spawnForAgent("lead", "target", {
      ...spawn,
      notifyOnFinish: true,
    });
    f.target.recordWorkerNotice(receipt.agentId!, "finished", "turn-1", "Renewed result");
    const renew = async () => {
      f.sourceConfig.chats[0]!.token = `hchat1.${"Z".repeat(43)}`;
      f.sourceConfig.chats[0]!.expiresAt += 100000;
      f.sourceConfig.outgoing[0]!.token = `hlink1.${"Y".repeat(43)}`;
      f.sourceConfig.outgoing[0]!.expiresAt += 100000;
      f.targetConfig.incoming[0]!.token = f.sourceConfig.outgoing[0]!.token;
      f.targetConfig.incoming[0]!.expiresAt += 100000;
      f.save();
    };
    if (when === "before-read") await renew();
    else f.state.beforeFinish = renew;
    const source = f.restartSource();
    await source.syncNotifications();
    await source.flushNotificationDeliveries();
    expect(f.finishNotices).toHaveLength(1);
    expect(f.finishNotices[0]?.text).toContain("Renewed result");
    expect(retainedReturn(f.sourceHome).receivedNotices?.[0]?.state).toBe("delivered");
  },
);

test.each(["before-read", "before-handoff"])(
  "FU-170 delivers after limit sharing changes %s",
  async (when) => {
    const f = await fixture();
    const receipt = await f.source.spawnForAgent("lead", "target", {
      ...spawn,
      notifyOnFinish: true,
    });
    f.target.recordWorkerNotice(receipt.agentId!, "finished", "turn-1", "Shared limit result");
    const renew = async () => {
      f.sourceConfig.outgoing[0]!.shareLimits = true;
      f.targetConfig.incoming[0]!.operations.push("limits");
      f.save();
    };
    if (when === "before-read") await renew();
    else f.state.beforeFinish = renew;
    const source = f.restartSource();
    await source.syncNotifications();
    await source.flushNotificationDeliveries();
    expect(f.finishNotices).toHaveLength(1);
    expect(f.finishNotices[0]?.text).toContain("Shared limit result");
    expect(retainedReturn(f.sourceHome).receivedNotices?.[0]?.state).toBe("delivered");
  },
);

test("FU-170 refuses revocation at the return notice handoff", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "turn-1", "Revoked result");
  f.state.beforeFinish = async () => {
    f.sourceConfig.chats[0]!.revoked = true;
    f.save();
  };
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(0);
  expect(retainedReturn(f.sourceHome).receivedNotices?.[0]?.state).toBe("queued");
});

test("FU-170 keeps a finish that arrives before the creation reply", async () => {
  const f = await fixture();
  f.state.afterCreate = () =>
    f.target.recordWorkerNotice(f.created[0]!.agentId, "finished", "turn-fast", "Fast result");
  await f.source.spawnForAgent("lead", "target", { ...spawn, notifyOnFinish: true });
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(1);
  expect(f.finishNotices[0]?.text).toContain("Fast result");
});

test("FU-170 reconciles a lost creation reply before returning the retained finish", async () => {
  const f = await fixture();
  f.state.afterCreate = () => f.targetListener.server.closeAllConnections();
  await expect(
    f.source.spawnForAgent("lead", "target", { ...spawn, notifyOnFinish: true }),
  ).rejects.toThrow("uncertain");
  expect(f.created).toHaveLength(1);
  f.target.recordWorkerNotice(
    f.created[0]!.agentId,
    "finished",
    "turn-1",
    "Result after response loss",
  );
  f.state.afterCreate = () => {};
  const source = f.restartSource();
  await source.syncNotifications();
  await source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(1);
  expect(f.created).toHaveLength(1);
});

test.each([false, true, "reconcile", "late-failure"] as const)(
  "FU-170 runtime carries a worker notice into the lead provider (storage refused: %s)",
  async (storageRefused) => {
    const { AgentManager } = await import("./agent/agent-manager.js");
    const { AgentStorage } = await import("./agent/agent-storage.js");
    const { createHostLinkRuntime } = await import("./host-link-runtime.js");
    const { createTestAgentClients } = await import("./test-utils/fake-agent-client.js");
    const { createTestLogger } = await import("../test-utils/test-logger.js");
    const { heldSendsFor } = await import("./held-sends.js");
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "host-link-runtime-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const logger = createTestLogger();
    const leadInputs: unknown[] = [];
    const workerInputs: unknown[] = [];
    let noticeArrived!: () => void;
    const notified = new Promise<void>((resolve) => {
      noticeArrived = resolve;
    });
    const sourceHome = path.join(root, "source");
    const targetHome = path.join(root, "target");
    const sourceStorage = new AgentStorage(path.join(sourceHome, "agents"), logger);
    const targetStorage = new AgentStorage(path.join(targetHome, "agents"), logger);
    const sourceManager = new AgentManager({
      clients: createTestAgentClients({
        onStartTurn: (prompt) => {
          leadInputs.push(prompt);
          noticeArrived();
        },
      }),
      registry: sourceStorage,
      logger,
    });
    const targetManager = new AgentManager({
      clients: createTestAgentClients({ onStartTurn: (prompt) => workerInputs.push(prompt) }),
      registry: targetStorage,
      logger,
    });
    const sourceRuntime = await createHostLinkRuntime({
      home: sourceHome,
      serverId: "source",
      protected: () => true,
      agentManager: sourceManager,
      agentStorage: sourceStorage,
      logger,
      workspace: async () => "workspace-source",
    });
    const targetRuntime = await createHostLinkRuntime({
      home: targetHome,
      serverId: "target",
      protected: () => true,
      agentManager: targetManager,
      agentStorage: targetStorage,
      logger,
      workspace: async () => "workspace-target",
    });
    cleanups.push(async () => {
      sourceRuntime.close();
      targetRuntime.close();
      heldSendsFor(sourceManager, logger).close();
      heldSendsFor(targetManager, logger).close();
      for (const manager of [sourceManager, targetManager]) {
        for (const agent of manager.listAgents()) await manager.closeAgent(agent.id);
        await manager.flush();
      }
    });
    const targetApp = express();
    mountHostLinkRoutes(targetApp, () => targetRuntime.service);
    const targetListener = await listen(targetApp);
    const lead = await sourceManager.createAgent(
      { provider: "codex", model: "gpt-test", modeId: "full-access", cwd: root },
      undefined,
      { workspaceId: "workspace-source" },
    );
    const sourceConfig = emptyConfig();
    sourceConfig.chats.push({
      agentId: lead.id,
      token: chatToken,
      operations: ["spawn"],
      links: ["link"],
      expiresAt: 2000000000000,
      revoked: false,
    });
    sourceConfig.outgoing.push({
      id: "link",
      serverId: "target",
      token: linkToken,
      url: targetListener.url,
      machine: "mac",
      reporters: [],
      expiresAt: 2000000000000,
      revoked: false,
    });
    const targetConfig = emptyConfig();
    targetConfig.incoming.push({
      id: "link",
      serverId: "source",
      token: linkToken,
      leads: [lead.id],
      operations: ["spawn"],
      workloads: ["standard"],
      workspaces: { job: root },
      profiles: {
        worker: {
          provider: "codex",
          model: "gpt-test",
          modeId: "full-access",
          parents: ["codex:full-access"],
        },
      },
      maxWorkers: 1,
      expiresAt: 2000000000000,
      revoked: false,
    });
    writePrivateFileAtomicSync(
      path.join(sourceHome, "host-links.json"),
      JSON.stringify(sourceConfig),
    );
    writePrivateFileAtomicSync(
      path.join(targetHome, "host-links.json"),
      JSON.stringify(targetConfig),
    );
    if (storageRefused === true) {
      const rejectNotice = vi
        .spyOn(targetRuntime.service, "recordWorkerNotice")
        .mockImplementation(() => {
          throw new HostLinkStorageError("capacity");
        });
      cleanups.push(async () => {
        rejectNotice.mockRestore();
      });
    }
    if (storageRefused === "reconcile") {
      const blocked = vi
        .spyOn(targetRuntime.service, "recordWorkerNotice")
        .mockImplementationOnce(() => {
          throw new WindowsPrivateFileReconciliationError();
        });
      cleanups.push(async () => {
        blocked.mockRestore();
      });
    }
    if (storageRefused === "late-failure") {
      const receipt = new Int32Array(new SharedArrayBuffer(4));
      Atomics.store(receipt, 0, -1);
      const failed = vi
        .spyOn(targetRuntime.service, "recordWorkerNotice")
        .mockImplementationOnce(() => {
          throw new WindowsPrivateFileReconciliationError(receipt);
        });
      cleanups.push(async () => {
        failed.mockRestore();
      });
    }
    sourceRuntime.start();
    let finish!: () => void;
    const ended = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const unsubscribe = targetManager.subscribe(
      (event) => {
        if (event.type === "agent_stream" && event.event.type === "turn_completed") finish();
      },
      { replayState: false },
    );
    try {
      const receipt = await sourceRuntime.service.spawnForAgent(lead.id, "target", {
        ...spawn,
        notifyOnFinish: true,
      });
      await ended;
      if (storageRefused === "reconcile") {
        await new Promise<void>((resolve) => setImmediate(resolve));
        const result = (await targetRuntime.service.worker(receipt.token, {
          kind: "notices",
          agentId: receipt.agentId,
        })) as { notices: { text: string }[] };
        expect(result.notices.some((notice) => notice.text.includes("finished its turn"))).toBe(
          true,
        );
      }
      await notified;
      await sourceRuntime.service.flushNotificationDeliveries();
      expect(leadInputs).toHaveLength(1);
      await targetManager.setLabels(receipt.agentId!, { "fulcra.hold": "done" });
      await expect(
        targetRuntime.service.worker(receipt.token, {
          kind: "prompt",
          issuedAt: spawn.issuedAt,
          agentId: receipt.agentId,
          messageId: "22222222-2222-4222-8222-222222222222",
          prompt: "Start another task.",
        }),
      ).rejects.toMatchObject({
        name: "HostLinkError",
        code: "refused",
        message: "The worker is held as done.",
      });
      expect(workerInputs).toHaveLength(1);
      expect(String(leadInputs[0])).toContain(receipt.agentId!);
      expect(String(leadInputs[0])).toContain(
        storageRefused === true || storageRefused === "late-failure"
          ? "could not save a worker notice"
          : "finished",
      );
      expect(retainedReturn(sourceHome).receivedNotices?.[0]?.state).toBe("delivered");
      await sourceRuntime.service.syncNotifications();
      await sourceRuntime.service.flushNotificationDeliveries();
      expect(leadInputs).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  },
  30000,
);

test("FU-170 crash recovery retains an attempted notice without replay", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "turn-1", "Crash boundary result");
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  const file = path.join(f.sourceHome, "host-links-outbox.json");
  const journal = HostLinkJournalSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  Object.values(journal).forEach((entry: unknown) => {
    const record = entry as { receivedNotices: Array<{ state: string }> };
    record.receivedNotices[0]!.state = "sending";
  });
  writePrivateFileAtomicSync(file, JSON.stringify(journal), { durable: true });
  const source = f.restartSource();
  await source.syncNotifications();
  await source.flushNotificationDeliveries();
  expect(retainedReturn(f.sourceHome).receivedNotices?.[0]).toMatchObject({
    state: "uncertain",
    text: "Crash boundary result",
  });
  expect(f.finishNotices).toHaveLength(1);
});

test("FU-170 a stopped source cannot continue a pending notice read", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "turn-1", "Stopped source result");
  const pending = f.source.syncNotifications();
  f.source.stopNotifications();
  await pending;
  expect(f.state.noticeReads).toBe(0);
  expect(retainedReturn(f.sourceHome).watch?.failures).toBe(0);
  const source = f.restartSource();
  await source.syncNotifications();
  await source.flushNotificationDeliveries();
  expect(f.state.noticeReads).toBe(1);
  expect(f.finishNotices).toHaveLength(1);
});

test("FU-167 and FU-170 suppress a remote request resolved during the grace period", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerNotice(
    receipt.agentId!,
    "permission",
    "quick-permission",
    "Transient permission",
  );
  const early = await f.post(`${f.targetListener.url}/api/host-links/worker`, receipt.token!, {
    kind: "notices",
    agentId: receipt.agentId,
  });
  expect(early.body).toMatchObject({ notices: [] });
  f.target.resolveWorkerPermission(receipt.agentId!, "quick-permission");
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "turn-1", "Task result");
  f.state.now += 2001;
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(1);
  expect(f.finishNotices[0]?.text).toContain("finished");
  expect(f.finishNotices[0]?.text).not.toContain("Transient permission");
});

test("FU-167 and FU-170 suppress a resolved remote request while the lead is busy", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerNotice(receipt.agentId!, "permission", "held-permission", "Held permission");
  f.state.now += 2001;
  let queued!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    queued = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.state.beforeFinish = async () => {
    queued();
    await held;
  };
  await f.source.syncNotifications();
  await waiting;
  f.target.resolveWorkerPermission(receipt.agentId!, "held-permission");
  release();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(0);
  expect(retainedReturn(f.sourceHome).receivedNotices?.[0]?.state).toBe("suppressed");
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "turn-1", "Final result");
  f.state.now += 10000;
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(1);
  expect(f.finishNotices[0]?.text).toContain("finished");
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
    const confirmLimit = vi.fn(async ({ accountId }: { accountId: string }) => ({
      accountId,
      kind: limitKind,
      resetAt,
    }));
    await rotate(
      f.sourcePool,
      "pooled-session",
      "claude",
      { kind: limitKind, resetAt, confirmLimit },
      f.state.now,
    );
    expect(confirmLimit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ accountId: sharedAccount }),
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

test.each(["local", "source"])(
  "the later %s limit sets status and earliest reset",
  async (winner) => {
    const f = await limitFixture();
    const shortReset = new Date(f.state.now + 3600000).toISOString();
    const longReset = new Date(f.state.now + 5 * 86400000).toISOString();
    await markAccountLimited(
      f.targetPool,
      sharedAccount,
      {
        kind: winner === "local" ? "weekly" : "session",
        resetAt: winner === "local" ? longReset : shortReset,
      },
      f.state.now,
    );
    f.state.now += 1000;
    await markAccountLimited(
      f.sourcePool,
      sharedAccount,
      {
        kind: winner === "source" ? "weekly" : "session",
        resetAt: winner === "source" ? longReset : shortReset,
      },
      f.state.now,
    );
    expect(await f.source.shareAccountLimits()).toEqual({ delivered: 1, failed: 0 });
    const accounts = readAccounts(f.targetPool);
    expect(publicView(accounts, f.state.now).accounts[0]).toMatchObject({
      limitKind: "weekly",
      status: { state: "limited", until: longReset, source: winner },
    });
    expect(await assign(f.targetPool, "new-session", "claude", f.state.now)).toMatchObject({
      allLimited: true,
      earliestReset: longReset,
    });
  },
);

test("a suppressed limit observation is sent once until its key changes", async () => {
  const f = await limitFixture();
  await update(f.targetPool, (store) => {
    store.accounts = [];
  });
  const resetAt = new Date(f.state.now + 3600000).toISOString();
  await markAccountLimited(f.sourcePool, sharedAccount, { kind: "session", resetAt }, f.state.now);
  expect(await f.source.shareAccountLimits()).toEqual({ delivered: 1, failed: 0 });
  expect(await f.source.shareAccountLimits()).toEqual({ delivered: 0, failed: 0 });
  f.state.now += 1000;
  await markAccountLimited(f.sourcePool, sharedAccount, { kind: "weekly", resetAt }, f.state.now);
  expect(await f.source.shareAccountLimits()).toEqual({ delivered: 1, failed: 0 });
  expect(await f.source.shareAccountLimits()).toEqual({ delivered: 0, failed: 0 });
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

test.each([undefined, false])(
  "limit sharing stays off when shareLimits is %s",
  async (shareLimits) => {
    const f = await limitFixture();
    f.sourceConfig.outgoing[0]!.shareLimits = shareLimits;
    f.save();
    const resetAt = new Date(f.state.now + 3600000).toISOString();
    await markAccountLimited(
      f.sourcePool,
      sharedAccount,
      { kind: "session", resetAt },
      f.state.now,
    );
    expect(await f.source.shareAccountLimits()).toEqual({ delivered: 0, failed: 0 });
    expect(accountStatus(readAccounts(f.targetPool).accounts[0], f.state.now)).toEqual({
      state: "ok",
    });
  },
);

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
  const waitForObservation = (expectedReset: string) =>
    new Promise<void>((resolve) => {
      const watcher = watch(path.join(f.targetPool, "accounts"), (_event, file) => {
        if (
          file === "remote-limits.json" &&
          accountStatus(readAccounts(f.targetPool).accounts[0], f.state.now).until === expectedReset
        ) {
          watcher.close();
          resolve();
        }
      });
      cleanups.push(async () => {
        watcher.close();
      });
    });
  await markAccountLimited(f.sourcePool, sharedAccount, { kind: "session", resetAt }, f.state.now);
  const startup = waitForObservation(resetAt);
  const warnings: string[] = [];
  const close = startHostLimitSharing(f.source, path.join(f.root, "source"), () =>
    warnings.push("failed"),
  );
  cleanups.push(async () => close());
  await startup;
  expect(accountStatus(readAccounts(f.targetPool).accounts[0], f.state.now).until).toBe(resetAt);
  f.state.now += 1000;
  const weeklyReset = new Date(f.state.now + 86400000).toISOString();
  const later = waitForObservation(weeklyReset);
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

test("remote parent follow-ups re-arm each turn and joined steers share one notice", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  const child = receipt.agentId!;
  const { formatWorkerFinish } = loadAgentPolicy("report-notices");
  f.target.recordWorkerStarted(child, "first-turn");
  f.target.recordWorkerNotice(
    child,
    "finished",
    "first",
    formatWorkerFinish("First result.", { totalUsd: 1.25 }),
    "first-turn",
  );
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(1);
  for (const id of [
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ]) {
    await f.source.promptForAgent("lead", "target", {
      issuedAt: spawn.issuedAt,
      agentId: child,
      prompt: "Follow-up.",
      messageId: id,
      steer: true,
    });
  }
  f.target.recordWorkerStarted(child, "second-turn");
  f.target.recordWorkerNotice(
    child,
    "finished",
    "second",
    formatWorkerFinish("Second result.", { totalUsd: 4 }),
    "second-turn",
  );
  f.target.recordWorkerNotice(child, "finished", "second", "Duplicate result.");
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(2);
  expect(f.finishNotices[1]?.text).toContain("Second result.");
  expect(f.finishNotices[0]?.text).toContain("Session total spend: US$1.250000.");
  expect(f.finishNotices[1]?.text).toContain("Session total spend: US$4.000000.");
  await expect(
    f.source.promptForAgent("other", "target", {
      issuedAt: spawn.issuedAt,
      agentId: child,
      prompt: "Refused.",
      messageId,
    }),
  ).rejects.toThrow("No unique retained remote worker grant");
});

test("a remote follow-up can enable notices after creation opted out", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: false,
  });
  await f.source.promptForAgent("lead", "target", {
    issuedAt: spawn.issuedAt,
    agentId: receipt.agentId!,
    prompt: "Follow-up.",
    messageId: "22222222-2222-4222-8222-222222222222",
  });
  f.target.recordWorkerStarted(receipt.agentId!);
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "next", "Result.");
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(1);
});

test("a late prior-turn response cannot close a new remote notice watch", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerStarted(receipt.agentId!);
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "old", "Old result.");
  const realFetch = globalThis.fetch;
  let release!: () => void;
  let observed!: () => void;
  const responseReady = new Promise<void>((resolve) => {
    observed = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let delay = true;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    const result = await realFetch(url, options);
    if (delay && JSON.parse(String(options?.body)).kind === "notices") {
      delay = false;
      observed();
      await barrier;
    }
    return result;
  });
  try {
    const stale = f.source.syncNotifications();
    await responseReady;
    await f.source.promptForAgent("lead", "target", {
      issuedAt: spawn.issuedAt,
      agentId: receipt.agentId!,
      prompt: "Next task.",
      messageId: "22222222-2222-4222-8222-222222222222",
    });
    release();
    await stale;
    expect(retainedReturn(f.sourceHome).complete).toBe(false);
    f.target.recordWorkerStarted(receipt.agentId!);
    f.target.recordWorkerNotice(receipt.agentId!, "finished", "next", "New result.");
    await f.source.syncNotifications();
    await f.source.flushNotificationDeliveries();
    expect(f.finishNotices).toHaveLength(2);
    expect(retainedReturn(f.sourceHome).complete).toBe(true);
  } finally {
    release();
    spy.mockRestore();
  }
});

test("acknowledged history remains bounded beyond 128 results", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  const history = Array.from({ length: 128 }, (_, index) => ({
    id: String(index).padStart(64, "0"),
    kind: "finished",
    text: `Historical result ${index}.`,
  }));
  const inboxFile = path.join(f.deps.home, "host-links-inbox.json");
  const outboxFile = path.join(f.sourceHome, "host-links-outbox.json");
  const inbox = HostLinkJournalSchema.parse(JSON.parse(readFileSync(inboxFile, "utf8")));
  const outbox = HostLinkJournalSchema.parse(JSON.parse(readFileSync(outboxFile, "utf8")));
  const owner = Object.values(inbox).find((entry) => entry.profile)!;
  Object.assign(owner, { notices: history, complete: true, finishArmed: false });
  const sourceEntry = Object.values(outbox)[0]!;
  Object.assign(sourceEntry, {
    complete: true,
    receivedNotices: history.map((notice) => ({
      id: notice.id,
      kind: notice.kind,
      text: notice.text,
      state: "delivered",
      attempts: 0,
      nextAt: 0,
    })),
  });
  writePrivateFileAtomicSync(inboxFile, JSON.stringify(inbox));
  writePrivateFileAtomicSync(outboxFile, JSON.stringify(outbox));
  for (let index = 0; index < 3; index++) {
    await f.source.promptForAgent("lead", "target", {
      issuedAt: spawn.issuedAt,
      agentId: receipt.agentId!,
      prompt: "Next task.",
      messageId: `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
    });
    f.target.recordWorkerStarted(receipt.agentId!);
    f.target.recordWorkerNotice(receipt.agentId!, "finished", `turn-${index}`, `Result ${index}.`);
    await f.source.syncNotifications();
    await f.source.flushNotificationDeliveries();
  }
  expect(f.finishNotices).toHaveLength(3);
  expect(retainedReturn(f.sourceHome).receivedNotices?.length).toBeLessThan(3);
});

test("failed remote admission settles the retained receipt and never retries the task", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "old", "Old result.");
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  const prompt = vi
    .spyOn(f.deps, "prompt")
    .mockRejectedValue(new HostLinkError("refused", "Fixture admission refused."));
  const request = {
    issuedAt: spawn.issuedAt,
    agentId: receipt.agentId!,
    prompt: "Next task.",
    messageId: "22222222-2222-4222-8222-222222222222",
  };
  await expect(f.source.promptForAgent("lead", "target", request)).rejects.toMatchObject({
    code: "refused",
  });
  await expect(f.source.promptForAgent("lead", "target", request)).rejects.toMatchObject({
    code: "refused",
  });
  expect(prompt).toHaveBeenCalledOnce();
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(2);
  expect(f.finishNotices[1]?.text).toContain("not delivered");
});

test("interrupted admission returns one uncertain result without replay", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "old", "Old result.");
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  const promptId = "22222222-2222-4222-8222-222222222222";
  await f.source.promptForAgent("lead", "target", {
    issuedAt: spawn.issuedAt,
    agentId: receipt.agentId!,
    prompt: "Next task.",
    messageId: promptId,
  });
  const file = path.join(f.deps.home, "host-links-inbox.json");
  const journal = HostLinkJournalSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const pending = Object.values(journal).find(
    (entry) => entry.promptRequest && entry.receipt.messageId === promptId,
  )!;
  pending.receipt.state = "pending";
  writePrivateFileAtomicSync(file, JSON.stringify(journal));
  Object.assign(f.deps, { promptState: async () => null });
  const target = f.restartTarget();
  await target.recoverPromptAdmissions();
  await target.recoverPromptAdmissions();
  expect(f.prompts).toHaveLength(1);
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(2);
  expect(f.finishNotices[1]?.text).toContain("uncertain; do not replay");
});

test("history pruning fences an in-flight read from the new watch", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "old", "Old result.");
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  const realFetch = globalThis.fetch;
  let allowPrompt!: () => void, allowRead!: () => void;
  let promptReady!: () => void, readReady!: () => void;
  const promptStarted = new Promise<void>((resolve) => {
    promptReady = resolve;
  });
  const readStarted = new Promise<void>((resolve) => {
    readReady = resolve;
  });
  const promptBarrier = new Promise<void>((resolve) => {
    allowPrompt = resolve;
  });
  const readBarrier = new Promise<void>((resolve) => {
    allowRead = resolve;
  });
  let delay = true;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) => {
    const kind = JSON.parse(String(options?.body)).kind;
    if (kind === "prompt") {
      promptReady();
      await promptBarrier;
    }
    const response = await realFetch(url, options);
    if (kind === "notices" && delay) {
      delay = false;
      readReady();
      await readBarrier;
    }
    return response;
  });
  try {
    const prompt = f.source.promptForAgent("lead", "target", {
      issuedAt: spawn.issuedAt,
      agentId: receipt.agentId!,
      prompt: "Next task.",
      messageId: "22222222-2222-4222-8222-222222222222",
    });
    await promptStarted;
    const stale = f.source.syncNotifications();
    await readStarted;
    allowPrompt();
    await prompt;
    allowRead();
    await stale;
    await f.source.flushNotificationDeliveries();
    expect(f.finishNotices).toHaveLength(1);
    f.target.recordWorkerNotice(receipt.agentId!, "finished", "next", "New result.");
    await f.source.syncNotifications();
    await f.source.flushNotificationDeliveries();
    expect(f.finishNotices).toHaveLength(2);
  } finally {
    allowPrompt();
    allowRead();
    spy.mockRestore();
  }
});

test("long remote failures retain spend after target restart and delivery", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerStarted(receipt.agentId!);
  const { formatWorkerFinish } = loadAgentPolicy("report-notices");
  f.target.recordWorkerNotice(
    receipt.agentId!,
    "failed",
    "cost-failure",
    formatWorkerFinish("Fixture error ".repeat(1000), { totalUsd: 17.52 }),
  );
  f.restartTarget();
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(1);
  expect(f.finishNotices[0]!.text).toContain("Session total spend: US$17.520000.");
});

test("Windows timeout after rename retains the pending identity on a same-id retry", async () => {
  const f = await fixture();
  const platform = process.platform;
  let fail = true;
  vi.mocked(writeWindowsPrivateFileAtomicSync).mockImplementation((file, data) => {
    writeFileSync(file, data, { mode: 0o600 });
    if (fail) {
      fail = false;
      throw new WindowsPrivateFileReconciliationError();
    }
  });
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    await expect(f.target.receive(linkToken, f.wire)).rejects.toThrow("requires reconciliation");
    const saved = JSON.parse(readFileSync(path.join(f.deps.home, "host-links-inbox.json"), "utf8"));
    const pending = Object.values(saved)[0] as { receipt: unknown };
    expect(await f.target.receive(linkToken, f.wire)).toEqual(pending.receipt);
    expect(f.created).toHaveLength(0);
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
    vi.mocked(writeWindowsPrivateFileAtomicSync).mockRestore();
  }
});

test("Windows readers refuse an unsafe ACL before using grants", async () => {
  const f = await fixture();
  const platform = process.platform;
  vi.mocked(writeWindowsPrivateFileAtomicSync).mockImplementation((file, data) =>
    writeFileSync(file, data, { mode: 0o600 }),
  );
  vi.mocked(windowsAclIsSafe).mockReturnValue(false);
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    await expect(f.target.receive(linkToken, f.wire)).rejects.toThrow(
      "A private host-link file is required",
    );
    expect(f.created).toHaveLength(0);
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
    vi.mocked(windowsAclIsSafe).mockReturnValue(true);
    vi.mocked(writeWindowsPrivateFileAtomicSync).mockRestore();
  }
});

test("archived acknowledged workers leave replay fences and release journal space", async () => {
  const f = await fixture();
  const request = { ...spawn, notifyOnFinish: true };
  const receipt = await f.source.spawnForAgent("lead", "target", request);
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "gc-turn", "Completed result");
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(1);
  f.state.now += 10000;
  await f.source.syncNotifications();
  expect(
    Object.keys(JSON.parse(readFileSync(path.join(f.deps.home, "host-links-inbox.json"), "utf8"))),
  ).toHaveLength(1);
  f.chats.get(receipt.agentId!)!.archived = true;
  f.state.now += 10000;
  await f.source.syncNotifications();
  expect(
    Object.keys(JSON.parse(readFileSync(path.join(f.deps.home, "host-links-inbox.json"), "utf8"))),
  ).toHaveLength(0);
  expect(
    Object.keys(
      JSON.parse(readFileSync(path.join(f.sourceHome, "host-links-outbox.json"), "utf8")),
    ),
  ).toHaveLength(0);
  const source = f.restartSource();
  const target = f.restartTarget();
  expect(await source.spawnForAgent("lead", "target", request)).toEqual(receipt);
  expect((await target.receive(linkToken, { ...f.wire, notifyOnFinish: true })).agentId).toBe(
    receipt.agentId,
  );
  expect(f.created).toHaveLength(1);
  await expect(
    source
      .spawnForAgent("lead", "target", { ...request, prompt: "Changed" })
      .then(() => "admitted"),
  ).rejects.toThrow("retained request");
});

test("a refused notice save reaches its source lead through the existing watch", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerNoticeFailure(receipt.agentId!, new HostLinkStorageError("capacity"));
  f.restartTarget();
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(1);
  expect(f.finishNotices[0]!.text).toContain("could not save a worker notice");
  f.state.now += 10000;
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(1);
});

test("archive cleanup keeps unacknowledged and uncertain notices", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "unacked", "Retain this result");
  f.chats.get(receipt.agentId!)!.archived = true;
  f.state.failAfterHandoff = true;
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  f.state.now += 10000;
  await f.source.syncNotifications();
  expect(
    Object.keys(JSON.parse(readFileSync(path.join(f.deps.home, "host-links-inbox.json"), "utf8"))),
  ).toHaveLength(1);
  expect(
    Object.keys(
      JSON.parse(readFileSync(path.join(f.sourceHome, "host-links-outbox.json"), "utf8")),
    ),
  ).toHaveLength(1);
  expect(retainedReturn(f.sourceHome).receivedNotices?.[0]?.state).toBe("uncertain");
});

test("cleanup writes replay protection before an interrupted journal removal", async () => {
  const f = await fixture();
  const request = { ...spawn, notifyOnFinish: true };
  const receipt = await f.source.spawnForAgent("lead", "target", request);
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "gc-interrupted", "Keep the outcome");
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  f.chats.get(receipt.agentId!)!.archived = true;
  const file = path.join(f.deps.home, "host-links-inbox.json");
  const rename = vi.mocked(renameSync).getMockImplementation()!;
  vi.mocked(renameSync).mockImplementation((from, to) => {
    if (to === file) throw new Error("Interrupted journal removal");
    rename(from, to);
  });
  f.state.now += 10000;
  await f.source.syncNotifications();
  expect(Object.keys(JSON.parse(readFileSync(`${file}.replay`, "utf8")))).toHaveLength(1);
  expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toHaveLength(1);
  vi.mocked(renameSync).mockRestore();
  const target = f.restartTarget();
  expect((await target.receive(linkToken, { ...f.wire, notifyOnFinish: true })).agentId).toBe(
    receipt.agentId,
  );
  expect(f.created).toHaveLength(1);
  f.state.now += 60000;
  await f.source.syncNotifications();
  expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toHaveLength(0);
});

test("archive cleanup also removes workers that opted out of finish notices", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", spawn);
  f.chats.get(receipt.agentId!)!.archived = true;
  await f.source.syncNotifications();
  expect(
    Object.keys(
      JSON.parse(readFileSync(path.join(f.sourceHome, "host-links-outbox.json"), "utf8")),
    ),
  ).toHaveLength(0);
  expect(
    Object.keys(JSON.parse(readFileSync(path.join(f.deps.home, "host-links-inbox.json"), "utf8"))),
  ).toHaveLength(0);
  expect(f.finishNotices).toHaveLength(0);
});

test("replay capacity refuses new spawns without dropping live replay protection", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", spawn);
  f.chats.get(receipt.agentId!)!.archived = true;
  await f.source.syncNotifications();
  const file = path.join(f.sourceHome, "host-links-outbox.json.replay");
  const replay = JSON.parse(readFileSync(file, "utf8"));
  const first = Object.keys(replay)[0]!;
  const padding = {
    ...replay[first],
    hash: "x".repeat(1024 * 1024),
    retiredAt: f.state.now,
  };
  replay.padding = padding;
  const original = JSON.stringify(replay);
  writeFileSync(file, original, { mode: 0o600 });
  await expect(
    f.source
      .spawnForAgent("lead", "target", {
        ...spawn,
        messageId: "22222222-2222-4222-8222-222222222222",
      })
      .then(() => "admitted"),
  ).rejects.toThrow("replay storage is full");
  expect(readFileSync(file, "utf8")).toBe(original);
  expect((await f.source.spawnForAgent("lead", "target", spawn)).agentId).toBe(receipt.agentId);
  // Record age permits removal even while the credential stays configured.
  replay.padding.retiredAt = f.state.now - 31 * 86400000;
  writeFileSync(file, JSON.stringify(replay), { mode: 0o600 });
  expect(
    (
      await f.source.spawnForAgent("lead", "target", {
        ...spawn,
        messageId: "22222222-2222-4222-8222-222222222222",
      })
    ).state,
  ).toBe("created");
  expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toEqual([first]);
});

test("Windows spawn headroom preserves room for an existing worker finish", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const file = path.join(f.deps.home, "host-links-inbox.json");
  const journal = JSON.parse(readFileSync(file, "utf8"));
  const key = Object.keys(journal)[0]!;
  journal[key].hash = "x".repeat(512 * 1024);
  writeFileSync(file, JSON.stringify(journal), { mode: 0o600 });
  vi.mocked(writeWindowsPrivateFileAtomicSync).mockImplementation((target, data) =>
    writeFileSync(target, data, { mode: 0o600 }),
  );
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    await expect(
      f.target
        .receive(linkToken, { ...f.wire, messageId: "22222222-2222-4222-8222-222222222222" })
        .then(() => "admitted"),
    ).rejects.toThrow("Reserved space is for worker notices");
    f.target.recordWorkerNotice(receipt.agentId!, "finished", "reserved", "Final result");
    expect(JSON.parse(readFileSync(file, "utf8"))[key].notices[0].text).toBe("Final result");
    expect(f.created).toHaveLength(1);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    vi.mocked(writeWindowsPrivateFileAtomicSync).mockRestore();
  }
});

test("a lost archive acknowledgement reply recovers without replaying a queued prompt", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  const promptId = "22222222-2222-4222-8222-222222222222";
  await f.source.promptForAgent("lead", "target", {
    issuedAt: spawn.issuedAt,
    agentId: receipt.agentId!,
    messageId: promptId,
    prompt: "Next task",
  });
  f.target.recordWorkerStarted(receipt.agentId!);
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "archive-reply", "Final result");
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  f.chats.get(receipt.agentId!)!.archived = true;
  const worker = f.target.worker.bind(f.target);
  const lost = vi.spyOn(f.target, "worker").mockImplementation(async (token, raw) => {
    const result = await worker(token, raw);
    if ((raw as { kind: string }).kind === "acknowledge")
      throw new Error("Archive acknowledgement reply lost");
    return result;
  });
  f.state.now += 10000;
  await f.source.syncNotifications();
  expect(
    Object.keys(JSON.parse(readFileSync(path.join(f.deps.home, "host-links-inbox.json"), "utf8"))),
  ).toHaveLength(0);
  expect(retainedReturn(f.sourceHome).pendingPromptIds).toEqual([]);
  lost.mockRestore();
  f.sourceConfig.outgoing[0]!.expiresAt += 1000;
  f.targetConfig.incoming[0]!.expiresAt += 1000;
  f.save();
  const source = f.restartSource();
  f.restartTarget();
  f.state.now += 60000;
  await source.syncNotifications();
  expect(
    Object.keys(
      JSON.parse(readFileSync(path.join(f.sourceHome, "host-links-outbox.json"), "utf8")),
    ),
  ).toHaveLength(0);
  expect(f.prompts).toHaveLength(1);
  expect(f.created).toHaveLength(1);
  expect(f.finishNotices).toHaveLength(1);
});

test("archive cleanup checks the current archive state after its identity lookup", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "archive-race", "Retain control");
  f.chats.get(receipt.agentId!)!.archived = true;
  const target = new HostLinks({ ...f.deps, workerArchived: () => false });
  const journal = JSON.parse(readFileSync(path.join(f.deps.home, "host-links-inbox.json"), "utf8"));
  const owner = Object.values(journal)[0] as { notices: { id: string }[] };
  expect(
    await target.worker(receipt.token, {
      kind: "acknowledge",
      agentId: receipt.agentId,
      noticeIds: owner.notices.map((notice) => notice.id),
    }),
  ).toEqual({ archived: false });
  expect(
    Object.keys(JSON.parse(readFileSync(path.join(f.deps.home, "host-links-inbox.json"), "utf8"))),
  ).toHaveLength(1);
});

test("archive acknowledgement failures retain a bounded retry count", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "cleanup-offline", "Delivered once");
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  const worker = f.target.worker.bind(f.target);
  const unavailable = vi.spyOn(f.target, "worker").mockImplementation((token, raw) => {
    if ((raw as { kind: string }).kind === "acknowledge")
      return Promise.reject(new Error("Cleanup unavailable"));
    return worker(token, raw);
  });
  for (let attempt = 0; attempt < 8; attempt++) {
    f.state.now += 60000;
    await f.source.syncNotifications();
  }
  expect(retainedReturn(f.sourceHome).watch?.failures).toBe(8);
  const reads = f.state.noticeReads;
  f.state.now += 60000;
  await f.source.syncNotifications();
  expect(f.state.noticeReads).toBe(reads);
  expect(f.finishNotices).toHaveLength(1);
  unavailable.mockRestore();
});

test("configured replay fences expire after their retention period", async () => {
  const f = await fixture();
  const first = await f.source.spawnForAgent("lead", "target", spawn);
  const second = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    messageId: "22222222-2222-4222-8222-222222222222",
  });
  f.chats.get(first.agentId!)!.archived = true;
  await f.source.syncNotifications();
  const file = path.join(f.sourceHome, "host-links-outbox.json.replay");
  expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toHaveLength(1);
  f.state.now += 31 * 86400000;
  f.chats.get(second.agentId!)!.archived = true;
  await f.source.syncNotifications();
  const fences = Object.values(JSON.parse(readFileSync(file, "utf8"))) as {
    receipt: { agentId: string };
  }[];
  expect(fences.map((entry) => entry.receipt.agentId)).toEqual([second.agentId]);
});

test("a retired worker event leaves a visible repair marker without restoring its grant", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", spawn);
  f.chats.get(receipt.agentId!)!.archived = true;
  await f.source.syncNotifications();
  f.target.recordWorkerNotice(
    receipt.agentId!,
    "finished",
    "restored-turn",
    "Unexpected restored result",
  );
  const file = path.join(f.deps.home, "host-links-notice-failures.json");
  let markers: Record<string, boolean> = {};
  try {
    markers = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* Missing marker fails the assertion. */
  }
  expect(markers[receipt.agentId!]).toBe(true);
  expect(
    Object.keys(JSON.parse(readFileSync(path.join(f.deps.home, "host-links-inbox.json"), "utf8"))),
  ).toHaveLength(0);
});

test("a short reconciliation fence does not set a failure marker or hide the real finish", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerNoticeFailure(
    receipt.agentId!,
    new Error("Windows durable file commit requires reconciliation."),
  );
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(0);
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "actual", "Actual result");
  f.state.now += 10000;
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(1);
  expect(f.finishNotices[0]!.text).toContain("Actual result");
});

test("old spawn and prompt requests stay refused after replay records expire", async () => {
  const f = await fixture();
  const first = await f.source.spawnForAgent("lead", "target", spawn);
  f.chats.get(first.agentId!)!.archived = true;
  await f.source.syncNotifications();
  f.state.now += 31 * 86400000;
  const fresh = {
    ...spawn,
    issuedAt: f.state.now,
    messageId: "22222222-2222-4222-8222-222222222222",
  };
  const second = await f.source.spawnForAgent("lead", "target", fresh);
  await expect(
    f.source.spawnForAgent("lead", "target", spawn).then(() => "admitted"),
  ).rejects.toThrow("issuedAt");
  await expect(f.target.receive(linkToken, f.wire).then(() => "admitted")).rejects.toThrow(
    "issuedAt",
  );
  const prompt = {
    agentId: second.agentId!,
    prompt: "Old task",
    messageId,
    issuedAt: spawn.issuedAt,
  };
  await expect(f.source.promptForAgent("lead", "target", prompt)).rejects.toThrow("issuedAt");
  await expect(f.target.worker(second.token, { ...prompt, kind: "prompt" })).rejects.toThrow(
    "issuedAt",
  );
  expect(f.created).toHaveLength(2);
  expect(f.prompts).toHaveLength(0);
});

test("source and receiver apply the same clock skew and request age boundary", async () => {
  const f = await fixture();
  const tooFuture = { ...spawn, issuedAt: f.state.now + 5 * 60000 + 1 };
  await expect(
    f.source.spawnForAgent("lead", "target", tooFuture).then(() => "admitted"),
  ).rejects.toThrow("issuedAt");
  await expect(
    f.target.receive(linkToken, { ...f.wire, issuedAt: tooFuture.issuedAt }).then(() => "admitted"),
  ).rejects.toThrow("issuedAt");
  const edge = { ...spawn, issuedAt: f.state.now - (30 * 86400000 - 5 * 60000) + 1 };
  expect((await f.source.spawnForAgent("lead", "target", edge)).state).toBe("created");
  f.state.now++;
  await expect(
    f.source.spawnForAgent("lead", "target", edge).then(() => "admitted"),
  ).rejects.toThrow("issuedAt");
  await expect(
    f.target.receive(linkToken, { ...f.wire, issuedAt: edge.issuedAt }).then(() => "admitted"),
  ).rejects.toThrow("issuedAt");
  expect(f.created).toHaveLength(1);
});

test("a committed real finish clears a capacity warning and keeps the result text", async () => {
  const f = await fixture();
  const request = { ...spawn, notifyOnFinish: true };
  const receipt = await f.source.spawnForAgent("lead", "target", request);
  f.target.recordWorkerNoticeFailure(receipt.agentId!, new HostLinkStorageError("capacity"));
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(retainedReturn(f.sourceHome).watch?.failures).toBe(8);
  const reads = f.state.noticeReads;
  f.state.now += 10000;
  await f.source.syncNotifications();
  expect(f.state.noticeReads).toBe(reads);
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "repaired", "The actual result");
  expect(
    JSON.parse(readFileSync(path.join(f.deps.home, "host-links-notice-failures.json"), "utf8"))[
      receipt.agentId!
    ],
  ).toBeUndefined();
  await f.source.spawnForAgent("lead", "target", request);
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(2);
  expect(f.finishNotices[1]!.text).toContain("The actual result");
});

test("legacy active workers accept fresh prompts while timestamp-free pending requests never replay", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", spawn);
  const file = path.join(f.sourceHome, "host-links-outbox.json");
  const entries = JSON.parse(readFileSync(file, "utf8"));
  const key = Object.keys(entries)[0]!;
  delete entries[key].issuedAt;
  delete entries[key].wire.issuedAt;
  writeFileSync(file, JSON.stringify(entries), { mode: 0o600 });
  await f.source.promptForAgent("lead", "target", {
    agentId: receipt.agentId!,
    messageId: "22222222-2222-4222-8222-222222222222",
    prompt: "Fresh follow-up",
    issuedAt: f.state.now,
  });
  expect(f.prompts).toEqual(["Fresh follow-up"]);
  const pending = JSON.parse(readFileSync(file, "utf8"));
  pending[key].receipt.state = "pending";
  writeFileSync(file, JSON.stringify(pending), { mode: 0o600 });
  const source = f.restartSource();
  await source.syncNotifications();
  expect(f.created).toHaveLength(1);
  expect(retainedReturn(f.sourceHome).receipt.state).toBe("pending");
  expect(retainedReturn(f.sourceHome).watch?.failures).toBe(1);
});

test("source stamps a missing spawn time once and reuses it after uncertainty and restart", async () => {
  const f = await fixture();
  const { issuedAt: _omitted, ...request } = spawn;
  const receive = f.target.receive.bind(f.target);
  const times: number[] = [];
  const lost = vi.spyOn(f.target, "receive").mockImplementation(async (token, wire) => {
    times.push((wire as { issuedAt: number }).issuedAt);
    const receipt = await receive(token, wire);
    if (times.length === 1) throw new Error("Created receipt reply lost");
    return receipt;
  });
  await expect(f.source.spawnForAgent("lead", "target", request)).rejects.toThrow();
  const original = f.state.now;
  f.state.now += 60000;
  const source = f.restartSource();
  const receipt = await source.spawnForAgent("lead", "target", request);
  expect(receipt.state).toBe("created");
  expect(times).toEqual([original, original]);
  expect(f.created).toHaveLength(1);
  lost.mockRestore();
  f.chats.get(receipt.agentId!)!.archived = true;
  await source.syncNotifications();
  f.state.now += 60000;
  const replay = await f.restartSource().spawnForAgent("lead", "target", request);
  expect(replay).toEqual(receipt);
  expect(f.created).toHaveLength(1);
});

test("source refuses a changed spawn time while its UUID is active or retired", async () => {
  const f = await fixture();
  const { issuedAt: _omitted, ...request } = spawn;
  const first = await f.source.spawnForAgent("lead", "target", request);
  const changed = { ...request, issuedAt: f.state.now + 1 };
  await expect(f.source.spawnForAgent("lead", "target", changed)).rejects.toMatchObject({
    code: "conflict",
  });
  f.chats.get(first.agentId!)!.archived = true;
  await f.source.syncNotifications();
  await expect(f.restartSource().spawnForAgent("lead", "target", changed)).rejects.toMatchObject({
    code: "conflict",
  });
  expect(f.created).toHaveLength(1);
});

test("a retired worker warning reaches the source after a lost cleanup reply", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "old-result", "Original result");
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  f.chats.get(receipt.agentId!)!.archived = true;
  const worker = f.target.worker.bind(f.target);
  const lost = vi.spyOn(f.target, "worker").mockImplementation(async (token, raw) => {
    const result = await worker(token, raw);
    if ((raw as { kind: string }).kind === "acknowledge") throw new Error("Cleanup reply lost");
    return result;
  });
  f.state.now += 10000;
  await f.source.syncNotifications();
  lost.mockRestore();
  f.target.recordWorkerNotice(receipt.agentId!, "finished", "restored-event", "Retired result");
  f.state.now += 60000;
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(f.finishNotices).toHaveLength(2);
  expect(f.finishNotices[1]!.text).toContain("could not save a worker notice");
  expect(f.created).toHaveLength(1);
});

test("a permission notice save keeps a previous terminal storage failure warning", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerNoticeFailure(receipt.agentId!, new HostLinkStorageError("write"));
  f.target.recordWorkerNotice(
    receipt.agentId!,
    "permission",
    "later-permission",
    "Permission request",
  );
  await f.source.syncNotifications();
  await f.source.flushNotificationDeliveries();
  expect(
    f.finishNotices.some((notice) => notice.text.includes("could not save a worker notice")),
  ).toBe(true);
});

test("the HTTP source stamps a spawn before its first dispatch", async () => {
  const f = await fixture();
  const { issuedAt: _omitted, ...request } = spawn;
  expect((await f.dispatch(request)).status).toBe(200);
  const retained = retainedReturn(f.sourceHome);
  expect(retained.issuedAt).toBe(f.state.now);
  f.state.now += 60000;
  expect((await f.dispatch(request)).status).toBe(200);
  expect(retainedReturn(f.sourceHome).issuedAt).toBe(retained.issuedAt);
  expect((await f.dispatch({ ...request, issuedAt: f.state.now })).status).toBe(409);
  expect(f.created).toHaveLength(1);
});

test("only acknowledgement of the storage warning clears its marker without a terminal save", async () => {
  const f = await fixture();
  const receipt = await f.source.spawnForAgent("lead", "target", {
    ...spawn,
    notifyOnFinish: true,
  });
  f.target.recordWorkerNoticeFailure(receipt.agentId!, new HostLinkStorageError("write"));
  const query = () =>
    f.target.worker(receipt.token, { kind: "notices", agentId: receipt.agentId }) as Promise<{
      notices: { id: string }[];
    }>;
  const warning = (await query()).notices[0]!;
  await f.target.worker(receipt.token, {
    kind: "acknowledge",
    agentId: receipt.agentId,
    noticeIds: [],
  });
  expect((await query()).notices).toHaveLength(1);
  await f.target.worker(receipt.token, {
    kind: "acknowledge",
    agentId: receipt.agentId,
    noticeIds: [warning.id],
  });
  expect((await query()).notices).toHaveLength(0);
});
