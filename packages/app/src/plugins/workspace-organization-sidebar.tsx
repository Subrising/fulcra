import React, { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { router } from "expo-router";
import { FolderKanban, FolderGit2, MessageSquare } from "lucide-react-native";
import { ScrollView, Text, View } from "react-native";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { OrganizationExecutionRow } from "@/components/sidebar-workspace-list";
import { SidebarSessions } from "@/components/sidebar/sidebar-sessions";
import {
  PinnedSectionHeader,
  PinnedHostConnectionNotice,
} from "@/components/sidebar/pinned-section-header";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { applyStoredOrdering } from "@/hooks/sidebar-workspaces-view-model";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { StyleSheet } from "react-native-unistyles";
import { pluginRegistry, useControllerInstallations } from "./registry";
import { PluginInstallationProvider } from "./installation-provider";
import { useHostRuntimeClient, useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { getPreferredPluginContributionHost, WORKSPACES_PREFERENCE_KEY } from "./contribution-host";
import { useOrganizationIntakePreferences } from "@/stores/organization-intake-preferences-store";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useFetchQuery } from "@/data/query";
import { useContract } from "../../../../control/orca-organization/client/use-contract";
import {
  organizationDirectoryRpc,
  type OrganizationState,
  type WorkspaceUmbrella,
  type OrganizationProject,
} from "../../../../control/orca-organization/shared/workspace-organization";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import {
  organizationContextEntries,
  selectOrganizationSource,
} from "./workspace-organization-model";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";
interface Props {
  projects: SidebarProjectEntry[];
  entries: ReadonlyMap<string, SidebarWorkspaceEntry>;
  header?: ReactNode;
  footer?: ReactNode;
  fallback: ReactNode;
  beforeNavigate?: () => void;
}
export function WorkspaceOrganizationSidebar(props: Props) {
  const installed = useControllerInstallations().filter((plugin) =>
    plugin.surfaces.some((surface) => surface.id === "workspaces"),
  );
  const configured = useOrganizationIntakePreferences((state) => state.companyHost);
  const preferred = configured ?? getPreferredPluginContributionHost(WORKSPACES_PREFERENCE_KEY);
  const plugin = selectOrganizationSource(installed, preferred);
  const client = useHostRuntimeClient(plugin?.serverId ?? "");
  const [cached, setCached] = useState<{ serverId: string; data: OrganizationState } | null>(null);
  const remember = useStableEvent((serverId: string, data: OrganizationState) =>
    setCached((before) =>
      before?.serverId === serverId && before.data.revision >= data.revision
        ? before
        : { serverId, data },
    ),
  );
  if (plugin && client)
    return (
      <PluginInstallationProvider plugin={plugin}>
        <OrganizationReader {...props} serverId={plugin.serverId} remember={remember} />
      </PluginInstallationProvider>
    );
  if (cached && cached.serverId === preferred && cached.data.workspaces.length)
    return <OrganizationRows {...props} serverId={cached.serverId} data={cached.data} offline />;
  return props.fallback;
}
function OrganizationReader(
  props: Props & { serverId: string; remember: (id: string, data: OrganizationState) => void },
) {
  const read = useContract(organizationDirectoryRpc);
  const connected = useHostRuntimeIsConnected(props.serverId);
  const { remember, serverId } = props;
  const query = useFetchQuery({
    queryKey: ["fulcra-workspace-organization", props.serverId],
    queryFn: () => read({}),
    dataShape: "value",
    staleTimeMs: 30000,
    retry: false,
  });
  useEffect(() => {
    if (query.data) remember(serverId, query.data);
  }, [query.data, remember, serverId]);
  const { refetch } = query;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  if (!query.data?.workspaces.length)
    return (
      <>
        {query.isError && (
          <SidebarHeaderRow
            icon={FolderKanban}
            label="Company grouping unavailable · Retry"
            variant="compact"
            onPress={retry}
          />
        )}
        {props.fallback}
      </>
    );
  return <OrganizationRows {...props} data={query.data} offline={!connected || query.isError} />;
}
function OrganizationRows(
  props: Props & { serverId: string; data: OrganizationState; offline?: boolean },
) {
  const [outsideOpen, setOutsideOpen] = useState(false);
  const toggleOutside = useCallback(() => setOutsideOpen((open) => !open), []);
  const pinnedCollapsed = useSidebarCollapsedSectionsStore((state) => state.collapsedPinned);
  const togglePinned = useSidebarCollapsedSectionsStore((state) => state.togglePinnedCollapsed);
  const assigned = new Set(
    props.data.workspaces.flatMap((workspace) =>
      workspace.projects.flatMap((project) =>
        organizationContextEntries(project, props).map((entry) => entry.workspaceKey),
      ),
    ),
  );
  const outside = [...props.entries.values()].filter(
    (entry) => !assigned.has(entry.workspaceKey) && !entry.pinnedAt,
  );
  const storedPinOrder = useSidebarOrderStore((state) => state.pinnedWorkspaceOrder);
  const pinned = applyStoredOrdering({
    items: [...props.entries.values()]
      .filter((entry) => !!entry.pinnedAt)
      .sort((a, b) => (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "")),
    storedOrder: storedPinOrder,
    getKey: (entry) => entry.workspaceKey,
  });
  const hosts = useHosts();
  const ids = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const names = useMemo(() => new Map(hosts.map((host) => [host.serverId, host.label])), [hosts]);
  return (
    <ScrollView keyboardShouldPersistTaps="handled" style={styles.scroll}>
      {props.header}
      {props.offline && (
        <Text style={styles.notice}>Company connection unavailable · showing saved grouping.</Text>
      )}
      {pinned.length > 0 && (
        <>
          <PinnedSectionHeader collapsed={pinnedCollapsed} onToggle={togglePinned} />
          <PinnedHostConnectionNotice workspaces={pinned} />
          {!pinnedCollapsed &&
            pinned.map((entry) => (
              <OrganizationExecutionRow
                key={`pin:${entry.workspaceKey}`}
                workspace={entry}
                beforeNavigate={props.beforeNavigate}
              />
            ))}
        </>
      )}
      {props.data.workspaces.map((workspace) => (
        <UmbrellaRows key={workspace.id} workspace={workspace} {...props} />
      ))}
      <SidebarHeaderRow
        icon={FolderKanban}
        label={`Other execution contexts (${outside.length})`}
        accessibilityLabel="Other saved execution contexts"
        onPress={toggleOutside}
        variant="compact"
      />
      {outsideOpen &&
        outside.map((entry) => (
          <ContextRow
            key={entry.workspaceKey}
            entry={entry}
            beforeNavigate={props.beforeNavigate}
          />
        ))}
      <SidebarSessions serverIds={ids} hostNames={names} onSelect={props.beforeNavigate} />
      {props.footer}
    </ScrollView>
  );
}
function UmbrellaRows({
  workspace,
  ...props
}: Props & { workspace: WorkspaceUmbrella; serverId: string }) {
  const [open, setOpen] = useState(true);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  return (
    <View>
      <SidebarHeaderRow
        icon={FolderKanban}
        label={workspace.name}
        accessibilityLabel={`${workspace.name}, ${workspace.projects.length} projects`}
        onPress={toggle}
        variant="compact"
      />
      {open && (
        <View style={styles.indent}>
          {workspace.projects.map((project) => (
            <ProjectRows key={project.key} project={project} workspace={workspace} {...props} />
          ))}
        </View>
      )}
    </View>
  );
}
function ProjectRows({
  project,
  workspace,
  ...props
}: Props & { workspace: WorkspaceUmbrella; project: OrganizationProject; serverId: string }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const contexts = organizationContextEntries(project, props).filter((entry) => !entry.pinnedAt);
  const tasks = workspace.tasks.filter((task) => task.projectKey === project.key);
  return (
    <View>
      <SidebarHeaderRow icon={FolderGit2} label={project.name} onPress={toggle} variant="compact" />
      {open && (
        <View style={styles.indent}>
          {tasks
            .filter((task) => !task.parentId)
            .map((task) => (
              <PlanningRow
                key={task.id}
                task={task}
                tasks={tasks}
                workspaceId={workspace.id}
                serverId={props.serverId}
                beforeNavigate={props.beforeNavigate}
              />
            ))}
          {!contexts.length && (
            <Text style={styles.notice}>
              {organizationContextEntries(project, props).length
                ? "Execution contexts are pinned above."
                : "No saved execution contexts are available for this project."}
            </Text>
          )}
          {contexts.map((entry) => (
            <ContextRow
              key={entry.workspaceKey}
              entry={entry}
              beforeNavigate={props.beforeNavigate}
            />
          ))}
        </View>
      )}
    </View>
  );
}
function PlanningRow({
  task,
  tasks,
  workspaceId,
  serverId,
  beforeNavigate,
}: {
  task: WorkspaceUmbrella["tasks"][number];
  tasks: WorkspaceUmbrella["tasks"];
  workspaceId: string;
  serverId: string;
  beforeNavigate?: () => void;
}) {
  const open = useCallback(
    () =>
      router.push(
        `/h/${encodeURIComponent(serverId)}/plugin/${encodeURIComponent(pluginRegistry.controllerPluginId(serverId))}/surface/workspaces?workspace=${encodeURIComponent(workspaceId)}`,
      ),
    [serverId, workspaceId],
  );
  return (
    <View>
      <SidebarHeaderRow
        icon={FolderKanban}
        label={`${task.kind === "feature" ? "Feature" : "Task"}: ${task.title} · ${task.status ?? "planned"}`}
        variant="compact"
        onPress={open}
      />
      <View style={styles.indent}>
        {task.sessions.map((session) => (
          <SessionRow
            key={`${session.serverId}:${session.agentId}`}
            serverId={session.serverId}
            agentId={session.agentId}
            title="Linked conversation"
            beforeNavigate={beforeNavigate}
          />
        ))}
        {tasks
          .filter((child) => child.parentId === task.id)
          .map((child) => (
            <PlanningRow
              key={child.id}
              task={child}
              tasks={tasks}
              workspaceId={workspaceId}
              serverId={serverId}
              beforeNavigate={beforeNavigate}
            />
          ))}
      </View>
    </View>
  );
}
function ContextRow({
  entry,
  beforeNavigate,
}: {
  entry: SidebarWorkspaceEntry;
  beforeNavigate?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  return (
    <View>
      <OrganizationExecutionRow workspace={entry} beforeNavigate={beforeNavigate} />
      <SidebarHeaderRow
        icon={MessageSquare}
        label={expanded ? "Hide related sessions" : "Related sessions"}
        variant="compact"
        onPress={toggle}
      />
      {expanded && (
        <ContextSessions
          serverId={entry.serverId}
          workspaceId={entry.workspaceId}
          beforeNavigate={beforeNavigate}
        />
      )}
    </View>
  );
}
function ContextSessions({
  serverId,
  workspaceId,
  beforeNavigate,
}: {
  serverId: string;
  workspaceId: string;
  beforeNavigate?: () => void;
}) {
  const agents = useSessionStore((state) => state.sessions[serverId]?.agents);
  return (
    <View style={styles.indent}>
      {[...(agents?.values() ?? [])]
        .filter((agent) => agent.workspaceId === workspaceId && !agent.archivedAt)
        .map((agent) => (
          <SessionRow
            key={agent.id}
            serverId={serverId}
            agentId={agent.id}
            title={agent.title ?? "Saved conversation"}
            beforeNavigate={beforeNavigate}
          />
        ))}
    </View>
  );
}
function SessionRow({
  serverId,
  agentId,
  title,
  beforeNavigate,
}: {
  serverId: string;
  agentId: string;
  title: string;
  beforeNavigate?: () => void;
}) {
  const open = useCallback(() => {
    beforeNavigate?.();
    navigateToAgent({ serverId, agentId });
  }, [agentId, beforeNavigate, serverId]);
  return <SidebarHeaderRow icon={MessageSquare} label={title} variant="compact" onPress={open} />;
}
const styles = StyleSheet.create((theme) => ({
  scroll: { flex: 1 },
  indent: { paddingLeft: theme.spacing[2] },
  notice: { color: theme.colors.foregroundMuted, padding: theme.spacing[2] },
}));
