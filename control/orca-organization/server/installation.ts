import path from "node:path";
import { loadConfig, NotConfigured } from "./config.mjs";
// One class shared with the config reader (moved beside the plugin by V4), so a missing state root reaches callers as
// NotConfigured (PF-1/PF-2).
export { NotConfigured };
export type InstallationPlace = "controllerHome" | "outcomes" | "tasks";
export function installationPath(place: InstallationPlace, env = process.env): string {
  const config = loadConfig(env);
  if (place === "controllerHome") return config.home;
  if (place === "outcomes") return config.outcomesRoot;
  if (place === "tasks") return path.join(config.home, "tasks");
  throw new NotConfigured(`Unknown installation setting ${place}`);
}
