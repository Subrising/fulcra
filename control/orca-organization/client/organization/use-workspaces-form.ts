import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { openWorkspacesForm } from "./workspaces-form";
export function useWorkspacesForm() {
  const [model] = useState(openWorkspacesForm);
  useEffect(() => () => model.close(), [model]);
  const nameInput = useCallback(
    (handle: Parameters<typeof model.setNameInput>[0]) => model.setNameInput(handle),
    [model],
  );
  return {
    model,
    nameInput,
    state: useSyncExternalStore(model.subscribe, model.getState, model.getState),
  };
}
