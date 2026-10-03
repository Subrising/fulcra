import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { OrganizationSurface } from "./client/organization";
import { registerReturnCommands } from "./client/navigation";
import { SIDEBAR_TITLE } from "./client/build-identity";
import { AccountsSurface } from "./client/accounts";
import { IntegrationsScreen } from "./client/integrations";
import { AgentStepThroughPanel } from "./client/step-through-panel";
import { registerAccountSwitch } from "./client/switch-account";
function LeadershipSurface(props: PluginSurfaceProps) {
  return <OrganizationSurface {...props} initialPillar="organisation" initialView="leadership" />;
}
export default function contribute(client: PluginClientContext) {
  const surface = client.addSurface("organization", OrganizationSurface);
  const leadership = client.addSurface("leadership", LeadershipSurface);
  const sidebar = client.addSidebarItem({
    id: "organization",
    title: SIDEBAR_TITLE,
    icon: "Network",
    surface: "organization",
  });
  const commands = registerReturnCommands(client);
  // Fulcra J4 Settings › Integrations. A host without settings screens still reaches it from the Trackers tab.
  const settings =
    typeof client.addSettingsScreen === "function"
      ? client.addSettingsScreen({
          id: "integrations",
          title: "Integrations",
          icon: "KeyRound",
          Component: IntegrationsScreen,
        })
      : () => {};
  const accounts =
    typeof client.addSettingsScreen === "function"
      ? client.addSettingsScreen({
          id: "accounts",
          title: "Accounts & Defaults",
          icon: "Users",
          Component: AccountsSurface,
        })
      : () => {};
  // J6: "Step through" beside a conversation. Hosts that predate agent panels simply do not offer it.
  const panel =
    typeof client.addWorkspacePanel === "function"
      ? client.addWorkspacePanel({
          id: "step-through",
          title: "Step through",
          icon: "History",
          context: "agent",
          Component: AgentStepThroughPanel,
        })
      : () => {};
  // W1: "Switch account…" in a session's menu and /account in its chat.
  const accountSwitch = registerAccountSwitch(client);
  return () => {
    accountSwitch();
    panel();
    accounts();
    settings();
    commands();
    sidebar();
    surface();
    leadership();
  };
}
