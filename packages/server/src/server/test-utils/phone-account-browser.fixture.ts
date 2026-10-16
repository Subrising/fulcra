// This process owns only a scratch daemon, local relay, and test provider.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createPhoneAccountFixture, startPhoneAccountRelay } from "./phone-account-fixture.js";
import { DaemonClient } from "./daemon-client.js";
import { DeviceRegistry } from "../pairing/device-registry.js";
import { generateLocalPairingOffer } from "../pairing-offer.js";
import { parseConnectionOfferFromUrl } from "@getpaseo/protocol/connection-offer";
import { buildRelayWebSocketUrl } from "@getpaseo/protocol/daemon-endpoints";
import { generateKeyPair, exportPublicKey, exportSecretKey } from "@getpaseo/client/relay-v3";
import {
  addAccount,
  assign,
  readAccounts,
} from "../../../../../control/orca-organization/server/accounts.mjs";

const relay = await startPhoneAccountRelay();
const f = await createPhoneAccountFixture(relay.endpoint);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await f.close();
  relay.close();
  process.disconnect?.();
}
process.on("message", (message: { type?: string }) => {
  if (message.type === "stop") void close();
  if (message.type === "inspect")
    void readFile(path.join(f.daemon.paseoHome, "accounts-audit.json"), "utf8").then((raw) => {
      const pool = readAccounts(f.poolRoot);
      return process.send?.({
        type: "inspection",
        accountId: pool.assignments[f.agent.id]?.accountId,
        audit: JSON.parse(raw).entries,
      });
    });
});
process.once("disconnect", () => void close());
process.once("SIGTERM", () => void close().then(() => process.exit()));
try {
  const first = await addAccount(f.poolRoot, { provider: "claude", name: "Primary" });
  const spare = await addAccount(f.poolRoot, { provider: "claude", name: "Spare" });
  await assign(f.poolRoot, f.agent.id, "claude");
  const other = await f.owner.createAgent({
    provider: "claude",
    cwd: f.agent.cwd,
    workspaceId: f.workspaceId,
  });
  const keyPair = generateKeyPair();
  const registry = new DeviceRegistry(f.daemon.paseoHome);
  const device = registry.add(exportPublicKey(keyPair.publicKey), "Scratch phone");
  assert.equal(registry.hasAccountsManage(device.deviceId), false);
  assert.equal(registry.hasCommandCentre(device.deviceId), false);
  const offered = await generateLocalPairingOffer({
    paseoHome: f.daemon.paseoHome,
    relayEnabled: true,
    relayEndpoint: relay.endpoint,
    relayPublicEndpoint: relay.endpoint,
    appBaseUrl: "fulcra://pair",
    includeQr: false,
  });
  const offer = parseConnectionOfferFromUrl(offered.url!);
  assert.ok(offer);
  const phone = new DaemonClient({
    url: buildRelayWebSocketUrl({
      endpoint: relay.endpoint,
      useTls: false,
      serverId: offer.serverId,
      role: "client",
    }),
    appVersion: "0.11.4",
    clientType: "mobile",
    reconnect: { enabled: false },
    e2ee: {
      enabled: true,
      daemonPublicKeyB64: offer.daemonPublicKeyB64,
      getDeviceKeyPair: async () => keyPair,
    },
  });
  try {
    await phone.connect();
    await phone.fetchAgents();
    const permissions = phone.getLastServerInfoMessage()?.permissions;
    assert.equal(permissions?.includes("accounts.manage"), false);
    assert.equal(permissions?.includes("command-centre.manage"), false);
    const view = phone.observeTimeline([f.agent.id, other.id]);
    await view.ready;
    phone.sendHeartbeat({
      deviceType: "mobile",
      focusedAgentId: f.agent.id,
      focusedTerminalId: null,
      appVisible: true,
      lastActivityAt: new Date().toISOString(),
    });
    const listed = (await phone.invokePluginRpc(
      "orca-organization-next",
      "organization.accounts.session",
      { agentId: f.agent.id },
    )) as { accounts: object[] };
    assert.deepEqual(listed.accounts.map(Object.keys), [
      ["id", "name", "status"],
      ["id", "name", "status"],
    ]);
    for (const [method, input] of [
      ["organization.accounts.switch", { agentId: other.id, account: spare.id }],
      ["organization.accounts", {}],
      ["organization.accounts.add", { provider: "codex", name: "Extra" }],
      ["organization.accounts.update", { id: first.id, remove: true }],
      ["organization.accounts.update", { id: first.id, enabled: false }],
      ["organization.accounts.update", { id: first.id, token: "synthetic-token-never-used" }],
      ["organization.accounts.update", { id: first.id, priority: 99 }],
      ["organization.accounts.settings", { policy: "spread" }],
      ["organization.accounts.settings", { defaultAccount: { provider: "claude", id: spare.id } }],
    ] as const)
      await assert.rejects(() => phone.invokePluginRpc("orca-organization-next", method, input));
    for (const account of [spare.id, first.id]) {
      const result = (await phone.invokePluginRpc(
        "orca-organization-next",
        "organization.accounts.switch",
        { agentId: f.agent.id, account },
      )) as { ok: boolean };
      assert.equal(result.ok, true);
    }
    await view.release();
  } finally {
    await phone.close();
  }
  process.send?.({
    type: "ready",
    serverId: offer.serverId,
    relayEndpoint: relay.endpoint,
    daemonPublicKeyB64: offer.daemonPublicKeyB64,
    publicKeyB64: exportPublicKey(keyPair.publicKey),
    secretKeyB64: exportSecretKey(keyPair.secretKey),
    agentId: f.agent.id,
    workspaceId: f.workspaceId,
    deviceId: device.deviceId,
    spareId: spare.id,
  });
} catch (error) {
  // Fixture keys travel only over IPC. Error messages contain only synthetic account data.
  process.send?.({
    type: "error",
    message: error instanceof Error ? error.message.slice(0, 400) : "Fixture failed",
  });
  await close();
  process.exitCode = 1;
}
