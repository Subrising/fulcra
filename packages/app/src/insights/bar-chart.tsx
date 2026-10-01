import { useCallback, useState } from "react";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { G, Line, Path } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";

// A small bar chart for Insights: one or two series, thin bars with rounded tops on a shared baseline, a 2px gap
// between neighbouring bars, a recessive baseline and a legend only when there are two series. Tap (or click) a
// column to read its values in the line above the chart. Series colours are the validated pair for the surface.

export interface BarDatum {
  label: string;
  values: number[];
}

interface ChartPalette {
  series: [string, string];
  axis: string;
}

const DARK: [string, string] = ["#20744A", "#8a6ccf"];
const LIGHT: [string, string] = ["#20744A", "#7347af"];
function isDark(hex: string): boolean {
  const n = Number.parseInt(hex.replace("#", "").slice(0, 6), 16);
  if (!Number.isFinite(n)) return true;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}
const paletteProps = (theme: Theme) => ({
  palette: {
    series: isDark(theme.colors.surface0) ? DARK : LIGHT,
    axis: theme.colors.border,
  } satisfies ChartPalette,
});

const HEIGHT = 140;
const GAP = 2;
const RADIUS = 4;
// Thin marks: a bar never grows past this, and a column's bars are centred in it.
const MAX_BAR = 28;

const SERIES_IDS = ["first", "second"] as const;
/** A column's bars, one per series (at most two), each with a stable id. */
function seriesOf(d: BarDatum): { id: string; slot: number; value: number }[] {
  return SERIES_IDS.slice(0, d.values.length).map((id, slot) => ({
    id,
    slot,
    value: d.values[slot] ?? 0,
  }));
}

/** A bar with rounded top corners anchored to the baseline. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, w / 2, h);
  if (h <= 0) return "";
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

function Bars(props: {
  palette?: ChartPalette;
  data: readonly BarDatum[];
  width: number;
  selected: number | null;
}) {
  const palette = props.palette ?? { series: DARK, axis: "#2a2e2d" };
  const { data, width } = props;
  const series = Math.max(1, ...data.map((d) => d.values.length));
  const max = Math.max(1, ...data.flatMap((d) => d.values));
  const column = width / Math.max(1, data.length);
  const barWidth = Math.min(MAX_BAR, Math.max(2, (column - GAP * (series + 1)) / series));
  const inset = (column - (barWidth * series + GAP * (series - 1))) / 2;
  return (
    <Svg width={width} height={HEIGHT + 1}>
      {data.map((d, i) => (
        <G key={d.label} opacity={props.selected === null || props.selected === i ? 1 : 0.45}>
          {seriesOf(d).map((bar) => {
            const h = (bar.value / max) * (HEIGHT - 6);
            const x = i * column + inset + bar.slot * (barWidth + GAP);
            return (
              <Path
                key={bar.id}
                d={barPath(x, HEIGHT - h, barWidth, h)}
                fill={palette.series[bar.slot % 2]}
              />
            );
          })}
        </G>
      ))}
      <Line
        x1={0}
        y1={HEIGHT + 0.5}
        x2={width}
        y2={HEIGHT + 0.5}
        stroke={palette.axis}
        strokeWidth={1}
      />
    </Svg>
  );
}
const ThemedBars = withUnistyles(Bars);

export function BarChart(props: {
  data: readonly BarDatum[];
  seriesLabels: readonly string[];
  /** Readout for a column: "26 Sep: 18 started, 5 finished". */
  describe: (datum: BarDatum) => string;
  /** Shown above the chart until a column is chosen. */
  hint: string;
  testID?: string;
}) {
  const [width, setWidth] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);
  const readout =
    selected !== null && props.data[selected] ? props.describe(props.data[selected]) : null;
  const column = width / Math.max(1, props.data.length);
  return (
    <View style={styles.root} testID={props.testID}>
      <View style={styles.top}>
        <Text style={styles.readout}>{readout ?? props.hint}</Text>
        {props.seriesLabels.length > 1 ? <Legend labels={props.seriesLabels} /> : null}
      </View>
      <View onLayout={onLayout} style={styles.plot}>
        {width > 0 ? (
          <ThemedBars uniProps={paletteProps} data={props.data} width={width} selected={selected} />
        ) : null}
        <View style={styles.hits}>
          {props.data.map((d, i) => (
            <Hit
              key={d.label}
              index={i}
              width={column}
              onSelect={setSelected}
              label={props.describe(d)}
            />
          ))}
        </View>
      </View>
      <View style={styles.axis}>
        <Text style={styles.axisText}>{props.data[0]?.label ?? ""}</Text>
        <Text style={styles.axisText}>{props.data[props.data.length - 1]?.label ?? ""}</Text>
      </View>
    </View>
  );
}

function Hit(props: {
  index: number;
  width: number;
  label: string;
  onSelect: (index: number | null) => void;
}) {
  const { index, onSelect } = props;
  const onPress = useCallback(() => onSelect(index), [index, onSelect]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={onPress}
      style={[styles.hit, { width: props.width }]}
    />
  );
}

function Legend(props: { labels: readonly string[] }) {
  return (
    <View style={styles.legend}>
      {props.labels.map((label, i) => (
        <View key={label} style={styles.legendItem}>
          <View style={[styles.swatch, i === 0 ? styles.swatchA : styles.swatchB]} />
          <Text style={styles.axisText}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.spacing[1] },
  top: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  readout: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  plot: { height: HEIGHT + 1 },
  hits: { position: "absolute", left: 0, top: 0, bottom: 0, right: 0, flexDirection: "row" },
  hit: { height: "100%" },
  axis: { flexDirection: "row", justifyContent: "space-between" },
  axisText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  legend: { flexDirection: "row", gap: theme.spacing[3] },
  legendItem: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  swatchA: { backgroundColor: isDark(theme.colors.surface0) ? DARK[0] : LIGHT[0] },
  swatchB: { backgroundColor: isDark(theme.colors.surface0) ? DARK[1] : LIGHT[1] },
}));
