import { createIntakeNavigation, newIntakeId } from "./organization-navigation-model";
import { router } from "expo-router";
import type { OrganizationNavigation } from "../../../../control/orca-organization/shared/intake-draft";
import { useOrganizationIntakePreferences } from "@/stores/organization-intake-preferences-store";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { buildProjectSettingsRoute } from "@/utils/host-routes";
export function createOrganizationNavigation(controllerId: string): OrganizationNavigation {
  return createIntakeNavigation(controllerId, {
    push: (path) => router.push(path),
    newId: newIntakeId,
    chooseCompany: (serverId) =>
      useOrganizationIntakePreferences.getState().chooseCompany(serverId),
    projectRoute: buildProjectSettingsRoute,
    connection: (serverId) => {
      const snapshot = getHostRuntimeStore().getSnapshot(serverId);
      return {
        online: snapshot?.connectionStatus === "online",
        workspaceMultiplicity:
          snapshot?.client?.getLastServerInfoMessage()?.features?.workspaceMultiplicity === true,
      };
    },
  });
}
