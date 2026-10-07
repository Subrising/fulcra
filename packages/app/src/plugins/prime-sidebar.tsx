import React, { useCallback, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useFetchQuery } from "@/data/query";
import { Crown, Network, Plus, RefreshCw, Users } from "lucide-react-native";
import { router } from "expo-router";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { pluginRegistry, useControllerPlugin } from "./registry";
import { PluginInstallationProvider } from "./installation-provider";
import { usePluginHostNavigation } from "./host-navigation";
import { buildPluginSurfaceRoute } from "./routes";
import { useContract } from "../../../../control/orca-organization/client/use-contract";
import { roleDirectoryRpc, type Seat } from "../../../../control/orca-organization/shared/roles";
import { fleetRpc, type Fleet } from "../../../../control/orca-organization/shared/fleet";
import { projectsRpc } from "../../../../control/orca-organization/shared/projects";
import { primeName } from "../../../../control/orca-organization/client/organisation-model";
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

export function PrimeSidebarRows({
  serverId,
  onBeforeNavigate,
  hasTeamMap = false,
}: {
  serverId: string;
  onBeforeNavigate?: () => void;
  hasTeamMap?: boolean;
}) {
  const read = useContract(roleDirectoryRpc);
  const readFleet = useContract(fleetRpc);
  const readProjects = useContract(projectsRpc);
  const navigation = usePluginHostNavigation(serverId);
  const query = useFetchQuery({
    queryKey: ["orca-role-directory", serverId],
    queryFn: () => read({}),
    staleTimeMs: 30_000,
    dataShape: "value",
    retry: false,
  });
  const fleet = useFetchQuery({
    queryKey: ["orca-fleet", serverId],
    queryFn: () => readFleet({}),
    staleTimeMs: 30_000,
    dataShape: "value",
    retry: false,
  });
  const projects = useFetchQuery({
    queryKey: ["orca-projects", serverId],
    queryFn: () => readProjects({}),
    staleTimeMs: 60_000,
    dataShape: "value",
    retry: false,
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
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  const available = !query.isError && query.data?.available === true;
  const nodes = new Map((fleet.data?.nodes ?? []).map((node) => [node.id, node]));
  const projectName = new Map((projects.data?.projects ?? []).map((p) => [p.id, p.name]));
  const leads = available
    ? (query.data!.projectSeats ?? []).filter((seat) => seat.state === "assigned")
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
      {available ? (
        query.data!.primes.map((seat) => (
          <LeadRow
            key={seat.seat}
            seat={seat}
            title={primeName(seat.seat)}
            node={seat.sessionId ? nodes.get(seat.sessionId) : undefined}
            navigation={navigation}
            leadership={leadership}
            onBeforeNavigate={onBeforeNavigate}
            testID={`sidebar-prime-${seat.seat}`}
          />
        ))
      ) : (
        <SidebarHeaderRow
          icon={RefreshCw}
          label={
            query.isPending ? "Loading main assistants…" : "Couldn't load main assistants · Retry"
          }
          variant="compact"
          onPress={retry}
        />
      )}
      {available && query.data!.primes.length === 0 && (
        <SidebarHeaderRow
          icon={Crown}
          label="No main assistant yet · Set up"
          variant="compact"
          onPress={leadership}
        />
      )}
      {leads.map((seat) => (
        <LeadRow
          key={`project:${seat.seat}`}
          seat={seat}
          title={`Project lead · ${(seat.projectId && projectName.get(seat.projectId)) || "project"}`}
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

/** "Working · Mac mini", "Empty slot", or "Unavailable" when the session cannot be opened from here. */
export function leadStatusLine(seat: Seat, node: FleetNode | undefined, canOpen: boolean): string {
  if (seat.state === "vacant") return "Empty slot";
  if (!canOpen) return "Unavailable";
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
}: {
  seat: Seat;
  title: string;
  node: FleetNode | undefined;
  navigation: ReturnType<typeof usePluginHostNavigation>;
  leadership: () => void;
  onBeforeNavigate?: () => void;
  testID: string;
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
  const status = leadStatusLine(seat, node, canOpen);
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
