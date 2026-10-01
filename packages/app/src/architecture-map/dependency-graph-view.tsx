import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { G, Line, Polygon, Rect, Text as SvgText } from "react-native-svg";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ArchitectureGraph } from "@getpaseo/protocol/messages";
import { SearchField } from "@/components/ui/search-field";
import type { Theme } from "@/styles/theme";
import {
  drawnEdges,
  expandPackage,
  facets,
  isPackageNode,
  matchesQuery,
  nearestOnly,
  nodeRole,
  PACKAGE_PREFIX,
  packageOverview,
  selectModule,
  visibleNodes,
  type GraphEdge,
  type GraphNode,
  type NodeRole,
  type Selection,
} from "./dependency-graph-model";
import { fitText } from "./layout";

// The Code Dependency Map: the whole repository as modules and the imports between them. Select a module to
// light up what it uses and what uses it; filter by package or kind, search by name, zoom and pan. Same safety
// rules as the other architecture views: every string from the graph is a text child, never an attribute.

const K = "panels.architectureMap.graph";
const MARGIN = 30;
const LABEL_SIZE = 13;
const DETAIL_SIZE = 10.5;
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 2;
const CANVAS_HEIGHT = 560;
const SELECTED_STATE = { selected: true } as const;
const UNSELECTED_STATE = { selected: false } as const;
const KIND_KEYS = new Set([
  "frontend",
  "backend",
  "messagebus",
  "security",
  "database",
  "service",
  "external",
]);

interface GraphPalette {
  role: Record<NodeRole, string>;
  surface: string;
  foreground: string;
  muted: string;
}
const paletteProps = (theme: Theme) => ({
  palette: {
    role: {
      selected: theme.colors.foreground,
      dependency: theme.colors.statusMerged,
      dependent: theme.colors.statusWarning,
      match: theme.colors.accent,
      edited: theme.colors.statusSuccess,
      normal: theme.colors.foregroundMuted,
      dimmed: theme.colors.foregroundMuted,
    },
    surface: theme.colors.surface1,
    foreground: theme.colors.foreground,
    muted: theme.colors.foregroundMuted,
  } satisfies GraphPalette,
});
const FALLBACK_PALETTE: GraphPalette = {
  role: {
    selected: "#e8eaea",
    dependency: "#b392f0",
    dependent: "#c99a5b",
    match: "#8ab4f8",
    edited: "#6cb17b",
    normal: "#a1a5a4",
    dimmed: "#a1a5a4",
  },
  surface: "#1e2120",
  foreground: "#e8eaea",
  muted: "#a1a5a4",
};

export interface DependencyGraphViewProps {
  graph: ArchitectureGraph;
  /** Where the graph was drawn: the default branch's name, or the pull request. */
  refLabel: string;
  pullRequest: { number: number; title: string } | null;
  onClearPullRequest: (() => void) | null;
  /** Width to draw at before the first layout (tests and screenshots). */
  initialWidth?: number;
}

