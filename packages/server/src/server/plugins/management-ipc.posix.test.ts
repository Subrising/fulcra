import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import pino from "pino";
import { expect, test } from "vitest";
import { PluginRuntime } from "./runtime.js";
import { loadTrustedPlugins } from "./trusted.js";
import { Session } from "../session.js";
import { SessionAuthorization, OWNER_PERMISSIONS } from "../authorization/index.js";

test("P6 real plugin subprocess receives request context and cannot retain it", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".cc-management-fixture-"));
  const bundles = path.join(root, "bundles");
  const directory = path.join(bundles, "orca-organization-next");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "paseo-plugin.json"),
    JSON.stringify({ id: "orca-organization-next", requirements: { paseo: ">=0.8.0" } }),
  );
  await writeFile(
    path.join(directory, "index.server.ts"),
    `
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
let retained;
const rpc = defineRpc({name:"manage", input:z.object({mode:z.string()}), output:z.string()});
export default function setup(server) {
 server.handle(rpc, async (input, ctx) => {
  if(input.mode === "late") { try { await retained.invoke({method:"list",input:null}); return "unexpected"; } catch { return "refused"; } }
  if(!ctx.management) return "unavailable";
  if(input.mode === "retain") { retained=ctx.management; return "retained"; }
  if(input.mode === "typed") { try { await ctx.management.invoke({method:"list",input:null}); return "unexpected"; } catch(error) { return error.code ?? "lost-code"; } }
  await ctx.management.invoke({method:"list",input:null}); return "ok";
 });
 return () => {};
}
`,
  );

  await writeFile(
    path.join(directory, "index.host.js"),
    `export const hostContract="1.1";export const calls=[];let uncertain=false;export function crash(){uncertain=true;} export default sdk=>sdk.managementBridge.register(async(...args)=>{if(uncertain)throw Object.assign(Error("owned child exited"),{code:"uncertain"});calls.push(args);return null;});`,
  );
  const host = await loadTrustedPlugins(bundles, path.join(root, "home"), [], {
    enabled: () => true,
    validate: (c) => c,
  });
  const { calls, crash } = await import(path.join(directory, "index.host.js"));

  const logger = pino({ level: "silent" });
  const runtime = new PluginRuntime(logger, "0.9.1", {
    trustedBundles: host,
    sessionHost: {
      async attachPluginSocket(_pluginId, socket) {
        const closed = new Promise<void>((resolve) => socket.once("close", resolve));
        socket.on("message", (data) => {
          if (typeof data !== "string" || JSON.parse(data).type !== "hello") return;
          socket.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "status",
                payload: {
                  status: "server_info",
                  serverId: "fixture",
                  hostname: null,
                  version: "0.9.1",
                  features: {},
                },
              },
            }),
          );
        });
        return { closed };
      },
    },
  });
  const messages: Array<{
    type: string;
    payload: { output?: unknown; error?: string; requestId?: string };
  }> = [];
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
    sessionLogger: logger,
    inflightRequests: 0,
    peakInflightRequests: 0,
    delivery: { request: (_source: unknown, _frame: unknown, run: () => unknown) => run() },
    dispatchIntegrationMessage: () => undefined,
    dispatchInboundMessage: (frame: unknown, source: object) =>
      Reflect.get(session, "dispatchPluginMessage").call(session, frame, source),
    emit: (message: (typeof messages)[number]) => messages.push(message),
  });
  const source = {};
  const call = async (mode: string) => {
    await session.handleMessage(
      {
        type: "plugin.rpc.invoke.request",
        requestId: mode,
        pluginId: "orca-organization-next",
        method: "manage",
        input: { mode },
      },
      source,
    );
    return messages.at(-1)?.payload.output;
  };
  try {
    await runtime.startPlugin("orca-organization-next", directory).catch((error) => {
      throw new Error(JSON.stringify(runtime.getLogs("orca-organization-next")), { cause: error });
    });
    expect(await call("anonymous")).toBe("unavailable");
    expect(calls).toHaveLength(0);
    session.admitManagementSource(source, {
      id: "owner",
      authentication: "daemon-password",
      deviceId: null,
    });
    expect(await call("invoke")).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(await call("retain")).toBe("retained");
    expect(await call("late")).toBe("refused");
    expect(calls).toHaveLength(1);
    crash();
    expect(await call("typed")).toBe("uncertain");
    await call("crash");
    expect(
      messages.find(
        (message) => message.type === "rpc_error" && message.payload.requestId === "crash",
      )?.payload.error,
    ).toMatch(/uncertain; do not replay/);
    expect(
      messages.find(
        (message) => message.type === "rpc_error" && message.payload.requestId === "crash",
      )?.payload.error,
    ).not.toMatch(/refused/i);
    Reflect.get(session, "authorization").replacePermissions(["daemon.manage"]);
    expect(await call("underprivileged")).toBe("unavailable");
    expect(calls).toHaveLength(1);
  } finally {
    await runtime.stopAll();
    host.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
