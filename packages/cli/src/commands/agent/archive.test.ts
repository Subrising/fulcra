<<<<<<< HEAD
import { Command } from "commander";
import { runRestoreCommand } from "./restore";
import { connectToDaemon } from "../../utils/client";
vi.mock("../../utils/client", async (load) => ({
  ...(await load<typeof import("../../utils/client")>()),
  connectToDaemon: vi.fn(),
}));
import { describe, expect, it, vi } from "vitest";
import { findAgentToArchive } from "./archive";

const agent = (id: string, title = "chat") => ({ id, title });
const entries = (...agents: ReturnType<typeof agent>[]) => ({
  entries: agents.map((a) => ({ agent: a })),
});

describe("findAgentToArchive", () => {
  // A stored chat that is not loaded, and not on the first page of the list: the daemon still finds it by ID.
  it("finds a stored chat by ID prefix without reading the list", async () => {
    const stored = agent("2a58a281-7f09-4ca3-96e0-97a18bd3deee", "old chat");
    const client = {
      fetchAgent: vi.fn(async () => ({ agent: stored })),
      fetchAgents: vi.fn(async () => entries(agent("other"))),
    };
    await expect(findAgentToArchive(client as never, "2a58a281")).resolves.toBe(stored);
    expect(client.fetchAgent).toHaveBeenCalledWith({ agentId: "2a58a281" });
    expect(client.fetchAgents).not.toHaveBeenCalled();
  });

  it("falls back to the list for a name the daemon does not know", async () => {
    const named = agent("abc-1", "Review chat");
    const client = {
      fetchAgent: vi.fn(async () => null),
      fetchAgents: vi.fn(async () => entries(named, agent("xyz-2", "Other"))),
    };
    await expect(findAgentToArchive(client as never, "Review chat")).resolves.toBe(named);
  });

  // 0.2.13 review: the daemon said the ID is ambiguous, and the CLI then archived the one match on the first page.
  it("does not archive when the daemon says the ID is ambiguous, or the lookup fails", async () => {
    const page = entries(agent("ab34-new", "Newer"));
    for (const message of [
      'Agent identifier "ab" is ambiguous (ab12-old, ab34-new)',
      "Connection lost",
    ]) {
      const client = {
        getLastServerInfoMessage: () => ({ features: { agentArchiveSafety: true } }),
        fetchAgent: vi.fn(async () => Promise.reject(new Error(message))),
        fetchAgents: vi.fn(async () => page),
      };
      await expect(findAgentToArchive(client as never, "ab")).rejects.toThrow(message);
      expect(client.fetchAgents).not.toHaveBeenCalled();
    }
  });

  it("returns null for an unknown chat", async () => {
    const client = {
      fetchAgent: vi.fn(async () => null),
      fetchAgents: vi.fn(async () => entries(agent("abc-1"))),
    };
    await expect(findAgentToArchive(client as never, "nope")).resolves.toBeNull();
  });
});

describe("restore command", () => {
  it.each(["archived", "active", "missing", "failure", "unsupported"])(
    "restores the same ID and closes the client for %s",
    async (kind) => {
      const client = {
        getLastServerInfoMessage: () => ({
          features: { agentArchiveSafety: kind !== "unsupported" },
        }),
        fetchAgent: vi.fn(async () =>
          kind === "missing"
            ? null
            : {
                agent: {
                  id: "fixture-original",
                  archivedAt: kind === "active" ? null : "2026-10-01T00:00:00Z",
                },
              },
        ),
        fetchAgents: vi.fn(async () => ({ entries: [] })),
        refreshAgent: vi.fn(async () => {
          if (kind === "failure") throw new Error("Native restore failed");
          return { agentId: "fixture-original" };
        }),
        close: vi.fn(async () => {}),
      };
      vi.mocked(connectToDaemon).mockResolvedValue(client as never);
      const operation = runRestoreCommand("fixture", {}, new Command());
      if (kind === "unsupported") await expect(operation).rejects.toThrow("Update the host");
      else if (kind === "missing" || kind === "failure")
        await expect(operation).rejects.toThrow(
          kind === "missing" ? "not found" : "Native restore failed",
        );
      else
        await expect(operation).resolves.toMatchObject({
          data: { agentId: "fixture-original", status: "restored" },
        });
      expect(client.close).toHaveBeenCalledOnce();
      if (kind === "active" || kind === "missing" || kind === "unsupported")
        expect(client.refreshAgent).not.toHaveBeenCalled();
      else
        expect(client.refreshAgent).toHaveBeenCalledWith("fixture-original", undefined, {
          restore: true,
        });
    },
  );
});
=======
import { describe, expect, it } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { archiveAgent, type AgentArchiveClient } from "./archive.js";
import { reloadAgent, type AgentReloadClient } from "./reload.js";
import { detachAgent, type AgentDetachClient } from "./detach.js";

