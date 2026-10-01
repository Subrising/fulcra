import { describe, expect, it } from "vitest";
import { getInsights, PULL_REQUEST_LIST_LIMIT } from "./service.js";

const NOW = Date.parse("2026-09-29T12:00:00Z");

function deps(rowsFor: (args: string[]) => unknown[]) {
  const calls: string[][] = [];
  return {
    calls,
    deps: {
      paseoHome: "/nonexistent-insights-home",
      listProjects: async () => [
        { projectId: "p1", name: "Shop", rootPath: "/work/shop", kind: "git" },
      ],
      listWorkspaces: async () => [],
      listAgentRecords: async () => [],
      runGh: async (args: string[]) => {
        calls.push(args);
        return { stdout: JSON.stringify(rowsFor(args)) };
      },
      repositoryOf: async () => `acme/shop-${Math.random()}`,
      now: () => NOW,
    },
  };
}

describe("insights fetch", () => {
  it("reads pull requests merged or closed in the window, not only those opened in it", async () => {
    const old = {
      number: 1,
      createdAt: "2026-01-01T00:00:00Z",
      mergedAt: "2026-09-20T00:00:00Z",
      state: "MERGED",
    };
    const { deps: d, calls } = deps((args) => (args.includes("merged:>=2026-07-31") ? [old] : []));
    const result = await getInsights({ deps: d, projectId: null, days: 30 });
    expect(
      calls.map((a) => a[a.indexOf("--search") + 1]).filter((q) => q?.includes(":>=")),
    ).toEqual(["created:>=2026-07-31", "merged:>=2026-07-31", "closed:>=2026-07-31"]);
    expect(result.delivery?.merged).toBe(1);
    expect(result.delivery?.capped).toBe(false);
  });

  it("says so when a list reaches the read limit", async () => {
    const many = Array.from({ length: PULL_REQUEST_LIST_LIMIT }, (_, i) => ({
      number: i + 1,
      createdAt: "2026-09-20T00:00:00Z",
      state: "OPEN",
    }));
    const { deps: d } = deps((args) => (args.includes("open") ? many : []));
    const result = await getInsights({ deps: d, projectId: null, days: 30 });
    expect(result.delivery?.capped).toBe(true);
  });
});
