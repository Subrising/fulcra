import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useFetchQuery } from "@/data/query";
import { Crown, Network, Plus, RefreshCw, Users } from "lucide-react-native";
import { router } from "expo-router";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import {
  getHostRuntimeStore,
  useHostRegistryLoaded,
  useHostRuntimeClient,
  useHostRuntimeConnectionStatuses,
  useHosts,
} from "@/runtime/host-runtime";
import { useMainAssistantMemory } from "@/stores/main-assistant-memory-store";
import { useOrganizationIntakePreferences } from "@/stores/organization-intake-preferences-store";
import { mergeMainAssistants, useMainAssistantReads } from "./home-computer";
import { mainAssistant } from "../../../../control/orca-organization/shared/team";
import { useSessionStore } from "@/stores/session-store";
import { useLeadsMemory, type RememberedLead } from "@/stores/leads-memory-store";
import { pluginRegistry, useControllerPlugin, useUntrustedPlugins } from "./registry";
import { PluginInstallationProvider } from "./installation-provider";
import { usePluginHostNavigation } from "./host-navigation";
import { buildPluginSurfaceRoute } from "./routes";
import { useContract } from "../../../../control/orca-organization/client/use-contract";
import { roleDirectoryRpc, type Seat } from "../../../../control/orca-organization/shared/roles";
import { fleetRpc, type Fleet } from "../../../../control/orca-organization/shared/fleet";
import { projectsRpc } from "../../../../control/orca-organization/shared/projects";
import { STATE_LABEL, stateOf } from "../../../../control/orca-organization/client/team-tree";
import { create } from "zustand";
import { chatLeads } from "./sidebar-chat-leads";
import { lastKnownStatusLine } from "@getpaseo/protocol/chat-status";

import type { Theme } from "@/styles/theme";

const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedCrown = withUnistyles(Crown);
const ThemedUsers = withUnistyles(Users);
const ThemedPlus = withUnistyles(Plus);

// The leads at the top of the sidebar: a one-click Team map, then the main assistant and every project lead with a
// plain status and the computer it runs on. A row opens its chat; "+" sends it new work, as typing in its chat would.

export function PrimeSidebar({
  serverId,
  onBeforeNavigate,
}: {
  serverId: string;
  onBeforeNavigate?: () => void;
}) {
  const plugin = useControllerPlugin(serverId);
  const client = useHostRuntimeClient(serverId);
  if (!plugin || !client) return null;
  return (
    <PluginInstallationProvider plugin={plugin}>
      <PrimeSidebarRows
        serverId={serverId}
        onBeforeNavigate={onBeforeNavigate}
        hasTeamMap={plugin.surfaces.some((surface) => surface.id === "team")}
      />
    </PluginInstallationProvider>
  );
}

type FleetNode = Fleet["nodes"][number];

// FULCRA(sidebar-retry): right after a daemon restart the controller plugin is not ready yet, so the first reads fail or
// report the role records unavailable. The sidebar tries again by itself (about 35 s in total) before it shows
// "Couldn't load", instead of waiting for someone to press Retry.
export const SIDEBAR_READ_RETRIES = 6;
// FULCRA(sidebar-leads): the lead reads had no timer, so a lead seated after the app opened stayed out of the sidebar
// until the app was reopened (seen with a project lead). The Leads page already read every 30 s.
export const SIDEBAR_REFRESH_MS = 30_000;
export const sidebarRetryDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, 10_000);
async function availableDirectory<T extends { available?: boolean; unavailable?: string | null }>(
  read: Promise<T>,
): Promise<T> {
  const directory = await read;
  if (directory?.available !== true)
    throw new Error(directory?.unavailable?.trim() || "Role records unavailable");
  return directory;
}

// Fulcra 0.2.9: "Loading leads…" stayed for about 35 s of silent retries and then said only "Couldn't load leads",
// while the Mac mini's controller was stopped. The row now gives the reason from the first failed reply; the
// automatic retries go on behind it.
const GENERIC_FAILURE = /^(Management \w+|Role records unavailable|Controller \w+)$/;
export function leadsFailureLabel(error: unknown, hostLabel: string): string {
  const message = error instanceof Error ? error.message.trim() : "";
  const reason =
    !message || GENERIC_FAILURE.test(message)
      ? `Command Centre is not answering on ${hostLabel}`
      : message.slice(0, 120);
  return `Couldn't load leads: ${reason} · Retry`;
}

