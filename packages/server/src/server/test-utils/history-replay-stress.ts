/** Manual, isolated daemon stress check. This command retains all generated history. */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import v8 from "node:v8";
import os from "node:os";
import { readMacMemory } from "./mac-memory.js";
import { statfs, realpath } from "node:fs/promises";
import { strict as assert } from "node:assert";
import pino from "pino";
import { claudeProjectDirSync } from "../agent/providers/claude/project-dir.js";
import { journalHistoryCache } from "../agent/history-load.js";
import { ClaudeAgentClient } from "../agent/providers/claude/agent.js";
import { createTestPaseoDaemon } from "./paseo-daemon.js";
import { DaemonClient } from "./daemon-client.js";

const root = process.env.HISTORY_STRESS_ROOT;
assert(root && path.isAbsolute(root), "Set HISTORY_STRESS_ROOT to a new scratch directory");
const fixtureFile = path.join(root, "fixture.json");
const mode = process.argv[2];
const cwd = path.join(root, "repo");
const configDir = path.join(root, "claude");
const paseoHomeRoot = path.join(root, "daemon");
const paseoHome = path.join(paseoHomeRoot, ".paseo");
const sizes = [490_449_603, 490_449_603, 490_449_603];
const timestamp = "2026-10-17T00:00:00.000Z";

