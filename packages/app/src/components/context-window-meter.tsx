import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { StyleSheet, UnistylesRuntime } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Combobox } from "@/components/ui/combobox";
import { UsagePanel } from "@/provider-usage/usage-panel";
import { useUsagePanel } from "@/provider-usage/use-usage-panel";

interface ContextWindowMeterProps {
  maxTokens: number | null;
  usedTokens: number | null;
  totalCostUsd?: number | null;
  showPercentage?: boolean;
  serverId?: string;
  /** The session this meter belongs to: its usage is the account it runs on (Fulcra account pool). */
  agentId?: string;
  /** The Paseo provider key, e.g. "claude", "gemini", "codex" */
  provider?: string | null;
  /** Reserve the meter footprint and show a loading ring while usage is pending. */
  pending?: boolean;
  /** Optional glyph envelope for icon-toolbar alignment. */
  glyphSize?: number;
}

function ignoreSelection() {}

const SVG_SIZE = 14;
const COMPACT_SVG_SIZE = 12;
const COMPACT_CENTER = COMPACT_SVG_SIZE / 2;
const COMPACT_RADIUS = 5;
const STROKE_WIDTH = 2;
const COMPACT_STROKE_WIDTH = 1.75;
const COMPACT_CIRCUMFERENCE = 2 * Math.PI * COMPACT_RADIUS;

function isValidMaxTokens(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isValidUsedTokens(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function getUsagePercentage(maxTokens: number, usedTokens: number): number | null {
  if (!isValidMaxTokens(maxTokens) || !isValidUsedTokens(usedTokens)) {
    return null;
  }
  return (usedTokens / maxTokens) * 100;
}

function clampPercentage(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function getMeterColors(
  percentage: number,
  theme: ReturnType<typeof UnistylesRuntime.getTheme>,
): { progress: string; track: string } {
  const track = theme.colors.surface3;
  if (percentage > 90) {
    return { progress: theme.colors.destructive, track };
  }
  if (percentage >= 70) {
    return { progress: theme.colors.palette.amber[500], track };
  }
  return { progress: theme.colors.foregroundMuted, track };
}

function getMeterGeometry(showPercentage: boolean, glyphSize?: number) {
  if (showPercentage) {
    return {
      svgSize: COMPACT_SVG_SIZE,
      center: COMPACT_CENTER,
      radius: COMPACT_RADIUS,
      strokeWidth: COMPACT_STROKE_WIDTH,
      circumference: COMPACT_CIRCUMFERENCE,
      containerStyle: styles.containerWithLabel,
    };
  }
  const resolvedSize = glyphSize ?? SVG_SIZE;
  const resolvedStrokeWidth = glyphSize ? 2 : STROKE_WIDTH;
  return {
    svgSize: resolvedSize,
    center: resolvedSize / 2,
    radius: (resolvedSize - resolvedStrokeWidth) / 2,
    strokeWidth: resolvedStrokeWidth,
    circumference: Math.PI * (resolvedSize - resolvedStrokeWidth),
    containerStyle: styles.container,
  };
}

export function ContextWindowMeter({
  maxTokens,
  usedTokens,
  showPercentage = false,
  serverId,
  agentId,
  glyphSize,
}: ContextWindowMeterProps) {
  const theme = UnistylesRuntime.getTheme();
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const anchorRef = useRef<View>(null);
  const panel = useUsagePanel(serverId ?? "", agentId ?? "", isOpen);
  const percentage =
    maxTokens !== null && usedTokens !== null ? getUsagePercentage(maxTokens, usedTokens) : null;

  const openPanel = useCallback(() => setIsOpen(true), [setIsOpen]);
  const accessibilityState = useMemo(() => ({ expanded: isOpen }), [isOpen]);
  const header = useMemo(() => ({ title: t("usagePanel.title") }), [t]);
  const geometry = getMeterGeometry(showPercentage, glyphSize);

  const clampedPercentage = clampPercentage(percentage ?? 0);
  const roundedPercentage = percentage === null ? null : Math.round(percentage);
  const { svgSize, center, radius, strokeWidth, circumference, containerStyle } = geometry;
  const dashOffset = circumference - (clampedPercentage / 100) * circumference;
  const colors = getMeterColors(clampedPercentage, theme);

  return (
    <>
      <Pressable
        ref={anchorRef}
        style={containerStyle}
        testID="context-window-meter"
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t("usagePanel.title")}
        accessibilityState={accessibilityState}
        onPress={openPanel}
      >
        <Svg
          width={svgSize}
          height={svgSize}
          viewBox={`0 0 ${svgSize} ${svgSize}`}
          style={styles.svg}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <Circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={colors.track}
            strokeWidth={strokeWidth}
          />
          {percentage !== null ? (
            <Circle
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={colors.progress}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
            />
          ) : null}
        </Svg>
        {showPercentage ? (
          <Text style={styles.percentageLabel}>
            {roundedPercentage === null ? "—" : `${roundedPercentage}%`}
          </Text>
        ) : null}
      </Pressable>
      <Combobox
        options={[]}
        value=""
        onSelect={ignoreSelection}
        anchorRef={anchorRef}
        open={isOpen}
        onOpenChange={setIsOpen}
        header={header}
        searchable={false}
        desktopPlacement="top-start"
        desktopMinWidth={420}
        desktopFixedHeight={600}
        desktopPreventInitialFlash
      >
        <UsagePanel {...panel} />
      </Combobox>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  containerWithLabel: {
    height: 28,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
  },
  svg: {
    transform: [{ rotate: "-90deg" }],
  },
  percentageLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
}));
