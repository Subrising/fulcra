/** @vitest-environment jsdom */
import { renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  queries: [] as { queryFn: () => Promise<unknown> }[],
  read: vi.fn(),
  status: null as {
    number: number;
    baseRefName?: string;
    baseRefOid: string;
    headRefOid: string;
  } | null,
  statusInputs: [] as { pullRequest?: number; enabled: boolean }[],
  diffInputs: [] as { enabled: boolean }[],
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (select: (state: unknown) => unknown) =>
    select({
      sessions: {
        server: {
          client: { getFileAtCommit: fixture.read },
          serverInfo: { features: { checkoutFileAtCommit: true } },
        },
      },
    }),
}));
vi.mock("@/data/query", () => ({
  useFetchQuery: (input: { queryFn: () => Promise<unknown> }) => {
    fixture.queries.push(input);
    return { data: undefined, isLoading: false, refetch() {} };
  },
}));
vi.mock("@/git/use-pr-status-query", () => ({
  useCheckoutPrStatusQuery: (input: { pullRequest?: number; enabled: boolean }) => {
    fixture.statusInputs.push(input);
    return { status: fixture.status, isLoading: false };
  },
}));
vi.mock("@/git/use-diff-query", () => ({
  useCheckoutDiffQuery: (input: { enabled: boolean }) => {
    fixture.diffInputs.push(input);
    return {
      files: [{ path: "unrelated.ts" }],
      isLoading: false,
      payloadError: null,
      diffTooLarge: false,
    };
  },
}));
import { usePullRequestMaps, useArchitectureChangeSources } from "./use-architecture-change";
beforeEach(() => {
  fixture.queries = [];
  fixture.statusInputs = [];
  fixture.diffInputs = [];
  fixture.status = null;
  fixture.read.mockReset().mockResolvedValue({ status: "ok", encoding: "utf-8", content: "map" });
});
const base = "a".repeat(40),
  head = "b".repeat(40);
it("reads the exact supplied commit pair, not its merge base or working tree", async () => {
  renderHook(() =>
    usePullRequestMaps({
      serverId: "server",
      workspaceRoot: "/fixture",
      path: ".fulcra/architecture/app.ir.json",
      pullRequest: null,
      commit: { base, head },
    }),
  );
  await fixture.queries[0].queryFn();
  expect(fixture.read.mock.calls.map((call) => call[0].at)).toEqual([
    { kind: "commit", sha: base },
    { kind: "commit", sha: head },
  ]);
});
it("preserves PR merge-base semantics at its own commits", async () => {
  renderHook(() =>
    usePullRequestMaps({
      serverId: "server",
      workspaceRoot: "/fixture",
      path: ".fulcra/architecture/app.ir.json",
      pullRequest: { baseRefOid: base, headRefOid: head },
    }),
  );
  await fixture.queries[0].queryFn();
  expect(fixture.read.mock.calls.map((call) => call[0].at)).toEqual([
    { kind: "merge-base", of: [base, head] },
    { kind: "commit", sha: head },
  ]);
});
it("requests the selected PR and refuses a legacy host's unrelated current-branch answer", () => {
  fixture.status = { number: 3, baseRefOid: base, headRefOid: head };
  const { result } = renderHook(() =>
    useArchitectureChangeSources({
      serverId: "server",
      workspaceRoot: "/fixture",
      enabled: true,
      selection: { pullRequest: 27 },
    }),
  );
  expect(fixture.statusInputs[0].pullRequest).toBe(27);
  expect(fixture.diffInputs[0].enabled).toBe(false);
  expect(result.current.pullRequest).toBeNull();
  expect(result.current.error).toBe("The requested pull request is unavailable on this host.");
  expect(result.current.changedFiles).toEqual([]);
});
it("uses the selected PR's commits when its number matches", () => {
  fixture.status = { number: 27, baseRefName: "main", baseRefOid: base, headRefOid: head };
  const { result } = renderHook(() =>
    useArchitectureChangeSources({
      serverId: "server",
      workspaceRoot: "/fixture",
      enabled: true,
      selection: { pullRequest: 27 },
    }),
  );
  expect(result.current.pullRequest).toEqual(fixture.status);
  expect(result.current.error).toBeNull();
});

it("explicit commits ignore a cached current-branch PR", () => {
  fixture.status = { number: 3, baseRefOid: "c".repeat(40), headRefOid: "d".repeat(40) };
  const { result } = renderHook(() =>
    useArchitectureChangeSources({
      serverId: "server",
      workspaceRoot: "/fixture",
      enabled: true,
      selection: { commit: { base, head } },
    }),
  );
  expect(fixture.statusInputs[0].enabled).toBe(false);
  expect(result.current.pullRequest).toBeNull();
  expect(result.current.error).toBeNull();
});

it("Code architecture navigation carries the exact selected host, workspace and native PR without fallback", async () => {
  const { codeArchitectureNavigation } = await import("./change-view-request");
  expect(
    codeArchitectureNavigation({
      serverId: "book",
      workspaceId: "same-workspace",
      pullRequest: 42,
    }),
  ).toEqual({
    key: "book\0same-workspace",
    target: { kind: "architecture_map" },
    selection: { pullRequest: 42 },
  });
  expect(codeArchitectureNavigation({ serverId: "mini", workspaceId: "same-workspace" }).key).toBe(
    "mini\0same-workspace",
  );
  expect(
    codeArchitectureNavigation({ serverId: "book", workspaceId: "same-workspace" }).selection,
  ).toBeUndefined();
  expect(() =>
    codeArchitectureNavigation({ serverId: "book", workspaceId: "same-workspace", pullRequest: 0 }),
  ).toThrow("Choose one pull request");
});
