import { create } from "zustand";

// The pull request panel's "Architecture change" button opens the architecture map tab and asks it to
// show the Change view. The tab target stays `{ kind: "architecture_map" }` (one map tab per
// workspace, as before); the request is a one-shot note the panel consumes and then clears, so a
// persisted layout never carries it.

interface ChangeViewRequests {
  pending: ReadonlySet<string>;
  request: (workspaceKey: string) => void;
  consume: (workspaceKey: string) => boolean;
}

export const useChangeViewRequests = create<ChangeViewRequests>((set, get) => ({
  pending: new Set(),
  request: (workspaceKey) =>
    set((state) => ({ pending: new Set(state.pending).add(workspaceKey) })),
  consume: (workspaceKey) => {
    if (!get().pending.has(workspaceKey)) return false;
    set((state) => {
      const pending = new Set(state.pending);
      pending.delete(workspaceKey);
      return { pending };
    });
    return true;
  },
}));

export const changeViewRequestKey = (serverId: string, workspaceId: string) =>
  `${serverId}\u0000${workspaceId}`;
