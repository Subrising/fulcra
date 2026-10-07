import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View, type LayoutChangeEvent } from "react-native";
import Svg, { G, Line, Polygon, Rect, Text as SvgText } from "react-native-svg";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import { useCanvasGestures } from "./use-canvas-gestures";
import type { ArchitectureMapModel, ArchitectureMapNode, CardTone, NodeTone } from "./ir-model";
import {
  computeViewBox,
  edgeGeometry,
  fitText,
  indexNodes,
  shouldDrawLabels,
  type EdgeGeometry,
} from "./layout";

// Security boundary: every IR-derived string below is a React child of a Text element, so it
// reaches the screen as a text node. Nothing from the IR is placed in an href, a style, a
// colour, a font or an id attribute; colours come from fixed tone tables. The test
// `architecture-map-safety.test.ts` fails if this module grows an HTML sink or a link.

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const ZOOM_STEP = 1.25;
const LABEL_SIZE = 13;
const DETAIL_SIZE = 10.5;
const SELECTED_STATE = { selected: true } as const;
const UNSELECTED_STATE = { selected: false } as const;

type Tone = NodeTone | CardTone;

// Colours reach the SVG through withUnistyles uniProps on the canvas (docs/unistyles.md bans the hook).
function toneColor(theme: Theme, tone: Tone): string {
  const colors = theme.colors;
  switch (tone) {
    case "service":
    case "cyan":
      return colors.accent;
    case "client":
    case "emerald":
      return colors.statusSuccess;
    case "data":
    case "amber":
      return colors.statusWarning;
    case "security":
    case "rose":
      return colors.statusDanger;
    case "messaging":
    case "cloud":
    case "violet":
      return colors.statusMerged;
    case "external":
    case "neutral":
      return colors.foregroundMuted;
  }
}

const NODE_TONE_LIST: readonly NodeTone[] = [
  "service",
  "client",
  "external",
  "data",
  "messaging",
  "cloud",
  "security",
  "neutral",
];

// The whole canvas is the one withUnistyles-wrapped component: wrapping each SVG element makes
// Unistyles insert an HTML wrapper inside <svg> on web, which the browser never paints.
interface MapPalette {
  tone: Record<NodeTone, string>;
  accent: string;
  surface: string;
  foreground: string;
  muted: string;
}
const paletteProps = (theme: Theme) => ({
  palette: {
    tone: Object.fromEntries(
      NODE_TONE_LIST.map((tone) => [tone, toneColor(theme, tone)]),
    ) as Record<NodeTone, string>,
    accent: theme.colors.accent,
    surface: theme.colors.surface1,
    foreground: theme.colors.foreground,
    muted: theme.colors.foregroundMuted,
  } satisfies MapPalette,
});
const FALLBACK_PALETTE: MapPalette = {
  tone: {
    service: "#8ab4f8",
    client: "#6cb17b",
    external: "#a1a5a4",
    data: "#c99a5b",
    messaging: "#b392f0",
    cloud: "#b392f0",
    security: "#d0695f",
    neutral: "#a1a5a4",
  },
  accent: "#8ab4f8",
  surface: "#1e2120",
  foreground: "#e8eaea",
  muted: "#a1a5a4",
};

function MapCanvas(props: {
  palette?: MapPalette;
  viewBox: { x: number; y: number; width: number; height: number };
  zoom: number;
  title: string;
  geometries: readonly { edge: ArchitectureMapModel["edges"][number]; geometry: EdgeGeometry }[];
  nodes: readonly ArchitectureMapNode[];
  drawLabels: boolean;
  incident: { nodeIds: ReadonlySet<string>; edgeIds: ReadonlySet<string> } | null;
  selectedId: string | null;
  onToggle: (id: string) => void;
}) {
  const { viewBox, zoom, geometries, nodes, drawLabels, incident, selectedId, onToggle } = props;
  const palette = props.palette ?? FALLBACK_PALETTE;
  return (
    <Svg
      width={viewBox.width * zoom}
      height={viewBox.height * zoom}
      viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
      accessibilityLabel={props.title}
    >
      {geometries.map(({ edge, geometry }) => (
        <MapEdge
          key={edge.id}
          geometry={geometry}
          label={drawLabels ? edge.label : null}
          style={edge.style}
          dimmed={incident !== null && !incident.edgeIds.has(edge.id)}
          palette={palette}
        />
      ))}
      {nodes.map((node) => (
        <MapNode
          key={node.id}
          node={node}
          drawLabels={drawLabels}
          selected={node.id === selectedId}
          dimmed={incident !== null && !incident.nodeIds.has(node.id)}
          onToggle={onToggle}
          palette={palette}
        />
      ))}
    </Svg>
  );
}
const ThemedMapCanvas = withUnistyles(MapCanvas);

