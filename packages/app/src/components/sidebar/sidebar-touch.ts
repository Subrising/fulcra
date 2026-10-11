import { StyleSheet } from "react-native-unistyles";
import { buttonControlHeight } from "@/components/ui/control-geometry";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useHasFinePointer } from "@/hooks/use-fine-pointer";

// FU-62: on a touch screen (native, a phone-size layout, or a browser with no mouse-like pointer) every sidebar row
// is at least a 48 px touch target. A desktop with a mouse keeps the compact rows.
export const SIDEBAR_TOUCH_ROW_HEIGHT = 48;

/** The side of a square footer button: 48 px on a touch screen, else the compact or small control height. */
export function sidebarFooterButtonSize(isCompact: boolean, touch: boolean): number {
  if (touch) return SIDEBAR_TOUCH_ROW_HEIGHT;
  return isCompact ? buttonControlHeight.md : buttonControlHeight.xs;
}

export function useSidebarTouchRows(): boolean {
  const isCompact = useIsCompactFormFactor();
  const finePointer = useHasFinePointer();
  return isNative || isCompact || !finePointer;
}

export const sidebarTouchStyles = StyleSheet.create({
  /** A horizontal row: its children are already centred on the cross axis. */
  row: { minHeight: SIDEBAR_TOUCH_ROW_HEIGHT },
  /** A vertical stack of lines: centre them in the taller row. */
  stack: { minHeight: SIDEBAR_TOUCH_ROW_HEIGHT, justifyContent: "center" },
});
