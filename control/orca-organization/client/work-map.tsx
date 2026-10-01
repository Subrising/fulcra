import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { copyText, PanSurface as HostPanSurface, type PanSurfaceProps } from "@getpaseo/plugin/client/react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useContract } from "./use-contract";
import { WorkButton } from "./work-button";
import { Details } from "./details";
import { lastGood } from "./last-good";
import { workMapProjectRpc, workMapRpc, type WorkMapProject } from "../shared/work-map";
import { ageText, buildOutline, CARD, changeAnnouncement, displayGlyph, freshness, initialExpanded, layoutMap, LINK_STYLE, toggleExpanded, type Filter, type Freshness, type Row } from "./work-map-model";

/**
 * The Fulcra work map. Read-only: this module imports only the two work-map read contracts, and
 * `work-map-readonly.test` fails if it ever imports a write contract or navigates anywhere.
 * The only action is copying an id to this device's clipboard.
 */

export const OVERVIEW_POLL_MS = 15000, PROJECT_POLL_MS = 30000;

type Props = Pick<PluginSurfaceProps, "theme" | "layout" | "host">;

export function WorkMapSurface({ theme, layout, host }: Props) {
  const c = theme.colors, text = { color: c.foreground }, muted = { color: c.foregroundMuted };
  const hostId = host?.id ?? "";
  const readOverview = useContract(workMapRpc), readProject = useContract(workMapProjectRpc);
  const [frozen, setFrozen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string[] | null>(null);
  const [moreOpen, setMoreOpen] = useState<string[]>([]);
  const [view, setView] = useState<"list" | "map">("list");
  const [selected, setSelected] = useState<string | null>(null);
  const [legend, setLegend] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(t); }, []);

  const overviewKey = ["orca-work-map", hostId];
  const overview = useQuery({
    queryKey: overviewKey, queryFn: () => readOverview({}),
    refetchInterval: frozen ? false : OVERVIEW_POLL_MS, refetchIntervalInBackground: false, refetchOnWindowFocus: !frozen, retry: false,
  });
  // J0: a stalled read keeps showing the last good map (memory only), with one plain notice.
  const last = lastGood(overview, overviewKey, { now }), d = last.data;
  const open = expanded ?? initialExpanded(d);
  const projectQueries = useQueries({
    queries: open.map(projectId => ({
      queryKey: ["orca-work-map-project", hostId, projectId], queryFn: () => readProject({ projectId }),
      refetchInterval: frozen ? false : PROJECT_POLL_MS, refetchIntervalInBackground: false, refetchOnWindowFocus: !frozen, retry: false,
    })),
  });
  const projects: Record<string, WorkMapProject | undefined> = {};
  const projectStale: Record<string, boolean> = {};
  open.forEach((id, i) => {
    projects[id] = projectQueries[i] ? lastGood(projectQueries[i], ["orca-work-map-project", hostId, id], { now }).data : undefined;
    projectStale[id] = freshness(projectQueries[i]?.data?.observedAt, now, Boolean(projectQueries[i]?.isError), frozen) === "stale";
  });

  const fresh: Freshness = freshness(d?.observedAt, now, overview.isError, frozen);
  const outline = useMemo(() => d ? buildOutline({ overview: d, projects, expanded: open, moreOpen, filter, search }) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [d, JSON.stringify(Object.values(projects).map(p => p?.observedAt)), open.join(), moreOpen.join(), filter, search]);
  const previous = useRef<Row[] | undefined>(undefined);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  useEffect(() => { if (!outline) return; setAnnouncement(changeAnnouncement(previous.current, outline.rows)); previous.current = outline.rows; }, [d?.observedAt]);

  const toggle = (row: Row) => {
    if (row.kind === "project" && row.target.projectId) setExpanded(toggleExpanded(open, row.target.projectId));
    else if (row.kind === "more" && row.target.taskId) setMoreOpen([...moreOpen, row.target.taskId]);
    else setSelected(row.id);
  };
  const chosen = outline?.rows.find(r => r.id === selected) ?? null;
  const header = fresh === "frozen" ? "Frozen" : fresh === "stale" ? `STALE · retained ${ageText(d?.observedAt, now)}` : `Observed ${ageText(d?.observedAt, now)}`;
  const dim = fresh === "stale" ? 0.6 : 1;

  const showAttention = !!d && d.attention.length > 0 && filter !== "attention";
  const attentionPanel = showAttention ? <View accessibilityLabel={`Needs attention, ${d.attention.length}`} style={{ gap: 6, padding: 12, borderWidth: 1, borderColor: c.border, borderRadius: 10, opacity: dim }}>
      <Text style={{ ...text, fontWeight: "600" }}>⚠ Needs attention ({d.attention.length})</Text>
      {d.attention.slice(0, 8).map((a, i) => <Pressable key={`${a.kind}:${i}`} accessibilityRole="button" accessibilityLabel={`Attention: ${a.detail}`} style={{ minHeight: 44, justifyContent: "center" }}
        onPress={() => { if (a.projectId && !open.includes(a.projectId)) setExpanded(toggleExpanded(open, a.projectId)); if (a.projectId) setSelected(`project:${a.projectId}`); }}>
        <Text style={text}>⚠ {a.detail}</Text></Pressable>)}
      {d.attention.length > 8 && <Text style={muted}>Use the "Needs attention" filter to see all {d.attention.length}.</Text>}
    </View> : null;

  return <ScrollView keyboardShouldPersistTaps="handled" testID="work-map" style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 14 }}>
    <Text accessibilityRole="header" style={{ ...text, fontSize: 24, fontWeight: "600" }}>Fulcra work map</Text>
    <Text accessibilityLiveRegion="polite" testID="work-map-freshness" style={{ ...text, fontWeight: "500" }}>{d ? header : overview.isError ? "Unavailable" : "Reading…"}{announcement ? ` · ${announcement}` : ""}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <WorkButton theme={theme} label="Refresh work map" onPress={() => { void overview.refetch(); projectQueries.forEach(q => void q.refetch()); }}>{overview.isFetching ? "Refreshing…" : "Refresh"}</WorkButton>
      <WorkButton theme={theme} label={frozen ? "Resume updates" : "Freeze updates"} selected={frozen} onPress={() => setFrozen(!frozen)}>{frozen ? "Resume" : "Freeze"}</WorkButton>
      <WorkButton theme={theme} label="Show list" selected={view === "list"} onPress={() => setView("list")}>List</WorkButton>
      <WorkButton theme={theme} label="Show map" selected={view === "map"} onPress={() => setView("map")}>Map</WorkButton>
      <WorkButton theme={theme} label="Status legend" expanded={legend} onPress={() => setLegend(!legend)}>{legend ? "Legend −" : "Legend +"}</WorkButton>
    </View>
    {/* J0-10: say what the two less obvious controls do. */}
    <Text style={muted}>Freeze keeps this view still while you read; Resume brings it up to date. Legend explains the symbols.</Text>
    <TextInput accessibilityLabel="Search sessions, seats, workstreams and issues" value={search} onChangeText={v => setSearch(v.slice(0, 160))} placeholder="Search sessions, seats, issues…" placeholderTextColor={c.foregroundMuted}
      style={{ color: c.foreground, padding: 12, borderWidth: 1, borderColor: c.border, borderRadius: 8 }} />
    <View accessibilityRole="radiogroup" accessibilityLabel="Filter" style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {([["all", "All"], ["attention", "Needs attention"], ["delegated", "Run by Fulcra"], ["human", "Run by you"]] as const).map(([key, label]) =>
        <Pressable key={key} accessibilityRole="radio" accessibilityLabel={`Filter: ${label}`} accessibilityState={{ checked: filter === key }} onPress={() => setFilter(key)}
          style={{ minHeight: 44, paddingHorizontal: 12, justifyContent: "center", borderRadius: 22, borderWidth: 1, borderColor: filter === key ? c.accent ?? c.foreground : c.border }}>
          <Text style={{ ...text, fontWeight: filter === key ? "700" : "400" }}>{filter === key ? "● " : "○ "}{label}</Text>
        </Pressable>)}
    </View>
    {legend && <Legend theme={theme} />}

    {!d && overview.isError && <Text style={text}>Fulcra can't reach the controller on this host: {(overview.error as Error)?.message ?? "unavailable"}.</Text>}
    {!d && overview.isPending && <Text style={muted}>Reading seats, projects and sessions…</Text>}
    {d && last.notice && <Text accessibilityLiveRegion="polite" testID="work-map-stall" style={text}>{last.notice}</Text>}
    {d && !d.available && <Text style={text}>Recorded seats could not be read ({d.unavailable}). No orchestrator can be named or ruled out.</Text>}
    {d && d.available && d.primes.length === 0 && d.projects.every(p => !p.seat) && <Text style={text}>No prime or project orchestrator is recorded yet. Seats are assigned in Leadership.</Text>}
    {d && !d.sources.projects.available && <Text style={muted}>Project membership unknown; seats are still shown. {d.sources.projects.note}</Text>}
    {d && !d.sources.fleet.available && <Text style={muted}>Session runtime unavailable; control modes and seats are still shown.</Text>}

    {/* J6 (J5 walkthrough): in Map view the attention panel (up to eight rows) pushed the graph below the fold.
        The map now comes first with a one-line count; the full panel follows it. List view is unchanged. */}
    {showAttention && view === "list" && attentionPanel}
    {showAttention && view === "map" && <Text accessibilityLabel={`Needs attention, ${d!.attention.length}, listed below the map`} style={{ ...text, fontWeight: "600", opacity: dim }}>⚠ {d!.attention.length} need attention, listed below the map</Text>}

    {outline && outline.rows.length === 0 && <View style={{ gap: 8 }}><Text style={text}>Nothing matches these filters.</Text><WorkButton theme={theme} label="Clear filters" onPress={() => { setFilter("all"); setSearch(""); }} /></View>}
    {outline && view === "list" && <View accessibilityRole="list" accessibilityLabel="Fulcra work outline" style={{ gap: 4, opacity: dim }}>
      {outline.rows.map(row => <OutlineRow key={row.id} row={row} fresh={projectStale[row.target.projectId ?? ""] ? "stale" : fresh} selected={row.id === selected} theme={theme} onPress={() => toggle(row)} />)}
    </View>}
    {outline && view === "map" && <MapView rows={outline.rows} fresh={fresh} selected={selected} theme={theme} native={layout.platform === "ios" || layout.platform === "android"} onPress={toggle} />}
    {showAttention && view === "map" && attentionPanel}
    {outline && outline.hidden > 0 && <Text style={muted}>{outline.hidden} hidden by the current filter or search.</Text>}

    {chosen && <Detail row={chosen} theme={theme} />}
    {d && <Text style={muted}>{d.note}</Text>}
  </ScrollView>;
}

