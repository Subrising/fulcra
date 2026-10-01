import { expect, test } from "vitest";
import {
  ServerInfoStatusPayloadSchema,
  HubRelationshipStatusSchema,
  DAEMON_PERMISSIONS,
} from "./messages.js";
import { permissionsForWire } from "./permission-wire.js";
import {
  FrozenServerInfo,
  FrozenHubStatus,
} from "../../server/src/server/test-utils/frozen-v11a-permissions.js";
const info = {
  status: "server_info",
  serverId: "fixture",
  hostname: "fixture",
  version: "0.9.1",
  permissions: [...DAEMON_PERMISSIONS],
};
const hub = {
  state: "connected",
  daemonId: "fixture",
  hubOrigin: null,
  permissions: [...DAEMON_PERMISSIONS],
  connectedAt: null,
  lastError: null,
};
test("B1 owner server_info and Hub status retain released wire compatibility", () => {
  expect(
    FrozenServerInfo.safeParse({
      ...info,
      permissions: permissionsForWire(info.permissions, false),
    }).success,
  ).toBe(true);
  expect(
    FrozenHubStatus.safeParse({ ...hub, permissions: permissionsForWire(hub.permissions, false) })
      .success,
  ).toBe(true);
  expect(permissionsForWire(info.permissions, true)).toContain("command-centre.manage");
  expect(info.permissions).toContain("command-centre.manage");
});
test("future clients ignore unknown status permissions without losing known permissions", () => {
  expect(
    ServerInfoStatusPayloadSchema.parse({
      ...info,
      permissions: [...info.permissions, "future.permission"],
    }).permissions,
  ).toEqual(info.permissions);
  expect(
    HubRelationshipStatusSchema.parse({
      ...hub,
      permissions: [...hub.permissions, "future.permission"],
    }).permissions,
  ).toEqual(hub.permissions);
});