function toggled(set: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

export function DependencyGraphView(props: DependencyGraphViewProps) {
  const { t } = useTranslation();
  const { graph } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hiddenKinds, setHiddenKinds] = useState<ReadonlySet<string>>(new Set());
  const [hiddenGroups, setHiddenGroups] = useState<ReadonlySet<string>>(new Set());
  const [zoomFactor, setZoomFactor] = useState(1);
  // The level shown: every package (default), or one package opened into its modules.
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [allLevels, setAllLevels] = useState(false);
  const shown = useMemo(
    () => (openGroup === null ? packageOverview(graph) : expandPackage(graph, openGroup)),
    [graph, openGroup],
  );
  const [width, setWidth] = useState(props.initialWidth ?? 0);
  const onLayout = useCallback((e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width), []);

  const visible = useMemo(
    () => visibleNodes(shown, { query, hiddenKinds, hiddenGroups }),
    [shown, query, hiddenKinds, hiddenGroups],
  );
  const visibleIds = useMemo(() => new Set(visible.map((node) => node.id)), [visible]);
  const selection = useMemo(
    () => (selectedId && visibleIds.has(selectedId) ? selectModule(shown, selectedId) : null),
    [shown, selectedId, visibleIds],
  );
  // What lights up: the direct neighbours, or every level when asked.
  const lit = useMemo(
    () => (selection && !allLevels ? nearestOnly(selection) : selection),
    [selection, allLevels],
  );
  const highlighted = useMemo(() => new Set(shown.highlighted), [shown.highlighted]);
  const edges = useMemo(
    () => drawnEdges({ edges: shown.edges, visible: visibleIds, selection: lit }),
    [shown.edges, visibleIds, lit],
  );
  const matches = useMemo(
    () => (query.trim() ? visible.filter((node) => matchesQuery(node, query)) : []),
    [visible, query],
  );
  const frame = useMemo(() => frameOf(visible), [visible]);
  const fit = width > 0 ? Math.min(1, Math.max(MIN_ZOOM, (width - 2) / frame.width)) : 0.5;
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fit * zoomFactor));

  // A package opens into its modules; a module is selected (again to clear).
  const select = useCallback((id: string) => {
    if (isPackageNode(id)) {
      setOpenGroup(id.slice(PACKAGE_PREFIX.length));
      setSelectedId(null);
      setZoomFactor(1);
      return;
    }
    setSelectedId((cur) => (cur === id ? null : id));
  }, []);
  const backToOverview = useCallback(() => {
    setOpenGroup(null);
    setSelectedId(null);
    setZoomFactor(1);
  }, []);
  const toggleLevels = useCallback(() => setAllLevels((v) => !v), []);
  const clearSelection = useCallback(() => setSelectedId(null), []);
  const zoomIn = useCallback(() => setZoomFactor((z) => z * 1.25), []);
  const zoomOut = useCallback(() => setZoomFactor((z) => z / 1.25), []);
  const zoomFit = useCallback(() => setZoomFactor(1), []);
  const toggleKind = useCallback((kind: string) => setHiddenKinds((s) => toggled(s, kind)), []);
  const toggleGroup = useCallback((group: string) => setHiddenGroups((s) => toggled(s, group)), []);
  const { groups, kinds } = useMemo(() => facets(graph), [graph]);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      testID="dependency-graph"
    >
      <View style={styles.header}>
        <Text style={styles.title}>{t(`${K}.title`)}</Text>
        <Text style={styles.subtitle}>
          {t(`${K}.subtitle`, {
            modules: graph.nodes.length,
            connections: graph.edges.length,
            ref: props.refLabel,
            commit: graph.commit.slice(0, 9),
          })}
        </Text>
      </View>
      {props.pullRequest ? (
        <PullRequestBanner
          number={props.pullRequest.number}
          parts={graph.highlighted.length}
          files={graph.changedFiles}
          onClear={props.onClearPullRequest}
        />
      ) : null}
      <View style={styles.toolbar}>
        <View style={styles.search}>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder={t(`${K}.searchPlaceholder`)}
            clearAccessibilityLabel={t("sessions.actions.clearSearch")}
            testID="dependency-graph-search"
          />
        </View>
        {query.trim() ? (
          <Text style={styles.muted}>{t(`${K}.matches`, { count: matches.length })}</Text>
        ) : null}
        <ToolButton label="−" hint={t(`${K}.zoomOut`)} onPress={zoomOut} />
        <ToolButton label="+" hint={t(`${K}.zoomIn`)} onPress={zoomIn} />
        <ToolButton label={t(`${K}.fit`)} hint={t(`${K}.fit`)} onPress={zoomFit} />
      </View>
      <ChipRow title={t(`${K}.filterKinds`)}>
        {kinds.map((kind) => (
          <FilterChip
            key={kind}
            value={kind}
            label={KIND_KEYS.has(kind) ? t(`${K}.kind.${kind}`) : kind}
            on={!hiddenKinds.has(kind)}
            onToggle={toggleKind}
          />
        ))}
      </ChipRow>
      <ChipRow title={t(`${K}.filterGroups`)}>
        {groups.map((group) => (
          <FilterChip
            key={group}
            value={group}
            label={group}
            on={!hiddenGroups.has(group)}
            onToggle={toggleGroup}
          />
        ))}
      </ChipRow>
      <Breadcrumb group={openGroup} onBack={backToOverview} />
      <Legend withEdited={highlighted.size > 0} />
      <View style={styles.canvas} onLayout={onLayout} testID="dependency-graph-canvas">
        <ScrollView style={styles.canvasScroll}>
          <ScrollView horizontal>
            <ThemedGraphCanvas
              uniProps={paletteProps}
              nodes={visible}
              edges={edges}
              frame={frame}
              zoom={zoom}
              selection={lit}
              query={query}
              highlighted={highlighted}
              showCounts={openGroup === null}
              onSelect={select}
            />
          </ScrollView>
        </ScrollView>
      </View>
      {selection ? (
        <SelectionCard
          graph={shown}
          selection={selection}
          allLevels={allLevels}
          onToggleLevels={toggleLevels}
          onSelect={select}
          onClear={clearSelection}
        />
      ) : (
        <Text style={styles.muted}>
          {t(openGroup === null ? `${K}.packageHint` : `${K}.selectHint`)}
        </Text>
      )}
    </ScrollView>
  );
}

