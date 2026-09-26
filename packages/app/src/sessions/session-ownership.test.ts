import { describe, expect, it } from "vitest";
import {
  selectSessionLeaderLabel,
  selectSessionOwnership,
  selectSessionProjectLabel,
  type SessionOwnershipLabels,
  type SessionOwnershipRecord,
} from "./session-ownership";

const labels: SessionOwnershipLabels = {
  unknownProject: "Project unknown",
  noLeaderYet: "No leader yet",
  reportsTo: (leader) => `Reports to ${leader}`,
  unknownAccessibility: "Owning project unknown",
};

function record(
  overrides: Partial<SessionOwnershipRecord> = {},
): SessionOwnershipRecord {
  return {
    state: "recorded",
    projectId: "0c2a1d64-6b1e-4f5a-9d2f-1f7a4a2b3c4d",
    projectName: "Portable delivery",
    taskId: "6f1c9f2e-6d3a-4a1b-9c8e-2f5d7b1a3c9e",
    taskTitle: "Ship the portable route",
    leaderAgentId: "agent-leader-1",
    leaderTitle: "Portable coordinator",
    detail: null,
    ...overrides,
  };
}

describe("selectSessionOwnership", () => {
  it("carries all four ownership service states instead of collapsing them", () => {
    // `recorded` is the normal healthy path: written through a seat at creation.
    const recorded = selectSessionOwnership(record());
    expect(recorded).toMatchObject({ kind: "owned", state: "recorded" });
    expect(selectSessionOwnership(record({ state: "adopted" }))).toMatchObject({
      kind: "owned",
      state: "adopted",
    });
    // Owned by a project, led by nobody: a bootstrap state, not a degraded one.
    expect(
      selectSessionOwnership(record({ state: "declared", leaderAgentId: null })),
    ).toMatchObject({ kind: "owned", state: "declared" });
    expect(selectSessionOwnership(record({ state: "unknown" })).kind).toBe("unknown");
    expect(selectSessionOwnership(null).kind).toBe("unassigned");
  });

  it("reads an unrecognised state as unknown rather than falling through", () => {
    // The failure this guards: an unhandled state reaching the `declared` branch would
    // print a confident "No leader yet" about a session nobody has established anything
    // about — worse than showing nothing, because it looks like an answer.
    const future = selectSessionOwnership({
      ...record(),
      state: "supervised" as SessionOwnershipRecord["state"],
    });
    expect(future.kind).toBe("unknown");
    expect(selectSessionLeaderLabel(future, labels)).toBeNull();
    expect(selectSessionOwnership({ ...record(), state: "" as SessionOwnershipRecord["state"] }).kind).toBe(
      "unknown",
    );
  });

  it("reports the state that is true when a record contradicts itself", () => {
    // Claims adoption but names no leader.
    expect(selectSessionOwnership(record({ state: "adopted", leaderAgentId: null }))).toMatchObject(
      { kind: "owned", state: "declared" },
    );
    // Claims ownership without a project.
    expect(selectSessionOwnership(record({ projectId: "  " })).kind).toBe("unknown");
  });
});

describe("selectSessionProjectLabel", () => {
  const placement = { projectName: "derived-from-workspace" };

  it("prefers recorded ownership over the derived placement", () => {
    expect(
      selectSessionProjectLabel({ ownership: selectSessionOwnership(record()), placement, labels }),
    ).toMatchObject({ text: "Portable delivery", source: "controller", isUnknown: false });
  });

  it("shows the ownership service's own sentence rather than wording we invented", () => {
    const detail = "The owning task was closed on 19 September.";
    expect(
      selectSessionProjectLabel({
        ownership: selectSessionOwnership(record({ state: "unknown", detail })),
        placement,
        labels,
      }),
    ).toEqual({
      text: detail,
      source: "controller",
      isUnknown: true,
      accessibilityLabel: detail,
    });
  });

  it("falls back to our wording only when the ownership service supplied none", () => {
    expect(
      selectSessionProjectLabel({
        ownership: selectSessionOwnership(record({ state: "unknown", detail: null })),
        placement,
        labels,
      }),
    ).toMatchObject({ text: "Project unknown", accessibilityLabel: "Owning project unknown" });
  });

  it("keeps unknown and unassigned apart — unknown never shows the derived placement", () => {
    const unknown = selectSessionProjectLabel({
      ownership: selectSessionOwnership(record({ state: "unknown" })),
      placement,
      labels,
    });
    const unassigned = selectSessionProjectLabel({
      ownership: selectSessionOwnership(null),
      placement,
      labels,
    });
    expect(unknown.text).not.toBe(placement.projectName);
    expect(unknown.isUnknown).toBe(true);
    expect(unassigned).toMatchObject({
      text: "derived-from-workspace",
      source: "derived",
      isUnknown: false,
    });
  });
});

describe("selectSessionLeaderLabel", () => {
  it("names the leader, says there is none yet, or says nothing at all", () => {
    expect(selectSessionLeaderLabel(selectSessionOwnership(record()), labels)).toBe(
      "Reports to Portable coordinator",
    );
    expect(
      selectSessionLeaderLabel(
        selectSessionOwnership(record({ state: "declared", leaderAgentId: null })),
        labels,
      ),
    ).toBe("No leader yet");
    // A recorded session that has not been given a leader says so, rather than silently
    // showing nothing where a leader belongs.
    expect(
      selectSessionLeaderLabel(
        selectSessionOwnership(record({ state: "recorded", leaderAgentId: null })),
        labels,
      ),
    ).toBe("No leader yet");
    expect(selectSessionLeaderLabel(selectSessionOwnership(null), labels)).toBeNull();
    expect(
      selectSessionLeaderLabel(selectSessionOwnership(record({ state: "unknown" })), labels),
    ).toBeNull();
  });

  it("falls back to the leader id when the plugin resolved no name", () => {
    expect(
      selectSessionLeaderLabel(selectSessionOwnership(record({ leaderTitle: null })), labels),
    ).toBe("Reports to agent-leader-1");
  });
});
