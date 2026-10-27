import { describe, expect, it } from "vitest";
import {
  checkReportingLine,
  decideOutboundSend,
  checkPromptLine,
  decideSend,
  findRoleHolder,
  type LineStore,
  resolveLineRef,
  type LineAgent,
} from "./reporting-lines.js";

// Fulcra 0.2.8 reporting lines: worker -> lead -> main assistant -> the owner.

const MINI = "srv_mini";
const BOOK = "srv_book";
const agent = (id: string, title: string, labels: Record<string, string> = {}): LineAgent => ({
  id,
  title,
  labels,
});
const main = agent("main-1", "Main assistant", { "fulcra.reports-to": "owner" });
const lead = agent("lead-1", "Fulcra lead", { "fulcra.reports-to": "main-1" });
const otherLead = agent("lead-2", "FMC lead", { "fulcra.reports-to": "main-1" });
const worker = agent("work-1", "Review", { "fulcra.reports-to": "lead-1" });
const otherWorker = agent("work-2", "Talkboard", { "fulcra.reports-to": "lead-2" });
const holderId = (agents: LineAgent[]) => {
  const holder = findRoleHolder(agents, "main-assistant");
  return holder && "id" in holder ? holder.id : null;
};
const byId = new Map([main, lead, otherLead, worker, otherWorker].map((a) => [a.id, a]));

function send(from: LineAgent, to: LineAgent) {
  const parent = from.labels?.["fulcra.reports-to"];
  return checkReportingLine({
    sender: { agentId: from.id },
    senderAgent: from,
    target: to,
    senderParent: parent ? (byId.get(parent) ?? null) : null,
    localServerId: MINI,
  });
}

