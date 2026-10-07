import type { RefObject } from "react";
import type { View } from "react-native";

export interface CanvasGestureOptions {
  zoom: number;
  minZoom: number;
  maxZoom: number;
  onZoom: (zoom: number) => void;
}

// Native keeps the toolbar buttons and the scroll views' own panning; pinch-to-zoom on native is a follow-up.
export function useCanvasGestures(_frame: RefObject<View | null>, _options: CanvasGestureOptions) {}
