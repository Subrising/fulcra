import { Pressable, Text } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

export function WorkButton({
  theme,
  label,
  children,
  onPress,
  selected,
  expanded,
  disabled,
}: Pick<PluginSurfaceProps, "theme"> & {
  label: string;
  children?: string;
  onPress: () => void;
  selected?: boolean;
  expanded?: boolean;
  disabled?: boolean;
}) {
  const c = theme.colors;
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
        paddingHorizontal: 16,
        paddingVertical: 12,
        justifyContent: "center",
        flexShrink: 1,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: selected ? (c.accent ?? c.foreground) : c.border,
        backgroundColor: selected ? (c.surface2 ?? c.surface0) : (c.surface1 ?? c.surface0),
      }}
    >
      <Text
        style={{
          color: disabled ? c.foregroundMuted : c.foreground,
          fontSize: 14,
          fontWeight: selected ? "700" : "500",
        }}
      >
        {children ?? label}
      </Text>
    </Pressable>
  );
}
