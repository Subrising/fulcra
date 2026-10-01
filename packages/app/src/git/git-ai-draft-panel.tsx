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
          ["commit-message", "Draft commit message"],
          ["pull-request", "Draft PR description"],
          ["conflict-help", "Explain conflicts"],
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
  useEffect(() => {
    model.activate();
    return () => model.dispose();
  }, [model]);
  const pending = state.phase === "pending";
  const draft = state.draft;

  return (
    <View style={styles.root} testID="git-ai-draft-panel">
      <Text style={styles.label}>AI Git help</Text>
      <Text style={styles.hint}>
        Generate a suggestion, review it and edit it. Nothing is committed, published or resolved
        here.
      </Text>
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
          Generating draft…
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
          Use draft in editor
        </Button>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.spacing[2] },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: theme.spacing[2] },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.base, fontWeight: "500" },
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
