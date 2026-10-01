// R-V11B M1 proof: "the targeted plugin is the registered bundled controller plugin" (§6) is checked only as an ID
// string. A trusted bundle registering the bridge makes ANY ordinary runtime plugin configured under that ID (for
// example `plugin.source.install.request` / `installDirectory({ id: "orca-organization-next" })` from a
// user-writable directory) receive an authenticated owner's management context over IPC. PluginRuntime keeps no
// source/bundle identity for a loaded plugin, and `enabled: () => boolean` cannot see which process is targeted.
import pino from "pino";
import { expect, test } from "vitest";
import { Session } from "./session.js";
import { OWNER_PERMISSIONS, SessionAuthorization } from "./authorization/index.js";
import { TrustedPlugins } from "./plugins/trusted.js";
import { PluginRuntime } from "./plugins/runtime.js";

test("M1: an ordinary plugin not proven to be the bundled controller gets no management context", async () => {
  const host = new TrustedPlugins({ enabled: () => true, validate: (command) => command });
  host.initializeKnownAgents([]);
  // Bundled trusted half: registers the bridge from the distribution directory.
  host.registerV11("orca-organization-next", true, (sdk) =>
    sdk.managementBridge.register(async () => null),
  );
  // Ordinary half actually serving RPC: here a user-installed look-alike (the runtime cannot tell the difference).
  const runtime = new PluginRuntime(pino({ level: "silent" }), "0.9.1");
  const delivered: unknown[] = [];
  const squatter = {
    id: "orca-organization-next",
    methods: new Set(["status"]),
    pending: new Map(),
    child: {
      send(
        message: { type: string; requestId?: string; management?: unknown },
        cb?: (e: null) => void,
      ) {
        cb?.(null);
        if (message.type === "invoke") {
          delivered.push(message.management);
          queueMicrotask(() =>
            Reflect.get(runtime, "handleChildMessage").call(runtime, squatter, {
              type: "result",
              requestId: message.requestId,
              output: null,
            }),
          );
        }
        return true;
      },
    },
  };
  Reflect.get(runtime, "plugins").set(squatter.id, squatter);
  const session = Object.create(Session.prototype) as Session;
  Object.assign(session, {
    managementSources: new Map(),
    managementInvocations: new Map(),
    authorization: new SessionAuthorization(OWNER_PERMISSIONS),
    agentManager: { trustedPlugins: host },
    pluginRuntime: {
      managementTarget: runtime.managementTarget.bind(runtime),
      invokePluginRpc: runtime.invoke.bind(runtime),
    },
    sessionLogger: pino({ level: "silent" }),
    emit: () => {},
  });
  const ownerSocket = {};
  session.admitManagementSource(ownerSocket, {
    id: "owner",
    authentication: "daemon-password",
    deviceId: null,
  });
  await Reflect.get(session, "dispatchPluginMessage").call(
    session,
    {
      type: "plugin.rpc.invoke.request",
      requestId: "r",
      pluginId: "orca-organization-next",
      method: "status",
      input: {},
    },
    ownerSocket,
  );
  host.close();
  // Expected per §6: no context unless the host has verified this runtime instance is the bundled controller.
  expect(delivered).toEqual([undefined]);
});
