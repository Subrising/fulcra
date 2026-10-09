import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { DaemonConnectionError } from "@getpaseo/client/internal/daemon-client";
import {
  addRunOptions,
  resolveExistingRunWorkspace,
  resolveRunCallerAgentId,
  runRunCommand,
  type AgentRunOptions,
} from "./run";

const connection = vi.hoisted(() => vi.fn());
vi.mock("../../utils/client.js", () => ({ connectToDaemon: connection }));

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

// Answers fetchAgent the way a daemon does: an unknown id is an error.
function daemonWithAgents(...agentIds: string[]) {
  return {
    async fetchAgent({ agentId }: { agentId: string }) {
      if (!agentIds.includes(agentId)) {
        throw new Error(`Agent not found: ${agentId}`);
      }
      return { agent: { id: agentId } };
    },
  };
}

describe("managed agent caller context", () => {
  it("uses a trimmed PASEO_AGENT_ID when the target daemon runs that agent", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents("parent-agent"), {
        PASEO_AGENT_ID: "  parent-agent  ",
      }),
    ).resolves.toBe("parent-agent");
  });

  it("runs without a caller when PASEO_AGENT_ID belongs to another daemon", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents("other-agent"), {
        PASEO_AGENT_ID: "parent-agent",
      }),
    ).resolves.toBeUndefined();
  });

  it("fails instead of dropping the caller when the lookup loses its connection", async () => {
    const disconnectedDaemon = {
      async fetchAgent(): Promise<never> {
        throw new DaemonConnectionError("Connection lost before message could be sent");
      },
    };

    await expect(
      resolveRunCallerAgentId(disconnectedDaemon, { PASEO_AGENT_ID: "parent-agent" }),
    ).rejects.toBeInstanceOf(DaemonConnectionError);
  });

  it("omits blank caller ids", async () => {
    await expect(
      resolveRunCallerAgentId(daemonWithAgents(), { PASEO_AGENT_ID: "   " }),
    ).resolves.toBeUndefined();
  });
});

describe("existing run workspace resolution", () => {
  it("queries the daemon for an exact workspace id and uses its directory", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [{ id: "workspace-2", workspaceDirectory: "/workspace/two" }],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "workspace-2")).resolves.toEqual({
      id: "workspace-2",
      cwd: "/workspace/two",
    });
    expect(fetchWorkspaces).toHaveBeenCalledWith({
      filter: { query: "workspace-2" },
      page: { limit: 200 },
    });
  });

  it("rejects a workspace id absent from daemon state", async () => {
    const fetchWorkspaces = vi.fn().mockResolvedValue({
      entries: [],
      pageInfo: { nextCursor: null },
    });

    await expect(resolveExistingRunWorkspace({ fetchWorkspaces }, "missing")).rejects.toMatchObject(
      {
        code: "WORKSPACE_NOT_FOUND",
        message: "Workspace not found: missing",
      },
    );
  });
});

// validateRunOptions runs before the CLI ever connects to a daemon, so these
// invalid combinations reject without one running.
describe("runRunCommand option validation", () => {
  const originalWorkspaceId = process.env.PASEO_WORKSPACE_ID;

  beforeEach(() => {
    delete process.env.PASEO_WORKSPACE_ID;
  });

  afterEach(() => {
    if (originalWorkspaceId === undefined) {
      delete process.env.PASEO_WORKSPACE_ID;
    } else {
      process.env.PASEO_WORKSPACE_ID = originalWorkspaceId;
    }
  });

  async function expectInvalidOptions(
    options: Omit<AgentRunOptions, "daemonTarget">,
    messageMatch: RegExp,
  ) {
    await expect(
      runRunCommand("do something", { ...options, daemonTarget }, {} as never),
    ).rejects.toMatchObject({
      code: "INVALID_OPTIONS",
      message: expect.stringMatching(messageMatch),
    });
  }

  it("rejects --new-workspace combined with --workspace", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", workspace: "ws-1" },
      /--new-workspace and --workspace cannot be combined/,
    );
  });

  it("allows explicit worktree workspace creation through validation", async () => {
    // Explicit workspace creation with no --workspace
    // must clear validation. It still fails later (provider resolution), which
    // is enough to prove the new guard did not reject it.
    await expect(
      runRunCommand(
        "do something",
        { newWorkspace: "worktree", provider: undefined, daemonTarget },
        {} as never,
      ),
    ).rejects.not.toMatchObject({ code: "INVALID_OPTIONS" });
  });

  it("rejects unknown new workspace kinds", async () => {
    await expectInvalidOptions({ newWorkspace: "container" }, /Unsupported new workspace kind/);
  });

  it("rejects two workspace creation flags", async () => {
    await expectInvalidOptions(
      { newWorkspace: "local", worktree: "legacy-slug" },
      /--new-workspace and --worktree cannot be combined/,
    );
  });

  it("rejects an unknown worktree creation mode before connecting", async () => {
    await expectInvalidOptions(
      { newWorkspace: "worktree", worktreeMode: "container" },
      /Unsupported worktree mode/,
    );
  });
});

