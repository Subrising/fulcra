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
    // A lead (it holds a seat) with no line and no parent is flagged, not hidden.
    expect(reportingLeadLine({ "fulcra.seat": "project-lead" }, "mini", sessions)).toBe(
      "No reporting line recorded",
    );
    expect(
      reportingLeadLine(
        { "fulcra.seat": "project-lead", "paseo.parent-agent-id": "lead-1" },
        "mini",
        sessions,
      ),
    ).toBe("Reports to Fulcra lead");
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
    expect(rows.find((row) => row.agentId === "lead-1")?.lead).toBeNull();
  });
});
