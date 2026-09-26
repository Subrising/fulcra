import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { G, Line, Polygon, Rect, Text as SvgText } from "react-native-svg";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import type { ArchitectureChange } from "./architecture-change";
import type { ArchitectureMapEdge, ArchitectureMapModel, ArchitectureMapNode } from "./ir-model";
import { computeViewBox, edgeGeometry, fitText, shouldDrawLabels, type ViewBox } from "./layout";
import { withStatus, type DiffStatus, type EdgeField, type NodeField } from "./map-diff";

// The Change view: the system map before and after one change, coloured by what the change did.
// Same security boundary as architecture-map-view.tsx: every IR-derived string is a text child of
// a Text or SvgText element, colours come only from theme tokens, and nothing from the IR reaches a
// link, a style or an attribute. Colour is never the only signal: changed boxes carry a word badge.

type ReadyChange = Extract<ArchitectureChange, { kind: "ready" }>;
type Mode = "side-by-side" | "changes" | "before" | "after";
type StatusNode = ArchitectureMapNode & { status: DiffStatus };
type StatusEdge = ArchitectureMapEdge & { status: DiffStatus };

const SIDE_BY_SIDE_MIN_WIDTH = 760;
// Drawn at this width until the first layout arrives, so the pictures never start blank.
const FIRST_PAINT_WIDTH = 360;
// Side by side shows the whole of both maps (an overview); a single picture keeps labels readable
// and scrolls sideways instead.
const OVERVIEW_MIN_ZOOM = 0.3;
const SINGLE_MIN_ZOOM = 0.75;
// A single picture that scrolls opens on its first changed part, this far in from the edge.
const FOCUS_MARGIN = 16;
const LABEL_SIZE = 13;
const DETAIL_SIZE = 10.5;
const BADGE_SIZE = 9.5;
const SELECTED_STATE = { selected: true } as const;
const UNSELECTED_STATE = { selected: false } as const;

function statusColor(theme: Theme, status: DiffStatus): string {
  switch (status) {
    case "added":
      return theme.colors.statusSuccess;
    case "removed":
      return theme.colors.statusDanger;
    case "changed":
      return theme.colors.statusWarning;
    case "unchanged":
      return theme.colors.foregroundMuted;
  }
}

const STATUSES: readonly DiffStatus[] = ["added", "removed", "changed", "unchanged"];
const frameProps = new Map(
  STATUSES.map((status) => [
    status,
    (theme: Theme) => ({ fill: theme.colors.surface1, stroke: statusColor(theme, status) }),
  ]),
);
const strokeProps = new Map(
  STATUSES.map((status) => [status, (theme: Theme) => ({ stroke: statusColor(theme, status) })]),
);
const fillProps = new Map(
  STATUSES.map((status) => [status, (theme: Theme) => ({ fill: statusColor(theme, status) })]),
);
const foregroundFill = (theme: Theme) => ({ fill: theme.colors.foreground });
const mutedFill = (theme: Theme) => ({ fill: theme.colors.foregroundMuted });

const ThemedLine = withUnistyles(Line);
const ThemedPolygon = withUnistyles(Polygon);
const ThemedRect = withUnistyles(Rect);
const ThemedSvgText = withUnistyles(SvgText);

function statusPicture(
  model: ArchitectureMapModel | null,
  nodeStatus: ReadonlyMap<string, DiffStatus>,
  edgeStatus: ReadonlyMap<string, DiffStatus>,
): { nodes: StatusNode[]; edges: StatusEdge[] } {
  if (!model) return { nodes: [], edges: [] };
  return {
    nodes: model.nodes.map((node) => withStatus(node, nodeStatus.get(node.id) ?? "unchanged")),
    edges: model.edges.map((edge) => withStatus(edge, edgeStatus.get(edge.id) ?? "unchanged")),
  };
}

export interface ArchitectureChangeViewProps {
  change: ReadyChange;
  title: string;
  baseLabel: string | null;
  onOpenPullRequest: (() => void) | null;
  /** Width to draw at before the first layout (tests and screenshots pass the viewport). */
  initialWidth?: number;
}

