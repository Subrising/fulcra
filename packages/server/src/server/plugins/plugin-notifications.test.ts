import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { PushDeliveryReport, PushPayload } from "../push/index.js";
import {
  KEY_RETENTION_MS,
  PluginNotificationCenter,
  PluginNotifyNotDeclaredError,
  PluginNotifyRateLimitedError,
  PluginNotifyStorageError,
  type PluginNotification,
} from "./plugin-notifications.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function stateFile(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "fulcra-notify-"));
  directories.push(directory);
  return path.join(directory, "plugin-notifications.json");
}

interface Harness {
  notifications: PluginNotificationCenter;
  pushes: PushPayload[];
  added: PluginNotification[];
  clock: { value: number };
  outcome: { next: () => PushDeliveryReport | Promise<PushDeliveryReport> };
}

function center(
  options: { now?: { value: number }; filePath?: string; outcome?: Harness["outcome"] } = {},
): Harness {
  const pushes: PushPayload[] = [];
  const added: PluginNotification[] = [];
  const clock = options.now ?? { value: Date.parse("2026-09-24T09:00:00Z") };
  const outcome = options.outcome ?? { next: () => ({ devices: 1, accepted: 1 }) };
  const notifications = new PluginNotificationCenter({
    push: {
      async send(payload) {
        pushes.push(payload);
        return outcome.next();
      },
    },
    serverId: "server-1",
    logger: pino({ level: "silent" }),
    filePath: options.filePath,
    now: () => clock.value,
    autoDrain: false,
    onAdded: (notification) => added.push(notification),
  });
  return { notifications, pushes, added, clock, outcome };
}

const now = { key: "decision:1", title: "Approve the release", urgency: "now" as const };

