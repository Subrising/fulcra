import React, {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { View, ScrollView, type ScrollViewProps } from "react-native";
import { Gesture, GestureDetector, type NativeGesture } from "react-native-gesture-handler";
import type { PanSurfaceProps } from "@getpaseo/plugin/client/react-native";

const ScrollContext = createContext<NativeGesture | null>(null);
export const PanScrollView = forwardRef<ScrollView, ScrollViewProps>(
  function PanScrollView(props, ref) {
    const scroll = useMemo(() => Gesture.Native(), []);
    return (
      <ScrollContext.Provider value={scroll}>
        <GestureDetector gesture={scroll}>
          <ScrollView {...props} ref={ref} />
        </GestureDetector>
      </ScrollContext.Provider>
    );
  },
);

export function PanSurface({ onPanStart, onPanUpdate, onPanEnd, ...props }: PanSurfaceProps) {
  const scroll = useContext(ScrollContext);
  const callbacks = useRef({ onPanStart, onPanUpdate, onPanEnd });
  const origin = useRef<{ x: number; y: number } | null>(null);
  const prefix = useRef({ x: 0, y: 0 });
  const active = useRef(false),
    mounted = useRef(false);
  callbacks.current = { onPanStart, onPanUpdate, onPanEnd };
  const finish = useCallback((cancelled: boolean) => {
    if (!active.current) return;
    active.current = false;
    callbacks.current.onPanEnd(cancelled);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      finish(true);
    };
  }, [finish]);
  // Stable recognizers preserve ownership across plugin state/callback updates.
  const gesture = useMemo(() => {
    if (!scroll) throw new Error("PanSurface requires a PanScrollView ancestor");
    return Gesture.Pan()
      .minDistance(6)
      .averageTouches(true)
      .runOnJS(true)
      .blocksExternalGesture(scroll)
      .onBegin((event) => {
        if (mounted.current) origin.current = { x: event.absoluteX, y: event.absoluteY };
      })
      .onTouchesDown((event) => {
        // A second pointer changes the centroid before activation. Rebase the
        // origin so that pointer spacing is not counted as drag movement.
        if (!mounted.current || active.current || event.allTouches.length < 2) return;
        const center = event.allTouches.reduce(
          (sum, touch) => ({ x: sum.x + touch.absoluteX, y: sum.y + touch.absoluteY }),
          { x: 0, y: 0 },
        );
        origin.current = {
          x: center.x / event.allTouches.length,
          y: center.y / event.allTouches.length,
        };
      })
      .onStart((event) => {
        if (!mounted.current) return;
        // Callback transforms capture local bindings separately; use shared refs
        // on the JS thread for state spanning different gesture callbacks.
        // Android resets translation when activation crosses the threshold.
        // Preserve only that lost prefix; later translation remains continuous
        // when pointer count changes, unlike raw absolute coordinates.
        prefix.current = origin.current
          ? {
              x: event.absoluteX - origin.current.x - event.translationX,
              y: event.absoluteY - origin.current.y - event.translationY,
            }
          : { x: 0, y: 0 };
        origin.current = null;
        active.current = true;
        callbacks.current.onPanStart();
        callbacks.current.onPanUpdate({
          x: prefix.current.x + event.translationX,
          y: prefix.current.y + event.translationY,
        });
      })
      .onUpdate((event) => {
        if (active.current)
          callbacks.current.onPanUpdate({
            x: prefix.current.x + event.translationX,
            y: prefix.current.y + event.translationY,
          });
      })
      .onEnd((event, success) => {
        if (active.current && success)
          callbacks.current.onPanUpdate({
            x: prefix.current.x + event.translationX,
            y: prefix.current.y + event.translationY,
          });
      })
      .onFinalize((_event, success) => {
        origin.current = null;
        finish(!success);
      });
  }, [scroll, finish]);
  return (
    <GestureDetector gesture={gesture}>
      <View {...props} collapsable={false} />
    </GestureDetector>
  );
}