export function PrimeSidebarRows({
  serverId,
  onBeforeNavigate,
  hasTeamMap = false,
  retryDelay = sidebarRetryDelay,
}: {
  serverId: string;
  onBeforeNavigate?: () => void;
  hasTeamMap?: boolean;
  retryDelay?: (attempt: number) => number;
}) {
  const read = useContract(roleDirectoryRpc);
  const readFleet = useContract(fleetRpc);
  const readProjects = useContract(projectsRpc);
  const navigation = usePluginHostNavigation(serverId);
  const hostLabel = useHosts().find((host) => host.serverId === serverId)?.label ?? "this computer";
  const query = useFetchQuery({
    queryKey: ["orca-role-directory", serverId],
    queryFn: () => availableDirectory(read({})),
    staleTimeMs: 30_000,
    refetchInterval: SIDEBAR_REFRESH_MS,
    dataShape: "value",
    retry: SIDEBAR_READ_RETRIES,
    retryDelay,
  });
  const fleet = useFetchQuery({
    queryKey: ["orca-fleet", serverId],
    queryFn: () => readFleet({}),
    staleTimeMs: 30_000,
    refetchInterval: SIDEBAR_REFRESH_MS,
    dataShape: "value",
    retry: SIDEBAR_READ_RETRIES,
    retryDelay,
  });
  const projects = useFetchQuery({
    queryKey: ["orca-projects", serverId],
    queryFn: () => readProjects({}),
    staleTimeMs: 60_000,
    refetchInterval: SIDEBAR_REFRESH_MS,
    dataShape: "value",
    retry: SIDEBAR_READ_RETRIES,
    retryDelay,
  });
  const openSurface = useCallback(
    (id: string) => {
      onBeforeNavigate?.();
      router.push(
        buildPluginSurfaceRoute(serverId, pluginRegistry.controllerPluginId(serverId), {
          kind: "surface",
          id,
        }),
      );
    },
    [onBeforeNavigate, serverId],
  );
  const leadership = useCallback(() => openSurface("leadership"), [openSurface]);
  const teamMap = useCallback(
    () => openSurface(hasTeamMap ? "team" : "leadership"),
    [hasTeamMap, openSurface],
  );
  const { refetch } = query;
  const { refetch: refetchFleet } = fleet;
  const { refetch: refetchProjects } = projects;
  // Retry reads all three again: retrying only the directory left lead rows without status ("Status unknown").
  const retry = useCallback(() => {
    void refetch();
    void refetchFleet();
    void refetchProjects();
  }, [refetch, refetchFleet, refetchProjects]);
  const available = !query.isError && query.data?.available === true;
  const nodes = new Map((fleet.data?.nodes ?? []).map((node) => [node.id, node]));
  const projectName = new Map((projects.data?.projects ?? []).map((p) => [p.id, p.name]));
  return (
    <>
      <SidebarHeaderRow
        icon={Network}
        label="Team map"
        accessibilityLabel="Team map: who leads whom and what each is doing"
        onPress={teamMap}
        variant="compact"
        testID="sidebar-team-map"
      />
      <SidebarHeaderRow
        icon={Crown}
        label="Leads"
        accessibilityLabel="Leads: your main assistant and project leads"
        onPress={leadership}
        variant="compact"
        testID="sidebar-top-primes"
      />
      {available ? null : (
        <SidebarHeaderRow
          icon={RefreshCw}
          label={
            (query.error ?? query.failureReason)
              ? leadsFailureLabel(query.error ?? query.failureReason, hostLabel)
              : "Loading leads…"
          }
          variant="compact"
          onPress={retry}
        />
      )}
      {available && !mainAssistant(query.data!.primes) ? (
        <MainAssistantChoice serverId={serverId} leadership={leadership} />
      ) : null}
      <LeadRows
        serverId={serverId}
        directory={available ? query.data! : null}
        nodes={nodes}
        projectName={projectName}
        projectsKnown={projects.data !== undefined}
        navigation={navigation}
        leadership={leadership}
        onBeforeNavigate={onBeforeNavigate}
      />
    </>
  );
}

/**
 * Fulcra 0.2.11: the computers whose Leads section lists their main assistant now. Their automatic pinned row is
 * not shown (it would show the same chat twice). When Leads cannot list it (offline, not read yet) the pin stays.
 */
export const useLeadsListedMainAssistant = create<{
  hosts: ReadonlySet<string>;
  set(serverId: string, listed: boolean): void;
}>()((set, get) => ({
  hosts: new Set(),
  set(serverId, listed) {
    if (get().hosts.has(serverId) === listed) return;
    const hosts = new Set(get().hosts);
    if (listed) hosts.add(serverId);
    else hosts.delete(serverId);
    set({ hosts });
  },
}));

/**
 * Fulcra 0.2.11: the main assistant first, then this computer's project leads, then the leads another connected
 * computer records (read-only). Every row names its chat.
 */
