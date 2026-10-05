import { router, usePathname } from "expo-router";
import React, { useCallback } from "react";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { resolvePluginIcon } from "./icons";
import { buildPluginSurfaceRoute, hostIdFromPathname } from "./routes";
import {
  getPreferredPluginContributionHost,
  rememberPluginContributionHost,
} from "./contribution-host";
import { type PluginSidebarGroup, type PluginSidebarTarget } from "./sidebar-groups";
import { PrimeSidebar } from "./prime-sidebar";
import { useOrganizationIntakePreferences } from "@/stores/organization-intake-preferences-store";
import { selectCompanyTarget } from "./workspace-organization-model";
import { globalIntakeRoute } from "./organization-navigation-model";
import { COMMAND_CENTRE_PLUGIN_ID } from "./command-centre-connection";

function selectTarget(
  group: PluginSidebarGroup,
  currentHostId: string | null,
): PluginSidebarTarget {
  const current = group.targets.find((target) => target.plugin.serverId === currentHostId);
  if (current) return current;
  const rememberedHostId = getPreferredPluginContributionHost(group.key);
  const remembered = group.targets.find((target) => target.plugin.serverId === rememberedHostId);
  return remembered ?? group.targets[0];
}

export function PluginSidebarItemRow({
  group,
  onBeforeNavigate,
}: {
  group: PluginSidebarGroup;
  onBeforeNavigate?: () => void;
}) {
  const pathname = usePathname();
  const companyHost = useOrganizationIntakePreferences((state) => state.companyHost);
  const hydrated = useOrganizationIntakePreferences((state) => state.hydrated);
  const hydrationError = useOrganizationIntakePreferences((state) => state.hydrationError);
  const company = group.pluginId === COMMAND_CENTRE_PLUGIN_ID;
  let target: PluginSidebarTarget | null;
  if (company) target = hydrationError ? null : selectCompanyTarget(group.targets, companyHost);
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
    if (!route || !target || (company && !hydrated)) {
      onBeforeNavigate?.();
      if (hydrationError || !companyHost) router.push(globalIntakeRoute());
      else router.push("/settings");
      return;
    }
    rememberPluginContributionHost(group.key, target.plugin.serverId);
    onBeforeNavigate?.();
    router.push(route);
  }, [group.key, onBeforeNavigate, route, target, company, hydrated, companyHost, hydrationError]);
  if (!target || (company && !hydrated)) {
    let label = "Choose company organisation";
    let accessibilityLabel = "Choose the company organisation for Fulcra";
    if (hydrationError) {
      label = "Saved company preference unavailable · Retry";
      accessibilityLabel = "Retry the saved company organisation preference";
    } else if (!hydrated) {
      label = "Reading company organisation…";
      accessibilityLabel = "Reading saved company organisation";
    } else if (companyHost) {
      label = "Company connection unavailable · Review";
      accessibilityLabel = "Review the saved company connection in Hosts";
    }
    return (
      <SidebarHeaderRow
        icon={resolvePluginIcon(group.icon)}
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
        group.pluginId === COMMAND_CENTRE_PLUGIN_ID &&
        group.contributionId === "organization" && (
          <PrimeSidebar serverId={target.plugin.serverId} onBeforeNavigate={onBeforeNavigate} />
        )}
    </>
  );
}
