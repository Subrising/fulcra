import { WorkspacesSurface } from "./client/organization/workspaces";
import { IntakeSurface } from "./client/organization/intake";
import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { OrganizationSurface } from "./client/organization";
import { registerReturnCommands } from "./client/navigation";
import { SIDEBAR_TITLE } from "./client/build-identity";
import { AccountsSurface } from "./client/accounts";
import { IntegrationsScreen } from "./client/integrations";
import { AgentStepThroughPanel } from "./client/step-through-panel";
import { registerAccountSwitch } from "./client/switch-account";
import { registerTeamRole } from "./client/team-setup";
import { CleanupSurface } from "./client/worktree-lifecycle";
import { CleanupNowSection } from "./client/cleanup-now-view";
import { DevicesSurface } from "./client/devices";
import { ChannelsSurface } from "./client/channels";
import { setSettingsInApp } from "./client/tabs";
import { WhatItDidTurnFooter } from "./client/what-it-did-footer";
function LeadershipSurface(props: PluginSurfaceProps) {
  return <OrganizationSurface {...props} initialPillar="organisation" initialView="leadership" />;
}
// The sidebar's "Team map": the Team tab's Who-is-in-charge tree, one click from anywhere.
function TeamMapSurface(props: PluginSurfaceProps) {
  return <OrganizationSurface {...props} initialPillar="team" />;
}
// Settings → Clean-up: the automatic choices and "Clean up now" above the job-folder preview.
function CleanupSettingsScreen(props: Pick<PluginSurfaceProps, "theme" | "layout">) {
  return <CleanupSurface {...props} header={<CleanupNowSection theme={props.theme} />} />;
}
export default function contribute(client: PluginClientContext) {
  const surface = client.addSurface("organization", OrganizationSurface);
  const workspaces = client.addSurface("workspaces", WorkspacesSurface);
  const intake = client.addSurface("intake", IntakeSurface);
  const workspaceSidebar = client.addSidebarItem({
    id: "workspaces",
    title: "Workspaces",
    icon: "FolderKanban",
    surface: "workspaces",
  });
  const leadership = client.addSurface("leadership", LeadershipSurface);
  const teamMap = client.addSurface("team", TeamMapSurface);
  const sidebar = client.addSidebarItem({
    id: "organization",
    title: SIDEBAR_TITLE,
    icon: "Network",
    surface: "organization",
  });
  const commands = registerReturnCommands(client);
  // Fulcra's settings pages live in the app's one Settings screen. Hosts that predate settings screens keep the
  // Settings tab inside Fulcra instead.
  const settingsScreens =
    typeof client.addSettingsScreen === "function"
      ? [
          client.addSettingsScreen({
            id: "accounts",
            title: "Accounts & models",
            icon: "Users",
            Component: AccountsSurface,
          }),
          client.addSettingsScreen({
            id: "integrations",
            title: "Issue trackers",
            icon: "KeyRound",
            Component: IntegrationsScreen,
          }),
          client.addSettingsScreen({
            id: "cleanup",
            title: "Clean-up",
            icon: "Archive",
            Component: CleanupSettingsScreen,
          }),
          client.addSettingsScreen({
            id: "devices",
            title: "Trusted devices",
            icon: "Smartphone",
            Component: DevicesSurface,
          }),
          client.addSettingsScreen({
            id: "channels",
            title: "Message channels",
            icon: "MessagesSquare",
            Component: ChannelsSurface,
          }),
        ]
      : [];
  setSettingsInApp(settingsScreens.length > 0);
  // J6: "What it did" beside a conversation: each turn in plain words, with step-through for the detail. Hosts that
  // predate agent panels simply do not offer it. The panel id stays "step-through" so saved layouts keep working.
  const panel =
    typeof client.addWorkspacePanel === "function"
      ? client.addWorkspacePanel({
          id: "step-through",
          title: "What it did",
          icon: "History",
          context: "agent",
          Component: AgentStepThroughPanel,
        })
      : () => {};
  // The folded "What it did" line under each turn in the chat; apps without the turn-footer seam skip it.
  const whatItDidFooter =
    typeof client.addTurnFooter === "function"
      ? client.addTurnFooter({ id: "what-it-did", Component: WhatItDidTurnFooter })
      : () => {};
  const whatItDidCommand =
    typeof client.addWorkspacePanel === "function" &&
    typeof client.addCommandCenterItem === "function"
      ? client.addCommandCenterItem({
          id: "what-it-did",
          context: "agent",
          title: "What it did",
          icon: "History",
          keywords: ["summary", "steps", "replay", "step through", "what happened"],
          onSelect: (ctx) => ctx.openPanel("step-through"),
        })
      : () => {};
  // W1: "Switch account…" in a session's menu and /account in its chat.
  const accountSwitch = registerAccountSwitch(client);
  // Fulcra 0.2.8: "Make main assistant" and "Make lead of project…" from any chat.
  const teamRole = registerTeamRole(client);
  return () => {
    accountSwitch();
    teamRole();
    whatItDidCommand();
    whatItDidFooter();
    panel();
    for (const remove of settingsScreens) remove();
    setSettingsInApp(false);
    commands();
    sidebar();
    surface();
    leadership();
    teamMap();
    workspaceSidebar();
    intake();
    workspaces();
  };
}
