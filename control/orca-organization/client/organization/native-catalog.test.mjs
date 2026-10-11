import test from "node:test";
import assert from "node:assert/strict";
import { readOrganizationNativeCatalog } from "./native-catalog.mjs";
test("bounded directory pagination retains exact host/project/session identity without model/history calls", async () => {
  let reads = 0;
  const api = {
    projects: {
      list: async () => ({ projects: [{ projectId: "project", projectDisplayName: "Alpha" }] }),
    },
    workspaces: {
      list: async ({ page }) => {
        reads++;
        return {
          entries: [
            {
              id: page.cursor ? "second" : "first",
              projectId: "project",
              name: "main",
              workspaceDirectory: "/repo",
              projectRootPath: "/repo",
              status: "done",
            },
          ],
          pageInfo: { hasMore: !page.cursor, nextCursor: page.cursor ? null : "next" },
        };
      },
    },
    agents: {
      list: async () => ({
        entries: [
          {
            agent: {
              id: "retained-agent",
              workspaceId: "first",
              title: "Original conversation",
              status: "idle",
            },
          },
        ],
        pageInfo: { hasMore: false },
      }),
      ref: () => assert.fail("No provider restore"),
    },
    providers: { refresh: () => assert.fail("No probe") },
  };
  const data = await readOrganizationNativeCatalog(api, "host-a");
  assert.equal(reads, 2);
  assert.equal(data.partial, false);
  assert.deepEqual(
    data.contexts.map(({ serverId, projectId, workspaceId }) => ({
      serverId,
      projectId,
      workspaceId,
    })),
    [
      { serverId: "host-a", projectId: "project", workspaceId: "first" },
      { serverId: "host-a", projectId: "project", workspaceId: "second" },
    ],
  );
  assert.equal(data.sessions[0].agentId, "retained-agent");
});
test("a repeated cursor or page cap is partial, never an unbounded read loop", async () => {
  let calls = 0;
  const list = async () => {
    calls++;
    return { entries: [], pageInfo: { hasMore: true, nextCursor: "same" } };
  };
  const result = await readOrganizationNativeCatalog(
    { projects: { list: async () => ({ projects: [] }) }, workspaces: { list }, agents: { list } },
    "host-a",
  );
  assert.equal(result.partial, true);
  assert.equal(calls, 4);
});
