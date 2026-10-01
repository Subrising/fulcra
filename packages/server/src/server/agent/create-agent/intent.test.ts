import { describe, expect, it } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { resolveCreateAgentIntent } from "./intent.js";

describe("resolveCreateAgentIntent", () => {
  it("keeps caller parentage when an explicit workspace changes placement", async () => {
    const intent = await resolveCreateAgentIntent({
      explicitWorkspaceId: "workspace-isolated",
      caller: { id: "parent-agent", cwd: "/parent", workspaceId: "workspace-parent" },
      labels: { purpose: "review" },
      resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/isolated" }),
      createWorkspace: async () => ({ workspaceId: "workspace-created", cwd: "/created" }),
    });

    expect(intent).toEqual({
      workspaceId: "workspace-isolated",
      cwd: "/isolated",
      parentAgentId: "parent-agent",
      labels: {
        purpose: "review",
        "fulcra.role": "implementation",
        [PARENT_AGENT_ID_LABEL]: "parent-agent",
      },
    });
  });

  it("update-7: a child inherits its caller's task and project, and is an implementation worker unless it names a role", async () => {
    const base = {
      caller: {
        id: "lead",
        cwd: "/lead",
        workspaceId: "ws-lead",
        labels: {
          task: "task-1",
          "fulcra.project": "proj-1",
          owner: "orca-control",
          "fulcra.role": "orchestration",
        },
      },
      resolveWorkspace: async (workspaceId: string) => ({ workspaceId, cwd: "/x" }),
      createWorkspace: async () => ({ workspaceId: "ws-new", cwd: "/new" }),
    };
    const child = await resolveCreateAgentIntent(base);
    expect(child.labels).toEqual({
      task: "task-1",
      "fulcra.project": "proj-1",
      "fulcra.role": "implementation",
      [PARENT_AGENT_ID_LABEL]: "lead",
    });
    const reviewer = await resolveCreateAgentIntent({
      ...base,
      labels: { "fulcra.role": "review", task: "task-2" },
    });
    expect(reviewer.labels).toMatchObject({
      "fulcra.role": "review",
      task: "task-2",
      "fulcra.project": "proj-1",
      [PARENT_AGENT_ID_LABEL]: "lead",
    });
    // No caller (the UI, the controller): nothing inherited, no role imposed.
    const top = await resolveCreateAgentIntent({ ...base, caller: null, labels: { purpose: "x" } });
    expect(top.labels).toEqual({ purpose: "x" });
    // A caller's parent label is never inherited: the child's parent is the caller itself.
    const nested = await resolveCreateAgentIntent({
      ...base,
      caller: {
        ...base.caller,
        labels: { ...base.caller.labels, [PARENT_AGENT_ID_LABEL]: "prime" },
      },
    });
    expect(nested.labels[PARENT_AGENT_ID_LABEL]).toBe("lead");
  });

  it("defaults an agent caller to its workspace without creating one", async () => {
    let createCount = 0;
    const intent = await resolveCreateAgentIntent({
      caller: { id: "parent-agent", cwd: "/parent", workspaceId: "workspace-parent" },
      resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/unused" }),
      createWorkspace: async () => {
        createCount += 1;
        return { workspaceId: "workspace-created", cwd: "/created" };
      },
    });

    expect(intent.workspaceId).toBe("workspace-parent");
    expect(intent.cwd).toBe("/parent");
    expect(intent.parentAgentId).toBe("parent-agent");
    expect(createCount).toBe(0);
  });

  it("creates a workspace for a human caller with no workspace context", async () => {
    const intent = await resolveCreateAgentIntent({
      caller: null,
      resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/unused" }),
      createWorkspace: async () => ({ workspaceId: "workspace-created", cwd: "/created" }),
    });

    expect(intent).toEqual({
      workspaceId: "workspace-created",
      cwd: "/created",
      parentAgentId: null,
      labels: {},
    });
  });

  it("keeps legacy detached creation independent", async () => {
    const intent = await resolveCreateAgentIntent({
      caller: { id: "parent-agent", cwd: "/parent", workspaceId: "workspace-parent" },
      labels: { [PARENT_AGENT_ID_LABEL]: "spoofed-parent" },
      legacyDetached: true,
      resolveWorkspace: async (workspaceId) => ({ workspaceId, cwd: "/unused" }),
      createWorkspace: async () => ({ workspaceId: "workspace-created", cwd: "/created" }),
    });

    expect(intent).toEqual({
      workspaceId: "workspace-parent",
      cwd: "/parent",
      parentAgentId: null,
      labels: {},
    });
  });
});
