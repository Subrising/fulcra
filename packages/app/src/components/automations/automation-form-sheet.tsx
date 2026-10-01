import { useCallback, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { Automation, AutomationResult } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { CadenceEditor } from "@/components/schedules/cadence-editor";
import { Button } from "@/components/ui/button";
import type { FieldControlSize } from "@/components/ui/control-geometry";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  openAutomationForm,
  toAutomationInput,
  type ActionKind,
  type AutomationFormModel,
  type AutomationFormState,
  type SessionEvent,
  type TemplateChoice,
  type TriggerKind,
} from "@/automations/automation-form-model";
import { providerLabel, type AutomationNames } from "@/automations/describe";

// The "When X, do Y" builder. One model per open (the parent mounts this with a key per record).

const K = "automations.builder";
const ANY_PROJECT = "";

type Payload = Awaited<ReturnType<DaemonClient["listAutomations"]>>;

export interface AutomationFormSheetProps {
  automation?: Automation;
  result: AutomationResult;
  names: AutomationNames;
  client: DaemonClient;
  apply: (work: () => Promise<Payload>) => Promise<Payload>;
  onClose: () => void;
}

interface FieldsProps {
  model: AutomationFormModel;
  state: AutomationFormState;
  result: AutomationResult;
  size: FieldControlSize;
}

function useModel(props: AutomationFormSheetProps) {
  const { t } = useTranslation();
  const [model] = useState(() =>
    openAutomationForm({
      automation: props.automation,
      names: {
        ...props.names,
        providerDefaults: (provider) =>
          t(`${K}.providerDefaults`, { provider: providerLabel(provider) }),
      },
    }),
  );
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  return { model, state };
}

export function AutomationFormSheet(props: AutomationFormSheetProps): ReactElement {
  const { t } = useTranslation();
  const { model, state } = useModel(props);
  const size: FieldControlSize = useIsCompactFormFactor() ? "md" : "sm";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { automation, client, apply, onClose } = props;

  const submit = useCallback(async () => {
    const input = toAutomationInput(model.getState());
    if (!input) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await apply(() =>
        client.saveAutomation({ automation: input, ...(automation ? { id: automation.id } : {}) }),
      );
      if (payload.status === "ok") onClose();
      else setError(payload.error ?? t(`${K}.saveFailed`));
    } finally {
      setBusy(false);
    }
  }, [apply, automation, client, model, onClose, t]);

  const remove = useCallback(async () => {
    if (!automation) return;
    setBusy(true);
    try {
      const payload = await apply(() => client.deleteAutomation(automation.id));
      if (payload.status === "ok") onClose();
    } finally {
      setBusy(false);
    }
  }, [apply, automation, client, onClose]);

  const header = useMemo(
    () => ({ title: t(automation ? `${K}.editTitle` : `${K}.newTitle`) }),
    [automation, t],
  );
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        {automation ? (
          <Button variant="ghost" onPress={remove} disabled={busy} testID="automation-delete">
            {t(`${K}.delete`)}
          </Button>
        ) : null}
        <View style={styles.footerSpacer} />
        <Button variant="secondary" onPress={onClose} disabled={busy}>
          {t(`${K}.cancel`)}
        </Button>
        <Button
          variant="default"
          onPress={submit}
          disabled={!state.canSubmit}
          loading={busy}
          testID="automation-save"
        >
          {t(automation ? `${K}.save` : `${K}.create`)}
        </Button>
      </View>
    ),
    [automation, busy, onClose, remove, state.canSubmit, submit, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible
      onClose={onClose}
      footer={footer}
      desktopMaxWidth={640}
      testID="automation-form-sheet"
    >
      <Field label={t(`${K}.name`)}>
        <FormTextInput
          size={size}
          initialValue={state.name}
          onChangeText={model.setName}
          placeholder={t(`${K}.namePlaceholder`)}
          accessibilityLabel={t(`${K}.name`)}
          testID="automation-name"
        />
      </Field>
      <TriggerFields model={model} state={state} result={props.result} size={size} />
      <ActionFields model={model} state={state} result={props.result} size={size} />
      <SwitchRow label={t(`${K}.enabled`)} value={state.enabled} onChange={model.setEnabled} />
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </AdaptiveModalSheet>
  );
}

