import { workName, sessionName, sessionStatus, sessionRole } from "./work-labels";
import { projectsRpc } from "../shared/projects";
import { WorkBrief } from "./work-brief";
import { ConversationUpdates } from "./conversation-updates";
import { QuotaWaitCard, quotaLabel, quotaIsStale } from "./quota-wait";
import {
  PanSurface as HostPanSurface,
  PanScrollView as HostPanScrollView,
} from "@getpaseo/plugin/client/react-native";
import { OriginalConversation } from "./original-conversation";
import { WorkButton } from "./work-button";
import { useWorkView } from "./work-view";
import { WorkGraph, type GraphIntent } from "./work-graph";
import type { GraphPage } from "./work-graph-layout";
import type { ReactNode } from "react";
import { historyRpc, type HistoryCursor } from "../shared/history";
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRpc, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useContract } from "./use-contract";
import { View, Text, Pressable, ScrollView, TextInput } from "react-native";
import { fleetRpc, fleetHostsRpc, type Fleet } from "../shared/fleet";
import { trackersRpc } from "../shared/trackers";
import { lastGood } from "./last-good";
import { StepThrough } from "./step-through";
import {
  useLiveHostOverlay,
  describeLiveState,
  isWorkingForDisplay,
  useAppHostList,
  displayHostName,
  plainNodeError,
  useAppLinkSections,
  allHostsLabel,
  appLinkTargets,
  fleetReadState,
} from "./fleet-live";
import { FLEET_AUTO_RETRY_LIMIT } from "./fleet-live-model";
import { AppLinkSections } from "./fleet-app-link";
type Node = Fleet["nodes"][number];
const NO_NODES: Node[] = [];
// Update-7: "Started by <parent> · implementation · account Work". A parent outside this page is named by id prefix.
export function ownershipLine(node: Node, fleet?: Fleet) {
  const parent = node.parent ? fleet?.nodes.find((n) => n.id === node.parent) : null;
  const who = node.parent
    ? `Started by ${parent ? parent.title : `session ${node.parent.slice(0, 8)}`}${node.origin === "spawned" ? " (from inside that session)" : ""}`
    : node.origin === "spawned"
      ? "Started from inside a session"
      : "Started by you or the controller";
  return [
    who,
    node.role ? `role ${node.role}` : null,
    node.account ? `account ${node.account.name}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}
export function Activity({
  node,
  theme,
  navigation,
  frozen,
  host,
  graph,
  quotaStale,
  fleet,
  layout,
  liveLine = null,
  hostLabel,
  errorText,
}: {
  node: Node;
  fleet?: Fleet;
  frozen: boolean;
  quotaStale: boolean;
  graph?: (page: GraphPage) => ReactNode;
  /** Display only: never an input to an action below. */ liveLine?: string | null;
  /** Display name for the node's host. */ hostLabel?: string;
  /** Plain-words version of node.error, for display. */ errorText?: string | null;
} & PluginSurfaceProps) {
  const read = useContract(historyRpc),
    colors = theme.colors;
  const [evidenceOpen, showEvidence] = useState(false),
    [stepping, setStepping] = useState(false);
  const [cursor, setCursor] = useState<HistoryCursor | null>(null),
    retained = useRef<Awaited<ReturnType<typeof read>> | null>(null),
    presentedHistorical = useRef(false);
  const query = useQuery({
    queryKey: ["orca-activity-history-messages", host?.id, node.task, node.id, cursor],
    queryFn: () => read({ taskId: node.task, sessionId: node.id, cursor, includeMessages: true }),
    refetchInterval: frozen || cursor ? false : 15000,
    refetchOnWindowFocus: !frozen && !cursor,
    retry: false,
    gcTime: 0,
    placeholderData: (previous) => previous,
  });
  if (query.data && !query.isPlaceholderData) {
    retained.current = query.data;
    presentedHistorical.current = !!cursor;
  }
  const d = query.data ?? retained.current,
    text = { color: colors.foreground },
    muted = { color: colors.foregroundMuted };
  const summary = (
    <View
      style={{
        padding: 20,
        gap: 12,
        backgroundColor: colors.surface1 ?? colors.surface0,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 20,
      }}
    >
      <Text style={{ ...muted, fontSize: 12, fontWeight: "600", letterSpacing: 1 }}>
        SELECTED SESSION
      </Text>
      <Text style={{ ...text, fontSize: 22, fontWeight: "600" }}>{sessionName(node, fleet)}</Text>
      <Text style={muted}>
        {hostLabel ?? node.host} · {node.provider} · {node.model ?? "model not reported"} ·{" "}
        {node.effort ? `effort ${node.effort}` : "effort not reported"}
      </Text>
      {/* Update-7: who started it, its role and the account it runs on. */}
      <Text testID="fleet-ownership" style={muted}>
        {ownershipLine(node, fleet)}
      </Text>
      <Text style={{ ...text, fontWeight: "500" }}>
        {sessionStatus(node, quotaStale)}
        {node.mode === "human" ? " · You have control" : ""}
      </Text>
      {liveLine && (
        <Text testID="fleet-live-line" style={muted}>
          {liveLine}
        </Text>
      )}
      {fleet && (
        <Text style={muted}>
          {sessionRole(node, fleet)} ·{" "}
          {workName(fleet.tasks.find((t) => t.id === node.task)?.title)}
        </Text>
      )}
      {node.quotaWait && (
        <QuotaWaitCard
          wait={node.quotaWait}
          theme={theme}
          stale={quotaStale || quotaIsStale(node.quotaObservedAt)}
        />
      )}
      {node.error && <Text style={text}>{errorText ?? node.error}</Text>}
      <OriginalConversation
        key={`${node.host}:${node.serverId}:${node.agentId}`}
        targetServerId={node.serverId}
        targetHost={node.host}
        agentId={node.agentId}
        host={host}
        navigation={navigation}
        theme={theme}
      />
      <WorkButton theme={theme} label="Step through this session" onPress={() => setStepping(true)}>
        Step through this session
      </WorkButton>
    </View>
  );
  // J6: replay the session turn by turn, under the task title.
  if (stepping)
    return (
      <StepThrough
        sessionId={node.id}
        taskId={node.task}
        provider={node.provider}
        title={sessionName(node, fleet)}
        taskTitle={fleet ? workName(fleet.tasks.find((t) => t.id === node.task)?.title) : null}
        theme={theme}
        layout={layout}
        host={host}
        onClose={() => setStepping(false)}
      />
    );
  const scope = (
    <View style={{ gap: 8 }}>
      {query.isError && (
        <Text style={text}>Activity unavailable. Retained details below are stale.</Text>
      )}
      {cursor && (
        <Text style={muted}>
          {presentedHistorical.current
            ? "Historical page · automatic updates paused"
            : "Activity updates paused · previous page retained"}
        </Text>
      )}
      {query.isError && <Text style={muted}>Return to latest to restart activity history.</Text>}
      {query.isFetching && d && (
        <Text style={muted}>Loading requested page; retained details shown below.</Text>
      )}
      {!d && (
        <Text style={muted}>
          {query.isPending ? "Reading confirmed activity…" : "No activity observation"}
        </Text>
      )}
      {d && (
        <Text style={muted}>Conversation history and technical trace are available below.</Text>
      )}
    </View>
  );
  const paging = (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      <WorkButton
        theme={theme}
        label="Load older activity"
        disabled={query.isFetching || query.isError || !d?.cursor}
        onPress={() => {
          if (d?.cursor) setCursor(d.cursor);
        }}
      >
        {query.isFetching ? "Reading activity…" : "Older activity"}
      </WorkButton>
      <WorkButton
        theme={theme}
        label="Return to latest activity"
        onPress={() => {
          setCursor(null);
          if (!cursor) void query.refetch();
        }}
      >
        Latest activity
      </WorkButton>
    </View>
  );
  const details = (
    <View
      style={{
        padding: 16,
        gap: 10,
        backgroundColor: colors.surface1 ?? colors.surface0,
        borderRadius: 16,
      }}
    >
      <Text selectable style={muted}>
        Session: {node.id} · Task: {node.task}
      </Text>
      <Text selectable style={muted}>
        Recorded title: {node.title}
      </Text>
      <Text style={muted}>Native state: {node.status}</Text>
      <Text style={muted}>Session status describes activity, not task completion.</Text>
      <Text style={muted}>State observed: {node.observedAt ?? "unknown"}</Text>
      <Text style={muted}>Native update: {node.updatedAt ?? "unknown"}</Text>
      {d && (
        <>
          <Text style={muted}>Activity observed: {d.observedAt}</Text>
          <Text style={{ ...text, fontWeight: "600" }}>Instruction and delivery receipts</Text>
          {!d.receipts.length && <Text style={muted}>No recent receipt evidence available</Text>}
          {d.receipts.map((r) => (
            <View
              key={r.id}
              style={{ borderLeftWidth: 2, borderColor: colors.border, paddingLeft: 12, gap: 4 }}
            >
              <Text style={text}>
                {r.kind} → {r.state}
                {r.notification ? " → " + r.notification : ""}
              </Text>
              <Text selectable style={muted}>
                {r.id}
              </Text>
              {r.evidenceHash && (
                <Text selectable style={muted}>
                  Reported output hash (unverified): {r.evidenceHash}
                </Text>
              )}
            </View>
          ))}
          {!!d.activity.length && (
            <Text style={{ ...text, fontWeight: "600" }}>Native activity → reported files</Text>
          )}
          {d.activity.map((a, index) => (
            <View
              key={a.id + index}
              style={{ borderLeftWidth: 2, borderColor: colors.border, paddingLeft: 12, gap: 4 }}
            >
              <Text style={text}>
                {a.label}
                {a.state ? " · " + a.state : ""}
              </Text>
              {a.files.map((f) => (
                <Text key={f} selectable style={muted}>
                  ↳ {f}
                </Text>
              ))}
            </View>
          ))}
        </>
      )}
    </View>
  );
  return (
    <View style={{ gap: 16 }}>
      {summary}
      {scope}
      {d && (
        <ConversationUpdates
          key={cursor?.seq ?? "latest"}
          messages={d.messages}
          references={
            fleet
              ? new Map([
                  ...fleet.tasks.map((t) => [t.id.toLowerCase(), workName(t.title)] as const),
                  ...fleet.nodes.map((n) => [n.id.toLowerCase(), sessionName(n, fleet)] as const),
                ])
              : undefined
          }
          historical={presentedHistorical.current}
          stale={query.isError}
          theme={theme}
        />
      )}
      {paging}
      {graph?.({
        data: evidenceOpen ? (d ?? undefined) : undefined,
        historical: presentedHistorical.current,
        stale: query.isError,
        loading: query.isFetching,
      })}
      {
        <WorkButton
          theme={theme}
          label="Session evidence"
          expanded={evidenceOpen}
          onPress={() => showEvidence(!evidenceOpen)}
        >
          {evidenceOpen ? "Hide session evidence −" : "Session evidence +"}
        </WorkButton>
      }
      {evidenceOpen && (
        <>
          {d && <Text style={muted}>{d.note}</Text>}
          {details}
        </>
      )}
    </View>
  );
}
function GraphMode({
  fleet,
  shown,
  selected,
  chosen,
  frozen,
  stale,
  onSelect,
  onExit,
  onFreeze,
  savedIntent,
  onIntentChange,
  ...props
}: PluginSurfaceProps & {
  onTask: (id: string) => void;
  fleet: Fleet;
  shown: Node[];
  selected: string | null;
  chosen?: Node;
  frozen: boolean;
  stale: boolean;
  onSelect: (id: string) => void;
  onExit: () => void;
  onFreeze: () => void;
  savedIntent: GraphIntent | null;
  onIntentChange: (value: GraphIntent) => void;
}) {
  const intent = useRef<GraphIntent | null>(savedIntent),
    c = props.theme.colors;
  // J3: linked tracker items for the work on screen — opt-in, so the default graph makes no extra request.
  // Polled only while shown and the graph is open; frozen pauses it.
  const [showTrackers, setShowTrackers] = useState(false);
  const readTrackers = useRpc(trackersRpc);
  const subjects = useMemo(
    () => [...new Set([...shown.map((n) => n.task), ...shown.map((n) => n.id)])].slice(0, 64),
    [shown],
  );
  const trackerQuery = useQuery({
    queryKey: ["orca-trackers", props.host?.id, subjects],
    queryFn: () => readTrackers({ subjects }),
    enabled: showTrackers && subjects.length > 0,
    refetchInterval: frozen ? false : 60000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  const native = props.layout.platform === "android" || props.layout.platform === "ios";
  const nativePan = native && !!HostPanSurface && !!HostPanScrollView;
  const PageScroll = nativePan ? HostPanScrollView : ScrollView;
  const field = (page?: GraphPage) => (
    <WorkGraph
      fleet={fleet}
      shown={shown}
      selected={selected}
      page={page}
      stale={stale}
      frozen={frozen}
      theme={props.theme}
      onSelect={onSelect}
      onTask={props.onTask}
      intent={intent}
      onIntentChange={onIntentChange}
      compact={props.layout.compact}
      nativePan={nativePan}
      touchUnavailable={native && !nativePan}
      trackers={showTrackers ? trackerQuery.data : undefined}
    />
  );
  return (
    <PageScroll
      testID="work-graph-page"
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: props.layout.compact ? 16 : 24, gap: 20 }}
    >
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <WorkButton theme={props.theme} label="Back to work list" onPress={onExit}>
          ← Work list
        </WorkButton>
        <WorkButton
          theme={props.theme}
          label={frozen ? "Resume updates" : "Freeze view"}
          onPress={onFreeze}
        />
        <WorkButton
          theme={props.theme}
          label={showTrackers ? "Hide linked tracker items" : "Show linked tracker items"}
          selected={showTrackers}
          onPress={() => setShowTrackers(!showTrackers)}
        />
      </View>
      {chosen && (
        <WorkBrief
          taskId={chosen.task}
          frozen={frozen}
          onTask={props.onTask}
          theme={props.theme}
          host={props.host}
        />
      )}
      {chosen ? (
        <Activity
          key={[props.host?.id, chosen.task, chosen.id].join(":")}
          node={chosen}
          fleet={fleet}
          frozen={frozen}
          quotaStale={stale}
          {...props}
          graph={field}
        />
      ) : (
        field()
      )}
    </PageScroll>
  );
}
export function FleetSurface(props: PluginSurfaceProps & { onTask: (id: string) => void }) {
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);
  const [technical, showTechnical] = useState(false),
    [taskLimit, setTaskLimit] = useState(8);
  const scroll = useRef<ScrollView>(null),
    [{ graphOpen, host, search, selected, frozen, graphIntent }, updateView] = useWorkView(
      props.host?.id,
    );
  const openGraph = (graphOpen: boolean) => updateView({ graphOpen }),
    setHost = (host: string) => {
      setOffset(0);
      updateView({ host, selected: null, graphIntent: null });
    },
    setSearch = (search: string) => {
      setOffset(0);
      updateView({ search, selected: null, graphIntent: null });
    },
    select = (selected: string | null) => updateView({ selected }),
    freeze = (frozen: boolean) => updateView({ frozen });
  const [serverSearch, setServerSearch] = useState(search);
  useEffect(() => {
    const timer = setTimeout(() => setServerSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const saveIntent = useCallback(
    (graphIntent: GraphIntent) => updateView({ graphIntent }),
    [updateView],
  );
  const read = useContract(fleetRpc),
    readProjects = useContract(projectsRpc);
  const directory = useQuery({
    queryKey: ["orca-projects", props.host?.id],
    queryFn: async () => projectsRpc.output.parse(await readProjects({})),
    refetchInterval: frozen ? false : 30000,
    refetchOnWindowFocus: !frozen,
    retry: false,
  });
  const directoryAge = now - Date.parse(directory.data?.observedAt ?? ""),
    projectStale =
      directory.isError ||
      !Number.isFinite(directoryAge) ||
      directoryAge > 45000 ||
      directoryAge < -5000;
  const projectName = (task: string) => {
    const id = directory.data?.membership.find((m) => m.taskId === task)?.projectId;
    return directory.data?.projects.find((p) => p.id === id)?.name;
  };
  // MH4 (J15): the configured Macs come from the plugin's own config, so the machine switch and the app-link
  // lists work even when the fleet read fails.
  const readHosts = useContract(fleetHostsRpc);
  const hostList = useQuery({
    queryKey: ["orca-fleet-hosts", props.host?.id],
    queryFn: () => readHosts({}),
    refetchInterval: frozen ? false : 60000,
    refetchOnWindowFocus: !frozen,
    retry: false,
  });
  // Bounded retries: after FLEET_AUTO_RETRY_LIMIT failures in a row with nothing to show, the page stops refetching
  // on its own and says why; "Try again" starts over. Counted per view (host, search, page).
  const fleetKey = JSON.stringify([props.host?.id, serverSearch, host, offset]);
  const errorsAtSuccess = useRef(new Map<string, number>());
  const failuresOf = (errorCount: number) =>
    errorCount - (errorsAtSuccess.current.get(fleetKey) ?? 0);
  const query = useQuery({
    queryKey: ["orca-fleet", props.host?.id, serverSearch, host, offset],
    queryFn: () => read({ search: serverSearch, host, offset }),
    refetchInterval: (q) =>
      frozen ||
      (q.state.status === "error" &&
        !q.state.data &&
        failuresOf(q.state.errorUpdateCount) >= FLEET_AUTO_RETRY_LIMIT)
        ? false
        : 15000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: !frozen,
    refetchOnMount: !frozen,
    retry: false,
  });
  useEffect(() => {
    if (query.isSuccess) errorsAtSuccess.current.set(fleetKey, query.errorUpdateCount);
  }, [fleetKey, query.isSuccess, query.dataUpdatedAt, query.errorUpdateCount]);
  const tryAgain = () => {
    errorsAtSuccess.current.set(fleetKey, query.errorUpdateCount);
    void query.refetch();
    void hostList.refetch();
  };
  // J0: a stalled read keeps the last good sessions list (memory only) and says so in one plain notice.
  const last = lastGood(query, ["orca-fleet", props.host?.id, serverSearch, host, offset], { now });
  const d = last.data,
    c = props.theme.colors,
    text = { color: c.foreground },
    muted = { color: c.foregroundMuted },
    chosen = d?.nodes.find((n) => n.id === selected);
  const shown = d?.nodes ?? NO_NODES;
  // Live state from this app's own host connections (MULTIHOST-DESIGN §5.2). Display only: it feeds the text
  // lines and the "Working now" count below, and nothing an action receives.
  const live = useLiveHostOverlay(shown, d?.hosts?.[0] ?? null, frozen);
  const liveLineFor = (id: string) => {
    const state = live.byNode.get(id);
    return state ? describeLiveState(state) : null;
  };
  // Names for people: this app's label for a host, else the configured name capitalised; never an id.
  const appHosts = useAppHostList();
  const serverIdByHost = new Map([
    ...(hostList.data?.hosts ?? [])
      .filter((h) => h.serverId)
      .map((h) => [h.name, h.serverId] as const),
    ...shown.filter((n) => n.serverId).map((n) => [n.host, n.serverId] as const),
  ]);
  const hostNames = hostList.data?.hosts.map((h) => h.name) ??
    d?.hosts ?? [...new Set(shown.map((n) => n.host))];
  const localHost = hostList.data?.local ?? d?.hosts?.[0] ?? null;
  const readState = fleetReadState({
    hasData: !!d,
    isError: query.isError,
    failures: failuresOf(query.errorUpdateCount),
    hostName: host === "all" ? null : displayHostName(host, serverIdByHost.get(host), appHosts),
    reason: query.error instanceof Error ? query.error.message : null,
  });
  // MH4: other Macs' sessions as this app sees them over its own link. Display only (fleet-app-link.tsx has no actions).
  const enrolledAgentIds = useMemo(
    () => new Set(shown.flatMap((n) => (n.agentId ? [n.agentId] : []))),
    [shown],
  );
  const appLink = useAppLinkSections(
    useMemo(
      () => appLinkTargets(hostList.data?.hosts ?? [], localHost, host),
      [hostList.data, localHost, host],
    ),
    enrolledAgentIds,
    frozen,
  );
  const hostName = (name: string, serverId?: string | null) =>
    displayHostName(name, serverId ?? serverIdByHost.get(name), appHosts);
  const errorFor = (n: Node) =>
    plainNodeError(n.error, {
      remote: n.host !== (d?.hosts?.[0] ?? null),
      hostName: hostName(n.host, n.serverId),
      hasLiveLine: !!liveLineFor(n.id),
    });
  const matchingTasks = d?.tasks.filter((t) => shown.some((n) => n.task === t.id)) ?? [];
  const activeTask = d?.tasks.find((t) => t.id === chosen?.task);
  const observedAt = Date.parse(d?.observedAt ?? ""),
    stale =
      query.isError ||
      last.fromMemory ||
      !Number.isFinite(observedAt) ||
      now - observedAt > 45000 ||
      observedAt - now > 5000;
  if (graphOpen && d)
    return (
      <GraphMode
        key={JSON.stringify([props.host?.id, host, search])}
        {...props}
        fleet={d}
        shown={shown}
        selected={selected}
        chosen={chosen}
        stale={stale}
        frozen={frozen}
        savedIntent={graphIntent}
        onIntentChange={saveIntent}
        onSelect={select}
        onExit={() => openGraph(false)}
        onFreeze={() => freeze(!frozen)}
      />
    );
  return (
    <ScrollView
      ref={scroll}
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{
        width: "100%",
        maxWidth: 1040,
        alignSelf: "center",
        padding: props.layout.compact ? 16 : 24,
        gap: 16,
      }}
    >
      <View style={{ gap: 8 }}>
        <Text style={{ ...muted, fontSize: 12, letterSpacing: 1, fontWeight: "600" }}>
          FULCRA / WORK
        </Text>
        <Text style={{ ...text, fontSize: 26, fontWeight: "600" }}>Your work, at a glance</Text>
        <Text style={{ ...muted, fontSize: 16 }}>The goal. The progress. What needs you next.</Text>
      </View>
      <Text accessibilityLiveRegion="polite" style={{ ...text, fontWeight: "500" }}>
        {frozen
          ? "Frozen"
          : (last.notice ??
            (stale ? (d ? "May be out of date" : readState.message) : "Updating every 15s"))}
        {d ? " · across your saved sessions" : ""}
      </Text>
      {(readState.kind === "retrying" || readState.kind === "failed") && (
        <View
          testID="fleet-read-error"
          style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 12 }}
        >
          <WorkButton theme={props.theme} label="Try again" onPress={tryAgain}>
            Try again
          </WorkButton>
          {appLink.length > 0 && (
            <Text style={muted}>Below is what this app can see of your other Macs.</Text>
          )}
        </View>
      )}
      {chosen && (
        <View style={{ gap: 12 }}>
          <WorkButton theme={props.theme} label="Back to overview" onPress={() => select(null)}>
            ← Overview
          </WorkButton>
          <Activity
            key={[props.host?.id, chosen.task, chosen.id].join(":")}
            node={chosen}
            fleet={d}
            frozen={frozen}
            quotaStale={stale}
            liveLine={liveLineFor(chosen.id)}
            hostLabel={hostName(chosen.host, chosen.serverId)}
            errorText={errorFor(chosen)}
            {...props}
          />
        </View>
      )}
      {activeTask && (
        <View style={{ gap: 12 }}>
          <Text style={{ ...text, fontSize: 18, fontWeight: "600" }}>
            {workName(activeTask.title)}
          </Text>
          <WorkBrief
            key={activeTask.id}
            taskId={activeTask.id}
            frozen={frozen}
            onTask={props.onTask}
            theme={props.theme}
            host={props.host}
          />
        </View>
      )}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <WorkButton
          theme={props.theme}
          label="Open work graph"
          disabled={!d}
          onPress={() => openGraph(true)}
        >
          Open work graph
        </WorkButton>
        <WorkButton
          theme={props.theme}
          label={frozen ? "Resume updates" : "Freeze view"}
          onPress={() => freeze(!frozen)}
        />
        <WorkButton
          theme={props.theme}
          label="Refresh work"
          onPress={() => {
            void query.refetch();
            void directory.refetch();
          }}
        >
          Refresh
        </WorkButton>
      </View>
      <View style={{ gap: 12 }}>
        <TextInput
          accessibilityLabel="Find work"
          placeholder="Find a task, session or provider"
          value={search}
          onChangeText={setSearch}
          maxLength={160}
          style={{
            ...text,
            minHeight: 52,
            padding: 16,
            fontSize: 16,
            backgroundColor: c.surface1 ?? c.surface0,
            borderWidth: 1,
            borderColor: c.border,
            borderRadius: 16,
          }}
        />
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {["all", ...hostNames].map((h) => (
            <WorkButton
              key={h}
              theme={props.theme}
              label={h === "all" ? allHostsLabel(hostNames.length) : hostName(h)}
              selected={h === host}
              onPress={() => setHost(h)}
            />
          ))}
        </View>
        {live.unavailable.length > 0 && (
          <Text style={muted}>
            Live state unavailable from this app: {live.unavailable.join(", ")}
          </Text>
        )}
      </View>
      <AppLinkSections sections={appLink} theme={props.theme} />
      {d && (
        <>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 20 }}>
            {[
              ["Conversations", d.total],
              [
                "Working now",
                d.nodes.filter((n) => isWorkingForDisplay(n, live.byNode.get(n.id))).length,
              ],
              [
                "Session alerts",
                d.nodes.filter(
                  (n) =>
                    (live.byNode.get(n.id)?.pending ?? n.pending ?? 0) > 0 ||
                    n.error ||
                    ["revoking", "delegating"].includes(n.mode),
                ).length,
              ],
              ["Matching", d.matching ?? shown.length],
            ].map(([label, count]) => (
              <View key={label} style={{ gap: 4 }}>
                <Text style={{ ...text, fontSize: 24, fontWeight: "600" }}>{count}</Text>
                <Text style={muted}>{label}</Text>
              </View>
            ))}
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <WorkButton
              theme={props.theme}
              label="Previous sessions"
              disabled={offset === 0}
              onPress={() => {
                select(null);
                setOffset(Math.max(0, offset - 64));
              }}
            />
            <WorkButton
              theme={props.theme}
              label="Next sessions"
              disabled={d.nextOffset == null}
              onPress={() => {
                select(null);
                setOffset(d.nextOffset!);
              }}
            />
          </View>
          <WorkButton
            theme={props.theme}
            label="Technical observation details"
            expanded={technical}
            onPress={() => showTechnical(!technical)}
          />
          {technical && (
            <>
              <Text style={muted}>
                Reported progress comes from published briefs. Session activity and release approval
                are recorded separately.
              </Text>
              <Text style={muted}>{d.note}</Text>
              <Text style={muted}>{d.quotaNote}</Text>
              <Text style={muted}>{d.observedAt}</Text>
            </>
          )}
          {!shown.length && <Text style={text}>No enrolled sessions match these filters.</Text>}
          {matchingTasks.slice(0, taskLimit).map((task) => (
            <View
              key={task.id}
              style={{ gap: 12, paddingTop: 16, borderTopWidth: 1, borderColor: c.border }}
            >
              <Pressable
                accessibilityRole="button"
                style={{ minHeight: 48, justifyContent: "center" }}
                onPress={() => props.onTask(task.id)}
              >
                <Text style={{ ...text, fontSize: 18, fontWeight: "600" }}>
                  {task.identifier ? task.identifier + " · " : ""}
                  {workName(task.title)} ↗
                </Text>
              </Pressable>
              <Text style={muted}>
                {projectName(task.id)
                  ? `Project: ${projectName(task.id)}${projectStale ? " · last recorded" : ""}`
                  : "Project not recorded or unavailable"}
              </Text>
              {!chosen && (
                <WorkBrief
                  compact
                  taskId={task.id}
                  frozen={frozen}
                  onTask={props.onTask}
                  theme={props.theme}
                  host={props.host}
                />
              )}
              <View style={{ gap: 10 }}>
                {shown
                  .filter((n) => n.task === task.id)
                  .map((n) => {
                    const children = d.edges.filter((e) => e.from === n.id);
                    return (
                      <Pressable
                        key={n.id}
                        accessibilityRole="button"
                        accessibilityLabel={`Inspect ${sessionName(n, d)}`}
                        accessibilityState={{ selected: selected === n.id }}
                        onPress={() => {
                          select(n.id);
                          scroll.current?.scrollTo({ y: 0, animated: false });
                        }}
                        style={{
                          minHeight: 48,
                          padding: 18,
                          gap: 8,
                          backgroundColor:
                            selected === n.id
                              ? (c.surface2 ?? c.surface0)
                              : (c.surface1 ?? c.surface0),
                          borderWidth: selected === n.id ? 2 : 1,
                          borderColor: selected === n.id ? (c.accent ?? c.foreground) : c.border,
                          borderRadius: 16,
                        }}
                      >
                        <Text style={{ ...text, fontWeight: "600" }}>↳ {sessionName(n, d)}</Text>
                        <Text style={muted}>
                          {hostName(n.host, n.serverId)} · {n.provider} · {sessionStatus(n, stale)}
                        </Text>
                        {liveLineFor(n.id) && <Text style={muted}>{liveLineFor(n.id)}</Text>}
                        <Text style={muted}>{sessionRole(n, d)}</Text>
                        {n.quotaWait && (
                          <Text style={text}>
                            {stale || quotaIsStale(n.quotaObservedAt) ? "Last recorded: " : ""}
                            {quotaLabel(n.quotaWait)}
                          </Text>
                        )}
                        {children.length > 0 && (
                          <Text style={muted}>
                            Saved team: {children.length} linked conversation
                            {children.length === 1 ? "" : "s"}
                          </Text>
                        )}
                        {n.error && <Text style={text}>{errorFor(n)}</Text>}
                      </Pressable>
                    );
                  })}
              </View>
            </View>
          ))}
          {matchingTasks.length > taskLimit && (
            <WorkButton
              theme={props.theme}
              label="Show more work"
              onPress={() => setTaskLimit((n) => n + 8)}
            >{`Show more work (${taskLimit} of ${matchingTasks.length} tasks)`}</WorkButton>
          )}
        </>
      )}
    </ScrollView>
  );
}
