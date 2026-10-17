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
