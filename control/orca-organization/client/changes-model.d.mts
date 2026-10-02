import type { TrackerView } from "../shared/cc/connectors";
export interface ChangeWorkspace {
  id: string;
  workspaceKind?: string;
  gitRuntime?: { remoteUrl?: string | null } | null;
}
export function recentPullRequests(
  entries: TrackerView["items"],
  now?: number,
): TrackerView["items"];
export type ChangeTarget =
  | { state: "ready"; repo: string; workspaceId: string; pullRequest: number }
  | { state: "no-checkout"; repo: string; pullRequest: number }
  | { state: "unreadable" };
export function changeTarget(
  item: TrackerView["items"][number]["item"],
  workspaces: readonly ChangeWorkspace[],
  chosen?: ReadonlyMap<string, string>,
): ChangeTarget;
export function checkoutFolder(text: string): string | null;
export function addFolderProblem(error: unknown): string;
export function changeDestination(
  item: TrackerView["items"][number]["item"],
  workspaces: readonly ChangeWorkspace[],
): { workspaceId: string; pullRequest: number } | null;
export function readChangeWorkspaces(
  list: (input: { page: { limit: number; cursor?: string } }) => Promise<{
    entries: ChangeWorkspace[];
    pageInfo?: { hasMore: boolean; nextCursor: string | null };
  }>,
): Promise<{ entries: ChangeWorkspace[] }>;