function LeadRows({
  serverId,
  directory,
  nodes,
  projectName,
  projectsKnown,
  navigation,
  leadership,
  onBeforeNavigate,
}: {
  serverId: string;
  directory: { primes?: Seat[]; projectSeats?: Seat[] } | null;
  nodes: ReadonlyMap<string, FleetNode>;
  projectName: ReadonlyMap<string, string>;
  /** False while the projects read has failed or not answered: a seated lead is then still shown. */
  projectsKnown: boolean;
  navigation: ReturnType<typeof usePluginHostNavigation>;
  leadership: () => void;
  onBeforeNavigate?: () => void;
}) {
  // Leads of archived projects are hidden with their project, but only when the project list was read: a failed
  // projects read must not hide every seated lead.
  const leads = (directory?.projectSeats ?? []).filter(
    (seat) =>
      seat.state === "assigned" &&
      seat.projectId &&
      (!projectsKnown || projectName.has(seat.projectId)),
  );
  const main = directory ? mainAssistant(directory.primes) : null;
  const mainNode = main?.sessionId ? nodes.get(main.sessionId) : undefined;
  const { live: remote, remembered: rememberedLeads } = useOtherHostLeads(serverId);
  const sessions = useSessionStore((state) => state.sessions);
  const seatedIds = new Set([
    ...[main, ...leads, ...remote.map((lead) => lead.seat)].flatMap((seat) =>
      seat?.sessionId ? [seat.sessionId] : [],
    ),
    // A remembered lead stays one row even while its chat is still in this app's chat list.
    ...rememberedLeads.map((lead) => lead.sessionId),
  ]);
  const chatLeadRows = useMemo(
    () => chatLeads(sessions, seatedIds),
    // seatedIds is rebuilt each render from the values below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessions, [...seatedIds].sort().join(",")],
  );
  const hosts = useHosts();
  const listMain = useLeadsListedMainAssistant((state) => state.set);
  const listed = main !== null;
  useEffect(() => {
    listMain(serverId, listed);
    return () => listMain(serverId, false);
  }, [listMain, serverId, listed]);
  return (
    <>
      {main ? (
        <LeadRow
          key="main-assistant"
          seat={main}
          role="Main assistant"
          title={chatName(mainNode, "Main assistant")}
          node={mainNode}
          navigation={navigation}
          leadership={leadership}
          onBeforeNavigate={onBeforeNavigate}
          testID="sidebar-lead-main-assistant"
        />
      ) : null}
      {leads.map((seat) => {
        const node = seat.sessionId ? nodes.get(seat.sessionId) : undefined;
        const role = `Lead · ${projectName.get(seat.projectId!) ?? "project"}`;
        return (
          <LeadRow
            key={`project:${seat.seat}`}
            seat={seat}
            role={role}
            title={chatName(node, role)}
            node={node}
            navigation={navigation}
            leadership={leadership}
            onBeforeNavigate={onBeforeNavigate}
            testID={`sidebar-lead-${seat.seat}`}
          />
        );
      })}
      {chatLeadRows.map((lead) => (
        <ChatLeadRow
          key={`chat:${lead.serverId}:${lead.agentId}`}
          lead={lead}
          hostLabel={hosts.find((host) => host.serverId === lead.serverId)?.label}
          navigation={navigation}
          leadership={leadership}
          onBeforeNavigate={onBeforeNavigate}
        />
      ))}
      {rememberedLeads.map((lead) => (
        <RememberedLeadRow
          key={`remembered:${lead.serverId}:${lead.seat}`}
          lead={lead}
          onBeforeNavigate={onBeforeNavigate}
        />
      ))}
      {remote.map((lead) => (
        <LeadRow
          key={`remote:${lead.serverId}:${lead.seat.seat}`}
          seat={lead.seat}
          role={`Lead · ${lead.project}`}
          title={chatName(lead.node, `Lead · ${lead.project}`)}
          node={lead.node}
          hostLabel={lead.hostLabel}
          hostServerId={lead.serverId}
          navigation={navigation}
          leadership={leadership}
          onBeforeNavigate={onBeforeNavigate}
          testID={`sidebar-remote-lead-${lead.serverId}-${lead.seat.seat}`}
        />
      ))}
    </>
  );
}

/** The chat's own name from the fleet, else the role. */
export function chatName(node: FleetNode | undefined, fallback: string): string {
  const title = node?.title?.trim();
  return title && title !== "Saved conversation" && title !== "Remote conversation"
    ? title
    : fallback;
}

export interface OtherHostLead {
  serverId: string;
  hostLabel: string;
  seat: Seat;
  project: string;
  /** False when the projects read failed: `project` is then a placeholder, never to be remembered. */
  projectKnown: boolean;
  node: FleetNode | undefined;
}

/**
 * Fulcra 0.2.11: the project leads that the controller on another connected computer records, read-only, with that
 * computer's name. The same reads the pinned main assistant makes (role directory, projects, fleet), from each online
 * computer except the home computer. A computer that does not answer shows no rows; the home computer's leads stay.
 */
