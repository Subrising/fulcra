import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { G, Line, Polygon, Rect, Text as SvgText } from "react-native-svg";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ArchitectureGraph } from "@getpaseo/protocol/messages";
import { SearchField } from "@/components/ui/search-field";
import { useHostFeatureAvailability } from "@/runtime/host-features";
import type { Theme } from "@/styles/theme";
import {
  callersOnly,
  drawnEdges,
  expandInPlace,
  facets,
  isPackageNode,
  nearestOnly,
  nodeRole,
  PACKAGE_PREFIX,
  packageOverview,
  searchModules,
  selectModule,
  visibleNodes,
  type GraphEdge,
  type GroupFrame,
  type GraphNode,
  type NodeRole,
  type Selection,
} from "./dependency-graph-model";
import { fitText } from "./layout";
import { useReviewExplanation } from "./use-generated-change";

// The Code Dependency Map: the whole repository as modules and the imports between them. Select a module to
// light up what it uses and what uses it; filter by package or kind, search by name, zoom and pan. Each box says in
// one line what its kind of part is for; the side panel adds a model-written "What it does", fetched only when a
// part is opened and cached on the host. Parts the pull request changes get an amber outline that stays through
// selection. A package opens in place inside a frame; search lists matching parts and jumps to one. Same safety rules as the other architecture views: every string from the graph is a text child,
// never an attribute.

