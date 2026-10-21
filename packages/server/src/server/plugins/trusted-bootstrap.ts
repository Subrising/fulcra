import type { ManagementStartup } from "./management.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { loadTrustedPlugins } from "./trusted.js";

/** Storage membership is complete before setup, and setup returns before any provider launch. */
export async function initializeTrustedPlugins(
  storage: Pick<AgentStorage, "initialize" | "listLoaded">,
  directory: string | undefined,
  paseoHome: string,
  management?: ManagementStartup,
) {
  await storage.initialize();
  const records = await storage.listLoaded();
  return loadTrustedPlugins(
    directory,
    paseoHome,
    records.map((record) => record.id),
    management,
  );
}