function SwitchRow(props: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  testID?: string;
}) {
  return (
    <View style={styles.switchRow}>
      <Text style={styles.switchLabel}>{props.label}</Text>
      <Switch
        value={props.value}
        onValueChange={props.onChange}
        accessibilityLabel={props.label}
        testID={props.testID}
      />
    </View>
  );
}

function useProjectOptions(result: AutomationResult, withAny: string | null) {
  return useMemo<SelectFieldOption<string>[]>(() => {
    const options = result.projects.map((p) => ({
      id: p.projectId,
      value: p.projectId,
      label: p.name,
    }));
    return withAny === null
      ? options
      : [{ id: "any", value: ANY_PROJECT, label: withAny }, ...options];
  }, [result.projects, withAny]);
}

function displayOf(label: string | undefined): SelectFieldDisplay | null {
  return label ? { label } : null;
}

function TriggerFields({ model, state, result, size }: FieldsProps) {
  const { t } = useTranslation();
  const kinds = useMemo<SegmentedControlOption<TriggerKind>[]>(
    () => [
      { value: "pull_request", label: t(`${K}.trigger.pull_request`) },
      { value: "session", label: t(`${K}.trigger.session`) },
      { value: "schedule", label: t(`${K}.trigger.schedule`) },
    ],
    [t],
  );
  return (
    <Field label={t(`${K}.when`)}>
      <View style={styles.group}>
        <SegmentedControl
          options={kinds}
          value={state.triggerKind}
          onValueChange={model.setTriggerKind}
          size={size}
          testID="automation-trigger"
        />
        {state.triggerKind === "pull_request" ? (
          <PullRequestTrigger model={model} state={state} result={result} size={size} />
        ) : null}
        {state.triggerKind === "session" ? (
          <SessionTrigger model={model} state={state} result={result} size={size} />
        ) : null}
        {state.triggerKind === "schedule" ? (
          <CadenceEditor value={state.cadence} onChange={model.setCadence} size={size} />
        ) : null}
      </View>
    </Field>
  );
}

function PullRequestTrigger({ model, state, result, size }: FieldsProps) {
  const { t } = useTranslation();
  const options = useProjectOptions(result, null);
  const onProject = useCallback(
    (value: string, display: SelectFieldDisplay) =>
      model.setPullRequestProject(value, display.label),
    [model],
  );
  const onOpened = useCallback(() => model.togglePullRequestEvent("opened"), [model]);
  const onUpdated = useCallback(() => model.togglePullRequestEvent("updated"), [model]);
  return (
    <>
      <SelectField
        label={t(`${K}.project`)}
        value={state.pullRequestProjectId}
        selectedDisplay={displayOf(state.displays.pullRequestProject)}
        options={options}
        onChange={onProject}
        placeholder={t(`${K}.chooseProject`)}
        emptyText={t(`${K}.noProjects`)}
        size={size}
        testID="automation-pr-project"
      />
      <SwitchRow
        label={t(`${K}.prOpened`)}
        value={state.pullRequestEvents.includes("opened")}
        onChange={onOpened}
      />
      <SwitchRow
        label={t(`${K}.prUpdated`)}
        value={state.pullRequestEvents.includes("updated")}
        onChange={onUpdated}
      />
      <Text style={styles.hint}>{t(`${K}.prHint`)}</Text>
    </>
  );
}