const K = "panels.architectureMap.graph";
const P = `${K}.panel`;
const PLAIN = "panels.architectureMap.review.plain";
const SHOWN_FILES = 12;
const SHA40 = /^[0-9a-f]{40}$/;
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
  changed: string;
  surface: string;
  foreground: string;
  muted: string;
}
const paletteProps = (theme: Theme) => ({
  palette: {
    role: {
      selected: theme.colors.foreground,
      dependency: theme.colors.statusMerged,
      dependent: theme.colors.accent,
      match: theme.colors.accent,
      edited: theme.colors.statusWarning,
      normal: theme.colors.foregroundMuted,
      dimmed: theme.colors.foregroundMuted,
    },
    changed: theme.colors.statusWarning,
    surface: theme.colors.surface1,
    foreground: theme.colors.foreground,
    muted: theme.colors.foregroundMuted,
  } satisfies GraphPalette,
});
const FALLBACK_PALETTE: GraphPalette = {
  role: {
    selected: "#e8eaea",
    dependency: "#b392f0",
    dependent: "#8ab4f8",
    match: "#8ab4f8",
    edited: "#c09664",
    normal: "#a1a5a4",
    dimmed: "#a1a5a4",
  },
  changed: "#c09664",
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
  /** The host and folder the map was drawn for: the side panel's "What it does" asks that host. */
  serverId?: string;
  cwd?: string | null;
  /** Opens a repository-relative file in a tab ("Open code"). */
  onOpenFile?: (path: string) => void;
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
  // Every package (default), with at most one opened in place into its modules.
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [allLevels, setAllLevels] = useState(false);
  const [callers, setCallers] = useState(false);
  const opened = useMemo(
    () =>
      openGroup === null
        ? { graph: packageOverview(graph), frame: null }
        : expandInPlace(graph, openGroup),
    [graph, openGroup],
  );
  const shown = opened.graph;
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
  // What lights up: the direct neighbours, every level when asked, or only what calls the selection.
  const lit = useMemo(() => {
    if (!selection) return null;
    if (callers) return callersOnly(selection);
    return allLevels ? selection : nearestOnly(selection);
  }, [selection, allLevels, callers]);
  const highlighted = useMemo(() => new Set(shown.highlighted), [shown.highlighted]);
  const edges = useMemo(
    () => drawnEdges({ edges: shown.edges, visible: visibleIds, selection: lit }),
    [shown.edges, visibleIds, lit],
  );
  const frame = useMemo(() => frameOf(visible, opened.frame), [visible, opened.frame]);
  const fit = width > 0 ? Math.min(1, Math.max(MIN_ZOOM, (width - 2) / frame.width)) : 0.5;
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, fit * zoomFactor));

  // A package opens in place (closing any other); a module is selected (again to clear).
  const select = useCallback((id: string) => {
    if (isPackageNode(id)) {
      setOpenGroup(id.slice(PACKAGE_PREFIX.length));
      setSelectedId(null);
      return;
    }
    setCallers(false);
    setSelectedId((cur) => (cur === id ? null : id));
  }, []);
  const backToOverview = useCallback(() => {
    setOpenGroup(null);
    setSelectedId(null);
    setZoomFactor(1);
  }, []);
  const toggleLevels = useCallback(() => setAllLevels((v) => !v), []);
  const toggleCallers = useCallback(() => setCallers((v) => !v), []);
  const { serverId, cwd } = props;
  const summarySource = useMemo(
    () =>
      serverId && cwd && SHA40.test(graph.commit) ? { serverId, cwd, commit: graph.commit } : null,
    [serverId, cwd, graph.commit],
  );
  const doesOf = useCallback(
    (node: GraphNode) => (KIND_KEYS.has(node.kind) ? t(`${K}.does.${node.kind}`) : node.kind),
    [t],
  );
  const sizeOf = useCallback(
    (node: GraphNode) =>
      t(`${K}.moduleFacts`, { files: node.files, code: node.code, tests: node.tests }),
    [t],
  );
  // Plain verbs on the lines: "uses · 12" when a package is at either end, "uses" on a lit line between modules.
  const edgeLabel = useCallback(
    (edge: GraphEdge, isLit: boolean) => {
      if (isPackageNode(edge.from) || isPackageNode(edge.to))
        return t(`${P}.edgeUses`, { count: edge.imports });
      return isLit ? t(`${P}.edgeVerb`) : null;
    },
    [t],
  );
  // Search jumps: open the part's package, make it visible, select it, then scroll it into view.
  const results = useMemo(() => searchModules(graph, query), [graph, query]);
  const [jumpTo, setJumpTo] = useState<string | null>(null);
  // The search box keeps its own text, so after a jump the list hides until the text changes.
  const [pickedFor, setPickedFor] = useState<string | null>(null);
  const jump = useCallback(
    (node: GraphNode) => {
      setHiddenGroups((s) => (s.has(node.group) ? toggled(s, node.group) : s));
      setHiddenKinds((s) => (s.has(node.kind) ? toggled(s, node.kind) : s));
      setOpenGroup(node.group);
      setCallers(false);
      setSelectedId(node.id);
      setPickedFor(query);
      setJumpTo(node.id);
    },
    [query],
  );
  const vertical = useRef<ScrollView | null>(null);
  const horizontal = useRef<ScrollView | null>(null);
  useEffect(() => {
    if (!jumpTo) return;
    const node = visible.find((n) => n.id === jumpTo);
    if (!node) return;
    vertical.current?.scrollTo({ y: Math.max(0, (node.y - frame.y) * zoom - 40), animated: true });
    horizontal.current?.scrollTo({
      x: Math.max(0, (node.x - frame.x) * zoom - 40),
      animated: true,
    });
    setJumpTo(null);
  }, [jumpTo, visible, frame, zoom]);
  const closeGroup = backToOverview;
  const selectedLabel = selection
    ? (shown.nodes.find((n) => n.id === selection.id)?.label ?? null)
    : null;
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
          <Text style={styles.muted}>{t(`${K}.matches`, { count: results.length })}</Text>
        ) : null}
        <ToolButton label="−" hint={t(`${K}.zoomOut`)} onPress={zoomOut} />
        <ToolButton label="+" hint={t(`${K}.zoomIn`)} onPress={zoomIn} />
        <ToolButton label={t(`${K}.fit`)} hint={t(`${K}.fit`)} onPress={zoomFit} />
      </View>
      {query.trim() && query !== pickedFor ? (
        <SearchResults results={results} onJump={jump} />
      ) : null}
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
      <Breadcrumb group={openGroup} part={selectedLabel} onBack={backToOverview} />
      <Legend withEdited={highlighted.size > 0} />
      <View style={styles.canvas} onLayout={onLayout} testID="dependency-graph-canvas">
        <ScrollView ref={vertical} style={styles.canvasScroll}>
          <ScrollView ref={horizontal} horizontal>
            <ThemedGraphCanvas
              uniProps={paletteProps}
              nodes={visible}
              edges={edges}
              frame={frame}
              group={opened.frame}
              closeGroupLabel={t(`${P}.closeGroup`)}
              onCloseGroup={closeGroup}
              zoom={zoom}
              selection={lit}
              query={query}
              highlighted={highlighted}
              doesOf={doesOf}
              sizeOf={sizeOf}
              edgeLabel={edgeLabel}
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
          callers={callers}
          onToggleCallers={toggleCallers}
          does={doesOf}
          changed={highlighted.has(selection.id)}
          summary={summarySource}
          onOpenFile={props.onOpenFile ?? null}
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

