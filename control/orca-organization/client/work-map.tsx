import React, { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import {
  copyText,
  PanSurface as HostPanSurface,
  type PanSurfaceProps,
} from "@getpaseo/plugin/client/react-native";
import * as pluginClient from "@getpaseo/plugin/client";
import { liveMapRows, EMPTY_NATIVE, type ActivityFilter } from "./live-map-model";
import type { Fleet } from "../shared/fleet";
import type { RemitsView } from "../shared/cc/remit";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useContract } from "./use-contract";
import { WorkButton } from "./work-button";
import { Details } from "./details";
import { lastGood } from "./last-good";
import { workMapProjectRpc, workMapRpc, type WorkMapProject } from "../shared/work-map";
import {
  ageText,
  buildOutline,
  CARD,
  changeAnnouncement,
  displayGlyph,
  freshness,
  layoutMap,
  LINK_STYLE,
  LIMITS,
  toggleExpanded,
  type Filter,
  type Freshness,
  type Row,
} from "./work-map-model";

/** Observation-only map. Opening an exact native chat/Changes view is explicit user navigation. */
// COMPAT(observedAgentCache): added in the next development build, remove after 2027-02-01 when the app floor supplies the hook.
const nativeApi = pluginClient as Partial<
  Pick<typeof pluginClient, "useObservedAgents" | "useHosts">
>;
const useNativeCache = nativeApi.useObservedAgents ?? (() => EMPTY_NATIVE);
const useNativeHosts = nativeApi.useHosts ?? (() => []);

export const OVERVIEW_POLL_MS = 15000,
  PROJECT_POLL_MS = 30000;

type Props = Pick<PluginSurfaceProps, "theme" | "layout" | "host" | "navigation"> & {
  fleet?: Fleet;
  remits?: RemitsView;
};

