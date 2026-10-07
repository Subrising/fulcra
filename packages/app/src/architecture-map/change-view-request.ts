import { create } from "zustand";

// The pull request panel's "Architecture change" button opens the architecture map tab and asks it to
// show the Change view. The tab target stays `{ kind: "architecture_map" }` (one map tab per
// workspace, as before); the request is a one-shot note the panel consumes and then clears, so a
// persisted layout never carries it.

export type ArchitectureChangeSelection =
  | { pullRequest: number; commit?: never }
  | { commit: { base: string; head: string }; pullRequest?: never };

export function parseArchitectureChangeSelection(input: {
  pullRequest?: unknown;
  commit?: unknown;
}): ArchitectureChangeSelection {
  if (
    input.commit === undefined &&
    Number.isSafeInteger(input.pullRequest) &&
    (input.pullRequest as number) > 0
  )
    return { pullRequest: input.pullRequest as number };
  if (input.pullRequest === undefined && input.commit && typeof input.commit === "object") {
    const pair = input.commit as { base?: unknown; head?: unknown };
    const sha = /^[a-fA-F0-9]{40}$/;
    if (
      typeof pair.base === "string" &&
      typeof pair.head === "string" &&
      sha.test(pair.base) &&
      sha.test(pair.head)
    )
      return { commit: { base: pair.base.toLowerCase(), head: pair.head.toLowerCase() } };
  }
  throw new Error("Choose one pull request or two full commit SHAs.");
}

interface ChangeViewRequests {
  pending: ReadonlyMap<string, ArchitectureChangeSelection | true>;
  request: (workspaceKey: string, selection?: ArchitectureChangeSelection) => void;
  consume: (workspaceKey: string) => ArchitectureChangeSelection | boolean;
}

export const useChangeViewRequests = create<ChangeViewRequests>((set, get) => ({
  pending: new Map(),
  request: (workspaceKey, selection) =>
    set((state) => ({ pending: new Map(state.pending).set(workspaceKey, selection ?? true) })),
  consume: (workspaceKey) => {
    const selection = get().pending.get(workspaceKey);
    if (!selection) return false;
    set((state) => {
      const pending = new Map(state.pending);
      pending.delete(workspaceKey);
      return { pending };
    });
    return selection;
  },
}));

export const changeViewRequestKey = (serverId: string, workspaceId: string) =>
  `${serverId}\u0000${workspaceId}`;

/** Navigation only: preserves exact host/workspace and validates an explicit native PR selector. */
export function codeArchitectureNavigation(input: {
  serverId: string;
  workspaceId: string;
  pullRequest?: number;
}) {
  return {
    key: changeViewRequestKey(input.serverId, input.workspaceId),
    target: { kind: "architecture_map" as const },
    selection:
      input.pullRequest === undefined
        ? undefined
        : parseArchitectureChangeSelection({ pullRequest: input.pullRequest }),
  };
}
