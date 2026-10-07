import { useCallback, useState } from "react";
import { ForgeSearchItemSchema } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useSessionStore } from "@/stores/session-store";
import type { GeneratedPayload } from "./generated-change";

// The Change view drawn from code (CONTRACTS v1.17): the project's pull requests to choose from, the host's
// generated Before/After and blast radius for the chosen one, and the one write, fetching a pull request's commits,
// which only runs when the person presses the button.

const LIST_STALE_MS = 30_000;
const CHANGE_STALE_MS = 60_000;
// Explanations are cached on the host, so asking again after this is free; useFetchQuery needs a finite value.
const EXPLAIN_STALE_MS = 10 * 60_000;

export interface PullRequestChoice {
  number: number;
  title: string;
  state: string;
}

export function useCanGenerateChanges(serverId: string): boolean {
  return useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.architectureChangeGenerate === true,
  );
}

export function usePullRequestChoices(input: {
  serverId: string;
  cwd: string | null;
  enabled: boolean;
}) {
  const client = useSessionStore((state) => state.sessions[input.serverId]?.client ?? null);
  return useFetchQuery({
    dataShape: "value",
    staleTimeMs: LIST_STALE_MS,
    queryKey: ["architecture-change-pull-requests", input.serverId, input.cwd],
    enabled: Boolean(client && input.cwd && input.enabled),
    retry: false,
    queryFn: async (): Promise<PullRequestChoice[]> => {
      if (!client || !input.cwd) return [];
      const payload = await client.searchForge({
        cwd: input.cwd,
        query: "",
        kinds: ["change_request"],
        limit: 30,
      });
      if (payload.error) throw new Error(payload.error);
      return payload.items.flatMap((item) => {
        const parsed = ForgeSearchItemSchema.safeParse(item);
        return parsed.success && parsed.data.kind === "change_request"
          ? [{ number: parsed.data.number, title: parsed.data.title, state: parsed.data.state }]
          : [];
      });
    },
  });
}

export function useGeneratedChange(input: {
  serverId: string;
  cwd: string | null;
  pullRequest: number | null;
}) {
  const client = useSessionStore((state) => state.sessions[input.serverId]?.client ?? null);
  return useFetchQuery({
    dataShape: "value",
    staleTimeMs: CHANGE_STALE_MS,
    queryKey: ["architecture-change-generated", input.serverId, input.cwd, input.pullRequest],
    enabled: Boolean(client && input.cwd && input.pullRequest !== null),
    retry: false,
    queryFn: async (): Promise<GeneratedPayload> => {
      if (!client || !input.cwd || input.pullRequest === null)
        throw new Error("No pull request chosen");
      return client.getArchitectureChange({ cwd: input.cwd, pullRequest: input.pullRequest });
    },
  });
}

export function useFetchPullRequestCommits(input: {
  serverId: string;
  cwd: string | null;
  pullRequest: number | null;
  onFetched: () => void;
}): { fetch: () => void; fetching: boolean; failed: string | null } {
  const client = useSessionStore((state) => state.sessions[input.serverId]?.client ?? null);
  const [fetching, setFetching] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const { cwd, pullRequest, onFetched } = input;
  const fetch = useCallback(() => {
    if (!client || !cwd || pullRequest === null) return;
    setFetching(true);
    setFailed(null);
    void (async () => {
      try {
        const result = await client.fetchArchitectureChangeCommits({ cwd, pullRequest });
        if (result.status === "ok") onFetched();
        else setFailed(result.error ?? "");
      } catch (error) {
        setFailed(error instanceof Error ? error.message : "");
      } finally {
        setFetching(false);
      }
    })();
  }, [client, cwd, pullRequest, onFetched]);
  return { fetch, fetching, failed };
}

export function useCanShowGraph(serverId: string): boolean {
  return useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.architectureGraph === true,
  );
}

