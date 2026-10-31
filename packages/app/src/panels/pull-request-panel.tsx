import { useRetainedPullRequestData } from "./pull-request/data";
import {
  pullRequestPanelPresentation,
  usePullRequestPanelDescriptor,
} from "./pull-request/descriptor";
import { Text, View } from "react-native";
<<<<<<< HEAD
import { GitPullRequest } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";
import { ArchitectureEntry } from "./architecture-entry";
import { formatPrTabLabel } from "@/git/pull-request-panel";
=======
import { useTranslation } from "react-i18next";
import invariant from "tiny-invariant";
>>>>>>> refs/remotes/upstream/tags/v0.14.0
import { usePaneContext } from "@/panels/pane-context";
import { definePanel } from "@/panels/panel-registry";
import { PullRequestContent } from "@/panels/pull-request";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";

const CENTERED_PADDED_STYLE = {
  flex: 1,
  alignItems: "center",
  justifyContent: "center",
  padding: 16,
} as const;

function PullRequestPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target } = usePaneContext();
  const cwd = useWorkspaceDirectory(serverId, workspaceId) ?? "";
  invariant(target.kind === "pull_request", "PullRequestPanel requires pull_request target");
  const prPane = useRetainedPullRequestData({ serverId, cwd }, "content");
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
