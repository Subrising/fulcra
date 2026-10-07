import { describe, expect, it } from "vitest";
import { chooseHomeComputer, hasMainAssistant } from "./home-computer";

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
  it("needs a readable directory with an assigned seat", () => {
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
