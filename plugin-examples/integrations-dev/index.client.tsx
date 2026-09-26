import type { PluginClientContext } from "@getpaseo/plugin/client";
import { IntegrationsScreen } from "./client/integrations-screen";

// A developer test screen, not product UI: it proves a plugin settings screen can host
// Connect, Reconnect and Disconnect through `usePaseo().credentials`.
export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "integrations",
    title: "Integrations (developer test)",
    icon: "KeyRound",
    Component: IntegrationsScreen,
  });
  return () => {};
}