function SessionTrigger({ model, state, result, size }: FieldsProps) {
  const { t } = useTranslation();
  const events = useMemo<SegmentedControlOption<SessionEvent>[]>(
    () => [
      { value: "finished", label: t(`${K}.session.finished`) },
      { value: "blocked", label: t(`${K}.session.blocked`) },
      { value: "usage_limit", label: t(`${K}.session.usage_limit`) },
    ],
    [t],
  );
  const options = useProjectOptions(result, t(`${K}.anyProject`));
  const onProject = useCallback(
    (value: string, display: SelectFieldDisplay) =>
      model.setSessionProject(value || null, display.label),
    [model],
  );
  const anyLabel = t(`${K}.anyProject`);
  const projectLabel = state.displays.sessionProject;
  const display = useMemo(
    () => (state.sessionProjectId ? displayOf(projectLabel) : { label: anyLabel }),
    [anyLabel, projectLabel, state.sessionProjectId],
  );
  return (
    <>
      <SegmentedControl
        options={events}
        value={state.sessionEvent}
        onValueChange={model.setSessionEvent}
        size={size}
        testID="automation-session-event"
      />
      <SelectField
        label={t(`${K}.project`)}
        value={state.sessionProjectId ?? ANY_PROJECT}
        selectedDisplay={display}
        options={options}
        onChange={onProject}
        placeholder={t(`${K}.anyProject`)}
        emptyText={t(`${K}.noProjects`)}
        size={size}
      />
    </>
  );
}

function ActionFields({ model, state, result, size }: FieldsProps) {
  const { t } = useTranslation();
  const kinds = useMemo<SegmentedControlOption<ActionKind>[]>(
    () => [
      { value: "start_session", label: t(`${K}.action.start_session`) },
      { value: "message_session", label: t(`${K}.action.message_session`) },
      { value: "note", label: t(`${K}.action.note`) },
    ],
    [t],
  );
  return (
    <Field label={t(`${K}.do`)}>
      <View style={styles.group}>
        <SegmentedControl
          options={kinds}
          value={state.actionKind}
          onValueChange={model.setActionKind}
          size={size}
          testID="automation-action"
        />
        {state.actionKind === "start_session" ? (
          <StartSessionAction model={model} state={state} result={result} size={size} />
        ) : null}
        {state.actionKind === "message_session" ? (
          <MessageSessionAction model={model} state={state} result={result} size={size} />
        ) : null}
        {state.actionKind === "note" ? (
          <NoteAction model={model} state={state} result={result} size={size} />
        ) : null}
      </View>
    </Field>
  );
}

function templateKey(choice: TemplateChoice): string {
  return choice.kind === "profile" ? `profile:${choice.id}` : `provider:${choice.provider}`;
}

function useTemplateOptions(result: AutomationResult, defaultsLabel: (p: string) => string) {
  return useMemo<SelectFieldOption<TemplateChoice>[]>(() => {
    const providers = result.providers.length > 0 ? result.providers : ["claude"];
    return [
      ...result.templates.map((p) => ({
        id: `profile:${p.id}`,
        value: { kind: "profile" as const, id: p.id, provider: p.provider },
        label: p.name,
        description: providerLabel(p.provider),
      })),
      ...providers.map((provider) => ({
        id: `provider:${provider}`,
        value: { kind: "provider" as const, provider },
        label: defaultsLabel(providerLabel(provider)),
      })),
    ];
  }, [defaultsLabel, result.providers, result.templates]);
}

function PromptField({ model, state, size }: Omit<FieldsProps, "result">) {
  const { t } = useTranslation();
  return (
    <>
      <Text style={styles.subLabel}>{t(`${K}.prompt`)}</Text>
      <FormTextInput
        size={size}
        initialValue={state.prompt}
        onChangeText={model.setPrompt}
        placeholder={t(`${K}.promptPlaceholder`)}
        accessibilityLabel={t(`${K}.prompt`)}
        style={styles.multiline}
        multiline
        numberOfLines={4}
        textAlignVertical="top"
        testID="automation-prompt"
      />
      <Text style={styles.hint}>{t(`${K}.eventHint`, { token: "{{event}}" })}</Text>
    </>
  );
}

