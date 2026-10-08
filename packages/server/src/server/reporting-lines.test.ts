import { describe, expect, it } from "vitest";
import {
  checkReportingLine,
  findRoleHolder,
  resolveLineRef,
  type LineAgent,
} from "./reporting-lines.js";

// Fulcra 0.2.8 reporting lines: worker -> lead -> main assistant -> David.

const MINI = "srv_mini";
const BOOK = "srv_book";
const agent = (id: string, title: string, labels: Record<string, string> = {}): LineAgent => ({
  id,
  title,
  labels,
});
const main = agent("main-1", "Main assistant", { "fulcra.reports-to": "owner" });
const lead = agent("lead-1", "Fulcra lead", { "fulcra.reports-to": "main-1" });
const otherLead = agent("lead-2", "FMC lead", { "fulcra.reports-to": "main-1" });
const worker = agent("work-1", "Review", { "fulcra.reports-to": "lead-1" });
const otherWorker = agent("work-2", "Talkboard", { "fulcra.reports-to": "lead-2" });
const byId = new Map([main, lead, otherLead, worker, otherWorker].map((a) => [a.id, a]));

function send(from: LineAgent, to: LineAgent) {
  const parent = from.labels?.["fulcra.reports-to"];
  return checkReportingLine({
    sender: { agentId: from.id },
    senderAgent: from,
    target: to,
    senderParent: parent ? (byId.get(parent) ?? null) : null,
    localServerId: MINI,
  });
}

