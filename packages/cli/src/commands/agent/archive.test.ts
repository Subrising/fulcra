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

  it("falls back to the list for a name, and when the lookup fails", async () => {
    const named = agent("abc-1", "Review chat");
    const client = {
      fetchAgent: vi.fn(async () => null),
      fetchAgents: vi.fn(async () => entries(named, agent("xyz-2", "Other"))),
    };
    await expect(findAgentToArchive(client as never, "Review chat")).resolves.toBe(named);
    const failing = { ...client, fetchAgent: vi.fn(async () => Promise.reject(new Error("down"))) };
    await expect(findAgentToArchive(failing as never, "abc")).resolves.toBe(named);
  });

  it("returns null for an unknown chat", async () => {
    const client = {
      fetchAgent: vi.fn(async () => null),
      fetchAgents: vi.fn(async () => entries(agent("abc-1"))),
    };
    await expect(findAgentToArchive(client as never, "nope")).resolves.toBeNull();
  });
});
