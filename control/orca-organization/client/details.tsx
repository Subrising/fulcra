import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
// J0 plain language: ids, hashes and other technical detail sit behind one "Details" disclosure, closed by
// default, so the screen reads in sentences and the exact values are still one tap away.
export function Details({ theme, children, label = "Details" }: { theme: PluginSurfaceProps["theme"]; children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false), c = theme.colors;
  return <View style={{ gap: 4 }}>
    <Pressable accessibilityRole="button" accessibilityLabel={`${open ? "Hide" : "Show"} ${label.toLowerCase()}`} accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ minHeight: 32, justifyContent: "center" }}>
      <Text style={{ color: c.foregroundMuted }}>{open ? "▾" : "▸"} {label}</Text>
    </Pressable>
    {open && <View style={{ gap: 4, paddingLeft: 12 }}>{children}</View>}
  </View>;
}
