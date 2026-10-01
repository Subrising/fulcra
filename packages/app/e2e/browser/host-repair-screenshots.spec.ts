import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";

const READY_TIMEOUT = 60_000;
// Cold Metro loads, two navigations, hydration and the real modal share this budget.
test.setTimeout(300_000);
const readyExpect = expect.configure({ timeout: READY_TIMEOUT });

// Runs in the page (serialised by evaluateAll): the banner's theme, layout and text once it is
// visible with fonts loaded, else null.
function sampleBanner(elements: Element[]) {
  if (elements.length !== 1) return null;
  const element = elements[0];
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  if (
    !rect.width ||
    !rect.height ||
    style.visibility !== "visible" ||
    document.fonts.status !== "loaded"
  )
    return null;
  const channels = style.backgroundColor.match(/\d+/g)?.slice(0, 3).map(Number);
  if (!channels || channels.length !== 3) return null;
  return {
    theme: channels.every((value) => value > 200) ? "light" : "dark",
    layout: [rect.x, rect.y, rect.width, rect.height, element.scrollWidth, element.clientWidth],
    text: element.textContent,
  };
}

// Use the same Metro/app fixture and registry override as helpers/hosts.ts.
// No relay or owner daemon is contacted: every seeded relay is terminal before probing.
for (const colorScheme of ["light", "dark"] as const) {
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    for (const reason of ["pairing-upgraded", "device-removed"] as const) {
      test(`repair ${reason} ${colorScheme} ${viewport.width}x${viewport.height}`, async ({
        page,
      }, testInfo) => {
        page.setDefaultNavigationTimeout(READY_TIMEOUT);
        await page.setViewportSize(viewport);
        await page.emulateMedia({ colorScheme });
        await gotoAppShell(page);
        const serverId = "repair-fixture-studio";
        await page.evaluate(
          (seed) => {
            const nonce = localStorage.getItem("@paseo:e2e-seed-nonce");
            if (!nonce) throw new Error("Expected fixture seed nonce");
            const registry = JSON.parse(localStorage.getItem("@paseo:daemon-registry") ?? "[]");
            registry.push({
              serverId: seed.serverId,
              label: "Studio Mac",
              pairingRequired: seed.reason,
              connections: [
                {
                  id: "relay:relay.example.test:443",
                  type: "relay",
                  relayEndpoint: "relay.example.test:443",
                  daemonPublicKeyB64: "fixture-pin",
                },
              ],
              preferredConnectionId: "relay:relay.example.test:443",
            });
            localStorage.setItem("@paseo:daemon-registry", JSON.stringify(registry));
            // The app defaults to an explicit dark preference, not the OS scheme.
            localStorage.setItem(
              "@paseo:app-settings",
              JSON.stringify({ theme: seed.colorScheme }),
            );
            localStorage.setItem("@paseo:e2e-disable-default-seed-once", nonce);
          },
          { serverId, reason, colorScheme },
        );
        await page.goto(`/settings/hosts/${serverId}/connections`);
        const banner = page.getByTestId("host-repair-banner");
        const pairButton = banner.getByRole("button", { name: "Pair again", exact: true });
        // AppearanceProvider mounts screens after settings hydration. Wait for the
        // applied theme, loaded fonts and unchanged layout across a quiet second.
        // evaluateAll re-resolves on every poll and returns null during remounts;
        // it never keeps an ElementHandle or times out waiting for a detached node.
        let previousSample: string | null = null;
        let stableSince = 0;
        await readyExpect
          .poll(
            async () => {
              const sample = await banner.evaluateAll(sampleBanner);
              const current = sample?.theme === colorScheme ? JSON.stringify(sample) : null;
              if (!current || current !== previousSample) {
                previousSample = current;
                stableSince = Date.now();
                return false;
              }
              return Date.now() - stableSince >= 1000;
            },
            { timeout: READY_TIMEOUT, intervals: [250, 500] },
          )
          .toBe(true);
        await readyExpect(banner).toBeVisible();
        await readyExpect(banner).toContainText("Pair Studio Mac again");
        await readyExpect(banner).toContainText(
          reason === "device-removed"
            ? "This device was removed from Studio Mac. Pair again to reconnect."
            : "Fulcra's pairing got safer",
        );
        await readyExpect(pairButton).toBeVisible();
        await readyExpect(pairButton).toBeEnabled();
        await readyExpect
          .poll(
            () =>
              banner.evaluateAll(
                (elements) =>
                  elements.length === 1 &&
                  elements[0].clientWidth > 0 &&
                  elements[0].scrollWidth <= elements[0].clientWidth,
              ),
            { timeout: READY_TIMEOUT },
          )
          .toBe(true);
        await page.screenshot({
          path: testInfo.outputPath(
            `repair-${reason}-${colorScheme}-${viewport.width}x${viewport.height}.png`,
          ),
          fullPage: false,
        });
        // Also exercise the real modal/portal through Metro's normal React interop.
        const modal = page.getByTestId("pair-link-modal");
        // A remount can discard the click's state. Retry the whole interaction,
        // using fresh locators each time; success still requires the real modal.
        await expect(async () => {
          if (!(await modal.isVisible())) await pairButton.click({ timeout: 10_000 });
          await expect(modal).toBeVisible({ timeout: 5_000 });
        }).toPass({ timeout: READY_TIMEOUT, intervals: [250, 500] });
      });
    }
  }
}
