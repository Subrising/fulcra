import { mkdtemp, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import {
  createHostLinkCommand,
  hostLinkEndpoint,
  hostLinkNoticeStatus,
  saveHostLinkReceipt,
} from "./host-link.js";

test("host-link status counts uncertain notices, exhausted notices, and exhausted watches without credentials", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "host-link-status-"));
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    expect(await hostLinkNoticeStatus(root)).toEqual({
      uncertain: 0,
      exhausted: 0,
      exhaustedWatches: 0,
    });
    await writeFile(
      path.join(root, "host-links-outbox.json"),
      JSON.stringify({
        first: {
          notifyOnFinish: true,
          complete: true,
          receipt: { token: "synthetic-secret" },
          receivedNotices: [{ state: "uncertain" }, { state: "exhausted" }, { state: "delivered" }],
        },
        second: {
          notifyOnFinish: true,
          complete: false,
          watch: { failures: 8 },
          receivedNotices: [{ state: "exhausted" }, { state: "queued" }],
        },
        third: { notifyOnFinish: true, complete: true, watch: { failures: 8 } },
        unrelated: { notifyOnFinish: false, receivedNotices: [{ state: "uncertain" }] },
      }),
      { mode: 0o600 },
    );
    await createHostLinkCommand().parseAsync(["status", "--home", root], { from: "user" });
    expect(output).toHaveBeenCalledExactlyOnceWith(
      '{"uncertain":1,"exhausted":2,"exhaustedWatches":1}\n',
    );
    await writeFile(path.join(root, "host-links-outbox.json"), "{}");
    expect(await hostLinkNoticeStatus(root)).toEqual({
      uncertain: 0,
      exhausted: 0,
      exhaustedWatches: 0,
    });
    await writeFile(path.join(root, "host-links-outbox.json"), '{"broken":null}');
    await expect(hostLinkNoticeStatus(root)).rejects.toThrow(
      "The host-link notice journal requires repair.",
    );
    if (process.platform !== "win32") {
      await chmod(path.join(root, "host-links-outbox.json"), 0o644);
      await expect(hostLinkNoticeStatus(root)).rejects.toThrow(
        "Use a private, bounded host-link file.",
      );
    }
  } finally {
    output.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

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
