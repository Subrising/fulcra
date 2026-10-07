export type GitAiDraftKind = "commit-message" | "pull-request" | "conflict-help";

export type GitAiDraft =
  | { kind: "commit-message"; message: string }
  | { kind: "pull-request"; title: string; body: string }
  | { kind: "conflict-help"; advice: string };

export type GitAiTextDraft = Exclude<GitAiDraft, { kind: "conflict-help" }>;

export interface GitAiDraftState {
  phase: "idle" | "pending" | "ready" | "error";
  draft: GitAiDraft | null;
  error: string | null;
}

export function createGitAiDraftModel(deps: {
  requestDraft: (kind: GitAiDraftKind) => Promise<GitAiDraft>;
  // Fill a human-editable form only. Commit/PR actions retain their existing
  // separate confirmations and write checks; this model has no writer API.
  onUseDraft: (draft: GitAiTextDraft) => void;
}) {
  let state: GitAiDraftState = { phase: "idle", draft: null, error: null };
  let active = true;
  let generation = 0;
  const listeners = new Set<() => void>();

  function update(next: GitAiDraftState) {
    state = next;
    for (const listener of listeners) listener();
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async request(kind: GitAiDraftKind) {
      if (!active || state.phase === "pending") return;
      const requestGeneration = ++generation;
      update({ phase: "pending", draft: null, error: null });
      try {
        const draft = await deps.requestDraft(kind);
        if (!active || requestGeneration !== generation) return;
        if (draft.kind !== kind) throw new Error("Unexpected draft kind");
        update({ phase: "ready", draft, error: null });
      } catch {
        if (active && requestGeneration === generation) {
          update({
            phase: "error",
            draft: null,
            error: "Couldn't write a draft just now. Try again.",
          });
        }
      }
    },
    edit(field: "message" | "title" | "body" | "advice", text: string) {
      if (!active || state.phase !== "ready" || !state.draft) return;
      const draft = state.draft;
      if (draft.kind === "commit-message" && field === "message") {
        update({ ...state, draft: { ...draft, message: text } });
      } else if (draft.kind === "pull-request" && (field === "title" || field === "body")) {
        update({ ...state, draft: { ...draft, [field]: text } });
      } else if (draft.kind === "conflict-help" && field === "advice") {
        update({ ...state, draft: { ...draft, advice: text } });
      }
    },
    useDraft() {
      if (!active || state.phase !== "ready" || !state.draft) return;
      const draft = state.draft;
      if (draft.kind === "conflict-help") return;
      if (draft.kind === "commit-message" && !draft.message.trim()) return;
      if (draft.kind === "pull-request" && (!draft.title.trim() || !draft.body.trim())) return;
      try {
        deps.onUseDraft({ ...draft });
      } catch {
        update({ ...state, error: "Could not use this draft. Try again." });
      }
    },
    activate() {
      active = true;
    },
    dispose() {
      active = false;
      generation++;
      state = { phase: "idle", draft: null, error: null };
      listeners.clear();
    },
  };
}
