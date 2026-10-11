import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page, WebSocketRoute } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { buildPluginSurfaceRoute } from "../../src/plugins/routes";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

// FU-62: with many leads the Leads block covered the sidebar, and Pinned and the sessions below it could not be
// reached on a small screen. The whole sidebar now scrolls as one area, lead rows are one line, and the Leads arrow
// folds the block and remembers it. Synthetic leads come from a stand-in controller plugin (the real one needs a
// Command Centre); the sidebar code under test is the app's own.
const PLUGIN_ID = "orca-organization-next";
const LEADS = 14;
const SHOTS = process.env.FU62_SHOTS_DIR ?? path.join(tmpdir(), "fu62-sidebar-shots");
// Phone and tablet sizes run as touch screens (a finger as the pointer); the desktop sizes use a mouse.
const SIZES = [
  { name: "phone-375", width: 375, height: 812, touch: true },
  { name: "phone-landscape", width: 812, height: 375, touch: true },
  { name: "tablet-768", width: 768, height: 1024, touch: true },
  { name: "window-1280x720", width: 1280, height: 720, touch: false },
  { name: "desktop-1440", width: 1440, height: 900, touch: false },
];
type Size = (typeof SIZES)[number];
type Measured = Awaited<ReturnType<typeof measure>>;

// The pointer type is set per case, never taken from the runner: a headless CI browser reports no fine pointer, and
// the app then (rightly) treats the desktop sizes as touch. Pointer and hover media queries answer from
// `window.__e2ePointer`; every other query goes to the browser.
function installPointerQueries() {
  const answer = (query: string, mode: "fine" | "coarse"): boolean | undefined => {
    const fine = mode === "fine";
    const known: Record<string, boolean> = {
      "(hover: hover) and (pointer: fine)": fine,
      "(pointer: fine)": fine,
      "(pointer: coarse)": !fine,
      "(any-pointer: fine)": fine,
      "(any-pointer: coarse)": !fine,
      "(hover: hover)": fine,
      "(hover: none)": !fine,
    };
    return known[query.toLowerCase().replace(/\s+/g, " ").trim()];
  };
  const real = window.matchMedia.bind(window);
  window.matchMedia = (query: string) => {
    const list = real(query);
    const mode = (window as unknown as { __e2ePointer?: "fine" | "coarse" }).__e2ePointer;
    const matches = mode ? answer(query, mode) : undefined;
    if (matches === undefined) return list;
    return Object.defineProperty(list, "matches", { get: () => matches });
  };
}

/** Makes the page a touch screen or a mouse desktop for the next navigation. */
async function setSize(page: Page, size: Size) {
  await page.setViewportSize({ width: size.width, height: size.height });
  // Init scripts run in the order they were added, so the last case's mode wins.
  await page.addInitScript(
    (mode) => {
      (window as unknown as { __e2ePointer?: string }).__e2ePointer = mode;
    },
    size.touch ? "coarse" : "fine",
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", {
    enabled: size.touch,
    maxTouchPoints: size.touch ? 5 : 1,
  });
}

/** The pass criteria: reach, no overflow, no clipping, no sideways scroll, and 48 px touch targets. */
function expectSidebarPasses(label: string, size: Size, result: Measured) {
  expect.soft(result.sideways, `${label}: sideways scroll`).toBe(false);
  expect.soft(result.pinned, `${label}: Pinned`).toBe("reachable");
  expect.soft(result.sessions, `${label}: sessions`).toBe("reachable");
  expect.soft(result.overflow, `${label}: overflow`).toEqual([]);
  expect.soft(result.clipped, `${label}: clipped text`).toEqual([]);
  expect.soft(result.overlaps, `${label}: overlapping rows`).toEqual([]);
  const leads = result.controls.filter(
    (control) =>
      control.testId === "sidebar-top-primes" ||
      control.testId === "sidebar-leads-collapse" ||
      control.testId?.startsWith("sidebar-lead-"),
  );
  expect.soft(leads.length, `${label}: lead controls found`).toBeGreaterThan(2);
  // On a touch screen every control is a touch target, the page header's buttons and the row menus included
  // (FU-73); with a mouse only the Leads block is.
  const targets = size.touch ? result.controls : leads;
  if (size.touch) {
    const rowMenus = result.controls.filter((control) =>
      /^sidebar-(workspace|project)-kebab-/.test(control.testId ?? ""),
    );
    expect.soft(rowMenus.length, `${label}: row menus found`).toBeGreaterThan(0);
    const header = result.controls.filter((control) => control.header);
    expect.soft(header.length, `${label}: header buttons found`).toBeGreaterThan(0);
  }
  const small = targets.filter((control) => control.width < 48 || control.height < 48);
  expect.soft(small, `${label}: controls under 48x48 px`).toEqual([]);
  if (!size.touch) {
    const newChat = result.controls.find((control) => control.testId === "sidebar-new-chat");
    expect.soft(newChat?.height, `${label}: compact rows kept with a mouse`).toBeLessThan(48);
  }
}

