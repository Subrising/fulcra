import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { createTestPaseoDaemon, type TestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient } from "../test-utils/fake-agent-client.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import type { AgentPromptInput } from "../agent/agent-sdk-types.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).toReversed()) await close();
});

function promptText(prompt: AgentPromptInput): string {
  return typeof prompt === "string" ? prompt : JSON.stringify(prompt);
}

async function fixture(count = 1) {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "send-before-load-")));
  const staticDir = path.join(root, "static");
  await mkdir(staticDir);
  let daemon: TestPaseoDaemon | undefined;
  let client: DaemonClient | undefined;
  cleanups.push(async () => {
    await client?.close();
    await daemon?.close();
    await rm(root, { recursive: true, force: true });
  });
  const options = { paseoHomeRoot: root, staticDir, cleanup: false };
  daemon = await createTestPaseoDaemon({
    ...options,
    agentClients: { claude: createTestAgentClient("claude") },
  });
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const agent = await daemon.daemon.agentManager.createAgent(
      { provider: "claude", cwd: root },
      undefined,
      {},
    );
    ids.push(agent.id);
  }
  await daemon.daemon.agentManager.flush();
  await daemon.daemon.agentStorage.flush?.();
  await daemon.close();
  const prompts: string[] = [];
  const start = async () => {
    daemon = await createTestPaseoDaemon({
      ...options,
      agentClients: {
        claude: createTestAgentClient("claude", {
          onStartTurn: (prompt) => prompts.push(promptText(prompt)),
        }),
      },
    });
    // A closed daemon marks its sessions closed. A cold, idle session is the case under test.
    for (const id of ids) {
      const record = await daemon.daemon.agentStorage.get(id);
      await daemon.daemon.agentStorage.upsert({ ...record!, lastStatus: "idle" });
    }
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    return { daemon, client };
  };
  return {
    ids,
    prompts,
    start,
    queueFile: () => daemon!.daemon.agentStorage.heldMessagesPath,
  };
}

/** Hold the history load of one session until the test opens the gate. */
function gateLoad(daemon: TestPaseoDaemon, agentId: string) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const manager = daemon.daemon.agentManager;
  const original = manager.hydrateTimelineFromProvider.bind(manager);
  vi.spyOn(manager, "hydrateTimelineFromProvider").mockImplementation(async (id, ...rest) => {
    if (id === agentId) await gate;
    return original(id, ...rest);
  });
  return open;
}

test("a send to a session that is loading is accepted at once and delivered once after the load", async () => {
  const f = await fixture();
  const { daemon, client } = await f.start();
  const [id] = f.ids;
  const open = gateLoad(daemon, id!);
  const began = Date.now();
  const notes: string[] = [];
  const onDelivery = (note: string) => notes.push(note);
  await client.sendAgentMessage(id!, "first", { messageId: "m-1", onDelivery });
  await client.sendAgentMessage(id!, "second", { messageId: "m-2", onDelivery });
  expect(Date.now() - began).toBeLessThan(1000);
  expect(notes).toEqual(["accepted, delivered after load", "accepted, delivered after load"]);
  expect(f.prompts).toHaveLength(0);
  open();
  await vi.waitFor(() => expect(f.prompts.join("\n")).toContain("second"), { timeout: 10_000 });
  const joined = f.prompts.join("\n");
  expect(joined.indexOf("first")).toBeGreaterThanOrEqual(0);
  expect(joined.indexOf("first")).toBeLessThan(joined.indexOf("second"));
  expect(joined.match(/first/g)).toHaveLength(1);
  expect(joined.match(/second/g)).toHaveLength(1);
});

test("a send to another session is not blocked by a long replay", async () => {
  const f = await fixture(2);
  const { daemon, client } = await f.start();
  const [slow, fast] = f.ids;
  const open = gateLoad(daemon, slow!);
  await client.sendAgentMessage(slow!, "for the slow one", { messageId: "slow-1" });
  const began = Date.now();
  await client.sendAgentMessage(fast!, "for the fast one", { messageId: "fast-1" });
  await vi.waitFor(() => expect(f.prompts.join("\n")).toContain("for the fast one"), {
    timeout: 5000,
  });
  expect(Date.now() - began).toBeLessThan(5000);
  expect(f.prompts.join("\n")).not.toContain("for the slow one");
  open();
  await vi.waitFor(() => expect(f.prompts.join("\n")).toContain("for the slow one"), {
    timeout: 10_000,
  });
});

test("a message accepted before a crash is saved and delivered once after restart", async () => {
  const f = await fixture();
  const first = await f.start();
  const [id] = f.ids;
  const open = gateLoad(first.daemon, id!);
  await first.client.sendAgentMessage(id!, "survives a crash", { messageId: "c-1" });
  const onDisk = await readFile(f.queueFile(), "utf8");
  expect(JSON.parse(onDisk).filter((r: { state: string }) => r.state === "queued")).toHaveLength(1);
  // A crash leaves the file as it was at accept. Close the first daemon, then put that file back.
  open();
  await first.client.close();
  await first.daemon.close();
  await writeFile(f.queueFile(), onDisk);
  f.prompts.length = 0;
  const second = await f.start();
  expect(second.daemon).toBeDefined();
  await vi.waitFor(() => expect(f.prompts.join("\n")).toContain("survives a crash"), {
    timeout: 10_000,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(f.prompts.join("\n").match(/survives a crash/g)).toHaveLength(1);
});
