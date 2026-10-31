import { describe, expect, test } from "vitest";
import { MAIN_ASSISTANT_ROLE, REPORTS_TO_LABEL, SEAT_LABEL } from "@getpaseo/protocol/agent-labels";
import { tellSenderUndelivered, undeliveredNoticeRecipient } from "./undelivered-notice.js";

const LANE = "3a4f9c83-e2c9-4a20-890b-93b699facd64";
const LEAD = "4c111479-b424-43e5-bd1e-6311db7276bc";
const MAIN = "88b1e035-23be-4d19-bcdc-2a09aa2dfc01";
const OTHER = "9dc065a8-c02e-43fb-bef5-3a22ae15b7d7";

interface Chat {
  id: string;
  labels: Record<string, string>;
  archivedAt?: string;
  config: { title: string };
}
const chat = (id: string, labels: Record<string, string> = {}): Chat => ({
  id,
  labels,
  config: { title: id.slice(0, 4) },
});

function deps(chats: Chat[]) {
  const byId = new Map(chats.map((c) => [c.id, c]));
  return {
    agentManager: { getAgent: (id: string) => byId.get(id), listAgents: () => chats },
    agentStorage: { getCached: (id: string) => byId.get(id) ?? null, listCached: () => chats },
    localServerId: "srv_mini",
  } as never;
}

describe("FU-622: an undelivered message always has a chat to tell", () => {
  const all = [
    chat(LANE, { [REPORTS_TO_LABEL]: LEAD }),
    chat(LEAD),
    chat(MAIN, { [SEAT_LABEL]: MAIN_ASSISTANT_ROLE }),
    chat(OTHER),
  ];

  test("another live chat that sent the message is told", () => {
    expect(
      undeliveredNoticeRecipient({ ...deps(all), sender: { agentId: OTHER }, targetId: LANE }),
    ).toBe(OTHER);
  });

  test("a script that sent as the receiver itself: the receiver's lead is told", () => {
    expect(
      undeliveredNoticeRecipient({ ...deps(all), sender: { agentId: LANE }, targetId: LANE }),
    ).toBe(LEAD);
  });

  test("no sender and no lead: the main assistant is told", () => {
    const chats = [chat(LANE), chat(MAIN, { [SEAT_LABEL]: MAIN_ASSISTANT_ROLE })];
    expect(undeliveredNoticeRecipient({ ...deps(chats), targetId: LANE })).toBe(MAIN);
  });

  test("a lead on another computer is skipped for the main assistant", () => {
    const chats = [
      chat(LANE, { [REPORTS_TO_LABEL]: `${LEAD}@srv_book` }),
      chat(MAIN, { [SEAT_LABEL]: MAIN_ASSISTANT_ROLE }),
    ];
    expect(
      undeliveredNoticeRecipient({ ...deps(chats), sender: { agentId: LANE }, targetId: LANE }),
    ).toBe(MAIN);
  });

  test("tellSenderUndelivered sends the self-send notice to the lead, not to the stuck receiver", () => {
    const sent: string[] = [];
    const base = deps(all) as unknown as { agentManager: Record<string, unknown> };
    const errors: unknown[] = [];
    tellSenderUndelivered({
      ...(base as never),
      agentManager: {
        ...base.agentManager,
        trustedPlugins: { daemon: async (run: () => Promise<void>) => run() },
        // held-sends keeps one queue per manager; hold() runs at once when idle, so record the target here.
        hasInFlightRun: () => false,
        subscribe: () => () => {},
      } as never,
      logger: {
        warn: (o: { told?: string }) => o.told && sent.push(o.told),
        error: (o: unknown) => errors.push(o),
        info: () => {},
      } as never,
      sender: { agentId: LANE },
      targetId: LANE,
      reason: "Final notice handoff timed out",
    });
    expect(sent[0]).toBe(LEAD);
    expect(errors).toEqual([]);
  });
});
