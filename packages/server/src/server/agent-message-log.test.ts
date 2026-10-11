import { afterEach, describe, expect, test } from "vitest";
import {
  lastAgentMessageAt,
  noteAgentMessage,
  resetAgentMessageLogForTests,
} from "./agent-message-log.js";

afterEach(() => resetAgentMessageLogForTests());

describe("agent message log (FU-115)", () => {
  test("keeps the time of the last message from one chat to another, per direction", () => {
    noteAgentMessage("a", "b", 100);
    noteAgentMessage("a", "b", 200);
    expect(lastAgentMessageAt("a", "b")).toBe(200);
    expect(lastAgentMessageAt("b", "a")).toBeNull();
    expect(lastAgentMessageAt("a", "c")).toBeNull();
  });

  test("ignores a message to oneself and an empty ID, and drops the oldest entries past its cap", () => {
    noteAgentMessage("a", "a", 1);
    noteAgentMessage("", "b", 1);
    expect(lastAgentMessageAt("a", "a")).toBeNull();
    for (let i = 0; i < 2001; i += 1) noteAgentMessage(`s${i}`, "lead", i);
    expect(lastAgentMessageAt("s0", "lead")).toBeNull();
    expect(lastAgentMessageAt("s2000", "lead")).toBe(2000);
  });
});
