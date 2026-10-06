import React from "react";
import { Text, View } from "react-native";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { settingsStyles } from "@/styles/settings";
const options: SegmentedControlOption<"all" | "primes" | "off">[] = [
  { value: "all", label: "All" },
  { value: "primes", label: "Primes & leads" },
  { value: "off", label: "Off" },
];
export function NotificationModeCardContent({
  unavailableReason,
  mode,
  error,
  onChange,
}: {
  unavailableReason: string | null;
  mode: "all" | "primes" | "off";
  error: string | null;
  onChange: (mode: "all" | "primes" | "off") => void;
}) {
  if (unavailableReason)
    return (
      <View style={settingsStyles.card} testID="host-page-notification-mode-unavailable">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Notify me</Text>
            <Text style={settingsStyles.rowHint}>{unavailableReason}</Text>
          </View>
        </View>
      </View>
    );
  return (
    <View style={settingsStyles.card} testID="host-page-notification-mode-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Notify me</Text>
          <Text style={settingsStyles.rowHint}>
            Which sessions send a notification when they finish, ask a question, or need permission
          </Text>
          {error && (
            <Text accessibilityLiveRegion="polite" style={settingsStyles.rowHint}>
              {error}
            </Text>
          )}
        </View>
        <SegmentedControl
          options={options}
          value={mode}
          onValueChange={onChange}
          size="sm"
          testID="host-page-notification-mode"
        />
      </View>
    </View>
  );
}
