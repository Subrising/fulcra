import { describe, expect, it } from "vitest";
import {
  findWorkspaceForDirectory,
  structuredRunSchema,
  type RunWorkspaceLookupClient,
} from "./run.js";

const entry = (id: string, workspaceDirectory: string) => ({ id, workspaceDirectory });
const lookup = (entries: Array<{ id: string; workspaceDirectory: string }>) => ({
  fetchWorkspaces: async () => ({ entries, pageInfo: { nextCursor: null } }),
});

// Fulcra 0.2.17 (FU-60): a run reuses the workspace that owns its directory, and keeps the agent id.
describe("run reuses a workspace for the same directory", () => {
  it("finds the workspace whose directory is the run directory, even with a trailing slash", async () => {
    const client = lookup([entry("w1", "/work/other"), entry("w2", "/work/songs")]);
    expect(await findWorkspaceForDirectory(client, "/work/songs/")).toEqual({
      id: "w2",
      cwd: "/work/songs",
    });
  });

  it("returns null for a new directory, and does not match a parent or a sibling", async () => {
    const client = lookup([entry("w1", "/work"), entry("w2", "/work/songs-2")]);
    expect(await findWorkspaceForDirectory(client, "/work/songs")).toBeNull();
  });

  it("lists workspaces in stable project order without a text query and follows pages until the directory matches", async () => {
    const requests: Parameters<RunWorkspaceLookupClient["fetchWorkspaces"]>[0][] = [];
    const client: RunWorkspaceLookupClient = {
      async fetchWorkspaces(options) {
        requests.push(options);
        if (requests.length === 1) {
          return { entries: [entry("w1", "/work/other")], pageInfo: { nextCursor: "next" } };
        }
        return { entries: [entry("w2", "/work/songs")], pageInfo: { nextCursor: null } };
      },
    };
    expect(await findWorkspaceForDirectory(client, "/work/songs/")).toEqual({
      id: "w2",
      cwd: "/work/songs",
    });
    expect(requests).toEqual([
      { sort: [{ key: "project_id", direction: "asc" }], page: { limit: 200 } },
      { sort: [{ key: "project_id", direction: "asc" }], page: { limit: 200, cursor: "next" } },
    ]);
  });

  it("fails when the lookup fails, so the run cannot create a duplicate workspace", async () => {
    const client = {
      fetchWorkspaces: async () => {
        throw new Error("daemon busy");
      },
    };
    await expect(findWorkspaceForDirectory(client, "/work/songs")).rejects.toThrow("daemon busy");
  });

  it("returns null only after all pages exclude the directory", async () => {
    const requests: Parameters<RunWorkspaceLookupClient["fetchWorkspaces"]>[0][] = [];
    const client: RunWorkspaceLookupClient = {
      async fetchWorkspaces(options) {
        requests.push(options);
        return {
          entries: [entry("w1", "/work/other")],
          pageInfo: { nextCursor: requests.length === 1 ? "next" : null },
        };
      },
    };
    expect(await findWorkspaceForDirectory(client, "/work/songs")).toBeNull();
    expect(requests).toEqual([
      { sort: [{ key: "project_id", direction: "asc" }], page: { limit: 200 } },
      { sort: [{ key: "project_id", direction: "asc" }], page: { limit: 200, cursor: "next" } },
    ]);
  });
});

describe("run --output-schema keeps the agent id", () => {
  const data = {
    agentId: "agent-1",
    status: "completed" as const,
    provider: "claude",
    cwd: "/x",
    title: null,
  };
  const output = { summary: "ok" };

  it("prints the answer as it was without --json, and wraps it with the agent id under --json", () => {
    expect(structuredRunSchema(output).serialize?.(data)).toEqual({ summary: "ok" });
    expect(structuredRunSchema(output, true).serialize?.(data)).toEqual({
      agentId: "agent-1",
      output: { summary: "ok" },
    });
  });
});