/** The whole-repository module graph, at the default branch or at a pull request's head. */
export function useArchitectureGraph(input: {
  serverId: string;
  cwd: string | null;
  pullRequest: number | null;
}) {
  const client = useSessionStore((state) => state.sessions[input.serverId]?.client ?? null);
  return useFetchQuery({
    dataShape: "value",
    staleTimeMs: CHANGE_STALE_MS,
    queryKey: ["architecture-graph", input.serverId, input.cwd, input.pullRequest],
    enabled: Boolean(client && input.cwd),
    retry: false,
    queryFn: async () => {
      if (!client || !input.cwd) throw new Error("No workspace");
      return client.getArchitectureGraph({
        cwd: input.cwd,
        ...(input.pullRequest !== null ? { pullRequest: input.pullRequest } : {}),
      });
    },
  });
}

export function useCanReviewPullRequests(serverId: string): boolean {
  return useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.pullRequestReview === true,
  );
}

/** One pull request's review screen facts. */
export function usePullRequestReview(input: {
  serverId: string;
  cwd: string | null;
  pullRequest: number;
}) {
  const client = useSessionStore((state) => state.sessions[input.serverId]?.client ?? null);
  return useFetchQuery({
    dataShape: "value",
    staleTimeMs: CHANGE_STALE_MS,
    queryKey: ["pull-request-review", input.serverId, input.cwd, input.pullRequest],
    enabled: Boolean(client && input.cwd),
    retry: false,
    queryFn: async () => {
      if (!client || !input.cwd) throw new Error("No workspace");
      return client.getPullRequestReview({ cwd: input.cwd, pullRequest: input.pullRequest });
    },
  });
}

/** One file's changes between the pull request's merge base and head. */
export function useReviewFileDiff(input: {
  serverId: string;
  cwd: string | null;
  base: string | null;
  head: string | null;
  path: string | null;
}) {
  const client = useSessionStore((state) => state.sessions[input.serverId]?.client ?? null);
  return useFetchQuery({
    dataShape: "value",
    staleTimeMs: CHANGE_STALE_MS,
    queryKey: [
      "pull-request-review-diff",
      input.serverId,
      input.cwd,
      input.base,
      input.head,
      input.path,
    ],
    enabled: Boolean(client && input.cwd && input.base && input.head && input.path),
    retry: false,
    queryFn: async () => {
      if (!client || !input.cwd || !input.base || !input.head || !input.path)
        throw new Error("No file chosen");
      return client.getPullRequestReviewFileDiff({
        cwd: input.cwd,
        base: input.base,
        head: input.head,
        path: input.path,
      });
    },
  });
}

/**
 * "In plain words" or pseudocode for one review file, asked once per file version. The host caches the text, so a
 * re-open or a second reviewer costs nothing; the reply also carries today's use against the daily cap.
 */
export function useReviewExplanation(input: {
  serverId: string;
  cwd: string | null;
  base: string | null;
  head: string | null;
  path: string | null;
  /** "module": the code map's What it does for one folder; pass the map's commit as both base and head. */
  kind: "summary" | "pseudocode" | "module";
  enabled: boolean;
}) {
  const client = useSessionStore((state) => state.sessions[input.serverId]?.client ?? null);
  return useFetchQuery({
    dataShape: "value",
    staleTimeMs: EXPLAIN_STALE_MS,
    queryKey: [
      "pull-request-review-explain",
      input.serverId,
      input.cwd,
      input.base,
      input.head,
      input.path,
      input.kind,
    ],
    enabled: Boolean(
      input.enabled && client && input.cwd && input.base && input.head && input.path,
    ),
    retry: false,
    queryFn: async () => {
      if (!client || !input.cwd || !input.base || !input.head || !input.path)
        throw new Error("No file chosen");
      return client.explainPullRequestReviewFile({
        cwd: input.cwd,
        base: input.base,
        head: input.head,
        path: input.path,
        kind: input.kind,
      });
    },
  });
}
