import { useMemo } from "react";
import { useFetchQuery } from "@/data/query";
import { useCheckoutDiffQuery } from "@/git/use-diff-query";
import { useCheckoutPrStatusQuery } from "@/git/use-pr-status-query";
import { useSessionStore } from "@/stores/session-store";
import {
  buildArchitectureChange,
  directoriesToCheck,
  mapTextAtCommit,
  pullRequestReadable,
  type ChangedFile,
  type PullRequestMaps,
} from "./architecture-change";
import { isArchitectureMapPath } from "./change-summary";
import { ARCHITECTURE_IR_LIMITS } from "./ir-schema";
import type { PatchFile } from "./reverse-patch";

// Read-only, like the map panel: the branch's diff against its base (the pull request's base branch
// when there is one), the map's current text, and listings of the folders beside changed code. The
// daemon confines every read to the workspace root.

const STALE_TIME_MS = 5000;

export interface ArchitectureChangeSources {
  isLoading: boolean;
  error: string | null;
  /** The diff was cut short by the host, so a change to the map may be missing from it. */
  diffTooLarge: boolean;
  changedFiles: ChangedFile[];
  /** Maps the branch deleted: they are not in the folder any more but still have a "before". */
  deletedMaps: string[];
  mapDiff: (path: string) => PatchFile | null;
  pullRequest: {
    number: number;
    baseRefName: string | null;
    /** The forge's commits for the base branch tip and the head, when given. */
    baseRefOid: string | null;
    headRefOid: string | null;
  } | null;
}

export function useArchitectureChangeSources(input: {
  serverId: string;
  workspaceRoot: string | null;
  enabled: boolean;
}): ArchitectureChangeSources {
  const cwd = input.workspaceRoot ?? "";
  const prStatus = useCheckoutPrStatusQuery({
    serverId: input.serverId,
    cwd,
    enabled: input.enabled && Boolean(cwd),
  });
  const pr = prStatus.status;
  const baseRef = pr?.baseRefName ?? undefined;
  const diff = useCheckoutDiffQuery({
    serverId: input.serverId,
    cwd,
    mode: "base",
    baseRef,
    // Undoing the diff must see every character, or the rebuilt base would differ from the real one.
    ignoreWhitespace: false,
    enabled: input.enabled && Boolean(cwd) && !prStatus.isLoading,
    queryScope: "architecture-change",
  });
  return useMemo(() => {
    const byPath = new Map(diff.files.map((file) => [file.oldPath ?? file.path, file]));
    for (const file of diff.files) byPath.set(file.path, file);
    return {
      isLoading: prStatus.isLoading || diff.isLoading,
      error: diff.payloadError ? (diff.payloadError.message ?? null) : null,
      diffTooLarge: diff.diffTooLarge,
      changedFiles: diff.files.map((file) => ({
        path: file.path,
        ...(file.oldPath ? { oldPath: file.oldPath } : {}),
        isDeleted: file.isDeleted,
      })),
      deletedMaps: diff.files
        .filter((file) => file.isDeleted && isArchitectureMapPath(file.path))
        .map((file) => file.path),
      mapDiff: (path: string) => byPath.get(path) ?? null,
      pullRequest:
        pr && typeof pr.number === "number"
          ? {
              number: pr.number,
              baseRefName: pr.baseRefName ?? null,
              baseRefOid: pr.baseRefOid ?? null,
              headRefOid: pr.headRefOid ?? null,
            }
          : null,
    };
  }, [diff, pr, prStatus.isLoading]);
}

/** The map's current text; null when the file does not exist (the branch deleted it). */
export function useArchitectureMapText(input: {
  serverId: string;
  workspaceRoot: string | null;
  path: string | null;
  exists: boolean;
}) {
  const client = useSessionStore((state) => state.sessions[input.serverId]?.client ?? null);
  return useFetchQuery({
    dataShape: "value",
    staleTimeMs: STALE_TIME_MS,
    queryKey: [
      "architecture-change-text",
      input.serverId,
      input.workspaceRoot,
      input.path,
      input.exists,
    ],
    enabled: Boolean(client && input.workspaceRoot && input.path),
    retry: false,
    queryFn: async (): Promise<string | null> => {
      if (!input.exists) return null;
      if (!client || !input.workspaceRoot || !input.path) return null;
      const file = await client.readFile(
        input.workspaceRoot,
        input.path,
        undefined,
        ARCHITECTURE_IR_LIMITS.maxBytes,
      );
      return new TextDecoder("utf-8").decode(file.bytes);
    },
  });
}

/**
 * The map at a pull request's commits: Before at the merge base of its base and head,
 * After at its head. Both come from git at those commits; the working tree is never read.
 */
