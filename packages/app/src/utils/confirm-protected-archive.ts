import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { confirmDialog } from "./confirm-dialog";

export async function confirmProtectedArchive(
  input: {
    client: Pick<DaemonClient, "fetchAgent">;
    agentId: string;
    supported: boolean;
  },
  confirm = confirmDialog,
): Promise<boolean> {
  if (!input.supported) return false;
  const result = await input.client.fetchAgent({ agentId: input.agentId });
  if (!result) throw new Error("Agent not found.");
  const safety = result.agent.archiveSafety;
  if (!safety?.confirmationRequired) return false;
  const accepted = await confirm({
    title: "Archive this protected session?",
    message: `${safety.reasons?.join(" ") ?? "This session is a lead or owns open work."} Archive stops the session. Restore keeps the same session record.`,
    confirmLabel: "Archive",
    cancelLabel: "Cancel",
    destructive: true,
  });
  if (!accepted) throw new Error("Archive cancelled.");
  return true;
}
