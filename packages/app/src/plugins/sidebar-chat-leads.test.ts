import { describe, expect, it } from "vitest";
import { chatLeads, chatStatusLabel } from "./sidebar-chat-leads";

const chat = (id: string, title: string, labels: Record<string, string>, extra = {}) => ({
  id,
  title,
  status: "idle",
  labels,
  ...extra,
});
const line = { "fulcra.reports-to": "role:main-assistant" };

describe("chatLeads", () => {
  it("finds a seatless chat that reports to the main assistant, on any computer, by title", () => {
    const sessions = {
      mini: { agents: new Map([["b", chat("b", "Zed lead", line)]]) },
      book: {
        agents: new Map([
          ["a", chat("a", "AI gag games lead", line)],
          ["w", chat("w", "Worker", { "fulcra.reports-to": "a" })],
        ]),
      },
    };
    expect(chatLeads(sessions, new Set()).map((l) => [l.serverId, l.agentId, l.title])).toEqual([
      ["book", "a", "AI gag games lead"],
      ["mini", "b", "Zed lead"],
    ]);
  });

  it("leaves out shown, archived, closed, main assistant and other-line chats", () => {
    const sessions = {
      mini: {
        agents: new Map([
          ["seated", chat("seated", "Seated", line)],
          ["old", chat("old", "Old", line, { archivedAt: "2026-10-01" })],
          ["shut", chat("shut", "Shut", line, { status: "closed" })],
          ["main", chat("main", "Main", { ...line, "fulcra.seat": "main-assistant" })],
          ["owner", chat("owner", "Owner", { "fulcra.reports-to": "owner" })],
          ["none", chat("none", "None", {})],
          ["ok", chat("ok", "", line)],
        ]),
      },
    };
    const found = chatLeads(sessions, new Set(["seated"]));
    expect(found.map((l) => l.agentId)).toEqual(["ok"]);
    expect(found[0]!.title).toBe("Lead");
  });
});

describe("chatStatusLabel", () => {
  it("uses the Team map words and nothing for an unknown status", () => {
    expect(chatStatusLabel("running")).toBe("Working");
    expect(chatStatusLabel("idle")).toBe("Idle");
    expect(chatStatusLabel("error")).toBe("Needs attention");
    expect(chatStatusLabel(undefined)).toBeNull();
    expect(chatStatusLabel("weird")).toBeNull();
  });
});
