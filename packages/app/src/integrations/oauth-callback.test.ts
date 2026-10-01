import { describe, expect, it, vi } from "vitest";
import { forwardOAuthCallback, parseOAuthCallback } from "./oauth-callback";

const LINK = "fulcra://oauth/flow_1234abcd?code=fake-code&state=fake-state";
type Client = Parameters<typeof forwardOAuthCallback>[1][number];
const client = (
  ownedFlows: readonly string[],
  behaviour: () => Promise<unknown>,
): Client & { calls: unknown[] } => {
  const calls: unknown[] = [];
  return {
    calls,
    ownsSignInFlow: (flowId: string) => ownedFlows.includes(flowId),
    completeCredentialSignIn: vi.fn(async (input: unknown) => {
      calls.push(input);
      return behaviour();
    }) as never,
  };
};
const connected = (displayName: string) => async () => ({
  status: "connected",
  account: { displayName },
});

describe("fulcra sign-in return link forwarding", () => {
  it("recognises only fulcra://oauth/<flowId>", () => {
    expect(parseOAuthCallback(LINK)).toEqual({ url: LINK, flowId: "flow_1234abcd" });
    for (const bad of [
      "orca://oauth/flow_1234abcd",
      "fulcra://oauth/a/b",
      "fulcra://other/flow_1234abcd",
      "fulcra://oauth/flow_1234abcd#x",
      // Repeated or trailing slashes (R-E-12).
      "fulcra://oauth//flow_1234abcd/",
      "fulcra://oauth//flow_1234abcd",
      "fulcra://oauth/flow_1234abcd/",
      "fulcra://oauth/flow_1234abcd/?code=x",
      "not a url",
      null,
    ]) {
      expect(parseOAuthCallback(bad)).toBeNull();
    }
  });

  it("hands the unchanged link only to the host that started the flow", async () => {
    const before = client(["flow_other001"], connected("never"));
    const owner = client(["flow_1234abcd"], connected("Fake (GitHub)"));
    const after = client([], connected("never"));
    expect(await forwardOAuthCallback(LINK, [before, owner, after])).toEqual({
      status: "connected",
      displayName: "Fake (GitHub)",
    });
    expect(owner.calls).toEqual([{ input: { kind: "callback", url: LINK } }]);
    expect(before.calls).toEqual([]);
    expect(after.calls).toEqual([]);
  });

  it("sends the code nowhere when no host, or more than one, claims the flow (R-E-11)", async () => {
    const hosts = [client([], connected("never")), client(["flow_other001"], connected("never"))];
    expect(await forwardOAuthCallback(LINK, hosts)).toMatchObject({ status: "failed" });
    const twins = [
      client(["flow_1234abcd"], connected("never")),
      client(["flow_1234abcd"], connected("never")),
    ];
    expect(await forwardOAuthCallback(LINK, twins)).toMatchObject({ status: "failed" });
    expect(await forwardOAuthCallback(LINK, [])).toMatchObject({ status: "failed" });
    for (const host of [...hosts, ...twins]) expect(host.calls).toEqual([]);
  });

  it("does not try another host when the owner refuses, and never forwards other links", async () => {
    const refusing = client(["flow_1234abcd"], async () => {
      throw new Error("expired");
    });
    const bystander = client([], connected("never"));
    expect(await forwardOAuthCallback(LINK, [refusing, bystander])).toMatchObject({
      status: "failed",
    });
    expect(refusing.calls).toHaveLength(1);
    expect(bystander.calls).toEqual([]);
    const pending = client(["flow_1234abcd"], async () => ({
      status: "pending",
      retryAfterSeconds: 5,
    }));
    expect(await forwardOAuthCallback(LINK, [pending])).toEqual({ status: "pending" });
    const never = client(["flow_1234abcd"], connected("x"));
    for (const other of ["orca://h/s/agent/a", "fulcra://oauth//flow_1234abcd/?code=x"]) {
      expect(await forwardOAuthCallback(other, [never])).toMatchObject({ status: "failed" });
    }
    expect(never.calls).toEqual([]);
  });
});
