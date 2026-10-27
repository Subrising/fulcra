// FU-423 boot load test, daemon side. Not part of CI: control/tools/boot-load.mjs runs it.
// Seeds a scratch daemon home like a long-lived host (many archived session records, a few live ones, real-size
// timeline journals, live working folders that are git checkouts, plain folders or deleted folders), then starts
// the real daemon on it with fake providers (no model is ever called) and logs at info level to a file, so
// ws_runtime_metrics (request counts, event loop delay) and ws_slow_request lines can be counted afterwards.
//
//   npx tsx scripts/boot-load-daemon.ts --home <dir> --port <n> --log <file> [--seed] [--live 30] [--archived 720]
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import { createTestPaseoDaemon } from "../src/server/test-utils/paseo-daemon.js";

const args = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const homeRoot = path.resolve(arg("home") ?? "");
const port = Number(arg("port", "0"));
const logFile = path.resolve(arg("log") ?? path.join(homeRoot, "daemon.log"));
const live = Number(arg("live", "30"));
const archived = Number(arg("archived", "720"));
if (!arg("home")) throw Error("--home is required");

const words =
  "agent session journal replay timeline request controller watcher folder branch merge test".split(
    " ",
  );
const filler = (n: number, offset: number) =>
  Array.from({ length: n }, (_, i) => words[(offset + i * 7) % words.length]).join(" ");

// One turn is a user message, 12 reasoning + tool call pairs and an answer: 26 rows.
function item(seq: number): Record<string, unknown> {
  const step = (seq - 1) % 26;
  if (step === 0) return { type: "user_message", text: filler(40, seq), messageId: randomUUID() };
  if (step === 25) return { type: "assistant_message", text: filler(150, seq) };
  if (step % 2) return { type: "reasoning", text: filler(60, seq) };
  return {
    type: "tool_call",
    callId: `toolu_${randomUUID().replace(/-/g, "")}`,
    name: "Bash",
    detail: { type: "shell", command: filler(12, seq), output: filler(400, seq) },
    status: "completed",
    error: null,
  };
}

function journal(id: string, rows: number, start: number): string {
  const lines = [JSON.stringify({ version: 1, agentId: id, epoch: randomUUID() })];
  for (let seq = 1; seq <= rows; seq++)
    lines.push(
      JSON.stringify({
        op: "append",
        rows: [
          {
            seq,
            timestamp: new Date(start + seq * 4000).toISOString(),
            item: item(seq),
            turnId: `foreground-turn-${Math.ceil(seq / 26)}`,
          },
        ],
      }),
    );
  return lines.join("\n") + "\n";
}

function seed(paseoHome: string) {
  const agents = path.join(paseoHome, "agents"),
    journals = path.join(paseoHome, "native-timeline-journal"),
    work = path.join(homeRoot, "work");
  fs.mkdirSync(journals, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(
    path.join(paseoHome, "config.json"),
    JSON.stringify({ daemon: { reviveOnRestart: true, autoResumeOnLimit: false } }, null, 2),
  );
  const ids: { id: string; archived: boolean }[] = [];
  const now = Date.now();
  for (let i = 0; i < archived + live; i++) {
    const isArchived = i < archived,
      id = randomUUID();
    ids.push({ id, archived: isArchived });
    let cwd = path.join(work, `job-${i}`);
    if (!isArchived) {
      // Live folders: two thirds git checkouts, the rest plain folders, and a few deleted ones.
      const kind = (i - archived) % 6;
      if (kind === 5) cwd = path.join(work, `deleted-${i}`);
      else {
        fs.mkdirSync(cwd, { recursive: true });
        if (kind < 4) execFileSync("git", ["init", "-q", cwd]);
      }
    }
    const created = new Date(now - (archived + live - i) * 600000).toISOString(),
      updated = new Date(now - (archived + live - i) * 300000).toISOString();
    const record = {
      id,
      provider: i % 3 ? "claude" : "codex",
      cwd,
      createdAt: created,
      updatedAt: updated,
      lastActivityAt: updated,
      lastUserMessageAt: created,
      title: `Load fixture ${i}`,
      labels: isArchived ? {} : { owner: "orca-control" },
      lastStatus: isArchived ? "closed" : "idle",
      lastModeId: "auto",
      config: { modeId: "auto", model: "fake-model", thinkingOptionId: "medium" },
      features: [],
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      internal: false,
      archivedAt: isArchived ? updated : null,
    };
    const dir = path.join(
      agents,
      cwd
        .replace(/^([A-Za-z]):/, "$1")
        .replace(/[\\/:]+/g, "-")
        .replace(/^-+/, ""),
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(record, null, 2));
    const rows = isArchived ? 150 + ((i * 37) % 900) : 800 + ((i * 53) % 1600);
    fs.writeFileSync(
      path.join(journals, `${createHash("sha256").update(id).digest("hex")}.jsonl`),
      journal(id, rows, Date.parse(created)),
    );
  }
  fs.writeFileSync(path.join(homeRoot, "sessions.json"), JSON.stringify(ids));
}

const paseoHome = path.join(homeRoot, ".paseo");
if (args.includes("--seed")) {
  fs.mkdirSync(paseoHome, { recursive: true });
  seed(paseoHome);
  console.log(JSON.stringify({ seeded: archived + live, home: homeRoot }));
  process.exit(0);
}
const logger = pino({ level: "info" }, pino.destination({ dest: logFile, sync: false }));
const daemon = await createTestPaseoDaemon({
  paseoHomeRoot: homeRoot,
  listenPort: port,
  logger,
  cleanup: false,
});
console.log(JSON.stringify({ ready: true, port: daemon.port, pid: process.pid }));
const stop = async () => {
  await daemon.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("message", (m) => {
  if (m === "stop") void stop();
});
