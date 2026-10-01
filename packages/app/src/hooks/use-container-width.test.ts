// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import type { LayoutChangeEvent } from "react-native";
import { describe, expect, it } from "vitest";
import { readMeasuredWidth, useContainerWidthBelow } from "./use-container-width";

function layoutEvent(width: number): LayoutChangeEvent {
  return {
    nativeEvent: {
      layout: {
        width,
        height: 48,
        x: 0,
        y: 0,
      },
    },
  } as LayoutChangeEvent;
}

describe("readMeasuredWidth", () => {
  it("returns the width of a rendered container", () => {
    expect(readMeasuredWidth(layoutEvent(650))).toBe(650);
  });

  it("returns null for the zero width a hidden retained panel reports", () => {
    expect(readMeasuredWidth(layoutEvent(0))).toBeNull();
  });
});

describe("useContainerWidthBelow", () => {
  it("does not re-render for width changes that stay in the same threshold bucket", () => {
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useContainerWidthBelow(700);
    });

    expect(result.current.isBelow).toBe(true);
    expect(renderCount).toBe(1);

    act(() => {
      result.current.onLayout(layoutEvent(650));
      result.current.onLayout(layoutEvent(620));
      result.current.onLayout(layoutEvent(699));
    });

    expect(result.current.isBelow).toBe(true);
    expect(renderCount).toBe(1);
  });

  it("re-renders when the width crosses the threshold", () => {
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useContainerWidthBelow(700);
    });

    act(() => {
      result.current.onLayout(layoutEvent(760));
    });

    expect(result.current.isBelow).toBe(false);
    expect(renderCount).toBe(2);
  });

  it("ignores zero-width measurements from hidden mounted content", () => {
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useContainerWidthBelow(700, { initialIsBelow: false });
    });

    expect(result.current.isBelow).toBe(false);

    act(() => {
      result.current.onLayout(layoutEvent(0));
    });

    expect(result.current.isBelow).toBe(false);
    expect(renderCount).toBe(1);

    act(() => {
      result.current.onLayout(layoutEvent(650));
    });

    expect(result.current.isBelow).toBe(true);
    expect(renderCount).toBe(2);
  });
});

import { useContextObservation } from "@/context/observation";
describe("Context retained observation lifecycle", () => {
  it("hides old-scope rows synchronously and fences late results after scope and authority changes", () => {
    const observers: Array<{ publish: (rows: string[]) => void; stopped: boolean }> = [];
    const observe = (publish: (rows: string[]) => void) => {
      const observer = { publish, stopped: false };
      observers.push(observer);
      return () => {
        observer.stopped = true;
      };
    };
    const { result, rerender, unmount } = renderHook(
      ({ scope, enabled }) => useContextObservation(scope, enabled, observe),
      { initialProps: { scope: "hostA/workspace/session/epoch1", enabled: true } },
    );
    act(() => observers[0].publish(["old"]));
    expect(result.current).toEqual({ status: "loaded", data: ["old"] });
    rerender({ scope: "hostB/workspace/session/epoch2", enabled: true });
    expect(result.current).toEqual({ status: "loading" });
    expect(observers[0].stopped).toBe(true);
    act(() => observers[0].publish(["late-old"]));
    expect(result.current).toEqual({ status: "loading" });
    act(() => observers[1].publish(["current"]));
    expect(result.current).toEqual({ status: "loaded", data: ["current"] });
    rerender({ scope: "hostB/workspace/session/epoch2", enabled: false });
    expect(result.current).toEqual({ status: "loading" });
    expect(observers[1].stopped).toBe(true);
    act(() => observers[1].publish(["after-revoke"]));
    expect(result.current).toEqual({ status: "loading" });
    unmount();
  });
  it("does not subscribe while hidden and releases on collapse/unmount", () => {
    let starts = 0;
    let stops = 0;
    const observe = () => {
      starts++;
      return () => {
        stops++;
      };
    };
    const { rerender, unmount } = renderHook(
      ({ visible }) => useContextObservation("scope", visible, observe),
      { initialProps: { visible: false } },
    );
    expect(starts).toBe(0);
    rerender({ visible: true });
    expect(starts).toBe(1);
    rerender({ visible: false });
    expect(stops).toBe(1);
    rerender({ visible: true });
    expect(starts).toBe(2);
    unmount();
    expect(stops).toBe(2);
  });
});
