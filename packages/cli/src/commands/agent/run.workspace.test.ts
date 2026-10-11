import { describe, expect, it } from "vitest";
import { findWorkspaceForDirectory, structuredRunSchema } from "./run.js";

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

  it("returns null when the lookup fails, so the run can still make a workspace", async () => {
    const client = {
      fetchWorkspaces: async () => {
        throw new Error("daemon busy");
      },
    };
    expect(await findWorkspaceForDirectory(client, "/work/songs")).toBeNull();
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
