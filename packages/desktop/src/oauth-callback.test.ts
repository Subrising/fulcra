import { describe, expect, it } from "vitest";
import { findOAuthCallbackInArgv, isOAuthCallbackLink } from "./oauth-callback.js";

describe("fulcra sign-in return links", () => {
  it("accepts only fulcra://oauth/<flowId>", () => {
    expect(isOAuthCallbackLink("fulcra://oauth/flow_1234abcd?code=x&state=y")).toBe(true);
    for (const bad of [
      "orca://oauth/flow_1234abcd",
      "fulcra://h/server/agent/a",
      "fulcra://oauth/",
      "fulcra://oauth/a/b",
      "fulcra://oauth/short",
      "fulcra://user:pass@oauth/flow_1234abcd",
      "fulcra://oauth:99/flow_1234abcd",
      "fulcra://oauth/flow_1234abcd#fragment",
      "fulcra://oauth//flow_1234abcd/",
      "fulcra://oauth//flow_1234abcd",
      "fulcra://oauth/flow_1234abcd/",
      "fulcra://oauth/flow_1234abcd/?code=x",
      "https://oauth/flow_1234abcd",
      42,
    ]) {
      expect(isOAuthCallbackLink(bad)).toBe(false);
    }
  });

  it("finds the link among Electron launch arguments", () => {
    expect(
      findOAuthCallbackInArgv([
        "/Applications/Fulcra.app/Contents/MacOS/Fulcra",
        "--no-sandbox",
        "fulcra://oauth/flow_1234abcd?code=x",
      ]),
    ).toBe("fulcra://oauth/flow_1234abcd?code=x");
    expect(findOAuthCallbackInArgv(["Fulcra", "orca://h/s/agent/a"])).toBeNull();
  });
});
