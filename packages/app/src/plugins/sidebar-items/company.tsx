import { router, usePathname } from "expo-router";
import React, { useCallback } from "react";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { resolvePluginIcon } from "../icons";
import { buildPluginSurfaceRoute, hostIdFromPathname } from "../routes";
import {
  getPreferredPluginContributionHost,
  rememberPluginContributionHost,
} from "../contribution-host";
import type { PluginCompanySidebarGroup, PluginLegacySidebarTarget } from "../sidebar-groups";
import { PrimeSidebar } from "../prime-sidebar";
import { useOrganizationIntakePreferences } from "@/stores/organization-intake-preferences-store";
import { useHosts } from "@/runtime/host-runtime";
import { chooseHomeComputer, useMainAssistantHosts, type HomeChoice } from "../home-computer";
import { globalIntakeRoute } from "../organization-navigation-model";
import { isCommandCentrePlugin } from "../command-centre-connection";

function selectTarget(
  group: PluginCompanySidebarGroup,
  currentHostId: string | null,
): PluginLegacySidebarTarget {
  const current = group.targets.find((target) => target.plugin.serverId === currentHostId);
  if (current) return current;
  const rememberedHostId = getPreferredPluginContributionHost(group.key);
  const remembered = group.targets.find((target) => target.plugin.serverId === rememberedHostId);
  return remembered ?? group.targets[0];
}

// FULCRA(plugin-host): the Command Centre row picks the company host and shows untrusted entries.
export function CompanyPluginSidebarRow({
  group,
  onBeforeNavigate,
}: {
  group: PluginCompanySidebarGroup;
  onBeforeNavigate?: () => void;
}) {
  const pathname = usePathname();
  const companyHost = useOrganizationIntakePreferences((state) => state.companyHost);
  const hydrated = useOrganizationIntakePreferences((state) => state.hydrated);
  const hydrationError = useOrganizationIntakePreferences((state) => state.hydrationError);
  const hosts = useHosts();
  const company = isCommandCentrePlugin(group.pluginId);
  const ready = company && hydrated && !hydrationError;
  const trustedIds = group.targets
    .filter((candidate) => !candidate.untrusted)
    .map((candidate) => candidate.plugin.serverId);
  const mainAssistantHosts = useMainAssistantHosts(
    trustedIds,
    ready && !companyHost && trustedIds.length > 1,
  );
  const choice: HomeChoice<PluginLegacySidebarTarget> | null = ready
    ? chooseHomeComputer(group.targets, { savedHost: companyHost, mainAssistantHosts })
    : null;
  let target: PluginLegacySidebarTarget | null;
  if (company) target = choice?.kind === "chosen" ? choice.target : null;
  else target = selectTarget(group, hostIdFromPathname(pathname));
  const route = target
    ? buildPluginSurfaceRoute(target.plugin.serverId, group.pluginId, {
        kind: "sidebar",
        id: group.contributionId,
      })
    : null;
  const isActive = group.targets.some(
    (candidate) =>
      pathname ===
      buildPluginSurfaceRoute(candidate.plugin.serverId, group.pluginId, {
        kind: "sidebar",
        id: group.contributionId,
      }),
  );
  const navigate = useCallback(() => {
    if (company && !hydrated) return;
    if (!route || !target) {
      if (choice?.kind === "checking") return;
      onBeforeNavigate?.();
      if (choice?.kind === "update")
        router.push(
          buildPluginSurfaceRoute(choice.serverId, group.pluginId, {
            kind: "sidebar",
            id: group.contributionId,
          }),
        );
      else if (choice?.kind === "missing") router.push("/settings");
      else router.push(globalIntakeRoute());
      return;
    }
    rememberPluginContributionHost(group.key, target.plugin.serverId);
    onBeforeNavigate?.();
    router.push(route);
  }, [group, onBeforeNavigate, route, target, company, hydrated, choice]);
  if (!target) {
    const computer = (serverId: string) =>
      hosts.find((host) => host.serverId === serverId)?.label ?? "your other computer";
    const { label, accessibilityLabel } = homeChoiceLabel(choice, {
      hydrated,
      hydrationError,
      computer,
    });
    return (
      <SidebarHeaderRow
        icon={resolvePluginIcon(choice?.kind === "update" ? "ShieldAlert" : group.icon)}
        variant="compact"
        label={label}
        accessibilityLabel={accessibilityLabel}
        onPress={navigate}
        testID={`plugin-sidebar-${group.pluginId}-${group.contributionId}`}
      />
    );
  }
  return (
    <>
      <SidebarHeaderRow
        icon={resolvePluginIcon(target.untrusted ? "ShieldAlert" : group.icon)}
        label={target.untrusted ? `${group.title} · Not trusted` : group.title}
        accessibilityLabel={
          target.untrusted
            ? `${group.title}. Plugin not trusted on this Mac. Open for update instructions.`
            : group.title
        }
        onPress={navigate}
        isActive={isActive}
        testID={`plugin-sidebar-${group.pluginId}-${group.contributionId}`}
        variant="compact"
      />
      {!target.untrusted &&
        isCommandCentrePlugin(group.pluginId) &&
        group.contributionId === "organization" && (
          <PrimeSidebar serverId={target.plugin.serverId} onBeforeNavigate={onBeforeNavigate} />
        )}
    </>
  );
}

/** What the Fulcra row says while no home computer is chosen, in plain words. */
export function homeChoiceLabel(
  choice: HomeChoice<PluginLegacySidebarTarget> | null,
  input: {
    hydrated: boolean;
    hydrationError: string | null;
    computer: (serverId: string) => string;
  },
): { label: string; accessibilityLabel: string } {
  if (input.hydrationError)
    return {
      label: "Couldn't read your saved choice · Retry",
      accessibilityLabel: "Retry reading which computer runs your main assistant",
    };
  if (!input.hydrated || !choice)
    return { label: "Reading your saved choice…", accessibilityLabel: "Reading your saved choice" };
  switch (choice.kind) {
    case "checking":
      return {
        label: "Finding your main assistant…",
        accessibilityLabel: "Finding which computer runs your main assistant",
      };
    case "update": {
      const name = input.computer(choice.serverId);
      return {
        label: `Update Fulcra on ${name}`,
        accessibilityLabel: `Fulcra on ${name} is a different version or not trusted here. Open for update steps.`,
      };
    }
    case "missing": {
      const name = input.computer(choice.serverId);
      return {
        label: `${name} isn't connected · Review`,
        accessibilityLabel: `${name} runs your main assistant but isn't connected. Review in Settings.`,
      };
    }
    default:
      return {
        label: "Which computer runs your main assistant?",
        accessibilityLabel: "Choose which computer runs your main assistant",
      };
  }
}