function useOtherHostLeads(homeServerId: string): {
  live: OtherHostLead[];
  remembered: ShownRememberedLead[];
} {
  const hosts = useHosts();
  const ids = useMemo(
    () => hosts.map((host) => host.serverId).filter((id) => id !== homeServerId),
    [hosts, homeServerId],
  );
  const statuses = useHostRuntimeConnectionStatuses(ids);
  const untrusted = useUntrustedPlugins();
  const needsUpdate = (id: string) =>
    untrusted.some(
      (plugin) => plugin.serverId === id && plugin.id === pluginRegistry.controllerPluginId(id),
    );
  // An online computer whose Fulcra is not trusted here cannot be read; it is shown from memory.
  const key = ids
    .filter((id) => statuses.get(id) === "online" && !needsUpdate(id))
    .sort()
    .join(",");
  const query = useFetchQuery({
    queryKey: ["fulcra-other-host-leads", key],
    queryFn: async () =>
      Promise.all(
        key
          .split(",")
          .map(async (serverId) => ({ serverId, leads: await readHostLeads(serverId) })),
      ),
    enabled: key.length > 0,
    staleTimeMs: 30_000,
    refetchInterval: SIDEBAR_REFRESH_MS,
    dataShape: "list",
    retry: 1,
  });
  const memory = useLeadsMemory((state) => state.byHost);
  const remember = useLeadsMemory((state) => state.remember);
  const labelOf = useCallback(
    (id: string) => hosts.find((host) => host.serverId === id)?.label ?? "another computer",
    [hosts],
  );
  // Only reads for the computers in the current key count. After a computer goes offline, the list query keeps the
  // previous key's data for a moment; using it would show a computer's leads twice for one read.
  const results = useMemo(() => {
    const current = new Set(key ? key.split(",") : []);
    return new Map(
      (key ? (query.data ?? []) : [])
        .filter((read) => current.has(read.serverId))
        .map((read) => [read.serverId, read.leads]),
    );
  }, [key, query.data]);
  const memoryRef = useRef(memory);
  memoryRef.current = memory;
  // What each computer answered is kept, so it can be shown when the computer is away.
  useEffect(() => {
    for (const [id, leads] of results) {
      if (leads === null) continue;
      // A failed projects read names no project. The name remembered for the same seat is kept; if there is none,
      // nothing is saved this time, so the placeholder is never remembered. The next read tries again.
      const earlier = new Map((memoryRef.current[id] ?? []).map((lead) => [lead.seat, lead]));
      const entries: RememberedLead[] = [];
      for (const lead of leads) {
        const before = earlier.get(lead.seat.seat);
        const project = lead.projectKnown ? lead.project : before?.project;
        if (project === undefined) break;
        entries.push({
          seat: lead.seat.seat,
          sessionId: lead.seat.sessionId ?? "",
          project,
          title: lead.projectKnown
            ? chatName(lead.node, `Lead · ${project}`)
            : (before?.title ?? chatName(lead.node, `Lead · ${project}`)),
        });
      }
      if (entries.length === leads.length) remember(id, entries);
    }
  }, [results, remember]);
  const live = useMemo(
    () =>
      [...results.entries()].flatMap(([id, leads]) =>
        (leads ?? []).map(
          (lead): OtherHostLead => ({
            serverId: lead.serverId,
            seat: lead.seat,
            project: lead.project,
            projectKnown: lead.projectKnown,
            node: lead.node,
            hostLabel: labelOf(id),
          }),
        ),
      ),
    [results, labelOf],
  );
  const shownRemembered = useMemo(
    () =>
      ids.flatMap((id): ShownRememberedLead[] => {
        const note = rememberedNote(
          labelOf(id),
          needsUpdate(id),
          statuses.get(id) === "online",
          results.get(id),
        );
        // Read fine just now: the live rows show. Not read yet: remembered rows, not greyed, so nothing flickers.
        if (note === LIVE) return [];
        return (memory[id] ?? []).map(
          (lead): ShownRememberedLead => ({
            seat: lead.seat,
            sessionId: lead.sessionId,
            project: lead.project,
            title: lead.title,
            serverId: id,
            note,
          }),
        );
      }),
    // needsUpdate reads `untrusted` and `ids`; both are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ids, memory, results, statuses, untrusted, labelOf],
  );
  return { live, remembered: shownRemembered };
}

export interface ShownRememberedLead extends RememberedLead {
  serverId: string;
  /** Why the lead is greyed: "<computer> offline", "update Fulcra on <computer>", or null while it is being read. */
  note: string | null;
}

const LIVE = Symbol("read now");

/** LIVE when the computer was read now; else the reason its remembered leads are greyed (null: not read yet). */
export function rememberedNote(
  label: string,
  needsUpdate: boolean,
  online: boolean,
  read: unknown[] | null | undefined,
): string | null | typeof LIVE {
  if (needsUpdate) return `update Fulcra on ${label}`;
  if (!online) return `${label} offline`;
  if (read === null) return `Command Centre not answering on ${label}`;
  if (read === undefined) return null;
  return LIVE;
}