describe("reporting lines", () => {
  it("allows a send up to the parent and down to the chat's own children", () => {
    expect(send(worker, lead)).toEqual({ allowed: true, why: "parent" });
    expect(send(lead, worker)).toEqual({ allowed: true, why: "child" });
    expect(send(lead, main)).toEqual({ allowed: true, why: "parent" });
    expect(send(main, lead)).toEqual({ allowed: true, why: "child" });
  });

  it("refuses a send outside the line and names the right recipient", () => {
    expect(send(worker, main)).toEqual({
      allowed: false,
      reason: "Send this to your lead, Fulcra lead (lead-1).",
    });
    expect(send(worker, otherWorker)).toEqual({
      allowed: false,
      reason: "Send this to your lead, Fulcra lead (lead-1).",
    });
    expect(send(lead, otherWorker).allowed).toBe(false);
    expect(send(main, worker)).toEqual({
      allowed: false,
      reason: "A main assistant sends to its own leads. Ask David to add a direct link.",
    });
  });

  it("allows the one direct link a lead set, in both directions", () => {
    const linked = agent("work-3", "Designer", {
      "fulcra.reports-to": "lead-1",
      "fulcra.direct-link": "work-2",
    });
    expect(send(linked, otherWorker)).toEqual({ allowed: true, why: "direct link" });
    expect(send(otherWorker, linked)).toEqual({ allowed: true, why: "direct link" });
  });

  it("does not refuse a chat with no recorded line, and follows a created chat's parent", () => {
    expect(send(agent("loose", "Scratch"), main)).toEqual({
      allowed: true,
      why: "no line recorded",
    });
    const sub = agent("sub-1", "Subagent", { "paseo.parent-agent-id": "lead-1" });
    expect(send(sub, lead)).toEqual({ allowed: true, why: "parent" });
    expect(send(sub, main).allowed).toBe(false);
  });

  it("keeps a lead on another computer able to reach the main assistant and its own chats here", () => {
    const remote = (to: LineAgent) =>
      checkReportingLine({
        sender: { agentId: "book-lead", serverId: BOOK },
        senderAgent: null,
        target: to,
        senderParent: null,
        localServerId: MINI,
      });
    expect(remote(main)).toEqual({ allowed: true, why: "main assistant" });
    expect(
      remote(agent("w", "Ship It helper", { "fulcra.reports-to": `book-lead@${BOOK}` })),
    ).toEqual({ allowed: true, why: "child" });
    expect(remote(worker)).toEqual({
      allowed: false,
      reason:
        "From another computer, a chat can send only to its own chats here and to the main assistant.",
    });
  });

  it("treats a stamp with this computer's own server id as a local chat", () => {
    expect(
      checkReportingLine({
        sender: { agentId: "work-1", serverId: MINI },
        senderAgent: worker,
        target: lead,
        senderParent: lead,
        localServerId: MINI,
      }),
    ).toEqual({ allowed: true, why: "parent" });
  });

  it("follows a lead's line to whichever chat holds the main assistant role now", () => {
    const roleLead = agent("lead-9", "Mac operations lead", {
      "fulcra.reports-to": "role:main-assistant",
    });
    const oldMain = {
      ...agent("main-old", "Old main assistant", { "fulcra.seat": "main-assistant" }),
      updatedAt: "2026-10-01",
    };
    const newMain = agent("main-new", "Main assistant", { "fulcra.reports-to": "owner" });
    const lineTo = (to: LineAgent, holders: LineAgent[]) => {
      const mainAssistantId = findRoleHolder(holders, "main-assistant")?.id ?? null;
      return checkReportingLine({
        sender: { agentId: roleLead.id },
        senderAgent: roleLead,
        target: to,
        senderParent: holders.find((h) => h.id === mainAssistantId) ?? null,
        localServerId: MINI,
        mainAssistantId,
      });
    };
    // Before the move: the old holder receives; the new chat is not yet the lead's parent.
    expect(lineTo(oldMain, [oldMain, newMain])).toEqual({ allowed: true, why: "parent" });
    expect(lineTo(newMain, [oldMain, newMain]).allowed).toBe(false);
    // Move the role: the old holder is archived and the new chat carries the role label. No lead changes.
    const moved = [
      { ...oldMain, archivedAt: "2026-10-09" },
      { ...newMain, labels: { ...newMain.labels, "fulcra.seat": "main-assistant" } },
    ];
    expect(
      resolveLineRef("role:main-assistant", findRoleHolder(moved, "main-assistant")?.id ?? null),
    ).toBe("main-new");
    expect(lineTo(moved[1]!, moved)).toEqual({ allowed: true, why: "parent" });
    expect(lineTo(oldMain, moved)).toEqual({
      allowed: false,
      reason: "Send this to the main assistant, Main assistant (main-new).",
    });
    // And the new holder reaches the lead as its child.
    expect(
      checkReportingLine({
        sender: { agentId: "main-new" },
        senderAgent: moved[1]!,
        target: roleLead,
        senderParent: null,
        localServerId: MINI,
        mainAssistantId: "main-new",
      }),
    ).toEqual({ allowed: true, why: "child" });
  });

  it("picks the most recently updated live holder and says so when no chat holds the role", () => {
    const a = { ...agent("a", "A", { "fulcra.seat": "main-assistant" }), updatedAt: "2026-10-01" };
    const b = { ...agent("b", "B", { "fulcra.seat": "main-assistant" }), updatedAt: "2026-10-08" };
    expect(findRoleHolder([a, b], "main-assistant")?.id).toBe("b");
    expect(findRoleHolder([{ ...b, archivedAt: "x" }, a], "main-assistant")?.id).toBe("a");
    const roleLead = agent("lead-9", "Lead", { "fulcra.reports-to": "role:main-assistant" });
    expect(
      checkReportingLine({
        sender: { agentId: roleLead.id },
        senderAgent: roleLead,
        target: worker,
        senderParent: null,
        localServerId: MINI,
        mainAssistantId: null,
      }),
    ).toEqual({
      allowed: false,
      reason: "No chat is the main assistant now. Ask David to set one.",
    });
  });

  it("lets a chat on another computer reach the current role holder", () => {
    const holder = agent("main-new", "Main assistant", { "fulcra.seat": "main-assistant" });
    expect(
      checkReportingLine({
        sender: { agentId: "book-lead", serverId: BOOK },
        senderAgent: null,
        target: holder,
        senderParent: null,
        localServerId: MINI,
        mainAssistantId: "main-new",
      }),
    ).toEqual({ allowed: true, why: "main assistant" });
  });

  it("follows the parent the controller recorded on a chat it created", () => {
    const made = agent("made-1", "Worker", { "fulcra.parent-session": "lead-1" });
    expect(send(made, lead)).toEqual({ allowed: true, why: "parent" });
    expect(send(made, main).allowed).toBe(false);
  });
});
