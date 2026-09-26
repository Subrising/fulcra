import type { PluginServerContext } from "@getpaseo/plugin/server";

// A harmless read per connector. The host attaches the credential; this code never sees it.
const IDENTITY_PATHS: Record<string, string> = {
  github: "/user",
  jira: "/rest/api/3/myself",
  "jira-dc": "/rest/api/2/myself",
  bitbucket: "/2.0/user",
  "bitbucket-dc": "/rest/api/1.0/application-properties",
};

export function createCheckAccount(server: PluginServerContext) {
  return async (input: { accountId: string; connector: string }) => {
    if (!server.credentials) throw new Error("This host has no shared credential store");
    const path = IDENTITY_PATHS[input.connector];
    if (!path) throw new Error(`No check for ${input.connector}`);
    const response = await server.credentials.request(input.accountId, input.connector, {
      method: "GET",
      path,
    });
    return { connector: input.connector, status: response.status };
  };
}

export function createSendTestNotification(server: PluginServerContext) {
  return async (input: { urgency: "now" | "today" | "fyi" }) => {
    if (!server.notify) throw new Error("This host has no plugin notifications");
    return server.notify({
      key: `integrations-dev:${input.urgency}:${Date.now()}`,
      title: `Integrations test notification (${input.urgency})`,
      urgency: input.urgency,
    });
  };
}