export interface ArchitectureMapViewProps {
  model: ArchitectureMapModel;
}

export function ArchitectureMapView({ model }: ArchitectureMapViewProps) {
  const { t } = useTranslation();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [availableWidth, setAvailableWidth] = useState(0);

  const nodesById = useMemo(() => indexNodes(model), [model]);
  const geometries = useMemo(
    () =>
      model.edges.flatMap((edge) => {
        const geometry = edgeGeometry(edge, nodesById);
        return geometry ? [{ edge, geometry }] : [];
      }),
    [model.edges, nodesById],
  );
  const viewBox = useMemo(
    () =>
      computeViewBox(
        model,
        geometries.map((entry) => entry.geometry),
      ),
    [model, geometries],
  );
  const fitZoom =
    availableWidth > 0 ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, availableWidth / viewBox.width)) : 1;
  const effectiveZoom = zoom ?? Math.min(1, fitZoom);
  const drawLabels = shouldDrawLabels(model.nodes.length, effectiveZoom);

  const incident = useMemo(() => {
    if (!selectedId) return null;
    const ids = new Set<string>([selectedId]);
    const edgeIds = new Set<string>();
    for (const edge of model.edges) {
      if (edge.from === selectedId || edge.to === selectedId) {
        edgeIds.add(edge.id);
        ids.add(edge.from);
        ids.add(edge.to);
      }
    }
    return { nodeIds: ids, edgeIds };
  }, [model.edges, selectedId]);

  const clearSelection = useCallback(() => setSelectedId(null), []);
  const toggleSelection = useCallback(
    (id: string) => setSelectedId((current) => (current === id ? null : id)),
    [],
  );
  const zoomOut = useCallback(
    () => setZoom(Math.max(MIN_ZOOM, effectiveZoom / ZOOM_STEP)),
    [effectiveZoom],
  );
  const zoomIn = useCallback(
    () => setZoom(Math.min(MAX_ZOOM, effectiveZoom * ZOOM_STEP)),
    [effectiveZoom],
  );
  const zoomToFit = useCallback(() => setZoom(fitZoom), [fitZoom]);
  const zoomToActualSize = useCallback(() => setZoom(1), []);
  useEffect(() => {
    if (!isWeb || typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearSelection]);

  const canvasFrame = useRef<View | null>(null);
  useCanvasGestures(canvasFrame, {
    zoom: effectiveZoom,
    minZoom: MIN_ZOOM,
    maxZoom: MAX_ZOOM,
    onZoom: setZoom,
  });

  const onCanvasLayout = useCallback((event: LayoutChangeEvent) => {
    setAvailableWidth(event.nativeEvent.layout.width);
  }, []);

  const selected = selectedId ? (nodesById.get(selectedId) ?? null) : null;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      testID="architecture-map"
    >
      <View style={styles.header}>
        <Text style={styles.title} testID="architecture-map-title">
          {model.title}
        </Text>
        {model.subtitle ? (
          <Text style={styles.subtitle} testID="architecture-map-subtitle">
            {model.subtitle}
          </Text>
        ) : null}
        {model.hiddenCharactersRemoved ? (
          <Text style={styles.notice} testID="architecture-map-hidden-characters">
            {t("panels.architectureMap.hiddenCharacters")}
          </Text>
        ) : null}
      </View>

      <View style={styles.toolbar}>
        <ZoomButton
          label={t("panels.architectureMap.zoomOut")}
          onPress={zoomOut}
          testID="architecture-map-zoom-out"
        >
          −
        </ZoomButton>
        <ZoomButton
          label={t("panels.architectureMap.zoomIn")}
          onPress={zoomIn}
          testID="architecture-map-zoom-in"
        >
          +
        </ZoomButton>
        <ZoomButton
          label={t("panels.architectureMap.fit")}
          onPress={zoomToFit}
          testID="architecture-map-fit"
        >
          {t("panels.architectureMap.fit")}
        </ZoomButton>
        <ZoomButton
          label={t("panels.architectureMap.actualSize")}
          onPress={zoomToActualSize}
          testID="architecture-map-actual-size"
        >
          100%
        </ZoomButton>
      </View>

      {isWeb ? (
        <Text style={styles.subtitle} testID="architecture-map-gesture-hint">
          {t("panels.architectureMap.gestureHint")}
        </Text>
      ) : null}
      <View
        ref={canvasFrame}
        style={styles.canvasFrame}
        onLayout={onCanvasLayout}
        testID="architecture-map-canvas"
      >
        <ScrollView horizontal>
          <ThemedMapCanvas
            uniProps={paletteProps}
            viewBox={viewBox}
            zoom={effectiveZoom}
            title={model.title}
            geometries={geometries}
            nodes={model.nodes}
            drawLabels={drawLabels}
            incident={incident}
            selectedId={selectedId}
            onToggle={toggleSelection}
          />
        </ScrollView>
      </View>

      {selected ? <NodeDetail node={selected} model={model} onClose={clearSelection} /> : null}

      {model.cards.length > 0 ? (
        <View style={styles.cards}>
          {model.cards.map((card) => (
            <View key={card.key} style={styles.card} testID="architecture-map-card">
              <View style={styles.cardHeader}>
                <View style={[styles.dot, dotStyles[card.tone]]} />
                <Text style={styles.cardTitle}>{card.title}</Text>
              </View>
              {card.items.map((item) => (
                <Text key={item.key} style={styles.cardItem}>
                  {item.text}
                </Text>
              ))}
            </View>
          ))}
        </View>
      ) : null}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t("panels.architectureMap.components")}</Text>
        {model.nodes.map((node) => (
          <NodeRow
            key={node.id}
            node={node}
            selected={node.id === selectedId}
            onToggle={toggleSelection}
          />
        ))}
      </View>

      {model.boundaries.length > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t("panels.architectureMap.boundaries")}</Text>
          {model.boundaries.map((boundary) => (
            <Text key={boundary.key} style={styles.cardItem} testID="architecture-map-boundary">
              {boundary.label} · {boundary.kind}
            </Text>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

function NodeRow(props: {
  node: ArchitectureMapNode;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  const { node, selected, onToggle } = props;
  const onPress = useCallback(() => onToggle(node.id), [node.id, onToggle]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={selected ? SELECTED_STATE : UNSELECTED_STATE}
      onPress={onPress}
      style={[styles.listRow, selected && styles.listRowSelected]}
      testID="architecture-map-node-row"
    >
      <Text style={styles.listLabel}>{node.label}</Text>
      <Text style={styles.listMeta}>{node.type}</Text>
    </Pressable>
  );
}

function ZoomButton(props: {
  label: string;
  onPress: () => void;
  testID: string;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      style={styles.toolbarButton}
      testID={props.testID}
    >
      <Text style={styles.toolbarText}>{props.children}</Text>
    </Pressable>
  );
}

function MapEdge(props: {
  geometry: EdgeGeometry;
  label: string | null;
  style: "solid" | "emphasis" | "dashed";
  dimmed: boolean;
  palette: MapPalette;
}) {
  const { geometry, label, style, dimmed, palette } = props;
  const color = style === "emphasis" ? palette.accent : palette.muted;
  const emphasis = style === "emphasis";
  const points = geometry.arrow.map((point) => `${point.x},${point.y}`).join(" ");
  return (
    <G opacity={dimmed ? 0.2 : 1} testID="architecture-map-edge">
      <Line
        x1={geometry.start.x}
        y1={geometry.start.y}
        x2={geometry.end.x}
        y2={geometry.end.y}
        stroke={color}
        strokeWidth={emphasis ? 2 : 1.5}
        strokeDasharray={style === "dashed" ? "6 4" : undefined}
      />
      <Polygon points={points} fill={color} />
      {label ? (
        <SvgText
          x={geometry.labelAt.x}
          y={geometry.labelAt.y}
          fontSize={DETAIL_SIZE}
          fill={palette.muted}
          textAnchor="middle"
        >
          {label}
        </SvgText>
      ) : null}
    </G>
  );
}

function MapNode(props: {
  node: ArchitectureMapNode;
  drawLabels: boolean;
  selected: boolean;
  dimmed: boolean;
  onToggle: (id: string) => void;
  palette: MapPalette;
}) {
  const { node, drawLabels, selected, dimmed, onToggle, palette } = props;
  const toneColour = palette.tone[node.tone];
  const onPress = useCallback(() => onToggle(node.id), [node.id, onToggle]);
  const textX = node.x + 10;
  return (
    <G opacity={dimmed ? 0.2 : 1} testID="architecture-map-node">
      <Rect
        x={node.x}
        y={node.y}
        width={node.width}
        height={node.height}
        rx={8}
        fill={palette.surface}
        stroke={selected ? palette.accent : toneColour}
        strokeWidth={selected ? 2.5 : 1.5}
        strokeDasharray={node.tone === "external" ? "5 3" : undefined}
        onPress={onPress}
      />
      {drawLabels ? (
        <>
          <SvgText
            x={textX}
            y={node.y + 20}
            fontSize={LABEL_SIZE}
            fontWeight="600"
            fill={palette.foreground}
          >
            {fitText(node.label, node.width, LABEL_SIZE)}
          </SvgText>
          {node.sublabel ? (
            <SvgText x={textX} y={node.y + 36} fontSize={DETAIL_SIZE} fill={palette.muted}>
              {fitText(node.sublabel, node.width, DETAIL_SIZE)}
            </SvgText>
          ) : null}
          {node.tag ? (
            <SvgText x={textX} y={node.y + 51} fontSize={DETAIL_SIZE} fill={toneColour}>
              {fitText(node.tag, node.width, DETAIL_SIZE)}
            </SvgText>
          ) : null}
        </>
      ) : null}
    </G>
  );
}

function NodeDetail(props: {
  node: ArchitectureMapNode;
  model: ArchitectureMapModel;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { node, model, onClose } = props;
  const outgoing = model.edges.filter((edge) => edge.from === node.id);
  const incoming = model.edges.filter((edge) => edge.to === node.id);
  return (
    <View style={styles.detail} testID="architecture-map-detail">
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>{node.label}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("panels.architectureMap.closeDetail")}
          onPress={onClose}
          testID="architecture-map-detail-close"
        >
          <Text style={styles.toolbarText}>×</Text>
        </Pressable>
      </View>
      <Text style={styles.cardItem}>
        {t("panels.architectureMap.detailId")}: {node.id} · {node.type}
      </Text>
      {node.sublabel ? <Text style={styles.cardItem}>{node.sublabel}</Text> : null}
      {node.tag ? (
        <Text style={styles.cardItem} testID="architecture-map-detail-tag">
          {node.tag}
        </Text>
      ) : null}
      {outgoing.map((edge) => (
        <Text key={`out-${edge.id}`} style={styles.cardItem}>
          → {edge.to}
          {edge.label ? ` · ${edge.label}` : ""}
        </Text>
      ))}
      {incoming.map((edge) => (
        <Text key={`in-${edge.id}`} style={styles.cardItem}>
          ← {edge.from}
          {edge.label ? ` · ${edge.label}` : ""}
        </Text>
      ))}
    </View>
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
  notice: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, fontStyle: "italic" },
  toolbar: { flexDirection: "row", gap: theme.spacing[2] },
  toolbarButton: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  toolbarText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  canvasFrame: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    overflow: "hidden",
  },
  cards: { gap: theme.spacing[2] },
  card: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  cardTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  cardItem: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  detail: {
    gap: theme.spacing[1],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
  },
  section: { gap: theme.spacing[1] },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  listRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  listRowSelected: { backgroundColor: theme.colors.surface2 },
  listLabel: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  listMeta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));

const dotStyles = StyleSheet.create((theme) => ({
  emerald: { backgroundColor: toneColor(theme, "emerald") },
  cyan: { backgroundColor: toneColor(theme, "cyan") },
  amber: { backgroundColor: toneColor(theme, "amber") },
  rose: { backgroundColor: toneColor(theme, "rose") },
  violet: { backgroundColor: toneColor(theme, "violet") },
  neutral: { backgroundColor: toneColor(theme, "neutral") },
}));
