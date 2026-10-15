import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { confirmDialog } from "./confirm-dialog";

interface ProtectedSessionInput {
  client: Pick<DaemonClient, "fetchAgent">;
  agentId: string;
  supported: boolean;
}

async function confirmProtectedSession(
  input: ProtectedSessionInput,
  action: "Archive" | "Restore",
  confirm: typeof confirmDialog,
): Promise<boolean> {
  if (!input.supported) return false;
  const result = await input.client.fetchAgent({ agentId: input.agentId });
  if (!result) throw new Error("Agent not found.");
  const safety = result.agent.archiveSafety;
  if (!safety?.confirmationRequired) return false;
  const reason = safety.reasons?.join(" ") ?? "This session is a lead or owns open work.";
  const message =
    action === "Archive"
      ? `${reason} Archive stops the session. Restore keeps the same session record.`
      : `${reason} Restore makes this session active again. It keeps the same session record.`;
  const accepted = await confirm({
    title: `${action} this protected session?`,
    message,
    confirmLabel: action,
    cancelLabel: "Cancel",
    destructive: action === "Archive",
  });
  if (!accepted) throw new Error(`${action} cancelled.`);
  return true;
}

export async function confirmProtectedArchive(
  input: ProtectedSessionInput,
  confirm = confirmDialog,
): Promise<boolean> {
  return confirmProtectedSession(input, "Archive", confirm);
}

export async function confirmProtectedRestore(
  input: ProtectedSessionInput,
  confirm = confirmDialog,
): Promise<boolean> {
  return confirmProtectedSession(input, "Restore", confirm);
}
