import type { OrganizationCommand, OrganizationState } from "../../shared/workspace-organization";
import { randomId } from "../random-id";
export function createOrganizationOperations() {
  let snapshot: OrganizationState | undefined;
  let pending:
    | { requestId: string; expectedRevision: number; command: OrganizationCommand }
    | undefined;
  let closed = false;
  const listeners = new Set<() => void>();
  const publish = () => {
    for (const listener of listeners) listener();
  };
  const execute = async (
    command: OrganizationCommand,
    write: (input: {
      requestId: string;
      expectedRevision: number;
      command: OrganizationCommand;
    }) => Promise<OrganizationState>,
  ) => {
    if (closed || !snapshot)
      throw new Error("Workspace organization is unavailable. Your draft is retained.");
    if (pending && JSON.stringify(pending.command) !== JSON.stringify(command))
      throw new Error(
        "The previous update is not confirmed. Retry that same update before changing its intent.",
      );
    pending ??= { requestId: randomId(), expectedRevision: snapshot.revision, command };
    publish();
    try {
      const result = await write(pending);
      snapshot = result;
      pending = undefined;
      publish();
      return result;
    } catch (error) {
      if (error instanceof Error && error.message.includes("Organization changed.")) {
        pending = undefined;
        publish();
      }
      throw error;
    }
  };
  return {
    close: () => {
      closed = true;
      listeners.clear();
    },
    apply: (value: OrganizationState | undefined) => {
      if (value && (!snapshot || value.revision >= snapshot.revision)) snapshot = value;
    },
    getState: () => pending?.command.action ?? null,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    execute,
    retry: (write: Parameters<typeof execute>[1]) => {
      if (!pending) throw new Error("No unconfirmed update is retained");
      return execute(pending.command, write);
    },
  };
}
