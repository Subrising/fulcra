/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { buildArchitectureChange, type ArchitectureChange } from "./architecture-change";
import { ArchitectureChangeView } from "./architecture-change-view";
import { gitDiff } from "./git-patch.test.helpers";
import { pullRequestMaps } from "./pull-request-maps.test.helpers";

// As in architecture-map-view.test.tsx: each react-native-svg primitive becomes the DOM SVG
// element, so assertions see real text nodes. Theme mappings (uniProps) are dropped.
vi.mock("react-native-svg", async () => {
  const ReactModule = await import("react");
  const forwarded = ["x", "y", "width", "height", "viewBox", "strokeDasharray", "opacity"] as const;
  const make = (tag: string) =>
    function SvgPrimitive(props: Record<string, unknown> & { children?: React.ReactNode }) {
      const attributes: Record<string, unknown> = {};
      for (const key of forwarded) if (props[key] !== undefined) attributes[key] = props[key];
      if (typeof props.testID === "string") attributes["data-testid"] = props.testID;
      return ReactModule.createElement(tag, attributes, props.children as React.ReactNode);
    };
  return {
    default: make("svg"),
    G: make("g"),
    Line: make("line"),
    Polygon: make("polygon"),
    Rect: make("rect"),
    Text: make("text"),
  };
});

const MAP = ".fulcra/architecture/shop.ir.json";
const fixture = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const base = fixture("change-base.ir.json");
const head = fixture("change-head.ir.json");

type Ready = Extract<ArchitectureChange, { kind: "ready" }>;
function ready(options: { headText?: string; significant?: boolean } = {}): Ready {
  const headText = options.headText ?? head;
  const changedFiles = options.significant
    ? Array.from({ length: 12 }, (_, i) => ({ path: `src/f${i}.ts`, isDeleted: false }))
    : [
        { path: MAP, isDeleted: false },
        { path: "src/orders.ts", isDeleted: false },
        { path: "src/search.ts", isDeleted: false },
        { path: "docs/notes.md", isDeleted: false },
      ];
  const change = buildArchitectureChange({
    mapPath: MAP,
    headText,
    mapDiff: options.significant ? null : gitDiff(base, headText),
    changedFiles,
    siblings: new Map([["src", ["orders.ts", "orders.test.ts", "search.ts"]]]),
    // A pull request is compared at its own commits (v1.16): the committed maps, read through the
    // host. A significant change that left the map alone has the same map at both commits.
    pullRequest: { number: 17 },
    pullRequestMaps: pullRequestMaps(options.significant ? headText : base, headText),
  });
  if (change.kind !== "ready") throw new Error(JSON.stringify(change));
  return change;
}

let root: Root | null = null;
let container: HTMLElement | null = null;
const onOpenPullRequest = vi.fn();

function render(change: Ready, initialWidth: number): HTMLElement {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <ArchitectureChangeView
        change={change}
        title="Example shop"
        baseLabel="main"
        onOpenPullRequest={onOpenPullRequest}
        initialWidth={initialWidth}
      />,
    );
  });
  return container;
}

const all = (id: string) => [...(container?.querySelectorAll(`[data-testid="${id}"]`) ?? [])];
const one = (id: string) => container?.querySelector(`[data-testid="${id}"]`) ?? null;
const text = () => container?.textContent ?? "";
const press = (id: string) => act(() => (one(id) as HTMLElement).click());

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("React", React);
  await i18n.changeLanguage("en");
  onOpenPullRequest.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

describe("ArchitectureChangeView", () => {
  it("on a phone, opens on the combined picture with every change coloured and labelled", () => {
    render(ready(), 390);
    expect(one("architecture-change-delta")).not.toBeNull();
    expect(all("architecture-change-node-added")).toHaveLength(1);
    expect(all("architecture-change-node-removed")).toHaveLength(1);
    expect(all("architecture-change-node-changed")).toHaveLength(1);
    expect(all("architecture-change-node-unchanged")).toHaveLength(4);
    expect(all("architecture-change-edge-removed")).toHaveLength(1);
    expect(all("architecture-change-edge-added")).toHaveLength(2);
    // Colour is never the only signal.
    const badges = [...(one("architecture-change-delta")?.querySelectorAll("text") ?? [])].map(
      (node) => node.textContent,
    );
    expect(badges).toEqual(expect.arrayContaining(["New", "Removed", "Changed"]));
    expect(one("architecture-change-mode-side-by-side")).toBeNull();
  });

  it("says what changed in plain words", () => {
    render(ready(), 390);
    const summary = one("architecture-change-summary")?.textContent ?? "";
    expect(summary).toContain("Touches 3 parts of the system.");
    expect(summary).toContain("1 other part depends on what changed.");
    expect(summary).toContain(
      "4 files changed. 1 of 2 changed code files have a test beside them.",
    );
    const touched = one("architecture-change-touched")?.textContent ?? "";
    expect(touched).toContain("Product search");
    expect(touched).toContain("Weekly reports");
    expect(touched).toContain("changed: description");
    expect(one("architecture-change-reach")?.textContent).toContain("Shop website");
    expect(text()).toContain("Compared with main");
    expect(one("architecture-change-stale")).toBeNull();
  });

  it("on a phone, Before and After each show one side", () => {
    render(ready(), 390);
    press("architecture-change-mode-before");
    expect(one("architecture-change-before")).not.toBeNull();
    expect(all("architecture-change-node-removed")).toHaveLength(1);
    expect(all("architecture-change-node-added")).toHaveLength(0);
    press("architecture-change-mode-after");
    expect(all("architecture-change-node-added")).toHaveLength(1);
    expect(all("architecture-change-node-removed")).toHaveLength(0);
  });

  it("on a wide screen, shows Before and After side by side", () => {
    render(ready(), 1280);
    expect(one("architecture-change-before")?.textContent).toContain("Weekly reports");
    expect(one("architecture-change-before")?.textContent).not.toContain("Product search");
    expect(one("architecture-change-after")?.textContent).toContain("Product search");
    expect(one("architecture-change-after")?.textContent).not.toContain("Weekly reports");
    press("architecture-change-mode-changes");
    expect(one("architecture-change-delta")).not.toBeNull();
  });

  it("warns when a significant change left the map alone", () => {
    render(ready({ significant: true }), 390);
    const warning = one("architecture-change-stale")?.textContent ?? "";
    expect(warning).toContain("This diagram may be out of date");
    expect(warning).toContain("This change touches 12 files, but the map was not updated with it.");
    expect(one("architecture-change-summary")?.textContent).toContain(
      "No part of the system map changed.",
    );
  });

  it("opens the pull request in the app, never through a link", () => {
    render(ready(), 390);
    expect(one("architecture-change-open-pr")?.textContent).toBe("Open pull request #17");
    press("architecture-change-open-pr");
    expect(onOpenPullRequest).toHaveBeenCalledTimes(1);
    expect(container?.querySelector("a, [href]")).toBeNull();
  });

  it("shows markup in a label as text", () => {
    const hostile = head.replace('"Product search"', '"<img src=x onerror=alert(1)> search"');
    render(ready({ headText: hostile }), 390);
    expect(text()).toContain("<img src=x onerror=alert(1)> search");
    expect(container?.querySelector("img")).toBeNull();
  });
});