function frameOf(nodes: readonly GraphNode[]): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  if (nodes.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  const minX = Math.min(...nodes.map((n) => n.x)) - MARGIN;
  const minY = Math.min(...nodes.map((n) => n.y)) - MARGIN;
  const maxX = Math.max(...nodes.map((n) => n.x + n.width)) + MARGIN;
  const maxY = Math.max(...nodes.map((n) => n.y + n.height)) + MARGIN;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function PullRequestBanner(props: {
  number: number;
  parts: number;
  files: number;
  onClear: (() => void) | null;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.banner} testID="dependency-graph-pull-request">
      <Text style={styles.bannerText}>
        {t(`${K}.prBanner`, { number: props.number, parts: props.parts, files: props.files })}
      </Text>
      {props.onClear ? (
        <Pressable accessibilityRole="button" onPress={props.onClear} style={styles.button}>
          <Text style={styles.buttonText}>{t(`${K}.prClear`)}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Breadcrumb(props: { group: string | null; onBack: () => void }) {
  const { t } = useTranslation();
  if (props.group === null) {
    return <Text style={styles.crumbCurrent}>{t(`${K}.breadcrumbAll`)}</Text>;
  }
  return (
    <View style={styles.crumbs} testID="dependency-graph-breadcrumb">
      <Pressable accessibilityRole="button" onPress={props.onBack}>
        <Text style={styles.crumbLink}>{t(`${K}.breadcrumbAll`)}</Text>
      </Pressable>
      <Text style={styles.muted}>›</Text>
      <Text style={styles.crumbCurrent}>{props.group}</Text>
    </View>
  );
}

function ToolButton(props: { label: string; hint: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.hint}
      onPress={props.onPress}
      style={styles.button}
    >
      <Text style={styles.buttonText}>{props.label}</Text>
    </Pressable>
  );
}

function ChipRow(props: { title: string; children: ReactNode }) {
  return (
    <ScrollView horizontal contentContainerStyle={styles.chipRow}>
      <Text style={styles.chipTitle}>{props.title}</Text>
      {props.children}
    </ScrollView>
  );
}

function FilterChip(props: {
  value: string;
  label: string;
  on: boolean;
  onToggle: (value: string) => void;
}) {
  const { value, onToggle } = props;
  const onPress = useCallback(() => onToggle(value), [value, onToggle]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={props.on ? SELECTED_STATE : UNSELECTED_STATE}
      onPress={onPress}
      style={[styles.chip, props.on && styles.chipOn]}
      testID="dependency-graph-filter"
    >
      <Text style={props.on ? styles.chipText : styles.chipTextOff}>{props.label}</Text>
    </Pressable>
  );
}

function Legend(props: { withEdited: boolean }) {
  const { t } = useTranslation();
  return (
    <View style={styles.legend}>
      <LegendItem swatch={styles.swatchSelected} label={t(`${K}.legendSelected`)} />
      <LegendItem swatch={styles.swatchUses} label={t(`${K}.legendUses`)} />
      <LegendItem swatch={styles.swatchUsedBy} label={t(`${K}.legendUsedBy`)} />
      {props.withEdited ? (
        <LegendItem swatch={styles.swatchEdited} label={t(`${K}.legendEdited`)} />
      ) : null}
    </View>
  );
}

function LegendItem(props: { swatch: object; label: string }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.swatch, props.swatch]} />
      <Text style={styles.muted}>{props.label}</Text>
    </View>
  );
}

function GraphCanvas(props: {
  palette?: GraphPalette;
  nodes: readonly GraphNode[];
  edges: readonly { edge: GraphEdge; lit: boolean }[];
  frame: { x: number; y: number; width: number; height: number };
  zoom: number;
  selection: Selection | null;
  query: string;
  highlighted: ReadonlySet<string>;
  showCounts: boolean;
  onSelect: (id: string) => void;
}) {
  const palette = props.palette ?? FALLBACK_PALETTE;
  const { frame, zoom, selection, query, highlighted } = props;
  const byId = useMemo(() => new Map(props.nodes.map((node) => [node.id, node])), [props.nodes]);
  return (
    <Svg
      width={frame.width * zoom}
      height={frame.height * zoom}
      viewBox={`${frame.x} ${frame.y} ${frame.width} ${frame.height}`}
    >
      {props.edges.map(({ edge, lit }) => (
        <GraphEdgeLine
          key={`${edge.from}>${edge.to}`}
          edge={edge}
          lit={lit}
          byId={byId}
          palette={palette}
          selection={selection}
          showCount={props.showCounts}
        />
      ))}
      {props.nodes.map((node) => (
        <GraphNodeBox
          key={node.id}
          node={node}
          role={nodeRole({ node, selection, query, highlighted })}
          palette={palette}
          onSelect={props.onSelect}
        />
      ))}
    </Svg>
  );
}
const ThemedGraphCanvas = withUnistyles(GraphCanvas);

