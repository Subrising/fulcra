import { describe, expect, it, vi } from "vitest";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { adoptAgent, type AdoptClient } from "./adopt.js";

const GAG = "66c90f4a-6930-4de1-ae64-1caeb0380b7c";
const SHIP = "e84c026a-0000-4000-8000-000000000001";
const OLD = "11111111-1111-4111-8111-111111111111";
const agent = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: id.slice(0, 8),
  labels: {},
  runtimeInfo: { sessionId: `native-${id.slice(0, 8)}` },
  ...over,
});
function client(agents: ReturnType<typeof agent>[]) {
  const adoptAgentParent = vi.fn(async () => {});
  const fake: AdoptClient = {
    fetchAgents: async () => ({ entries: agents.map((a) => ({ agent: a })) }),
    adoptAgentParent,
  };
  return { fake, adoptAgentParent };
}

describe("agent adopt (FU-102)", () => {
  it("makes a lead the parent of an existing lead, with both native session ids and no old parent", async () => {
    const c = client([agent(GAG), agent(SHIP)]);
    const result = await adoptAgent(c.fake, "e84c026a", "66c90f4a");
    expect(result).toEqual({
      agentId: SHIP,
      parentAgentId: GAG,
      previousParentAgentId: null,
      status: "adopted",
    });
    expect(c.adoptAgentParent).toHaveBeenCalledWith({
      agentId: SHIP,
      parentAgentId: GAG,
      expectedParentAgentId: null,
      childNativeSessionId: "native-e84c026a",
      parentNativeSessionId: "native-66c90f4a",
    });
  });

  it("names the current parent as the expected one, so a changed relationship is refused by the host", async () => {
    const c = client([agent(GAG), agent(SHIP, { labels: { [PARENT_AGENT_ID_LABEL]: OLD } })]);
    const result = await adoptAgent(c.fake, SHIP, GAG);
    expect(result.previousParentAgentId).toBe(OLD);
    expect(c.adoptAgentParent.mock.calls[0]![0].expectedParentAgentId).toBe(OLD);
  });

  it("fails plainly for an unknown chat, the same chat, the current parent, or a chat with no session", async () => {
    const c = client([
      agent(GAG),
      agent(SHIP, { labels: { [PARENT_AGENT_ID_LABEL]: GAG } }),
      agent(OLD, { runtimeInfo: null }),
    ]);
    await expect(adoptAgent(c.fake, "nobody", GAG)).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
    await expect(adoptAgent(c.fake, GAG, "nobody")).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
    await expect(adoptAgent(c.fake, GAG, GAG)).rejects.toMatchObject({ code: "INVALID_OPTIONS" });
    await expect(adoptAgent(c.fake, SHIP, GAG)).rejects.toMatchObject({ code: "ALREADY_ADOPTED" });
    await expect(adoptAgent(c.fake, OLD, GAG)).rejects.toMatchObject({ code: "AGENT_NOT_LOADED" });
    expect(c.adoptAgentParent).not.toHaveBeenCalled();
  });

  it("reports the host's refusal as ADOPT_REFUSED with its message", async () => {
    const c = client([agent(GAG), agent(SHIP)]);
    c.adoptAgentParent.mockRejectedValueOnce(new Error("Current native owner admission required"));
    await expect(adoptAgent(c.fake, SHIP, GAG)).rejects.toMatchObject({
      code: "ADOPT_REFUSED",
      message: "Current native owner admission required",
    });
  });
});