function frameOf(
  nodes: readonly GraphNode[],
  group: GroupFrame | null,
): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const boxes = group ? [...nodes, group] : nodes;
  if (boxes.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  const minX = Math.min(...boxes.map((n) => n.x)) - MARGIN;
  const minY = Math.min(...boxes.map((n) => n.y)) - MARGIN;
  const maxX = Math.max(...boxes.map((n) => n.x + n.width)) + MARGIN;
  const maxY = Math.max(...boxes.map((n) => n.y + n.height)) + MARGIN;
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

/** The path to what is shown: All packages › the open package › the selected part. */
function Breadcrumb(props: { group: string | null; part: string | null; onBack: () => void }) {
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
      <Text style={props.part ? styles.muted : styles.crumbCurrent}>{props.group}</Text>
      {props.part ? (
        <>
          <Text style={styles.muted}>›</Text>
          <Text style={styles.crumbCurrent}>{props.part}</Text>
        </>
      ) : null}
    </View>
  );
}

function SearchResults(props: {
  results: readonly GraphNode[];
  onJump: (node: GraphNode) => void;
}) {
  const { t } = useTranslation();
  if (props.results.length === 0)
    return <Text style={styles.muted}>{t(`${K}.panel.noResults`)}</Text>;
  return (
    <View style={styles.results} testID="dependency-graph-results">
      {props.results.map((node) => (
        <SearchResult key={node.id} node={node} onJump={props.onJump} />
      ))}
    </View>
  );
}

function SearchResult(props: { node: GraphNode; onJump: (node: GraphNode) => void }) {
  const { node, onJump } = props;
  const onPress = useCallback(() => onJump(node), [node, onJump]);
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.row}>
      <Text style={styles.rowText} numberOfLines={1}>
        {node.label}
      </Text>
      <Text style={styles.muted} numberOfLines={1}>
        {node.folder || node.group}
      </Text>
    </Pressable>
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
  /** The package opened in place, drawn as a frame behind its modules. */
  group: GroupFrame | null;
  closeGroupLabel: string;
  onCloseGroup: () => void;
  zoom: number;
  selection: Selection | null;
  query: string;
  highlighted: ReadonlySet<string>;
  doesOf: (node: GraphNode) => string;
  sizeOf: (node: GraphNode) => string;
  edgeLabel: (edge: GraphEdge, lit: boolean) => string | null;
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
      {props.group ? (
        <GroupFrameBox
          frame={props.group}
          palette={palette}
          closeLabel={props.closeGroupLabel}
          onClose={props.onCloseGroup}
        />
      ) : null}
      {props.edges.map(({ edge, lit }) => (
        <GraphEdgeLine
          key={`${edge.from}>${edge.to}`}
          edge={edge}
          lit={lit}
          byId={byId}
          palette={palette}
          selection={selection}
          label={props.edgeLabel(edge, lit)}
        />
      ))}
      {props.nodes.map((node) => (
        <GraphNodeBox
          key={node.id}
          node={node}
          role={nodeRole({ node, selection, query, highlighted })}
          changed={highlighted.has(node.id)}
          does={props.doesOf(node)}
          size={props.sizeOf(node)}
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
  label: string | null;
}) {
  const { edge, lit, byId, palette, selection } = props;
  const from = byId.get(edge.from);
  const to = byId.get(edge.to);
  if (!from || !to) return null;
  // Edge to edge, so the verb at the middle sits in the gap between the boxes rather than under one.
  const start = anchorToward(from, { x: to.x + to.width / 2, y: to.y + to.height / 2 });
  const end = anchorToward(to, { x: from.x + from.width / 2, y: from.y + from.height / 2 });
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
      {props.label ? (
        <SvgText
          x={(start.x + end.x) / 2}
          y={(start.y + end.y) / 2 - 4}
          fontSize={DETAIL_SIZE}
          fill={palette.foreground}
          textAnchor="middle"
        >
          {props.label}
        </SvgText>
      ) : null}
    </G>
  );
}

