import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createPaseoToolCatalog } from "../agent/tools/paseo-tools.js";
import { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import { hasArmedFinishNotification } from "../agent/agent-prompt.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).toReversed()) await close();
});
async function fixture(parentLabel = PARENT_AGENT_ID_LABEL) {
  const root = await mkdtemp(path.join(tmpdir(), "send-finish-"));
  const prompts: string[] = [];
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: root,
    agentClients: {
      codex: createTestAgentClient("codex", {
        onStartTurn: (prompt) =>
          prompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt)),
      }),
    },
  });
  let client: DaemonClient | undefined;
  cleanups.push(async () => {
    await client?.close();
    await daemon.close();
    await rm(root, { recursive: true, force: true });
  });
  const manager = daemon.daemon.agentManager;
  const storage = daemon.daemon.agentStorage;
  const parent = await manager.createAgent(
    { provider: "codex", cwd: root, modeId: "full-access", title: "Parent" },
    undefined,
    {},
  );
  const child = await manager.createAgent(
    { provider: "codex", cwd: root, modeId: "full-access", title: "Child" },
    undefined,
    {
      labels: { [parentLabel]: parent.id },
    },
  );
  await manager.flush();
  client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  await client.connect();
  const catalog = createPaseoToolCatalog({
    agentManager: manager,
    agentStorage: storage,
    providerSnapshotManager: Object.create(ProviderSnapshotManager.prototype),
    callerAgentId: parent.id,
    logger: createTestLogger(),
  });
  const notices = () => prompts.filter((p) => p.includes("<paseo-system>") && p.includes(child.id));
  const finish = async () => {
    await vi.waitFor(() => expect(notices()).toHaveLength(1));
    await manager.waitForAgentEvent(parent.id);
    expect(notices()).toHaveLength(1);
  };
  const hold = async () => {
    vi.spyOn(child.session!, "startTurn").mockResolvedValueOnce({ turnId: "held-turn" });
    const iterator = manager.trustedPlugins.agentInput(() =>
      manager.streamAgent(child.id, "initial work"),
    );
    const first = iterator.next();
    await vi.waitFor(() =>
      expect(manager.getAgent(child.id)?.activeForegroundTurnId).toBe("held-turn"),
    );
    return async () => {
      Reflect.get(child.session!, "notifySubscribers").call(child.session, {
        type: "turn_completed",
        provider: "codex",
        turnId: "held-turn",
      });
      await first;
      await iterator.return(undefined);
    };
  };
  return {
    daemon,
    manager,
    storage,
    parent,
    child,
    client,
    catalog,
    notices,
    finish,
    hold,
    prompts,
  };
}

test.each(["MCP", "MCP blocking", "CLI send", "CLI steer"])(
  "%s arms one notice on a later turn",
  async (route) => {
    const f = await fixture();
    // A delivered receipt from an earlier turn cannot cover this task.
    const prior = await f.storage.armFinishNotice(f.child, f.parent.id, "report-up");
    await f.storage.recordFinishNotice(f.child.id, "earlier-turn", "finished");
    await f.storage.settleFinishNotice(f.child.id, prior.messageId, "delivered", "report-up");
    if (route.startsWith("MCP"))
      await f.catalog.executeTool("send_agent_prompt", {
        agentId: f.child.id,
        prompt: "new work",
        background: route !== "MCP blocking",
      });
    else
      await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          path.resolve("../cli/src/index.ts"),
          "send",
          f.child.id,
          "new work",
          "--no-wait",
          "--host",
          `127.0.0.1:${f.daemon.port}`,
          "--json",
          ...(route === "CLI steer" ? ["--steer"] : []),
        ],
        {
          timeout: 15000,
          env: {
            ...process.env,
            PASEO_HOME: f.daemon.paseoHome,
            PASEO_AGENT_ID: f.parent.id,
            PASEO_WORKSPACE_ID: "",
            PASEO_PASSWORD: "",
          },
        },
      );
    await f.finish();
    expect((await f.storage.getFinishNotice(f.child.id))?.messageId).not.toBe(prior.messageId);
  },
);

test("three queued parent messages produce one combined turn and one finish notice", async () => {
  const f = await fixture();
  const end = await f.hold();
  for (const text of ["one", "two", "three"])
    await f.client.sendAgentMessage(f.child.id, text, {
      sender: { agentId: f.parent.id },
      queue: true,
    });
  expect(f.notices()).toHaveLength(0);
  await end();
  await f.finish();
  expect(f.prompts.filter((p) => p.includes("Message 1 from"))).toHaveLength(1);
});