export function WorkMapSurface({ theme, layout, host, navigation, fleet, remits }: Props) {
  const c = theme.colors,
    text = { color: c.foreground },
    muted = { color: c.foregroundMuted };
  const hostId = host?.id ?? "";
  const readOverview = useContract(workMapRpc),
    readProject = useContract(workMapProjectRpc);
  const [frozen, setFrozen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState<string[] | null>(null);
  const [moreOpen, setMoreOpen] = useState<string[]>([]);
  const [view, setView] = useState<"list" | "map">(layout.compact ? "list" : "map");
  const [activity, setActivity] = useState<ActivityFilter>("active");
  const [hostFilter, setHostFilter] = useState("");
  const [projectFilter, setProjectFilter] = useState("");
  const native = useNativeCache();
  const nativeHosts = useNativeHosts();
  const scroll = useRef<ScrollView>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [workers, setWorkers] = useState(false);
  const [connections, setConnections] = useState(false);
  const [legend, setLegend] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [snapshot, setSnapshot] = useState<{
    native: typeof native;
    fleet?: Fleet;
    remits?: RemitsView;
    now: number;
  } | null>(null);
  const observed = snapshot ?? { native, fleet, remits, now };
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const overviewKey = ["orca-work-map", hostId];
  const overview = useQuery({
    queryKey: overviewKey,
    queryFn: () => readOverview({}),
    refetchInterval: frozen ? false : OVERVIEW_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: !frozen,
    retry: false,
  });
  // J0: a stalled read keeps showing the last good map (memory only), with one plain notice.
  const last = lastGood(overview, overviewKey, { now }),
    d = last.data;
  const open = expanded ?? [];
  const projectQueries = useQueries({
    queries: open.map((projectId) => ({
      queryKey: ["orca-work-map-project", hostId, projectId],
      queryFn: () => readProject({ projectId }),
      refetchInterval: frozen ? false : PROJECT_POLL_MS,
      refetchIntervalInBackground: false,
      refetchOnWindowFocus: !frozen,
      retry: false,
    })),
  });
  const projects: Record<string, WorkMapProject | undefined> = {};
  const projectStale: Record<string, boolean> = {};
  open.forEach((id, i) => {
    projects[id] = projectQueries[i]
      ? lastGood(projectQueries[i], ["orca-work-map-project", hostId, id], { now }).data
      : undefined;
    projectStale[id] =
      freshness(
        projectQueries[i]?.data?.observedAt,
        now,
        Boolean(projectQueries[i]?.isError),
        frozen,
      ) === "stale";
  });

  const fresh: Freshness = freshness(d?.observedAt, now, overview.isError, frozen);
  const projectsKey = JSON.stringify(Object.values(projects).map((p) => p?.observedAt));
  const openKey = open.join();
  const moreOpenKey = moreOpen.join();
  const outline = useMemo(
    () =>
      d ? buildOutline({ overview: d, projects, expanded: open, moreOpen, filter, search }) : null,
    // Rebuild on content keys, not on the identity of the project and expansion collections.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [d, projectsKey, openKey, moreOpenKey, filter, search],
  );
  const liveOutline = useMemo(
    () =>
      liveMapRows({
        rows: outline?.rows ?? [],
        fleet: observed.fleet,
        remits: observed.remits,
        native: observed.native,
        activity,
        host: hostFilter,
        project: projectFilter,
        search,
        now: observed.now,
      }),
    [
      outline,
      observed.fleet,
      observed.remits,
      observed.native,
      activity,
      hostFilter,
      projectFilter,
      search,
      observed.now,
    ],
  );
  const previous = useRef<Row[] | undefined>(undefined);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  useEffect(() => {
    if (!outline) return;
    setAnnouncement(changeAnnouncement(previous.current, outline.rows));
    previous.current = outline.rows;
    // Announce once per overview refresh, not whenever the outline is rebuilt for a filter or toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.observedAt]);

  const toggle = (row: Row) => {
    setSelected(row.id);
    scroll.current?.scrollTo({ y: 0, animated: false });
    if (row.kind === "project" && row.target.projectId) {
      setWorkers(true);
      setExpanded(toggleExpanded(open, row.target.projectId));
    } else if (row.kind === "more" && row.target.taskId)
      setMoreOpen([...moreOpen, row.target.taskId]);
    else setSelected(row.id);
  };
  const chosen = liveOutline.rows.find((r) => r.id === selected) ?? null;
  const header =
    fresh === "frozen"
      ? "Frozen"
      : fresh === "stale"
        ? `STALE · retained ${ageText(d?.observedAt, now)}`
        : `Observed ${ageText(d?.observedAt, now)}`;
  const dim = fresh === "stale" ? 0.6 : 1;

  const showAttention = !!d && d.attention.length > 0 && filter !== "attention";
  const attentionPanel = showAttention ? (
    <View
      accessibilityLabel={`Needs attention, ${d.attention.length}`}
      style={{
        gap: 6,
        padding: 12,
        borderWidth: 1,
        borderColor: c.border,
        borderRadius: 10,
        opacity: dim,
      }}
    >
      <Text style={{ ...text, fontWeight: "600" }}>⚠ Needs attention ({d.attention.length})</Text>
      {d.attention.slice(0, 8).map((a, i) => (
        <Pressable
          key={`${a.kind}:${i}`}
          accessibilityRole="button"
          accessibilityLabel={`Attention: ${a.detail}`}
          style={{ minHeight: 44, justifyContent: "center" }}
          onPress={() => {
            if (a.projectId && !open.includes(a.projectId))
              setExpanded(toggleExpanded(open, a.projectId));
            if (a.projectId) setSelected(`project:${a.projectId}`);
          }}
        >
          <Text style={text}>⚠ {a.detail}</Text>
        </Pressable>
      ))}
      {d.attention.length > 8 && (
        <Text style={muted}>Use the "Needs attention" filter to see all {d.attention.length}.</Text>
      )}
    </View>
  ) : null;

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      ref={scroll}
      testID="work-map"
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 14 }}
    >
      <Text accessibilityRole="header" style={{ ...text, fontSize: 24, fontWeight: "600" }}>
        Fulcra work map
      </Text>
      <Text
        accessibilityLiveRegion="polite"
        testID="work-map-freshness"
        style={{ ...text, fontWeight: "500" }}
      >
        {d ? header : overview.isError ? "Unavailable" : "Reading…"}
        {announcement ? ` · ${announcement}` : ""}
      </Text>
      {chosen && (
        <Detail
          key={chosen.id}
          row={chosen}
          theme={theme}
          navigation={navigation}
          now={observed.now}
        />
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <WorkButton
          theme={theme}
          label="Refresh work map"
          onPress={() => {
            void overview.refetch();
            projectQueries.forEach((q) => void q.refetch());
          }}
        >
          {overview.isFetching ? "Refreshing…" : "Refresh"}
        </WorkButton>
        <WorkButton
          theme={theme}
          label={frozen ? "Resume updates" : "Freeze updates"}
          selected={frozen}
          onPress={() => {
            setSnapshot(frozen ? null : { native, fleet, remits, now });
            setFrozen(!frozen);
          }}
        >
          {frozen ? "Resume" : "Freeze"}
        </WorkButton>
        <WorkButton
          theme={theme}
          label="Show list"
          selected={view === "list"}
          onPress={() => setView("list")}
        >
          List
        </WorkButton>
        <WorkButton
          theme={theme}
          label="Show map"
          selected={view === "map"}
          onPress={() => setView("map")}
        >
          Map
        </WorkButton>
        <WorkButton
          theme={theme}
          label="Status legend"
          expanded={legend}
          onPress={() => setLegend(!legend)}
        >
          {legend ? "Legend −" : "Legend +"}
        </WorkButton>
      </View>
      <TextInput
        accessibilityLabel="Search sessions, roles, workstreams and issues"
        value={search}
        onChangeText={(v) => setSearch(v.slice(0, 160))}
        placeholder="Search sessions, roles, issues…"
        placeholderTextColor={c.foregroundMuted}
        style={{
          color: c.foreground,
          padding: 12,
          borderWidth: 1,
          borderColor: c.border,
          borderRadius: 8,
        }}
      />
      <View
        style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
        accessibilityLabel="Activity filter"
      >
        {(
          [
            ["active", "Active / needs attention"],
            ["all", "All observed"],
          ] as const
        ).map(([value, label]) => (
          <WorkButton
            key={value}
            theme={theme}
            label={`Activity: ${label}`}
            selected={activity === value}
            onPress={() => setActivity(value)}
          >
            {label}
          </WorkButton>
        ))}
      </View>
      <Details theme={theme} label="More filters">
        {/* J0-10: say what the two less obvious controls do. */}
        <Text style={muted}>
          Freeze keeps this view still while you read; Resume brings it up to date. Legend explains
          the symbols.
        </Text>
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel="Filter"
          style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
        >
          {(
            [
              ["all", "All"],
              ["attention", "Needs attention"],
              ["delegated", "Fulcra controls this"],
              ["human", "You control this"],
            ] as const
          ).map(([key, label]) => (
            <Pressable
              key={key}
              accessibilityRole="radio"
              accessibilityLabel={`Filter: ${label}`}
              accessibilityState={{ checked: filter === key }}
              onPress={() => setFilter(key)}
              style={{
                minHeight: 44,
                paddingHorizontal: 12,
                justifyContent: "center",
                borderRadius: 22,
                borderWidth: 1,
                borderColor: filter === key ? (c.accent ?? c.foreground) : c.border,
              }}
            >
              <Text style={{ ...text, fontWeight: filter === key ? "700" : "400" }}>
                {filter === key ? "● " : "○ "}
                {label}
              </Text>
            </Pressable>
          ))}
        </View>
        <View
          style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
          accessibilityLabel="Native activity states"
        >
          {(
            [
              ["working", "Model turns"],
              ["idle", "Idle"],
              ["permission", "Permission"],
              ["error", "Error"],
              ["unknown", "Unknown"],
              ["unavailable", "Offline"],
            ] as const
          ).map(([value, label]) => (
            <WorkButton
              key={value}
              theme={theme}
              label={`Activity: ${label}`}
              selected={activity === value}
              onPress={() => setActivity(value)}
            >
              {label}
            </WorkButton>
          ))}
        </View>
        <Text style={muted}>
          Search covers expanded projects and cached native sessions. Creation links do not grant
          responsibility.
        </Text>
        <View
          style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
          accessibilityLabel="Host filter"
        >
          <WorkButton
            theme={theme}
            label="All hosts"
            selected={!hostFilter}
            onPress={() => setHostFilter("")}
          />
          {nativeHosts.map((host) => (
            <WorkButton
              key={host.serverId}
              theme={theme}
              label={`Host: ${host.label || "Unnamed host"}`}
              selected={hostFilter === host.serverId}
              onPress={() => setHostFilter(host.serverId)}
            />
          ))}
        </View>
        <TextInput
          accessibilityLabel="Filter project"
          value={projectFilter}
          onChangeText={(value) => setProjectFilter(value.slice(0, 160))}
          placeholder="Project name…"
          placeholderTextColor={c.foregroundMuted}
          style={{ ...text, minHeight: 44, padding: 12, borderWidth: 1, borderColor: c.border }}
        />
      </Details>
      <Text style={muted}>
        Prime seats are shown at the top; their reporting relationships are not recorded here.
      </Text>
      <Text testID="work-map-native-coverage" style={muted}>
        {nativeApi.useObservedAgents
          ? `${native.entries.length} of ${native.total} cached native sessions · this is not a full host roster`
          : "Update the Fulcra app to show cached native activity here."}
        {native.withheld
          ? ` · ${native.withheld} cached records have inconsistent host identity and cannot be opened`
          : ""}
        {native.truncated ? ` · ${native.truncated} outside the cache projection limit` : ""}
        {liveOutline.truncated
          ? ` · ${liveOutline.truncated} outside the ${LIMITS.rows}-row map limit`
          : ""}
      </Text>
      {legend && <Legend theme={theme} />}

      {!d && overview.isError && (
        <Text style={text}>
          Fulcra can't reach the controller on this host:{" "}
          {(overview.error as Error)?.message ?? "unavailable"}.
        </Text>
      )}
      {!d && overview.isPending && <Text style={muted}>Reading roles, projects and sessions…</Text>}
      {d && last.notice && (
        <Text accessibilityLiveRegion="polite" testID="work-map-stall" style={text}>
          {last.notice}
        </Text>
      )}
      {d && !d.available && (
        <Text style={text}>
          Recorded seats could not be read ({d.unavailable}). No orchestrator can be named or ruled
          out.
        </Text>
      )}
      {d && d.available && d.primes.length === 0 && d.projects.every((p) => !p.seat) && (
        <Text style={text}>
          No prime or project orchestrator is recorded yet. Seats are assigned in Leadership.
        </Text>
      )}
      {d && !d.sources.projects.available && (
        <Text style={muted}>
          Project membership unknown; seats are still shown. {d.sources.projects.note}
        </Text>
      )}
      {d && !d.sources.fleet.available && (
        <Text style={muted}>
          Session runtime unavailable; control modes and seats are still shown.
        </Text>
      )}

      {/* J6 (J5 walkthrough): in Map view the attention panel (up to eight rows) pushed the graph below the fold.
        The map now comes first with a one-line count; the full panel follows it. List view is unchanged. */}
      {showAttention && view === "list" && attentionPanel}
      {showAttention && view === "map" && (
        <Text
          accessibilityLabel={`Needs attention, ${d!.attention.length}, listed below the map`}
          style={{ ...text, fontWeight: "600", opacity: dim }}
        >
          ⚠ {d!.attention.length} need attention, listed below the map
        </Text>
      )}

      {liveOutline.rows.length === 0 && (
        <View style={{ gap: 8 }}>
          <Text style={text}>Nothing matches these filters.</Text>
          <WorkButton
            theme={theme}
            label="Clear filters"
            onPress={() => {
              setFilter("all");
              setSearch("");
              setActivity("all");
              setHostFilter("");
              setProjectFilter("");
            }}
          />
        </View>
      )}
      {view === "list" && (
        <View
          accessibilityRole="list"
          accessibilityLabel="Fulcra work outline"
          style={{ gap: 4, opacity: dim }}
        >
          {liveOutline.rows.map((row) => (
            <OutlineRow
              key={row.id}
              row={row}
              fresh={
                row.observedAt
                  ? freshness(row.observedAt, now, false, frozen)
                  : projectStale[row.target.projectId ?? ""]
                    ? "stale"
                    : fresh
              }
              selected={row.id === selected}
              theme={theme}
              onPress={() => toggle(row)}
            />
          ))}
        </View>
      )}
      {view === "map" && (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <WorkButton
            theme={theme}
            label={workers ? "Hide worker detail" : "Show active workers"}
            selected={workers}
            onPress={() => setWorkers((value) => !value)}
          />
          <WorkButton
            theme={theme}
            label={connections ? "Hide connections" : "Show recorded connections"}
            selected={connections}
            onPress={() => setConnections((value) => !value)}
          />
        </View>
      )}
      {view === "map" && (
        <MapView
          rows={
            workers
              ? liveOutline.rows
              : liveOutline.rows.filter(
                  (row) =>
                    row.kind === "prime" || row.kind === "project" || row.kind === "unplaced",
                )
          }
          connections={connections}
          fresh={fresh}
          selected={selected}
          theme={theme}
          native={layout.platform === "ios" || layout.platform === "android"}
          onPress={toggle}
        />
      )}
      {showAttention && view === "map" && attentionPanel}
      {outline && outline.hidden > 0 && (
        <Text style={muted}>{outline.hidden} hidden by the current filter or search.</Text>
      )}

      {liveOutline.hidden > 0 && (
        <Text style={muted}>
          {liveOutline.hidden} items hidden by activity, host or project filters.
        </Text>
      )}
      {d && <Text style={muted}>{d.note}</Text>}
    </ScrollView>
  );
}

function OutlineRow({
  row,
  fresh,
  selected,
  theme,
  onPress,
}: { row: Row; fresh: Freshness; selected: boolean; onPress: () => void } & Pick<
  PluginSurfaceProps,
  "theme"
>) {
  const c = theme.colors;
  if (row.kind === "notice")
    return (
      <Text style={{ color: c.foregroundMuted, paddingLeft: 12 + row.depth * 16 }}>
        {row.glyph} {row.title}
      </Text>
    );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={row.label}
      accessibilityState={{ selected, expanded: row.expandable ? row.expanded : undefined }}
      onPress={onPress}
      style={{
        minHeight: 44,
        paddingLeft: 8 + row.depth * 16,
        paddingRight: 8,
        paddingVertical: 6,
        borderRadius: 8,
        borderWidth: selected ? 2 : 0,
        borderColor: c.accent ?? c.foreground,
        backgroundColor: selected ? (c.surface2 ?? c.surface1) : "transparent",
      }}
    >
      <Text
        style={{
          color: c.foreground,
          fontWeight: row.kind === "project" || row.kind === "prime" ? "600" : "400",
        }}
      >
        {row.expandable ? (row.expanded ? "▾ " : "▸ ") : ""}
        {displayGlyph(row.glyph, fresh)} {row.title}
      </Text>
      {row.detail ? (
        <Text style={{ color: c.foregroundMuted }}>
          {fresh === "stale" ? "last observed · " : ""}
          {row.detail}
        </Text>
      ) : null}
    </Pressable>
  );
}

function Detail({
  row,
  theme,
  navigation,
  now,
}: { row: Row; now: number } & Pick<PluginSurfaceProps, "theme" | "navigation">) {
  const c = theme.colors,
    [copied, setCopied] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const nativeTarget =
    row.target.serverId && row.target.agentId
      ? { serverId: row.target.serverId, agentId: row.target.agentId }
      : null;
  const id =
    row.target.agentId ?? row.target.sessionId ?? row.target.taskId ?? row.target.projectId ?? null;
  return (
    <View
      accessibilityLabel={`Detail for ${row.title}`}
      style={{ gap: 6, padding: 12, borderWidth: 1, borderColor: c.border, borderRadius: 10 }}
    >
      <Text style={{ color: c.foreground, fontWeight: "600" }}>{row.title}</Text>
      <Text selectable style={{ color: c.foreground }}>
        {row.detail}
      </Text>
      {row.responsibility && <Text style={{ color: c.foreground }}>{row.responsibility}</Text>}
      {row.projectName && (
        <Text style={{ color: c.foregroundMuted }}>Project / context: {row.projectName}</Text>
      )}
      {row.creationParent && (
        <Text style={{ color: c.foregroundMuted }}>
          Creation ancestry: {row.creationParent}. This is separate from reporting responsibility.
        </Text>
      )}
      {row.observedAt && (
        <Text style={{ color: c.foregroundMuted }}>
          Native observation {ageText(row.observedAt, now)};{" "}
          {row.connection ?? "connection unknown"}.
          {freshness(row.observedAt, now, false, false) === "stale"
            ? " Last observed activity may be out of date."
            : ""}
        </Text>
      )}
      <WorkButton
        theme={theme}
        label="Open exact conversation"
        disabled={!nativeTarget || !navigation?.openAgentOnHost}
        onPress={() => {
          try {
            const result = navigation!.openAgentOnHost!(nativeTarget!);
            setMessage(
              result === "requested"
                ? "Opening the selected host conversation…"
                : "This host is unavailable. Check Fulcra Hosts, then retry.",
            );
          } catch {
            setMessage("Could not open this conversation. Check Fulcra Hosts, then retry.");
          }
        }}
      />
      <WorkButton
        theme={theme}
        label="Open native Changes"
        disabled={!nativeTarget || !row.changesAvailable || !navigation?.openAgentChangesOnHost}
        onPress={() => {
          try {
            const result = navigation!.openAgentChangesOnHost!(nativeTarget!);
            setMessage(
              result === "requested"
                ? "Opening this agent's native Changes view…"
                : "Changes are unavailable on this host or workspace. Open its conversation, reconnect the host and retry.",
            );
          } catch {
            setMessage(
              "Changes could not be opened. Open the conversation and use its Changes control.",
            );
          }
        }}
      />
      {!nativeTarget && (
        <Text style={{ color: c.foregroundMuted }}>
          The original host and agent identity are not available. Open the recorded host in Fulcra
          Hosts to find its conversation.
        </Text>
      )}
      {!row.changesAvailable && (
        <Text style={{ color: c.foregroundMuted }}>
          Changes require an online host and a known Git workspace. Open the conversation and
          reconnect the host to inspect its Changes.
        </Text>
      )}
      {!!message && (
        <Text accessibilityLiveRegion="polite" style={{ color: c.foregroundMuted }}>
          {message}
        </Text>
      )}
      {id && (
        <Details theme={theme}>
          {row.target.sessionId && (
            <Text selectable style={{ color: c.foregroundMuted }}>
              Session {row.target.sessionId}
            </Text>
          )}
          {row.target.taskId && (
            <Text selectable style={{ color: c.foregroundMuted }}>
              Task {row.target.taskId}
            </Text>
          )}
          {row.target.projectId && (
            <Text selectable style={{ color: c.foregroundMuted }}>
              Project {row.target.projectId}
            </Text>
          )}
          <WorkButton
            theme={theme}
            label={`Copy id ${id}`}
            onPress={() => {
              void copyText(id).then(
                () => setCopied("Copied"),
                () => setCopied("Copying is unavailable here; select the id above."),
              );
            }}
          >
            Copy id
          </WorkButton>
          {copied && (
            <Text accessibilityLiveRegion="polite" style={{ color: c.foregroundMuted }}>
              {copied}
            </Text>
          )}
        </Details>
      )}
    </View>
  );
}

function Legend({ theme }: Pick<PluginSurfaceProps, "theme">) {
  const c = theme.colors,
    line = { color: c.foreground };
  return (
    <View
      accessibilityLabel="Status legend"
      style={{ gap: 4, padding: 12, borderWidth: 1, borderColor: c.border, borderRadius: 10 }}
    >
      <Text style={{ ...line, fontWeight: "600" }}>Legend</Text>
      <Text style={line}>
        Native model activity requires an observed open turn. A resident process alone is not
        working. Runtime: ● reported running · ◐ waiting for permission · ○ idle — not done · ✕
        error · ? runtime unavailable
      </Text>
      <Text style={line}>Control: Fulcra controls this · you control this · changing</Text>
      <Text style={line}>
        Orchestrator: assigned · none yet · held by you · session gone · restarted since it was
        assigned · moved to other work
      </Text>
      <Text style={line}>
        Recorded responsibility is distinct from a message channel and creation ancestry. Unassigned
        means no relationship in this observation.
      </Text>
      <Text style={line}>Issues: open · in progress · blocked · done · cancelled · unknown</Text>
      <Text style={line}>Freshness: live · STALE (dimmed, hollow ⊙ ◌ ⊗ ◇ □ ▭) · frozen</Text>
      {Object.values(LINK_STYLE).map((s) => (
        <Text key={s.words} style={{ color: c.foregroundMuted }}>
          {s.dashed ? "╌╌" : s.weight > 2 ? "━━" : "──"} {s.words}
        </Text>
      ))}
    </View>
  );
}

/** Native pan where the host provides it; buttons everywhere. Same split as the Live work graph. */
function Viewport({
  nativePan,
  onPanStart,
  onPanUpdate,
  onPanEnd,
  ...props
}: PanSurfaceProps & { nativePan: boolean }) {
  return nativePan && HostPanSurface ? (
    <HostPanSurface
      {...props}
      onPanStart={onPanStart}
      onPanUpdate={onPanUpdate}
      onPanEnd={onPanEnd}
    />
  ) : (
    <View {...props} />
  );
}

function MapView({
  rows,
  fresh,
  selected,
  theme,
  native,
  onPress,
  connections,
}: {
  connections: boolean;
  rows: Row[];
  fresh: Freshness;
  selected: string | null;
  native: boolean;
  onPress: (row: Row) => void;
} & Pick<PluginSurfaceProps, "theme">) {
  const c = theme.colors;
  const graph = useMemo(() => layoutMap(rows), [rows]);
  const [zoom, setZoom] = useState(1),
    [offset, setOffset] = useState({ x: 0, y: 0 }),
    [viewport, setViewport] = useState({ width: 320, height: 320 });
  const start = useRef(offset);
  const clamp = (x: number, y: number) => ({
    x: Math.max(0, Math.min(x, Math.max(0, graph.width * zoom - viewport.width))),
    y: Math.max(0, Math.min(y, Math.max(0, graph.height * zoom - viewport.height))),
  });
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {(
          [
            [
              "Fit map",
              () => {
                setZoom(
                  Math.min(
                    1,
                    Math.max(1, viewport.width - 24) / graph.width,
                    Math.max(1, viewport.height - 24) / graph.height,
                  ),
                );
                setOffset({ x: 0, y: 0 });
              },
            ],
            [
              "Focus selection",
              () => {
                const node = selected ? byId.get(selected) : undefined;
                if (node) {
                  setZoom(1);
                  setOffset({ x: Math.max(0, node.x - 24), y: Math.max(0, node.y - 24) });
                }
              },
            ],
            ["Zoom out", () => setZoom((z) => Math.max(0.5, z - 0.25))],
            ["Zoom in", () => setZoom((z) => Math.min(2, z + 0.25))],
            [
              "Reset map",
              () => {
                setZoom(1);
                setOffset({ x: 0, y: 0 });
              },
            ],
            ["Pan left", () => setOffset(clamp(offset.x - 220, offset.y))],
            ["Pan right", () => setOffset(clamp(offset.x + 220, offset.y))],
            ["Pan up", () => setOffset(clamp(offset.x, offset.y - 160))],
            ["Pan down", () => setOffset(clamp(offset.x, offset.y + 160))],
          ] as const
        ).map(([label, fn]) => (
          <WorkButton
            key={label}
            theme={theme}
            label={label}
            onPress={fn}
            disabled={label === "Focus selection" && !selected}
          />
        ))}
      </View>
      <Viewport
        nativePan={native}
        onPanStart={() => {
          start.current = offset;
        }}
        onPanUpdate={({ x, y }) => setOffset(clamp(start.current.x - x, start.current.y - y))}
        onPanEnd={() => undefined}
        testID="work-map-viewport"
        accessibilityLabel="Fulcra work map; the list shows every item"
        onLayout={(e) =>
          setViewport({
            width: Math.max(1, e.nativeEvent.layout.width),
            height: Math.max(1, e.nativeEvent.layout.height),
          })
        }
        style={{
          height: 520,
          overflow: "hidden",
          borderWidth: 1,
          borderColor: c.border,
          borderRadius: 12,
          backgroundColor: c.surface0,
          opacity: fresh === "stale" ? 0.6 : 1,
        }}
      >
        {connections &&
          graph.edges.map((edge) => {
            const a = byId.get(edge.from)!,
              b = byId.get(edge.to)!,
              style = LINK_STYLE[edge.kind];
            const x1 = (a.x + CARD.width) * zoom - offset.x,
              y1 = (a.y + CARD.height / 2) * zoom - offset.y,
              x2 = b.x * zoom - offset.x,
              y2 = (b.y + CARD.height / 2) * zoom - offset.y;
            if (
              Math.max(x1, x2) < 0 ||
              Math.min(x1, x2) > viewport.width ||
              Math.max(y1, y2) < 0 ||
              Math.min(y1, y2) > viewport.height
            )
              return null;
            const width = Math.max(2, Math.hypot(x2 - x1, y2 - y1)),
              angle = Math.atan2(y2 - y1, x2 - x1);
            return (
              <View
                key={edge.id}
                pointerEvents="none"
                accessible={false}
                style={{
                  position: "absolute",
                  left: (x1 + x2) / 2 - width / 2,
                  top: (y1 + y2) / 2,
                  width,
                  borderTopWidth: style.weight,
                  borderColor:
                    edge.kind === "parent" || edge.kind === "channel" ? c.foreground : c.border,
                  borderStyle: style.dashed ? "dashed" : "solid",
                  transform: [{ rotate: `${angle}rad` }],
                }}
              />
            );
          })}
        {graph.nodes
          .filter(
            (n) =>
              n.x * zoom + CARD.width * zoom >= offset.x &&
              n.x * zoom <= offset.x + viewport.width &&
              n.y * zoom + CARD.height * zoom >= offset.y &&
              n.y * zoom <= offset.y + viewport.height,
          )
          .map((n) => (
            <Pressable
              key={n.id}
              accessibilityRole="button"
              accessibilityLabel={n.row.label}
              accessibilityState={{
                selected: n.id === selected,
                expanded: n.row.expandable ? n.row.expanded : undefined,
              }}
              onPress={() => onPress(n.row)}
              style={{
                position: "absolute",
                left: n.x * zoom - offset.x,
                top: n.y * zoom - offset.y,
                width: CARD.width * zoom,
                height: CARD.height * zoom,
                padding: 8 * zoom,
                gap: 2,
                borderRadius: 12,
                borderWidth: n.id === selected ? 2 : 1,
                borderColor: n.id === selected ? (c.accent ?? c.foreground) : c.border,
                backgroundColor: c.surface1 ?? c.surface0,
              }}
            >
              <Text
                numberOfLines={1}
                style={{
                  color: c.foreground,
                  fontWeight: "600",
                  fontSize: Math.max(11, 13 * zoom),
                }}
              >
                {n.row.expandable ? (n.row.expanded ? "▾ " : "▸ ") : ""}
                {displayGlyph(n.row.glyph, fresh)} {n.row.title}
              </Text>
              {zoom >= 0.75 && (
                <Text
                  numberOfLines={2}
                  style={{ color: c.foregroundMuted, fontSize: Math.max(10, 11 * zoom) }}
                >
                  {n.row.detail}
                </Text>
              )}
            </Pressable>
          ))}
      </Viewport>
      <Text style={{ color: c.foregroundMuted }}>
        {graph.nodes.length} nodes · {graph.edges.length} links · {Math.round(zoom * 100)}% · Use
        List for full-size labels; Fit shows an overview; List and Focus selection keep labels
        readable.
      </Text>
    </View>
  );
}
