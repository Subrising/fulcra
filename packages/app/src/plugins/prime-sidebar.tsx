import React, { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useFetchQuery } from "@/data/query";
import { Crown, Network, Plus, RefreshCw, Users } from "lucide-react-native";
import { router } from "expo-router";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import { useOrganizationIntakePreferences } from "@/stores/organization-intake-preferences-store";
import { preferredMainAssistant, useMainAssistantSeats } from "./home-computer";
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
  const companyHost = useOrganizationIntakePreferences((state) => state.companyHost);
  const ids = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const found = useMainAssistantSeats<Seat>(ids, mainAssistant);
  const label = (serverId: string) =>
    hosts.find((host) => host.serverId === serverId)?.label ?? "another computer";
  return { found, companyHost, label };
}

/**
 * Fulcra 0.2.8: the main assistant, pinned at the top of the sidebar on every device, with the computer it runs on.
 * It comes from any connected computer, so the MacBook app shows the main assistant that runs on the Mac mini.
 */
export function PinnedMainAssistant({ onBeforeNavigate }: { onBeforeNavigate?: () => void }) {
  const { found, companyHost, label } = useAllMainAssistants();
  const chosen = preferredMainAssistant(found, companyHost);
  if (!chosen) return null;
  return (
    <PinnedRow
      serverId={chosen.serverId}
      seat={chosen.seat}
      node={(chosen.node ?? undefined) as FleetNode | undefined}
      hostLabel={label(chosen.serverId)}
      onBeforeNavigate={onBeforeNavigate}
    />
  );
}

function PinnedRow({
  serverId,
  seat,
  node,
  hostLabel,
  onBeforeNavigate,
}: {
  serverId: string;
  seat: Seat;
  node: FleetNode | undefined;
  hostLabel: string;
  onBeforeNavigate?: () => void;
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
      title="Main assistant"
      node={node}
      hostLabel={hostLabel}
      navigation={navigation}
      leadership={leadership}
      onBeforeNavigate={onBeforeNavigate}
      testID="sidebar-pinned-main-assistant"
    />
  );
}

/**
 * This computer has no main assistant. When another connected computer has one, the first choice is to use it (it
 * becomes Fulcra's home computer in this app); setting one up here comes second.
 */
function MainAssistantChoice({
  serverId,
  leadership,
}: {
  serverId: string;
  leadership: () => void;
}) {
  const { found, label } = useAllMainAssistants();
  const chooseCompany = useOrganizationIntakePreferences((state) => state.chooseCompany);
  const elsewhere = (found ?? []).find((f) => f.serverId !== serverId) ?? null;
  const useElsewhere = useCallback(() => {
    if (elsewhere) chooseCompany(elsewhere.serverId);
  }, [chooseCompany, elsewhere]);
  return (
    <>
      {elsewhere ? (
        <SidebarHeaderRow
          icon={Crown}
          label={`Use the main assistant on ${label(elsewhere.serverId)}`}
          variant="compact"
          onPress={useElsewhere}
          testID="sidebar-use-remote-main-assistant"
        />
      ) : null}
      <SidebarHeaderRow
        icon={Crown}
        label={elsewhere ? "Set up a main assistant here" : "No main assistant yet · Set up"}
        variant="compact"
        onPress={leadership}
        testID="sidebar-set-up-main-assistant"
      />
    </>
  );
}

/** "Working · Mac mini", "Empty slot", or "Unavailable" when the session cannot be opened from here. */
export function leadStatusLine(
  seat: Seat,
  node: FleetNode | undefined,
  canOpen: boolean,
  hostLabel?: string,
): string {
  if (seat.state === "vacant") return "Empty slot";
  if (!canOpen) return hostLabel ? `Not connected · ${hostLabel}` : "Unavailable";
  if (!node) return hostLabel ?? "Status unknown";
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
  hostLabel,
}: {
  seat: Seat;
  title: string;
  node: FleetNode | undefined;
  navigation: ReturnType<typeof usePluginHostNavigation>;
  leadership: () => void;
  onBeforeNavigate?: () => void;
  testID: string;
  /** The computer the chat runs on, shown when this app has no live status for it. */
  hostLabel?: string;
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
  const status = leadStatusLine(seat, node, canOpen, hostLabel);
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
            <Text style={styles.title} numberOfLines={1}>
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
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  text: { flex: 1, minWidth: 0 },
  title: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  status: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm - 1 },
  plus: { padding: theme.spacing[1], borderRadius: theme.borderRadius.md },
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
  action: { paddingVertical: theme.spacing[1], paddingHorizontal: theme.spacing[2] },
}));
