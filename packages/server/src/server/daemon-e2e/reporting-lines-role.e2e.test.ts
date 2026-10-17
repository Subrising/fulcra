import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { realpathSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { MAIN_ASSISTANT_REF, REPORTS_TO_LABEL, SEAT_LABEL } from "@getpaseo/protocol/agent-labels";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { hashDaemonPassword } from "../auth.js";
import { writePrivateFileAtomicSync } from "../private-files.js";
import { HostLinkReceiptSchema, type HostLinkConfig } from "../host-link-contracts.js";
import { sendPromptToAgent, formatSystemNotificationPrompt } from "../agent/agent-prompt.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

// FULCRA(orchestration): a lead's parent is the main assistant role, not a chat id. Moving the role to another chat
// changes no lead: the lead's next send to the role reaches the new holder.

test("a lead's send to the main assistant role reaches the chat that holds the role now", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "reporting-role-"));
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;
  try {
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot: root,
      cleanup: false,
      agentClients: { codex: createTestAgentClient("codex") },
    });
    const manager = daemon.daemon.agentManager;
    const create = (title: string, labels: Record<string, string>) =>
      manager.createAgent(
        { provider: "codex", cwd: root, modeId: "full-access", title },
        undefined,
        { labels },
      );
    // A create never carries the seat label (a fork or `paseo run --label` cannot claim the role).
    const oldMain = await create("Old main assistant", { [SEAT_LABEL]: "main-assistant" });
    expect(manager.getAgent(oldMain.id)?.labels[SEAT_LABEL]).toBeUndefined();
    // The controller sets it from the seat bindings (here: the daemon's own label write).
    await manager.setLabels(oldMain.id, { [SEAT_LABEL]: "main-assistant" });
    const newMain = await create("Main assistant", {});
    const lead = await create("Mac operations lead", { [REPORTS_TO_LABEL]: MAIN_ASSISTANT_REF });

    const turns: string[] = [];
    manager.subscribe(
      (event) => {
        if (event.type === "agent_stream" && event.event.type === "turn_started")
          turns.push(event.agentId);
      },
      { replayState: false },
    );
    const nextTurn = (id: string) =>
      new Promise<void>((resolve) => {
        const off = manager.subscribe(
          (event) => {
            if (
              event.type === "agent_stream" &&
              event.agentId === id &&
              event.event.type === "turn_started"
            ) {
              off();
              resolve();
            }
          },
          { replayState: false },
        );
      });

    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    // A chat (or the app) cannot claim the role by writing the label: only the controller session writes it.
    await expect(
      client.updateAgent(lead.id, { labels: { [SEAT_LABEL]: "main-assistant" } }),
    ).rejects.toThrow("fulcra.seat follows the main assistant seat");
    expect(manager.getAgent(lead.id)?.labels[SEAT_LABEL]).toBeUndefined();
    const fromLead = { sender: { agentId: lead.id } };

    let reached = nextTurn(oldMain.id);
    await client.sendAgentMessage(MAIN_ASSISTANT_REF, "report one", fromLead);
    await reached;
    await manager.waitForAgentEvent(oldMain.id);

    // Move the role. The lead's labels do not change.
    await manager.setLabels(oldMain.id, { [SEAT_LABEL]: "" });
    await manager.setLabels(newMain.id, { [SEAT_LABEL]: "main-assistant" });
    expect(manager.getAgent(lead.id)?.labels[REPORTS_TO_LABEL]).toBe(MAIN_ASSISTANT_REF);

    reached = nextTurn(newMain.id);
    await client.sendAgentMessage(MAIN_ASSISTANT_REF, "report two", fromLead);
    await reached;
    expect(turns).toEqual([oldMain.id, newMain.id]);

    // The old holder is now outside the lead's line.
    await expect(client.sendAgentMessage(oldMain.id, "report three", fromLead)).rejects.toThrow(
      "Send this to the main assistant, Main assistant",
    );
  } finally {
    await client?.close();
    await daemon?.close();
    if (daemon) await rm(daemon.staticDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("WebSocket sends steer the native turn and combine three queued messages into one wake", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "message-queue-"));
  const prompts: unknown[] = [];
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;
  try {
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot: root,
      cleanup: false,
      agentClients: {
        codex: createTestAgentClient("codex", { onStartTurn: (prompt) => prompts.push(prompt) }),
      },
    });
    const manager = daemon.daemon.agentManager;
    const sender = await manager.createAgent(
      {
        provider: "codex",
        cwd: root,
        modeId: "full-access",
      },
      undefined,
      { workspaceId: undefined },
    );
    const target = await manager.createAgent(
      {
        provider: "codex",
        cwd: root,
        modeId: "full-access",
      },
      undefined,
      { workspaceId: undefined },
    );
    const start = vi
      .spyOn(target.session!, "startTurn")
      .mockResolvedValueOnce({ turnId: "current-turn" });
    const iterator = manager.trustedPlugins.agentInput(() =>
      manager.streamAgent(target.id, "current task"),
    );
    const first = iterator.next();
    await vi.waitFor(() =>
      expect(manager.getAgent(target.id)?.activeForegroundTurnId).toBe("current-turn"),
    );
    const steer = vi.fn(async () => ({ status: "accepted" as const }));
    target.session!.steerActiveTurn = steer;
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    let note = "";
    await client.sendAgentMessage(target.id, "change direction", {
      sender: { agentId: sender.id },
      activeTurnBehavior: "steer",
      onDelivery: (value) => {
        note = value;
      },
    });
    expect(steer).toHaveBeenCalledExactlyOnceWith(
      "change direction",
      expect.objectContaining({ expectedTurnId: "current-turn" }),
    );
    expect(note).toBe("Message delivered through native steering.");
    for (const text of ["one", "two", "three"]) {
      await client.sendAgentMessage(target.id, text, {
        sender: { agentId: sender.id },
        queue: true,
      });
    }
    expect(start).toHaveBeenCalledTimes(1);
    expect(prompts).toEqual([]);
    await manager.trustedPlugins.daemon(() => manager.cancelAgentRun(target.id));
    await first;
    await iterator.return(undefined);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts).toEqual([
      `Message 1 from ${sender.id}:\none\n\nMessage 2 from ${sender.id}:\ntwo\n\nMessage 3 from ${sender.id}:\nthree`,
    ]);
    expect(start).toHaveBeenCalledTimes(2);
  } finally {
    vi.restoreAllMocks();
    await client?.close();
    await daemon?.close();
    if (daemon) await rm(daemon.staticDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("two isolated daemons create one remote worker and deliver a role notice through narrow credentials", async () => {
  const source = await createTestPaseoDaemon({
    agentClients: { codex: createTestAgentClient("codex") },
    mcpEnabled: false,
    auth: { password: hashDaemonPassword("source-test-password") },
  });
  let target: TestPaseoDaemon | undefined;
  let stopEvents = () => {};
  try {
    target = await createTestPaseoDaemon({
      agentClients: { codex: createTestAgentClient("codex") },
      mcpEnabled: false,
      auth: { password: hashDaemonPassword("target-test-password") },
    });
    const lead = await source.daemon.agentManager.createAgent(
      {
        provider: "codex",
        cwd: source.paseoHome,
        modeId: "full-access",
        model: "gpt-5.4-mini",
        title: "Lead",
      },
      undefined,
      { workspaceId: undefined, labels: { [REPORTS_TO_LABEL]: MAIN_ASSISTANT_REF } },
    );
    const main = await target.daemon.agentManager.createAgent(
      { provider: "codex", cwd: target.paseoHome, modeId: "full-access", title: "Main assistant" },
      undefined,
      { workspaceId: undefined },
    );
    await target.daemon.agentManager.setLabels(main.id, { [SEAT_LABEL]: "main-assistant" });
    const inputs: Array<{ id: string; text: string }> = [];
    const turns: string[] = [];
    stopEvents = target.daemon.agentManager.subscribe(
      (event) => {
        if (event.type !== "agent_stream") return;
        if (event.event.type === "turn_started") turns.push(event.agentId);
        if (event.event.type === "timeline" && event.event.item.type === "user_message")
          inputs.push({ id: event.agentId, text: event.event.item.text });
      },
      { replayState: false },
    );
    const token = `hlink1.${"A".repeat(43)}`;
    const chatToken = `hchat1.${"B".repeat(43)}`;
    const sourceConfig: HostLinkConfig = {
      version: 1,
      machine: "mac",
      incoming: [],
      chats: [
        {
          agentId: lead.id,
          token: chatToken,
          operations: ["spawn", "notice"],
          links: ["remote"],
          revoked: false,
          expiresAt: 2000000000000,
        },
      ],
      outgoing: [
        {
          id: "remote",
          serverId: target.daemon.getServerId(),
          url: `http://127.0.0.1:${target.port}`,
          token,
          machine: "mac",
          reporters: [lead.id],
          revoked: false,
          expiresAt: 2000000000000,
        },
      ],
      routes: { standard: "remote", mainAssistant: "remote" },
    };
    const targetConfig: HostLinkConfig = {
      version: 1,
      machine: "mac",
      chats: [],
      outgoing: [],
      routes: {},
      incoming: [
        {
          id: "remote",
          serverId: source.daemon.getServerId(),
          token,
          leads: [lead.id],
          operations: ["spawn", "notice"],
          workloads: ["standard"],
          workspaces: { job: realpathSync(target.paseoHome) },
          profiles: {
            worker: {
              provider: "codex",
              model: "gpt-5.4-mini",
              modeId: "full-access",
              parents: ["codex:full-access"],
            },
          },
          maxWorkers: 2,
          revoked: false,
          expiresAt: 2000000000000,
        },
      ],
    };
    writePrivateFileAtomicSync(
      path.join(source.paseoHome, "host-links.json"),
      JSON.stringify(sourceConfig),
    );
    writePrivateFileAtomicSync(
      path.join(target.paseoHome, "host-links.json"),
      JSON.stringify(targetConfig),
    );
    const body = {
      kind: "spawn",
      messageId: "88888888-8888-4888-8888-888888888888",
      workload: "standard",
      workspace: "job",
      profile: "worker",
      title: "Remote worker",
      prompt: "Reply with the task result.",
    };
    const dispatch = async (input: unknown) => {
      const response = await fetch(`http://127.0.0.1:${source.port}/api/host-links/dispatch`, {
        method: "POST",
        headers: { authorization: `Bearer ${chatToken}`, "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(200);
      return HostLinkReceiptSchema.parse(await response.json());
    };
    const receipt = await dispatch(body);
    expect(receipt.state).toBe("created");
    const worker = target.daemon.agentManager.getAgent(receipt.agentId!);
    expect(worker?.labels[REPORTS_TO_LABEL]).toBe(`${lead.id}@${source.daemon.getServerId()}`);
    expect(worker?.config.modeId).toBe("full-access");
    expect(worker?.config.model).toBe("gpt-5.4-mini");
    await target.daemon.agentManager.waitForAgentEvent(receipt.agentId!);
    expect(inputs).toEqual([{ id: receipt.agentId, text: body.prompt }]);
    expect(turns).toEqual([receipt.agentId]);
    expect(await dispatch(body)).toEqual(receipt);
    expect(target.daemon.agentManager.listAgents()).toHaveLength(2);
    const notice = await dispatch({
      kind: "notice",
      messageId: "99999999-9999-4999-8999-999999999999",
      text: "Worker result is ready.",
    });
    expect(notice.state).toBe("delivered");
    expect(notice.agentId).toBe(main.id);
    await target.daemon.agentManager.waitForAgentEvent(main.id);
    expect(inputs[1]).toEqual({
      id: main.id,
      text: formatSystemNotificationPrompt(
        `Host notice from ${lead.id}@${source.daemon.getServerId()}:\nWorker result is ready.`,
      ),
    });
    const invalid = await fetch(`http://127.0.0.1:${target.port}/api/host-links/receive`, {
      method: "POST",
      headers: { authorization: `Bearer ${chatToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(invalid.status).toBe(403);
    expect(target.daemon.agentManager.listAgents()).toHaveLength(2);

    const manager = target.daemon.agentManager;
    await manager.setAgentMode(main.id, "auto-review");
    await sendPromptToAgent({
      agentManager: manager,
      agentStorage: target.daemon.agentStorage,
      agentId: main.id,
      prompt: 'printf "ok" > permission.txt',
      logger: createTestLogger(),
    });
    expect((await manager.waitForAgentEvent(main.id)).permission).not.toBe(null);
    let stopWatch = () => {};
    const queued = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        listener.close();
        reject(new Error("Notice admission event timed out."));
      }, 5000);
      const listener = watch(target!.paseoHome, (_event, file) => {
        if (file !== "host-links-inbox.json") return;
        listener.close();
        clearTimeout(timer);
        resolve();
      });
      stopWatch = () => {
        listener.close();
        clearTimeout(timer);
      };
    });
    try {
      const pendingNotice = dispatch({
        kind: "notice",
        messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        text: "Delayed remote notice.",
      });
      await queued;
      expect((await manager.waitForAgentEvent(main.id)).permission).not.toBe(null);
      const replacement = await manager.createAgent(
        {
          provider: "codex",
          cwd: target.paseoHome,
          modeId: "full-access",
          title: "New main assistant",
        },
        undefined,
        { workspaceId: undefined },
      );
      await manager.setLabels(main.id, { [SEAT_LABEL]: "" });
      await manager.setLabels(replacement.id, { [SEAT_LABEL]: "main-assistant" });
      await manager.cancelAgentRun(main.id);
      const moved = await pendingNotice;
      expect(moved.state).toBe("delivered");
      expect(moved.agentId).toBe(replacement.id);
      await manager.waitForAgentEvent(replacement.id);
      expect(inputs.filter((item) => item.id === replacement.id)).toEqual([
        {
          id: replacement.id,
          text: formatSystemNotificationPrompt(
            `Host notice from ${lead.id}@${source.daemon.getServerId()}:\nDelayed remote notice.`,
          ),
        },
      ]);
      expect(inputs.filter((item) => item.id === main.id).map((item) => item.text)).toEqual([
        formatSystemNotificationPrompt(
          `Host notice from ${lead.id}@${source.daemon.getServerId()}:\nWorker result is ready.`,
        ),
      ]);
      expect(turns.filter((id) => id === main.id)).toHaveLength(2);
    } finally {
      stopWatch();
    }
  } finally {
    stopEvents();
    await target?.close();
    await source.close();
  }
}, 60000);

test("paused PC completion notices cross the socket without starting Claude", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "notice-pause-"));
  const prompts: Array<{ provider: string; prompt: unknown }> = [];
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;
  try {
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot: root,
      cleanup: false,
      agentClients: {
        claude: createTestAgentClient("claude", {
          onStartTurn: (prompt) => prompts.push({ provider: "claude", prompt }),
        }),
        codex: createTestAgentClient("codex", {
          onStartTurn: (prompt) => prompts.push({ provider: "codex", prompt }),
        }),
      },
    });
    const manager = daemon.daemon.agentManager;
    const owner = await manager.createAgent({ provider: "claude", cwd: root }, undefined, {
      workspaceId: undefined,
    });
    const active = await manager.createAgent({ provider: "codex", cwd: root }, undefined, {
      workspaceId: undefined,
    });
    const pause = path.join(daemon.paseoHome, "pause.json");
    await writeFile(pause, JSON.stringify({ pausedProviders: ["claude"] }));
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    await client.sendAgentMessage(owner.id, "PC receipt one");
    await client.sendAgentMessage(owner.id, "PC receipt two");
    expect(prompts).toEqual([]);
    const held = JSON.parse(
      await readFile(path.join(daemon.paseoHome, "held-messages.json"), "utf8"),
    );
    expect(held.filter((record: { state: string }) => record.state === "queued")).toHaveLength(2);
    await client.sendAgentMessage(active.id, "Codex receipt");
    await vi.waitFor(() => expect(prompts.filter((p) => p.provider === "codex")).toHaveLength(1));
    expect(prompts.filter((p) => p.provider === "claude")).toHaveLength(0);
    await writeFile(pause, JSON.stringify({ pausedProviders: [] }));
    await vi.waitFor(() => expect(prompts.filter((p) => p.provider === "claude")).toHaveLength(1));
    expect(String(prompts.find((p) => p.provider === "claude")!.prompt)).toContain(
      "PC receipt one",
    );
    expect(String(prompts.find((p) => p.provider === "claude")!.prompt)).toContain(
      "PC receipt two",
    );
  } finally {
    await client?.close();
    await daemon?.close();
    if (daemon) await rm(daemon.staticDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
