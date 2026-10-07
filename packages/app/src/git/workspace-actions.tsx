import { useCallback, useState } from "react";
import { GitAiWorkspacePreview, type GitAiStartKind } from "./git-ai-workspace-preview";
import { GitActionsSplitButton } from "@/git/actions-split-button";
import { GIT_ACTION_ICONS } from "@/git/action-icons";
import { useGitActions } from "@/git/use-actions";
import { useHostFeatureAvailability } from "@/runtime/host-features";

interface WorkspaceActionsProps {
  serverId: string;
  cwd: string;
  workspaceId: string;
}

export function WorkspaceActions({ serverId, cwd, workspaceId }: WorkspaceActionsProps) {
  // Where the host can draft wording, Commit and Create PR show an editable draft first.
  const drafts = useHostFeatureAvailability(serverId, "gitAiDrafts") === true;
  const [start, setStart] = useState<{ kind: GitAiStartKind; nonce: number } | null>(null);
  const reviewWording = useCallback(
    (kind: GitAiStartKind) => setStart((prev) => ({ kind, nonce: (prev?.nonce ?? 0) + 1 })),
    [],
  );
  const { gitActions } = useGitActions({
    serverId,
    cwd,
    icons: GIT_ACTION_ICONS,
    reviewWording: drafts ? reviewWording : undefined,
  });

  return (
    <>
      <GitActionsSplitButton gitActions={gitActions} />
      <GitAiWorkspacePreview
        serverId={serverId}
        workspaceId={workspaceId}
        cwd={cwd}
        start={start}
      />
    </>
  );
}
