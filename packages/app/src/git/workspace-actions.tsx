import { GitAiWorkspacePreview } from "./git-ai-workspace-preview";
import { GitActionsSplitButton } from "@/git/actions-split-button";
import { GIT_ACTION_ICONS } from "@/git/action-icons";
import { useGitActions } from "@/git/use-actions";

interface WorkspaceActionsProps {
  serverId: string;
  cwd: string;
  workspaceId: string;
}

export function WorkspaceActions({ serverId, cwd, workspaceId }: WorkspaceActionsProps) {
  const { gitActions } = useGitActions({
    serverId,
    cwd,
    icons: GIT_ACTION_ICONS,
  });

  return (
    <>
      <GitActionsSplitButton gitActions={gitActions} />
      <GitAiWorkspacePreview serverId={serverId} workspaceId={workspaceId} cwd={cwd} />
    </>
  );
}
