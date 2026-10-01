import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, test } from "vitest";
import { buildStoredAgentPayload } from "./agent/agent-projections.js";
import type { PaseoDaemonConfig } from "./bootstrap.js";

// Orca R3a (DESIGN-R R-M17, R-M18). A daemon that stops mid-turn leaves the agent's record saying `running`, and
// agents initialize on demand, so nothing ever rewrote it. Boot now normalises such records -- and loads nothing.
const originalPath = process.env.PATH;

describe("bootstrap interrupted-turn normalisation", () => {
  const roots: string[] = [];
  afterEach(async () => {
    process.env.PATH = originalPath;
    await Promise.all(
      roots
        .splice(0)
        .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
    );
  });

  test("R-M17: boot marks a stored running turn idle and interrupted, and loads, resumes or prompts no agent", async () => {
    const { createPaseoDaemon } = await import("./bootstrap.js");
    const root = await mkdtemp(path.join(os.tmpdir(), "paseo-interrupted-boot-"));
    roots.push(root);
    const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).split(/\r?\n/)[0].trim();
    process.env.PATH = path.dirname(gitPath);
    const paseoHome = path.join(root, ".paseo"),
      staticDir = path.join(root, "static"),
      agentStoragePath = path.join(paseoHome, "agents");
    await mkdir(agentStoragePath, { recursive: true });
    await mkdir(staticDir, { recursive: true });
    const at = "2026-09-23T22:10:00.000Z",
      userAt = "2026-09-23T22:09:59.000Z";
    const record = (id: string, extra: Record<string, unknown>) => ({
      id,
      provider: "codex",
      cwd: root,
      createdAt: at,
      updatedAt: at,
      lastUserMessageAt: userAt,
      lastStatus: "running",
      lastModeId: "auto",
      config: { modeId: "auto", model: "gpt-5.4" },
      persistence: {
        provider: "codex",
        sessionId: `session-${id}`,
        metadata: { provider: "codex", cwd: root },
      },
      ...extra,
    });
    const ids = {
      running: "11111111-1111-4111-8111-000000000001",
      initializing: "11111111-1111-4111-8111-000000000002",
      archived: "11111111-1111-4111-8111-000000000003",
      internal: "11111111-1111-4111-8111-000000000004",
      idle: "11111111-1111-4111-8111-000000000005",
    };
    const seeds = {
      [ids.running]: record(ids.running, {}),
      [ids.initializing]: record(ids.initializing, { lastStatus: "initializing" }),
      [ids.archived]: record(ids.archived, { archivedAt: at }),
      [ids.internal]: record(ids.internal, { internal: true }),
      [ids.idle]: record(ids.idle, { lastStatus: "idle" }),
    };
    for (const [id, seed] of Object.entries(seeds))
      await writeFile(path.join(agentStoragePath, `${id}.json`), JSON.stringify(seed));

    const config: PaseoDaemonConfig = {
      listen: "127.0.0.1:0",
      paseoHome,
      corsAllowedOrigins: [],
      hostnames: true,
      mcpEnabled: false,
      staticDir,
      mcpDebug: false,
      // No provider client at all: a load or resume attempt could not even start a session, let alone a turn.
      agentClients: {},
      agentStoragePath,
      relayEnabled: false,
      appBaseUrl: "https://app.paseo.sh",
      openai: undefined,
      speech: undefined,
    };
    const daemon = await createPaseoDaemon(config, pino({ level: "silent" }));
    try {
      await daemon.agentStorage.flush();
      for (const id of Object.values(ids)) expect(daemon.agentManager.getAgent(id)).toBeNull();
      const stored = new Map((await daemon.agentStorage.list()).map((r) => [r.id, r]));
      for (const id of [ids.running, ids.initializing]) {
        const r = stored.get(id)!;
        expect(r.lastStatus).toBe("idle");
        expect(r.interruptedTurn).toMatchObject({
          previousStatus: seeds[id].lastStatus,
          lastUserMessageAt: userAt,
        });
        expect(typeof r.interruptedTurn?.bootId).toBe("string");
        // R-M18: byte-identical timestamps, on disk.
        // Storage may re-home a rewritten record under its per-cwd directory; read it wherever it now lives.
        const files = (await readdir(agentStoragePath, { recursive: true })).filter((f) =>
          String(f).endsWith(`${id}.json`),
        );
        expect(files).toHaveLength(1);
        const raw = JSON.parse(
          await readFile(path.join(agentStoragePath, String(files[0])), "utf8"),
        );
        expect(raw.updatedAt).toBe(at);
        expect(raw.lastUserMessageAt).toBe(userAt);
        // What every client reads for an agent no process has loaded.
        const payload = buildStoredAgentPayload(r, ["codex"]);
        expect(payload.status).toBe("idle");
        expect(payload.interruptedTurn?.previousStatus).toBe(seeds[id].lastStatus);
      }
      for (const id of [ids.archived, ids.internal, ids.idle]) {
        expect(stored.get(id)?.lastStatus).toBe(seeds[id].lastStatus);
        expect(stored.get(id)?.interruptedTurn).toBeUndefined();
      }
    } finally {
      await daemon.stop().catch(() => undefined);
      await daemon.agentManager.flush().catch(() => undefined);
    }
  });
});
