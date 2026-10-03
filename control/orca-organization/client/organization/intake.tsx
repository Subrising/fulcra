import React, { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { getPaseoClient, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { SettingsInput } from "@getpaseo/plugin/client/ui";
import type { IntakeDraft, OrganizationNavigation } from "../../shared/intake-draft";
import { organizationCommand, organizationReceiverRpc } from "../../shared/workspace-organization";
import { operatorInvokeRpc } from "../../shared/operator-invoke";
import { useContract } from "../use-contract";
import { randomId } from "../random-id";
import { WorkButton } from "../work-button";
import {
  resolveIntakeWorkspace,
  resolveIntakeDestination,
  resolveExistingContext,
  parsePrimeDestination,
  parsePrimeQuestion,
} from "../../shared/workspace-organization.mjs";
import { useOrganization } from "./use-organization";
import { useNativeCatalog } from "./use-native-catalog";
import { useIntakeForm } from "./use-intake-form";
import { useCreationModels } from "./use-creation-models";
import { askIntakePrime, createIntakeChat } from "./native-actions.mjs";
type Props = PluginSurfaceProps & {
  organizationDraft?: IntakeDraft;
  organizationNavigation?: OrganizationNavigation;
};
export function IntakeSurface(props: Props) {
  const [fallback] = useState(() => ({ id: randomId(), text: "", setText: (_text: string) => {} }));
  const draft = props.organizationDraft ?? fallback;
  const { model, state } = useIntakeForm(draft);
  const { query, mutate, retry, pendingAction } = useOrganization(props.host.id),
    catalog = useNativeCatalog();
  const receiver = useContract(organizationReceiverRpc),
    sendOwned = useContract(operatorInvokeRpc);
  const saved = query.data?.intakes.find((intake) => intake.id === draft.id);
  const workspaceDecision = query.data
    ? resolveIntakeWorkspace(
        query.data,
        state.text || saved?.text || "",
        saved?.workspaceId ?? state.workspaceId,
      )
    : null;
  const workspace =
    workspaceDecision?.kind === "resolved" ? workspaceDecision.workspace : undefined;
  const decision = workspace
    ? resolveIntakeDestination(
        workspace,
        state.text || saved?.text || "",
        state.projectKey || saved?.projectKey || workspace.lastProjectKey,
      )
    : null;
  const answeredProjectKey =
    saved?.primeRequest?.state === "answered" && saved.primeReply && workspace
      ? parsePrimeDestination(saved.primeReply, workspace, saved.id)
      : null;
  const primeQuestion =
    saved?.primeRequest?.state === "answered"
      ? parsePrimeQuestion(saved.primeReply, saved.id)
      : null;
  const projectKey =
    state.projectKey ||
    saved?.projectKey ||
    answeredProjectKey ||
    (decision?.kind === "resolved" ? decision.projectKey : "");
  const project = workspace?.projects.find((entry) => entry.key === projectKey);
  const memberContexts = project
    ? catalog.contexts.filter((context) =>
        project.placements.some(
          (ref) => ref.serverId === context.serverId && ref.projectId === context.projectId,
        ),
      )
    : [];
  const contextDecision = project ? resolveExistingContext(project, memberContexts) : null;
  const context =
    memberContexts.find((entry) => `${entry.serverId}:${entry.workspaceId}` === state.contextKey) ??
    memberContexts.find(
      (entry) =>
        saved?.context?.serverId === entry.serverId &&
        saved.context.workspaceId === entry.workspaceId &&
        saved.context.projectId === entry.projectId,
    ) ??
    (contextDecision?.kind === "resolved" ? contextDecision.context : undefined);
  const online =
    !!context &&
    catalog.hosts.some((host) => host.serverId === context.serverId && host.status === "online");
  const creation = useCreationModels(
    model,
    props.host.id,
    context?.serverId,
    online,
    context?.directory,
  );
  const offeredModel = creation.models.find((entry) => entry.key === state.model);
  const thinkingKnown =
    !state.thinking ||
    !!offeredModel?.thinkingOptions?.some((entry) => entry.id === state.thinking);
  const reusable = !!context && !!props.organizationNavigation?.canReuseContext(context.serverId);
  const responsible = saved?.prime ?? workspace?.prime;
  const c = props.theme.colors;
  const ensure = async () => {
    if (!workspace)
      throw new Error("Choose the company workspace this request is for. Your draft is retained.");
    if (saved) return saved;
    model.bindSource();
    const result = await mutate({
      action: "begin-intake",
      workspaceId: workspace.id,
      intakeId: draft.id,
      text: state.text,
      projectKey: state.projectKey || null,
    });
    const retained = result.intakes.find((intake) => intake.id === draft.id);
    if (!retained)
      throw new Error(
        "The request receipt is not confirmed. Keep this draft and retry its retained update.",
      );
    return retained;
  };
  const record = async (command: Record<string, unknown>) =>
    mutate(
      organizationCommand.parse({ ...command, workspaceId: workspace!.id, intakeId: draft.id }),
    );
  const start = async () => {
    if (!workspace || !project || !context)
      throw new Error("Choose the existing project context this conversation should use.");
    const intake = await ensure();
    const target = {
      serverId: context.serverId,
      projectId: context.projectId,
      workspaceId: context.workspaceId,
    };
    const routed = await mutate({
      action: "route",
      workspaceId: workspace.id,
      intakeId: intake.id,
      projectKey: project.key,
      context: target,
    });
    const current = routed.intakes.find((entry) => entry.id === intake.id)!;
    await mutate({
      action: "set-context",
      workspaceId: workspace.id,
      projectKey: project.key,
      context: target,
    });
    if (current.conversations.length) {
      model.setNotice(
        "The destination correction is saved for future requests. The original conversation and its history stay linked below.",
      );
      return;
    }
    if (!online || !offeredModel || !thinkingKnown || !reusable)
      throw new Error(
        "The destination host/model is not confirmed. Your request is retained; no conversation was created.",
      );
    const result = await createIntakeChat({
      intake: current,
      project,
      api: getPaseoClient(target.serverId),
      config: {
        provider: state.model,
        thinkingOptionId: state.thinking || undefined,
        modeId: state.modeId || undefined,
      },
      deliveryId: randomId(),
      agentId: randomId(),
      taskId: state.taskId || null,
      record,
      canReuseContext: props.organizationNavigation!.canReuseContext,
    });
    if (props.navigation?.openAgentOnHost?.(result) !== "requested")
      model.setNotice(
        "The conversation was created on its recorded host. Reconnect that host, then open the original conversation below.",
      );
  };
  const askPrime = async () => {
    const intake = await ensure();
    const epoch = state.choiceEpoch;
    if (!workspace!.projects.length) {
      model.setNotice(
        "Your request is retained. Add an existing project in Workspaces before asking the prime to route it.",
      );
      return;
    }
    if (!intake.prime) {
      model.setNotice(
        "Your intake is retained with you. Choose its existing project or configure a receiving prime in Workspaces.",
      );
      return;
    }
    const receiving = await receiver({ prime: intake.prime });
    const reply = await askIntakePrime({
      intake,
      workspace: workspace!,
      api: () => getPaseoClient(intake.prime!.serverId),
      available: catalog.hosts.some(
        (host) => host.serverId === intake.prime!.serverId && host.status === "online",
      ),
      binding: receiving.binding,
      requestId: intake.primeRequest?.id ?? randomId(),
      record,
      sendOwned,
    });
    if (reply) {
      const key = parsePrimeDestination(reply, workspace!, intake.id);
      if (key) model.applyPrimeDestination(key, epoch);
      else
        model.setNotice(
          parsePrimeQuestion(reply, intake.id) ??
            "The receiving prime needs a project choice. Your original request and reply are retained.",
        );
    }
  };
  const openOriginal = (serverId: string, agentId: string) => {
    if (props.navigation?.openAgentOnHost?.({ serverId, agentId }) !== "requested")
      model.setNotice(
        "The original host is not available in this app. Reconnect it; no replacement conversation was created.",
      );
  };
  const mayAsk =
    !saved?.primeRequest ||
    ["held", "offline", "busy", "unavailable"].includes(saved.primeRequest.state);
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: c.surface0 }}
      contentContainerStyle={{ padding: 16, gap: 14 }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={{ color: c.foregroundMuted }}>
        {query.data?.companyName ?? "Company intake"} ·{" "}
        {responsible
          ? `Responsible intake: ${responsible.label ?? responsible.seat ?? "recorded receiver"}`
          : "Responsible intake: you"}
      </Text>
      {query.isPending && (
        <Text style={{ color: c.foregroundMuted }}>Reading the company’s saved intake route…</Text>
      )}
      {query.isError && (
        <View style={{ gap: 8 }}>
          <Text style={{ color: c.foreground }}>
            Company intake is unavailable. Your local draft is retained.
          </Text>
          <WorkButton
            theme={props.theme}
            label="Retry company intake"
            onPress={() => {
              void query.refetch();
            }}
          />
        </View>
      )}
      {!saved && (
        <SettingsInput
          key={draft.id}
          label="What would you like to work on?"
          initialValue={state.text}
          disabled={state.busy}
          onChangeText={model.setText}
          placeholder="Improve Ship It onboarding"
        />
      )}
      {saved && (
        <Text selectable style={{ color: c.foreground }}>
          {saved.text}
        </Text>
      )}
      {query.data?.workspaces.length === 0 && (
        <Text style={{ color: c.foreground }}>
          Create a company workspace in Workspaces and add its existing projects. Starting a request
          creates no repo, project or execution context.
        </Text>
      )}
      {!workspace &&
        query.data?.workspaces.map((entry) => (
          <WorkButton
            key={entry.id}
            theme={props.theme}
            label={`This request is for ${entry.name}`}
            onPress={() => model.setWorkspace(entry.id)}
          />
        ))}
      {workspace && (
        <>
          <Text style={{ color: c.foreground }}>
            {workspace.name} ·{" "}
            {workspaceDecision?.kind === "resolved" ? workspaceDecision.basis : "Saved workspace"}
          </Text>
          {saved && (
            <Text style={{ color: c.foregroundMuted }}>
              Retained request · {saved.state.replaceAll("-", " ")}
            </Text>
          )}
          {decision?.kind === "ambiguous" && (
            <Text style={{ color: c.foreground }}>
              This request names more than one project. Which one is it for?
            </Text>
          )}
          {project && (
            <WorkButton
              theme={props.theme}
              label={state.choosingProject ? "Keep this project" : "Change destination project"}
              onPress={model.toggleProjectChoice}
            />
          )}
          {(!project || state.choosingProject) &&
            workspace.projects.map((entry) => (
              <WorkButton
                key={entry.key}
                theme={props.theme}
                label={entry.name}
                selected={entry.key === projectKey}
                onPress={() => model.setProject(entry.key)}
              />
            ))}
          {!workspace.projects.length && (
            <Text style={{ color: c.foregroundMuted }}>
              This workspace has no linked projects yet. Add an existing project in Workspaces; this
              request creates no technical placement.
            </Text>
          )}
          {!project && (
            <WorkButton
              theme={props.theme}
              label={
                !workspace.projects.length
                  ? "Retain this request"
                  : responsible
                    ? `Route this request through ${responsible.label ?? responsible.seat ?? "intake"}`
                    : "Retain this request with me"
              }
              disabled={state.busy || (!state.text.trim() && !saved) || !mayAsk}
              onPress={() => void model.run(askPrime)}
            />
          )}
          {project && (
            <>
              <Text style={{ color: c.foreground }}>
                Destination: {project.name}
                {context
                  ? ` · ${catalog.hosts.find((host) => host.serverId === context.serverId)?.label ?? "Saved host"} · ${context.name}`
                  : " · existing context needs confirmation"}
              </Text>
              {!context && (
                <Text style={{ color: c.foregroundMuted }}>
                  {contextDecision?.kind !== "resolved"
                    ? contextDecision?.reason
                    : "Choose an existing context once."}
                </Text>
              )}
              {(!context || state.advanced) &&
                memberContexts.map((entry) => (
                  <WorkButton
                    key={`${entry.serverId}:${entry.workspaceId}`}
                    theme={props.theme}
                    label={`Use ${entry.name} · ${catalog.hosts.find((host) => host.serverId === entry.serverId)?.label ?? "Saved host"}`}
                    selected={
                      entry.workspaceId === context?.workspaceId &&
                      entry.serverId === context?.serverId
                    }
                    onPress={() => model.setContext(`${entry.serverId}:${entry.workspaceId}`)}
                  />
                ))}
              {workspace.tasks
                .filter((task) => task.projectKey === project.key)
                .map((task) => (
                  <WorkButton
                    key={task.id}
                    theme={props.theme}
                    label={`Related ${task.kind}: ${task.title}`}
                    selected={state.taskId === task.id}
                    onPress={() => model.setTask(task.id)}
                  />
                ))}
              {!saved?.conversations.length && (
                <>
                  <Text style={{ color: c.foregroundMuted }}>
                    Conversation owner: you · Model: {offeredModel?.label ?? state.modelLabel}
                    {state.thinking ? ` · ${state.thinking}` : ""}
                  </Text>
                  <WorkButton
                    theme={props.theme}
                    label={state.advanced ? "Hide conversation options" : "Change context or model"}
                    onPress={model.toggleAdvanced}
                  />
                  {state.advanced &&
                    creation.models.map((entry) => (
                      <WorkButton
                        key={entry.key}
                        theme={props.theme}
                        label={entry.label}
                        selected={state.model === entry.key}
                        onPress={() => model.setModel(entry.key, entry.label)}
                      />
                    ))}
                  {state.advanced &&
                    offeredModel?.thinkingOptions?.map((entry) => (
                      <WorkButton
                        key={entry.id}
                        theme={props.theme}
                        label={`Thinking: ${entry.label}`}
                        selected={state.thinking === entry.id}
                        onPress={() => model.setThinking(entry.id)}
                      />
                    ))}
                  {online && !offeredModel && (
                    <WorkButton
                      theme={props.theme}
                      label="Read this host’s offered models"
                      onPress={() => {
                        void creation.providers.refetch();
                      }}
                    />
                  )}
                  {online && !reusable && (
                    <Text style={{ color: c.foregroundMuted }}>
                      Update this host/app to confirm creation inside its existing project context.
                    </Text>
                  )}
                  {!online && (
                    <Text style={{ color: c.foregroundMuted }}>
                      The destination host is offline. Your request stays here until it can be used.
                    </Text>
                  )}
                </>
              )}
              <WorkButton
                theme={props.theme}
                label={
                  saved?.conversations.length
                    ? "Save corrected destination for future requests"
                    : `Start chat in ${project.name}`
                }
                disabled={
                  state.busy ||
                  (!state.text.trim() && !saved) ||
                  !context ||
                  (!saved?.conversations.length &&
                    (!online || !offeredModel || !thinkingKnown || !reusable))
                }
                onPress={() => void model.run(start)}
              />
            </>
          )}
          {primeQuestion && <Text style={{ color: c.foreground }}>{primeQuestion}</Text>}
          {saved?.primeRequest && saved.primeRequest.state !== "answered" && saved.primeReply && (
            <Text style={{ color: c.foreground }}>{saved.primeReply}</Text>
          )}
          {saved?.primeRequest && (
            <Text style={{ color: c.foregroundMuted }}>
              Prime routing: {saved.primeRequest.state}.
            </Text>
          )}
          {saved?.prime && (
            <WorkButton
              theme={props.theme}
              label="Open the original receiving conversation"
              onPress={() => openOriginal(saved.prime!.serverId, saved.prime!.agentId)}
            />
          )}
          {saved?.conversations.map((entry) => (
            <View key={entry.deliveryId} style={{ gap: 6 }}>
              <Text style={{ color: c.foregroundMuted }}>
                Original destination ·{" "}
                {workspace.projects.find((child) => child.key === entry.projectKey)?.name ??
                  "Recorded project"}{" "}
                · {entry.state}
              </Text>
              <WorkButton
                theme={props.theme}
                label="Open original conversation (same history)"
                onPress={() => openOriginal(entry.serverId, entry.agentId)}
              />
            </View>
          ))}
        </>
      )}
      {state.busy && (
        <Text accessibilityLiveRegion="polite" style={{ color: c.foregroundMuted }}>
          Updating this retained request…
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
    </ScrollView>
  );
}