function GroupFrameBox(props: {
  frame: GroupFrame;
  palette: GraphPalette;
  closeLabel: string;
  onClose: () => void;
}) {
  const { frame, palette } = props;
  return (
    <G testID="dependency-graph-group-frame">
      <Rect
        x={frame.x}
        y={frame.y}
        width={frame.width}
        height={frame.height}
        rx={12}
        fill="none"
        stroke={palette.muted}
        strokeWidth={1.25}
        strokeDasharray="6 4"
      />
      <SvgText
        x={frame.x + 14}
        y={frame.y + 22}
        fontSize={LABEL_SIZE}
        fontWeight="600"
        fill={palette.foreground}
      >
        {fitText(frame.group, frame.width - 80, LABEL_SIZE)}
      </SvgText>
      {/* Plain words, not a glyph: the SVG font has no ▾ and drew it as a dot. */}
      <SvgText
        x={frame.x + frame.width - 14}
        y={frame.y + 22}
        fontSize={DETAIL_SIZE}
        textAnchor="end"
        fill={palette.muted}
        onPress={props.onClose}
        testID="dependency-graph-group-close"
      >
        {props.closeLabel}
      </SvgText>
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
  /** Changed by the pull request: an amber outline that stays when something else is selected. */
  changed: boolean;
  does: string;
  size: string;
  palette: GraphPalette;
  onSelect: (id: string) => void;
}) {
  const { node, role, palette, onSelect } = props;
  const onPress = useCallback(() => onSelect(node.id), [node.id, onSelect]);
  const color = palette.role[role];
  const strong = role !== "normal" && role !== "dimmed";
  return (
    <G opacity={role === "dimmed" ? 0.3 : 1} testID={`dependency-graph-node-${role}`}>
      {props.changed ? (
        <Rect
          x={node.x - 4}
          y={node.y - 4}
          width={node.width + 8}
          height={node.height + 8}
          rx={11}
          fill="none"
          stroke={palette.changed}
          strokeWidth={2}
          testID="dependency-graph-node-changed"
        />
      ) : null}
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
        y={node.y + 20}
        fontSize={LABEL_SIZE}
        fontWeight="600"
        fill={palette.foreground}
        onPress={onPress}
      >
        {fitText(node.label, node.width, LABEL_SIZE)}
      </SvgText>
      <SvgText x={node.x + 10} y={node.y + 37} fontSize={DETAIL_SIZE} fill={palette.foreground}>
        {fitText(props.does, node.width, DETAIL_SIZE)}
      </SvgText>
      <SvgText x={node.x + 10} y={node.y + 54} fontSize={DETAIL_SIZE} fill={palette.muted}>
        {fitText(props.size, node.width, DETAIL_SIZE)}
      </SvgText>
    </G>
  );
}

interface SummarySource {
  serverId: string;
  cwd: string;
  commit: string;
}

const NO_FILES: readonly string[] = [];