function edgeColor(edge: GraphEdge, selection: Selection | null, palette: GraphPalette): string {
  if (!selection) return palette.muted;
  const toSelection = edge.to === selection.id || selection.usedByAll.has(edge.to);
  return toSelection ? palette.role.dependent : palette.role.dependency;
}

function GraphEdgeLine(props: {
  edge: GraphEdge;
  lit: boolean;
  byId: ReadonlyMap<string, GraphNode>;
  palette: GraphPalette;
  selection: Selection | null;
  showCount: boolean;
}) {
  const { edge, lit, byId, palette, selection } = props;
  const from = byId.get(edge.from);
  const to = byId.get(edge.to);
  if (!from || !to) return null;
  const start = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const end = anchorToward(to, start);
  const color = lit ? edgeColor(edge, selection, palette) : palette.muted;
  return (
    <G opacity={lit ? 0.95 : 0.22}>
      <Line
        x1={start.x}
        y1={start.y}
        x2={end.x}
        y2={end.y}
        stroke={color}
        strokeWidth={lit ? 2 : 1}
      />
      <Polygon points={arrow(start, end)} fill={color} />
      {props.showCount ? (
        <SvgText
          x={(start.x + end.x) / 2}
          y={(start.y + end.y) / 2 - 4}
          fontSize={DETAIL_SIZE}
          fill={palette.foreground}
          textAnchor="middle"
        >
          {String(edge.imports)}
        </SvgText>
      ) : null}
    </G>
  );
}

/** Where a line from `from` meets the edge of `node`'s box. */
function anchorToward(node: GraphNode, from: { x: number; y: number }) {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  const dx = from.x - cx;
  const dy = from.y - cy;
  const scale = Math.min(
    dx === 0 ? Infinity : node.width / 2 / Math.abs(dx),
    dy === 0 ? Infinity : node.height / 2 / Math.abs(dy),
  );
  if (!Number.isFinite(scale)) return { x: cx, y: cy };
  return { x: cx + dx * scale, y: cy + dy * scale };
}

function arrow(start: { x: number; y: number }, end: { x: number; y: number }): string {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const bx = end.x - ux * 8;
  const by = end.y - uy * 8;
  return `${end.x},${end.y} ${bx - uy * 4},${by + ux * 4} ${bx + uy * 4},${by - ux * 4}`;
}

function GraphNodeBox(props: {
  node: GraphNode;
  role: NodeRole;
  palette: GraphPalette;
  onSelect: (id: string) => void;
}) {
  const { node, role, palette, onSelect } = props;
  const onPress = useCallback(() => onSelect(node.id), [node.id, onSelect]);
  const color = palette.role[role];
  const strong = role !== "normal" && role !== "dimmed";
  return (
    <G opacity={role === "dimmed" ? 0.3 : 1} testID={`dependency-graph-node-${role}`}>
      <Rect
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        rx={8}
        fill={palette.surface}
        stroke={color}
        strokeWidth={strong ? 2.5 : 1.25}
        onPress={onPress}
      />
      <SvgText
        x={node.x + 10}
        y={node.y + 21}
        fontSize={LABEL_SIZE}
        fontWeight="600"
        fill={palette.foreground}
        onPress={onPress}
      >
        {fitText(node.label, node.width, LABEL_SIZE)}
      </SvgText>
      <SvgText x={node.x + 10} y={node.y + 40} fontSize={DETAIL_SIZE} fill={palette.muted}>
        {fitText(`${node.code} code · ${node.tests} tests`, node.width, DETAIL_SIZE)}
      </SvgText>
    </G>
  );
}

