import type { ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";

/** Small building blocks shared by the Organisation screens. Colours come from theme tokens only. */
export type Theme = PluginSurfaceProps["theme"];
export type Colors = Theme["colors"];

export function newId() { return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.floor(Math.random() * 16); return (c === "x" ? r : (r & 3) | 8).toString(16); }); }

export function Button({ theme, label, onPress, testID, primary, selected, disabled, expanded, children }: { theme: Theme; label: string; onPress: () => void; testID?: string; primary?: boolean; selected?: boolean; disabled?: boolean; expanded?: boolean; children?: ReactNode }) {
  const c = theme.colors;
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, selected, expanded }} aria-selected={selected} aria-expanded={expanded} disabled={disabled} onPress={onPress}
    style={{ minHeight: 44, paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, justifyContent: "center", opacity: disabled ? 0.5 : 1,
      backgroundColor: primary ? c.accent : selected ? c.surface2 : c.surface1, borderWidth: primary ? 0 : 1, borderColor: selected ? c.accent : c.border }}>
    {children ?? <Text style={{ color: primary ? c.accentForeground : c.foreground, fontWeight: selected || primary ? "700" : "600", fontSize: 15 }}>{label}</Text>}
  </Pressable>;
}

export function Notice({ colors, tone, children, testID }: { colors: Colors; tone: "warning" | "danger" | "success"; children: ReactNode; testID?: string }) {
  const c = tone === "danger" ? colors.statusDanger : tone === "warning" ? colors.statusWarning : colors.statusSuccess;
  return <View testID={testID} accessibilityLiveRegion="polite" style={{ borderLeftWidth: 3, borderLeftColor: c, backgroundColor: colors.surface2, padding: 10, borderRadius: 8 }}>
    <Text style={{ color: colors.foreground, lineHeight: 20 }}>{children}</Text>
  </View>;
}

export function Pill({ colors, tone, children }: { colors: Colors; tone: "success" | "warning" | "danger" | "muted"; children: string }) {
  const c = tone === "success" ? colors.statusSuccess : tone === "warning" ? colors.statusWarning : tone === "danger" ? colors.statusDanger : colors.foregroundMuted;
  return <View style={{ alignSelf: "flex-start", borderRadius: 999, borderWidth: 1, borderColor: c, paddingHorizontal: 10, paddingVertical: 2 }}>
    <Text style={{ color: c, fontSize: 13, fontWeight: "700" }}>{children}</Text>
  </View>;
}

export function SectionTitle({ colors, children }: { colors: Colors; children: string }) {
  return <Text accessibilityRole="header" style={{ color: colors.foregroundMuted, fontSize: 13, fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase" }}>{children}</Text>;
}