async function readHostLeads(serverId: string): Promise<Omit<OtherHostLead, "hostLabel">[] | null> {
  const client = getHostRuntimeStore().getSnapshot(serverId)?.client;
  if (!client) return null;
  const plugin = pluginRegistry.controllerPluginId(serverId);
  try {
    const directory = (await client.invokePluginRpc(plugin, "organization.role-directory", {})) as {
      available?: boolean;
      projectSeats?: Seat[];
    } | null;
    // A reply that says it is unavailable is a failed read, not "no leads": the remembered leads stay.
    if (!directory?.available) return null;
    const seats = (directory.projectSeats ?? []).filter(
      (seat) => seat.state === "assigned" && seat.projectId,
    );
    if (!seats.length) return [];
    const [projects, fleet] = (await Promise.all([
      client.invokePluginRpc(plugin, "organization.projects", {}).catch(() => null),
      client.invokePluginRpc(plugin, "organization.fleet", {}).catch(() => null),
    ])) as [{ projects?: { id: string; name: string }[] } | null, Fleet | null];
    const names = new Map((projects?.projects ?? []).map((p) => [p.id, p.name]));
    const nodes = new Map((fleet?.nodes ?? []).map((node) => [node.id, node]));
    // Leads of archived projects are hidden with their project, as on the home computer. A failed projects read
    // hides nothing (the lead is then named "project").
    return seats
      .filter((seat) => !projects || names.has(seat.projectId!))
      .map((seat) => ({
        serverId,
        seat,
        project: names.get(seat.projectId!) ?? "project",
        projectKnown: names.has(seat.projectId!),
        node: seat.sessionId ? nodes.get(seat.sessionId) : undefined,
      }));
  } catch {
    return null;
  }
}

function useAllMainAssistants() {
  const hosts = useHosts();
  const registryLoaded = useHostRegistryLoaded();
  const companyHost = useOrganizationIntakePreferences((state) => state.companyHost);
  const ids = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const statuses = useHostRuntimeConnectionStatuses(ids);
  const onlineIds = useMemo(
    () => ids.filter((id) => statuses.get(id) === "online"),
    [ids, statuses],
  );
  const reads = useMainAssistantReads<Seat>(onlineIds, mainAssistant);
  const remembered = useMainAssistantMemory((state) => state.byHost);
  const remember = useMainAssistantMemory((state) => state.remember);
  const forget = useMainAssistantMemory((state) => state.forget);
  useEffect(() => {
    for (const read of reads ?? []) {
      if (read.status === "found" && read.seat.sessionId)
        remember(read.serverId, { seat: read.seat.seat, sessionId: read.seat.sessionId });
      else if (read.status === "none") forget(read.serverId);
    }
  }, [reads, remember, forget]);
  useEffect(() => {
    // A computer removed from this app takes its remembered main assistant with it.
    if (!registryLoaded) return;
    for (const serverId of Object.keys(remembered)) if (!ids.includes(serverId)) forget(serverId);
  }, [registryLoaded, ids, remembered, forget]);
  const shown = useMemo(
    () =>
      mergeMainAssistants({
        hostIds: ids,
        online: new Set(onlineIds),
        reads,
        remembered,
        homeServerId: companyHost,
      }),
    [ids, onlineIds, reads, remembered, companyHost],
  );
  const label = (serverId: string) =>
    hosts.find((host) => host.serverId === serverId)?.label ?? "another computer";
  // Still asking a connected computer, with nothing remembered: do not say "No main assistant yet" yet.
  const finding = reads === null && shown.length === 0;
  return { shown, label, finding };
}

/**
 * Fulcra 0.2.8: every known main assistant, pinned at the top of the sidebar on every device, each with the computer
 * it runs on. The MacBook app shows the main assistant that runs on the Mac mini. When that computer is away the row
 * stays, marked offline; its chat says the computer is offline. Two computers with one each both show.
 */