function StartSessionAction({ model, state, result, size }: FieldsProps) {
  const { t } = useTranslation();
  const projects = useProjectOptions(result, null);
  const defaultsLabel = useCallback(
    (provider: string) => t(`${K}.providerDefaults`, { provider }),
    [t],
  );
  const templates = useTemplateOptions(result, defaultsLabel);
  const onProject = useCallback(
    (value: string, display: SelectFieldDisplay) => model.setProject(value, display.label),
    [model],
  );
  const onTemplate = useCallback(
    (value: TemplateChoice, display: SelectFieldDisplay) => model.setTemplate(value, display.label),
    [model],
  );
  return (
    <>
      <SelectField
        label={t(`${K}.project`)}
        value={state.projectId}
        selectedDisplay={displayOf(state.displays.project)}
        options={projects}
        onChange={onProject}
        placeholder={t(`${K}.chooseProject`)}
        emptyText={t(`${K}.noProjects`)}
        size={size}
        testID="automation-project"
      />
      <SelectField
        label={t(`${K}.template`)}
        value={state.template}
        selectedDisplay={displayOf(state.displays.template)}
        options={templates}
        onChange={onTemplate}
        getValueKey={templateKey}
        placeholder={t(`${K}.chooseTemplate`)}
        emptyText={t(`${K}.noTemplates`)}
        size={size}
        testID="automation-template"
      />
      <PromptField model={model} state={state} size={size} />
      <SwitchRow
        label={t(`${K}.allowUnattended`)}
        value={state.allowUnattended}
        onChange={model.setAllowUnattended}
        testID="automation-allow-unattended"
      />
      <Text style={state.allowUnattended ? styles.warning : styles.hint}>
        {t(state.allowUnattended ? `${K}.allowUnattendedWarning` : `${K}.allowUnattendedHint`)}
      </Text>
    </>
  );
}

function MessageSessionAction({ model, state, result, size }: FieldsProps) {
  const { t } = useTranslation();
  const untitled = t("automations.untitledSession");
  const options = useMemo<SelectFieldOption<string>[]>(
    () =>
      result.sessions.map((s) => ({
        id: s.agentId,
        value: s.agentId,
        label: s.title || untitled,
        description: result.projects.find((p) => p.projectId === s.projectId)?.name,
      })),
    [result.projects, result.sessions, untitled],
  );
  const onSession = useCallback(
    (value: string, display: SelectFieldDisplay) => model.setSession(value, display.label),
    [model],
  );
  return (
    <>
      <SelectField
        label={t(`${K}.sessionLabel`)}
        value={state.agentId}
        selectedDisplay={displayOf(state.displays.session)}
        options={options}
        onChange={onSession}
        placeholder={t(`${K}.chooseSession`)}
        emptyText={t(`${K}.noSessions`)}
        searchable
        size={size}
      />
      <PromptField model={model} state={state} size={size} />
    </>
  );
}

function NoteAction({ model, state, size }: FieldsProps) {
  const { t } = useTranslation();
  return (
    <>
      <FormTextInput
        size={size}
        initialValue={state.noteText}
        onChangeText={model.setNoteText}
        placeholder={t(`${K}.notePlaceholder`)}
        accessibilityLabel={t(`${K}.note`)}
        style={styles.multiline}
        multiline
        numberOfLines={3}
        textAlignVertical="top"
        testID="automation-note"
      />
      <Text style={styles.hint}>{t(`${K}.noteHint`)}</Text>
      {state.canPostToGithub ? (
        <>
          <SwitchRow
            label={t(`${K}.postToGithub`)}
            value={state.postToGithub}
            onChange={model.setPostToGithub}
            testID="automation-post-to-github"
          />
          <Text style={styles.hint}>{t(`${K}.postToGithubHint`)}</Text>
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  group: { gap: theme.spacing[2] },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[1],
  },
  switchLabel: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  subLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  warning: { color: theme.colors.palette.amber[500], fontSize: theme.fontSize.sm },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  multiline: { minHeight: 88 },
  error: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
  footer: { flex: 1, flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  footerSpacer: { flex: 1 },
}));