async function sizedJsonl(file: string, size: number, make: (index: number) => unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const handle = await open(file, "wx", 0o600);
  let bytes = 0;
  let index = 0;
  try {
    while (bytes < size) {
      const line = JSON.stringify(make(index++)) + "\n";
      await handle.writeFile(line);
      bytes += Buffer.byteLength(line);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { bytes, records: index };
}

async function checkResources(): Promise<void> {
  await mkdir(root!, { recursive: true });
  if (process.platform !== "darwin") throw new Error("Run this manual check on the designated Mac");
  const userVolumeRoot = path.join(path.parse(os.homedir()).root, "Users") + path.sep;
  if (!(await realpath(root!)).startsWith(userVolumeRoot))
    throw new Error("Use the internal user volume for scratch history");
  const memory = readMacMemory();
  if (memory.availableBytes < 6 * 1024 ** 3)
    throw new Error("History stress needs at least 6 GiB available memory");
  const disk = await statfs(root!);
  if (disk.bavail * disk.bsize < 8 * 1024 ** 3)
    throw new Error("History stress needs at least 8 GiB free disk space");
  process.stdout.write(JSON.stringify({ phase: "admission", ...memory }) + "\n");
}

await checkResources();

function stressParentContent(index: number, payload: string): unknown[] {
  if (index === 0)
    return Array.from({ length: 11 }, (_, child) => ({
      type: "tool_use",
      id: `task-child-${child}`,
      name: "Task",
      input: { subagent_type: "general-purpose", description: `Check child ${child}` },
    }));
  if (index % 2 === 0)
    return [
      { type: "tool_use", id: `call-${index}`, name: "Bash", input: { command: "synthetic" } },
    ];
  return [{ type: "tool_result", tool_use_id: `call-${index - 1}`, content: payload }];
}

if (mode === "generate") {
  await mkdir(cwd, { recursive: true });
  await mkdir(path.join(root, "user", "shared-vault", "projects"), { recursive: true });
  const project = claudeProjectDirSync(cwd, { configDir });
  const agents = [];
  for (const [sessionIndex, size] of sizes.entries()) {
    const id = randomUUID();
    const sessionId = `stress-${sessionIndex}`;
    const parent = path.join(project, `${sessionId}.jsonl`);
    const payload = "synthetic history output ".repeat(750);
    const measured = await sizedJsonl(parent, size, (index) => ({
      type: index % 2 === 0 ? "assistant" : "user",
      sessionId,
      cwd,
      uuid: `${sessionId}-${index}`,
      timestamp,
      message: {
        role: index % 2 === 0 ? "assistant" : "user",
        content: stressParentContent(index, payload),
      },
    }));

    let sidechainRecords = 0;
    for (let child = 0; child < 11; child++) {
      const generatedChild = await sizedJsonl(
        path.join(project, sessionId, "subagents", `agent-child-${child}.jsonl`),
        1_008_174,
        (index) => ({
          type: "assistant",
          isSidechain: true,
          sessionId,
          cwd,
          agentId: `child-${child}`,
          timestamp,
          message: {
            role: "assistant",
            content: [{ type: "text", text: `child ${index} ` + "x".repeat(8192) }],
            stop_reason: "end_turn",
          },
        }),
      );
      sidechainRecords += generatedChild.records;
    }
    for (let child = 0; child < 11; child++) {
      await writeFile(
        path.join(project, sessionId, "subagents", `agent-child-${child}.meta.json`),
        JSON.stringify({ toolUseId: `task-child-${child}`, agentType: "general-purpose" }),
        { flag: "wx" },
      );
    }
    const directory = path.join(paseoHome, "native-timeline-journal");
    await mkdir(directory, { recursive: true });
    const journal = path.join(directory, createHash("sha256").update(id).digest("hex") + ".jsonl");
    const file = await open(journal, "wx", 0o600);
    let journalBytes = 0;
    const header = JSON.stringify({ version: 1, agentId: id, epoch: randomUUID() }) + "\n";
    await file.writeFile(header);
    journalBytes += Buffer.byteLength(header);
    for (let seq = 1; journalBytes < 75_337_092; seq++) {
      const item =
        seq % 2 === 1
          ? { type: "user_message", text: `prompt ${seq}` }
          : {
              type: "assistant_message",
              text: `reply ${seq} ` + "y".repeat(2300),
              messageId: `reply-${seq}`,
            };
      const line = JSON.stringify({ op: "append", rows: [{ seq, timestamp, item }] }) + "\n";
      await file.writeFile(line);
      journalBytes += Buffer.byteLength(line);
    }
    await file.sync();
    await file.close();
    const recordDir = path.join(paseoHome, "agents", "scratch");
    await mkdir(recordDir, { recursive: true });
    await writeFile(
      path.join(recordDir, `${id}.json`),
      JSON.stringify({
        id,
        provider: "claude",
        cwd,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastStatus: "closed",
        labels: {},
        persistence: { provider: "claude", sessionId, metadata: { cwd } },
      }),
      { flag: "wx" },
    );
    agents.push({ id, sessionId, parent, journal, ...measured, journalBytes, sidechainRecords });
  }
  await writeFile(fixtureFile, JSON.stringify({ formatVersion: 2, agents }, null, 2), {
    flag: "wx",
  });
  process.stdout.write(JSON.stringify({ phase: "generated", agents }) + "\n");
} else if (mode === "run") {
  assert.equal(process.env.CLAUDE_CONFIG_DIR, configDir);
  assert.equal(process.env.HOME, path.join(root, "user"));
  assert.equal(process.env.PASEO_HOME, paseoHome);
  const fixture = JSON.parse(await readFile(fixtureFile, "utf8")) as {
    formatVersion: number;
    agents: {
      records: number;
      sidechainRecords: number;
      id: string;
      sessionId: string;
      parent: string;
      journal: string;
      bytes: number;
      journalBytes: number;
    }[];
  };
  assert.equal(fixture.formatVersion, 2);
  for (const agent of fixture.agents) {
    assert.equal((await stat(agent.parent)).size, agent.bytes);
    assert.equal((await stat(agent.journal)).size, agent.journalBytes);
  }
  let peakHeap = process.memoryUsage().heapUsed;
  const sample = () => {
    const memory = process.memoryUsage();
    peakHeap = Math.max(peakHeap, memory.heapUsed);
    process.stdout.write(JSON.stringify({ phase: "sample", ...memory, peakHeap }) + "\n");
  };
  const timer = setInterval(sample, 100);
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  assert.equal(heapLimit, 4_395_630_592, "Use the measured production heap limit");
  process.stdout.write(JSON.stringify({ phase: "start", heapLimit, pid: process.pid }) + "\n");
  const logger = pino(
    { level: "info" },
    {
      write: (line: string) => {
        if (/history|replay|cache/i.test(line)) process.stdout.write(line);
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
      },
    },
  );
  let daemon: Awaited<ReturnType<typeof createTestPaseoDaemon>> | undefined;
  let client: DaemonClient | undefined;
  try {
    daemon = await createTestPaseoDaemon({
      paseoHomeRoot,
      cleanup: false,
      pluginsEnabled: false,
      logger,
      agentClients: {
        claude: new ClaudeAgentClient({
          logger,
          queryFactory: () => {
            throw new Error("History replay must not start a provider query");
          },
          modelProbe: async () => [],
          resolveVersion: async () => "2.1.220",
        }),
      },
    });
    client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const connected = client;
    const manager = daemon.daemon.agentManager;
    await Promise.all(
      fixture.agents.map(async ({ id, sessionId, records, sidechainRecords }) => {
        await connected.resumeAgent({ provider: "claude", sessionId, metadata: { cwd } }, { cwd });
        const agent = manager.getAgent(id);
        assert(agent && "session" in agent && agent.session);
        let parentItems = 0,
          childItems = 0;
        for await (const event of agent.session.streamHistory()) {
          if (event.type === "timeline") parentItems++;
          if (event.type === "provider_subagent" && event.event.type === "timeline") childItems++;
        }
        assert.equal(
          parentItems,
          records + 10,
          "Replay every parent item, including eleven initial Task cards",
        );
        assert.equal(childItems, sidechainRecords, "Replay every linked sidechain item");
        const page = await connected.fetchAgentTimeline(id, {
          direction: "tail",
          limit: 20,
          projection: "canonical",
          timeout: 600_000,
        });
        assert(page.entries.length > 0 && page.entries.length <= 20);
        assert(page.hasOlder); // A tail page must retain access to older history.
        sample();
        process.stdout.write(
          JSON.stringify({
            phase: "resumed",
            id,
            count: page.entries.length,
            parentItems,
            childItems,
          }) + "\n",
        );
      }),
    );
    sample();
    process.stdout.write(JSON.stringify({ phase: "complete", peakHeap, heapLimit }) + "\n");
  } finally {
    clearInterval(timer);
    await client?.close();
    await daemon?.close();
    assert.equal(
      daemon?.daemon.agentManager.getMetricsSnapshot().total ?? 0,
      0,
      "Close every scratch runtime",
    );
    assert(
      journalHistoryCache.bytes <= 128 * 1024 * 1024,
      "Bound unused journal metadata after closing",
    );
    sample();
    process.stdout.write(
      JSON.stringify({
        phase: "closed",
        journalCacheBytes: journalHistoryCache.bytes,
        peakHeap,
        heapLimit,
      }) + "\n",
    );
  }
} else {
  throw new Error("Use generate or run");
}
