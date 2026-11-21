import { TOUCH_TARGET } from "@/hooks/use-touch-targets";

/** Shared geometry for menu rows and controls that align with them. */
<<<<<<< HEAD
export const MENU_ITEM_HEIGHT = { xs: TOUCH_TARGET, md: 28 } as const;
=======
import { density } from "@/styles/density";

/** A menu row is a tight row: touch-sized wherever controls are (see `resolveControlSizing`). */
export const MENU_ITEM_HEIGHT = density.tightRowHeight;
>>>>>>> refs/remotes/upstream/tags/v0.16.0
