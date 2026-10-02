import { View, Text } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import type { Fleet } from "../shared/fleet";
type Wait = NonNullable<Fleet["nodes"][number]["quotaWait"]>;
export function quotaIsStale(at: string | null | undefined) {
  const age = Date.now() - Date.parse(at ?? "");
  return !Number.isFinite(age) || age < -5000 || age > 45000;
}
export function quotaLabel(wait: Wait) {
  return wait.state === "attention"
    ? "Waiting for control review"
    : wait.state === "checking"
      ? "Waiting for verification"
      : wait.reason === "model-limit"
        ? "Waiting for model capacity"
        : "Waiting for provider capacity";
}
export function QuotaWaitCard({
  wait,
  theme,
  stale,
}: {
  wait: Wait;
  stale: boolean;
  theme: PluginSurfaceProps["theme"];
}) {
  const c = theme.colors;
  return (
    <View
      accessibilityLabel="Saved instruction wait"
      style={{
        padding: 16,
        gap: 8,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface2 ?? c.surface0,
      }}
    >
      <Text style={{ color: c.foreground, fontWeight: "600" }}>
        {stale ? "Last recorded: " : ""}
        {quotaLabel(wait)}
      </Text>
      <Text style={{ color: c.foregroundMuted }}>
        {stale
          ? "This observation is stale. Refresh before relying on the saved state."
          : wait.state === "attention"
            ? "Your instruction is saved, but its current control needs review. Open task controls to inspect or take over."
            : "Your instruction is saved. Fulcra rechecks provider capacity and control before resuming it; you do not need to send it again."}
      </Text>
      {wait.since && <Text style={{ color: c.foregroundMuted }}>Saved since {wait.since}</Text>}
      {wait.checkedAt && (
        <Text style={{ color: c.foregroundMuted }}>Last checked {wait.checkedAt}</Text>
      )}
      {!stale && wait.nextCheckAt && (
        <Text style={{ color: c.foregroundMuted }}>
          Scheduled check: {wait.nextCheckAt}. This is not a promised restart time.
        </Text>
      )}
    </View>
  );
}
