import { GitAiDraftSchema } from "@getpaseo/protocol/git-ai-draft";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { EditingTextInput } from "@/components/ui/text-input";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useHostFeatureAvailability } from "@/runtime/host-features";
import { useSessionStore } from "@/stores/session-store";
import { useCheckoutGitActionsStore } from "./actions-store";
import { GitAiDraftPanel } from "./git-ai-draft-panel";
import type { GitAiDraftKind, GitAiTextDraft } from "./git-ai-draft-model";

export type GitAiStartKind = "commit-message" | "pull-request";

const START_TITLE: Record<GitAiStartKind, string> = {
  "commit-message": "Commit your changes",
  "pull-request": "Open a pull request",
};

export function GitAiWorkspacePreview(props: {
  serverId: string;
  workspaceId: string;
  cwd: string;
  /** Commit or Create PR asked for wording: open straight onto that draft. A new nonce reopens it. */
  start?: { kind: GitAiStartKind; nonce: number } | null;
}) {
  const supported = useHostFeatureAvailability(props.serverId, "gitAiDrafts");
  const [open, setOpen] = useState<{ startWith?: GitAiStartKind } | null>(null);
  const show = useCallback(() => setOpen({}), []);
  const close = useCallback(() => setOpen(null), []);
  const nonce = props.start?.nonce;
  const startKind = props.start?.kind;
  useEffect(() => {
    if (nonce !== undefined && startKind) setOpen({ startWith: startKind });
  }, [nonce, startKind]);
  if (supported !== true) return null;
  return (
    <>
      <Button size="sm" variant="outline" onPress={show}>
        Write with AI
      </Button>
      {open ? (
        <GitAiWorkspacePreviewSession
          key={nonce ?? "manual"}
          {...props}
          startWith={open.startWith}
          onClose={close}
        />
      ) : null}
    </>
  );
}