function SelectionCard(props: {
  graph: ArchitectureGraph;
  selection: Selection;
  allLevels: boolean;
  onToggleLevels: () => void;
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const { graph, selection } = props;
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const node = byId.get(selection.id);
  if (!node) return null;
  return (
    <View style={styles.card} testID="dependency-graph-selection">
      <View style={styles.cardHead}>
        <View style={styles.cardTitleBox}>
          <Text style={styles.cardTitle}>{node.label}</Text>
          <Text style={styles.muted}>{node.folder || "."}</Text>
          <Text style={styles.muted}>
            {t(`${K}.moduleFacts`, { files: node.files, code: node.code, tests: node.tests })}
          </Text>
        </View>
        <View style={styles.cardActions}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={props.allLevels ? SELECTED_STATE : UNSELECTED_STATE}
            onPress={props.onToggleLevels}
            style={[styles.chip, props.allLevels && styles.chipOn]}
            testID="dependency-graph-all-levels"
          >
            <Text style={styles.chipText}>{t(`${K}.allLevels`)}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" onPress={props.onClear} style={styles.button}>
            <Text style={styles.buttonText}>{t(`${K}.clear`)}</Text>
          </Pressable>
        </View>
      </View>
      <View style={styles.stats}>
        <Stat
          value={`${selection.usesDirect.length} · ${selection.usesAll.size}`}
          label={t(`${K}.statUses`)}
          tone={styles.usesText}
        />
        <Stat
          value={`${selection.usedByDirect.length} · ${selection.usedByAll.size}`}
          label={t(`${K}.statUsedBy`)}
          tone={styles.usedByText}
        />
        <Stat value={String(selection.dependentFiles)} label={t(`${K}.statFiles`)} tone={null} />
      </View>
      <View style={styles.columns}>
        <ModuleList
          title={t(`${K}.usesTitle`)}
          ids={selection.usesDirect}
          byId={byId}
          onSelect={props.onSelect}
        />
        <ModuleList
          title={t(`${K}.usedByTitle`)}
          ids={selection.usedByDirect}
          byId={byId}
          onSelect={props.onSelect}
        />
      </View>
    </View>
  );
}

function Stat(props: { value: string; label: string; tone: object | null }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, props.tone]}>{props.value}</Text>
      <Text style={styles.muted}>{props.label}</Text>
    </View>
  );
}

function ModuleList(props: {
  title: string;
  ids: readonly string[];
  byId: ReadonlyMap<string, GraphNode>;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.column}>
      <Text style={styles.sectionTitle}>{props.title}</Text>
      {props.ids.length === 0 ? <Text style={styles.muted}>{t(`${K}.none`)}</Text> : null}
      {props.ids.map((id) => (
        <ModuleLink
          key={id}
          id={id}
          label={props.byId.get(id)?.label ?? id}
          onSelect={props.onSelect}
        />
      ))}
    </View>
  );
}

function ModuleLink(props: { id: string; label: string; onSelect: (id: string) => void }) {
  const { id, onSelect } = props;
  const onPress = useCallback(() => onSelect(id), [id, onSelect]);
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.row}>
      <Text style={styles.rowText} numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
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
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  banner: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.statusSuccess,
    backgroundColor: theme.colors.surface1,
  },
  bannerText: { flexShrink: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  toolbar: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[2] },
  search: { flexGrow: 1, minWidth: 180 },
  button: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  buttonText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  chipRow: { alignItems: "center", gap: theme.spacing[1.5] },
  chipTitle: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  chip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  chipOn: { backgroundColor: theme.colors.surface2, borderColor: theme.colors.borderAccent },
  chipText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  chipTextOff: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textDecorationLine: "line-through",
  },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[3] },
  legendItem: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  swatch: { width: 10, height: 10, borderRadius: 3 },
  swatchSelected: { backgroundColor: theme.colors.foreground },
  swatchUses: { backgroundColor: theme.colors.statusMerged },
  swatchUsedBy: { backgroundColor: theme.colors.statusWarning },
  swatchEdited: { backgroundColor: theme.colors.statusSuccess },
  canvas: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  canvasScroll: { maxHeight: CANVAS_HEIGHT },
  card: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  cardActions: { flexDirection: "row", alignItems: "flex-start", gap: theme.spacing[2] },
  crumbs: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  crumbLink: { color: theme.colors.accent, fontSize: theme.fontSize.sm },
  crumbCurrent: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  cardHead: { flexDirection: "row", justifyContent: "space-between", gap: theme.spacing[2] },
  cardTitleBox: { flexShrink: 1, gap: theme.spacing[0.5] },
  cardTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  stat: {
    minWidth: 140,
    flexGrow: 1,
    gap: theme.spacing[0.5],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
  },
  statValue: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  usesText: { color: theme.colors.statusMerged },
  usedByText: { color: theme.colors.statusWarning },
  columns: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[3] },
  column: { flexGrow: 1, flexBasis: 240, gap: theme.spacing[0.5] },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  row: {
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  rowText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));
