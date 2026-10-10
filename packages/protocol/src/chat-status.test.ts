import { describe, expect, it } from "vitest";
import { chatStatusWord, lastKnownStatusLine } from "./chat-status";

describe("chat status words", () => {
  it("names each chat-list status the same way for the sidebar and the Leads page", () => {
    expect(lastKnownStatusLine("running")).toBe("Working · last known");
    expect(lastKnownStatusLine("idle")).toBe("Idle · last known");
    expect(lastKnownStatusLine("initializing")).toBe("Starting · last known");
    expect(lastKnownStatusLine("error")).toBe("Needs attention · last known");
    expect(lastKnownStatusLine("closed")).toBe("Saved");
  });

  it("says the status is unknown when the chat list has none or an unknown value", () => {
    expect(lastKnownStatusLine(undefined)).toBe("Status unknown");
    expect(lastKnownStatusLine("weird")).toBe("Status unknown");
    expect(chatStatusWord("weird")).toBeNull();
  });
});