test("repeated native steers join one turn and keep one finish notice", async () => {
  const f = await fixture();
  const end = await f.hold();
  f.child.session!.steerActiveTurn = vi.fn(async () => ({ status: "accepted" as const }));
  for (const text of ["one", "two", "three"])
    await f.client.sendAgentMessage(f.child.id, text, {
      sender: { agentId: f.parent.id },
      activeTurnBehavior: "steer",
    });
  expect(await f.storage.getFinishNotice(f.child.id)).toMatchObject({
    parentId: f.parent.id,
    status: "armed",
  });
  await end();
  await f.finish();
});

test("MCP queued delivery re-arms a delivered saved notice", async () => {
  const f = await fixture();
  const prior = await f.storage.armFinishNotice(f.child, f.parent.id, "report-up");
  await f.storage.recordFinishNotice(f.child.id, "earlier-turn", "finished");
  await f.storage.settleFinishNotice(f.child.id, prior.messageId, "delivered", "report-up");
  const end = await f.hold();
  await f.catalog.executeTool("send_agent_prompt", {
    agentId: f.child.id,
    prompt: "queued work",
    notifyOnFinish: true,
  });
  await end();
  await f.finish();
  expect((await f.storage.getFinishNotice(f.child.id))?.messageId).not.toBe(prior.messageId);
});

test("explicit opt-out and upward sends do not arm a finish notice", async () => {
  const f = await fixture();
  await f.client.sendAgentMessage(f.child.id, "quiet work", {
    sender: { agentId: f.parent.id },
    notifyOnFinish: false,
  });
  await vi.waitFor(() => expect(f.prompts).toContain("quiet work"));
  await f.manager.waitForAgentEvent(f.child.id);
  expect(await f.storage.getFinishNotice(f.child.id)).toBeNull();
  expect(hasArmedFinishNotification(f.manager, f.child.id, f.parent.id)).toBe(false);
  await f.client.sendAgentMessage(f.parent.id, "result", { sender: { agentId: f.child.id } });
  await vi.waitFor(() => expect(f.prompts).toContain("result"));
  expect(await f.storage.getFinishNotice(f.parent.id)).toBeNull();
  expect(f.notices()).toHaveLength(0);
});

test("a refused steer queues the next task and delivers both turn results", async () => {
  const f = await fixture();
  const end = await f.hold();
  f.child.session!.steerActiveTurn = vi.fn(async () => ({ status: "unavailable" as const }));
  const notice = await f.storage.armFinishNotice(f.child, f.parent.id, "report-up");
  await f.client.sendAgentMessage(f.child.id, "queued after refusal", {
    sender: { agentId: f.parent.id },
    activeTurnBehavior: "steer",
  });
  await end();
  await vi.waitFor(() => expect(f.notices()).toHaveLength(2));
  expect(f.prompts).toContain("queued after refusal");
  expect((await f.storage.getFinishNotice(f.child.id))?.messageId).not.toBe(notice.messageId);
});

test("a remote relay without a return route refuses the task unless it opts out", async () => {
  const f = await fixture();
  const remote = await createTestPaseoDaemon({
    agentClients: { codex: createTestAgentClient("codex") },
  });
  cleanups.push(remote.close);
  const worker = await remote.daemon.agentManager.createAgent(
    { provider: "codex", cwd: remote.paseoHome, modeId: "full-access" },
    undefined,
    {
      labels: { "fulcra.reports-to": `${f.parent.id}@${f.daemon.daemon.getServerId()}` },
    },
  );
  const client = new DaemonClient({ url: `ws://127.0.0.1:${remote.port}/ws` });
  cleanups.push(() => client.close());
  await client.connect();
  const sender = { agentId: f.parent.id, serverId: f.daemon.daemon.getServerId() };
  await expect(
    client.sendAgentMessage(worker.id, "must have a notice", { sender }),
  ).rejects.toThrow("Send through the parent host");
  await client.sendAgentMessage(worker.id, "explicit opt-out", { sender, notifyOnFinish: false });
  await remote.daemon.agentManager.waitForAgentEvent(worker.id, { waitForActive: true });
});

test("a plain reporting-line child gets a saved finish notice", async () => {
  const f = await fixture("fulcra.reports-to");
  await f.client.sendAgentMessage(f.child.id, "work", { sender: { agentId: f.parent.id } });
  await f.finish();
  expect(await f.storage.getFinishNotice(f.child.id)).toMatchObject({
    parentId: f.parent.id,
    status: "delivered",
  });
});
