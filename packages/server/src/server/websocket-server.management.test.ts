import { expect, test, vi } from "vitest";
import pino from "pino";
import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { ServerInfoStatusPayloadSchema } from "@getpaseo/protocol/messages";
import { PluginRuntime } from "./plugins/runtime.js";
import { SessionAuthorization } from "./authorization/index.js";

const hash = "$2b$12$OLxyuuP9uLK30Uzc4wQX0O6liuU/Q1t5P2b0Ebf36mULvpVK3DRZW";
test("Draft and catalog availability preserves permissions and requires a concrete guarded pager", () => {
  const runtime = new PluginRuntime(pino({ enabled: false }), "0.10.2");
  const authorization = new SessionAuthorization(["workspace.read"]);
  for (const pager of [undefined, runtime.catalogPaging]) {
    const server = Object.create(VoiceAssistantWebSocketServer.prototype);
    Object.assign(server, {
      serverId: "availability-fixture",
      daemonVersion: "0.10.2",
      pluginRuntime: { catalogPaging: () => pager },
    });
    const payload = ServerInfoStatusPayloadSchema.parse(
      Reflect.get(server, "buildServerInfoStatusPayload").call(
        server,
        { getPermissions: () => ["workspace.read"] },
        true,
      ),
    );
    expect(payload.features?.gitAiDrafts).toBe(true);
    expect(payload.features?.pluginCatalogPaging).toBe(pager ? true : undefined);
    expect(payload.permissions).toEqual(["workspace.read"]);
    expect(authorization.allowsPermission("workspace.write")).toBe(false);
    expect(authorization.allowsPermission("daemon.manage")).toBe(false);
  }
});
test("P6 only successful bearer validation creates owner authentication evidence", async () => {
  for (const password of [undefined, hash]) {
    const server = Object.create(VoiceAssistantWebSocketServer.prototype);
    const attach = vi.fn(async (..._arguments: unknown[]) => {});
    Object.assign(server, {
      logger: pino({ level: "silent" }),
      pendingPasswordChecks: 0,
      attachSocket: attach,
    });
    const close = vi.fn();
    const pause = vi.fn();
    const resume = vi.fn();
    await Reflect.get(server, "attachAuthenticatedSocket").call(
      server,
      { close, readyState: 1, pause, resume },
      {
        headers: { "sec-websocket-protocol": "paseo.bearer.correct-password" },
        socket: { remoteAddress: "127.0.0.1" },
      },
      password,
    );
    expect(close).not.toHaveBeenCalled();
    expect(pause).toHaveBeenCalledTimes(password ? 1 : 0);
    expect(resume).toHaveBeenCalledTimes(password ? 1 : 0);
    expect(server.pendingPasswordChecks).toBe(0);
    const admission = attach.mock.calls[0]?.[4];
    expect(admission).toMatchObject({ principalId: "owner" });
    if (password)
      expect(admission).toHaveProperty("authentication", {
        id: "owner",
        authentication: "daemon-password",
        deviceId: null,
      });
    else expect(admission).not.toHaveProperty("authentication");
  }
});
test("P6 failed bearer admission never reaches Session", async () => {
  const server = Object.create(VoiceAssistantWebSocketServer.prototype);
  const attach = vi.fn();
  const close = vi.fn();
  Object.assign(server, {
    logger: pino({ level: "silent" }),
    pendingPasswordChecks: 0,
    attachSocket: attach,
  });
  await Reflect.get(server, "attachAuthenticatedSocket").call(
    server,
    { close, readyState: 1, pause: vi.fn(), resume: vi.fn() },
    { headers: { "sec-websocket-protocol": "paseo.bearer.wrong" }, socket: {} },
    hash,
  );
  expect(close).toHaveBeenCalled();
  expect(attach).not.toHaveBeenCalled();
});