function makeAgent(
  id: string,
  overrides: Partial<AgentSnapshotPayload> = {},
): AgentSnapshotPayload {
  return {
    id,
    title: null,
    status: "closed",
    archivedAt: null,
    ...overrides,
  } as AgentSnapshotPayload;
}

class FakeAgentClient implements AgentArchiveClient, AgentReloadClient, AgentDetachClient {
  readonly archived: string[] = [];
  readonly refreshed: string[] = [];
  readonly detached: string[] = [];
  readonly fetchAgentCalls: string[] = [];
  fetchAgentError: Error | null = null;
  closed = false;

  constructor(
    private readonly listed: AgentSnapshotPayload[],
    private readonly stored: AgentSnapshotPayload[] = listed,
  ) {}

  async fetchAgents() {
    return { entries: this.listed.map((agent) => ({ agent })), pageInfo: { nextCursor: null } };
  }

  async fetchAgent({ agentId }: { agentId: string }) {
    this.fetchAgentCalls.push(agentId);
    if (this.fetchAgentError) throw this.fetchAgentError;
    const found =
      this.stored.find((e) => e.id === agentId) ??
      this.stored.find((e) => e.id.startsWith(agentId)) ??
      this.stored.find((e) => e.title === agentId);
    return found ? { agent: found } : null;
  }

  async archiveAgent(agentId: string) {
    this.archived.push(agentId);
    return { archivedAt: "2026-11-15T00:00:00.000Z" };
  }

  async refreshAgent(agentId: string) {
    this.refreshed.push(agentId);
    return { agentId, timelineSize: 3 };
  }

  async detachAgent(agentId: string) {
    this.detached.push(agentId);
  }

  async close() {
    this.closed = true;
  }
}

describe("unlisted agent resolution", () => {
  const unlistedId = "9eac296c-4d60-4189-a0b5-ae71dd9c6ad9";
  const otherId = "c9a97e5d-4a92-4646-a016-53032146d0a1";

  it("archives an unlisted agent via fetchAgent without title collision", async () => {
    const unlisted = makeAgent(unlistedId, { title: "orphaned agent" });
    const other = makeAgent(otherId, { title: `worker ${unlistedId}` });
    const client = new FakeAgentClient([other], [other, unlisted]);
    const result = await archiveAgent(unlistedId.toUpperCase(), {}, async () => client);
    expect(result.data).toEqual({
      agentId: unlistedId,
      status: "archived",
      archivedAt: "2026-11-15T00:00:00.000Z",
    });
    expect(client.fetchAgentCalls).toEqual([unlistedId]);
    expect(client.archived).toEqual([unlistedId]);
    expect(client.closed).toBe(true);
  });

  it("enforces archived and running checks on fetched unlisted agents", async () => {
    const archivedClient = new FakeAgentClient(
      [],
      [makeAgent(unlistedId, { archivedAt: "2026-11-14T10:00:00.000Z" })],
    );
    await expect(archiveAgent(unlistedId, {}, async () => archivedClient)).rejects.toMatchObject({
      code: "AGENT_ALREADY_ARCHIVED",
    });
    const runningClient = new FakeAgentClient([], [makeAgent(unlistedId, { status: "running" })]);
    await expect(archiveAgent(unlistedId, {}, async () => runningClient)).rejects.toMatchObject({
      code: "AGENT_RUNNING",
    });
  });

  it("reloads and detaches unlisted agents via fetchAgent fallback", async () => {
    const unlisted = makeAgent(unlistedId, { title: "orphaned agent" });
    const reloadClient = new FakeAgentClient([], [unlisted]);
    const detachClient = new FakeAgentClient([], [unlisted]);
    expect((await reloadAgent(unlistedId, {}, async () => reloadClient)).data).toEqual({
      agentId: unlistedId,
      status: "reloaded",
      timelineSize: 3,
    });
    expect((await detachAgent(unlistedId, {}, async () => detachClient)).data).toEqual({
      agentId: unlistedId,
      status: "detached",
    });
  });

  it("does not accept another agent the daemon matched by title for a missing full id", async () => {
    const titled = makeAgent(otherId, { title: unlistedId });
    const client = new FakeAgentClient([], [titled]);
    await expect(archiveAgent(unlistedId, {}, async () => client)).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
    expect(client.archived).toEqual([]);
  });

  it("throws AGENT_NOT_FOUND when missing and propagates lookup errors", async () => {
    await expect(
      archiveAgent(unlistedId, {}, async () => new FakeAgentClient([], [])),
    ).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
    const failingClient = new FakeAgentClient([], []);
    failingClient.fetchAgentError = new Error('Agent identifier "9eac" is ambiguous');
    await expect(archiveAgent("9eac", {}, async () => failingClient)).rejects.toMatchObject({
      code: "ARCHIVE_FAILED",
    });
    await expect(detachAgent("9eac", {}, async () => failingClient)).rejects.toMatchObject({
      code: "DETACH_FAILED",
      message: 'Failed to detach agent: Agent identifier "9eac" is ambiguous',
    });
  });
});
>>>>>>> refs/remotes/upstream/tags/v0.18.0
