import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

// FU-396: one button scale. The hit area stays 48 px; the drawn control is a compact 32 px button, so a screen of
// actions no longer reads as a wall of equal pills. `primary` is the one main action of a section, `quiet` a text
// action for repeated row actions, and the default an outlined secondary button.
export function WorkButton({
  theme,
  label,
  children,
  onPress,
  selected,
  expanded,
  disabled,
  primary,
  quiet,
}: Pick<PluginSurfaceProps, "theme"> & {
  label: string;
  children?: string;
  onPress: () => void;
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
  primary?: boolean;
  quiet?: boolean;
}) {
  const c = theme.colors;
  const filled = primary && !disabled;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, expanded, disabled }}
      aria-selected={selected}
      aria-expanded={expanded}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: 48,
        minWidth: 48,
        justifyContent: "center",
        alignSelf: "flex-start",
        flexShrink: 1,
      }}
    >
      <View
        style={{
          minHeight: 32,
          paddingHorizontal: quiet ? 4 : 12,
          paddingVertical: 6,
          justifyContent: "center",
          borderRadius: 8,
          borderWidth: quiet || filled ? 0 : 1,
          borderColor: selected ? (c.accent ?? c.foreground) : c.border,
          backgroundColor: filled
            ? c.accent
            : selected
              ? (c.surface2 ?? c.surface0)
              : "transparent",
        }}
      >
        <Text
          style={{
            color: disabled
              ? c.foregroundMuted
              : filled
                ? c.accentForeground
                : quiet
                  ? c.statusSuccess
                  : c.foreground,
            fontSize: 13,
            fontWeight: filled || selected ? "600" : "500",
          }}
        >
          {children ?? label}
        </Text>
      </View>
    </Pressable>
  );
}
