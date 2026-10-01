import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import {
  contextAgentIdentity,
  contextWorkspaceKey,
  makeContextSelection,
  matchesContextSelection,
  useContextScope,
} from "./scope";
import { useContextObservation } from "./observation";
import { ContextAccountSummary, ContextSessionMetadata } from "./account-sessions";
import { ContextCheckout } from "./checkout";
import { ContextContainedFiles, ContextProviderChildren } from "./resources";
import { ContextReports } from "./reports";
import { ContextOutputs } from "./outputs";
import { ContextManagedOutputs } from "./managed-outputs";
import { ContextManagedContent } from "./managed-content";
import type { ReactNode } from "react";

interface ContextContentProps {
  serverId: string;
  workspaceId: string;
  onOpenTarget: (target: WorkspaceTabTarget) => void;
  onOpenExplorer: (view: "files" | "changes" | "pr") => void;
}

const noSubscription = () => () => {};
export function ContextContent(props: ContextContentProps) {
  const { serverId, workspaceId } = props;
  const client = useHostRuntimeClient(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const active = useRetainedPanelActive();
  // Session-store's display serverInfo intentionally omits permissions. Observe the
  // admitted client handshake itself, including revocation, without widening it.
  const subscribe = useCallback(
    (notify: () => void) => client?.subscribe(notify) ?? noSubscription(),
    [client],
  );
  const snapshot = useCallback(
    () =>
      JSON.stringify([
        client?.getLastServerInfoMessage()?.serverId ?? null,
        client?.getLastServerInfoMessage()?.permissions ?? null,
      ]),
    [client],
  );
  const admission = useSyncExternalStore(subscribe, snapshot, snapshot);
  const allowed =
    client?.getLastServerInfoMessage()?.permissions?.includes("workspace.read") === true;
  const select = useContextScope((state) => state.select);
  useEffect(() => {
    if (!allowed || !connected) select(contextWorkspaceKey(serverId, workspaceId), null);
  }, [allowed, connected, select, serverId, workspaceId]);
  const session = useSessionStore((state) => state.sessions[serverId]);
  const workspace = session?.workspaces.get(workspaceId);
  const selection = useContextScope(
    (state) => state.selected[contextWorkspaceKey(serverId, workspaceId)] ?? null,
  );
  const selectedAgent = selection ? session?.agents.get(selection.agentId) : undefined;
  const liveIdentity = selectedAgent ? contextAgentIdentity(selectedAgent) : null;
  const { t } = useTranslation();
  if (!connected)
    return <Message>{t("context.offline", { defaultValue: "Offline — status unknown" })}</Message>;
  if (!client?.getLastServerInfoMessage()?.permissions)
    return (
      <Message>
        {t("context.admissionUnsupported", {
          defaultValue: "Workspace observation needs a host with explicit permission support.",
        })}
      </Message>
    );
  if (!allowed)
    return (
      <Message>
        {t("context.forbidden", {
          defaultValue: "Workspace observation is not permitted by this host.",
        })}
      </Message>
    );
  if (!workspace || session?.client !== client)
    return <Message>{t("context.loading", { defaultValue: "Loading workspace…" })}</Message>;
  return (
    <AdmittedContext
      key={JSON.stringify([
        serverId,
        workspaceId,
        session?.clientGeneration,
        admission,
        selection?.identity,
        liveIdentity,
      ])}
      {...props}
      active={active}
    />
  );
}

function AdmittedContext({
  serverId,
  workspaceId,
  onOpenTarget,
  onOpenExplorer,
  active,
}: ContextContentProps & { active: boolean }) {
  const { t } = useTranslation();
  const session = useSessionStore((state) => state.sessions[serverId]);
  const workspace = session?.workspaces.get(workspaceId);
  const { selected, validAgent, selectSession, selectWorkspace } = useContextAgent(
    serverId,
    workspaceId,
  );
  const openFiles = useCallback(() => onOpenExplorer("files"), [onOpenExplorer]);
  const openChanges = useCallback(() => onOpenExplorer("changes"), [onOpenExplorer]);
  const openPr = useCallback(() => onOpenExplorer("pr"), [onOpenExplorer]);
  const openArchitecture = useCallback(
    () => onOpenTarget({ kind: "architecture_map" }),
    [onOpenTarget],
  );
  if (!workspace) return null;
  return (
    <View style={styles.fill}>
      <ContextHeading
        name={workspace.name}
        host={session?.serverInfo?.hostname ?? serverId}
        agent={validAgent}
        selected={Boolean(selected)}
        onWorkspace={selectWorkspace}
      />
      <ScrollView contentContainerStyle={styles.content}>
        <ContextGroup
          label={t("context.files", { defaultValue: "Files & outputs" })}
          defaultExpanded={true}
        >
          <>
            <ContextOutputs
              serverId={serverId}
              workspaceId={workspaceId}
              agent={validAgent}
              active={active}
            />
            <ContextManagedOutputs
              serverId={serverId}
              workspaceId={workspaceId}
              agent={validAgent}
              active={active}
            />
            <ContextManagedContent
              serverId={serverId}
              workspaceId={workspaceId}
              agent={validAgent}
              active={active}
            />
            {active ? (
              <ContextContainedFiles
                serverId={serverId}
                workspaceId={workspaceId}
                active={active}
                onOpenTarget={onOpenTarget}
              />
            ) : null}
            <Button variant="ghost" onPress={openFiles}>
              {t("context.browseFiles", { defaultValue: "Browse workspace files" })}
            </Button>
            {validAgent ? (
              <OpenTargetButton kind="agent" id={validAgent.id} onOpenTarget={onOpenTarget}>
                {t("context.sessionOutputs", {
                  defaultValue: "View outputs and attachments in session",
                })}
              </OpenTargetButton>
            ) : null}
            <Message>
              {t("context.attachmentNote", {
                defaultValue: "Composer attachments are draft inputs, not produced artifacts.",
              })}
            </Message>
          </>
        </ContextGroup>
        <ContextGroup
          label={t("context.git", { defaultValue: "Git — workspace" })}
          defaultExpanded={true}
        >
          <ContextGit workspace={workspace} onChanges={openChanges} onPr={openPr} />
          {active ? (
            <ContextCheckout
              serverId={serverId}
              workspaceId={workspaceId}
              active={active}
              onOpenTarget={onOpenTarget}
            />
          ) : null}
          <Button variant="ghost" onPress={openArchitecture}>
            {t("panels.architectureMap.label", { defaultValue: "Architecture map" })}
          </Button>
        </ContextGroup>
        <ContextGroup
          label={t("context.terminals", { defaultValue: "Terminals & scripts — workspace" })}
          defaultExpanded={false}
        >
          {active ? (
            <ContextTerminals
              serverId={serverId}
              workspaceId={workspaceId}
              onOpenTarget={onOpenTarget}
            />
          ) : null}
        </ContextGroup>
        <ContextGroup
          label={t("context.sessions", { defaultValue: "Sessions" })}
          defaultExpanded={false}
        >
          {!selected || validAgent ? (
            <ContextAccountSummary
              serverId={serverId}
              workspaceId={workspaceId}
              agentId={validAgent?.id}
              active={active}
            />
          ) : null}
          {active && (!selected || validAgent) ? (
            <ContextSessions
              key={selected?.identity ?? "workspace"}
              serverId={serverId}
              workspaceId={workspaceId}
              agentId={validAgent?.id ?? null}
              onSelect={selectSession}
              onOpenTarget={onOpenTarget}
            />
          ) : null}
        </ContextGroup>
        <ContextGroup
          label={t("context.receipts", { defaultValue: "Receipts & reports" })}
          defaultExpanded={false}
        >
          <ContextReports
            serverId={serverId}
            workspaceId={workspaceId}
            agent={validAgent}
            active={active}
          />
        </ContextGroup>
      </ScrollView>
    </View>
  );
}

function ContextTerminals({
  serverId,
  workspaceId,
  onOpenTarget,
}: Pick<ContextContentProps, "serverId" | "workspaceId" | "onOpenTarget">) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const workspace = useSessionStore((state) =>
    state.sessions[serverId]?.workspaces.get(workspaceId),
  );
  const cwd = workspace?.workspaceDirectory ?? "";
  const observe = useCallback(
    (
      publish: (
        data: Awaited<ReturnType<NonNullable<typeof client>["listTerminals"]>>["terminals"],
      ) => void,
      fail: () => void,
    ) => {
      if (!client) return () => {};
      const controller = new AbortController();
      const observation = client.observeTerminals({ cwd, workspaceId, signal: controller.signal });
      const detach = observation.subscribe({
        snapshot: (data) => publish(data.terminals),
        update: (message) => {
          if (message.type !== "terminals_changed") return;
          if (
            message.payload.workspaceId === workspaceId ||
            message.payload.subscriptionId === observation.subscriptionId
          )
            publish(message.payload.terminals);
        },
        error: fail,
      });
      void observation.ready.catch(fail);
      return () => {
        controller.abort();
        detach();
        void observation.release().catch(() => {});
      };
    },
    [client, cwd, workspaceId],
  );
  const result = useContextObservation(
    JSON.stringify([serverId, workspaceId, cwd]),
    Boolean(client && cwd),
    observe,
  );
  const [limit, setLimit] = useState(20);
  if (result.status !== "loaded")
    return (
      <Message>
        {result.status === "error"
          ? t("context.loadError", { defaultValue: "Unable to observe terminals" })
          : t("context.loadingTerminals", { defaultValue: "Loading terminals…" })}
      </Message>
    );
  return (
    <>
      {result.data.length === 0 ? (
        <Message>{t("context.noTerminals", { defaultValue: "No observed terminals" })}</Message>
      ) : null}
      {result.data.slice(0, limit).map((terminal) => (
        <View key={terminal.id} style={styles.row}>
          <OpenTargetButton kind="terminal" id={terminal.id} onOpenTarget={onOpenTarget}>
            {terminal.name}
          </OpenTargetButton>
          <StatusBadge
            label={
              terminal.activity?.state ?? t("context.unknown", { defaultValue: "Status unknown" })
            }
          />
        </View>
      ))}
      {Math.max(result.data.length, workspace?.scripts.length ?? 0) > limit ? (
        <MoreRows
          count={Math.max(result.data.length, workspace?.scripts.length ?? 0)}
          setLimit={setLimit}
        />
      ) : null}
      {workspace?.scripts.slice(0, limit).map((script) => (
        <View key={script.scriptName} style={styles.row}>
          <Text style={styles.metadata}>
            {script.scriptName} · {script.lifecycle}
          </Text>
          {script.terminalId &&
          result.data.some((terminal) => terminal.id === script.terminalId) ? (
            <OpenTargetButton kind="terminal" id={script.terminalId} onOpenTarget={onOpenTarget}>
              {t("context.view", { defaultValue: "View" })}
            </OpenTargetButton>
          ) : null}
        </View>
      ))}
    </>
  );
}