export function ArchitectureChangeView({
  change,
  title,
  baseLabel,
  onOpenPullRequest,
  initialWidth = FIRST_PAINT_WIDTH,
}: ArchitectureChangeViewProps) {
  const { t } = useTranslation();
  const [measured, setWidth] = useState(0);
  const width = measured > 0 ? measured : initialWidth;
  const wide = width >= SIDE_BY_SIDE_MIN_WIDTH;
  const modes: Mode[] = wide ? ["side-by-side", "changes"] : ["changes", "before", "after"];
  const [chosen, setChosen] = useState<Mode | null>(null);
  const mode = chosen && modes.includes(chosen) ? chosen : modes[0];
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  }, []);

  const { comparison } = change;
  const before = useMemo(
    () => statusPicture(change.base, comparison.nodeStatus, comparison.edgeStatus),
    [change.base, comparison],
  );
  const after = useMemo(
    () => statusPicture(change.head, comparison.nodeStatus, comparison.edgeStatus),
    [change.head, comparison],
  );
  // One frame for every picture, so a box sits in the same place in Before and After.
  const frame = useMemo(() => sharedViewBox(change.delta), [change.delta]);
  const inner = Math.max(0, width - 2);
  const columnWidth = wide ? Math.floor((inner - 12) / 2) : inner;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      testID="architecture-change"
    >
      <View style={styles.header}>
        <Text style={styles.title}>{t("panels.architectureMap.change.title")}</Text>
        <Text style={styles.subtitle} testID="architecture-change-map-title">
          {title}
        </Text>
        <Text style={styles.subtitle}>
          {baseLabel
            ? t("panels.architectureMap.change.comparedWith", { base: baseLabel })
            : t("panels.architectureMap.change.comparedWithStart")}
        </Text>
      </View>

      {change.staleness.outOfDate ? <StaleWarning change={change} /> : null}

      <Summary change={change} />

      <View style={styles.modes} accessibilityRole="tablist">
        {modes.map((item) => (
          <ModeButton key={item} mode={item} selected={item === mode} onChoose={setChosen} />
        ))}
      </View>

      <Legend />

      <View onLayout={onLayout} style={styles.canvasRow}>
        <Pictures
          mode={mode}
          before={before}
          after={after}
          delta={change.delta}
          frame={frame}
          width={columnWidth}
        />
      </View>

      <Details change={change} onOpenPullRequest={onOpenPullRequest} />
    </ScrollView>
  );
}

function Pictures(props: {
  mode: Mode;
  before: { nodes: StatusNode[]; edges: StatusEdge[] };
  after: { nodes: StatusNode[]; edges: StatusEdge[] };
  delta: ReadyChange["delta"];
  frame: ViewBox;
  width: number;
}) {
  const { t } = useTranslation();
  const { mode, before, after, delta, frame, width } = props;
  const noBefore = t("panels.architectureMap.change.noBefore");
  const noAfter = t("panels.architectureMap.change.noAfter");
  switch (mode) {
    case "side-by-side":
      return (
        <>
          <Picture
            heading={t("panels.architectureMap.change.modeBefore")}
            empty={noBefore}
            picture={before}
            frame={frame}
            width={width}
            testID="architecture-change-before"
          />
          <Picture
            heading={t("panels.architectureMap.change.modeAfter")}
            empty={noAfter}
            picture={after}
            frame={frame}
            width={width}
            testID="architecture-change-after"
          />
        </>
      );
    case "before":
      return (
        <Picture
          empty={noBefore}
          picture={before}
          frame={frame}
          width={width}
          testID="architecture-change-before"
        />
      );
    case "after":
      return (
        <Picture
          empty={noAfter}
          picture={after}
          frame={frame}
          width={width}
          testID="architecture-change-after"
        />
      );
    case "changes":
      return (
        <Picture
          empty={t("panels.architectureMap.change.summaryNoParts")}
          picture={delta}
          frame={frame}
          width={width}
          testID="architecture-change-delta"
        />
      );
  }
}

function sharedViewBox(delta: ReadyChange["delta"]): ViewBox {
  const nodesById = new Map(delta.nodes.map((node) => [node.id, node]));
  const geometries = delta.edges.flatMap((edge) => {
    const geometry = edgeGeometry(edge, nodesById);
    return geometry ? [geometry] : [];
  });
  if (delta.nodes.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  const model: ArchitectureMapModel = {
    title: "",
    subtitle: null,
    nodes: delta.nodes,
    edges: [],
    cards: [],
    boundaries: [],
    hiddenCharactersRemoved: false,
  };
  return computeViewBox(model, geometries);
}

function ModeButton(props: { mode: Mode; selected: boolean; onChoose: (mode: Mode) => void }) {
  const { t } = useTranslation();
  const { mode, selected, onChoose } = props;
  const onPress = useCallback(() => onChoose(mode), [mode, onChoose]);
  const label = {
    "side-by-side": t("panels.architectureMap.change.modeSideBySide"),
    changes: t("panels.architectureMap.change.modeChanges"),
    before: t("panels.architectureMap.change.modeBefore"),
    after: t("panels.architectureMap.change.modeAfter"),
  }[mode];
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={selected ? SELECTED_STATE : UNSELECTED_STATE}
      onPress={onPress}
      style={[styles.mode, selected && styles.modeSelected]}
      testID={`architecture-change-mode-${mode}`}
    >
      <Text style={[styles.modeText, selected && styles.modeTextSelected]}>{label}</Text>
    </Pressable>
  );
}