// What the app shows while the daemon connection is down.
const RECONNECTING = /Reconnecting to host|isn't connected|^Connecting$|is offline|Cannot reach/i;

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function pluginSources() {
  const seat = (n: number, role: string, projectId: string | null) => ({
    role,
    seat: projectId ?? "main",
    projectId,
    state: "assigned",
    revision: 1,
    task: null,
    sessionId: null,
    session: null,
    note: null,
    at: null,
    membershipAt: null,
    sessionPresent: false,
    sessionGenerationChanged: false,
    sessionTaskMatches: false,
    dispatch: null,
  });
  const projects = Array.from({ length: LEADS }, (_, i) => ({
    id: uuid(100 + i),
    name: `Synthetic project ${i + 1} with a fairly long name for the narrow sidebar`,
    description: null,
    status: "in_progress",
  }));
  const directory = {
    available: true,
    unavailable: null,
    primes: [seat(1, "prime", null)],
    projectSeats: projects.map((project, i) => seat(i + 2, "project-orchestrator", project.id)),
    programme: null,
    note: "Synthetic leads",
  };
  const server = `import { z } from "zod";
const any = z.any();
const DIRECTORY = ${JSON.stringify(directory)};
const PROJECTS = ${JSON.stringify(projects)};
export default function contribute(server) {
  server.handle({ name: "organization.role-directory", input: any, output: any }, () => ({
    ...DIRECTORY,
    observedAt: new Date().toISOString(),
  }), { readOnly: true });
  server.handle({ name: "organization.projects", input: any, output: any }, () => ({
    observedAt: new Date().toISOString(),
    available: true,
    partial: false,
    projects: PROJECTS,
    membership: [],
    note: "Synthetic projects",
  }), { readOnly: true });
  return () => {};
}`;
  const client = `import React from "react";
import { Text, View } from "react-native";
function Surface() {
  return <View><Text>Synthetic controller surface</Text></View>;
}
export default function contribute(client) {
  client.addSurface("organization", Surface);
  client.addSurface("leadership", Surface);
  client.addSidebarItem({ id: "organization", title: "Fulcra", icon: "House", surface: "organization" });
  return () => {};
}`;
  return { client, server };
}

