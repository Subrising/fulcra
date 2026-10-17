import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { recordOpenSessions } from "../revive-on-restart.js";
import { hostLinksFor } from "../host-links.js";
import {
  HostLinkWorkerNoticesSchema,
  type HostLinkConfig,
  type HostLinkReceipt,
} from "../host-link-contracts.js";
import { writePrivateFileAtomicSync } from "../private-files.js";
import { hashDaemonPassword } from "../auth.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import { createTestLogger } from "../../test-utils/test-logger.js";

vi.mock("../limit-resume/service.js", async (original) => ({
  ...(await original<typeof import("../limit-resume/service.js")>()),
  INTERRUPTED_SETTLE_MS: 0,
  STAGGER_MS: 0,
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).toReversed()) await close();
});

test.each(["none", "local", "remote"])(
  "CLI starts a reloaded idle child and notifies its parent with blocked recovery: %s",
  async (recoveryKind) => {
    const blockRecovery = recoveryKind !== "none";
    const remoteRecovery = recoveryKind === "remote";
    const root = realpathSync(await mkdtemp(path.join(tmpdir(), "reloaded-cli-send-")));
    const staticDir = path.join(root, "static");
    await mkdir(staticDir);
    let daemon: TestPaseoDaemon | undefined;
    let releaseRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => (releaseRecovery = resolve));
    let enteredRecovery!: () => void;
    const recoveryEntered = new Promise<void>((resolve) => (enteredRecovery = resolve));
    cleanups.push(async () => {
      releaseRecovery();
      await daemon?.close();
      await rm(root, { recursive: true, force: true });
    });
    const options = {
      paseoHomeRoot: root,
      staticDir,
      cleanup: false,
      ...(remoteRecovery ? { auth: { password: hashDaemonPassword("reload-test-password") } } : {}),
    };
    const initialProvider = createTestAgentClient("codex");
    const create = initialProvider.createSession.bind(initialProvider);
    initialProvider.createSession = async (...args) => {
      const session = await create(...args);
      if (remoteRecovery && args[0].title === "Remote worker") {
        // The scratch provider loses its terminal event before the daemon stops.
        const subscribe = session.subscribe.bind(session);
        session.subscribe = (listener) =>
          subscribe((event) => {
            if (!["turn_completed", "turn_failed", "turn_canceled"].includes(event.type))
              listener(event);
          });
      }
      return session;
    };
    daemon = await createTestPaseoDaemon({
      ...options,
      agentClients: { codex: initialProvider },
    });
    const manager = daemon.daemon.agentManager;
    const config = { provider: "codex", cwd: root, modeId: "full-access" };
    const parent = await manager.createAgent({ ...config, title: "Parent" }, undefined, {});
    const child = await manager.createAgent({ ...config, title: "Idle child" }, undefined, {
      labels: { [PARENT_AGENT_ID_LABEL]: parent.id },
    });
    let remoteReceipt: HostLinkReceipt | undefined;
    if (remoteRecovery) {
      const token = `hlink1.${"A".repeat(43)}`;
      const hostConfig: HostLinkConfig = {
        version: 1,
        machine: "mac",
        chats: [],
        outgoing: [],
        routes: {},
        incoming: [
          {
            id: "test-link",
            serverId: "test-source",
            token,
            leads: [parent.id],
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
            revoked: false,
            expiresAt: 2000000000000,
          },
        ],
      };
      writePrivateFileAtomicSync(
        path.join(daemon.paseoHome, "host-links.json"),
        JSON.stringify(hostConfig),
      );
      remoteReceipt = await hostLinksFor(manager)!.receive(token, {
        kind: "spawn",
        messageId: randomUUID(),
        destination: daemon.daemon.getServerId(),
        sender: parent.id,
        sourceProvider: "codex",
        sourceMode: "full-access",
        workload: "standard",
        workspace: "job",
        profile: "worker",
        title: "Remote worker",
        prompt: "old remote task",
        notifyOnFinish: true,
      });
      await vi.waitFor(() =>
        expect(hostLinksFor(manager)!.pendingNoticeWorkers()).toEqual([
          { agentId: remoteReceipt!.agentId, started: true },
        ]),
      );
    }
    const slow = await manager.createAgent({ ...config, title: "Slow recovery" }, undefined, {});
    await manager.flush();
    const sessionId = child.persistence!.sessionId;
    await daemon.close();
    daemon = undefined;
    // The scratch stop record models one cut-off turn beside the saved idle child.
    await recordOpenSessions({
      paseoHome: path.join(root, ".paseo"),
      agents: [
        { id: parent.id, lifecycle: "idle" },
        { id: child.id, lifecycle: "idle" },
        { id: slow.id, lifecycle: blockRecovery ? "running" : "idle" },
        ...(remoteReceipt ? [{ id: remoteReceipt.agentId!, lifecycle: "running" }] : []),
      ],
    });
    const prompts: string[] = [];
    let noticeAtStart: unknown;
    const provider = createTestAgentClient("codex", {
      onStartTurn: (prompt) => {
        const text = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
        prompts.push(text);
        if (text === "new child task")
          noticeAtStart = daemon!.daemon.agentStorage
            .listCached()
            .find((record) => record.id === child.id)?.finishNotice;
      },
    });
    const resume = provider.resumeSession.bind(provider);
    provider.resumeSession = async (handle, ...args) => {
      if (blockRecovery && handle.sessionId === slow.persistence!.sessionId) {
        enteredRecovery();
        await recovery;
      }
      return resume(handle, ...args);
    };
    daemon = await createTestPaseoDaemon({ ...options, agentClients: { codex: provider } });
    const restored = daemon.daemon;
    await vi.waitFor(async () => {
      expect((await restored.agentStorage.get(child.id))?.lastStatus).toBe("idle");
    });
    if (blockRecovery) await recoveryEntered;
    expect(restored.agentManager.getAgent(child.id)).toBeNull();
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve("../cli/src/index.ts"),
        "send",
        child.id,
        "--no-wait",
        "--prompt",
        "new child task",
        "--host",
        `127.0.0.1:${daemon.port}`,
        "--json",
      ],
      {
        timeout: 15000,
        env: {
          ...process.env,
          PASEO_HOME: daemon.paseoHome,
          PASEO_AGENT_ID: parent.id,
          PASEO_WORKSPACE_ID: "",
          PASEO_PASSWORD: remoteRecovery ? "reload-test-password" : "",
        },
      },
    );
    expect(JSON.parse(result.stdout).status).toBe("sent");
    await vi.waitFor(() => expect(prompts).toContain("new child task"), { timeout: 3000 });
    expect(noticeAtStart).toMatchObject({ parentId: parent.id, status: "armed" });
    expect(restored.agentManager.getAgent(child.id)?.persistence?.sessionId).toBe(sessionId);
    await vi.waitFor(() =>
      expect(
        prompts.filter((p) => p.includes("<paseo-system>") && p.includes(child.id)),
      ).toHaveLength(1),
    );
    expect(prompts.filter((p) => p === "new child task")).toHaveLength(1);
    await vi.waitFor(async () =>
      expect((await restored.agentStorage.getFinishNotice(child.id))?.status).toBe("delivered"),
    );
    if (remoteReceipt) {
      const readNotices = async () =>
        HostLinkWorkerNoticesSchema.parse(
          await hostLinksFor(restored.agentManager)!.worker(remoteReceipt!.token, {
            kind: "notices",
            agentId: remoteReceipt!.agentId,
          }),
        );
      // Queue startup must not prematurely settle the interrupted worker's saved notice.
      expect(await readNotices()).toMatchObject({ complete: false, notices: [] });
      // An explicit prompt can resume the remote worker during unrelated recovery.
      await restored.agentManager.trustedPlugins.agentInput(() =>
        sendPromptToAgent({
          agentManager: restored.agentManager,
          agentStorage: restored.agentStorage,
          agentId: remoteReceipt!.agentId!,
          prompt: "resumed remote task",
          unarchive: false,
          logger: createTestLogger(),
        }),
      );
      await vi.waitFor(async () =>
        expect(await readNotices()).toMatchObject({
          complete: true,
          notices: [{ kind: "finished" }],
        }),
      );
      expect((await readNotices()).notices).toHaveLength(1);
    }
  },
  30000,
);
