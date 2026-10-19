import { windowsAclIsSafe } from "@getpaseo/server/private-files";
import { mkdtemp, rm, stat, writeFile, chmod, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, vi } from "vitest";
import {
  createHostLinkCommand,
  clearHostLinkNoticeFailure,
  hostLinkEndpoint,
  hostLinkNoticeStatus,
  saveHostLinkReceipt,
} from "./host-link.js";

vi.mock("@getpaseo/server/private-files", async (original) => ({
  ...(await original<typeof import("@getpaseo/server/private-files")>()),
  initializeWindowsPrivateFiles: vi.fn(async () => {}),
  windowsAclIsSafe: vi.fn(() => true),
}));

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

test("host-link CLI refuses a Windows credential journal with an unsafe ACL", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "host-link-acl-"));
  await writeFile(path.join(root, "host-links-outbox.json"), "{}", { mode: 0o600 });
  const platform = process.platform;
  vi.mocked(windowsAclIsSafe).mockReturnValue(false);
  try {
    Object.defineProperty(process, "platform", { value: "win32" });
    await expect(hostLinkNoticeStatus(root)).rejects.toThrow(
      "Use a private, bounded host-link file.",
    );
  } finally {
    Object.defineProperty(process, "platform", { value: platform });
    vi.mocked(windowsAclIsSafe).mockReturnValue(true);
    await rm(root, { recursive: true, force: true });
  }
});

test("notice repair clears only the reconciled worker warning", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "host-link-repair-"));
  const worker = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  const file = path.join(root, "host-links-notice-failures.json");
  try {
    await writeFile(file, JSON.stringify({ [worker]: true, [other]: true }), { mode: 0o600 });
    await clearHostLinkNoticeFailure(root, worker);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ [other]: true });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
