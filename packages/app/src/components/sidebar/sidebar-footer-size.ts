import { buttonControlHeight } from "@/components/ui/control-geometry";
import { SIDEBAR_TOUCH_ROW_HEIGHT } from "@/components/sidebar/sidebar-touch";

/** The side of a square footer button: 48 px on a touch screen, else the compact or small control height. */
export function sidebarFooterButtonSize(isCompact: boolean, touch: boolean): number {
  if (touch) return SIDEBAR_TOUCH_ROW_HEIGHT;
  return isCompact ? buttonControlHeight.md : buttonControlHeight.xs;
}