function OutlineRow({ row, fresh, selected, theme, onPress }: { row: Row; fresh: Freshness; selected: boolean; onPress: () => void } & Pick<PluginSurfaceProps, "theme">) {
  const c = theme.colors;
  if (row.kind === "notice") return <Text style={{ color: c.foregroundMuted, paddingLeft: 12 + row.depth * 16 }}>{row.glyph} {row.title}</Text>;
  return <Pressable accessibilityRole="button" accessibilityLabel={row.label} accessibilityState={{ selected, expanded: row.expandable ? row.expanded : undefined }} onPress={onPress}
    style={{ minHeight: 44, paddingLeft: 8 + row.depth * 16, paddingRight: 8, paddingVertical: 6, borderRadius: 8, borderWidth: selected ? 2 : 0, borderColor: c.accent ?? c.foreground, backgroundColor: selected ? c.surface2 ?? c.surface1 : "transparent" }}>
    <Text style={{ color: c.foreground, fontWeight: row.kind === "project" || row.kind === "prime" ? "600" : "400" }}>{row.expandable ? (row.expanded ? "▾ " : "▸ ") : ""}{displayGlyph(row.glyph, fresh)} {row.title}</Text>
    {row.detail ? <Text style={{ color: c.foregroundMuted }}>{fresh === "stale" ? "last observed · " : ""}{row.detail}</Text> : null}
  </Pressable>;
}

