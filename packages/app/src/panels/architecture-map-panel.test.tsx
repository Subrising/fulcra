/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { parseArchitectureIr } from "@/architecture-map/ir-model";
import { pullRequestReadable, type PullRequestMaps } from "@/architecture-map/architecture-change";
import { BASE_COMMIT, HEAD_COMMIT } from "@/architecture-map/pull-request-maps.test.helpers";

const state = vi.hoisted(() => ({
  workspaceRoot: "/work/project" as string | null,
  list: null as unknown,
  document: null as unknown,
  documentArgs: [] as unknown[],
  openPreferredTarget: vi.fn(),
  tabState: undefined as unknown,
  setCurrentTabState: vi.fn(),
  openTab: vi.fn(),
  change: null as unknown,
}));

vi.mock("@/architecture-map/use-architecture-maps", () => ({
  useArchitectureMapList: () => state.list,
  useArchitectureMapDocument: (args: unknown) => {
    state.documentArgs.push(args);
    return state.document;
  },
}));
vi.mock("@/stores/session-store-hooks", () => ({
  useWorkspaceDirectory: () => state.workspaceRoot,
}));
vi.mock("@/panels/pane-context", () => ({
  usePaneContext: () => ({
    serverId: "srv",
    workspaceId: "ws",
    target: { kind: "architecture_map" },
    state: state.tabState,
    setCurrentTabState: state.setCurrentTabState,
    openTab: state.openTab,
    openPreferredTarget: state.openPreferredTarget,
  }),
}));
// The Change view's reads, answered from the fixture pair ; the comparison is real.
vi.mock("@/architecture-map/use-architecture-change", async () => {
  const { buildArchitectureChange } = await import("@/architecture-map/architecture-change");
  return {
    useArchitectureChange: (input: { maps: { name: string; path: string; size: number }[] }) => {
      const sources = state.change as {
        changedFiles: { path: string; isDeleted: boolean }[];
        mapDiff: (path: string) => never;
        pullRequest: { number: number; baseRefName: string } | null;
        pullRequestMaps?: PullRequestMaps | null;
      };
      const selected = { ...input.maps[0], exists: true };
      const headText = readFileSync(
        join(__dirname, "../architecture-map/fixtures/change-head.ir.json"),
        "utf8",
      );
      return {
        candidates: [selected],
        selected,
        change: buildArchitectureChange({
          mapPath: selected.path,
          headText,
          mapDiff: sources.mapDiff(selected.path),
          changedFiles: sources.changedFiles,
          siblings: new Map(),
          pullRequest: sources.pullRequest,
          pullRequestMaps: sources.pullRequestMaps ?? null,
        }),
        error: null,
        loading: false,
        diffCut: false,
        pullRequest: sources.pullRequest,
        reload: vi.fn(),
      };
    },
  };
});
vi.mock("@/architecture-map/architecture-change-view", () => ({
  ArchitectureChangeView: ({ change }: { change: { comparison: { touched: string[] } } }) =>
    React.createElement(
      "div",
      { "data-testid": "rendered-change" },
      change.comparison.touched.join(","),
    ),
}));
vi.mock("@/architecture-map/architecture-map-view", () => ({
  ArchitectureMapView: ({ model }: { model: { title: string } }) =>
    React.createElement("div", { "data-testid": "rendered-map" }, model.title),
}));

import {
  changeViewRequestKey,
  useChangeViewRequests,
} from "@/architecture-map/change-view-request";
import { gitDiff } from "@/architecture-map/git-patch.test.helpers";
import { architectureMapPanelRegistration } from "./architecture-map-panel";

const Panel = architectureMapPanelRegistration.component;
let root: Root | null = null;
let container: HTMLElement | null = null;

const idle = { data: undefined, isLoading: false, error: null, refetch: vi.fn() };
const entry = (name: string) => ({ name, path: `.fulcra/architecture/${name}`, size: 2267 });

function render(): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(<Panel />));
  return container;
}

