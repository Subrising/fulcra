// MH4 (J15): sessions on another Mac, as this app sees them over its own link. Reading only: this component has no
// buttons, links or handlers, and nothing here reaches the Command Centre (fleet-live.test.ts checks both).
import { View, Text } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { AppLinkSection } from "./fleet-live-model";

const MAX_ROWS = 50;

export function AppLinkSections({
  sections,
  theme,
}: {
  sections: readonly AppLinkSection[];
  theme: PluginSurfaceProps["theme"];
}) {
  const c = theme.colors,
    text = { color: c.foreground },
    muted = { color: c.foregroundMuted };
  if (!sections.length) return null;
  return (
    <View style={{ gap: 16 }}>
      {sections.map((section) => {
        const count = section.sessions.length;
        return (
          <View
            key={section.hostName}
            testID="fleet-app-link-section"
            style={{
              gap: 8,
              padding: 16,
              backgroundColor: c.surface1 ?? c.surface0,
              borderWidth: 1,
              borderColor: c.border,
              borderRadius: 16,
            }}
          >
            <Text style={{ ...text, fontSize: 16, fontWeight: "600" }}>
              {section.state === "ok"
                ? `${section.hostName} · ${count} session${count === 1 ? "" : "s"} not in Command Centre tasks`
                : section.hostName}
            </Text>
            <Text style={muted}>{section.note}</Text>
            {section.sessions.slice(0, MAX_ROWS).map((session) => (
              <View
                key={session.agentId}
                style={{ borderLeftWidth: 2, borderColor: c.border, paddingLeft: 12, gap: 2 }}
              >
                <Text style={text} numberOfLines={1}>
                  {session.title}
                </Text>
                <Text style={muted} numberOfLines={1}>
                  {[
                    session.status,
                    session.provider,
                    session.accountName ? `account ${session.accountName}` : null,
                    session.backgroundWorkCount > 0
                      ? `${session.backgroundWorkCount} background job${session.backgroundWorkCount === 1 ? "" : "s"}`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Text>
              </View>
            ))}
            {count > MAX_ROWS && (
              <Text
                style={muted}
              >{`And ${count - MAX_ROWS} more. All of them are in the sidebar and History.`}</Text>
            )}
            {section.state === "ok" && count > 0 && (
              <Text style={muted}>Open them from the sidebar or History.</Text>
            )}
          </View>
        );
      })}
    </View>
  );
}
