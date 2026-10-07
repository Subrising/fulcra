import React, { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsInput, SettingsGroup, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useWorkspacesForm } from "./use-workspaces-form";
import { roleDirectoryRpc, type Seat } from "../../shared/roles";
import { useContract } from "../use-contract";
import { WorkButton } from "../work-button";
import { useOrganization } from "./use-organization";
import { useNativeCatalog } from "./use-native-catalog";
import type { OrganizationProject, WorkspaceUmbrella } from "../../shared/workspace-organization";
import type { OrganizationNavigation } from "../../shared/intake-draft";
type SurfaceProps = PluginSurfaceProps & {
  organizationNavigation?: OrganizationNavigation;
  embedded?: boolean;
  initialWorkspaceId?: string;
};
type Catalog = ReturnType<typeof useNativeCatalog>;
type Changes = ReturnType<typeof useOrganization>;
type Run = (action: () => Promise<unknown>) => Promise<void>;
export function WorkspacesSurface(props: SurfaceProps) {
  const { query, mutate, retry, pendingAction } = useOrganization(props.host.id);
  const catalog = useNativeCatalog(),
    readRoles = useContract(roleDirectoryRpc);
  const roles = useQuery({
    queryKey: ["orca-role-directory", props.host.id],
    queryFn: () => readRoles({}),
    retry: false,
    staleTime: 30000,
  });
  const { model, state, nameInput } = useWorkspacesForm();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [configureWorkspaceId, setConfigureWorkspaceId] = useState<string | null>(
    props.initialWorkspaceId ?? null,
  );
  const [receiverSearch, setReceiverSearch] = useState("");
  const [savedReceiverOpen, setSavedReceiverOpen] = useState(false);
  const c = props.theme.colors;
  const recorded = (roles.data?.primes ?? []).filter(
    (prime) => prime.state === "assigned" && prime.sessionId,
  );
  const selectPrime = (prime: Seat) => {
    const receiving = catalog.sessions.filter(
      (session) =>
        session.agentId === prime.sessionId &&
        catalog.hosts.some(
          (host) => host.serverId === session.serverId && host.status === "online",
        ),
    );
    if (receiving.length !== 1) {
      model.setNotice(
        "The receiving host is not uniquely confirmed. Open Main assistants to inspect its original conversation; no identity was replaced.",
      );
      return;
    }
    model.setPrime(
      {
        serverId: receiving[0].serverId,
        agentId: prime.sessionId!,
        seat: prime.seat,
        kind: "recorded-prime",
        label: `${prime.seat} prime`,
      },
      `${prime.seat} prime`,
    );
  };
  const content = (
    <View style={{ gap: 16, width: "100%", maxWidth: 760 }} testID="company-workspace-setup">
      <SettingsGroup title={query.data?.companyName ?? "Company workspaces"}>
        <Text style={{ color: c.foregroundMuted }}>
          Workspace → projects → features and tasks → conversations and execution contexts.
        </Text>
        {props.organizationNavigation && (
          <WorkButton
            theme={props.theme}
            label={`Use this company organisation from ${props.host.label || "this host"}`}
            onPress={props.organizationNavigation.setDefaultCompanySource}
          />
        )}
        <Text style={{ color: c.foregroundMuted }}>
          Company source: {props.host.label || "this host"}. Choosing this source changes app
          navigation, not project or session ownership.
        </Text>
        <WorkButton
          theme={props.theme}
          label={settingsOpen ? "Hide company settings" : "Company settings and new workspace"}
          onPress={() => setSettingsOpen((open) => !open)}
        />
        {(settingsOpen || query.data?.workspaces.length === 0) && (
          <View style={{ gap: 8 }}>
            <SettingsInput
              layout="stacked"
              label="Company display name"
              initialValue={state.companyName}
              onChangeText={model.setCompanyName}
              placeholder={query.data?.companyName ?? "Your company"}
            />
            <WorkButton
              theme={props.theme}
              label="Save company name"
              disabled={state.busy || !query.data || !state.companyName.trim()}
              onPress={() =>
                void model.run(() => mutate({ action: "name-company", name: state.companyName }))
              }
            />
            <SettingsSection title="New workspace">
              <SettingsInput
                layout="stacked"
                label="Workspace name"
                placeholder="AI Game Dev"
                ref={nameInput}
                initialValue={state.name}
                onChangeText={model.setName}
              />
              <Text style={{ color: c.foregroundMuted }}>Responsible intake prime</Text>
              <WorkButton
                theme={props.theme}
                label="Keep intake with me"
                selected={!state.prime}
                onPress={() => model.setPrime(null, "You")}
              />
              {recorded.map((prime) => (
                <WorkButton
                  key={prime.seat}
                  theme={props.theme}
                  label={`${prime.seat} prime`}
                  selected={state.prime?.agentId === prime.sessionId}
                  onPress={() => selectPrime(prime)}
                />
              ))}
              <WorkButton
                theme={props.theme}
                label={
                  savedReceiverOpen
                    ? "Hide saved intake conversations"
                    : "Choose a saved conversation for human-held intake"
                }
                expanded={savedReceiverOpen}
                onPress={() => setSavedReceiverOpen((open) => !open)}
              />
              {savedReceiverOpen && (
                <View style={{ gap: 8 }}>
                  <SettingsInput
                    layout="stacked"
                    label="Find the existing intake conversation"
                    initialValue={receiverSearch}
                    onChangeText={setReceiverSearch}
                  />
                  <Text style={{ color: c.foregroundMuted }}>
                    This records a human-held intake reference. It creates no prime seat, grants no
                    control and sends no instruction.
                  </Text>
                  {catalog.sessions
                    .filter((session) =>
                      session.title.toLowerCase().includes(receiverSearch.toLowerCase()),
                    )
                    .slice(0, 24)
                    .map((session) => (
                      <WorkButton
                        key={`${session.serverId}:${session.agentId}`}
                        theme={props.theme}
                        label={`Retain intake with ${session.title} · ${catalog.hosts.find((host) => host.serverId === session.serverId)?.label ?? "Saved host"}`}
                        selected={
                          state.prime?.serverId === session.serverId &&
                          state.prime.agentId === session.agentId
                        }
                        onPress={() =>
                          model.setPrime(
                            {
                              serverId: session.serverId,
                              agentId: session.agentId,
                              seat: null,
                              kind: "human-session",
                              label: session.title,
                            },
                            `${session.title} (human-held)`,
                          )
                        }
                      />
                    ))}
                  <Text style={{ color: c.foregroundMuted }}>
                    Showing up to 24 matching cached catalogue conversations. Search narrows this
                    list; unavailable host pages remain unknown.
                  </Text>
                </View>
              )}
              {!roles.data?.available && (
                <Text style={{ color: c.foregroundMuted }}>
                  Prime records are unavailable. Human-owned chats still use an existing project
                  context.
                </Text>
              )}
              <WorkButton
                theme={props.theme}
                disabled={state.busy || !state.name.trim() || !query.data}
                label="Create company workspace"
                onPress={() =>
                  void model.run(async () => {
                    const result = await mutate({
                      action: "create-workspace",
                      name: state.name,
                      prime: state.prime,
                    });
                    const created = result.workspaces.find(
                      (entry) => !query.data?.workspaces.some((old) => old.id === entry.id),
                    );
                    if (created) setConfigureWorkspaceId(created.id);
                    if (result.workspaces.length === 1)
                      props.organizationNavigation?.setDefaultCompanySource();
                    model.clearName();
                  })
                }
              />
            </SettingsSection>
          </View>
        )}
        {query.isPending && (
          <Text style={{ color: c.foregroundMuted }}>Reading company workspaces…</Text>
        )}
        {query.isError && (
          <WorkButton
            theme={props.theme}
            label="Retry company workspaces"
            onPress={() => {
              void query.refetch();
            }}
          />
        )}
        {state.busy && (
          <Text accessibilityLiveRegion="polite" style={{ color: c.foregroundMuted }}>
            Saving this organization update…
          </Text>
        )}
        {pendingAction && (
          <WorkButton
            theme={props.theme}
            label="Retry the retained unconfirmed update"
            disabled={state.busy}
            onPress={() => void model.run(retry)}
          />
        )}
        {!!state.notice && (
          <Text accessibilityLiveRegion="polite" style={{ color: c.foreground }}>
            {state.notice}
          </Text>
        )}
        {query.data?.workspaces.length === 0 && (
          <Text style={{ color: c.foregroundMuted }}>
            No company workspaces yet. Add existing projects after creating one; their repos, chats
            and worktrees keep their identities.
          </Text>
        )}
        {query.data?.workspaces.map((workspace) => (
          <SettingsSection key={workspace.id} title={workspace.name}>
            <Text style={{ color: c.foregroundMuted }}>
              Intake: {workspace.prime?.label ?? workspace.prime?.seat ?? "You"}
            </Text>
            <WorkButton
              theme={props.theme}
              label={
                query.data.defaultWorkspaceId === workspace.id
                  ? "Default workspace for new requests"
                  : `Use ${workspace.name} for new requests`
              }
              selected={query.data.defaultWorkspaceId === workspace.id}
              disabled={state.busy}
              onPress={() =>
                void model.run(async () => {
                  await mutate({ action: "default-workspace", workspaceId: workspace.id });
                  props.organizationNavigation?.setDefaultCompanySource();
                })
              }
            />
            <WorkButton
              theme={props.theme}
              label={
                configureWorkspaceId === workspace.id
                  ? "Hide workspace settings"
                  : `Manage ${workspace.name} intake and projects`
              }
              onPress={() =>
                setConfigureWorkspaceId((before) => (before === workspace.id ? null : workspace.id))
              }
            />
            {configureWorkspaceId === workspace.id && (
              <WorkButton
                theme={props.theme}
                label={`Use ${state.primeLabel} for ${workspace.name} intake`}
                disabled={state.busy}
                onPress={() =>
                  void model.run(() =>
                    mutate({ action: "set-prime", workspaceId: workspace.id, prime: state.prime }),
                  )
                }
              />
            )}
            {configureWorkspaceId === workspace.id && (
              <Text style={{ color: c.foregroundMuted }}>
                Choose the receiving prime in Company settings above, then apply it here. This
                records routing responsibility only.
              </Text>
            )}
            {props.organizationNavigation && (
              <WorkButton
                theme={props.theme}
                label={`New chat for ${workspace.name}`}
                onPress={() => props.organizationNavigation!.newIntake(workspace.id)}
              />
            )}
            {workspace.projects.map((project) => (
              <ProjectWork
                key={project.key}
                project={project}
                workspace={workspace}
                props={props}
                catalog={catalog}
                run={model.run}
                mutate={mutate}
                busy={state.busy}
              />
            ))}
            {configureWorkspaceId === workspace.id && (
              <>
                <SettingsInput
                  layout="stacked"
                  label={`Find an existing project for ${workspace.name}`}
                  initialValue={state.projectSearch}
                  onChangeText={model.setProjectSearch}
                  placeholder="Ship It or Demo Day"
                />
                {catalog.projects
                  .filter(
                    (project) =>
                      project.name
                        .toLocaleLowerCase()
                        .includes(state.projectSearch.toLocaleLowerCase()) &&
                      !query.data!.workspaces.some((group) =>
                        group.projects.some((child) =>
                          child.placements.some(
                            (ref) =>
                              ref.serverId === project.serverId &&
                              ref.projectId === project.projectId,
                          ),
                        ),
                      ),
                  )
                  .slice(0, 24)
                  .map((project) => (
                    <WorkButton
                      key={`${project.serverId}:${project.projectId}`}
                      theme={props.theme}
                      label={`Add ${project.name} · ${catalog.hosts.find((host) => host.serverId === project.serverId)?.label ?? "Saved host"}`}
                      disabled={state.busy}
                      onPress={() =>
                        void model.run(() =>
                          mutate({ action: "add-project", workspaceId: workspace.id, project }),
                        )
                      }
                    />
                  ))}
              </>
            )}
            {query.data.intakes
              .filter((intake) => intake.workspaceId === workspace.id)
              .map((intake) => (
                <View key={intake.id} style={{ gap: 4 }}>
                  <Text style={{ color: c.foregroundMuted }}>
                    Retained intake · {intake.state.replaceAll("-", " ")}
                  </Text>
                  {props.organizationNavigation && (
                    <WorkButton
                      theme={props.theme}
                      label={`Open intake: ${intake.text.slice(0, 100)}`}
                      onPress={() =>
                        props.organizationNavigation!.openIntake(intake.id, workspace.id)
                      }
                    />
                  )}
                </View>
              ))}
          </SettingsSection>
        ))}
        {props.organizationNavigation && (
          <WorkButton
            theme={props.theme}
            label="Create a real new project deliberately"
            onPress={props.organizationNavigation.createProject}
          />
        )}
        {catalog.partial && (
          <Text style={{ color: c.foregroundMuted }}>
            Some hosts or directory pages are unavailable. Existing grouping and conversation links
            are retained.
          </Text>
        )}
      </SettingsGroup>
    </View>
  );
  if (props.embedded) return content;
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: 16 }}
      keyboardShouldPersistTaps="handled"
    >
      {content}
    </ScrollView>
  );
}
function ProjectWork({
  project,
  workspace,
  props,
  catalog,
  run,
  mutate,
  busy,
}: {
  project: OrganizationProject;
  workspace: WorkspaceUmbrella;
  props: SurfaceProps;
  catalog: Catalog;
  run: Run;
  mutate: Changes["mutate"];
  busy: boolean;
}) {
  const { model, state, nameInput } = useWorkspacesForm();
  const [adding, setAdding] = useState(false);
  const tasks = workspace.tasks.filter((task) => task.projectKey === project.key);
  return (
    <SettingsSection title={project.name}>
      {project.placements.map(
        (ref) =>
          props.organizationNavigation && (
            <WorkButton
              key={`${ref.serverId}:${ref.projectId}`}
              theme={props.theme}
              label={`Manage existing ${project.name} · ${catalog.hosts.find((host) => host.serverId === ref.serverId)?.label ?? "Saved host"}`}
              onPress={() => props.organizationNavigation!.openProject(ref.serverId, ref.projectId)}
            />
          ),
      )}
      {tasks
        .filter((task) => !task.parentId)
        .map((task) => (
          <PlanningWork
            key={task.id}
            task={task}
            allTasks={tasks}
            project={project}
            workspace={workspace}
            props={props}
            catalog={catalog}
            run={run}
            mutate={mutate}
            busy={busy}
          />
        ))}
      <WorkButton
        theme={props.theme}
        label={adding ? "Hide new planning work" : `Add a feature or task to ${project.name}`}
        onPress={() => setAdding((open) => !open)}
      />
      {adding && (
        <>
          <SettingsInput
            layout="stacked"
            label={`New feature or task for ${project.name}`}
            ref={nameInput}
            initialValue={state.name}
            onChangeText={model.setName}
            placeholder="Onboarding"
          />
          <WorkButton
            theme={props.theme}
            label="No parent feature"
            selected={!state.parentId}
            onPress={() => model.setParent("")}
          />
          {tasks
            .filter((task) => task.kind === "feature")
            .map((task) => (
              <WorkButton
                key={task.id}
                theme={props.theme}
                label={`Under feature: ${task.title}`}
                selected={state.parentId === task.id}
                onPress={() => model.setParent(task.id)}
              />
            ))}
          {(["feature", "task"] as const).map((kind) => (
            <WorkButton
              key={kind}
              theme={props.theme}
              label={`Add ${kind} to ${project.name}`}
              disabled={busy || !state.name.trim()}
              onPress={() =>
                void run(async () => {
                  await mutate({
                    action: "add-task",
                    workspaceId: workspace.id,
                    projectKey: project.key,
                    title: state.name,
                    kind,
                    parentId: kind === "task" ? state.parentId || null : null,
                  });
                  model.clearName();
                })
              }
            />
          ))}
        </>
      )}
    </SettingsSection>
  );
}
function PlanningWork({
  task,
  allTasks,
  project,
  workspace,
  props,
  catalog,
  run,
  mutate,
  busy,
}: {
  task: WorkspaceUmbrella["tasks"][number];
  allTasks: WorkspaceUmbrella["tasks"];
  project: OrganizationProject;
  workspace: WorkspaceUmbrella;
  props: SurfaceProps;
  catalog: Catalog;
  run: Run;
  mutate: Changes["mutate"];
  busy: boolean;
}) {
  const c = props.theme.colors;
  const [managing, setManaging] = useState(false);
  const contexts = catalog.contexts.filter((context) =>
    project.placements.some(
      (ref) => ref.serverId === context.serverId && ref.projectId === context.projectId,
    ),
  );
  const eligible = catalog.sessions.filter((session) =>
    contexts.some(
      (context) =>
        context.serverId === session.serverId && context.workspaceId === session.workspaceId,
    ),
  );
  return (
    <View style={{ gap: 6, paddingLeft: task.parentId ? 12 : 0 }}>
      <Text style={{ color: c.foreground }}>
        {task.kind === "feature" ? "Feature" : "Task"}: {task.title}
      </Text>
      <Text style={{ color: c.foregroundMuted }}>
        Planning state: {task.status ?? "planned"} · Responsibility:{" "}
        {task.owner?.label ?? task.owner?.seat ?? "Unassigned"}
      </Text>
      <WorkButton
        theme={props.theme}
        label={managing ? "Hide planning controls" : `Manage ${task.title}`}
        onPress={() => setManaging((open) => !open)}
      />
      {managing && (
        <>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 4 }}>
            {(["planned", "active", "blocked", "done"] as const).map((status) => (
              <WorkButton
                key={status}
                theme={props.theme}
                label={`Mark ${task.title} ${status}`}
                selected={(task.status ?? "planned") === status}
                disabled={busy}
                onPress={() =>
                  void run(() =>
                    mutate({
                      action: "update-task",
                      workspaceId: workspace.id,
                      taskId: task.id,
                      status,
                      owner: task.owner ?? null,
                    }),
                  )
                }
              />
            ))}
          </View>
          <WorkButton
            theme={props.theme}
            label={`Keep ${task.title} unassigned`}
            disabled={busy}
            onPress={() =>
              void run(() =>
                mutate({
                  action: "update-task",
                  workspaceId: workspace.id,
                  taskId: task.id,
                  status: task.status ?? "planned",
                  owner: null,
                }),
              )
            }
          />
          {workspace.prime && (
            <WorkButton
              theme={props.theme}
              label={`Record ${workspace.prime.label ?? workspace.prime.seat ?? "intake"} as planning responsibility`}
              disabled={busy}
              onPress={() =>
                void run(() =>
                  mutate({
                    action: "update-task",
                    workspaceId: workspace.id,
                    taskId: task.id,
                    status: task.status ?? "planned",
                    owner: workspace.prime,
                  }),
                )
              }
            />
          )}
        </>
      )}
      {task.contexts?.map((context) => (
        <Text
          key={`${context.serverId}:${context.workspaceId}`}
          style={{ color: c.foregroundMuted }}
        >
          Execution context:{" "}
          {catalog.contexts.find(
            (entry) =>
              entry.serverId === context.serverId && entry.workspaceId === context.workspaceId,
          )?.name ?? "Saved context"}{" "}
          ·{" "}
          {catalog.hosts.find((host) => host.serverId === context.serverId)?.label ?? "Saved host"}
        </Text>
      ))}
      {task.sessions.map((session) => (
        <WorkButton
          key={`${session.serverId}:${session.agentId}`}
          theme={props.theme}
          label={`Open linked ${catalog.sessions.find((current) => current.serverId === session.serverId && current.agentId === session.agentId)?.title ?? "conversation"}`}
          onPress={() =>
            props.navigation?.openAgentOnHost?.({
              serverId: session.serverId,
              agentId: session.agentId,
            })
          }
        />
      ))}
      {managing &&
        eligible
          .filter(
            (session) =>
              !task.sessions.some(
                (linked) =>
                  linked.serverId === session.serverId && linked.agentId === session.agentId,
              ),
          )
          .slice(0, 8)
          .map((session) => (
            <WorkButton
              key={`${session.serverId}:${session.agentId}`}
              theme={props.theme}
              label={`Link existing conversation: ${session.title}`}
              disabled={busy}
              onPress={() =>
                void run(() => {
                  const context = contexts.find(
                    (entry) =>
                      entry.serverId === session.serverId &&
                      entry.workspaceId === session.workspaceId,
                  )!;
                  return mutate({
                    action: "link-session",
                    workspaceId: workspace.id,
                    taskId: task.id,
                    session: {
                      serverId: session.serverId,
                      agentId: session.agentId,
                      workspaceId: context.workspaceId,
                    },
                    context: {
                      serverId: context.serverId,
                      workspaceId: context.workspaceId,
                      projectId: context.projectId,
                    },
                  });
                })
              }
            />
          ))}
      {allTasks
        .filter((child) => child.parentId === task.id)
        .map((child) => (
          <PlanningWork
            key={child.id}
            task={child}
            allTasks={allTasks}
            project={project}
            workspace={workspace}
            props={props}
            catalog={catalog}
            run={run}
            mutate={mutate}
            busy={busy}
          />
        ))}
    </View>
  );
}
