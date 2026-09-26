import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { GitPullRequest, Network } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";
import {
  changeViewRequestKey,
  useChangeViewRequests,
} from "@/architecture-map/change-view-request";
import { useArchitectureMapList } from "@/architecture-map/use-architecture-maps";
import { formatPrTabLabel } from "@/git/pull-request-panel";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";
import { PullRequestContent, usePullRequestData } from "@/panels/pull-request";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import type { Theme } from "@/styles/theme";

const ThemedGitPullRequest = withUnistyles(GitPullRequest);
const ThemedNetwork = withUnistyles(Network);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const pullRequestPanelPresentation = {
  label: (t) => t("panels.pullRequest.label"),
  subtitle: (t) => t("panels.pullRequest.subtitle"),
  tooltip: (t) => t("panels.pullRequest.label"),
  icon: ThemedGitPullRequest,
} satisfies PanelPresentation;
const CENTERED_PADDED_STYLE = {
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
} as const;

function usePullRequestPanelDescriptor(
  _target: { kind: "pull_request" },
  context: { serverId: string; workspaceId: string },
) {
  const { t } = useTranslation();
  const cwd = useWorkspaceDirectory(context.serverId, context.workspaceId) ?? "";
  const prPane = usePullRequestData({ serverId: context.serverId, cwd, timelineEnabled: false });
  const label =
    prPane.prNumber === null
      ? pullRequestPanelPresentation.label(t)
      : formatPrTabLabel(prPane.prNumber);
  return {
    label,
    subtitle: pullRequestPanelPresentation.subtitle(t),
    tooltip: label,
    titleState: prPane.isLoading ? ("loading" as const) : ("ready" as const),
    icon: pullRequestPanelPresentation.icon,
    statusBucket: null,
  };
}

function PullRequestPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target } = usePaneContext();
  const cwd = useWorkspaceDirectory(serverId, workspaceId) ?? "";
  invariant(target.kind === "pull_request", "PullRequestPanel requires pull_request target");
  const prPane = usePullRequestData({ serverId, cwd });
  if (!cwd) {
    return (
      <View style={CENTERED_PADDED_STYLE}>
        <Text>{t("panels.file.directoryMissing")}</Text>
      </View>
    );
  }
  return (
    <View style={styles.root}>
      {prPane.prNumber !== null ? <ArchitectureChangeEntry /> : null}
      <PullRequestContent serverId={serverId} workspaceId={workspaceId} cwd={cwd} prPane={prPane} />
    </View>
  );
}

// "Architecture change": shown only when the project keeps a map (.fulcra/architecture/*.ir.json).
// It opens the map tab straight into its Change view for this branch.
function ArchitectureChangeEntry() {
  const { t } = useTranslation();
  const { serverId, workspaceId, openTab } = usePaneContext();
  const workspaceRoot = useWorkspaceDirectory(serverId, workspaceId);
  const list = useArchitectureMapList({ serverId, workspaceRoot });
  const request = useChangeViewRequests((state) => state.request);
  const open = useCallback(() => {
    request(changeViewRequestKey(serverId, workspaceId));
    openTab({ kind: "architecture_map" });
  }, [openTab, request, serverId, workspaceId]);
  if (list.data?.kind !== "listed" || list.data.maps.length === 0) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint={t("panels.architectureMap.change.openFromPullRequestHint")}
      onPress={open}
      style={styles.entry}
      testID="pull-request-architecture-change"
    >
      <ThemedNetwork size={14} uniProps={foregroundMutedColorMapping} />
      <Text style={styles.entryText}>{t("panels.architectureMap.change.openFromPullRequest")}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1 },
  entry: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: theme.spacing[1.5],
    marginHorizontal: theme.spacing[3],
    marginTop: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  entryText: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
}));

export const pullRequestPanelRegistration = definePanel("pull_request", {
  component: PullRequestPanel,
  presentation: pullRequestPanelPresentation,
  useDescriptor: usePullRequestPanelDescriptor,
});
