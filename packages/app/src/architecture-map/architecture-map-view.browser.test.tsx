import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { i18n } from "@/i18n/i18next";
import { darkTheme } from "@/styles/theme";
import { parseArchitectureIr, type ArchitectureMapModel } from "./ir-model";
import { ArchitectureMapView } from "./architecture-map-view";
import headMap from "./fixtures/head.ir.json";

// The map's web gestures in real Chromium: a pinch (ctrl-wheel) zooms in, a drag pans, and a drag that ends on a
// part does not select it. Saves the pictures to .vitest-screenshots/map/.

const theme = vi.hoisted(() => ({ current: null as unknown }));

// The shared unistyles stub pins one light test theme and ignores `uniProps`. Here styles resolve
// against whichever real theme is current, and `uniProps` mappings are applied, as on device.
vi.mock("react-native-unistyles", async () => {
  const ReactModule = await import("react");
  const resolve = <T,>(styles: T | ((t: unknown) => T)): T =>
    typeof styles === "function" ? (styles as (t: unknown) => T)(theme.current) : styles;
  return {
    StyleSheet: {
      create: <T extends object>(styles: T | ((t: unknown) => T)) =>
        new Proxy({} as T, {
          get: (_target, key) => (resolve(styles) as Record<PropertyKey, unknown>)[key],
        }),
    },
    withUnistyles:
      (Component: React.ComponentType<Record<string, unknown>>) =>
      ({ uniProps, ...props }: Record<string, unknown> & { uniProps?: (t: unknown) => object }) =>
        ReactModule.createElement(Component, {
          ...props,
          ...(uniProps ? uniProps(theme.current) : {}),
        }),
    UnistylesRuntime: { setTheme: () => undefined, themeName: "light" },
  };
});

// react-native-svg's primitives as DOM SVG elements; React maps the camelCase props to attributes.
vi.mock("react-native-svg", async () => {
  const ReactModule = await import("react");
  const make = (tag: string) =>
    function SvgPrimitive({
      testID,
      children,
      onPress: _onPress,
      ...props
    }: Record<string, unknown>) {
      return ReactModule.createElement(
        tag,
        { ...props, ...(typeof testID === "string" ? { "data-testid": testID } : {}) },
        children as React.ReactNode,
      );
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

function model(): ArchitectureMapModel {
  const result = parseArchitectureIr(new TextEncoder().encode(JSON.stringify(headMap)));
  if (result.kind !== "ok") throw new Error(JSON.stringify(result));
  return result.model;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

const pause = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
const svgWidth = (frame: Element) => Number(frame.querySelector("svg")?.getAttribute("width") ?? 0);

describe("Architecture map gestures in a browser", () => {
  it("zooms with a pinch and pans with a drag", async () => {
    theme.current = darkTheme;
    await i18n.changeLanguage("en");
    await page.viewport(900, 700);
    document.body.style.margin = "0";
    document.body.style.backgroundColor = darkTheme.colors.surface0;
    container = document.createElement("div");
    container.style.width = "900px";
    container.style.height = "700px";
    container.style.display = "flex";
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root?.render(<ArchitectureMapView model={model()} />));
    await pause();

    const frame = container.querySelector('[data-testid="architecture-map-canvas"]') as HTMLElement;
    expect(container.textContent).toContain("Pinch or Cmd/Ctrl-scroll to zoom");
    const before = svgWidth(frame);
    const box = frame.getBoundingClientRect();
    const at = { clientX: box.left + 100, clientY: box.top + 60, bubbles: true, cancelable: true };
    for (let i = 0; i < 2; i += 1) {
      act(() => {
        frame.dispatchEvent(new WheelEvent("wheel", { ...at, deltaY: -40, ctrlKey: true }));
      });
      await pause(30);
    }
    await pause();
    const zoomed = svgWidth(frame);
    expect(zoomed).toBeGreaterThan(before);

    const scroller = frame.firstElementChild as HTMLElement;
    const startLeft = scroller.scrollLeft;
    const pointer = { pointerType: "mouse", button: 0, bubbles: true };
    act(() => {
      frame.dispatchEvent(
        new PointerEvent("pointerdown", {
          ...pointer,
          clientX: box.left + 400,
          clientY: box.top + 80,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          ...pointer,
          clientX: box.left + 250,
          clientY: box.top + 80,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          ...pointer,
          clientX: box.left + 250,
          clientY: box.top + 80,
        }),
      );
    });
    await pause();
    expect(scroller.scrollLeft).toBeGreaterThan(startLeft);
    await page.screenshot({
      element: container,
      path: "../../.vitest-screenshots/map/map-zoomed-dark.png",
    });

    act(() => {
      frame.dispatchEvent(new MouseEvent("dblclick", at));
    });
    await pause();
    expect(svgWidth(frame)).toBeGreaterThan(zoomed);
  });
});
