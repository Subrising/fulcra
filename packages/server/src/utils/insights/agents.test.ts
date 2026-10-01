import { describe, expect, it } from "vitest";
import { agentInsights, type AgentEvent, type AgentRecordFacts } from "./agents.js";
import { eventFor } from "./recorder.js";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const at = (days: number) => new Date(NOW - days * 86_400_000).toISOString();
const rec = (p: Partial<AgentRecordFacts> & { id: string }): AgentRecordFacts => ({
  cwd: "/work/shop",
  createdAt: at(1),
  ...p,
});
const projects = [{ projectId: "p1", name: "Shop", rootPath: "/work/shop" }];

describe("agent insights", () => {
  const records = [
    rec({ id: "a", createdAt: at(2), attentionReason: "finished", attentionTimestamp: at(1.9) }),
    rec({ id: "b", createdAt: at(2), archivedAt: at(1) }),
    rec({
      id: "c",
      cwd: "/elsewhere",
      createdAt: at(0.5),
      requiresAttention: true,
      attentionReason: "permission",
    }),
    rec({ id: "old", createdAt: at(40) }),
    rec({ id: "hidden", createdAt: at(1), internal: true }),
  ];
  const events: AgentEvent[] = [
    { type: "recording-started", at: at(5) },
    { type: "blocked", agentId: "a", at: at(1.95) },
    { type: "unblocked", agentId: "a", at: at(1.95 - 2 / 24) },
    { type: "blocked", agentId: "c", at: new Date(NOW - 3_600_000).toISOString() },
    { type: "limit", agentId: "b", at: at(1.5) },
  ];
  const result = agentInsights({
    records,
    events,
    projects,
    workspaceProject: new Map(),
    days: 30,
    now: NOW,
  });

  it("counts sessions started and finished in the window, leaving internal ones out", () => {
    expect(result.totals.started).toBe(3);
    // Only "a" finished a turn; "b" was archived without finishing, which is not a finish.
    expect(result.totals.finished).toBe(1);
    expect(result.perDay).toHaveLength(31);
  });

  it("adds up time waiting on the person, open waits running until now, and usage-limit stops", () => {
    expect(result.totals.blocked).toBe(2);
    expect(result.totals.blockedHours).toBe(3);
    expect(result.totals.limitStops).toBe(1);
    expect(result.totals.waitingNow).toBe(1);
    expect(result.recordingSince).toBe(at(5));
  });

  it("groups by registered project, with everything else as other folders", () => {
    expect(result.byProject).toEqual([
      { projectId: "p1", name: "Shop", started: 2, finished: 1, blockedHours: 2, limitStops: 1 },
      { projectId: "", name: "", started: 1, finished: 0, blockedHours: 1, limitStops: 0 },
    ]);
  });

  it("closes a wait when its session stops, and never counts a failed turn as finished", () => {
    const ended = agentInsights({
      records: [
        // Waiting on the person, then archived without an answer: the wait ends at the archive.
        rec({ id: "w", createdAt: at(3), archivedAt: at(2) }),
        // A failed turn is not a finish.
        rec({ id: "f", createdAt: at(3), attentionReason: "error", attentionTimestamp: at(2.5) }),
      ],
      events: [
        { type: "recording-started", at: at(5) },
        { type: "blocked", agentId: "w", at: at(2 + 1 / 24) },
        { type: "blocked", agentId: "f", at: at(2.5 + 2 / 24) },
      ],
      projects,
      workspaceProject: new Map(),
      days: 30,
      now: NOW,
    });
    // One hour for "w" (until its archive) and two for "f" (until its failed turn), not days until now.
    expect(ended.totals.blockedHours).toBe(3);
    expect(ended.totals.finished).toBe(0);
  });

  it("records only the events insights need", () => {
    expect(
      eventFor(
        { type: "agent_stream", agentId: "x", event: { type: "permission_requested" } },
        "t",
      ),
    ).toEqual({ type: "blocked", agentId: "x", at: "t" });
    expect(
      eventFor(
        {
          type: "agent_stream",
          agentId: "x",
          event: { type: "turn_failed", error: "You've hit your usage limit" },
        },
        "t",
      )?.type,
    ).toBe("limit");
    expect(
      eventFor(
        {
          type: "agent_stream",
          agentId: "x",
          event: { type: "turn_failed", error: "network down" },
        },
        "t",
      ),
    ).toBeNull();
    expect(eventFor({ type: "agent_state" }, "t")).toBeNull();
  });
});
