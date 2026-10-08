import { describe, expect, it } from "vitest";
import { chooseHomeComputer, hasMainAssistant, mergeMainAssistants } from "./home-computer";

const target = (serverId: string, untrusted = false) => ({ plugin: { serverId }, untrusted });
const mini = target("srv_mini"),
  book = target("srv_book"),
  oldBook = target("srv_book", true);

describe("chooseHomeComputer", () => {
  it("uses a saved choice, and asks for an update when that computer's plugin is not trusted", () => {
    expect(
      chooseHomeComputer([mini, book], { savedHost: "srv_book", mainAssistantHosts: null }),
    ).toEqual({ kind: "chosen", target: book, why: "saved" });
    expect(
      chooseHomeComputer([mini, oldBook], { savedHost: "srv_book", mainAssistantHosts: null }),
    ).toEqual({ kind: "update", serverId: "srv_book" });
    expect(chooseHomeComputer([mini], { savedHost: "srv_gone", mainAssistantHosts: null })).toEqual(
      {
        kind: "missing",
        serverId: "srv_gone",
      },
    );
  });

  it("picks the only trusted computer without asking", () => {
    expect(
      chooseHomeComputer([mini, oldBook], { savedHost: null, mainAssistantHosts: null }),
    ).toEqual({ kind: "chosen", target: mini, why: "only" });
  });

  it("picks the one computer running a main assistant, and asks only when that is ambiguous", () => {
    const both = [mini, book];
    expect(chooseHomeComputer(both, { savedHost: null, mainAssistantHosts: null })).toEqual({
      kind: "checking",
    });
    expect(
      chooseHomeComputer(both, { savedHost: null, mainAssistantHosts: new Set(["srv_book"]) }),
    ).toEqual({ kind: "chosen", target: book, why: "main-assistant" });
    expect(
      chooseHomeComputer(both, {
        savedHost: null,
        mainAssistantHosts: new Set(["srv_book", "srv_mini"]),
      }),
    ).toEqual({ kind: "ask", candidates: both });
    expect(chooseHomeComputer(both, { savedHost: null, mainAssistantHosts: new Set() })).toEqual({
      kind: "ask",
      candidates: both,
    });
  });

  it("says to update when no computer has a trusted plugin", () => {
    expect(
      chooseHomeComputer([target("srv_a", true), oldBook], {
        savedHost: null,
        mainAssistantHosts: new Set(["srv_book"]),
      }),
    ).toEqual({ kind: "update", serverId: "srv_book" });
  });
});

describe("hasMainAssistant", () => {
  it("needs a readable directory with an assigned role", () => {
    expect(
      hasMainAssistant({ available: true, primes: [{ state: "assigned", sessionId: "s" }] }),
    ).toBe(true);
    expect(
      hasMainAssistant({ available: true, primes: [{ state: "vacant", sessionId: null }] }),
    ).toBe(false);
    expect(
      hasMainAssistant({ available: false, primes: [{ state: "assigned", sessionId: "s" }] }),
    ).toBe(false);
    expect(hasMainAssistant(null)).toBe(false);
  });
});

describe("mergeMainAssistants (sidebar, Fulcra 0.2.8)", () => {
  const seat = (sessionId: string) => ({ seat: "main", sessionId });
  const found = (serverId: string, sessionId: string) => ({
    serverId,
    status: "found" as const,
    seat: seat(sessionId),
    node: null,
  });
  const base = {
    hostIds: ["srv_book", "srv_mini"],
    online: new Set(["srv_book", "srv_mini"]),
    remembered: {},
    homeServerId: "srv_book",
  };
  const ids = (shown: { serverId: string; offline: boolean }[]) =>
    shown.map((entry) => `${entry.serverId}${entry.offline ? ":offline" : ""}`);

  it("shows the Mini's main assistant in the MacBook app", () => {
    const shown = mergeMainAssistants({
      ...base,
      reads: [{ serverId: "srv_book", status: "none" }, found("srv_mini", "s-mini")],
    });
    expect(ids(shown)).toEqual(["srv_mini"]);
    expect(shown[0]).toMatchObject({ seatName: "main", sessionId: "s-mini", offline: false });
  });

  it("keeps an offline Mini's main assistant from memory, marked offline", () => {
    const shown = mergeMainAssistants({
      ...base,
      online: new Set(["srv_book"]),
      reads: [{ serverId: "srv_book", status: "none" }],
      remembered: { srv_mini: { seat: "main", sessionId: "s-mini" } },
    });
    expect(ids(shown)).toEqual(["srv_mini:offline"]);
    expect(shown[0]!.seat).toBeNull();
  });

  it("shows nothing when no computer has a main assistant", () => {
    expect(
      mergeMainAssistants({
        ...base,
        reads: [
          { serverId: "srv_book", status: "none" },
          { serverId: "srv_mini", status: "none" },
        ],
        remembered: { srv_mini: { seat: "main", sessionId: "old" } },
      }),
    ).toEqual([]);
  });

  it("shows both when two computers have one, the home computer first", () => {
    const shown = mergeMainAssistants({
      ...base,
      homeServerId: "srv_mini",
      reads: [found("srv_book", "s-book"), found("srv_mini", "s-mini")],
    });
    expect(ids(shown)).toEqual(["srv_mini", "srv_book"]);
  });

  it("uses memory while a connected computer's read is pending or failed, not marked offline", () => {
    const remembered = { srv_mini: { seat: "main", sessionId: "s-mini" } };
    expect(ids(mergeMainAssistants({ ...base, reads: null, remembered }))).toEqual(["srv_mini"]);
    expect(
      ids(
        mergeMainAssistants({
          ...base,
          reads: [{ serverId: "srv_mini", status: "failed" }],
          remembered,
        }),
      ),
    ).toEqual(["srv_mini"]);
  });

  it("ignores memory for a computer that is no longer in this app", () => {
    expect(
      mergeMainAssistants({
        ...base,
        hostIds: ["srv_book"],
        reads: [],
        remembered: { srv_mini: { seat: "main", sessionId: "s-mini" } },
      }),
    ).toEqual([]);
  });
});
