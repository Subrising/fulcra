import { Pin } from "lucide-react-native";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  formatDisplayPct,
  formatProviderUsageLabel,
  formatResetLabel,
  formatResetTime,
  formatRunsOutLabel,
} from "./format";
import { UsageMeter } from "./meter";
import { displayPercent, usageWindowRowLabel } from "./model";
import { UsageResetLine } from "./reset-line";
import type { UsageDisplayAs } from "./preferences";
import { windowTone } from "./tone";
import type { UsageTone, UsageWindow } from "./types";
import { useRelativeTimeTick } from "./use-relative-time-tick";

export function UsageWindowBar({
  window,
  displayAs,
  pinnable,
  pinned,
  onTogglePin,
  pinLabel,
  pinTestID,
  retained = false,
}: {
  retained?: boolean;
  window: UsageWindow;
  displayAs: UsageDisplayAs;
  /** Whether the row pins the window to the sidebar. When false the row is a plain bar. */
  pinnable: boolean;
  pinned: boolean;
  onTogglePin: () => void;
  /** What the row pins, naming the source and window: "Pin Claude Session". */
  pinLabel: string;
  pinTestID: string;
}) {
  const { t, i18n } = useTranslation();
  const shownPct = displayPercent(window, displayAs);
  const tone = windowTone(window);

  const now = useRelativeTimeTick({ enabled: window.runsOutAt != null || window.resetsAt != null });
  const isAtRisk =
    window.runsOutAt != null &&
    window.shortfallPct != null &&
    (!retained || Date.parse(window.runsOutAt) > now);
  const countdown = isAtRisk
    ? formatRunsOutLabel(window.runsOutAt, now, t)
    : formatResetLabel(window.resetsAt, retained, now, t);
  // The exact time belongs to the reset; beside a runs-out warning it would read as the moment
  // the quota runs out.
  const exactTime = isAtRisk ? null : formatResetTime(window.resetsAt, now, t);

  const value =
    shownPct != null ? formatDisplayPct(shownPct, displayAs, i18n.resolvedLanguage, t) : "—";
  const accessibilityState = useMemo(() => ({ checked: pinned }), [pinned]);
  const content = {
    label: formatProviderUsageLabel(window.id, window.label, t),
    value,
    countdown,
    exactTime,
    isAtRisk,
    percent: shownPct ?? 0,
    tone,
    pinned,
  };

  if (!pinnable) {
    return (
      <View style={styles.row}>
        <WindowRowContent {...content} pinnable={false} />
      </View>
    );
  }

  // The whole row pins the window to the sidebar Usage item; the pin glyph is the only sign of it.
  return (
    <Pressable
      onPress={onTogglePin}
      accessibilityRole="checkbox"
      accessibilityLabel={usageWindowRowLabel({
        pinLabel,
        value,
        trailing: [countdown, exactTime].filter(Boolean).join(" · "),
      })}
      accessibilityState={accessibilityState}
      aria-checked={pinned}
      style={styles.row}
      testID={pinTestID}
    >
      <WindowRowContent {...content} pinnable />
    </Pressable>
  );
}

function WindowRowContent({
  label,
  value,
  countdown,
  exactTime,
  isAtRisk,
  percent,
  tone,
  pinnable,
  pinned,
}: {
  label: string;
  value: string;
  countdown: string | null;
  exactTime: string | null;
  isAtRisk: boolean;
  percent: number;
  tone: UsageTone;
  pinnable: boolean;
  pinned: boolean;
}) {
  return (
    <>
      <View style={styles.labelRow}>
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.value} numberOfLines={1}>
          {value}
        </Text>
        {pinnable ? <UsagePinGlyph pinned={pinned} /> : null}
      </View>
      <UsageMeter percent={percent} tone={tone} />
      <UsageResetLine countdown={countdown} exactTime={exactTime} atRisk={isAtRisk} />
    </>
  );
}

const ThemedPin = withUnistyles(Pin);

function UsagePinGlyph({ pinned }: { pinned: boolean }) {
  const { t } = useTranslation();
  const iconMapping = useMemo(
    () => (theme: { colors: { foreground: string; foregroundMuted: string } }) => ({
      color: pinned ? theme.colors.foreground : theme.colors.foregroundMuted,
      fill: pinned ? theme.colors.foreground : "none",
    }),
    [pinned],
  );
  return (
    <Tooltip delayDuration={300} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <View
          style={styles.pin}
          testID={pinned ? "usage-pin-glyph-pinned" : "usage-pin-glyph-unpinned"}
        >
          <ThemedPin size={12} uniProps={iconMapping} />
        </View>
      </TooltipTrigger>
      <TooltipContent side="top">
        <Text style={styles.tooltipText}>
          {pinned ? t("providerUsage.unpin") : t("providerUsage.pin")}
        </Text>
      </TooltipContent>
    </Tooltip>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { gap: 3, paddingVertical: theme.spacing[1.5] },
  pin: { width: 12, alignItems: "center" },
  tooltipText: { color: theme.colors.popoverForeground, fontSize: theme.fontSize.sm },
<<<<<<< HEAD
  row: {
    minHeight: 48,
    justifyContent: "center",
    gap: 3,
    // The highlight bleeds into the card padding so the label and bar stay on the card's rail.
    marginHorizontal: -theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    // Its own stacking context, so the highlight layer paints above the card and below the text.
    zIndex: 0,
  },
  highlightNone: {
    display: "none",
  },
  highlightPinned: {
    ...StyleSheet.absoluteFillObject,
    zIndex: -1,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  // The pinned surface at half strength: a separate layer, so the text keeps full opacity.
  highlightHovered: {
    ...StyleSheet.absoluteFillObject,
    zIndex: -1,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    opacity: theme.opacity[50],
  },
=======
>>>>>>> refs/remotes/upstream/tags/v0.15.0
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  label: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  value: {
    flexShrink: 0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
