import { describe, expect, it } from "vitest";
import { OAUTH_CALLBACK_LINK_MAX_LENGTH, parseOAuthCallbackLink } from "./oauth-callback-link";

const LINK = "fulcra://oauth/flow_1234abcd?code=fake-code&state=fake-state";

describe("fulcra sign-in return link shape", () => {
  it("accepts fulcra://oauth/<flowId>, with or without a query, and returns it unchanged", () => {
    expect(parseOAuthCallbackLink(LINK)).toEqual({ url: LINK, flowId: "flow_1234abcd" });
    expect(parseOAuthCallbackLink("fulcra://oauth/flow_1234abcd")).toEqual({
      url: "fulcra://oauth/flow_1234abcd",
      flowId: "flow_1234abcd",
    });
    const uuid = "0b6c8f3e-4a2d-4c1b-9e7f-1234567890ab";
    expect(parseOAuthCallbackLink(`fulcra://oauth/${uuid}?code=x`)?.flowId).toBe(uuid);
  });

  it("refuses every other shape", () => {
    for (const bad of [
      // Repeated and trailing slashes.
      "fulcra://oauth//flow_1234abcd",
      "fulcra://oauth//flow_1234abcd/",
      "fulcra://oauth/flow_1234abcd/",
      "fulcra://oauth/flow_1234abcd//",
      "fulcra://oauth/flow_1234abcd/?code=x",
      "fulcra://oauth///flow_1234abcd?code=x",
      "fulcra:///oauth/flow_1234abcd",
      // Dot segments that URL parsing would normalise away.
      "fulcra://oauth/x/../flow_1234abcd",
      "fulcra://oauth/./flow_1234abcd",
      "fulcra://oauth/flow_1234abcd/.",
      // Wrong scheme, host or path.
      "orca://oauth/flow_1234abcd",
      "FULCRA://oauth/flow_1234abcd",
      "fulcra://OAUTH/flow_1234abcd",
      "fulcra://other/flow_1234abcd",
      "https://oauth/flow_1234abcd",
      "fulcra:oauth/flow_1234abcd",
      "fulcra://oauth/",
      "fulcra://oauth",
      "fulcra://oauth/a/b",
      "fulcra://oauth/short",
      `fulcra://oauth/${"a".repeat(129)}`,
      "fulcra://oauth/flow%2F1234abcd",
      "fulcra://oauth/flow_1234abcd\\x",
      // Credentials, port, fragment, whitespace.
      "fulcra://user:pass@oauth/flow_1234abcd",
      "fulcra://oauth:99/flow_1234abcd",
      "fulcra://oauth/flow_1234abcd#fragment",
      "fulcra://oauth/flow_1234abcd?code=x#fragment",
      " fulcra://oauth/flow_1234abcd",
      "fulcra://oauth/flow_1234abcd?code=a b",
      `fulcra://oauth/flow_1234abcd?code=${"x".repeat(OAUTH_CALLBACK_LINK_MAX_LENGTH)}`,
      "not a url",
      42,
      null,
    ]) {
      expect(parseOAuthCallbackLink(bad), String(bad)).toBeNull();
    }
  });
});