/** The side panel for one module: What it does / Connected to / Inside / Open code / Show what calls this. */
function SelectionCard(props: {
  graph: ArchitectureGraph;
  selection: Selection;
  allLevels: boolean;
  onToggleLevels: () => void;
  callers: boolean;
  onToggleCallers: () => void;
  does: (node: GraphNode) => string;
  changed: boolean;
  summary: SummarySource | null;
  onOpenFile: ((path: string) => void) | null;
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const { graph, selection, onOpenFile } = props;
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const node = byId.get(selection.id);
  const part = usePartSummary(props.summary, node?.folder ?? "");
  if (!node) return null;
  return (
    <View style={styles.card} testID="dependency-graph-selection">
      <CardHead
        node={node}
        changed={props.changed}
        entry={onOpenFile ? (part.files[0] ?? null) : null}
        onOpenFile={onOpenFile}
        onClear={props.onClear}
      />
      <Text style={styles.sectionTitle}>{t(`${P}.whatItDoes`)}</Text>
      <View testID="dependency-graph-what-it-does">
        {part.asking ? (
          <WrittenSummary query={part.written} fallback={props.does(node)} />
        ) : (
          <Text style={styles.body}>{props.does(node)}</Text>
        )}
      </View>
      <ConnectedTo
        selection={selection}
        byId={byId}
        allLevels={props.allLevels}
        onToggleLevels={props.onToggleLevels}
        callers={props.callers}
        onToggleCallers={props.onToggleCallers}
        onSelect={props.onSelect}
      />
      <Inside
        node={node}
        files={part.files}
        onOpenFile={onOpenFile}
        usedToday={part.written.data?.usedToday}
        dailyLimit={part.written.data?.dailyLimit}
      />
    </View>
  );
}

/** The model-written "What it does" and file list for one folder, asked only when the host can answer. */
function usePartSummary(summary: SummarySource | null, folder: string) {
  const supported =
    useHostFeatureAvailability(summary?.serverId ?? null, "pullRequestReviewExplain") === true;
  const asking = supported && summary !== null && folder !== "";
  const written = useReviewExplanation({
    serverId: summary?.serverId ?? "",
    cwd: summary?.cwd ?? null,
    base: summary?.commit ?? null,
    head: summary?.commit ?? null,
    path: folder || null,
    kind: "module",
    enabled: asking,
  });
  return { asking, written, files: written.data?.files ?? NO_FILES };
}

function CardHead(props: {
  node: GraphNode;
  changed: boolean;
  entry: string | null;
  onOpenFile: ((path: string) => void) | null;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const { node, entry, onOpenFile } = props;
  const openEntry = useCallback(() => {
    if (onOpenFile && entry) onOpenFile(entry);
  }, [onOpenFile, entry]);
  return (
    <View style={styles.cardHead}>
      <View style={styles.cardTitleBox}>
        <Text style={styles.cardTitle}>{node.label}</Text>
        <Text style={styles.muted}>{node.folder || "."}</Text>
        {props.changed ? <Text style={styles.changedText}>{t(`${P}.changedHere`)}</Text> : null}
      </View>
      <View style={styles.cardActions}>
        {entry ? (
          <Pressable
            accessibilityRole="button"
            onPress={openEntry}
            style={styles.button}
            testID="dependency-graph-open-code"
          >
            <Text style={styles.buttonText}>{t(`${P}.openCode`)}</Text>
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" onPress={props.onClear} style={styles.button}>
          <Text style={styles.buttonText}>{t(`${K}.clear`)}</Text>
        </Pressable>
      </View>
    </View>
  );
}

function ConnectedTo(props: {
  selection: Selection;
  byId: ReadonlyMap<string, GraphNode>;
  allLevels: boolean;
  onToggleLevels: () => void;
  callers: boolean;
  onToggleCallers: () => void;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const { selection, byId } = props;
  return (
    <>
      <Text style={styles.sectionTitle}>{t(`${P}.connectedTo`)}</Text>
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
      <View style={styles.toggles}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={props.callers ? SELECTED_STATE : UNSELECTED_STATE}
          onPress={props.onToggleCallers}
          style={[styles.chip, props.callers && styles.chipOn]}
          testID="dependency-graph-show-callers"
        >
          <Text style={styles.chipText}>
            {t(props.callers ? `${P}.showAll` : `${P}.showCallers`)}
          </Text>
        </Pressable>
        {props.callers ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityState={props.allLevels ? SELECTED_STATE : UNSELECTED_STATE}
            onPress={props.onToggleLevels}
            style={[styles.chip, props.allLevels && styles.chipOn]}
            testID="dependency-graph-all-levels"
          >
            <Text style={styles.chipText}>{t(`${K}.allLevels`)}</Text>
          </Pressable>
        )}
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
    </>
  );
}

function Inside(props: {
  node: GraphNode;
  files: readonly string[];
  onOpenFile: ((path: string) => void) | null;
  usedToday: number | undefined;
  dailyLimit: number | undefined;
}) {
  const { t } = useTranslation();
  const { node, files } = props;
  return (
    <>
      <Text style={styles.sectionTitle}>{t(`${P}.inside`)}</Text>
      <Text style={styles.muted}>
        {t(`${K}.moduleFacts`, { files: node.files, code: node.code, tests: node.tests })}
      </Text>
      {files.slice(0, SHOWN_FILES).map((path) => (
        <FileLink key={path} path={path} folder={node.folder} onOpen={props.onOpenFile} />
      ))}
      {files.length > SHOWN_FILES ? (
        <Text style={styles.muted}>
          {t(`${P}.moreFiles`, { count: files.length - SHOWN_FILES })}
        </Text>
      ) : null}
      {props.usedToday !== undefined && props.dailyLimit !== undefined ? (
        <Text style={styles.muted}>
          {t(`${PLAIN}.usedToday`, { used: props.usedToday, limit: props.dailyLimit })}
        </Text>
      ) : null}
    </>
  );
}

/** The written summary, or the rule-based line with a note when the cap is reached or no model answered. */
function WrittenSummary(props: {
  query: ReturnType<typeof useReviewExplanation>;
  fallback: string;
}) {
  const { t } = useTranslation();
  const { query } = props;
  if (query.isLoading) return <Text style={styles.muted}>{t(`${PLAIN}.writing`)}</Text>;
  const data = query.data;
  if (data?.status === "ok" && data.text) return <Text style={styles.body}>{data.text}</Text>;
  const note = data?.status === "limit" ? `${P}.limitReached` : `${P}.unavailable`;
  return (
    <>
      <Text style={styles.body}>{props.fallback}</Text>
      <Text style={styles.muted}>{t(note)}</Text>
    </>
  );
}

function FileLink(props: {
  path: string;
  folder: string;
  onOpen: ((path: string) => void) | null;
}) {
  const { path, onOpen } = props;
  const onPress = useCallback(() => onOpen?.(path), [onOpen, path]);
  const name =
    props.folder && path.startsWith(`${props.folder}/`)
      ? path.slice(props.folder.length + 1)
      : path;
  if (!onOpen) {
    return (
      <Text style={styles.rowText} numberOfLines={1}>
        {name}
      </Text>
    );
  }
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.row}>
      <Text style={styles.linkText} numberOfLines={1}>
        {name}
      </Text>
    </Pressable>
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
    borderColor: theme.colors.statusWarning,
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
  swatchUsedBy: { backgroundColor: theme.colors.accent },
  swatchEdited: { backgroundColor: theme.colors.statusWarning },
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
  results: {
    gap: theme.spacing[0.5],
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
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
  usedByText: { color: theme.colors.accent },
  changedText: { color: theme.colors.statusWarning, fontSize: theme.fontSize.sm },
  body: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, lineHeight: 20 },
  linkText: { color: theme.colors.accent, fontSize: theme.fontSize.sm },
  toggles: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
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
