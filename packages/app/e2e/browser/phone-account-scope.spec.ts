import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnTsx, killProcessTree } from "../support/helpers/spawn-node";
import { once } from "node:events";
import { composerLocator } from "../support/helpers/composer";
import { buildHostAgentDetailRoute } from "../../src/utils/host-routes";

test("normal paired phone lists and switches the viewed session through the real relay", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  const repository = path.resolve(__dirname, "../../../..");
  const child = spawnTsx(
    path.join(repository, "packages/server/src/server/test-utils/phone-account-browser.fixture.ts"),
    [],
    {
      cwd: repository,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});
  interface Fixture {
    serverId: string;
    relayEndpoint: string;
    daemonPublicKeyB64: string;
    publicKeyB64: string;
    secretKeyB64: string;
    agentId: string;
    workspaceId: string;
    deviceId: string;
    spareId: string;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const f = await new Promise<Fixture>((resolve, reject) => {
    timer = setTimeout(() => reject(Error("Scratch account fixture startup timed out")), 90_000);
    child.once("error", reject);
    child.once("exit", (code) => reject(Error(`Scratch fixture exited: ${code}`)));
    child.on("message", (message: { type?: string; message?: string }) => {
      if (message.type === "ready") {
        clearTimeout(timer);
        resolve(message as unknown as Fixture);
      }
      if (message.type === "error") {
        clearTimeout(timer);
        reject(Error(`Scratch permission assertions failed: ${message.message}`));
      }
    });
  }).catch(async (error) => {
    clearTimeout(timer);
    await killProcessTree(child);
    throw error;
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const offer = f;
    const connection = {
      id: `relay:${f.relayEndpoint}`,
      type: "relay",
      relayEndpoint: f.relayEndpoint,
      deviceId: f.deviceId,
      useTls: false,
      daemonPublicKeyB64: offer.daemonPublicKeyB64,
    };
    await page.addInitScript(
      ({ host, identity }) => {
        localStorage.setItem("fulcra:relay-device-identity:v3", JSON.stringify(identity));
        localStorage.setItem("@paseo:daemon-registry", JSON.stringify([host]));
      },
      {
        host: {
          serverId: offer.serverId,
          label: "Scratch host",
          connections: [connection],
          preferredConnectionId: connection.id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        identity: { publicKeyB64: f.publicKeyB64, secretKeyB64: f.secretKeyB64 },
      },
    );
    await page.routeWebSocket(/:(6767|6768)\b/, (socket) => socket.close());
    const out = info.outputPath("screens");
    await mkdir(out, { recursive: true });
    for (const [width, height] of [
      [375, 812],
      [768, 1024],
      [1440, 1000],
      [812, 375],
    ]) {
      await page.setViewportSize({ width, height });
      await page.goto(
        new URL(
          buildHostAgentDetailRoute(offer.serverId, f.agentId, f.workspaceId),
          `http://127.0.0.1:${process.env.E2E_METRO_PORT}`,
        ).toString(),
      );
      const composer = composerLocator(page);
      await expect(composer).toBeEditable({ timeout: 45_000 });
      await composer.fill("/account");
      await expect(
        page
          .getByText("List this session’s accounts, or switch it to one", { exact: true })
          .first(),
      ).toBeVisible();
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      const panel = page.getByTestId("switch-account").filter({ visible: true });
      await expect(panel).toBeVisible();
      await expect(panel.getByText("Primary", { exact: true })).toBeVisible();
      await expect(panel.getByText("Spare", { exact: true })).toBeVisible();
      const layoutIssues = await panel.evaluate((root) => {
        const bounds = root.getBoundingClientRect();
        function measureElements() {
          const failures: string[] = [];
          for (const item of root.querySelectorAll<HTMLElement>("*")) {
            const r = item.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            if (r.left < bounds.left - 1 || r.right > bounds.right + 1) failures.push("overflow");
            if (item.matches("button,[role=button]") && (r.width < 48 || r.height < 48))
              failures.push("small control");
            if (
              item.scrollWidth > item.clientWidth + 1 &&
              getComputedStyle(item).overflowX === "hidden"
            )
              failures.push("clipped text");
          }
          return failures;
        }
        function measureText() {
          const failures: string[] = [];
          const lines: { rect: DOMRect; text: string }[] = [];
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (
              !node.textContent?.trim() ||
              node.parentElement?.closest('svg,[aria-hidden="true"]')
            )
              continue;
            const range = document.createRange();
            range.selectNodeContents(node);
            for (const rect of range.getClientRects()) {
              if (
                rect.width &&
                rect.height &&
                rect.top >= bounds.top &&
                rect.bottom <= bounds.bottom
              ) {
                if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1)
                  failures.push("clipped text");
                lines.push({ rect, text: node.textContent.slice(0, 30) });
              }
            }
          }
          for (let a = 0; a < lines.length; a++)
            for (let b = a + 1; b < lines.length; b++) {
              const x =
                Math.min(lines[a].rect.right, lines[b].rect.right) -
                Math.max(lines[a].rect.left, lines[b].rect.left);
              const y =
                Math.min(lines[a].rect.bottom, lines[b].rect.bottom) -
                Math.max(lines[a].rect.top, lines[b].rect.top);
              if (x > 1 && y > 1)
                failures.push(`text overlap: ${lines[a].text} / ${lines[b].text}`);
            }
          return failures;
        }
        const failures = [...measureElements(), ...measureText()];
        if (document.documentElement.scrollWidth > innerWidth) failures.push("sideways page");
        return failures;
      });
      await writeFile(
        path.join(out, `account-${width}x${height}.json`),
        JSON.stringify(layoutIssues),
      );
      await page.screenshot({ path: path.join(out, `account-${width}x${height}.png`) });
      expect(layoutIssues).toEqual([]);
    }
    await page.getByRole("button", { name: "Use Spare for this session", exact: true }).click();
    await expect(page.getByText(/Switched to account "Spare"/)).toBeVisible();
    const inspection = new Promise<{ accountId: string; audit: unknown[] }>((resolve) => {
      child.once("message", (message) =>
        resolve(message as { accountId: string; audit: unknown[] }),
      );
    });
    child.send({ type: "inspect" });
    const result = await inspection;
    expect(result.accountId).toBe(f.spareId);
    expect(result.audit).toEqual(
      Array.from({ length: 3 }, (_, index) =>
        expect.objectContaining({
          deviceId: f.deviceId,
          action: "switch",
          accountLabel: index === 1 ? "Primary" : "Spare",
        }),
      ),
    );
    expect(errors).toEqual([]);
  } catch (error) {
    await page.screenshot({ path: info.outputPath("before-fixture-close.png") });
    await info.attach("account-page-state", {
      body: await page.locator("body").innerText(),
      contentType: "text/plain",
    });
    throw error;
  } finally {
    clearTimeout(timer);
    const stopped = once(child, "exit");
    child.send({ type: "stop" });
    await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    await killProcessTree(child);
  }
});