function ContextSessions({
  serverId,
  workspaceId,
  agentId,
  onSelect,
  onOpenTarget,
}: Pick<ContextContentProps, "serverId" | "workspaceId" | "onOpenTarget"> & {
  agentId: string | null;
  onSelect: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const [limit, setLimit] = useState(20);
  const agents = useSessionStore((state) => state.sessions[serverId]?.agents);
  if (agentId)
    return (
      <ContextChildren
        key={JSON.stringify([
          agentId,
          agents?.get(agentId)?.createdAt,
          agents?.get(agentId)?.runtimeInfo?.sessionId,
          agents?.get(agentId)?.runtimeInstanceId,
        ])}
        serverId={serverId}
        workspaceId={workspaceId}
        agentId={agentId}
        onOpenTarget={onOpenTarget}
      />
    );
  const rows = [...(agents?.values() ?? [])].filter(
    (agent) => agent.workspaceId === workspaceId && !agent.archivedAt,
  );
  return (
    <>
      {rows.length === 0 ? (
        <Message>{t("context.noSessions", { defaultValue: "No observed sessions" })}</Message>
      ) : null}
      {rows.slice(0, limit).map((agent) => (
        <View key={agent.id} style={styles.row}>
          <SelectSessionButton id={agent.id} onSelect={onSelect}>
            {agent.title ?? agent.id}
          </SelectSessionButton>
          <ContextSessionMetadata agent={agent} />
          <OpenTargetButton kind="agent" id={agent.id} onOpenTarget={onOpenTarget}>
            {t("context.openSession", { defaultValue: "Open session" })}
          </OpenTargetButton>
        </View>
      ))}
      {rows.length > limit ? <MoreRows count={rows.length} setLimit={setLimit} /> : null}
    </>
  );
}

function ContextChildren({
  serverId,
  agentId,
  workspaceId,
  onOpenTarget,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  onOpenTarget: ContextContentProps["onOpenTarget"];
}) {
  const { t } = useTranslation();
  const agents = useSessionStore((state) => state.sessions[serverId]?.agents);
  const rows = [...(agents?.values() ?? [])].filter(
    (agent) =>
      agent.parentAgentId === agentId && agent.workspaceId === workspaceId && !agent.archivedAt,
  );
  const [limit, setLimit] = useState(20);
  return (
    <>
      <Message>{t("context.children", { defaultValue: "Managed child sessions" })}</Message>
      <ContextProviderChildren
        serverId={serverId}
        workspaceId={workspaceId}
        agentId={agentId}
        active={true}
        onOpenTarget={onOpenTarget}
      />
      {rows.length === 0 ? (
        <Message>{t("context.noChildren", { defaultValue: "No observed child sessions" })}</Message>
      ) : null}
      {rows.slice(0, limit).map((row) => (
        <View key={row.id} style={styles.row}>
          <OpenTargetButton kind="agent" id={row.id} onOpenTarget={onOpenTarget}>
            {row.title ?? row.id}
          </OpenTargetButton>
          <Text style={styles.metadata}>
            {t("context.managed", { defaultValue: "Managed child session" })}
          </Text>
          <ContextSessionMetadata agent={row} />
        </View>
      ))}
      {rows.length > limit ? <MoreRows count={rows.length} setLimit={setLimit} /> : null}
    </>
  );
}
function Message({ children }: { children: ReactNode }) {
  return <Text style={styles.metadata}>{children}</Text>;
}
const styles = StyleSheet.create((theme) => ({
  fill: { flex: 1 },
  heading: {
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  metadata: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  content: { padding: theme.spacing[3], gap: theme.spacing[4] },
  group: { gap: theme.spacing[2] },
  row: { gap: theme.spacing[1] },
}));

function ContextGroup({
  label,
  defaultExpanded,
  children,
}: {
  label: string;
  defaultExpanded: boolean;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const toggle = useCallback(() => setExpanded((value) => !value), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  return (
    <View style={styles.group}>
      <Button variant="ghost" accessibilityState={accessibilityState} onPress={toggle}>
        {label}
      </Button>
      {expanded ? children : null}
    </View>
  );
}
function OpenTargetButton({
  kind,
  id,
  onOpenTarget,
  children,
}: {
  kind: "agent" | "terminal";
  id: string;
  onOpenTarget: ContextContentProps["onOpenTarget"];
  children: ReactNode;
}) {
  const open = useCallback(
    () => onOpenTarget(kind === "agent" ? { kind, agentId: id } : { kind, terminalId: id }),
    [id, kind, onOpenTarget],
  );
  return (
    <Button variant="ghost" onPress={open}>
      {children}
    </Button>
  );
}
function SelectSessionButton({
  id,
  onSelect,
  children,
}: {
  id: string;
  onSelect: (id: string) => void;
  children: ReactNode;
}) {
  const select = useCallback(() => onSelect(id), [id, onSelect]);
  return (
    <Button variant="ghost" onPress={select}>
      {children}
    </Button>
  );
}
function MoreRows({
  count,
  setLimit,
}: {
  count: number;
  setLimit: React.Dispatch<React.SetStateAction<number>>;
}) {
  const { t } = useTranslation();
  const more = useCallback(
    () => setLimit((value) => Math.min(value + 20, count)),
    [count, setLimit],
  );
  return (
    <Button variant="ghost" onPress={more}>
      {t("context.more", { defaultValue: "Show more" })}
    </Button>
  );
}

function ContextGit({
  workspace,
  onChanges,
  onPr,
}: {
  workspace: import("@/stores/session-store").WorkspaceDescriptor;
  onChanges: () => void;
  onPr: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Message>
        {workspace.gitRuntime?.currentBranch ??
          t("context.branchUnknown", { defaultValue: "Branch unknown or detached HEAD" })}
      </Message>
      <Message>
        {workspace.worktreeSlug ??
          t("context.worktreeUnknown", { defaultValue: "Worktree label unavailable" })}
      </Message>
      <Message>
        {workspace.diffStat
          ? `+${workspace.diffStat.additions} −${workspace.diffStat.deletions}`
          : t("context.diffUnknown", { defaultValue: "Changes unknown" })}
      </Message>
      <Button variant="ghost" onPress={onChanges}>
        {t("context.changes", { defaultValue: "View workspace changes and commits" })}
      </Button>
      <Message>
        {t("context.prUnknown", {
          defaultValue: "Pull request status uses the host’s existing forge view.",
        })}
      </Message>
      <Button variant="ghost" onPress={onPr}>
        {t("context.pr", { defaultValue: "View workspace pull request" })}
      </Button>
    </>
  );
}

function ContextHeading({
  name,
  host,
  agent,
  selected,
  onWorkspace,
}: {
  name: string;
  host: string;
  agent: import("@/stores/session-store").Agent | null | undefined;
  selected: boolean;
  onWorkspace: () => void;
}) {
  const { t } = useTranslation();
  const scope = agent
    ? (agent.title ?? agent.id)
    : t(selected ? "context.sessionUnavailable" : "context.workspace", {
        defaultValue: selected ? "Session unavailable" : "Workspace",
      });
  return (
    <View style={styles.heading}>
      <Text style={styles.title}>{name}</Text>
      <Text style={styles.metadata}>{host}</Text>
      <Text style={styles.metadata}>
        {t("context.scope", { defaultValue: "Scope: {{scope}}", scope })}
      </Text>
      {agent ? <ContextSessionMetadata agent={agent} /> : null}
      {selected && !agent ? (
        <Message>
          {t("context.scopeMissing", {
            defaultValue: "Selected session is unavailable. Choose a current session.",
          })}
        </Message>
      ) : null}
      <Button variant="ghost" size="sm" onPress={onWorkspace}>
        {t("context.workspaceScope", { defaultValue: "Workspace scope" })}
      </Button>
    </View>
  );
}

function useContextAgent(serverId: string, workspaceId: string) {
  const session = useSessionStore((state) => state.sessions[serverId]);
  const key = contextWorkspaceKey(serverId, workspaceId);
  const selected = useContextScope((state) => state.selected[key] ?? null);
  const select = useContextScope((state) => state.select);
  const agent = selected ? session?.agents.get(selected.agentId) : undefined;
  const validAgent =
    selected &&
    matchesContextSelection(selected, agent, session?.clientGeneration ?? -1) &&
    agent?.workspaceId === workspaceId
      ? agent
      : null;
  const selectSession = useCallback(
    (id: string) => {
      const current = useSessionStore.getState().sessions[serverId];
      if (!current) return;
      const next = current.agents.get(id);
      if (next?.workspaceId === workspaceId)
        select(key, makeContextSelection(next, current.clientGeneration));
    },
    [key, select, serverId, workspaceId],
  );
  const selectWorkspace = useCallback(() => select(key, null), [key, select]);
  return { selected, validAgent, selectSession, selectWorkspace };
}