export function usePullRequestMaps(input: {
  serverId: string;
  workspaceRoot: string | null;
  path: string | null;
  pullRequest: { baseRefOid: string | null; headRefOid: string | null } | null;
}): { data: PullRequestMaps | null | undefined; isLoading: boolean; refetch: () => unknown } {
  const client = useSessionStore((state) => state.sessions[input.serverId]?.client ?? null);
  const hostCanRead = useSessionStore(
    (state) => state.sessions[input.serverId]?.serverInfo?.features?.checkoutFileAtCommit === true,
  );
  const commits = pullRequestReadable(hostCanRead, input.pullRequest);
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: STALE_TIME_MS,
    queryKey: [
      "architecture-change-at-commits",
      input.serverId,
      input.workspaceRoot,
      input.path,
      commits?.base ?? null,
      commits?.head ?? null,
    ],
    enabled: Boolean(client && input.workspaceRoot && input.path && commits),
    retry: false,
    queryFn: async (): Promise<PullRequestMaps> => {
      if (!client || !input.workspaceRoot || !input.path || !commits)
        return { kind: "unavailable", reason: "pull-request", detail: [] };
      const read = (
        at: { kind: "commit"; sha: string } | { kind: "merge-base"; of: [string, string] },
      ) =>
        client.getFileAtCommit({
          cwd: input.workspaceRoot!,
          at,
          path: input.path!,
          maxBytes: ARCHITECTURE_IR_LIMITS.maxBytes,
        });
      let before, after;
      try {
        [before, after] = await Promise.all([
          read({ kind: "merge-base", of: [commits.base, commits.head] }),
          read({ kind: "commit", sha: commits.head }),
        ]);
      } catch (error) {
        // A refused or failed read is shown as such; the view never falls back to local files.
        return {
          kind: "unavailable",
          reason: "commit-read",
          detail: error instanceof Error ? [error.message] : [],
        };
      }
      const base = mapTextAtCommit(before),
        head = mapTextAtCommit(after);
      if (base.kind === "unavailable") return base;
      if (head.kind === "unavailable") return head;
      return { kind: "ok", base: base.text, head: head.text };
    },
  });
  // Without the host interface or the forge's commits there is nothing to read: say so, never guess.
  if (input.pullRequest && !commits)
    return {
      data: { kind: "unavailable", reason: "pull-request", detail: [] },
      isLoading: false,
      refetch: query.refetch,
    };
  return {
    data: query.data ?? (input.pullRequest ? undefined : null),
    isLoading: query.isLoading,
    refetch: query.refetch,
  };
}

/** File names in each folder beside changed code, for the "test beside it" count. */
export function useSiblingListings(input: {
  serverId: string;
  workspaceRoot: string | null;
  changedFiles: readonly ChangedFile[];
}) {
  const client = useSessionStore((state) => state.sessions[input.serverId]?.client ?? null);
  const directories = useMemo(() => directoriesToCheck(input.changedFiles), [input.changedFiles]);
  return useFetchQuery({
    dataShape: "value",
    staleTimeMs: STALE_TIME_MS,
    queryKey: ["architecture-change-siblings", input.serverId, input.workspaceRoot, directories],
    enabled: Boolean(client && input.workspaceRoot && directories.length > 0),
    retry: false,
    queryFn: async (): Promise<Map<string, string[]>> => {
      const listings = new Map<string, string[]>();
      if (!client || !input.workspaceRoot) return listings;
      // One folder at a time: a handful of small reads, never a burst.
      for (const directory of directories) {
        try {
          const listing = await client.listDirectory(input.workspaceRoot, directory);
          listings.set(
            directory,
            listing.entries.filter((entry) => entry.kind === "file").map((entry) => entry.name),
          );
        } catch {
          // A folder that cannot be listed is simply not counted as checked.
        }
      }
      return listings;
    },
  });
}

export interface ChangeCandidate {
  name: string;
  path: string;
  size: number;
  /** False for a map the branch deleted: it has a "before" but no file now. */
  exists: boolean;
}

/**
 * Everything the Change view needs for one workspace: the maps to choose from (listed ones plus
 * any the branch deleted), the chosen map's comparison, and the state of the reads behind it.
 */
export function useArchitectureChange(input: {
  serverId: string;
  workspaceRoot: string;
  maps: readonly { name: string; path: string; size: number }[];
  chosenPath: string | null;
}) {
  const { serverId, workspaceRoot, maps, chosenPath } = input;
  const sources = useArchitectureChangeSources({ serverId, workspaceRoot, enabled: true });
  const candidates = useMemo<ChangeCandidate[]>(
    () => [
      ...maps.map((entry) => ({ ...entry, exists: true })),
      ...sources.deletedMaps.map((path) => ({
        path,
        name: path.slice(path.lastIndexOf("/") + 1),
        size: 0,
        exists: false,
      })),
    ],
    [maps, sources.deletedMaps],
  );
  const selected = candidates.find((entry) => entry.path === chosenPath) ?? candidates[0] ?? null;
  const { mapDiff, changedFiles, pullRequest } = sources;
  // A pull request reads its map at its own commits; only a branch without one reads the local file.
  const atCommits = usePullRequestMaps({
    serverId,
    workspaceRoot,
    path: selected?.path ?? null,
    pullRequest,
  });
  const text = useArchitectureMapText({
    serverId,
    workspaceRoot: pullRequest ? null : workspaceRoot,
    path: selected?.path ?? null,
    exists: selected?.exists ?? false,
  });
  const siblings = useSiblingListings({
    serverId,
    workspaceRoot,
    changedFiles: sources.changedFiles,
  });
  const change = useMemo(() => {
    if (!selected || sources.isLoading) return null;
    if (pullRequest ? atCommits.data === undefined : text.data === undefined) return null;
    return buildArchitectureChange({
      mapPath: selected.path,
      headText: pullRequest ? null : (text.data ?? null),
      mapDiff: mapDiff(selected.path),
      changedFiles,
      siblings: siblings.data ?? new Map(),
      pullRequest,
      pullRequestMaps: pullRequest ? (atCommits.data ?? null) : null,
    });
  }, [
    selected,
    text.data,
    atCommits.data,
    sources.isLoading,
    mapDiff,
    changedFiles,
    siblings.data,
    pullRequest,
  ]);
  const error = text.error instanceof Error ? text.error.message : sources.error;
  return {
    candidates,
    selected,
    change,
    error,
    loading:
      sources.isLoading ||
      text.isLoading ||
      atCommits.isLoading ||
      (change === null && error === null),
    /** The host cut the diff short and the chosen map is not in what arrived. */
    diffCut: sources.diffTooLarge && selected !== null && mapDiff(selected.path) === null,
    pullRequest,
    reload: pullRequest ? atCommits.refetch : text.refetch,
  };
}
