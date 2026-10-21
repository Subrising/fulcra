import type { ManagementStartup } from "./management.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { loadTrustedPlugins } from "./trusted.js";

/** Storage membership is complete before setup, and setup returns before any provider launch. */
export async function initializeTrustedPlugins(
  storage: Pick<AgentStorage, "initialize" | "knownIds">,
  directory: string | undefined,
  paseoHome: string,
  management?: ManagementStartup,
) {
  await storage.initialize();
  // Archived sessions count: unarchive, archive and delete still pass the known-agent check after a restart.
  const ids = await storage.knownIds();
  return loadTrustedPlugins(directory, paseoHome, ids, management);
}
