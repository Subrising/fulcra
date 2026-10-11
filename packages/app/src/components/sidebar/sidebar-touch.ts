import { StyleSheet } from "react-native-unistyles";
import { TOUCH_TARGET, useTouchTargets } from "@/hooks/use-touch-targets";

// FU-62: on a touch screen (native, a phone-size layout, or a browser with no mouse-like pointer) every sidebar row
// is at least a 48 px touch target. A desktop with a mouse keeps the compact rows.
export const SIDEBAR_TOUCH_ROW_HEIGHT = TOUCH_TARGET;

export function useSidebarTouchRows(): boolean {
  return useTouchTargets();
}

export const sidebarTouchStyles = StyleSheet.create({
  /** A horizontal row: its children are already centred on the cross axis. */
  row: { minHeight: SIDEBAR_TOUCH_ROW_HEIGHT },
  /** A vertical stack of lines: centre them in the taller row. */
  stack: { minHeight: SIDEBAR_TOUCH_ROW_HEIGHT, justifyContent: "center" },
});
