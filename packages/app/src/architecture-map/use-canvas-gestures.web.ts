import { useEffect, useRef, type RefObject } from "react";
import type { View } from "react-native";
import type { CanvasGestureOptions } from "./use-canvas-gestures";

// Map gestures on the web: pinch (a trackpad sends it as a ctrl-wheel) or Cmd/Ctrl + wheel zooms around the
// pointer, dragging the canvas pans it, and a double-click zooms in. A plain wheel keeps scrolling the page.
const DRAG_THRESHOLD = 4;

function scrollParent(element: HTMLElement | null, axis: "x" | "y"): HTMLElement | null {
  for (let node = element; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    const overflow = axis === "x" ? style.overflowX : style.overflowY;
    const scrollable =
      axis === "x" ? node.scrollWidth > node.clientWidth : node.scrollHeight > node.clientHeight;
    if (scrollable && (overflow === "auto" || overflow === "scroll")) return node;
  }
  return null;
}

export function useCanvasGestures(frame: RefObject<View | null>, options: CanvasGestureOptions) {
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    const element = frame.current as unknown as HTMLElement | null;
    if (!element || typeof element.addEventListener !== "function") return;
    const zoomAround = (factor: number, clientX: number, clientY: number) => {
      const { zoom, minZoom, maxZoom, onZoom } = latest.current;
      const next = Math.min(maxZoom, Math.max(minZoom, zoom * factor));
      if (next === zoom) return;
      const scrollX = scrollParent(element.firstElementChild as HTMLElement | null, "x");
      const scrollY = scrollParent(element, "y");
      const box = element.getBoundingClientRect();
      // Keep the point under the pointer still: scale its offset into the canvas by the zoom ratio.
      const pointX = (scrollX?.scrollLeft ?? 0) + clientX - box.left;
      const pointY = (scrollY?.scrollTop ?? 0) + clientY - box.top;
      const ratio = next / zoom;
      onZoom(next);
      requestAnimationFrame(() => {
        if (scrollX) scrollX.scrollLeft = pointX * ratio - (clientX - box.left);
        if (scrollY) scrollY.scrollTop += pointY * ratio - pointY;
      });
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomAround(Math.exp(-event.deltaY * 0.005), event.clientX, event.clientY);
    };
    const onDoubleClick = (event: MouseEvent) => zoomAround(1.5, event.clientX, event.clientY);

    let drag: { x: number; y: number; left: number; top: number; moved: boolean } | null = null;
    let scrollX: HTMLElement | null = null;
    let scrollY: HTMLElement | null = null;
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.pointerType !== "mouse") return;
      scrollX = scrollParent(element.firstElementChild as HTMLElement | null, "x");
      scrollY = scrollParent(element, "y");
      drag = {
        x: event.clientX,
        y: event.clientY,
        left: scrollX?.scrollLeft ?? 0,
        top: scrollY?.scrollTop ?? 0,
        moved: false,
      };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      drag.moved = true;
      element.style.cursor = "grabbing";
      if (scrollX) scrollX.scrollLeft = drag.left - dx;
      if (scrollY) scrollY.scrollTop = drag.top - dy;
    };
    const onPointerUp = () => {
      element.style.cursor = "";
      // A drag must not also select the node it ended on.
      if (drag?.moved) {
        const swallow = (click: MouseEvent) => {
          click.stopPropagation();
          click.preventDefault();
        };
        element.addEventListener("click", swallow, { capture: true, once: true });
        setTimeout(() => element.removeEventListener("click", swallow, { capture: true }), 0);
      }
      drag = null;
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("dblclick", onDoubleClick);
    element.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("dblclick", onDoubleClick);
      element.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [frame]);
}