function GitAiWorkspacePreviewSession(props: {
  serverId: string;
  workspaceId: string;
  cwd: string;
  startWith?: GitAiStartKind;
  onClose: () => void;
}) {
  const client = useHostRuntimeClient(props.serverId);
  const session = useSessionStore((state) => state.sessions[props.serverId]);
  const [epoch, setEpoch] = useState(0);
  const lifetime = useRef({ active: true, epoch: 0 });
  const connection = client?.getLastServerInfoMessage();
  const generation = session?.clientGeneration;
  const current = useCallback(() => {
    const now = useSessionStore.getState().sessions[props.serverId];
    return Boolean(
      lifetime.current.active &&
      client?.isConnected &&
      now?.client === client &&
      now.clientGeneration === generation &&
      now.workspaces.get(props.workspaceId)?.workspaceDirectory === props.cwd &&
      client.getLastServerInfoMessage() === connection &&
      connection?.permissions?.includes("workspace.read"),
    );
  }, [client, connection, generation, props.cwd, props.serverId, props.workspaceId]);
  useEffect(() => {
    const observedLifetime = lifetime.current;
    observedLifetime.active = true;
    const invalidate = () => {
      if (!current()) {
        lifetime.current.epoch++;
        setEpoch(lifetime.current.epoch);
      }
    };
    const events = client?.subscribe(invalidate);
    const connections = client?.subscribeConnectionStatus(invalidate);
    const store = useSessionStore.subscribe(invalidate);
    invalidate();
    return () => {
      observedLifetime.active = false;
      observedLifetime.epoch++;
      events?.();
      connections?.();
      store();
    };
  }, [client, current]);
  const requestDraft = useCallback(
    async (kind: GitAiDraftKind) => {
      if (!client || !current()) throw new Error("Git draft read unavailable");
      const admitted = lifetime.current.epoch;
      const result = await client.requestGitAiDraft(props.workspaceId, kind);
      if (!current() || admitted !== lifetime.current.epoch)
        throw new Error("Git draft read changed");
      return result;
    },
    [client, current, props.workspaceId],
  );
  const [wording, setWording] = useState<GitAiTextDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    setWording(null);
    setError(null);
    setSubmitted(false);
  }, [epoch, client, connection, props.workspaceId]);
  const useDraft = useCallback(
    (draft: GitAiTextDraft) => {
      if (!current()) throw new Error("Git draft selection changed");
      setWording({ ...draft });
      setError(null);
    },
    [current],
  );
  const editMessage = useCallback(
    (message: string) =>
      setWording((draft) => (draft?.kind === "commit-message" ? { ...draft, message } : draft)),
    [],
  );
  const editTitle = useCallback(
    (title: string) =>
      setWording((draft) => (draft?.kind === "pull-request" ? { ...draft, title } : draft)),
    [],
  );
  const editBody = useCallback(
    (body: string) =>
      setWording((draft) => (draft?.kind === "pull-request" ? { ...draft, body } : draft)),
    [],
  );
  const performHumanAction = useCallback(() => {
    if (
      !wording ||
      submitted ||
      !current() ||
      !connection?.permissions?.includes("workspace.write")
    )
      return;
    const admitted = lifetime.current.epoch;
    const parsed = GitAiDraftSchema.safeParse(wording);
    if (!parsed.success || parsed.data.kind === "conflict-help") {
      setError("Add a message first. A pull request also needs a title and a description.");
      return;
    }
    const draft = parsed.data;
    // A separate human click uses the existing action store and server write admission. Use draft above never calls this.
    setSubmitted(true);
    const actions = useCheckoutGitActionsStore.getState();
    const operation =
      draft.kind === "commit-message"
        ? actions.commit({ serverId: props.serverId, cwd: props.cwd, message: draft.message })
        : actions.createPr({
            serverId: props.serverId,
            cwd: props.cwd,
            title: draft.title,
            body: draft.body,
          });
    void operation
      .then(() => {
        if (current() && admitted === lifetime.current.epoch) props.onClose();
        return undefined;
      })
      .catch(() => {
        if (current() && admitted === lifetime.current.epoch)
          setError(
            "Fulcra couldn't confirm that it worked. Check your changes before trying again.",
          );
        // Unknown action outcome remains locked; never automatically replay.
      });
  }, [connection, current, props, submitted, wording]);
  const header = useMemo(
    () => ({
      title: props.startWith ? START_TITLE[props.startWith] : "Write with AI",
      subtitle:
        "Fulcra drafts the wording from your changes. Edit it, then confirm. Nothing changes until you do.",
    }),
    [props.startWith],
  );
  const key = JSON.stringify([props.serverId, props.workspaceId, generation, epoch]);
  const writeAllowed = connection?.permissions?.includes("workspace.write") === true;
  return (
    <AdaptiveModalSheet visible onClose={props.onClose} header={header}>
      <View style={styles.root}>
        <GitAiDraftPanel
          checkoutKey={key}
          requestDraft={requestDraft}
          onUseDraft={useDraft}
          startWith={props.startWith}
          disabled={!current() || submitted}
        />
        {wording?.kind === "commit-message" ? (
          <EditingTextInput
            key={key + "subject"}
            initialValue={wording.message}
            onChangeText={editMessage}
            accessibilityLabel="Commit message"
          />
        ) : null}
        {wording?.kind === "pull-request" ? (
          <>
            <EditingTextInput
              key={key + "title"}
              initialValue={wording.title}
              onChangeText={editTitle}
              accessibilityLabel="Pull request title"
            />
            <EditingTextInput
              key={key + "body"}
              initialValue={wording.body}
              onChangeText={editBody}
              multiline
              accessibilityLabel="Pull request description"
            />
          </>
        ) : null}
        {wording ? (
          <Button onPress={performHumanAction} disabled={!writeAllowed || !current() || submitted}>
            {wording.kind === "commit-message" ? "Commit all changes" : "Open the pull request"}
          </Button>
        ) : null}
        {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      </View>
    </AdaptiveModalSheet>
  );
}
const styles = StyleSheet.create((theme) => ({
  root: { gap: theme.spacing[3], padding: theme.spacing[4] },
}));
