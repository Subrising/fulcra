import { afterEach, expect, test } from "vitest";
import {
  HUB_CLI_PROCESS_TIMEOUT_MS,
  HubRelationshipHarness,
} from "./test-utils/relationship-harness.js";

let relationship: HubRelationshipHarness | null = null;

afterEach(async () => {
  await relationship?.close();
  relationship = null;
});

// This is a three-process CLI integration contract, not a latency assertion.
// Each cold TypeScript CLI has its own deadline; include all three plus daemon/Git setup.
test(
  "the Hub CLI connects, reports status, and disconnects through the daemon",
  async () => {
    relationship = await HubRelationshipHarness.start();
    const connected = await relationship.runCli([
      "hub",
      "connect",
      "https://hub.test",
      "--api-key",
      "hub-contract-api-key:ceremony-token",
      "--permission",
      "hub.execute",
    ]);
    relationship.connectLatestSocket();

    const status = await relationship.runCli(["hub", "status"]);
    const enrollment = relationship.enrollmentAttempts()[0];
    const secret = relationship.relationshipFile()?.credential?.secret;
    const disconnected = await relationship.runCli(["hub", "disconnect"]);

    expect(connected.state).toBe("connecting");
    expect(status.state).toBe("connected");
    expect(relationship.loggableValues(status)).not.toContain(secret);
    expect(relationship.loggableValues(status)).not.toContain(enrollment.credentialVerifier);
    expect(relationship.loggableValues(status)).not.toContain(enrollment.token);
    expect(relationship.loggableValues(status)).not.toContain(enrollment.idempotencyKey);
    expect(disconnected.state).toBe("not_connected");
  },
  3 * HUB_CLI_PROCESS_TIMEOUT_MS + 30_000,
);