describe("plugin notify hook", () => {
  it("refuses a plugin whose manifest does not declare requirements.notify", async () => {
    const { notifications, pushes, added } = center();
    await expect(
      notifications.notify({ pluginId: "organization", declared: false, request: now }),
    ).rejects.toBeInstanceOf(PluginNotifyNotDeclaredError);
    await notifications.drain();
    expect(pushes).toEqual([]);
    expect(added).toEqual([]);
    expect(notifications.list()).toEqual([]);
  });

  it("pushes only urgency now, title only, and marks it pushed only after the push service accepts it", async () => {
    const { notifications, pushes, added } = center();
    for (const urgency of ["now", "today", "fyi"] as const) {
      await notifications.notify({
        pluginId: "organization",
        declared: true,
        request: { key: `k-${urgency}`, title: `Title ${urgency}`, urgency, deepLink: "/inbox/1" },
      });
    }
    expect(
      notifications.list().map((entry) => [entry.urgency, entry.delivery, entry.pushed]),
    ).toEqual([
      ["fyi", "not-needed", false],
      ["today", "not-needed", false],
      ["now", "pending", false],
    ]);
    await notifications.drain();
    expect(pushes).toEqual([
      {
        title: "Title now",
        body: "",
        data: {
          serverId: "server-1",
          kind: "plugin-notification",
          pluginId: "organization",
          notificationId: added[0].id,
          deepLink: "/inbox/1",
        },
      },
    ]);
    expect(notifications.list()[2]).toMatchObject({ delivery: "sent", pushed: true });
  });

  it("is idempotent by key per plugin, and the same key from another plugin is new", async () => {
    const { notifications, pushes } = center();
    const first = await notifications.notify({ pluginId: "p-one", declared: true, request: now });
    const again = await notifications.notify({
      pluginId: "p-one",
      declared: true,
      request: { ...now, title: "Changed title" },
    });
    expect(again).toEqual({ id: first.id, duplicate: true });
    const other = await notifications.notify({ pluginId: "p-two", declared: true, request: now });
    expect(other.duplicate).toBe(false);
    await notifications.drain();
    expect(pushes).toHaveLength(2);
  });

  it("keeps a key deduplicated after other plugins push it out of the 500-item list", async () => {
    const { notifications, pushes, clock } = center();
    const first = await notifications.notify({ pluginId: "quiet", declared: true, request: now });
    for (let index = 0; index < 500; index += 1) {
      clock.value += 7_000; // stays under the noisy plugin's rate limit
      await notifications.notify({
        pluginId: "noisy",
        declared: true,
        request: { key: `n${index}`, title: "Hello", urgency: "fyi" },
      });
    }
    expect(notifications.list(500).some((entry) => entry.id === first.id)).toBe(false);
    await expect(
      notifications.notify({ pluginId: "quiet", declared: true, request: now }),
    ).resolves.toEqual({ id: first.id, duplicate: true });
    await notifications.drain();
    expect(pushes).toHaveLength(1);
    clock.value += KEY_RETENTION_MS;
    await expect(
      notifications.notify({ pluginId: "quiet", declared: true, request: now }),
    ).resolves.toMatchObject({ duplicate: false });
  }, 30_000);

  it("rate-limits each plugin to ten a minute, including across a restart", async () => {
    const filePath = stateFile();
    const first = center({ filePath });
    for (let index = 0; index < 10; index += 1) {
      await first.notifications.notify({
        pluginId: "noisy",
        declared: true,
        request: { key: `n${index}`, title: "Hello", urgency: "fyi" },
      });
    }
    const restarted = center({ filePath, now: first.clock });
    await expect(
      restarted.notifications.notify({
        pluginId: "noisy",
        declared: true,
        request: { key: "n10", title: "Hello", urgency: "fyi" },
      }),
    ).rejects.toBeInstanceOf(PluginNotifyRateLimitedError);
    await expect(
      restarted.notifications.notify({
        pluginId: "quiet",
        declared: true,
        request: { key: "q", title: "Hi", urgency: "fyi" },
      }),
    ).resolves.toMatchObject({ duplicate: false });
    first.clock.value += 60_000;
    await expect(
      restarted.notifications.notify({
        pluginId: "noisy",
        declared: true,
        request: { key: "n10", title: "Hello", urgency: "fyi" },
      }),
    ).resolves.toMatchObject({ duplicate: false });
  });

  it("refuses to acknowledge a notification it could not save", async () => {
    const filePath = stateFile();
    mkdirSync(filePath); // a directory where the file should be: every write fails
    const { notifications, pushes } = center({ filePath });
    await expect(
      notifications.notify({ pluginId: "p", declared: true, request: now }),
    ).rejects.toBeInstanceOf(PluginNotifyStorageError);
    await notifications.drain();
    expect(pushes).toEqual([]);
    expect(notifications.list()).toEqual([]);
  });

  it("retries a failed push with backoff, then records a final failure that a repeat re-queues", async () => {
    const failing = {
      next: (): PushDeliveryReport => {
        throw new Error("push service unreachable");
      },
    };
    const { notifications, pushes, clock, outcome } = center({ outcome: failing });
    const { id } = await notifications.notify({ pluginId: "p", declared: true, request: now });
    await notifications.drain();
    expect(notifications.list()[0]).toMatchObject({ delivery: "pending", pushed: false });
    await notifications.drain(); // not due yet: no second attempt
    expect(pushes).toHaveLength(1);
    for (const delay of [30_000, 120_000, 600_000, 1_800_000, 3_600_000]) {
      clock.value += delay;
      await notifications.drain();
    }
    expect(pushes).toHaveLength(6);
    expect(notifications.list()[0]).toMatchObject({ delivery: "failed", pushed: false });

    outcome.next = () => ({ devices: 2, accepted: 2 });
    await expect(
      notifications.notify({ pluginId: "p", declared: true, request: now }),
    ).resolves.toEqual({ id, duplicate: true });
    await notifications.drain();
    expect(notifications.list()[0]).toMatchObject({ delivery: "sent", pushed: true });
  });

  it("treats a push the service did not accept as not delivered", async () => {
    const outcome = { next: (): PushDeliveryReport => ({ devices: 1, accepted: 0 }) };
    const { notifications } = center({ outcome });
    await notifications.notify({ pluginId: "p", declared: true, request: now });
    await notifications.drain();
    expect(notifications.list()[0]).toMatchObject({ delivery: "pending", pushed: false });
  });

  it("records no-devices without retrying when no app is registered for push", async () => {
    const outcome = { next: (): PushDeliveryReport => ({ devices: 0, accepted: 0 }) };
    const { notifications, pushes, clock } = center({ outcome });
    await notifications.notify({ pluginId: "p", declared: true, request: now });
    await notifications.drain();
    clock.value += 3_600_000;
    await notifications.drain();
    expect(pushes).toHaveLength(1);
    expect(notifications.list()[0]).toMatchObject({ delivery: "no-devices", pushed: false });
  });

  it("resumes an undelivered push after a restart and keeps keys deduplicated", async () => {
    const filePath = stateFile();
    const first = center({ filePath, outcome: { next: () => Promise.reject(new Error("down")) } });
    const { id } = await first.notifications.notify({
      pluginId: "p",
      declared: true,
      request: now,
    });
    const restarted = center({ filePath, now: first.clock });
    await restarted.notifications.drain();
    expect(restarted.pushes).toHaveLength(1);
    expect(restarted.notifications.list()[0]).toMatchObject({ id, delivery: "sent", pushed: true });
    await expect(
      restarted.notifications.notify({ pluginId: "p", declared: true, request: now }),
    ).resolves.toEqual({ id, duplicate: true });
  });

  it("accepts a title of up to 120 characters with no body, and refuses anything else", async () => {
    const { notifications } = center();
    const notify = (request: unknown) =>
      notifications.notify({ pluginId: "p", declared: true, request });
    await expect(
      notify({ key: "ok", title: "x".repeat(120), urgency: "fyi" }),
    ).resolves.toBeDefined();
    await expect(notify({ key: "long", title: "x".repeat(121), urgency: "fyi" })).rejects.toThrow();
    await expect(
      notify({ key: "body", title: "t", urgency: "fyi", body: "details" }),
    ).rejects.toThrow();
    await expect(notify({ key: "nl", title: "two\nlines", urgency: "fyi" })).rejects.toThrow();
    await expect(notify({ key: "u", title: "t", urgency: "urgent" })).rejects.toThrow();
    await expect(
      notify({ key: "web", title: "t", urgency: "now", deepLink: "https://evil.test" }),
    ).rejects.toThrow();
    await expect(
      notify({ key: "proto", title: "t", urgency: "now", deepLink: "//evil.test" }),
    ).rejects.toThrow();
    await expect(
      notify({ key: "app", title: "t", urgency: "now", deepLink: "fulcra://inbox/7" }),
    ).resolves.toBeDefined();
  });
});
