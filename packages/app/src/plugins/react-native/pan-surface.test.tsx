/** @vitest-environment jsdom */
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Pressable, Text } from "react-native";
import { afterEach, expect, it, vi } from "vitest";
import { PanScrollView, PanSurface } from "./pan-surface";

const noop = () => {};
interface Touches {
  allTouches: { absoluteX: number; absoluteY: number }[];
}
interface Point {
  absoluteX?: number;
  absoluteY?: number;
  translationX: number;
  translationY: number;
}
// Node cannot run native recognizers. This tests callback/tap/lifecycle contracts;
// the paired Android APK must independently prove native scroll arbitration.
const native = vi.hoisted(() => {
  function builder() {
    return {
      config: {} as { averageTouches?: boolean; minDistance?: number; runOnJS?: boolean },
      touchesDown: (_event: Touches) => {},
      begin: (_event: Point) => {},
      start: (_event: Point) => {},
      update: (_event: Point) => {},
      end: (_event: Point, _success: boolean) => {},
      finalize: (_event: Point, _success: boolean) => {},
      parent: null as object | null,
      averageTouches(value: boolean) {
        this.config.averageTouches = value;
        return this;
      },
      minDistance(value: number) {
        this.config.minDistance = value;
        return this;
      },
      runOnJS(value: boolean) {
        this.config.runOnJS = value;
        return this;
      },
      blocksExternalGesture(ref: object) {
        this.parent = ref;
        return this;
      },
      onTouchesDown(callback: (event: Touches) => void) {
        this.touchesDown = callback;
        return this;
      },
      onBegin(callback: (event: Point) => void) {
        this.begin = callback;
        return this;
      },
      onStart(callback: (event: Point) => void) {
        this.start = callback;
        return this;
      },
      onUpdate(callback: (event: Point) => void) {
        this.update = callback;
        return this;
      },
      onEnd(callback: (event: Point, success: boolean) => void) {
        this.end = callback;
        return this;
      },
      onFinalize(callback: (event: Point, success: boolean) => void) {
        this.finalize = callback;
        return this;
      },
    };
  }
  const state: { current: ReturnType<typeof builder> | null } = { current: null };
  return { builder, state };
});
vi.mock("react-native-gesture-handler", async () => {
  const { ScrollView } = await import("react-native");
  return {
    ScrollView,
    Gesture: { Pan: native.builder, Native: () => ({ native: true }) },
    GestureDetector: ({
      gesture,
      children,
    }: {
      gesture: ReturnType<typeof native.builder>;
      children: React.ReactNode;
    }) => {
      if ("start" in gesture) native.state.current = gesture;
      return children;
    },
  };
});
function currentPan() {
  const value = native.state.current;
  if (!value) throw new Error("No native gesture rendered");
  return value;
}
afterEach(() => {
  cleanup();
  native.state.current = null;
});
it("keeps taps separate from cumulative pan updates and completion", () => {
  const events: unknown[] = [],
    tap = vi.fn();
  const onStart = vi.fn(() => events.push("start"));
  const onUpdate = vi.fn((point: { x: number; y: number }) => events.push(point));
  const onEnd = vi.fn((cancelled: boolean) => events.push({ cancelled }));
  render(
    <PanScrollView>
      <PanSurface onPanStart={onStart} onPanUpdate={onUpdate} onPanEnd={onEnd}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Inspect saved session"
          onPress={tap}
        >
          <Text>Session</Text>
        </Pressable>
      </PanSurface>
    </PanScrollView>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Inspect saved session" }));
  expect(tap).toHaveBeenCalledTimes(1);
  expect(events).toEqual([]);
  const pan = currentPan();
  expect(pan.parent).toEqual({ native: true });
  expect(pan.config).toEqual({ averageTouches: true, minDistance: 6, runOnJS: true });
  act(() => {
    pan.start({ translationX: 8, translationY: 10 });
    pan.update({ translationX: 72, translationY: 96 });
    pan.end({ translationX: 80, translationY: 110 }, true);
    pan.finalize({ translationX: 80, translationY: 110 }, true);
  });
  expect(events).toEqual([
    "start",
    { x: 8, y: 10 },
    { x: 72, y: 96 },
    { x: 80, y: 110 },
    { cancelled: false },
  ]);
  expect(tap).toHaveBeenCalledTimes(1);
});

it("retains the active recognizer and uses updated callbacks", () => {
  const initial = vi.fn(),
    updated = vi.fn(),
    end = vi.fn();
  const view = render(
    <PanScrollView>
      <PanSurface onPanStart={noop} onPanUpdate={initial} onPanEnd={end} />
    </PanScrollView>,
  );
  const pan = currentPan();
  act(() => pan.start({ translationX: 8, translationY: 0 }));
  view.rerender(
    <PanScrollView>
      <PanSurface onPanStart={noop} onPanUpdate={updated} onPanEnd={end} />
    </PanScrollView>,
  );
  expect(currentPan()).toBe(pan);
  act(() => {
    pan.update({ translationX: 100, translationY: 0 });
    pan.finalize({ translationX: 100, translationY: 0 }, false);
    pan.finalize({ translationX: 100, translationY: 0 }, true);
  });
  expect(initial).toHaveBeenCalledTimes(1);
  expect(updated).toHaveBeenCalledWith({ x: 100, y: 0 });
  expect(end).toHaveBeenCalledExactlyOnceWith(true);
});
it("cancels once on unmount and ignores late native callbacks", () => {
  const start = vi.fn(),
    update = vi.fn(),
    end = vi.fn();
  const view = render(
    <PanScrollView>
      <PanSurface onPanStart={start} onPanUpdate={update} onPanEnd={end} />
    </PanScrollView>,
  );
  const pan = currentPan(),
    point = { translationX: 20, translationY: 30 };
  act(() => pan.start(point));
  view.unmount();
  act(() => {
    pan.start(point);
    pan.update(point);
    pan.end(point, true);
    pan.finalize(point, true);
  });
  expect(start).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledTimes(1);
  expect(end).toHaveBeenCalledExactlyOnceWith(true);
});
it("does not emit a pan completion for a failed tap", () => {
  const end = vi.fn();
  render(
    <PanScrollView>
      <PanSurface onPanStart={noop} onPanUpdate={noop} onPanEnd={end} />
    </PanScrollView>,
  );
  act(() => currentPan().finalize({ translationX: 0, translationY: 0 }, false));
  expect(end).not.toHaveBeenCalled();
});
it("cancels exactly once after a plugin start callback throws", () => {
  const failure = new Error("Plugin callback failed"),
    update = vi.fn(),
    end = vi.fn();
  const start = vi.fn(() => {
    throw failure;
  });
  render(
    <PanScrollView>
      <PanSurface onPanStart={start} onPanUpdate={update} onPanEnd={end} />
    </PanScrollView>,
  );
  const pan = currentPan(),
    point = { translationX: 10, translationY: 20 };
  expect(() => pan.start(point)).toThrow(failure);
  act(() => {
    pan.finalize(point, false);
    pan.finalize(point, false);
  });
  expect(update).not.toHaveBeenCalled();
  expect(end).toHaveBeenCalledExactlyOnceWith(true);
});
it("requires the coordinating scroll ancestor", () => {
  expect(() => render(<PanSurface onPanStart={noop} onPanUpdate={noop} onPanEnd={noop} />)).toThrow(
    "PanSurface requires a PanScrollView ancestor",
  );
});

it("retains pre-activation movement after Android resets translation", () => {
  const update = vi.fn();
  render(
    <PanScrollView>
      <PanSurface onPanStart={noop} onPanUpdate={update} onPanEnd={noop} />
    </PanScrollView>,
  );
  const pan = currentPan();
  act(() => {
    pan.begin({ absoluteX: 200, absoluteY: 500, translationX: 0, translationY: 0 });
    pan.start({ absoluteX: 190, absoluteY: 480, translationX: 0, translationY: 0 });
    pan.update({ absoluteX: 100, absoluteY: 380, translationX: -90, translationY: -100 });
    pan.end({ absoluteX: 90, absoluteY: 370, translationX: -100, translationY: -110 }, true);
    pan.finalize({ translationX: -100, translationY: -110 }, true);
  });
  expect(update.mock.calls).toEqual([
    [{ x: -10, y: -20 }],
    [{ x: -100, y: -120 }],
    [{ x: -110, y: -130 }],
  ]);
  // iOS keeps translation; do not count its initial displacement twice.
  act(() => {
    pan.begin({ absoluteX: 200, absoluteY: 500, translationX: 0, translationY: 0 });
    pan.start({ absoluteX: 190, absoluteY: 480, translationX: -10, translationY: -20 });
    pan.update({ absoluteX: 100, absoluteY: 380, translationX: -100, translationY: -120 });
  });
  expect(update).toHaveBeenLastCalledWith({ x: -100, y: -120 });
});

it("does not count a second pointer's spacing as pre-activation movement", () => {
  const update = vi.fn();
  render(
    <PanScrollView>
      <PanSurface onPanStart={noop} onPanUpdate={update} onPanEnd={noop} />
    </PanScrollView>,
  );
  const pan = currentPan();
  act(() => {
    pan.begin({ absoluteX: 200, absoluteY: 500, translationX: 0, translationY: 0 });
    pan.touchesDown({
      allTouches: [
        { absoluteX: 200, absoluteY: 500 },
        { absoluteX: 200, absoluteY: 600 },
      ],
    });
    pan.start({ absoluteX: 190, absoluteY: 540, translationX: 0, translationY: 0 });
    pan.update({ absoluteX: 140, absoluteY: 490, translationX: -50, translationY: -50 });
    pan.touchesDown({
      allTouches: [
        { absoluteX: 140, absoluteY: 490 },
        { absoluteX: 140, absoluteY: 590 },
      ],
    });
    pan.end({ absoluteX: 90, absoluteY: 490, translationX: -100, translationY: -100 }, true);
  });
  expect(update.mock.calls).toEqual([
    [{ x: -10, y: -10 }],
    [{ x: -60, y: -60 }],
    [{ x: -110, y: -110 }],
  ]);
});
