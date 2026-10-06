import { useEffect, useState, useSyncExternalStore } from "react";
import { openIntakeForm } from "./intake-form";
import type { IntakeDraft } from "../../shared/intake-draft";
export function useIntakeForm(draft: IntakeDraft) {
  const [model] = useState(() => openIntakeForm(draft));
  useEffect(() => () => model.close(), [model]);
  return { model, state: useSyncExternalStore(model.subscribe, model.getState, model.getState) };
}
