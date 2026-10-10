import { describe, expect, it } from "vitest";
import type { Agent } from "@/stores/session-store";
import { reportingLeadLine, selectSidebarSessionRows } from "./sidebar-session-model";

const agent = (id: string, title: string, labels: Record<string, string> = {}) =>
  ({
    id,
    title,
    labels,
    status: "idle",
    pendingPermissions: [],
    provider: "claude",
  }) as unknown as Agent;
const sessions = {
  mini: {
    agents: new Map([
      ["lead-1", agent("lead-1", "Fulcra lead")],
      ["worker-1", agent("worker-1", "CI worker", { "fulcra.reports-to": "lead-1" })],
    ]),
  },
  book: { agents: new Map([["main-1", agent("main-1", "Main")]]) },
};

describe("reportingLeadLine", () => {
  it("names the lead in plain words for each kind of line", () => {
    expect(reportingLeadLine({ "fulcra.reports-to": "owner" }, "mini", sessions)).toBe(
      "Reports to you",
    );
    expect(
      reportingLeadLine({ "fulcra.reports-to": "role:main-assistant" }, "mini", sessions),
    ).toBe("Reports to Main assistant");
    expect(reportingLeadLine({ "fulcra.reports-to": "lead-1" }, "mini", sessions)).toBe(
      "Reports to Fulcra lead",
    );
    expect(reportingLeadLine({ "fulcra.reports-to": "main-1@book" }, "mini", sessions)).toBe(
      "Reports to Main",
    );
  });

  it("says a lead is not loaded instead of showing an ID, and shows nothing without a line", () => {
    expect(reportingLeadLine({ "fulcra.reports-to": "gone-9" }, "mini", sessions)).toBe(
      "Reports to a chat that is not loaded",
    );
    expect(reportingLeadLine({}, "mini", sessions)).toBeNull();
    expect(reportingLeadLine({ "fulcra.reports-to": "  " }, "mini", sessions)).toBeNull();
  });

  it("flags a chat with no line and no parent that has chats under it, except the main assistant", () => {
    const all = {
      mini: {
        agents: new Map([
          ["ship-lead", agent("ship-lead", "Ship It lead", { project: "ship-it", role: "lead" })],
          ["ship-worker", agent("ship-worker", "Worker", { "paseo.parent-agent-id": "ship-lead" })],
          ["main-1", agent("main-1", "Main", { "fulcra.seat": "main-assistant" })],
          ["main-kid", agent("main-kid", "Kid", { "fulcra.reports-to": "main-1" })],
          ["alone", agent("alone", "Alone")],
        ]),
      },
      book: {
        agents: new Map([
          ["book-kid", agent("book-kid", "Book kid", { "fulcra.reports-to": "alone@mini" })],
        ]),
      },
    };
    const note = (id: string) =>
      reportingLeadLine(all.mini.agents.get(id)!.labels, "mini", all, id);
    expect(note("ship-lead")).toBe("No reporting line recorded");
    // A child on another computer counts too.
    expect(note("alone")).toBe("No reporting line recorded");
    // The main assistant holds the role and reports to the owner.
    expect(note("main-1")).toBeNull();
    // A chat with a parent shows its lead, and a chat with no children shows nothing.
    expect(note("ship-worker")).toBe("Reports to Ship It lead");
    expect(note("main-kid")).toBe("Reports to Main");
    expect(reportingLeadLine({}, "mini", all, "nobody")).toBeNull();
  });

  it("falls back to the parent label, as the daemon does", () => {
    expect(reportingLeadLine({ "fulcra.parent-session": "lead-1" }, "mini", sessions)).toBe(
      "Reports to Fulcra lead",
    );
    expect(reportingLeadLine({ "paseo.parent-agent-id": "lead-1" }, "mini", sessions)).toBe(
      "Reports to Fulcra lead",
    );
    expect(
      reportingLeadLine(
        { "fulcra.reports-to": "owner", "paseo.parent-agent-id": "lead-1" },
        "mini",
        sessions,
      ),
    ).toBe("Reports to you");
  });
});

describe("selectSidebarSessionRows", () => {
  it("carries each chat's lead line", () => {
    const rows = selectSidebarSessionRows(sessions, ["mini"]);
    expect(rows.find((row) => row.agentId === "worker-1")?.lead).toBe("Reports to Fulcra lead");
    // lead-1 has no line and no parent, and worker-1 reports to it: flagged.
    expect(rows.find((row) => row.agentId === "lead-1")?.lead).toBe("No reporting line recorded");
  });
});