export function PinnedMainAssistant({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const { shown: all, label } = useAllMainAssistants();
  const inLeads = useLeadsListedMainAssistant((state) => state.hosts);
  const shown = all.filter((entry) => !inLeads.has(entry.serverId));
  return (
    <>
      {shown.map((entry, index) => {
        const testID =
          index === 0
            ? "sidebar-pinned-main-assistant"
            : `sidebar-pinned-main-assistant-${entry.serverId}`;
        const hostLabel = label(entry.serverId);
        return entry.seat && !entry.offline ? (
          <PinnedRow
            key={entry.serverId}
            serverId={entry.serverId}
            seat={entry.seat}
            node={(entry.node ?? undefined) as FleetNode | undefined}
            hostLabel={hostLabel}
            onBeforeNavigate={onBeforeNavigate}
            testID={testID}
          />
        ) : (
          <RememberedMainAssistantRow
            key={entry.serverId}
            serverId={entry.serverId}
            sessionId={entry.sessionId}
            hostLabel={hostLabel}
            offline={entry.offline}
            onBeforeNavigate={onBeforeNavigate}
            testID={testID}
          />
        );
      })}
    </>
  );
}

function PinnedRow({
  serverId,
  seat,
  node,
  hostLabel,
  onBeforeNavigate,
  testID,
}: {
  serverId: string;
  seat: Seat;
  node: FleetNode | undefined;
  hostLabel: string;
  onBeforeNavigate?: () => void;
  testID: string;
}) {
  const navigation = usePluginHostNavigation(serverId);
  const leadership = useCallback(() => {
    onBeforeNavigate?.();
    router.push(
      buildPluginSurfaceRoute(serverId, pluginRegistry.controllerPluginId(serverId), {
        kind: "surface",
        id: "leadership",
      }),
    );
  }, [onBeforeNavigate, serverId]);
  return (
    <LeadRow
      seat={seat}
      title={`Main assistant · ${hostLabel}`}
      node={node}
      unavailableText="Not connected"
      navigation={navigation}
      leadership={leadership}
      onBeforeNavigate={onBeforeNavigate}
      testID={testID}
    />
  );
}

/**
 * A main assistant known from that computer's last answer: it is offline, or this app could not read it just now.
 * A press opens its chat, which says plainly when the computer is offline and offers Retry.
 */
function RememberedMainAssistantRow({
  serverId,
  sessionId,
  hostLabel,
  offline,
  onBeforeNavigate,
  testID,
}: {
  serverId: string;
  sessionId: string;
  hostLabel: string;
  offline: boolean;
  onBeforeNavigate?: () => void;
  testID: string;
}) {
  const navigation = usePluginHostNavigation(serverId);
  const title = offline
    ? `Main assistant · ${hostLabel} · offline`
    : `Main assistant · ${hostLabel}`;
  const open = useCallback(() => {
    if (navigation.openAgentOnHost?.({ serverId, agentId: sessionId }) === "requested")
      onBeforeNavigate?.();
  }, [navigation, onBeforeNavigate, serverId, sessionId]);
  return (
    <View style={styles.row}>
      <View style={styles.line}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            offline
              ? `Open Main assistant conversation. ${hostLabel} is offline.`
              : `Open Main assistant conversation on ${hostLabel}`
          }
          onPress={open}
          testID={testID}
          style={styles.main}
        >
          <ThemedCrown size={14} uniProps={mutedColor} />
          <View style={styles.text}>
            <Text style={styles.title} numberOfLines={2}>
              {title}
            </Text>
            <Text style={styles.status} numberOfLines={1}>
              {offline ? "Not connected" : "Status unknown"}
            </Text>
          </View>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * This computer has no main assistant. When another computer has one, the first choice is to use it (it becomes
 * Fulcra's home computer in this app); setting one up here comes second. "No main assistant yet" shows only when no
 * computer has one.
 */
function MainAssistantChoice({
  serverId,
  leadership,
}: {
  serverId: string;
  leadership: () => void;
}) {
  const { shown, label, finding } = useAllMainAssistants();
  const chooseCompany = useOrganizationIntakePreferences((state) => state.chooseCompany);
  const elsewhere = shown.find((entry) => entry.serverId !== serverId) ?? null;
  const useElsewhere = useCallback(() => {
    if (elsewhere) chooseCompany(elsewhere.serverId);
  }, [chooseCompany, elsewhere]);
  return (
    <>
      {elsewhere ? (
        <ChoiceRow
          label={`Use the main assistant on ${label(elsewhere.serverId)}`}
          onPress={useElsewhere}
          testID="sidebar-use-remote-main-assistant"
        />
      ) : null}
      <ChoiceRow
        label={setUpLabel(Boolean(elsewhere), finding)}
        onPress={leadership}
        testID="sidebar-set-up-main-assistant"
      />
    </>
  );
}

function setUpLabel(elsewhere: boolean, finding: boolean): string {
  if (elsewhere) return "Make a chat the main assistant";
  if (finding) return "Finding your main assistant…";
  return "No main assistant yet · Set up";
}

/** A one-line sidebar choice with a 48 px target, the same height as the main assistant rows. */
function ChoiceRow({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        onPress={onPress}
        testID={testID}
        style={styles.main}
      >
        <ThemedCrown size={14} uniProps={mutedColor} />
        <Text style={[styles.title, styles.text]} numberOfLines={2}>
          {label}
        </Text>
      </Pressable>
    </View>
  );
}

/** "Working · Mac mini", "Empty slot", or "Unavailable" when the session cannot be opened from here. */
export function leadStatusLine(
  seat: Seat,
  node: FleetNode | undefined,
  canOpen: boolean,
  unavailableText = "Unavailable",
  hostLabel?: string,
  chatStatus?: string,
): string {
  if (seat.state === "vacant") return "Empty slot";
  if (!canOpen) return unavailableText;
  // The seat's chat is not a fleet node (the human-facing main assistant is not delegated to the controller): say
  // what the chat list knows, marked as last known.
  if (!node) {
    return lastKnownStatusLine(chatStatus);
  }
  return `${STATE_LABEL[stateOf(node)]} · ${hostLabel ?? node.host}`;
}

/**
 * A lead found in the chat list: a chat that reports to the main assistant and holds no seat. It opens its chat; there
 * is no "+" new work here, and its computer is named.
 */
function ChatLeadRow({
  lead,
  hostLabel,
  navigation,
  leadership,
  onBeforeNavigate,
}: {
  lead: { serverId: string; agentId: string; title: string; status: string | undefined };
  hostLabel: string | undefined;
  navigation: ReturnType<typeof usePluginHostNavigation>;
  leadership: () => void;
  onBeforeNavigate?: () => void;
}) {
  const status = ["Lead", lastKnownStatusLine(lead.status), hostLabel ?? "another computer"].join(
    " · ",
  );
  const open = useCallback(() => {
    const result = navigation.openAgentOnHost?.({ serverId: lead.serverId, agentId: lead.agentId });
    if (result !== "requested") return leadership();
    onBeforeNavigate?.();
  }, [lead.agentId, lead.serverId, leadership, navigation, onBeforeNavigate]);
  return (
    <View style={styles.row}>
      <View style={styles.line}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${lead.title} conversation`}
          onPress={open}
          testID={`sidebar-chat-lead-${lead.serverId}-${lead.agentId}`}
          style={styles.main}
        >
          <ThemedUsers size={14} uniProps={mutedColor} />
          <View style={styles.text}>
            <Text style={styles.title} numberOfLines={2}>
              {lead.title}
            </Text>
            <Text style={styles.status} numberOfLines={2}>
              {status}
            </Text>
          </View>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * A lead another computer reported earlier, shown greyed because that computer is offline, needs an update, or did not
 * answer. A press opens its chat, which says plainly when the computer is offline.
 */
function RememberedLeadRow({
  lead,
  onBeforeNavigate,
}: {
  lead: ShownRememberedLead;
  onBeforeNavigate?: () => void;
}) {
  const navigation = usePluginHostNavigation(lead.serverId);
  const open = useCallback(() => {
    if (
      navigation.openAgentOnHost?.({ serverId: lead.serverId, agentId: lead.sessionId }) ===
      "requested"
    )
      onBeforeNavigate?.();
  }, [lead.serverId, lead.sessionId, navigation, onBeforeNavigate]);
  const status = ["Lead", lead.project, lead.note ?? "last known"].join(" · ");
  return (
    <View style={[styles.row, lead.note ? styles.greyed : null]}>
      <View style={styles.line}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${lead.title} conversation. ${lead.note ?? ""}`.trim()}
          onPress={open}
          testID={`sidebar-remembered-lead-${lead.serverId}-${lead.seat}`}
          style={styles.main}
        >
          <ThemedUsers size={14} uniProps={mutedColor} />
          <View style={styles.text}>
            <Text style={styles.title} numberOfLines={2}>
              {lead.title}
            </Text>
            <Text style={styles.status} numberOfLines={2}>
              {status}
            </Text>
          </View>
        </Pressable>
      </View>
    </View>
  );
}

function LeadRow({
  seat,
  title,
  node,
  navigation,
  leadership,
  onBeforeNavigate,
  testID,
  unavailableText,
  role,
  hostLabel,
  hostServerId,
}: {
  seat: Seat;
  title: string;
  /** "Main assistant" or "Lead · <project>", shown before the status. */
  role?: string;
  /** The computer this app knows the lead's host as; it replaces the fleet's own host name. */
  hostLabel?: string;
  /**
   * A lead on another computer: the app host that computer's own controller reported it on. It opens the chat and
   * takes "+" new work there, like a lead on the home computer, even before this app has loaded that chat.
   */
  hostServerId?: string;
  node: FleetNode | undefined;
  navigation: ReturnType<typeof usePluginHostNavigation>;
  leadership: () => void;
  onBeforeNavigate?: () => void;
  testID: string;
  /** What the status line says when the chat cannot be opened from here. */
  unavailableText?: string;
}) {
  // A role-message dispatch address is not an app host identity. Open only on the host
  // that actually owns this saved agent; an unloaded or ambiguous identity stays in Leadership.
  const agentServerId = useSessionStore((state) => {
    const matches = Object.entries(state.sessions).filter(
      ([, session]) => seat.sessionId && session.agents.has(seat.sessionId),
    );
    return matches.length === 1 ? matches[0][0] : null;
  });
  // The computer's own report names the host the chat lives on; a role-message address never does.
  const ownerServerId = agentServerId ?? hostServerId ?? null;
  const canOpen = Boolean(
    seat.state === "assigned" && seat.sessionPresent && seat.sessionId && ownerServerId,
  );
  const chatStatus = useSessionStore((state) =>
    agentServerId && seat.sessionId
      ? state.sessions[agentServerId]?.agents.get(seat.sessionId)?.status
      : undefined,
  );
  const state = leadStatusLine(seat, node, canOpen, unavailableText, hostLabel, chatStatus);
  // Another computer's lead always names that computer, even when its status is not known here.
  const located =
    hostLabel && !state.endsWith(` · ${hostLabel}`) ? `${state} · ${hostLabel}` : state;
  const status = role ? `${role} · ${located}` : located;
  const label = canOpen ? title : `${title} · ${status}`;
  const [composing, setComposing] = useState(false);
  const open = useCallback(() => {
    if (!canOpen) return leadership();
    const result = navigation.openAgentOnHost?.({
      serverId: ownerServerId!,
      agentId: seat.sessionId!,
    });
    if (result !== "requested") return leadership();
    onBeforeNavigate?.();
  }, [ownerServerId, canOpen, leadership, navigation, onBeforeNavigate, seat.sessionId]);
  const toggleCompose = useCallback(() => setComposing((value) => !value), []);
  const sent = useCallback(() => {
    setComposing(false);
    open();
  }, [open]);
  const Icon = seat.role === "prime" ? ThemedCrown : ThemedUsers;
  return (
    <View style={styles.row}>
      <View style={styles.line}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={canOpen ? `Open ${title} conversation` : `Manage ${label}`}
          onPress={open}
          testID={testID}
          style={styles.main}
        >
          <Icon size={14} uniProps={mutedColor} />
          <View style={styles.text}>
            <Text style={styles.title} numberOfLines={2}>
              {title}
            </Text>
            <Text style={styles.status} numberOfLines={2}>
              {status}
            </Text>
          </View>
        </Pressable>
        {canOpen ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`New work for ${title}`}
            onPress={toggleCompose}
            testID={`${testID}-new-work`}
            style={styles.plus}
          >
            <ThemedPlus size={14} uniProps={mutedColor} />
          </Pressable>
        ) : null}
      </View>
      {composing && canOpen ? (
        <NewWorkBox
          title={title}
          serverId={ownerServerId!}
          agentId={seat.sessionId!}
          onSent={sent}
          onCancel={toggleCompose}
        />
      ) : null}
    </View>
  );
}

