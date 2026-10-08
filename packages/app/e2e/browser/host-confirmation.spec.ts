import { test, expect } from "../support/fixtures";
import {
  buildPairingLink,
  cancelHostConfirmation,
  connectToConfirmedHost,
  expectHostConfirmationFor,
  expectHostInHostPicker,
  hostConfirmation,
  openPairingLink,
  saveLinkedHostBeforeLoad,
  type LinkedHost,
} from "../support/helpers/host-confirmation";

// An unreachable relay: Fulcra claims the pairing on the relay after the answer, so a link that
// is accepted ends on the pairing error page and saves nothing.
const linkedHost: LinkedHost = {
  serverId: "srv_link_confirmation",
  relayEndpoint: "127.0.0.1:59998",
  // Fulcra shows a fingerprint of the key, so it must be a real 32-byte public key.
  daemonPublicKeyB64: Buffer.alloc(32, 7).toString("base64"),
};

const PAIRING_ERROR_ROUTE = /\/pair\?error=/;

test("a pairing link for a new host asks before saving it", async ({ page }) => {
  const link = buildPairingLink(linkedHost);

  await test.step("Cancel saves nothing", async () => {
    await openPairingLink(page, link);
    await expectHostConfirmationFor(page, linkedHost);
    await cancelHostConfirmation(page);
    await expect(page).toHaveURL(PAIRING_ERROR_ROUTE);
    await page.goto("/settings/general");
    await expectHostInHostPicker(page, linkedHost.serverId, "not listed");
  });

  await test.step("Connect closes the question and saves nothing while the relay is unreachable", async () => {
    await openPairingLink(page, link);
    await expectHostConfirmationFor(page, linkedHost);
    await connectToConfirmedHost(page);
    await expect(page).toHaveURL(PAIRING_ERROR_ROUTE, { timeout: 30_000 });
    await page.goto("/settings/general");
    await expectHostInHostPicker(page, linkedHost.serverId, "not listed");
  });
});

test("a pairing link for a saved host connects without asking", async ({ page }) => {
  await saveLinkedHostBeforeLoad(page, linkedHost);

  await openPairingLink(page, buildPairingLink(linkedHost));

  // No question: the link goes straight to the relay claim, which fails on the unreachable relay.
  await expect(page).toHaveURL(PAIRING_ERROR_ROUTE, { timeout: 30_000 });
  await expect(hostConfirmation(page)).toHaveCount(0);
});