/** Measures the sidebar the way FU-62 asks: reach, overflow, clipping, sideways scroll, control size. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const top = document.querySelector('[data-testid="sidebar-top-content"]');
    if (!top) throw new Error("sidebar top content not found");
    let scroller: HTMLElement | null = top.parentElement;
    while (scroller) {
      const style = getComputedStyle(scroller);
      if (/(auto|scroll)/.test(style.overflowY) && scroller.scrollHeight > scroller.clientHeight)
        break;
      if (/(auto|scroll)/.test(style.overflowY) && scroller.clientHeight > 0) break;
      scroller = scroller.parentElement;
    }
    if (!scroller) throw new Error("sidebar scroll container not found");
    const box = scroller.getBoundingClientRect();
    const reach = (testId: string) => {
      const el = document.querySelector(`[data-testid="${testId}"]`);
      if (!el) return "missing";
      el.scrollIntoView({ block: "nearest" });
      const r = el.getBoundingClientRect();
      const visible =
        r.top >= box.top - 1 &&
        r.top < box.bottom &&
        r.top < window.innerHeight &&
        r.left >= box.left - 1 &&
        r.right <= box.right + 1;
      scroller!.scrollTop = 0;
      return visible
        ? "reachable"
        : `not reachable (top ${Math.round(r.top)}, box ${Math.round(box.top)}-${Math.round(box.bottom)})`;
    };
    const inside = [...scroller.querySelectorAll<HTMLElement>("*")].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
    });
    // Text that an ancestor inside the sidebar cuts off (an ellipsis line) is not overflow.
    const clippedByAncestor = (el: HTMLElement) => {
      for (
        let parent = el.parentElement;
        parent && parent !== scroller;
        parent = parent.parentElement
      ) {
        if (getComputedStyle(parent).overflowX !== "visible") {
          const r = parent.getBoundingClientRect();
          if (r.right <= box.right + 1 && r.left >= box.left - 1) return true;
        }
      }
      return false;
    };
    const ellipsised = (el: HTMLElement) => {
      for (
        let node: HTMLElement | null = el;
        node && node !== scroller;
        node = node.parentElement
      ) {
        if (getComputedStyle(node).textOverflow === "ellipsis") return true;
      }
      return false;
    };
    const overflow = inside
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return (r.right > box.right + 1 || r.left < box.left - 1) && !clippedByAncestor(el);
      })
      .map((el) => el.getAttribute("data-testid") ?? el.textContent?.slice(0, 40) ?? el.tagName);
    const clipped = inside
      .filter((el) => {
        const style = getComputedStyle(el);
        const textLeaf = [...el.childNodes].some(
          (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
        );
        return (
          textLeaf &&
          el.scrollWidth > el.clientWidth + 1 &&
          !ellipsised(el) &&
          style.overflowX !== "visible"
        );
      })
      .map((el) => el.textContent?.slice(0, 60) ?? "");
    // Every visible sidebar control, including the footer outside the scroll, and every page header button.
    const header = document.querySelector('[data-testid="composer-dock-header"]');
    const headerButtons = header
      ? [...header.querySelectorAll<HTMLElement>('[role="button"], button')]
      : [];
    const controls = [
      ...new Set([
        ...document.querySelectorAll<HTMLElement>(
          '[data-testid^="sidebar-"], [data-testid^="menu-button"]',
        ),
        ...headerButtons,
      ]),
    ]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        // Row menus are buttons with no role attribute on web; they are matched by their test ID.
        const rowMenu = /^sidebar-(workspace|project)-kebab-/.test(
          el.getAttribute("data-testid") ?? "",
        );
        const role = rowMenu || el.getAttribute("role") === "button" || el.tagName === "BUTTON";
        return role && r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth;
      })
      .map((el) => {
        const r = el.getBoundingClientRect();
        return {
          name:
            el.getAttribute("aria-label") ??
            el.getAttribute("data-testid") ??
            el.textContent?.slice(0, 40) ??
            "",
          testId: el.getAttribute("data-testid"),
          header: Boolean(header?.contains(el)),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      });
    // No two rows draw in the same place (FU-62: on 0.2.13 the Leads setup rows did while a host reconnected).
    const nested = (a: Element, b: Element) => a.contains(b) || b.contains(a);
    const hits = (a: DOMRect, b: DOMRect) =>
      a.height > 0.5 &&
      b.height > 0.5 &&
      a.left < b.right - 0.5 &&
      b.left < a.right - 0.5 &&
      a.top < b.bottom - 0.5 &&
      b.top < a.bottom - 0.5;
    // A row inside the scroll is drawn only where the scroll shows it; rows scrolled under the footer are hidden.
    const seen = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (!scroller!.contains(el)) return r;
      const shownTop = Math.max(r.top, box.top);
      const shownBottom = Math.min(r.bottom, box.bottom);
      return new DOMRect(r.left, shownTop, r.width, Math.max(0, shownBottom - shownTop));
    };
    const named = (el: Element) =>
      el.getAttribute("data-testid") ?? el.textContent?.slice(0, 40) ?? el.tagName;
    const overlaps: string[] = [];
    const rows = [...document.querySelectorAll<HTMLElement>('[data-testid^="sidebar-"]')].filter(
      (el) => {
        const r = el.getBoundingClientRect();
        const role = el.getAttribute("role") === "button" || el.tagName === "BUTTON";
        return role && r.width > 0 && r.height > 0 && r.right > 0 && r.left < window.innerWidth;
      },
    );
    const lines = [...top.querySelectorAll<HTMLElement>("*")].filter((el) => {
      const r = el.getBoundingClientRect();
      const ownText = [...el.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
      );
      return ownText && r.width > 0 && r.height > 0;
    });
    for (const group of [rows, lines])
      for (let i = 0; i < group.length; i++)
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i]!;
          const b = group[j]!;
          if (nested(a, b)) continue;
          // Inline parts of one text line ("title", " · ", "status") share a line box by design.
          if (a.closest("[dir]") && a.closest("[dir]") === b.closest("[dir]")) continue;
          if (hits(seen(a), seen(b))) overlaps.push(`${named(a)} overlaps ${named(b)}`);
        }
    return {
      overlaps,
      sideways:
        scroller.scrollWidth > scroller.clientWidth + 1 ||
        document.documentElement.scrollWidth > window.innerWidth + 1,
      scrollerHeight: Math.round(scroller.clientHeight),
      contentHeight: Math.round(scroller.scrollHeight),
      pinned: reach("sidebar-pinned-section"),
      sessions: reach("sidebar-all-sessions"),
      overflow,
      clipped,
      controls,
    };
  });
}

// The host home is the controller surface, which has no shell menu on a phone; a workspace page has it.
async function openSidebar(page: Page, workspaceId: string) {
  await page.goto(buildHostWorkspaceRoute(getServerId(), workspaceId));
  // Wait for the page: a phone shows the menu, a wider screen shows the sidebar.
  const menu = page.getByRole("button", { name: "Open menu" }).filter({ visible: true }).first();
  const leads = page.getByTestId("sidebar-top-primes").filter({ visible: true }).first();
  await expect(menu.or(leads).first()).toBeVisible({ timeout: 30_000 });
  if (!(await leads.isVisible())) await menu.click();
  await expect(leads).toBeVisible({ timeout: 30_000 });
  await expect(
    page
      .getByTestId("sidebar-lead-p-" + uuid(100))
      .or(page.getByText(/Synthetic project 1 /).first()),
  ).toBeVisible({
    timeout: 30_000,
  });
}

test("the sidebar scrolls as one area with many leads, at phone, tablet and desktop sizes", async ({
  page,
}) => {
  test.setTimeout(480_000);
  await mkdir(SHOTS, { recursive: true });
  await page.addInitScript(installPointerQueries);
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-fu62-plugin-"));
  const client = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const seeded: SeededWorkspace[] = [];
  // Every daemon connection goes through this route, so the test can cut it and refuse new ones, as a daemon
  // restart does.
  const sockets = new Set<WebSocketRoute>();
  let refuse = false;
  await page.routeWebSocket(daemonWsRoutePattern(), (socket) => {
    if (refuse) {
      void socket.close({ code: 1012, reason: "Synthetic daemon restart" });
      return;
    }
    socket.connectToServer();
    sockets.add(socket);
  });
  try {
    const sources = pluginSources();
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
    );
    await writeFile(path.join(directory, "index.client.tsx"), sources.client);
    await writeFile(path.join(directory, "index.server.ts"), sources.server);
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(directory);
    for (let i = 0; i < 3; i++) {
      const workspace = await seedWorkspace({
        repoPrefix: `fu62-${i}-`,
        title: `Synthetic chat ${i + 1}`,
        git: false,
      });
      seeded.push(workspace);
      await workspace.client.createAgent({
        provider: "mock",
        cwd: workspace.workspaceDirectory,
        workspaceId: workspace.workspaceId,
        title: `Synthetic session ${i + 1}`,
      });
      if (i < 2) await workspace.client.setWorkspacePinned(workspace.workspaceId, true);
    }

    const results: Record<string, unknown> = {};
    for (const size of SIZES) {
      await setSize(page, size);
      await openSidebar(page, seeded[0]!.workspaceId);
      const result = await measure(page);
      results[size.name] = result;
      await writeFile(path.join(SHOTS, "measurements.json"), JSON.stringify(results, null, 2));
      await page.screenshot({ path: path.join(SHOTS, `${size.name}.png`) });
      await page.getByTestId("sidebar-pinned-section").first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(SHOTS, `${size.name}-scrolled.png`) });

      expectSidebarPasses(size.name, size, result);
    }

    // The host home is the controller surface. On a phone it must have a menu that opens the sidebar.
    for (const size of SIZES) {
      await setSize(page, size);
      // The host index restores the last workspace, so open the home surface's own route.
      await page.goto(
        buildPluginSurfaceRoute(getServerId(), PLUGIN_ID, { kind: "sidebar", id: "organization" }),
      );
      await expect(page.getByTestId("plugin-surface-title")).toBeVisible({ timeout: 30_000 });
      // Like a workspace, the home page has the sidebar toggle at every size. A phone opens the sidebar with it.
      const menu = page.getByTestId("menu-button").filter({ visible: true }).first();
      await expect(menu, `${size.name}: home menu`).toBeVisible({ timeout: 30_000 });
      if (size.name === "phone-375") {
        const menuBox = await menu.boundingBox();
        expect.soft(menuBox?.width, `${size.name}: home menu width`).toBeGreaterThanOrEqual(48);
        expect.soft(menuBox?.height, `${size.name}: home menu height`).toBeGreaterThanOrEqual(48);
        await page.screenshot({ path: path.join(SHOTS, `home-${size.name}-closed.png`) });
        await menu.click();
      }
      await expect(page.getByTestId("sidebar-top-primes").first()).toBeVisible({ timeout: 30_000 });
      // The lead rows load after the Leads header.
      await expect(page.getByText(/Synthetic project 1 /).first()).toBeVisible({ timeout: 30_000 });
      const result = await measure(page);
      results[`home-${size.name}`] = result;
      await writeFile(path.join(SHOTS, "measurements.json"), JSON.stringify(results, null, 2));
      await page.screenshot({ path: path.join(SHOTS, `home-${size.name}.png`) });
      expectSidebarPasses(`home ${size.name}`, size, result);
    }
    await writeFile(path.join(SHOTS, "measurements.json"), JSON.stringify(results, null, 2));

    // FU-62 (user report, 11 Oct): while the daemon restarts and after it is back, the Leads rows must not overlap.
    for (const size of SIZES) {
      await setSize(page, size);
      await openSidebar(page, seeded[0]!.workspaceId);
      refuse = true;
      for (const socket of sockets)
        await socket.close({ code: 1012, reason: "Synthetic daemon restart" });
      sockets.clear();
      await expect(page.getByText(RECONNECTING).first()).toBeVisible({ timeout: 30_000 });
      const down = await measure(page);
      results[`reconnecting-${size.name}`] = down;
      await page.screenshot({ path: path.join(SHOTS, `reconnecting-${size.name}.png`) });
      expect.soft(down.overlaps, `reconnecting ${size.name}: overlapping rows`).toEqual([]);
      expect.soft(down.sideways, `reconnecting ${size.name}: sideways scroll`).toBe(false);
      expect.soft(down.overflow, `reconnecting ${size.name}: overflow`).toEqual([]);
      expect.soft(down.clipped, `reconnecting ${size.name}: clipped text`).toEqual([]);
      refuse = false;
      await expect(page.getByText(/Synthetic project 1 /).first()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(RECONNECTING)).toHaveCount(0, {
        timeout: 60_000,
      });
      const back = await measure(page);
      results[`reconnected-${size.name}`] = back;
      await page.screenshot({ path: path.join(SHOTS, `reconnected-${size.name}.png`) });
      expect.soft(back.overlaps, `reconnected ${size.name}: overlapping rows`).toEqual([]);
      await writeFile(path.join(SHOTS, "measurements.json"), JSON.stringify(results, null, 2));
    }

    // The arrow folds Leads and the choice survives a reload.
    await setSize(page, SIZES[0]!);
    await openSidebar(page, seeded[0]!.workspaceId);
    await page.getByTestId("sidebar-leads-collapse").first().click();
    await expect(page.getByText(/Synthetic project 1 /)).toHaveCount(0);
    await page.screenshot({ path: path.join(SHOTS, "phone-375-leads-folded.png") });
    await page.reload();
    const menu = page.getByRole("button", { name: "Open menu" });
    if (await menu.isVisible().catch(() => false)) await menu.click();
    await expect(page.getByTestId("sidebar-leads-collapse").first()).toHaveAttribute(
      "aria-expanded",
      "false",
      { timeout: 30_000 },
    );
    await expect(page.getByText(/Synthetic project 1 /)).toHaveCount(0);
    await page.getByTestId("sidebar-leads-collapse").first().click();
  } finally {
    await client.removePlugin(PLUGIN_ID).catch(() => {});
    await client.close?.();
    for (const workspace of seeded) await workspace.cleanup().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
