import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { hostLinkEndpoint, saveHostLinkReceipt } from "./host-link.js";

test("host-link CLI refuses remote HTTP and credentials in URLs", () => {
  expect(hostLinkEndpoint("https://example.test", "dispatch")).toBe(
    "https://example.test/api/host-links/dispatch",
  );
  expect(hostLinkEndpoint("http://127.0.0.1:1234", "worker")).toBe(
    "http://127.0.0.1:1234/api/host-links/worker",
  );
  for (const url of [
    "http://example.test",
    "https://user:password@example.test",
    "https://example.test/?token=bad",
    "https://example.test/other",
  ])
    expect(() => hostLinkEndpoint(url, "dispatch")).toThrow();
});
test.skipIf(process.platform === "win32")(
  "worker receipts are private and preserve their identity",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "host-link-cli-"));
    try {
      const file = path.join(root, "receipt.json");
      await saveHostLinkReceipt(file, {
        serverId: "target",
        messageId: "11111111-1111-4111-8111-111111111111",
        state: "created",
        agentId: "worker",
        token: `hworker1.${"A".repeat(43)}`,
        endpoint: "https://example.test",
      });
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
