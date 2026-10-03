import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HANDOFF_MS,
  LimitResumeService,
  MAX_CHAIN,
  RESUME_PROMPT,
  STAGGER_MS,
  limitResumeFilePath,
  type LimitResumeAgent,
  type LimitResumeEvent,
} from "./service.js";

const T0 = Date.parse("2026-10-03T10:00:00Z");
const failed = (agentId: string, error: string, turnId = "t1"): LimitResumeEvent => ({
  type: "agent_stream",
  agentId,
  event: { type: "turn_failed", error, turnId },
});
const completed = (agentId: string, turnId = "t1"): LimitResumeEvent => ({
  type: "agent_stream",
  agentId,
  event: { type: "turn_completed", turnId },
});
const started = (agentId: string): LimitResumeEvent => ({
  type: "agent_stream",
  agentId,
  event: { type: "turn_started" },
});

describe("LimitResumeService", () => {
  let home: string;
  let enabled: boolean;
  let agents: Map<string, LimitResumeAgent>;
  let lastMessage: Map<string, string | null>;
  let sent: Array<{ agentId: string; prompt: string; at: number }>;
  let markers: Map<string, string | null>;
  let onMarker: ((id: string, at: string | null) => Promise<void> | void) | null;
  let getAgentDelay: Promise<void> | null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    home = mkdtempSync(path.join(os.tmpdir(), "limit-resume-"));
    enabled = true;
    agents = new Map();
    lastMessage = new Map();
    sent = [];
    markers = new Map();
    onMarker = null;
    getAgentDelay = null;
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
  });

  const make = () =>
    new LimitResumeService({
      paseoHome: home,
      isEnabled: () => enabled,
      captureBinding: (id) => agents.get(id)?.binding ?? null,
      getAgent: async (id) => {
        if (getAgentDelay) await getAgentDelay;
        return agents.get(id) ?? null;
      },
      getLastAssistantMessage: async (id) => lastMessage.get(id) ?? null,
      setMarker: async (id, at) => {
        markers.set(id, at);
        await onMarker?.(id, at);
      },
      sendResume: async (agentId, prompt, stillWanted, consume) => {
        if (!stillWanted()) return;
        consume();
        sent.push({ agentId, prompt, at: Date.now() });
      },
      onError: (e) => {
        throw e;
      },
      random: () => 0,
    });
  const idle = (): LimitResumeAgent => ({
    labels: {},
    archived: false,
    busy: false,
    unscopedResumeAllowed: true,
    binding: `v1:${"a".repeat(64)}`,
  });
  const resetIn = (ms: number) => `usage limit reached|${Math.floor((Date.now() + ms) / 1000)}`;
  const queued = () =>
    (JSON.parse(readFileSync(limitResumeFilePath(home), "utf8")) as { entries: unknown[] }).entries;

  it("resumes a limit-stopped session after the reset plus the controller's window, and only once", async () => {
    agents.set("a", idle());
    const svc = make();
    svc.start();
    await svc.onAgentEvent(failed("a", resetIn(60 * 60_000)));
    const due = T0 + 3_600_000 + HANDOFF_MS;
    expect(markers.get("a")).toBe(new Date(due).toISOString());

    await vi.advanceTimersByTimeAsync(3_600_000 + HANDOFF_MS - 1_000);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([{ agentId: "a", prompt: RESUME_PROMPT, at: due }]);
    expect(markers.get("a")).toBeNull();

    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(sent).toHaveLength(1);
  });

  describe("detection", () => {
    it("queues the Claude CLI's failed-turn wording with its named zone", async () => {
      agents.set("a", idle());
      const svc = make();
      svc.start();
      await svc.onAgentEvent(
        failed("a", "You've hit your session limit · resets 12:50am (Australia/Brisbane)"),
      );
      // 12:50am Brisbane (UTC+10) is 14:50Z; the clock now is 10:00Z the same day.
      expect(svc.pendingResumeAt("a")).toBe(Date.parse("2026-10-03T14:50:00Z") + HANDOFF_MS);
    });

    it("queues a turn that completed on the CLI's limit line (weekly dated form too)", async () => {
      agents.set("a", idle());
      const svc = make();
      svc.start();
      lastMessage.set(
        "a",
        "You've hit your weekly limit · resets Oct 6 at 8am (Australia/Brisbane)",
      );
      await svc.onAgentEvent(completed("a"));
      expect(svc.pendingResumeAt("a")).toBe(Date.parse("2026-10-05T22:00:00Z") + HANDOFF_MS);
    });

    it("reads Codex's stated reset instead of falling back to a 15 minute retry", async () => {
      agents.set("a", idle());
      const svc = make();
      svc.start();
      const stated = new Date(T0 + 5 * 3_600_000);
      const text = `Usage limit reached. Try again at ${stated.toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })}.`;
      await svc.onAgentEvent(failed("a", text));
      const at = svc.pendingResumeAt("a") ?? 0;
      // Within the minute resolution of the printed time, nowhere near 15 minutes.
      expect(Math.abs(at - (T0 + 5 * 3_600_000 + HANDOFF_MS))).toBeLessThan(60_000);
    });

    it("ignores prose that merely mentions a limit, and failures that are not limits", async () => {
      agents.set("a", idle());
      const svc = make();
      svc.start();
      lastMessage.set("a", "Done. Note the API usage limit reached|1760000000 string in the docs.");
      await svc.onAgentEvent(completed("a"));
      lastMessage.set("a", "I wrote the rate limiter.\nYou've hit your session limit · resets 3pm");
      await svc.onAgentEvent(completed("a", "t2"));
      await svc.onAgentEvent(failed("a", "Tool crashed", "t3"));
      expect(svc.pendingResumeAt("a")).toBeNull();
    });
  });

  describe("races", () => {
    it("keeps one entry and sends one resume when the same stop is delivered twice at once", async () => {
      agents.set("a", idle());
      const svc = make();
      svc.start();
      const event = failed("a", resetIn(60_000), "same-turn");
      await Promise.all([svc.onAgentEvent(event), svc.onAgentEvent(event)]);
      expect(queued()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(sent).toHaveLength(1);
    });

    it("drops a stop whose admission was overtaken by a newer turn", async () => {
      agents.set("a", idle());
      const svc = make();
      svc.start();
      let release: () => void = () => {};
      getAgentDelay = new Promise((resolve) => (release = resolve));
      const admission = svc.onAgentEvent(failed("a", resetIn(60_000)));
      await vi.advanceTimersByTimeAsync(0);
      // The epoch moves synchronously; the cancel itself queues behind the admission, which is still waiting.
      const newerTurn = svc.onAgentEvent(started("a"));
      release();
      await Promise.all([admission, newerTurn]);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(svc.pendingResumeAt("a")).toBeNull();
      expect(sent).toEqual([]);
    });

    it("does not send when the toggle is turned off while agent lookup awaits", async () => {
      agents.set("a", idle());
      const svc = make();
      svc.start();
      await svc.onAgentEvent(failed("a", resetIn(60_000)));
      let release = () => {};
      getAgentDelay = new Promise<void>((resolve) => (release = resolve));
      vi.advanceTimersByTime(60_000 + HANDOFF_MS);
      await Promise.resolve();
      enabled = false;
      release();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent).toEqual([]);
    });

    it("does not send when a user turn started and finished after the stop", async () => {
      agents.set("a", idle());
      const svc = make();
      svc.start();
      await svc.onAgentEvent(failed("a", resetIn(60_000)));
      await svc.onAgentEvent(started("a"));
      await svc.onAgentEvent(completed("a", "t-user"));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(sent).toEqual([]);
    });
  });

  describe("controller handoff", () => {
    it("steps aside when the controller resumed the session inside its own window", async () => {
      agents.set("a", idle());
      const svc = make();
      svc.start();
      await svc.onAgentEvent(failed("a", resetIn(60 * 60_000)));
      // The controller resumes at reset + 30..120 s; that starts a turn on the session.
      await vi.advanceTimersByTimeAsync(3_600_000 + 60_000);
      await svc.onAgentEvent(started("a"));
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(sent).toEqual([]);
      expect(markers.get("a")).toBeNull();
    });

    it("never acts before the controller's window has closed", async () => {
      agents.set("a", idle());
      const svc = make();
      svc.start();
      await svc.onAgentEvent(failed("a", resetIn(60 * 60_000)));
      await vi.advanceTimersByTimeAsync(3_600_000 + 120_000);
      expect(sent).toEqual([]);
    });
  });

  it("does not queue or resume when the toggle is off", async () => {
    agents.set("a", idle());
    enabled = false;
    const svc = make();
    svc.start();
    await svc.onAgentEvent(failed("a", resetIn(60_000)));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent).toEqual([]);

    enabled = true;
    await svc.onAgentEvent(failed("a", resetIn(60_000), "t2"));
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
    await svc.onAgentEvent(failed("opt", resetIn(60_000)));
    await svc.onAgentEvent(failed("busy", resetIn(60_000)));
    agents.set("busy", { ...idle(), busy: true });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sent).toEqual([]);
  });

  it("falls back to 15, 30, 60 minute backoff and gives up after MAX_CHAIN limit events", async () => {
    agents.set("a", idle());
    const svc = make();
    svc.start();
    const waits: number[] = [];
    for (let i = 0; i < MAX_CHAIN + 1; i += 1) {
      const before = Date.now();
      await svc.onAgentEvent(failed("a", "usage limit reached", `t${i}`));
      const at = svc.pendingResumeAt("a");
      if (at === null) break;
      waits.push((at - before - HANDOFF_MS) / 60_000);
      await vi.advanceTimersByTimeAsync(at - before + 1);
    }
    expect(waits).toEqual([15, 30, 60, 60]);
    expect(sent).toHaveLength(MAX_CHAIN);
  });

  it("survives a restart: a new service picks the queue up from disk", async () => {
    agents.set("a", idle());
    const first = make();
    first.start();
    await first.onAgentEvent(failed("a", resetIn(60 * 60_000)));
    first.stop();

    const second = make();
    second.start();
    expect(second.pendingResumeAt("a")).toBe(T0 + 3_600_000 + HANDOFF_MS);
    await vi.advanceTimersByTimeAsync(3_600_000 + HANDOFF_MS + 1_000);
    expect(sent.map((s) => s.agentId)).toEqual(["a"]);
  });

  it("does not send an in-flight resume after shutdown", async () => {
    agents.set("a", idle());
    const svc = make();
    svc.start();
    await svc.onAgentEvent(failed("a", resetIn(60_000)));
    let release = () => {};
    getAgentDelay = new Promise<void>((resolve) => (release = resolve));
    // Begin the timer callback without waiting for its deliberately blocked agent lookup.
    vi.advanceTimersByTime(60_000 + HANDOFF_MS);
    await Promise.resolve();
    await Promise.resolve();
    svc.stop();
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);
    expect(queued()).toHaveLength(1);
    getAgentDelay = null;
    const restarted = make();
    restarted.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toHaveLength(1);
    restarted.stop();
  });

  it("does not admit a stop after shutdown, including a pending lookup", async () => {
    agents.set("a", idle());
    const svc = make();
    svc.start();
    let release = () => {};
    getAgentDelay = new Promise<void>((resolve) => (release = resolve));
    const pending = svc.onAgentEvent(failed("a", resetIn(60_000)));
    await Promise.resolve();
    svc.stop();
    release();
    await pending;
    await svc.onAgentEvent(failed("a", resetIn(60_000), "later"));
    expect(svc.pendingResumeAt("a")).toBeNull();
    expect(markers.size).toBe(0);
  });

  it("ineligible stops do not promise a future auto-resume", async () => {
    agents.set("a", { ...idle(), unscopedResumeAllowed: false });
    const svc = make();
    svc.start();
    await svc.onAgentEvent(failed("a", resetIn(60_000)));
    expect(svc.pendingResumeAt("a")).toBeNull();
    expect(markers.get("a")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(60_000 + HANDOFF_MS + 1_000);
    expect(sent).toEqual([]);
    svc.stop();
  });

  it("legacy false/unknown binding never gains fallback or leaves a future promise on restart", async () => {
    agents.set("a", idle());
    const first = make();
    first.start();
    await first.onAgentEvent(failed("a", resetIn(60_000)));
    first.stop();
    const file = limitResumeFilePath(home);
    const data = JSON.parse(readFileSync(file, "utf8"));
    data.entries[0].unscoped = false;
    delete data.entries[0].binding;
    writeFileSync(file, JSON.stringify(data));
    const second = make();
    second.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(second.pendingResumeAt("a")).toBeNull();
    expect(markers.get("a")).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000 + HANDOFF_MS + 1_000);
    expect(sent).toEqual([]);
    second.stop();
  });

  it("captures original binding before async admission, never upgrades to a later model observation", async () => {
    agents.set("a", idle());
    const svc = make();
    svc.start();
    let release = () => {};
    getAgentDelay = new Promise<void>((yes) => (release = yes));
    const admission = svc.onAgentEvent(failed("a", resetIn(60_000)));
    agents.set("a", { ...idle(), binding: `v1:${"b".repeat(64)}` });
    release();
    await admission;
    expect(svc.pendingResumeAt("a")).toBeNull();
    expect(markers.get("a")).toBeUndefined();
    svc.stop();
  });

  it("staggers many sessions that reset at the same moment", async () => {
    const ids = Array.from({ length: 5 }, (_, i) => `s${i}`);
    const svc = make();
    svc.start();
    for (const id of ids) {
      agents.set(id, idle());
      await svc.onAgentEvent(failed(id, resetIn(60_000)));
    }
    await vi.advanceTimersByTimeAsync(60_000 + HANDOFF_MS + 1);
    await vi.advanceTimersByTimeAsync(10 * STAGGER_MS);
    expect(sent).toHaveLength(5);
    for (let i = 1; i < sent.length; i += 1) {
      expect(sent[i].at - sent[i - 1].at).toBeGreaterThanOrEqual(STAGGER_MS);
    }
  });
});
