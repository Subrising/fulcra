import express from "express";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { afterEach, expect, test } from "vitest";
import {
  HostLinks,
  type HostLinkChat,
  type HostLinkCreate,
  type HostLinkRoleNotice,
} from "./host-links.js";
import { mountHostLinkRoutes } from "./host-link-routes.js";
import { HostLinkReceiptSchema, type HostLinkConfig } from "./host-link-contracts.js";
import { writePrivateFileAtomicSync } from "./private-files.js";
import {
  isAgentMcpRequestAuthorized,
  isBearerTokenValidAsync,
  isBearerTokenValidSync,
  createRequireBearerMiddleware,
} from "./auth.js";

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
    failCreate: false,
    beforeNotice: () => {},
    afterCreate: () => {},
  };
  const deps = {
    home: path.join(root, "target"),
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