function Legend() {
  const { t } = useTranslation();
  const items: [DiffStatus, string][] = [
    ["added", t("panels.architectureMap.change.legendAdded")],
    ["removed", t("panels.architectureMap.change.legendRemoved")],
    ["changed", t("panels.architectureMap.change.legendChanged")],
    ["unchanged", t("panels.architectureMap.change.legendUnchanged")],
  ];
  return (
    <View style={styles.legend}>
      {items.map(([status, label]) => (
        <View key={status} style={styles.legendItem}>
          <View style={[styles.swatch, swatchStyles[status]]} />
          <Text style={styles.legendText}>{label}</Text>
        </View>
      ))}
    </View>
  );
}

function StaleWarning({ change }: { change: ReadyChange }) {
  const { t } = useTranslation();
  const { staleness } = change;
  return (
    <View style={styles.warning} testID="architecture-change-stale" accessibilityRole="alert">
      <Text style={styles.warningTitle}>{t("panels.architectureMap.change.staleTitle")}</Text>
      {staleness.citedChanged.length > 0 ? (
        <Text style={styles.warningText}>{t("panels.architectureMap.change.staleSources")}</Text>
      ) : (
        <Text style={styles.warningText}>
          {t("panels.architectureMap.change.staleFiles", { files: staleness.fileCount })}
        </Text>
      )}
      <Text style={styles.warningText}>{t("panels.architectureMap.change.staleAsk")}</Text>
    </View>
  );
}

function Summary({ change }: { change: ReadyChange }) {
  const { t } = useTranslation();
  const { comparison, files } = change;
  const parts = comparison.touched.length;
  let headline: string;
  if (!change.base && change.head) headline = t("panels.architectureMap.change.summaryNewMap");
  else if (change.base && !change.head)
    headline = t("panels.architectureMap.change.summaryDeletedMap");
  else if (parts > 0) headline = t("panels.architectureMap.change.summaryParts", { count: parts });
  else if (comparison.unchangedMap) headline = t("panels.architectureMap.change.summaryNoParts");
  else headline = t("panels.architectureMap.change.summaryRearranged");
  const unchecked = files.code - files.checked;
  return (
    <View style={styles.summary} testID="architecture-change-summary">
      <Text style={styles.summaryHeadline}>{headline}</Text>
      {comparison.reach.length > 0 ? (
        <Text style={styles.summaryText}>
          {t("panels.architectureMap.change.dependents", { count: comparison.reach.length })}
        </Text>
      ) : null}
      <Text style={styles.summaryText}>
        {t("panels.architectureMap.change.files", { count: files.changed })}
        {files.checked > 0
          ? ` ${t("panels.architectureMap.change.testsBeside", { withTests: files.withTests, checked: files.checked })}`
          : ""}
        {unchecked > 0 && files.checked > 0
          ? ` ${t("panels.architectureMap.change.testsNotChecked", { count: unchecked })}`
          : ""}
      </Text>
    </View>
  );
}

