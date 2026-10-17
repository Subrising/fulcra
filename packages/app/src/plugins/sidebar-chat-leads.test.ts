import { describe, expect, it } from "vitest";
import type { Seat } from "../../../../control/orca-organization/shared/roles";
import { liveProjectSeats, chatStatusLabel } from "./sidebar-chat-leads";

const seat = {
  role: "project-orchestrator",
  seat: "project",
  projectId: "project",
  state: "assigned",
  sessionId: "lead",
  sessionPresent: true,
  sessionTaskMatches: true,
  sessionGenerationChanged: false,
} as Seat;
const projects = {
  available: true,
  projects: [{ id: "project", name: "Example", status: "in_progress" }],
};
const agents = new Map([["lead", { status: "idle", archivedAt: null }]]);

describe("liveProjectSeats", () => {
  it.each(["idle", "running", "error", "initializing"])(
    "keeps a current seated lead with status %s",
    (status) => {
      expect(liveProjectSeats([seat], projects, new Map([["lead", { status }]]))).toEqual([seat]);
    },
  );
  it.each([
    { role: "prime" },
    { state: "vacant" },
    { projectId: null },
    { sessionId: null },
    { sessionPresent: false },
    { sessionTaskMatches: false },
    { sessionGenerationChanged: true },
  ])("rejects a stale or non-lead seat: %j", (patch) => {
    expect(liveProjectSeats([{ ...seat, ...patch } as Seat], projects, agents)).toEqual([]);
  });
  it.each([
    undefined,
    { available: false, projects: projects.projects },
    { available: true, projects: [] },
    { available: true, projects: [{ ...projects.projects[0]!, status: "archived" }] },
    { available: true, projects: [{ ...projects.projects[0]!, archivedAt: "2026-01-01" }] },
  ])("requires a known non-archived project: %j", (read) => {
    expect(liveProjectSeats([seat], read, agents)).toEqual([]);
  });
  it.each([
    undefined,
    new Map(),
    new Map([["lead", { status: "closed" }]]),
    new Map([["lead", { status: "idle", archivedAt: "2026-01-01" }]]),
    new Map([["lead", { status: "unavailable" }]]),
  ])("requires a live native session: %j", (read) => {
    expect(liveProjectSeats([seat], projects, read)).toEqual([]);
  });
  it("does not promote a reloaded label-only session or its saved orchestrator title", () => {
    const reloaded = {
      status: "idle",
      labels: { "fulcra.reports-to": "role:main-assistant", role: "lead" },
      title: "Saved project orchestrator",
      updatedAt: new Date().toISOString(),
    };
    expect(liveProjectSeats([], projects, new Map([["old", reloaded]]))).toEqual([]);
  });
});

it("uses shared status words", () => {
  expect(chatStatusLabel("running")).toBe("Working");
  expect(chatStatusLabel("idle")).toBe("Idle");
  expect(chatStatusLabel(undefined)).toBeNull();
});
