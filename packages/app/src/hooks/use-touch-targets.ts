import { StyleSheet } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useHasFinePointer } from "@/hooks/use-fine-pointer";

/** The smallest control a finger hits reliably. */
export const TOUCH_TARGET = 48;

/**
 * A touch screen: native, a phone-size layout, or a browser with no mouse-like pointer (a tablet). Controls then get
 * 48 px targets; a desktop with a mouse keeps its compact controls.
 */
export function useTouchTargets(): boolean {
  const isCompact = useIsCompactFormFactor();
  const finePointer = useHasFinePointer();
  return isNative || isCompact || !finePointer;
}

/**
 * Minimums, not sizes: added after a control's own frame, they grow it to a touch target and leave the drawn icon
 * or label as it is.
 */
export const touchTargetStyles = StyleSheet.create({
  icon: { minWidth: TOUCH_TARGET, minHeight: TOUCH_TARGET },
  text: { minHeight: TOUCH_TARGET },
});
