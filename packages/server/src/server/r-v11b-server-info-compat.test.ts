// R-V11B B1 proof: an owner server_info from a V1.1b daemon is rejected by every already-released client parser.
// Base parser = packages/protocol/src/messages.ts at b1d1411ed (git archive into ./base-protocol, unmodified).
// The same enum-validated `permissions` field shipped in v0.7.0 and v0.8.0 (commit adf80a9fe), so released
// DaemonClient/app/Android builds and the V2 controller's pinned client 0.8.0 behave like the base parser.
import { expect, test } from "vitest";
import { VoiceAssistantWebSocketServer } from "./websocket-server.js";
import { OWNER_PERMISSIONS } from "./authorization/index.js";
import { parseServerInfoStatusPayload as parseCurrent } from "@getpaseo/protocol/messages";
import { parseServerInfoStatusPayload as parseReleased } from "./test-utils/frozen-v11a-permissions.js";

test("B1: a pre-V1.1b client must still accept an owner server_info (no Command Centre configured)", () => {
  // Real payload builder. The owner Session carries OWNER_PERMISSIONS whether or not any controller is installed.
  const server = Object.create(VoiceAssistantWebSocketServer.prototype);
  Object.assign(server, { serverId: "srv", daemonVersion: "0.9.1", workspaceLabelService: null });
  const payload = Reflect.get(server, "buildServerInfoStatusPayload").call(server, {
    getPermissions: () => [...OWNER_PERMISSIONS],
  });
  // The supplied proof required toContain here, contradicting its frozen-parser assertion.
  expect(payload.permissions).not.toContain("command-centre.manage");
  // The new client accepts it...
  expect(parseCurrent(payload)).not.toBeNull();
  // ...but a released client drops it, so DaemonClient never leaves "connecting" (daemon-client.ts:6827-6842)
  // and the app never records server info (session-context.tsx:569). Expected: accepted, as before V1.1b.
  expect(parseReleased(payload)).not.toBeNull();
});
