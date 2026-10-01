import fs from "node:fs";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test, vi } from "vitest";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createTestAgentClient } from "../../test-utils/fake-agent-client.js";
import { AgentManager } from "../agent-manager.js";
import { toAgentPayload } from "../agent-projections.js";
import type { AgentClient, AgentSession, AgentStreamEvent } from "../agent-sdk-types.js";

// MULTIHOST-DESIGN §6.3: background work is display only. It may reach the agent snapshot, the
// workspace status bucket and the app; it must never change the agent's status, and nothing in
// admission, trusted plugins, management or policy may read it.

const SERVER_ROOT = path.resolve(__dirname, "../..");
const MENTION = /backgroundWork|background_work|BackgroundWork/;

/** Every non-test file in the server package allowed to mention background work, and why. */
const ALLOWED = new Map<string, string>([
  ["agent/agent-sdk-types.ts", "declares the stream event and getProcessId"],
  ["agent/agent-manager.ts", "stores it and re-publishes the snapshot"],
  ["agent/agent-projections.ts", "puts it on the snapshot"],
  ["agent/providers/claude/agent.ts", "produces it from Claude's task protocol"],
  ["agent/providers/claude/background-work.ts", "the Claude tracker"],
  ["agent/background-work/process-tree.ts", "the process sample"],
  ["agent/background-work/sampler.ts", "the process sampler"],
  ["workspace-directory.ts", "folds it into the workspace status bucket"],
  ["bootstrap.ts", "starts the sampler"],
  ["agent/providers/mock-load-test-agent.ts", "test-only provider: `paseo-e2e background <n>`"],
]);

function serverSources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : serverSources(full);
    return /\.(ts|mts|mjs|js)$/.test(entry.name) && !/\.test\.|\.e2e\.|test-utils/.test(full)
      ? [full]
      : [];
  });
}

describe("background work stays display only", () => {
  test("only the listed files mention it; admission, trusted plugins and policy do not", () => {
    const mentioning = serverSources(SERVER_ROOT)
      .filter((file) => MENTION.test(fs.readFileSync(file, "utf8")))
      .map((file) => path.relative(SERVER_ROOT, file).split(path.sep).join("/"))
      .sort();
    expect(mentioning).toEqual([...ALLOWED.keys()].sort());

    const mustNotRead = [
      ...fs
        .readdirSync(path.join(SERVER_ROOT, "plugins"))
        .filter((name) => name.startsWith("trusted") && !name.includes(".test."))
        .map((name) => `plugins/${name}`),
      "session.ts",
      "websocket-server.ts",
      "agent/agent-run-state.ts",
      "agent-attention-policy.ts",
      ...fs
        .readdirSync(path.join(SERVER_ROOT, "authorization"))
        .filter((name) => !name.includes(".test."))
        .map((name) => `authorization/${name}`),
    ];
    expect(mustNotRead.length).toBeGreaterThan(5);
    for (const file of mustNotRead) {
      const source = fs.readFileSync(path.join(SERVER_ROOT, file), "utf8");
      expect(MENTION.test(source), file).toBe(false);
    }
  });

  test("a session's background jobs reach the snapshot and never change the agent's status", async () => {
    const base = createTestAgentClient("codex");
    const emitters: Array<(event: AgentStreamEvent) => void> = [];
    const client = new Proxy(base, {
      get(target, property) {
        if (property === "createSession") {
          return async (...args: Parameters<AgentClient["createSession"]>) => {
            const session: AgentSession = await target.createSession(...args);
            const subscribe = session.subscribe.bind(session);
            session.subscribe = (callback) => {
              emitters.push(callback);
              return subscribe(callback);
            };
            return session;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const manager = new AgentManager({ clients: { codex: client }, logger: createTestLogger() });
    const cwd = mkdtempSync(path.join(tmpdir(), "background-work-fence-"));
    const created = await manager.createAgent({ provider: "codex", cwd }, undefined, {
      workspaceId: undefined,
    });
    expect(manager.getAgent(created.id)?.lifecycle).toBe("idle");
    expect(emitters.length).toBeGreaterThan(0);

    const emit = (count: number) => {
      for (const callback of emitters) {
        callback({
          type: "background_work_changed",
          provider: "codex",
          backgroundWork:
            count === 0
              ? null
              : {
                  count,
                  kinds: ["shell"],
                  source: "provider",
                  since: "2026-09-27T09:00:00.000Z",
                  observedAt: "2026-09-27T09:01:00.000Z",
                },
        });
      }
    };
    emit(2);
    await vi.waitFor(() =>
      expect(toAgentPayload(manager.getAgent(created.id)!).backgroundWork?.count).toBe(2),
    );
    let agent = manager.getAgent(created.id)!;
    let payload = toAgentPayload(agent);
    expect(payload.backgroundWork?.count).toBe(2);
    expect(agent.lifecycle).toBe("idle");
    expect(payload.status).toBe("idle");
    expect(payload.activeTurn).toBeNull();
    expect(payload.requiresAttention).toBe(false);

    emit(0);
    await vi.waitFor(() =>
      expect(toAgentPayload(manager.getAgent(created.id)!).backgroundWork).toBeUndefined(),
    );
    agent = manager.getAgent(created.id)!;
    payload = toAgentPayload(agent);
    expect(payload.backgroundWork).toBeUndefined();
    expect(payload.status).toBe("idle");
    await manager.closeAgent(created.id);
  });
});