describe("explicit run cwd workspace precedence", () => {
  const originalAgent = process.env.PASEO_AGENT_ID;
  const originalWorkspace = process.env.PASEO_WORKSPACE_ID;
  beforeEach(() => {
    connection.mockReset();
    process.env.PASEO_AGENT_ID = "caller-agent";
    process.env.PASEO_WORKSPACE_ID = "ambient-workspace";
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (originalAgent === undefined) delete process.env.PASEO_AGENT_ID;
    else process.env.PASEO_AGENT_ID = originalAgent;
    if (originalWorkspace === undefined) delete process.env.PASEO_WORKSPACE_ID;
    else process.env.PASEO_WORKSPACE_ID = originalWorkspace;
  });
  function fakeClient() {
    const client = {
      fetchAgent: vi.fn().mockResolvedValue({ agent: { id: "caller-agent" } }),
      fetchWorkspaces: vi.fn().mockResolvedValue({
        entries: [
          { id: "chosen-workspace", workspaceDirectory: "/fixtures/chosen" },
          { id: "ambient-workspace", workspaceDirectory: "/fixtures/ambient" },
        ],
        pageInfo: { nextCursor: null },
      }),
      createWorkspace: vi.fn().mockResolvedValue({
        workspace: {
          id: "requested-workspace",
          name: "Requested",
          workspaceDirectory: "/fixtures/requested",
        },
      }),
      createAgent: vi.fn().mockImplementation(async (input) => ({
        id: "child-agent",
        status: "running",
        title: "Fixture",
        provider: input.provider,
        cwd: input.cwd,
      })),
      close: vi.fn().mockResolvedValue(undefined),
    };
    connection.mockResolvedValue(client);
    return client;
  }
  async function parsedRun(flags: string[]) {
    const command = addRunOptions(new Command());
    command.exitOverride();
    command.parse([...flags, "fixture prompt"], { from: "user" });
    return runRunCommand(
      "fixture prompt",
      { ...command.opts(), provider: "codex", background: true, daemonTarget },
      command,
    );
  }
  it("honors parsed --cwd over caller and ambient placement while retaining caller identity", async () => {
    const client = fakeClient();
    await parsedRun(["--cwd", "/fixtures/requested"]);
    expect(client.createWorkspace).toHaveBeenCalledWith({
      source: { kind: "directory", path: "/fixtures/requested" },
    });
    expect(client.fetchWorkspaces).not.toHaveBeenCalled();
    expect(client.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/fixtures/requested",
        workspaceId: "requested-workspace",
        callerAgentId: "caller-agent",
      }),
    );
    expect(client.close).toHaveBeenCalledOnce();
  });
  it("records the calling chat as the new chat's reporting line and names it in the first message", async () => {
    const client = fakeClient();
    await parsedRun([]);
    expect(client.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: { "fulcra.reports-to": "caller-agent" },
        initialPrompt:
          "You report to chat caller-agent. Send your reports and questions to it.\n\nfixture prompt",
      }),
    );
  });
  it("honors --cwd over an ambient workspace without a caller", async () => {
    delete process.env.PASEO_AGENT_ID;
    const client = fakeClient();
    await parsedRun(["--cwd", "/fixtures/requested"]);
    expect(client.createWorkspace).toHaveBeenCalledWith({
      source: { kind: "directory", path: "/fixtures/requested" },
    });
    expect(client.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/fixtures/requested",
        workspaceId: "requested-workspace",
        callerAgentId: undefined,
      }),
    );
    expect(client.fetchWorkspaces).not.toHaveBeenCalled();
  });
  it("keeps implicit runs in the caller workspace", async () => {
    const client = fakeClient();
    await parsedRun([]);
    expect(client.createWorkspace).not.toHaveBeenCalled();
    expect(client.fetchWorkspaces).not.toHaveBeenCalled();
    expect(client.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: undefined, callerAgentId: "caller-agent" }),
    );
  });
  it("keeps implicit terminal runs in the ambient workspace", async () => {
    delete process.env.PASEO_AGENT_ID;
    const client = fakeClient();
    await parsedRun([]);
    expect(client.createWorkspace).not.toHaveBeenCalled();
    expect(client.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/fixtures/ambient", workspaceId: "ambient-workspace" }),
    );
  });
  it("keeps --workspace as the authoritative explicit workspace selection", async () => {
    const client = fakeClient();
    await parsedRun(["--workspace", "chosen-workspace", "--cwd", "/fixtures/requested"]);
    expect(client.createWorkspace).not.toHaveBeenCalled();
    expect(client.createAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/fixtures/chosen",
        workspaceId: "chosen-workspace",
        callerAgentId: "caller-agent",
      }),
    );
  });
  it("fails without a caller-workspace fallback when explicit cwd creation fails", async () => {
    const client = fakeClient();
    client.createWorkspace.mockResolvedValue({
      workspace: null,
      error: "Fixture path unavailable",
    } as never);
    await expect(parsedRun(["--cwd", "/fixtures/requested"])).rejects.toMatchObject({
      code: "WORKSPACE_CREATE_FAILED",
    });
    expect(client.createAgent).not.toHaveBeenCalled();
    expect(client.fetchWorkspaces).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });
});