function byTestId(id: string): HTMLElement | null {
  return container?.querySelector(`[data-testid="${id}"]`) ?? null;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("React", React);
  await i18n.changeLanguage("en");
  state.workspaceRoot = "/work/project";
  state.list = { ...idle };
  state.document = { ...idle };
  state.documentArgs = [];
  state.openPreferredTarget.mockReset();
  state.tabState = undefined;
  state.setCurrentTabState.mockReset();
  state.setCurrentTabState.mockImplementation((next: unknown) => {
    state.tabState = next;
  });
  state.openTab.mockReset();
  const fixture = (name: string) =>
    readFileSync(join(__dirname, "../architecture-map/fixtures", name), "utf8");
  const mapDiff = gitDiff(fixture("change-base.ir.json"), fixture("change-head.ir.json"));
  state.change = {
    isLoading: false,
    error: null,
    diffTooLarge: false,
    changedFiles: [{ path: ".fulcra/architecture/a.ir.json", isDeleted: false }],
    deletedMaps: [],
    mapDiff: (path: string) => (path === ".fulcra/architecture/a.ir.json" ? mapDiff : null),
    pullRequest: null,
  };
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

describe("ArchitectureMapPanel", () => {
  it("shows the Fulcra empty state naming the map directory when there is none", () => {
    state.list = { ...idle, data: { kind: "missing" } };
    render();
    const empty = byTestId("architecture-map-empty");
    expect(empty?.textContent).toContain("No architecture map in this project");
    expect(empty?.textContent).toContain("Fulcra shows maps stored in .fulcra/architecture.");
    expect(container?.textContent).not.toMatch(/archify/i);
  });

  it("names oversized maps it will not open", () => {
    state.list = {
      ...idle,
      data: { kind: "listed", maps: [], oversized: ["huge.ir.json"], truncated: false },
    };
    render();
    expect(byTestId("architecture-map-empty")?.textContent).toContain("huge.ir.json");
  });

  it("renders the first map and reads it by its listed path and size", () => {
    const result = parseArchitectureIr(
      readFileSync(join(__dirname, "../architecture-map/fixtures/head.ir.json")),
    );
    state.list = {
      ...idle,
      data: { kind: "listed", maps: [entry("a.ir.json")], oversized: [], truncated: false },
    };
    state.document = { ...idle, data: result };
    render();
    expect(byTestId("rendered-map")?.textContent).toBe("Radius definition: defproof-app");
    expect(state.documentArgs.at(-1)).toEqual({
      serverId: "srv",
      workspaceRoot: "/work/project",
      path: ".fulcra/architecture/a.ir.json",
      size: 2267,
    });
    expect(byTestId("architecture-map-picker-item")).toBeNull();
  });

  it("offers a picker when there are several maps", () => {
    state.list = {
      ...idle,
      data: {
        kind: "listed",
        maps: [entry("a.ir.json"), entry("b.ir.json")],
        oversized: [],
        truncated: false,
      },
    };
    state.document = { ...idle, isLoading: true };
    render();
    const items = Array.from(
      container?.querySelectorAll('[data-testid="architecture-map-picker-item"]') ?? [],
    );
    expect(items.map((item) => item.textContent)).toEqual(["a.ir.json", "b.ir.json"]);
  });

  it("shows every reason for an invalid map instead of drawing part of it, and opens the source", () => {
    state.list = {
      ...idle,
      data: { kind: "listed", maps: [entry("a.ir.json")], oversized: [], truncated: false },
    };
    state.document = {
      ...idle,
      data: {
        kind: "invalid",
        reasons: ["components.0.id: invalid id", 'connections.0.to: unknown component "x"'],
      },
    };
    render();
    const error = byTestId("architecture-map-error");
    expect(error?.textContent).toContain("This map can't be shown");
    expect(error?.textContent).toContain("components.0.id: invalid id");
    expect(error?.textContent).toContain('connections.0.to: unknown component "x"');
    expect(byTestId("rendered-map")).toBeNull();
    const open = Array.from(error?.querySelectorAll('[role="button"]') ?? []).find(
      (button) => button.textContent === "Open file",
    );
    act(() => {
      open?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(state.openPreferredTarget).toHaveBeenCalledWith(
      { kind: "file", path: ".fulcra/architecture/a.ir.json" },
      "explorerFiles",
    );
  });

  it("explains a map that is too large", () => {
    state.list = {
      ...idle,
      data: { kind: "listed", maps: [entry("a.ir.json")], oversized: [], truncated: false },
    };
    state.document = { ...idle, data: { kind: "too_large", bytes: 2_000_000 } };
    render();
    expect(byTestId("architecture-map-error")?.textContent).toContain("larger than 1 MiB");
    expect(byTestId("rendered-map")).toBeNull();
  });

  it("reports a read failure from the daemon", () => {
    state.list = {
      ...idle,
      data: { kind: "listed", maps: [entry("a.ir.json")], oversized: [], truncated: false },
    };
    state.document = { ...idle, error: new Error("File is too large to display") };
    render();
    expect(byTestId("architecture-map-error")?.textContent).toContain(
      "File is too large to display",
    );
  });

  it("needs a workspace directory", () => {
    state.workspaceRoot = null;
    render();
    expect(byTestId("rendered-map")).toBeNull();
    expect(byTestId("architecture-map-empty")).toBeNull();
  });

  it("switches to the Change view and shows what the branch changed in the chosen map", () => {
    state.list = {
      ...idle,
      data: { kind: "listed", maps: [entry("a.ir.json")], oversized: [], truncated: false },
    };
    state.document = { ...idle, isLoading: true };
    render();
    expect(byTestId("rendered-change")).toBeNull();
    act(() => (byTestId("architecture-map-view-change") as HTMLElement).click());
    expect(state.setCurrentTabState).toHaveBeenCalledWith({ view: "change" });
    act(() => root?.render(<Panel />));
    expect(byTestId("rendered-change")?.textContent).toBe("orders,reports,search");
  });

  // A pull request's comparison needs its own commits, which the host cannot read yet;
  // nothing is rebuilt from local files, and the one action opens the pull request.
  it("says a pull request's comparison is unavailable instead of rebuilding it, and opens the pull request", () => {
    (state.change as { pullRequest: unknown }).pullRequest = { number: 17, baseRefName: "main" };
    state.list = {
      ...idle,
      data: { kind: "listed", maps: [entry("a.ir.json")], oversized: [], truncated: false },
    };
    state.tabState = { view: "change" };
    render();
    expect(byTestId("rendered-change")).toBeNull();
    const message = byTestId("architecture-change-pull-request-unavailable");
    expect(message?.textContent).toContain("Comparison unavailable for this pull request");
    expect(message?.textContent).toContain("won't guess from the files on this computer");
    const action = Array.from(message?.querySelectorAll('[role="button"]') ?? []).find(
      (button) => button.textContent === "Open the pull request",
    );
    expect(action).toBeDefined();
    act(() => {
      action?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(state.openTab).toHaveBeenCalledWith({ kind: "pull_request" });
  });

  // F2 (v1.16): on a host that can't read a pull request's commits, the Change view says so in
  // words the user can act on, with no commit ids or tool names, and never draws a comparison.
  it("tells the user plainly when this computer's Fulcra can't compare a pull request yet", () => {
    const pullRequest = {
      number: 17,
      baseRefName: "main",
      baseRefOid: BASE_COMMIT,
      headRefOid: HEAD_COMMIT,
    };
    // The host doesn't offer checkout.file-at-commit.get, so nothing is read at the commits.
    expect(pullRequestReadable(false, pullRequest)).toBeNull();
    Object.assign(state.change as object, { pullRequest, pullRequestMaps: null });
    state.list = {
      ...idle,
      data: { kind: "listed", maps: [entry("a.ir.json")], oversized: [], truncated: false },
    };
    state.tabState = { view: "change" };
    render();
    expect(byTestId("rendered-change")).toBeNull();
    const text = byTestId("architecture-change-pull-request-unavailable")?.textContent ?? "";
    expect(text).toContain("Comparison unavailable for this pull request");
    expect(text).toContain("It won't guess from the files on this computer");
    expect(text).toContain("Open the pull request");
    const jargon =
      /\b[0-9a-f]{7,40}\b|\b(sha|oid|merge[- ]base|rpc|api|v1\.\d+|checkout\.|file-at-commit|capability)\b/i;
    expect(text).not.toMatch(jargon);
    // The other ways a pull request can't be compared read just as plainly.
    for (const key of [
      "unavailableTitle",
      "unavailableCommitRead",
      "unavailableNotInPullRequest",
    ]) {
      expect(i18n.t(`panels.architectureMap.change.${key}`)).not.toMatch(jargon);
    }
  });

  it("opens straight into the Change view when the pull request panel asks for it", () => {
    state.list = {
      ...idle,
      data: { kind: "listed", maps: [entry("a.ir.json")], oversized: [], truncated: false },
    };
    const key = changeViewRequestKey("srv", "ws");
    useChangeViewRequests.getState().request(key);
    render();
    expect(state.setCurrentTabState).toHaveBeenCalledWith({ view: "change" });
    expect(useChangeViewRequests.getState().pending.has(key)).toBe(false);
  });
});
