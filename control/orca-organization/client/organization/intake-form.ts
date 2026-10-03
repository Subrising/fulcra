import type { IntakeDraft } from "../../shared/intake-draft";
export function openIntakeForm(draft: IntakeDraft) {
  let state = {
    text: draft.text,
    workspaceId: draft.workspaceId ?? "",
    projectKey: "",
    contextKey: "",
    taskId: "",
    model: "codex/gpt-6.1-sol",
    modelLabel: "GPT-6.1 Sol",
    thinking: "high",
    modeId: "",
    busy: false,
    notice: "",
    choiceEpoch: 0,
    advanced: false,
    choosingProject: false,
  };
  let closed = false,
    modelEdited = false;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<typeof state>) => {
    if (
      closed ||
      Object.entries(patch).every(([key, value]) => state[key as keyof typeof state] === value)
    )
      return;
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close: () => {
      closed = true;
      listeners.clear();
    },
    bindSource: () => draft.bindSource?.(),
    setText: (text: string) => {
      draft.setText(text);
      publish({ text });
    },
    setWorkspace: (workspaceId: string) =>
      publish({
        workspaceId,
        projectKey: "",
        contextKey: "",
        taskId: "",
        choiceEpoch: state.choiceEpoch + 1,
      }),
    setProject: (projectKey: string) =>
      publish({ projectKey, contextKey: "", taskId: "", choiceEpoch: state.choiceEpoch + 1 }),
    setContext: (contextKey: string) => publish({ contextKey, choiceEpoch: state.choiceEpoch + 1 }),
    setTask: (taskId: string) => publish({ taskId, choiceEpoch: state.choiceEpoch + 1 }),
    setModel: (model: string, modelLabel = model) => {
      modelEdited = true;
      publish({ model, modelLabel });
    },
    setThinking: (thinking: string) => {
      modelEdited = true;
      publish({ thinking });
    },
    applyDefaults: (model: string, thinking: string, modeId = "", label?: string) => {
      if (!modelEdited)
        publish({
          model,
          thinking,
          modeId,
          modelLabel: label ?? (state.model === model ? state.modelLabel : model),
        });
    },
    applyPrimeDestination: (projectKey: string, epoch: number) => {
      if (state.choiceEpoch === epoch) publish({ projectKey, contextKey: "", taskId: "" });
    },
    toggleProjectChoice: () => publish({ choosingProject: !state.choosingProject }),
    toggleAdvanced: () => publish({ advanced: !state.advanced }),
    setNotice: (notice: string) => publish({ notice }),
    run: async (action: () => Promise<unknown>) => {
      if (closed || state.busy) return;
      publish({ busy: true, notice: "" });
      try {
        await action();
      } catch (error) {
        publish({
          notice:
            error instanceof Error
              ? error.message
              : "Your intake is saved. This operation could not be confirmed.",
        });
      } finally {
        publish({ busy: false });
      }
    },
  };
}