/** Sends one message to the lead through the normal chat send path, then opens its chat. */
function NewWorkBox({
  title,
  serverId,
  agentId,
  onSent,
  onCancel,
}: {
  title: string;
  serverId: string;
  agentId: string;
  onSent: () => void;
  onCancel: () => void;
}) {
  const client = useHostRuntimeClient(serverId);
  const input = useRef<EditingTextInputHandle>(null);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "failed">("idle");
  const send = useCallback(async () => {
    const message = text.trim();
    if (!message || !client) return;
    setState("sending");
    try {
      await client.sendAgentMessage(agentId, message);
      input.current?.reset();
      setText("");
      setState("idle");
      onSent();
    } catch {
      setState("failed");
    }
  }, [agentId, client, onSent, text]);
  const press = useCallback(() => void send(), [send]);
  return (
    <View style={styles.compose}>
      <EditingTextInput
        ref={input}
        accessibilityLabel={`New work for ${title}`}
        placeholder="What should it work on?"
        onChangeText={setText}
        multiline
        style={styles.input}
        testID="sidebar-new-work-input"
      />
      {state === "failed" ? (
        <Text style={styles.status}>{"Couldn't send. Check the connection and try again."}</Text>
      ) : null}
      <View style={styles.actions}>
        <Pressable accessibilityRole="button" onPress={onCancel} style={styles.action}>
          <Text style={styles.status}>Cancel</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Send to ${title}`}
          disabled={!text.trim() || state === "sending"}
          onPress={press}
          style={styles.action}
        >
          <Text style={styles.title}>{state === "sending" ? "Sending…" : "Send"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  greyed: { opacity: 0.5 },
  row: { paddingHorizontal: theme.spacing[2] },
  line: { flexDirection: "row", alignItems: "center" },
  main: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 48,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  text: { flex: 1, minWidth: 0 },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  status: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm - 1 },
  plus: {
    minWidth: 48,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
  },
  compose: {
    gap: theme.spacing[1],
    paddingLeft: theme.spacing[6],
    paddingBottom: theme.spacing[2],
  },
  input: {
    minHeight: 56,
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
  action: {
    minHeight: 48,
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
  },
}));
