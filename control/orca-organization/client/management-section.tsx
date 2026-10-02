import { useState, type ReactNode } from "react";
import { Keyboard, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { WorkButton } from "./work-button";

/** Keep scoped drafts mounted; disclosure never dispatches a management command. */
export function ManagementSection({
  theme,
  title,
  children,
}: Pick<PluginSurfaceProps, "theme"> & { title: string; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={{ gap: 12 }}>
      <WorkButton
        theme={theme}
        label={title}
        expanded={expanded}
        onPress={() => {
          Keyboard.dismiss();
          setExpanded(!expanded);
        }}
      />
      <View
        accessibilityElementsHidden={!expanded}
        importantForAccessibility={expanded ? "auto" : "no-hide-descendants"}
        style={{ display: expanded ? "flex" : "none", gap: 12 }}
      >
        {children}
      </View>
    </View>
  );
}
