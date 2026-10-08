import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useFetchQuery } from "@/data/query";
import { Crown, Network, Plus, RefreshCw, Users } from "lucide-react-native";
import { router } from "expo-router";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import {
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
import { pluginRegistry, useControllerPlugin } from "./registry";
import { PluginInstallationProvider } from "./installation-provider";
import { usePluginHostNavigation } from "./host-navigation";
import { buildPluginSurfaceRoute } from "./routes";
import { useContract } from "../../../../control/orca-organization/client/use-contract";
import { roleDirectoryRpc, type Seat } from "../../../../control/orca-organization/shared/roles";
import { fleetRpc, type Fleet } from "../../../../control/orca-organization/shared/fleet";
import { projectsRpc } from "../../../../control/orca-organization/shared/projects";
import { STATE_LABEL, stateOf } from "../../../../control/orca-organization/client/team-tree";

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
export const sidebarRetryDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, 10_000);
async function availableDirectory<T extends { available?: boolean }>(read: Promise<T>): Promise<T> {
  const directory = await read;
  if (directory?.available !== true) throw new Error("Role records unavailable");
  return directory;
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
  const query = useFetchQuery({
    queryKey: ["orca-role-directory", serverId],
    queryFn: () => availableDirectory(read({})),
    staleTimeMs: 30_000,
    dataShape: "value",
    retry: SIDEBAR_READ_RETRIES,
    retryDelay,
  });
  const fleet = useFetchQuery({
    queryKey: ["orca-fleet", serverId],
    queryFn: () => readFleet({}),
    staleTimeMs: 30_000,
    dataShape: "value",
    retry: SIDEBAR_READ_RETRIES,
    retryDelay,
  });
  const projects = useFetchQuery({
    queryKey: ["orca-projects", serverId],
    queryFn: () => readProjects({}),
    staleTimeMs: 60_000,
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
  // Leads of archived projects are hidden with their project.
  const leads = available
    ? (query.data!.projectSeats ?? []).filter(
        (seat) => seat.state === "assigned" && seat.projectId && projectName.has(seat.projectId),
      )
    : [];
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
          label={query.isPending ? "Loading leads…" : "Couldn't load leads · Retry"}
          variant="compact"
          onPress={retry}
        />
      )}
      {available && !mainAssistant(query.data!.primes) ? (
        <MainAssistantChoice serverId={serverId} leadership={leadership} />
      ) : null}
      {leads.map((seat) => (
        <LeadRow
          key={`project:${seat.seat}`}
          seat={seat}
          title={`Lead · ${projectName.get(seat.projectId!) ?? "project"}`}
          node={seat.sessionId ? nodes.get(seat.sessionId) : undefined}
          navigation={navigation}
          leadership={leadership}
          onBeforeNavigate={onBeforeNavigate}
          testID={`sidebar-lead-${seat.seat}`}
        />
      ))}
    </>
  );
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
  const { shown, label } = useAllMainAssistants();
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
): string {
  if (seat.state === "vacant") return "Empty slot";
  if (!canOpen) return unavailableText;
  if (!node) return "Status unknown";
  return `${STATE_LABEL[stateOf(node)]} · ${node.host}`;
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
}: {
  seat: Seat;
  title: string;
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
  const canOpen = Boolean(
    seat.state === "assigned" && seat.sessionPresent && seat.sessionId && agentServerId,
  );
  const status = leadStatusLine(seat, node, canOpen, unavailableText);
  const label = canOpen ? title : `${title} · ${status}`;
  const [composing, setComposing] = useState(false);
  const open = useCallback(() => {
    if (!canOpen) return leadership();
    const result = navigation.openAgentOnHost?.({
      serverId: agentServerId!,
      agentId: seat.sessionId!,
    });
    if (result !== "requested") return leadership();
    onBeforeNavigate?.();
  }, [agentServerId, canOpen, leadership, navigation, onBeforeNavigate, seat.sessionId]);
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
            <Text style={styles.status} numberOfLines={1}>
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
          serverId={agentServerId!}
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
