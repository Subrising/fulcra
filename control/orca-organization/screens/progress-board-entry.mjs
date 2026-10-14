import React from "react";
import { createRoot } from "react-dom/client";
import { View } from "react-native";
import { PaseoApiProvider, PluginRpcProvider } from "@getpaseo/plugin/client/host";
import { ProgressBoardSurface } from "../client/progress-board";

const params = new URLSearchParams(location.search);
const light = params.get("theme") === "light";
const colors = light
  ? {
      surface0: "#ffffff",
      surface1: "#fafafa",
      surface2: "#f4f4f5",
      border: "#e4e4e7",
      foreground: "#1a1a1e",
      foregroundMuted: "#71717a",
      accent: "#20744A",
      statusWarning: "#7b5d39",
    }
  : {
      surface0: "#181B1A",
      surface1: "#1E2120",
      surface2: "#272A29",
      border: "#252B2A",
      foreground: "#fafafa",
      foregroundMuted: "#A1A5A4",
      accent: "#20744A",
      statusWarning: "#c09664",
    };
const at = "2026-10-14T04:00:00Z";
const item = (id, kind, status, text) => ({
  id,
  kind,
  status,
  item: text,
  owner: "Board worker",
  evidence: "8 tests passed.",
  source: "Synthetic request 2026-10-12",
  createdAt: "2026-10-12T00:00:00Z",
});
const data = {
  observedAt: at,
  machine: "Fixture host",
  warnings: [],
  projects: [
    {
      id: "fixture",
      name: "Fixture project",
      ledgerState: "Current",
      items: [
        item("FU-1", "BUILD", "IN PROGRESS", "Show project progress on desktop and mobile."),
        item("FU-2", "DECIDE", "OPEN", "Select the release date."),
        item("FU-3", "FIX", "NEXT", "Check permission waits."),
        item("FU-4", "BUILD", "OPEN", "Check the screen on a phone."),
        item("FU-5", "FIX", "DONE", "Keep long branch names readable."),
        item("FU-6", "FIX", "BLOCKED: dependency", "Wait for the dependent branch checks."),
        {
          ...item("FU-7", "BUILD", "OPEN", "Confirm the project schedule."),
          owner: "Owner A",
          needsHuman: true,
        },
        ...Array.from({ length: 36 }, (_, n) =>
          item(
            `FU-${n + 8}`,
            ["BUILD", "FIX", "RULE", "DECIDE"][n % 4],
            ["OPEN", "IN PROGRESS", "NEXT", "BLOCKED", "DONE", "DONE"][n % 6],
            [
              "Keep report history available when the agent session is archived. Check recovery after a reconnect and preserve existing evidence.",
              "Show permission waits in the project board.",
              "Check the project filter with a long workspace name.",
              "Select which recent output to retain for the next release.",
            ][n % 4],
          ),
        ),
      ],
      jobs: [
        {
          id: "fixture-job",
          title: "Board worker with a long title that must wrap without clipping",
          status: "idle",
          machine: "Fixture host",
          createdAt: "2026-10-13T02:30:00Z",
          updatedAt: at,
          permissions: 1,
          result: "Added the board screen. Eight checks passed. The branch is ready for review.",
        },
        {
          id: "finished-job",
          title: "Finished worker",
          status: "done",
          machine: "Fixture host",
          createdAt: at,
          updatedAt: at,
          permissions: 0,
          result: "Done. All checks passed.",
        },
      ],
      branches: [
        {
          workspace: "Board workspace",
          branch: "fix/progress-board-with-a-long-branch-name",
          head: "0123456789abcdef0123456789abcdef01234567",
          state: "Open PR",
          ci: "Passed",
          observedAt: at,
        },
      ],
    },
    {
      id: "empty",
      name: "Empty project",
      ledgerState: "Ledger unavailable",
      items: [],
      jobs: [],
      branches: [],
    },
  ],
};
const events = [];
let reads = 0,
  releases = 0,
  offline = false;
const list = async () => ({
  subscription: {
    subscribe(callbacks) {
      events.push(callbacks);
    },
    release: async () => {
      releases++;
    },
  },
});
const paseo = { agents: { list }, workspaces: { list } };
const invoke = async () => {
  reads++;
  if (offline) throw Error("Offline fixture");
  return data;
};
window.boardTest = {
  reads: () => reads,
  releases: () => releases,
  update() {
    data.projects[0].jobs[0].status = "running";
    events.forEach((e) => e.update({ type: "agent_update" }));
  },
  offline(value) {
    offline = value;
  },
};
const props = {
  theme: { colors },
  host: { id: "fixture-host", label: "Fixture host" },
  layout: { compact: params.get("compact") === "1", platform: "web" },
  navigation: {
    openAgent() {
      window.boardTest.opened = true;
    },
  },
};
const root = createRoot(document.getElementById("root"));
window.boardTest.unmount = () => root.unmount();
root.render(
  React.createElement(
    PaseoApiProvider,
    { paseo },
    React.createElement(
      PluginRpcProvider,
      { invoke },
      React.createElement(
        View,
        { style: { height: "100vh" } },
        React.createElement(ProgressBoardSurface, props),
      ),
    ),
  ),
);