function Detail({ row, theme }: { row: Row } & Pick<PluginSurfaceProps, "theme">) {
  const c = theme.colors, [copied, setCopied] = useState<string | null>(null);
  const id = row.target.sessionId ?? row.target.taskId ?? row.target.projectId ?? null;
  return <View accessibilityLabel={`Detail for ${row.title}`} style={{ gap: 6, padding: 12, borderWidth: 1, borderColor: c.border, borderRadius: 10 }}>
    <Text style={{ color: c.foreground, fontWeight: "600" }}>{row.title}</Text>
    <Text selectable style={{ color: c.foreground }}>{row.detail}</Text>
    {id && <Details theme={theme}>
      {row.target.sessionId && <Text selectable style={{ color: c.foregroundMuted }}>Session {row.target.sessionId}</Text>}
      {row.target.taskId && <Text selectable style={{ color: c.foregroundMuted }}>Task {row.target.taskId}</Text>}
      {row.target.projectId && <Text selectable style={{ color: c.foregroundMuted }}>Project {row.target.projectId}</Text>}
      <WorkButton theme={theme} label={`Copy id ${id}`} onPress={() => { void copyText(id).then(() => setCopied("Copied"), () => setCopied("Copying is unavailable here; select the id above.")); }}>Copy id</WorkButton>
      {copied && <Text accessibilityLiveRegion="polite" style={{ color: c.foregroundMuted }}>{copied}</Text>}
    </Details>}
  </View>;
}

