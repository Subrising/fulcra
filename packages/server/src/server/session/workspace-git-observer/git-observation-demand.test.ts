import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import {
  GitObservationDemand,
  OPEN_CHECKOUT_CWD_LIMIT,
  type GitObservationAgent,
} from "./git-observation-demand.js";

const LIVE_CWD = path.resolve("/tmp/live");
const IDLE_CWD = path.resolve("/tmp/idle");

function liveAgent(overrides?: Partial<GitObservationAgent>): GitObservationAgent {
  return {
    id: "a1",
    cwd: LIVE_CWD,
    workspaceId: "ws-live",
    archivedAt: null,
    lifecycle: "idle",
    ...overrides,
  };
}

describe("GitObservationDemand (FU-590)", () => {
  test("isDemanded keeps workspaces with a live agent, by id or by directory", () => {
    const demand = new GitObservationDemand(() => [
      liveAgent(),
      liveAgent({ id: "a2", workspaceId: null, cwd: IDLE_CWD, lifecycle: "closed" }),
    ]);

    expect(demand.isDemanded({ id: "ws-live", workspaceDirectory: "/elsewhere" })).toBe(true);
    expect(demand.isDemanded({ id: "ws-other", workspaceDirectory: LIVE_CWD })).toBe(true);
    // A closed agent is not live work.
    expect(demand.isDemanded({ id: "ws-idle", workspaceDirectory: IDLE_CWD })).toBe(false);
  });

  test("isDemanded keeps a workspace with other live work, such as a running script", () => {
    const demand = new GitObservationDemand(
      () => [],
      (workspaceId) => workspaceId === "ws-script",
    );

    expect(demand.isDemanded({ id: "ws-script", workspaceDirectory: IDLE_CWD })).toBe(true);
    expect(demand.isDemanded({ id: "ws-idle", workspaceDirectory: IDLE_CWD })).toBe(false);
  });

  test("filter drops idle workspaces", () => {
    const demand = new GitObservationDemand(() => [liveAgent()]);

    expect(
      demand
        .filter([
          { id: "ws-live", workspaceDirectory: LIVE_CWD },
          { id: "ws-idle", workspaceDirectory: IDLE_CWD },
        ])
        .map((workspace) => workspace.id),
    ).toEqual(["ws-live"]);
  });

  test("noteOpenedCwd reports a new open checkout once and keeps only the most recent ones", () => {
    const demand = new GitObservationDemand(() => []);

    expect(demand.noteOpenedCwd(IDLE_CWD)).toBe(true);
    expect(demand.noteOpenedCwd(IDLE_CWD)).toBe(false);
    expect(demand.isDemanded({ id: "ws-idle", workspaceDirectory: IDLE_CWD })).toBe(true);

    for (let index = 0; index < OPEN_CHECKOUT_CWD_LIMIT; index += 1) {
      demand.noteOpenedCwd(path.resolve(`/tmp/open-${index}`));
    }
    expect(demand.isDemanded({ id: "ws-idle", workspaceDirectory: IDLE_CWD })).toBe(false);
    expect(demand.isDemanded({ id: "ws-last", workspaceDirectory: "/tmp/open-0" })).toBe(true);
  });

  test("noteAgentState reports when a workspace gains or loses its live agent", () => {
    const listAgents = vi.fn(() => [liveAgent()]);
    const demand = new GitObservationDemand(listAgents);

    // The first event seeds from listAgents, so it always reports a change.
    expect(demand.noteAgentState(liveAgent())).toBe(true);
    expect(demand.noteAgentState(liveAgent({ lifecycle: "running" }))).toBe(false);
    expect(demand.noteAgentState(liveAgent({ archivedAt: "2026-10-30T00:00:00.000Z" }))).toBe(true);
    expect(demand.isDemanded({ id: "ws-live", workspaceDirectory: LIVE_CWD })).toBe(false);
    expect(demand.noteAgentState(liveAgent({ id: "a3", workspaceId: "ws-new" }))).toBe(true);
    expect(listAgents).toHaveBeenCalledTimes(1);
  });
});
