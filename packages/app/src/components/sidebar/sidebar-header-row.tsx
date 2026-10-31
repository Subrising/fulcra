<<<<<<< HEAD
import type { StyleProp, ViewStyle } from "react-native";
import {
  useCallback,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
  type Ref,
} from "react";
=======
import { useCallback, useState, type ComponentType, type ReactNode, type Ref } from "react";
>>>>>>> refs/remotes/upstream/tags/v0.13.1
import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { HEADER_INNER_HEIGHT, HEADER_INNER_HEIGHT_MOBILE } from "@/constants/layout";
import { DensityIcon } from "@/components/ui/density-icon";
import { Shortcut } from "@/components/ui/shortcut";
import { density, densityIconBox } from "@/styles/density";
import type { ShortcutKey } from "@/utils/format-shortcut";
import { sidebarTouchStyles, useSidebarTouchRows } from "./sidebar-touch";

type SidebarHeaderRowVariant = "header" | "compact" | "inline";

export type SidebarRowIcon = ComponentType<{ size: number; color: string }>;

interface SidebarHeaderRowProps {
  icon: SidebarRowIcon | null;
  label: string;
  onPress: () => void;
  isActive?: boolean;
  testID?: string;
  nativeID?: string;
  accessibilityLabel?: string;
  /**
   * "header" (default): a sidebar-height row with its own bottom separator —
   * the lone header at the top of a sidebar (settings "Back to workspace").
   * "compact": a row with no separator, for entries that
   * sit in a header group whose wrapper owns the single divider.
   * "inline": a full-width row with no inset, for a row inside a padded container such as the
   * sidebar footer.
   */
  variant?: SidebarHeaderRowVariant;
  /** Shown in the right slot while the row is hovered, when `trailing` is not set. */
  shortcutKeys?: ShortcutKey[][] | null;
  /**
   * The right slot. A sibling of the row's button, never inside it (web cannot nest buttons). A
   * press on the slot presses the row; a button inside it presses on its own.
   */
  trailing?: ReactNode;
  rowRef?: Ref<View>;
  /** A 48 px touch target with a mouse too (the Leads header, which opens and folds a block). */
  tall?: boolean;
}

// Header strips and grouped rows both grow for touch input.
function useTallHeaderRow(tall: boolean): boolean {
  const touchRows = useSidebarTouchRows();
  return tall || touchRows;
}

function headerRowIconSize(variant: SidebarHeaderRowVariant) {
  return variant === "header" ? ICON_SIZE.md : ICON_SIZE.sm;
}

export function SidebarHeaderRow({
  icon,
  label,
  onPress,
  isActive = false,
  testID,
  nativeID,
  accessibilityLabel,
  variant = "header",
  shortcutKeys = null,
  trailing,
  rowRef,
  tall = false,
}: SidebarHeaderRowProps) {
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  // The button and its trailing slot are siblings, so the row owns the pressed fill for both.
  const [isPressed, setIsPressed] = useState(false);
  const handlePressIn = useCallback(() => setIsPressed(true), []);
  const handlePressOut = useCallback(() => setIsPressed(false), []);
  const isHighlighted = isHovered || isActive;
<<<<<<< HEAD
  const tallRow = useTallHeaderRow(tall);
  const iconSize = headerRowIconSize(variant);
=======
  const iconSize = variant === "header" ? "md" : "sm";
>>>>>>> refs/remotes/upstream/tags/v0.13.1

  let right = trailing ?? null;
  if (right === null && shortcutKeys && isHovered) {
    right = <Shortcut chord={shortcutKeys} />;
  }

  return (
    <View ref={rowRef} collapsable={false} style={getContainerStyle(variant, tallRow)}>
      <View
<<<<<<< HEAD
        style={[
          styles.row,
          tallRow && sidebarTouchStyles.row,
          isHighlighted && styles.rowHighlighted,
        ]}
=======
        style={[styles.row, isHighlighted && styles.rowHighlighted, isPressed && styles.rowPressed]}
>>>>>>> refs/remotes/upstream/tags/v0.13.1
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <Pressable
          onPress={onPress}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          testID={testID}
          nativeID={nativeID}
          accessible
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? label}
          accessibilityState={isActive ? SELECTED_STATE : undefined}
          aria-selected={isActive}
          style={tallRow ? [styles.button, sidebarTouchStyles.row] : styles.button}
        >
          {icon ? (
            <DensityIcon
              icon={icon}
              size={iconSize}
              color={isHighlighted ? "foreground" : "foregroundMuted"}
            />
          ) : (
            <View style={variant === "header" ? styles.iconSpacer : styles.iconSpacerCompact} />
          )}
          <Text style={[styles.label, isHighlighted && styles.labelHighlighted]}>{label}</Text>
        </Pressable>
        {right === null ? null : (
          <Pressable
            onPress={onPress}
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            accessible={false}
            focusable={false}
            style={styles.trailing}
          >
            {right}
          </Pressable>
        )}
      </View>
    </View>
  );
}

const SELECTED_STATE = { selected: true } as const;

const styles = StyleSheet.create((theme) => ({
  container: {
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
    paddingHorizontal: theme.spacing[2],
    justifyContent: "center",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    userSelect: "none",
  },
  containerCompact: {
    paddingHorizontal: theme.spacing[2],
    justifyContent: "center",
    userSelect: "none",
  },
  containerInline: {
    width: "100%",
    justifyContent: "center",
    userSelect: "none",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    // Same row geometry as the settings sidebar items. Shorter than the header
    // strip so the hover highlight clears the strip's bottom separator.
    minHeight: density.tightRowHeight,
    borderRadius: theme.borderRadius.lg,
  },
  rowHighlighted: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  // The workspace rows' pressed fill.
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  button: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: density.tightRowHeight,
    paddingVertical: theme.spacing[1],
    // Match the project rows' inner padding so the icons align on one vertical
    // edge with the list below.
    paddingHorizontal: theme.spacing[2],
  },
  iconSpacer: { width: densityIconBox("md"), height: densityIconBox("md") },
  iconSpacerCompact: { width: densityIconBox("sm"), height: densityIconBox("sm") },
  label: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  labelHighlighted: {
    color: theme.colors.foreground,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingRight: theme.spacing[2],
  },
}));

function getContainerStyle(variant: SidebarHeaderRowVariant, tall = false): StyleProp<ViewStyle> {
  if (tall) return [getContainerStyle(variant), sidebarTouchStyles.row];
  switch (variant) {
    case "header":
      return styles.container;
    case "compact":
      return styles.containerCompact;
    case "inline":
      return styles.containerInline;
  }
}
