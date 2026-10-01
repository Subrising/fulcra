import { describe, expect, it } from "vitest";
import {
  PluginRequirementsSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages";

const account = {
  version: 1,
  id: "3f7c1f0e-0000-4000-8000-000000000001",
  connector: "github",
  site: null,
  displayName: "octocat (GitHub)",
  method: "device",
  scopes: ["repo"],
  state: "connected",
  expiresAt: null,
  lastCheckedAt: "2026-09-24T10:00:00.000Z",
  createdAt: "2026-09-24T10:00:00.000Z",
};

describe("host plugin API protocol", () => {
  it("parses the credential store RPCs as dotted request/response pairs", () => {
    for (const request of [
      { type: "credentials.list.request", requestId: "r1" },
      {
        type: "credentials.begin.request",
        requestId: "r2",
        connector: "jira",
        method: "token",
        site: "acme.atlassian.net",
      },
      {
        type: "credentials.complete.request",
        requestId: "r3",
        flowId: "f",
        input: { kind: "token", token: "t", email: "a@b.test" },
      },
      {
        type: "credentials.complete.request",
        requestId: "r4",
        input: { kind: "callback", url: "fulcra://oauth/f?code=c&state=s" },
      },
      { type: "credentials.reconnect.request", requestId: "r5", accountId: account.id },
      { type: "credentials.remove.request", requestId: "r6", accountId: account.id },
      { type: "plugin.notifications.list.request", requestId: "r7", limit: 20 },
    ]) {
      expect(SessionInboundMessageSchema.safeParse(request).success).toBe(true);
    }
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "credentials.complete.request",
        requestId: "r8",
        input: { kind: "password", value: "x" },
      }).success,
    ).toBe(false);

    for (const response of [
      {
        type: "credentials.list.response",
        payload: {
          requestId: "r1",
          accounts: [account],
          providers: [
            {
              connector: "github",
              label: "GitHub",
              selfHosted: false,
              requiresSite: false,
              requiresEmailForToken: false,
              methods: [
                { method: "device", status: "unavailable", reason: "no-client-id" },
                { method: "token", status: "available" },
              ],
              tokenHelp: {
                createUrl: "https://github.com/settings/tokens",
                scopes: ["repo"],
                note: "n",
              },
            },
          ],
        },
      },
      {
        type: "credentials.begin.response",
        payload: {
          requestId: "r2",
          flow: {
            flowId: "f",
            method: "device",
            expiresAt: "2026-09-24T10:10:00.000Z",
            userCode: "ABCD-1234",
            verifyUrl: "https://github.com/login/device",
          },
        },
      },
      {
        type: "credentials.complete.response",
        payload: { requestId: "r3", result: { status: "pending", retryAfterSeconds: 5 } },
      },
      {
        type: "credentials.complete.response",
        payload: { requestId: "r4", result: { status: "connected", account } },
      },
      { type: "credentials.remove.response", payload: { requestId: "r6", removed: true } },
      {
        type: "plugin.notifications.list.response",
        payload: {
          requestId: "r7",
          notifications: [
            {
              id: "n",
              pluginId: "orca-organization",
              key: "k",
              title: "Approve the release",
              urgency: "now",
              deepLink: null,
              createdAt: "2026-09-24T10:00:00.000Z",
              pushed: true,
            },
          ],
        },
      },
    ]) {
      expect(SessionOutboundMessageSchema.safeParse(response).success).toBe(true);
    }
  });

  it("keeps the new manifest requirements optional and additive", () => {
    expect(PluginRequirementsSchema.parse({ paseo: ">=0.8.0" })).toEqual({ paseo: ">=0.8.0" });
    expect(
      PluginRequirementsSchema.parse({
        paseo: ">=0.9.0",
        notify: true,
        credentials: ["github", "jira-dc"],
      }),
    ).toEqual({ paseo: ">=0.9.0", notify: true, credentials: ["github", "jira-dc"] });
    expect(PluginRequirementsSchema.safeParse({ credentials: ["GitHub"] }).success).toBe(false);
  });

  it("passes the generated outbound validator", async () => {
    const { validateWSOutboundMessage } = await import("./validation/ws-outbound.js");
    const result = validateWSOutboundMessage({
      type: "session",
      message: {
        type: "credentials.complete.response",
        payload: { requestId: "r", result: { status: "connected", account } },
      },
    });
    expect(result.success).toBe(true);
  });
});
