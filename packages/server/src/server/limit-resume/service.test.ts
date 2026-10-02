import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LimitResumeService,
  MAX_CHAIN,
  RESUME_PROMPT,
  STAGGER_MS,
  type LimitResumeAgent,
  type LimitResumeEvent,
} from "./service.js";

const T0 = Date.parse("2026-10-03T10:00:00Z");
const limitEvent = (agentId: string, error: string): LimitResumeEvent => ({
  type: "agent_stream",
  agentId,
  event: { type: "turn_failed", error },
});

describe("LimitResumeService", () => {
  let home: string;
  let enabled: boolean;
  let agents: Map<string, LimitResumeAgent>;
  let sent: Array<{ agentId: string; prompt: string; at: number }>;
  let markers: Map<string, string | null>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    home = mkdtempSync(path.join(os.tmpdir(), "limit-resume-"));
    enabled = true;
    agents = new Map();
    sent = [];
    markers = new Map();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  });

  const make = () =>
    new LimitResumeService({
      paseoHome: home,
      isEnabled: () => enabled,
      getAgent: async (id) => agents.get(id) ?? null,
      setMarker: async (id, at) => void markers.set(id, at),
      sendResume: async (agentId, prompt) => void sent.push({ agentId, prompt, at: Date.now() }),
      onError: (e) => {
        throw e;
      },
      random: () => 0,
    });
  const idle = (): LimitResumeAgent => ({ labels: {}, archived: false, busy: false });
  const resetIn = (ms: number) => `usage limit reached|${Math.floor((Date.now() + ms) / 1000)}`;

  it("resumes a limit-stopped session at the reset time, and only once", async () => {
    agents.set("a", idle());
    const svc = make();
    svc.start();
    await svc.onAgentEvent(limitEvent("a", resetIn(60 * 60_000)));
    expect(markers.get("a")).toBe(new Date(T0 + 3_600_000).toISOString());

    await vi.advanceTimersByTimeAsync(3_599_000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([{ agentId: "a", prompt: RESUME_PROMPT, at: T0 + 3_600_000 }]);
    expect(markers.get("a")).toBeNull();

    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(sent).toHaveLength(1);
  });

  it("does not queue or resume when the toggle is off", async () => {
    agents.set("a", idle());
    enabled = false;
    const svc = make();
    svc.start();
    await svc.onAgentEvent(limitEvent("a", resetIn(60_000)));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent).toEqual([]);

    // Turned off after queueing: the entry is dropped at fire time.
    enabled = true;
    await svc.onAgentEvent(limitEvent("a", resetIn(60_000)));
    enabled = false;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent).toEqual([]);
    expect(svc.pendingResumeAt("a")).toBeNull();
  });

  it("honours the per-session opt-out, archived and busy sessions", async () => {
    agents.set("opt", { ...idle(), labels: { "fulcra.limit-resume": "off" } });
    agents.set("busy", idle());
    const svc = make();
    svc.start();
    await svc.onAgentEvent(limitEvent("opt", resetIn(60_000)));
    await svc.onAgentEvent(limitEvent("busy", resetIn(60_000)));
    agents.set("busy", { ...idle(), busy: true });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent).toEqual([]);
  });

  it("ignores failures that are not usage limits", async () => {
    agents.set("a", idle());
    const svc = make();
    svc.start();
    await svc.onAgentEvent(limitEvent("a", "Tool crashed"));
    expect(svc.pendingResumeAt("a")).toBeNull();
  });

  it("cancels when something else starts a turn", async () => {
    agents.set("a", idle());
    const svc = make();
    svc.start();
    await svc.onAgentEvent(limitEvent("a", resetIn(60_000)));
    await svc.onAgentEvent({ type: "agent_stream", agentId: "a", event: { type: "turn_started" } });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent).toEqual([]);
    expect(markers.get("a")).toBeNull();
  });

  it("falls back to 15, 30, 60 minute backoff and gives up after MAX_CHAIN limit events", async () => {
    agents.set("a", idle());
    const svc = make();
    svc.start();
    const waits: number[] = [];
    for (let i = 0; i < MAX_CHAIN + 1; i += 1) {
      const before = Date.now();
      await svc.onAgentEvent(limitEvent("a", "usage limit reached"));
      const at = svc.pendingResumeAt("a");
      if (at === null) break;
      waits.push((at - before) / 60_000);
      await vi.advanceTimersByTimeAsync(at - before + 1);
    }
    expect(waits).toEqual([15, 30, 60, 60]);
    expect(sent).toHaveLength(MAX_CHAIN);
  });

  it("survives a restart: a new service picks the queue up from disk", async () => {
    agents.set("a", idle());
    const first = make();
    first.start();
    await first.onAgentEvent(limitEvent("a", resetIn(60 * 60_000)));
    first.stop();

    const second = make();
    second.start();
    expect(second.pendingResumeAt("a")).toBe(T0 + 3_600_000);
    await vi.advanceTimersByTimeAsync(3_601_000);
    expect(sent.map((s) => s.agentId)).toEqual(["a"]);
  });

  it("staggers many sessions that reset at the same moment", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `s${i}`);
    const svc = make();
    svc.start();
    for (const id of ids) {
      agents.set(id, idle());
      await svc.onAgentEvent(limitEvent(id, resetIn(60_000)));
    }
    await vi.advanceTimersByTimeAsync(60_000 + 1);
    await vi.advanceTimersByTimeAsync(10 * STAGGER_MS);
    expect(sent).toHaveLength(5);
    for (let i = 1; i < sent.length; i += 1) {
      expect(sent[i].at - sent[i - 1].at).toBeGreaterThanOrEqual(STAGGER_MS);
    }
  });
});
