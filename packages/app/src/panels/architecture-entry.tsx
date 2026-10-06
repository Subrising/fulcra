import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { usePaneContext } from "./pane-context";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { useArchitectureMapList } from "@/architecture-map/use-architecture-maps";
import { useCanGenerateChanges, useCanShowGraph } from "@/architecture-map/use-generated-change";
import { canOpenCodeArchitecture } from "@/architecture-map/discovery";
import {
  codeArchitectureNavigation,
  useChangeViewRequests,
} from "@/architecture-map/change-view-request";

export function ArchitectureEntry({ pullRequest }: { pullRequest?: number }) {
  const { t } = useTranslation();
  const { serverId, workspaceId, host, openTab } = usePaneContext();
  const root = useWorkspaceDirectory(serverId, workspaceId);
  const list = useArchitectureMapList({ serverId, workspaceRoot: root });
  const canGenerate = useCanGenerateChanges(serverId),
    canGraph = useCanShowGraph(serverId);
  const hasMaps = list.data?.kind === "listed" && list.data.maps.length > 0;
  const validSelection =
    pullRequest === undefined || (Number.isSafeInteger(pullRequest) && pullRequest > 0);
  const available =
    host === "main" &&
    validSelection &&
    canOpenCodeArchitecture({ hasMaps, canGenerate, canGraph });
  const request = useChangeViewRequests((state) => state.request);
  const open = useCallback(() => {
    if (!available) return;
    const destination = codeArchitectureNavigation({ serverId, workspaceId, pullRequest });
    if (destination.selection) request(destination.key, destination.selection);
    openTab(destination.target);
  }, [available, openTab, pullRequest, request, serverId, workspaceId]);
  const label =
    pullRequest === undefined
      ? t("panels.architectureMap.label")
      : t("panels.architectureMap.change.openFromPullRequest");
  const explanation =
    host !== "main"
      ? t("panels.architectureMap.mainOnly")
      : t("panels.architectureMap.entryUnavailable");
  return (
    <View style={styles.entry}>
      <Button
        variant="ghost"
        size="sm"
        testID={
          pullRequest === undefined
            ? "changes-code-architecture"
            : "pull-request-architecture-change"
        }
        accessibilityLabel={label}
        accessibilityHint={!available ? explanation : undefined}
        disabled={!available}
        onPress={open}
      >
        {label}
      </Button>
      {!available && <Text style={styles.explanation}>{explanation}</Text>}
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  entry: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  explanation: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flexShrink: 1 },
}));