function Legend({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const c = theme.colors, line = { color: c.foreground };
  return <View accessibilityLabel="Status legend" style={{ gap: 4, padding: 12, borderWidth: 1, borderColor: c.border, borderRadius: 10 }}>
    <Text style={{ ...line, fontWeight: "600" }}>Legend</Text>
    <Text style={line}>Runtime: ● running · ◐ waiting for permission · ○ idle — not done · ✕ error · ? runtime unavailable</Text>
    <Text style={line}>Control mode: delegated · human · transitioning</Text>
    <Text style={line}>Orchestrator: assigned · none yet · held by you · session gone · restarted since it was assigned · moved to other work</Text>
    <Text style={line}>Owner: recorded (solid link) · adopted (dashed) · no leader recorded · not recorded</Text>
    <Text style={line}>Issues: open · in progress · blocked · done · cancelled · unknown</Text>
    <Text style={line}>Freshness: live · STALE (dimmed, hollow ⊙ ◌ ⊗ ◇ □ ▭) · frozen</Text>
    {Object.values(LINK_STYLE).map(s => <Text key={s.words} style={{ color: c.foregroundMuted }}>{s.dashed ? "╌╌" : s.weight > 2 ? "━━" : "──"} {s.words}</Text>)}
  </View>;
}

/** Native pan where the host provides it; buttons everywhere. Same split as the Live work graph. */
function Viewport({ nativePan, onPanStart, onPanUpdate, onPanEnd, ...props }: PanSurfaceProps & { nativePan: boolean }) {
  return nativePan && HostPanSurface ? <HostPanSurface {...props} onPanStart={onPanStart} onPanUpdate={onPanUpdate} onPanEnd={onPanEnd} /> : <View {...props} />;
}

function MapView({ rows, fresh, selected, theme, native, onPress }: { rows: Row[]; fresh: Freshness; selected: string | null; native: boolean; onPress: (row: Row) => void } & Pick<PluginSurfaceProps, "theme">) {
  const c = theme.colors;
  const graph = useMemo(() => layoutMap(rows), [rows]);
  const [zoom, setZoom] = useState(1), [offset, setOffset] = useState({ x: 0, y: 0 }), [viewport, setViewport] = useState({ width: 320, height: 320 });
  const start = useRef(offset);
  const clamp = (x: number, y: number) => ({ x: Math.max(0, Math.min(x, Math.max(0, graph.width * zoom - viewport.width))), y: Math.max(0, Math.min(y, Math.max(0, graph.height * zoom - viewport.height))) });
  const byId = new Map(graph.nodes.map(n => [n.id, n]));
  return <View style={{ gap: 8 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {([["Zoom out", () => setZoom(z => Math.max(0.5, z - 0.25))], ["Zoom in", () => setZoom(z => Math.min(2, z + 0.25))], ["Reset map", () => { setZoom(1); setOffset({ x: 0, y: 0 }); }],
        ["Pan left", () => setOffset(clamp(offset.x - 220, offset.y))], ["Pan right", () => setOffset(clamp(offset.x + 220, offset.y))], ["Pan up", () => setOffset(clamp(offset.x, offset.y - 160))], ["Pan down", () => setOffset(clamp(offset.x, offset.y + 160))]] as const)
        .map(([label, fn]) => <WorkButton key={label} theme={theme} label={label} onPress={fn} />)}
    </View>
    <Viewport nativePan={native} onPanStart={() => { start.current = offset; }} onPanUpdate={({ x, y }) => setOffset(clamp(start.current.x - x, start.current.y - y))} onPanEnd={() => undefined} testID="work-map-viewport" accessibilityLabel="Fulcra work map; the list shows every item"
      onLayout={e => setViewport({ width: Math.max(1, e.nativeEvent.layout.width), height: Math.max(1, e.nativeEvent.layout.height) })}
      style={{ height: 520, overflow: "hidden", borderWidth: 1, borderColor: c.border, borderRadius: 12, backgroundColor: c.surface0, opacity: fresh === "stale" ? 0.6 : 1 }}>
      {graph.edges.map(edge => {
        const a = byId.get(edge.from)!, b = byId.get(edge.to)!, style = LINK_STYLE[edge.kind];
        const x1 = (a.x + CARD.width) * zoom - offset.x, y1 = (a.y + CARD.height / 2) * zoom - offset.y, x2 = b.x * zoom - offset.x, y2 = (b.y + CARD.height / 2) * zoom - offset.y;
        if (Math.max(x1, x2) < 0 || Math.min(x1, x2) > viewport.width || Math.max(y1, y2) < 0 || Math.min(y1, y2) > viewport.height) return null;
        const width = Math.max(2, Math.hypot(x2 - x1, y2 - y1)), angle = Math.atan2(y2 - y1, x2 - x1);
        return <View key={edge.id} pointerEvents="none" accessible={false} style={{ position: "absolute", left: (x1 + x2) / 2 - width / 2, top: (y1 + y2) / 2, width, borderTopWidth: style.weight, borderColor: edge.kind === "parent" || edge.kind === "channel" ? c.foreground : c.border, borderStyle: style.dashed ? "dashed" : "solid", transform: [{ rotate: `${angle}rad` }] }} />;
      })}
      {graph.nodes.filter(n => n.x * zoom + CARD.width * zoom >= offset.x && n.x * zoom <= offset.x + viewport.width && n.y * zoom + CARD.height * zoom >= offset.y && n.y * zoom <= offset.y + viewport.height).map(n =>
        <Pressable key={n.id} accessibilityRole="button" accessibilityLabel={n.row.label} accessibilityState={{ selected: n.id === selected, expanded: n.row.expandable ? n.row.expanded : undefined }} onPress={() => onPress(n.row)}
          style={{ position: "absolute", left: n.x * zoom - offset.x, top: n.y * zoom - offset.y, width: CARD.width * zoom, height: CARD.height * zoom, padding: 8 * zoom, gap: 2, borderRadius: 12, borderWidth: n.id === selected ? 2 : 1, borderColor: n.id === selected ? c.accent ?? c.foreground : c.border, backgroundColor: c.surface1 ?? c.surface0 }}>
          <Text numberOfLines={1} style={{ color: c.foreground, fontWeight: "600", fontSize: Math.max(11, 13 * zoom) }}>{n.row.expandable ? (n.row.expanded ? "▾ " : "▸ ") : ""}{displayGlyph(n.row.glyph, fresh)} {n.row.title}</Text>
          {zoom >= 0.75 && <Text numberOfLines={2} style={{ color: c.foregroundMuted, fontSize: Math.max(10, 11 * zoom) }}>{n.row.detail}</Text>}
        </Pressable>)}
    </Viewport>
    <Text style={{ color: c.foregroundMuted }}>{graph.nodes.length} nodes · {graph.edges.length} links · {Math.round(zoom * 100)}%</Text>
  </View>;
}