describe("reporting lines", () => {
  it("keeps the same one-level refusal for a worker and a remote Main assistant", async () => {
    const store: LineStore = {
      get: async (id) => byId.get(id) ?? null,
      list: async () => [...byId.values()],
    };
    const decision = await decideOutboundSend(store, {
      senderId: worker.id,
      targetId: main.id,
      localServerId: MINI,
    });
    expect(decision).toMatchObject({
      inboundOnly: true,
      refusal: "Send this to your lead, Fulcra lead (lead-1).",
    });
    expect(
      checkReportingLine({
        sender: {
          agentId: worker.id,
          serverId: MINI,
          inboundOnly: true,
          refusal: decision.refusal,
        },
        senderAgent: null,
        target: main,
        senderParent: null,
        localServerId: BOOK,
        mainAssistantId: main.id,
      }),
    ).toEqual(send(worker, main));
  });
  it("refuses an inbound-only worker at a remote Main assistant", () => {
    expect(
      checkReportingLine({
        sender: {
          agentId: worker.id,
          serverId: MINI,
          inboundOnly: true,
          refusal: "Send this to your lead, Fulcra lead (lead-1).",
        },
        senderAgent: null,
        target: main,
        senderParent: null,
        localServerId: BOOK,
        mainAssistantId: main.id,
      }),
    ).toEqual(send(worker, main));
  });
  it("allows only destination-owned children or links after an outbound refusal", () => {
    const sender = { agentId: worker.id, serverId: MINI, inboundOnly: true as const };
    for (const labels of [
      { "fulcra.reports-to": `${worker.id}@${MINI}` },
      { "fulcra.direct-link": `${worker.id}@${MINI}` },
    ]) {
      expect(
        checkReportingLine({
          sender,
          senderAgent: null,
          target: agent("remote-child", "Child", labels),
          senderParent: null,
          localServerId: BOOK,
        }).allowed,
      ).toBe(true);
    }
  });
  it("checks source lines, qualified hosts, direct links, roles and unknown senders", async () => {
    const check = async (labels: Record<string, string>) => {
      const source = agent("source", "Source", labels);
      return decideOutboundSend(
        { get: async (id) => (id === source.id ? source : null), list: async () => [source] },
        { senderId: source.id, targetId: main.id, localServerId: MINI },
      );
    };
    expect(await check({})).toEqual({ inboundOnly: false });
    expect(await check({ "fulcra.reports-to": main.id })).toEqual({ inboundOnly: false });
    expect(await check({ "fulcra.reports-to": `${main.id}@${BOOK}` })).toMatchObject({
      inboundOnly: false,
      outboundServerOnly: BOOK,
      outboundParent: `${main.id}@${BOOK}`,
    });
    expect(await check({ "fulcra.reports-to": "lead-1", "fulcra.direct-link": main.id })).toEqual({
      inboundOnly: false,
    });
    expect(await check({ "fulcra.reports-to": "role:main-assistant" })).toMatchObject({
      inboundOnly: false,
      outboundMainOnly: true,
    });
    expect(
      await check({ "fulcra.reports-to": "role:main-assistant", "fulcra.direct-link": main.id }),
    ).toEqual({ inboundOnly: false });
    await expect(
      decideOutboundSend(
        { get: async () => null, list: async () => [] },
        { senderId: "missing", targetId: main.id },
      ),
    ).rejects.toThrow("not on this computer");
    for (const restriction of [{ outboundMainOnly: true as const }, { outboundServerOnly: MINI }]) {
      expect(
        checkReportingLine({
          sender: { agentId: worker.id, serverId: MINI, ...restriction },
          senderAgent: null,
          target: main,
          senderParent: null,
          localServerId: BOOK,
          mainAssistantId: restriction.outboundMainOnly ? "other-main" : main.id,
        }).allowed,
      ).toBe(false);
    }
  });
  it("FU-402 lets a worker on another computer reach its own lead here, and nobody else", async () => {
    const bookWorker = agent("book-work", "Release", { "fulcra.reports-to": `${lead.id}@${MINI}` });
    const source: LineStore = {
      get: async (id) => (id === bookWorker.id ? bookWorker : null),
      list: async () => [bookWorker],
    };
    const relayed = async (targetId: string) => ({
      agentId: bookWorker.id,
      serverId: BOOK,
      ...(await decideOutboundSend(source, {
        senderId: bookWorker.id,
        targetId,
        localServerId: BOOK,
      })),
    });
    const atMini = async (target: LineAgent) =>
      checkReportingLine({
        sender: await relayed(target.id),
        senderAgent: null,
        target,
        senderParent: null,
        localServerId: MINI,
        mainAssistantId: main.id,
      });
    expect(await atMini(lead)).toEqual({ allowed: true, why: "parent" });
    expect((await atMini(otherLead)).allowed).toBe(false);
    // The claim names the source's own line host; another host cannot use it.
    expect(
      checkReportingLine({
        sender: await relayed(lead.id),
        senderAgent: null,
        target: lead,
        senderParent: null,
        localServerId: "srv_pc",
        mainAssistantId: main.id,
      }).allowed,
    ).toBe(false);
    // The mark names one lead on one host. Another target or a missing host check is refused.
    for (const forged of [
      { outboundServerOnly: MINI, outboundParent: `${otherLead.id}@${MINI}` },
      { outboundServerOnly: MINI, outboundParent: `${lead.id}@srv_pc` },
      { outboundParent: `${lead.id}@${MINI}` },
    ])
      expect(
        checkReportingLine({
          sender: { agentId: bookWorker.id, serverId: BOOK, ...forged },
          senderAgent: null,
          target: lead,
          senderParent: null,
          localServerId: MINI,
          mainAssistantId: main.id,
        }).allowed,
      ).toBe(false);
    // Without the source's confirmation the old refusal stays.
    expect(
      checkReportingLine({
        sender: { agentId: bookWorker.id, serverId: BOOK },
        senderAgent: null,
        target: lead,
        senderParent: null,
        localServerId: MINI,
        mainAssistantId: main.id,
      }),
    ).toMatchObject({ allowed: false, reason: expect.stringContaining("From another computer") });
  });

  it("allows a send up to the parent and down to the chat's own children", () => {
    expect(send(worker, lead)).toEqual({ allowed: true, why: "parent" });
    expect(send(lead, worker)).toEqual({ allowed: true, why: "child" });
    expect(send(lead, main)).toEqual({ allowed: true, why: "parent" });
    expect(send(main, lead)).toEqual({ allowed: true, why: "child" });
  });

  it("refuses a send outside the line and names the right recipient", () => {
    expect(send(worker, main)).toEqual({
      allowed: false,
      reason: "Send this to your lead, Fulcra lead (lead-1).",
    });
    expect(send(worker, otherWorker)).toEqual({
      allowed: false,
      reason: "Send this to your lead, Fulcra lead (lead-1).",
    });
    expect(send(lead, otherWorker).allowed).toBe(false);
    expect(send(main, worker)).toEqual({
      allowed: false,
      reason: "A main assistant sends to its own leads. Ask the owner to add a direct link.",
    });
  });

  it("allows the one direct link a lead set, in both directions", () => {
    const linked = agent("work-3", "Designer", {
      "fulcra.reports-to": "lead-1",
      "fulcra.direct-link": "work-2",
    });
    expect(send(linked, otherWorker)).toEqual({ allowed: true, why: "direct link" });
    expect(send(otherWorker, linked)).toEqual({ allowed: true, why: "direct link" });
  });

  it("does not refuse a chat with no recorded line, and follows a created chat's parent", () => {
    expect(send(agent("loose", "Scratch"), main)).toEqual({
      allowed: true,
      why: "no line recorded",
    });
    const sub = agent("sub-1", "Subagent", { "paseo.parent-agent-id": "lead-1" });
    expect(send(sub, lead)).toEqual({ allowed: true, why: "parent" });
    expect(send(sub, main).allowed).toBe(false);
  });

  it("keeps a lead on another computer able to reach the main assistant and its own chats here", () => {
    const remote = (to: LineAgent) =>
      checkReportingLine({
        sender: { agentId: "book-lead", serverId: BOOK },
        senderAgent: null,
        target: to,
        senderParent: null,
        localServerId: MINI,
      });
    expect(remote(main)).toEqual({ allowed: true, why: "main assistant" });
    expect(
      remote(agent("w", "Alpha helper", { "fulcra.reports-to": `book-lead@${BOOK}` })),
    ).toEqual({ allowed: true, why: "child" });
    expect(remote(worker)).toEqual({
      allowed: false,
      reason:
        "From another computer, a chat can send only to its own chats here and to the main assistant.",
    });
  });

  it("treats a stamp with this computer's own server id as a local chat", () => {
    expect(
      checkReportingLine({
        sender: { agentId: "work-1", serverId: MINI },
        senderAgent: worker,
        target: lead,
        senderParent: lead,
        localServerId: MINI,
      }),
    ).toEqual({ allowed: true, why: "parent" });
  });

  it("follows a lead's line to whichever chat holds the main assistant role now", () => {
    const roleLead = agent("lead-9", "Mac operations lead", {
      "fulcra.reports-to": "role:main-assistant",
    });
    const oldMain = {
      ...agent("main-old", "Old main assistant", { "fulcra.seat": "main-assistant" }),
      updatedAt: "2026-10-01",
    };
    const newMain = agent("main-new", "Main assistant", { "fulcra.reports-to": "owner" });
    const lineTo = (to: LineAgent, holders: LineAgent[]) => {
      const mainAssistantId = holderId(holders);
      return checkReportingLine({
        sender: { agentId: roleLead.id },
        senderAgent: roleLead,
        target: to,
        senderParent: holders.find((h) => h.id === mainAssistantId) ?? null,
        localServerId: MINI,
        mainAssistantId,
      });
    };
    // Before the move: the old holder receives; the new chat is not yet the lead's parent.
    expect(lineTo(oldMain, [oldMain, newMain])).toEqual({ allowed: true, why: "parent" });
    expect(lineTo(newMain, [oldMain, newMain]).allowed).toBe(false);
    // Move the role: the old holder is archived and the new chat carries the role label. No lead changes.
    const moved = [
      { ...oldMain, archivedAt: "2026-10-09" },
      { ...newMain, labels: { ...newMain.labels, "fulcra.seat": "main-assistant" } },
    ];
    expect(resolveLineRef("role:main-assistant", holderId(moved))).toBe("main-new");
    expect(lineTo(moved[1]!, moved)).toEqual({ allowed: true, why: "parent" });
    expect(lineTo(oldMain, moved)).toEqual({
      allowed: false,
      reason: "Send this to the main assistant, Main assistant (main-new).",
    });
    // And the new holder reaches the lead as its child.
    expect(
      checkReportingLine({
        sender: { agentId: "main-new" },
        senderAgent: moved[1]!,
        target: roleLead,
        senderParent: null,
        localServerId: MINI,
        mainAssistantId: "main-new",
      }),
    ).toEqual({ allowed: true, why: "child" });
  });

  it("does not guess between two holders, ignores archived ones, and says so when no chat holds the role", () => {
    const a = { ...agent("a", "A", { "fulcra.seat": "main-assistant" }), updatedAt: "2026-10-01" };
    const b = { ...agent("b", "B", { "fulcra.seat": "main-assistant" }), updatedAt: "2026-10-08" };
    expect(findRoleHolder([a, b], "main-assistant")).toEqual({ ambiguous: true });
    expect(findRoleHolder([{ ...b, archivedAt: "x" }, a], "main-assistant")).toEqual({ id: "a" });
    expect(findRoleHolder([], "main-assistant")).toBeNull();
    const roleLead = agent("lead-9", "Lead", { "fulcra.reports-to": "role:main-assistant" });
    expect(
      checkReportingLine({
        sender: { agentId: roleLead.id },
        senderAgent: roleLead,
        target: worker,
        senderParent: null,
        localServerId: MINI,
        mainAssistantId: null,
      }),
    ).toEqual({
      allowed: false,
      reason: `${worker.title} (${worker.id.slice(0, 8)}) does not report to you, so you cannot send to it. Your line is the main assistant, and no chat on this computer holds that role now. Ask the owner to add a direct link.`,
    });
  });

  it("lets a chat on another computer reach the current role holder", () => {
    const holder = agent("main-new", "Main assistant", { "fulcra.seat": "main-assistant" });
    expect(
      checkReportingLine({
        sender: { agentId: "book-lead", serverId: BOOK },
        senderAgent: null,
        target: holder,
        senderParent: null,
        localServerId: MINI,
        mainAssistantId: "main-new",
      }),
    ).toEqual({ allowed: true, why: "main assistant" });
  });

  it("follows the parent the controller recorded on a chat it created", () => {
    const made = agent("made-1", "Worker", { "fulcra.parent-session": "lead-1" });
    expect(send(made, lead)).toEqual({ allowed: true, why: "parent" });
    expect(send(made, main).allowed).toBe(false);
  });

  describe("FU-485 a chat sends to a chat it created", () => {
    const made = agent("made-2", "Partner", {
      "fulcra.reports-to": "owner",
      "paseo.parent-agent-id": "lead-1",
    });
    const direct = (from: LineAgent, to: LineAgent, serverId?: string) =>
      checkReportingLine({
        sender: { agentId: from.id, ...(serverId ? { serverId } : {}) },
        senderAgent: serverId ? null : from,
        target: to,
        senderParent: null,
        localServerId: MINI,
      });

    it("allows a send to a child by parent id when its reporting line names another chat", () => {
      expect(direct(lead, made)).toEqual({ allowed: true, why: "child" });
      expect(direct(otherLead, made).allowed).toBe(false);
    });

    it("allows the controller's parent label too, and a qualified parent from another computer", () => {
      const byController = agent("made-3", "Worker", {
        "fulcra.reports-to": "owner",
        "fulcra.parent-session": "lead-1",
      });
      expect(direct(lead, byController)).toEqual({ allowed: true, why: "child" });
      const remoteChild = agent("made-4", "Worker", {
        "fulcra.reports-to": "owner",
        "paseo.parent-agent-id": `lead-1@${BOOK}`,
      });
      expect(direct(lead, remoteChild, BOOK)).toEqual({ allowed: true, why: "child" });
    });

    it("still refuses a held child", () => {
      const held = agent("made-5", "Partner", {
        "paseo.parent-agent-id": "lead-1",
        "fulcra.reports-to": "owner",
        "fulcra.hold": "done",
      });
      expect(direct(lead, held)).toMatchObject({ allowed: false });
    });

    it("keeps a three-level chain: a lead sends down to what it started, a worker only to its lead", () => {
      const gag = agent("gag-1", "Gag games lead", { "fulcra.reports-to": "main-1" });
      const shipIt = agent("ship-1", "Ship It lead", {
        "fulcra.reports-to": "main-1",
        "paseo.parent-agent-id": "gag-1",
      });
      const shipWorker = agent("ship-w", "Ship It worker", {
        "fulcra.reports-to": "main-1",
        "paseo.parent-agent-id": "ship-1",
      });
      const chain = new Map<string, LineAgent>();
      for (const a of [main, gag, shipIt, shipWorker]) chain.set(a.id, a);
      const run = (from: LineAgent, to: LineAgent) =>
        checkReportingLine({
          sender: { agentId: from.id },
          senderAgent: from,
          target: to,
          senderParent: chain.get(from.labels?.["fulcra.reports-to"] ?? "") ?? null,
          localServerId: MINI,
        });
      expect(run(shipIt, shipWorker)).toEqual({ allowed: true, why: "child" });
      expect(run(gag, shipIt)).toEqual({ allowed: true, why: "child" });
      expect(run(shipWorker, gag).allowed).toBe(false);
      expect(run(shipWorker, shipIt).allowed).toBe(false);
    });
  });

  describe("a prompt through the Paseo MCP tool", () => {
    const store = (agents: LineAgent[]): LineStore => ({
      get: async (id) => agents.find((a) => a.id === id) ?? null,
      list: async () => agents,
    });
    const seated = { ...main, labels: { ...main.labels, "fulcra.seat": "main-assistant" } };
    const all = [seated, lead, otherLead, worker, otherWorker];

    it("checks the calling chat's line, as a stamped CLI send is checked", async () => {
      await expect(checkPromptLine(store(all), worker.id, lead.id)).resolves.toBe(lead.id);
      await expect(checkPromptLine(store(all), worker.id, main.id)).rejects.toThrow(
        "Send this to your lead, Fulcra lead (lead-1).",
      );
    });

    it("never refuses the owner's own MCP client, which has no calling chat", async () => {
      await expect(checkPromptLine(store(all), undefined, otherWorker.id)).resolves.toBe(
        otherWorker.id,
      );
    });

    it("reads role:main-assistant as the holder, and refuses when none or two chats hold it", async () => {
      await expect(checkPromptLine(store(all), lead.id, "role:main-assistant")).resolves.toBe(
        main.id,
      );
      await expect(
        checkPromptLine(store([main, lead]), lead.id, "role:main-assistant"),
      ).rejects.toThrow("No chat is the main assistant now. Ask the owner to set one.");
      const second = { ...otherLead, labels: { "fulcra.seat": "main-assistant" } };
      await expect(
        checkPromptLine(store([seated, second, lead]), lead.id, "role:main-assistant"),
      ).rejects.toThrow("Two chats are marked as the main assistant.");
    });
  });

  it("refuses a local stamp that names no chat here, instead of reading it as no line", async () => {
    const store: LineStore = {
      get: async (id) => [main, lead].find((a) => a.id === id) ?? null,
      list: async () => [main, lead],
    };
    await expect(decideSend(store, { agentId: "made-up" }, main.id, MINI)).resolves.toEqual({
      allowed: false,
      reason: "This send names a chat that is not on this computer.",
    });
    await expect(
      decideSend(store, { agentId: "book-lead", serverId: "srv_book" }, main.id, MINI),
    ).resolves.toEqual({ allowed: true, why: "main assistant" }); // a remote sender has no record here
    await expect(
      decideSend(store, { agentId: "book-lead", serverId: "srv_book" }, lead.id, MINI),
    ).resolves.toMatchObject({ allowed: false });
  });
});

