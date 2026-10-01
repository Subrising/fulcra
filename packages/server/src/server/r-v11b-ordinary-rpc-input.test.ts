// R-V11B M2 proof: the new management-field refusal applies to every plugin's RPC input, not only the controller,
// so an ordinary plugin whose own input schema has a top-level `context` (or `principal`, `authentication`,
// `management`, `invocationId`) field stops working, even on a Fulcra with no Command Centre.
import pino from "pino";
import { expect, test, vi } from "vitest";
import { Session } from "./session.js";
import { OWNER_PERMISSIONS, SessionAuthorization } from "./authorization/index.js";
import { TrustedPlugins } from "./plugins/trusted.js";

test("M2: ordinary plugin RPC input with a `context` field reaches the plugin as before", async () => {
  const trustedPlugins = new TrustedPlugins(); // no trusted bundle, never configured: no Command Centre
  trustedPlugins.initializeKnownAgents([]);
  const invokePluginRpc = vi.fn(async () => "ok");
  const messages: Array<{ type: string }> = [];
  const session = Object.create(Session.prototype) as Session;
  Object.assign(session, {
    managementSources: new Map(),
    managementInvocations: new Map(),
    authorization: new SessionAuthorization(OWNER_PERMISSIONS),
    agentManager: { trustedPlugins },
    pluginRuntime: { invokePluginRpc },
    sessionLogger: pino({ level: "silent" }),
    inflightRequests: 0,
    peakInflightRequests: 0,
    delivery: { request: (_s: unknown, _m: unknown, run: () => unknown) => run() },
    dispatchIntegrationMessage: () => undefined,
    dispatchInboundMessage: (frame: unknown, source: object) =>
      Reflect.get(session, "dispatchPluginMessage").call(session, frame, source),
    emit: (message: { type: string }) => messages.push(message),
  });
  await session.handleMessage(
    {
      type: "plugin.rpc.invoke.request",
      requestId: "r1",
      pluginId: "notes-plugin",
      method: "search",
      input: { context: "workspace", query: "todo" },
    },
    {},
  );
  expect(invokePluginRpc).toHaveBeenCalledOnce();
  expect(messages.map((m) => m.type)).toContain("plugin.rpc.invoke.response");
});
