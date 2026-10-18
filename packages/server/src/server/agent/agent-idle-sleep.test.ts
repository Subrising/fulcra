import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { IdleSleep } from "./agent-idle-sleep.js";
import { AgentStorage } from "./agent-storage.js";
import { startAgentRun } from "./agent-prompt.js";
import type {
  AgentClient,
  AgentPersistenceHandle,
  AgentProvider,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent-sdk-types.js";

const logger = createTestLogger();
const CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;
const MINUTE = 60_000;

describe("IdleSleep timers", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function make(minutes: number, results: Array<"slept" | "busy" | "gone"> = ["slept"]) {
    const calls: Array<{ id: string; idle: number }> = [];
    let setting = minutes;
    const sleep = new IdleSleep({
      logger,
      minutes: () => setting,
      trySleep: async (id, idle) => {
        calls.push({ id, idle });
        return results[Math.min(calls.length - 1, results.length - 1)];
      },
    });
    return { sleep, calls, set: (value: number) => (setting = value) };
  }

  test("an idle session sleeps after N minutes, not before", async () => {
    const { sleep, calls } = make(20);
    sleep.observe("a", true);
    await vi.advanceTimersByTimeAsync(20 * MINUTE - 1);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual([{ id: "a", idle: 20 }]);
    sleep.dispose();
  });

  test("a repeated idle state keeps the first idle time", async () => {
    const { sleep, calls } = make(20);
    sleep.observe("a", true);
    await vi.advanceTimersByTimeAsync(15 * MINUTE);
    sleep.observe("a", true);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(calls).toHaveLength(1);
    sleep.dispose();
  });

  test("a busy answer retries after another full interval", async () => {
    const { sleep, calls } = make(10, ["busy", "slept"]);
    sleep.observe("a", true);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(calls).toHaveLength(2);
    sleep.dispose();
  });

  test("leaving idle cancels the timer", async () => {
    const { sleep, calls } = make(10);
    sleep.observe("a", true);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    sleep.observe("a", false);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(calls).toEqual([]);
    sleep.dispose();
  });

  test("0 turns sleeping off, also when the setting changes while a timer runs", async () => {
    const off = make(0);
    off.sleep.observe("a", true);
    await vi.advanceTimersByTimeAsync(24 * 60 * MINUTE);
    expect(off.calls).toEqual([]);
    off.sleep.dispose();

    const later = make(10);
    later.sleep.observe("a", true);
    later.set(0);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(later.calls).toEqual([]);
    later.sleep.dispose();
  });
});

class SleepySession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = CAPABILITIES;
  readonly id = "provider-session-1";
  awake = true;
  mayNotSleep = false;
  /** A turn that never ends: it starts, and no turn_completed follows. */
  holdTurn = false;
  sleeps = 0;
  wakes = 0;
  closes = 0;
  deliveries: string[] = [];
  private subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turn = 0;

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }
  async startTurn(prompt: unknown): Promise<{ turnId: string }> {
    // The same wake a provider does in ensureQuery() / connect().
    if (!this.awake) {
      this.awake = true;
      this.wakes++;
    }
    this.deliveries.push(String(prompt));
    const turnId = `turn-${++this.turn}`;
    setTimeout(() => {
      this.push({ type: "turn_started", provider: this.provider, turnId });
      if (this.holdTurn) return;
      this.push({ type: "turn_completed", provider: this.provider, turnId });
    }, 0);
    return { turnId };
  }
  async sleep(): Promise<boolean> {
    if (!this.awake || this.mayNotSleep) return false;
    this.awake = false;
    this.sleeps++;
    return true;
  }
  isSleeping(): boolean {
    return !this.awake;
  }
  push(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) callback(event);
  }
  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }
  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}
  async getRuntimeInfo() {
    return { provider: this.provider, sessionId: this.id, model: null, modeId: null };
  }
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  async setMode(): Promise<void> {}
  getPendingPermissions() {
    return [];
  }
  async respondToPermission(): Promise<void> {}
  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.id };
  }
  async interrupt(): Promise<void> {}
  async close(): Promise<void> {
    this.closes++;
  }
}

