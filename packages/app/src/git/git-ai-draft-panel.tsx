import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { EditingTextInput } from "@/components/ui/text-input";
import {
  createGitAiDraftModel,
  type GitAiDraft,
  type GitAiDraftKind,
  type GitAiTextDraft,
} from "./git-ai-draft-model";

export interface GitAiDraftPanelProps {
  checkoutKey: string;
  disabled?: boolean;
  requestDraft: (kind: GitAiDraftKind) => Promise<GitAiDraft>;
  onUseDraft: (draft: GitAiTextDraft) => void;
  /** Opened from Commit or Create PR: write that draft at once and hand it straight to the editor below. */
  startWith?: "commit-message" | "pull-request";
}

export function GitAiDraftPanel(props: GitAiDraftPanelProps) {
  return <GitAiDraftPanelSession key={props.checkoutKey} {...props} />;
}

function GitAiDraftPanelSession(props: GitAiDraftPanelProps) {
  const latest = useRef(props);
  latest.current = props;
  const [model] = useState(() =>
    createGitAiDraftModel({
      requestDraft: (kind) => latest.current.requestDraft(kind),
      onUseDraft: (draft) => {
        if (!latest.current.disabled) latest.current.onUseDraft(draft);
      },
    }),
  );
  const state = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const actions = useMemo(
    () =>
      (
        [
          ["commit-message", "Draft a commit message"],
          ["pull-request", "Draft a pull request"],
          ["conflict-help", "Explain the conflicts"],
        ] as const
      ).map(([kind, label]) => ({
        kind,
        label,
        onPress: () => {
          if (!latest.current.disabled) void model.request(kind);
        },
      })),
    [model],
  );
  const edits = useMemo(
    () => ({
      message: (text: string) => model.edit("message", text),
      title: (text: string) => model.edit("title", text),
      body: (text: string) => model.edit("body", text),
    }),
    [model],
  );
  const startWith = props.startWith;
  const start = useMemo(
    () => (startWith ? () => void model.request(startWith).then(() => model.useDraft()) : null),
    [model, startWith],
  );
  useEffect(() => {
    model.activate();
    start?.();
    return () => model.dispose();
  }, [model, start]);
  const pending = state.phase === "pending";
  const draft = state.draft;

  if (start)
    return (
      <View style={styles.root} testID="git-ai-draft-panel">
        {pending ? (
          <Text accessibilityRole="text" style={styles.hint}>
            Writing a draft from your changes…
          </Text>
        ) : null}
        {state.error ? (
          <>
            <Text accessibilityRole="alert" style={styles.error}>
              {state.error}
            </Text>
            <Button variant="outline" size="sm" disabled={props.disabled} onPress={start}>
              Try again
            </Button>
          </>
        ) : null}
      </View>
    );

  return (
    <View style={styles.root} testID="git-ai-draft-panel">
      {/* The sheet around this panel carries the title and the one-line explanation. */}
      <View style={styles.actions}>
        {actions.map(({ kind, label, onPress }) => (
          <Button
            key={kind}
            variant="outline"
            size="sm"
            disabled={props.disabled || pending}
            onPress={onPress}
          >
            {label}
          </Button>
        ))}
      </View>
      {pending ? (
        <Text accessibilityRole="text" style={styles.hint}>
          Writing a draft from your changes…
        </Text>
      ) : null}
      {state.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {state.error}
        </Text>
      ) : null}
      {draft?.kind === "commit-message" ? (
        <EditingTextInput
          key="commit-message"
          accessibilityLabel="Commit message draft"
          initialValue={draft.message}
          onChangeText={edits.message}
          style={styles.input}
        />
      ) : null}
      {draft?.kind === "pull-request" ? (
        <View style={styles.root}>
          <EditingTextInput
            accessibilityLabel="Pull request title draft"
            initialValue={draft.title}
            onChangeText={edits.title}
            style={styles.input}
          />
          <EditingTextInput
            accessibilityLabel="Pull request description draft"
            initialValue={draft.body}
            onChangeText={edits.body}
            multiline
            style={styles.input}
          />
        </View>
      ) : null}
      {draft?.kind === "conflict-help" ? (
        <Text selectable style={styles.advice}>
          {draft.advice}
        </Text>
      ) : null}
      {draft && draft.kind !== "conflict-help" ? (
        <Button variant="secondary" size="sm" disabled={props.disabled} onPress={model.useDraft}>
          Use this draft
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.spacing[2] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  advice: { color: theme.colors.foreground, fontSize: theme.fontSize.content },
  input: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[2],
  },
}));
