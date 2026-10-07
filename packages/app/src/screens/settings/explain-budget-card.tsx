import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeatureAvailability } from "@/runtime/host-features";
import { settingsStyles } from "@/styles/settings";

// How many written explanations (pull request review files and code map parts) this computer's host makes per day.
// The count used shows under each explanation; once the cap is reached the screens keep their rule-based lines.

// Matches DEFAULT_EXPLAIN_DAILY_LIMIT in the server's pull-request-review-explain.ts.
const HOST_DEFAULT = 30;
const CHOICES = [0, 10, 30, 60, 100];
const labelOf = (n: number) => (n === 0 ? "Off" : String(n));

export function explainBudgetOptions(current: number): SegmentedControlOption<string>[] {
  const values = CHOICES.includes(current) ? CHOICES : [...CHOICES, current].sort((a, b) => a - b);
  return values.map((n) => ({ value: String(n), label: labelOf(n) }));
}

export function ExplainBudgetCard({ serverId }: { serverId: string }) {
  const supported = useHostFeatureAvailability(serverId, "pullRequestReviewExplain") === true;
  const { config, patchConfig } = useDaemonConfig(serverId);
  const [error, setError] = useState<string | null>(null);
  const current = config?.explainDailyLimit ?? HOST_DEFAULT;
  const options = useMemo(() => explainBudgetOptions(current), [current]);
  const onChange = useCallback(
    (value: string) => {
      setError(null);
      patchConfig({ explainDailyLimit: Number(value) }).catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
    },
    [patchConfig],
  );
  if (!supported || !config) return null;
  return (
    <View style={settingsStyles.card} testID="settings-explain-budget-card">
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Written explanations per day</Text>
          <Text style={settingsStyles.rowHint}>
            Plain-words summaries in pull request reviews and the code map, written by a small model
            the first time someone opens a file or part. Each is saved, so opening it again is free.
          </Text>
          {error ? (
            <Text accessibilityLiveRegion="polite" style={settingsStyles.rowHint}>
              {error}
            </Text>
          ) : null}
        </View>
        <SegmentedControl
          options={options}
          value={String(current)}
          onValueChange={onChange}
          size="sm"
          testID="settings-explain-budget"
        />
      </View>
    </View>
  );
}