it("FU-164 refuses new work from the parent until the done hold is cleared", async () => {
  const held = agent("work-held", "Completed worker", {
    "fulcra.reports-to": lead.id,
    "fulcra.hold": "done",
  });
  const store: LineStore = {
    get: async (id) => (id === held.id ? held : (byId.get(id) ?? null)),
    list: async () => [...byId.values(), held],
  };
  expect(send(lead, held)).toMatchObject({
    allowed: false,
    reason: expect.stringContaining("Clear fulcra.hold"),
  });
  await expect(checkPromptLine(store, lead.id, held.id)).rejects.toThrow("Clear fulcra.hold");
  expect(
    await decideSend(store, { agentId: lead.id, serverId: MINI }, held.id, MINI),
  ).toMatchObject({ allowed: false });
  expect(await checkPromptLine(store, undefined, held.id)).toBe(held.id);
  held.labels!["fulcra.hold"] = "";
  expect(await checkPromptLine(store, lead.id, held.id)).toBe(held.id);
});

it("FU-164 applies the done hold to a remote parent and a role parent", () => {
  const held = agent("work-held", "Completed worker", {
    "fulcra.reports-to": `lead-remote@${BOOK}`,
    "fulcra.hold": "done",
  });
  expect(
    checkReportingLine({
      sender: { agentId: "lead-remote", serverId: BOOK },
      senderAgent: null,
      target: held,
      senderParent: null,
      localServerId: MINI,
    }),
  ).toMatchObject({ allowed: false });
  held.labels!["fulcra.reports-to"] = "role:main-assistant";
  expect(
    checkReportingLine({
      sender: { agentId: "holder" },
      senderAgent: agent("holder", "Main"),
      target: held,
      senderParent: null,
      localServerId: MINI,
      mainAssistantId: "holder",
    }),
  ).toMatchObject({ allowed: false });
});
