import { Text, View } from "react-native";
import { GitPullRequest } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";
import { ArchitectureEntry } from "./architecture-entry";
import { formatPrTabLabel } from "@/git/pull-request-panel";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel, type PanelPresentation } from "@/panels/panel-registry";
import { PullRequestContent, usePullRequestData } from "@/panels/pull-request";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

const ThemedGitPullRequest = withUnistyles(GitPullRequest);
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
      {prPane.prNumber !== null ? <ArchitectureEntry pullRequest={prPane.prNumber} /> : null}
      <PullRequestContent serverId={serverId} workspaceId={workspaceId} cwd={cwd} prPane={prPane} />
    </View>
  );
}

const styles = StyleSheet.create(() => ({ root: { flex: 1 } }));

export const pullRequestPanelRegistration = definePanel("pull_request", {
  component: PullRequestPanel,
  presentation: pullRequestPanelPresentation,
  useDescriptor: usePullRequestPanelDescriptor,
});