function Details(props: { change: ReadyChange; onOpenPullRequest: (() => void) | null }) {
  const { t } = useTranslation();
  const { change, onOpenPullRequest } = props;
  const { comparison } = change;
  const label = (id: string) =>
    change.head?.nodes.find((node) => node.id === id)?.label ??
    change.base?.nodes.find((node) => node.id === id)?.label ??
    id;
  const fieldName = (field: NodeField | EdgeField) =>
    t(`panels.architectureMap.change.field.${field}`);
  const touchedRows = comparison.touched.map((id) => {
    const status = comparison.nodeStatus.get(id) ?? "unchanged";
    const changed = comparison.components.changed.find((item) => item.id === id);
    const note = touchedNote(t, status, changed?.fields.map(fieldName) ?? null);
    return { id, status, name: label(id), note };
  });
  return (
    <View style={styles.details}>
      {touchedRows.length > 0 ? (
        <View style={styles.section} testID="architecture-change-touched">
          <Text style={styles.sectionTitle}>{t("panels.architectureMap.change.touchedTitle")}</Text>
          {touchedRows.map((row) => (
            <View key={row.id} style={styles.row}>
              <View style={[styles.swatch, swatchStyles[row.status]]} />
              <Text style={styles.rowName}>{row.name}</Text>
              <Text style={styles.rowNote}>{row.note}</Text>
            </View>
          ))}
        </View>
      ) : null}
      {comparison.reach.length > 0 ? (
        <View style={styles.section} testID="architecture-change-reach">
          <Text style={styles.sectionTitle}>{t("panels.architectureMap.change.dependsTitle")}</Text>
          <Text style={styles.rowNote}>{t("panels.architectureMap.change.dependsHint")}</Text>
          {comparison.reach.map((id) => (
            <Text key={id} style={styles.rowName}>
              {label(id)}
            </Text>
          ))}
        </View>
      ) : null}
      {comparison.suspectedRenames.map((pair) => (
        <Text
          key={`${pair.from}-${pair.to}`}
          style={styles.rowNote}
          testID="architecture-change-renamed"
        >
          {t("panels.architectureMap.change.renamed", {
            from: label(pair.from),
            to: label(pair.to),
          })}
        </Text>
      ))}
      {onOpenPullRequest && change.pullRequest ? (
        <Pressable
          accessibilityRole="button"
          onPress={onOpenPullRequest}
          style={styles.action}
          testID="architecture-change-open-pr"
        >
          <Text style={styles.actionText}>
            {t("panels.architectureMap.change.openPullRequest", {
              number: change.pullRequest.number,
            })}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// Why a touched part is listed: new, removed, which of its details changed, or only its connections.
function touchedNote(t: TFunction, status: DiffStatus, changedFields: string[] | null): string {
  if (status === "added") return t("panels.architectureMap.change.statusAdded");
  if (status === "removed") return t("panels.architectureMap.change.statusRemoved");
  if (changedFields) {
    return t("panels.architectureMap.change.statusChangedFields", {
      fields: changedFields.join(", "),
    });
  }
  return t("panels.architectureMap.change.statusConnections");
}

// The word on a coloured box, so colour is never the only signal.
function badgeFor(t: TFunction, status: DiffStatus): string | null {
  switch (status) {
    case "added":
      return t("panels.architectureMap.change.badgeAdded");
    case "removed":
      return t("panels.architectureMap.change.badgeRemoved");
    case "changed":
      return t("panels.architectureMap.change.badgeChanged");
    case "unchanged":
      return null;
  }
}

function Picture(props: {
  heading?: string;
  empty: string;
  picture: { nodes: StatusNode[]; edges: StatusEdge[] };
  frame: ViewBox;
  width: number;
  testID: string;
}) {
  const { heading, empty, picture, frame, width, testID } = props;
  const zoom = Math.max(
    heading ? OVERVIEW_MIN_ZOOM : SINGLE_MIN_ZOOM,
    Math.min(1, width / frame.width),
  );
  const nodesById = useMemo(
    () => new Map(picture.nodes.map((node) => [node.id, node])),
    [picture.nodes],
  );
  const drawLabels = shouldDrawLabels(picture.nodes.length, zoom);
  const scroller = useRef<ScrollView>(null);
  const focusX = useMemo(() => {
    const changed = picture.nodes.filter((node) => node.status !== "unchanged");
    if (changed.length === 0) return 0;
    const left = Math.min(...changed.map((node) => node.x));
    return Math.max(0, (left - frame.x) * zoom - FOCUS_MARGIN);
  }, [picture.nodes, frame.x, zoom]);
  useEffect(() => {
    if (!heading) scroller.current?.scrollTo({ x: focusX, animated: false });
  }, [focusX, heading]);
  return (
    <View style={[styles.picture, { width }]} testID={testID}>
      {heading ? <Text style={styles.pictureHeading}>{heading}</Text> : null}
      {picture.nodes.length === 0 ? (
        <Text style={styles.empty}>{empty}</Text>
      ) : (
        <ScrollView horizontal ref={scroller}>
          <Svg
            width={frame.width * zoom}
            height={frame.height * zoom}
            viewBox={`${frame.x} ${frame.y} ${frame.width} ${frame.height}`}
          >
            {picture.edges.map((edge) => (
              <ChangeEdge
                key={`${edge.status}-${edge.id}`}
                edge={edge}
                nodesById={nodesById}
                drawLabel={drawLabels}
              />
            ))}
            {picture.nodes.map((node) => (
              <ChangeNode key={`${node.status}-${node.id}`} node={node} drawLabels={drawLabels} />
            ))}
          </Svg>
        </ScrollView>
      )}
    </View>
  );
}

function ChangeEdge(props: {
  edge: StatusEdge;
  nodesById: ReadonlyMap<string, ArchitectureMapNode>;
  drawLabel: boolean;
}) {
  const { edge, nodesById, drawLabel } = props;
  const geometry = edgeGeometry(edge, nodesById);
  if (!geometry) return null;
  const points = geometry.arrow.map((point) => `${point.x},${point.y}`).join(" ");
  const quiet = edge.status === "unchanged";
  return (
    <G opacity={quiet ? 0.55 : 1} testID={`architecture-change-edge-${edge.status}`}>
      <ThemedLine
        x1={geometry.start.x}
        y1={geometry.start.y}
        x2={geometry.end.x}
        y2={geometry.end.y}
        uniProps={strokeProps.get(edge.status)}
        strokeWidth={quiet ? 1.5 : 2.25}
        strokeDasharray={edge.status === "removed" || edge.style === "dashed" ? "6 4" : undefined}
      />
      <ThemedPolygon points={points} uniProps={fillProps.get(edge.status)} />
      {drawLabel && edge.label ? (
        <ThemedSvgText
          x={geometry.labelAt.x}
          y={geometry.labelAt.y}
          fontSize={DETAIL_SIZE}
          uniProps={quiet ? mutedFill : fillProps.get(edge.status)}
          textAnchor="middle"
        >
          {edge.label}
        </ThemedSvgText>
      ) : null}
    </G>
  );
}

function ChangeNode(props: { node: StatusNode; drawLabels: boolean }) {
  const { t } = useTranslation();
  const { node, drawLabels } = props;
  const quiet = node.status === "unchanged";
  const badge = badgeFor(t, node.status);
  const textX = node.x + 10;
  const labelWidth = badge ? node.width - 56 : node.width;
  return (
    <G opacity={quiet ? 0.7 : 1} testID={`architecture-change-node-${node.status}`}>
      <ThemedRect
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        rx={8}
        uniProps={frameProps.get(node.status)}
        strokeWidth={quiet ? 1.5 : 2.5}
        strokeDasharray={node.status === "removed" ? "6 3" : undefined}
      />
      {badge ? (
        <ThemedSvgText
          x={node.x + node.width - 8}
          y={node.y + 15}
          fontSize={BADGE_SIZE}
          fontWeight="700"
          textAnchor="end"
          uniProps={fillProps.get(node.status)}
        >
          {badge}
        </ThemedSvgText>
      ) : null}
      {drawLabels ? (
        <>
          <ThemedSvgText
            x={textX}
            y={node.y + 20}
            fontSize={LABEL_SIZE}
            fontWeight="600"
            uniProps={foregroundFill}
          >
            {fitText(node.label, labelWidth, LABEL_SIZE)}
          </ThemedSvgText>
          {node.sublabel ? (
            <ThemedSvgText x={textX} y={node.y + 38} fontSize={DETAIL_SIZE} uniProps={mutedFill}>
              {fitText(node.sublabel, node.width, DETAIL_SIZE)}
            </ThemedSvgText>
          ) : null}
        </>
      ) : null}
    </G>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, backgroundColor: theme.colors.surface0 },
  content: { padding: theme.spacing[4], gap: theme.spacing[3] },
  header: { gap: theme.spacing[1] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  subtitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  warning: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.statusWarning,
    backgroundColor: theme.colors.surface1,
  },
  warningTitle: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  warningText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  summary: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  summaryHeadline: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  summaryText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  modes: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  mode: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  modeSelected: { backgroundColor: theme.colors.surface2, borderColor: theme.colors.borderAccent },
  modeText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  modeTextSelected: { color: theme.colors.foreground, fontWeight: theme.fontWeight.semibold },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[3] },
  legendItem: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  legendText: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  canvasRow: { flexDirection: "row", flexWrap: "wrap", gap: 12 },
  picture: {
    gap: theme.spacing[1],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
    paddingVertical: theme.spacing[2],
  },
  pictureHeading: {
    paddingHorizontal: theme.spacing[3],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  empty: {
    padding: theme.spacing[4],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  details: { gap: theme.spacing[3] },
  section: { gap: theme.spacing[1] },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  row: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.spacing[2] },
  rowName: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  rowNote: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  action: {
    alignSelf: "flex-start",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  actionText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));

const swatchStyles = StyleSheet.create((theme) => ({
  added: { backgroundColor: statusColor(theme, "added") },
  removed: { backgroundColor: statusColor(theme, "removed") },
  changed: { backgroundColor: statusColor(theme, "changed") },
  unchanged: { backgroundColor: statusColor(theme, "unchanged") },
}));