async function fixture(options: {
  minutes: number;
  deliveryPending?: () => boolean;
  providers?: string[];
}) {
  // The idle timer starts at createAgent, so the fake clock must exist before it.
  vi.useFakeTimers();
  const workdir = mkdtempSync(join(tmpdir(), "agent-idle-sleep-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const session = new SleepySession();
  const client: AgentClient = {
    provider: "codex" as AgentProvider,
    capabilities: CAPABILITIES,
    isAvailable: async () => true,
    createSession: async (_config: AgentSessionConfig) => session,
    resumeSession: async () => session,
    fetchCatalog: async () => ({ models: [], modes: [] }),
  };
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });
  manager.configureIdleSleep({
    minutes: () => options.minutes,
    providers: options.providers ? () => options.providers! : undefined,
    deliveryPending: options.deliveryPending,
  });
  const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
    labels: { task: "idle-sleep-fixture" },
  });
  return {
    manager,
    storage,
    session,
    agent,
    async cleanup() {
      vi.useRealTimers();
      await manager.flush();
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

describe("AgentManager idle sleep", () => {
  afterEach(() => vi.useRealTimers());

  test("an idle session sleeps after N minutes and stays idle, not closed", async () => {
    const f = await fixture({ minutes: 20, providers: ["codex"] });
    try {
      await vi.advanceTimersByTimeAsync(19 * MINUTE);
      expect(f.session.sleeps).toBe(0);
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(f.session.sleeps).toBe(1);
      expect(f.manager.isAgentSleeping(f.agent.id)).toBe(true);
      // approve-before-close and every closed-state reader see an open, idle session.
      const live = f.manager.getAgent(f.agent.id);
      expect(live?.lifecycle).toBe("idle");
      expect(live?.session).toBe(f.session);
      expect(f.session.closes).toBe(0);
      await f.manager.flush();
      expect((await f.storage.get(f.agent.id))?.lastStatus).not.toBe("closed");
    } finally {
      await f.cleanup();
    }
  });

  test("a Codex session does not sleep by default", async () => {
    // No providers setting: the default list is ["claude"] (Codex background terminals die with the app-server).
    const f = await fixture({ minutes: 20 });
    try {
      await vi.advanceTimersByTimeAsync(10 * 60 * MINUTE);
      expect(f.session.sleeps).toBe(0);
      expect(f.manager.isAgentSleeping(f.agent.id)).toBe(false);
    } finally {
      await f.cleanup();
    }
  });

  test("setting 0 never sleeps", async () => {
    const f = await fixture({ minutes: 0, providers: ["codex"] });
    try {
      await vi.advanceTimersByTimeAsync(48 * 60 * MINUTE);
      expect(f.session.sleeps).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  test("a running turn does not sleep", async () => {
    const f = await fixture({ minutes: 20, providers: ["codex"] });
    try {
      f.session.holdTurn = true;
      await startAgentRun(f.manager, f.agent.id, "work", logger);
      await vi.advanceTimersByTimeAsync(1);
      await vi.advanceTimersByTimeAsync(120 * MINUTE);
      expect(f.session.sleeps).toBe(0);
      expect(f.manager.getAgent(f.agent.id)?.lifecycle).toBe("running");
    } finally {
      await f.cleanup();
    }
  });

  test("a pending permission does not sleep", async () => {
    const f = await fixture({ minutes: 20, providers: ["codex"] });
    try {
      f.session.push({
        type: "permission_requested",
        provider: "codex",
        request: { id: "p1", provider: "codex", kind: "tool", name: "read" },
      });
      await vi.advanceTimersByTimeAsync(120 * MINUTE);
      expect(f.session.sleeps).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  test("a held or queued message waiting for the session does not sleep it, and it sleeps once the message is gone", async () => {
    let pending = true;
    const f = await fixture({ minutes: 20, providers: ["codex"], deliveryPending: () => pending });
    try {
      await vi.advanceTimersByTimeAsync(60 * MINUTE);
      expect(f.session.sleeps).toBe(0);
      pending = false;
      await vi.advanceTimersByTimeAsync(20 * MINUTE);
      expect(f.session.sleeps).toBe(1);
    } finally {
      await f.cleanup();
    }
  });

  test("a provider that refuses (goal, background work) is retried and not forced", async () => {
    const f = await fixture({ minutes: 20, providers: ["codex"] });
    try {
      f.session.mayNotSleep = true;
      await vi.advanceTimersByTimeAsync(100 * MINUTE);
      expect(f.session.sleeps).toBe(0);
      f.session.mayNotSleep = false;
      await vi.advanceTimersByTimeAsync(20 * MINUTE);
      expect(f.session.sleeps).toBe(1);
    } finally {
      await f.cleanup();
    }
  });

  test("a message wakes the sleeping session and is delivered once", async () => {
    const f = await fixture({ minutes: 20, providers: ["codex"] });
    try {
      await vi.advanceTimersByTimeAsync(21 * MINUTE);
      expect(f.manager.isAgentSleeping(f.agent.id)).toBe(true);
      await startAgentRun(f.manager, f.agent.id, "wake up", logger);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.manager.getAgent(f.agent.id)?.lifecycle).toBe("idle");
      expect(f.session.wakes).toBe(1);
      expect(f.session.deliveries).toEqual(["wake up"]);
      expect(f.manager.isAgentSleeping(f.agent.id)).toBe(false);
      expect(f.session.closes).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  test("after a wake and a finished turn the session sleeps again", async () => {
    const f = await fixture({ minutes: 20, providers: ["codex"] });
    try {
      await vi.advanceTimersByTimeAsync(21 * MINUTE);
      await startAgentRun(f.manager, f.agent.id, "again", logger);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.session.deliveries).toEqual(["again"]);
      expect(f.manager.getAgent(f.agent.id)?.lifecycle).toBe("idle");
      await vi.advanceTimersByTimeAsync(21 * MINUTE);
      expect(f.session.sleeps).toBe(2);
    } finally {
      await f.cleanup();
    }
  });
});
