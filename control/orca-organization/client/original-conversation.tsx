import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { conversationLink, conversationMessage } from "./conversation-link";

export function OriginalConversation({ targetHost, agentId, targetServerId, host, navigation, theme, label = "Open original conversation" }: Pick<PluginSurfaceProps, "host" | "navigation" | "theme"> & { targetHost: string; agentId: string | null; targetServerId?: string | null; label?: string }) {
  const [message, setMessage] = useState("");
  const link = conversationLink(targetHost, agentId, host?.id, navigation, targetServerId);
  return <View style={{ gap: 8 }}>
    {link.open && <Pressable style={{ minHeight: 48, paddingHorizontal: 18, paddingVertical: 14, justifyContent: "center", backgroundColor: theme.colors.accent ?? theme.colors.foreground, borderRadius: 14 }} accessibilityRole="button" accessibilityLabel={label} onPress={() => setMessage(conversationMessage(link.open!(), link.label))}>
      <Text style={{ color: theme.colors.accentForeground ?? theme.colors.surface0, fontSize: 15, fontWeight: "600" }}>{label} ↗</Text>
    </Pressable>}
    {!!(link.message || message) && <Text selectable accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted }}>{link.message || message}</Text>}
  </View>;
}
