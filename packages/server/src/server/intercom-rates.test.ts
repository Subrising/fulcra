import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { IntercomRates } from "./intercom-rates.js";

test("native rates: fresh lowering, permanent IDs, rollover and restart do not restore an old permit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "native-rates-test-"));
  const file = path.join(directory, "rates.json");
  let now = 10000000;
  let owner = true;
  const requireOwner = () => {
    if (!owner) throw new Error("Owner revoked");
  };
  const settings = { report: 1, followup: 32, channel: 8, seat: 8 };
  try {
    const rates = new IntercomRates(file, () => now);
    await rates.set({ messageId: randomUUID(), settings }, requireOwner);
    const id = randomUUID();
    const binding = { sourceEpoch: randomUUID(), parentEpoch: randomUUID() };
    const guard = await rates.reserve(id, "report", "parent", binding, requireOwner);
    guard();
    await expect(
      rates.reserve(randomUUID(), "report", "parent", binding, requireOwner),
    ).rejects.toThrow("rate refused");
    await rates.set(
      { messageId: randomUUID(), settings: { ...settings, report: 0 } },
      requireOwner,
    );
    expect(guard).toThrow("rate lowered");
    await rates.set({ messageId: randomUUID(), settings }, requireOwner);
    owner = false;
    expect(guard).toThrow("Owner revoked");
    owner = true;
    now += 3600000;
    expect(guard).toThrow("permit expired");
    const restarted = new IntercomRates(file, () => now);
    await expect(restarted.reserve(id, "report", "parent", binding, requireOwner)).rejects.toThrow(
      "permit expired",
    );
    await expect(
      restarted.reserve(
        id,
        "report",
        "parent",
        { ...binding, parentEpoch: randomUUID() },
        requireOwner,
      ),
    ).rejects.toThrow("conflict");
    const fresh = await restarted.reserve(randomUUID(), "report", "parent", binding, requireOwner);
    fresh();
    now--;
    expect(fresh).toThrow("clock rollback");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native rate Settings: strict finite bounds and captured owner refusal", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "native-rates-test-"));
  try {
    const rates = new IntercomRates(path.join(directory, "rates.json"));
    const settings = { report: 12, followup: 64, channel: 64, seat: 32 };
    expect(() =>
      rates.set({ messageId: randomUUID(), settings: { ...settings, report: 13 } }, () => {}),
    ).toThrow();
    expect(() => rates.set({ messageId: randomUUID(), settings, owner: true }, () => {})).toThrow();
    await expect(
      rates.set({ messageId: randomUUID(), settings }, () => {
        throw new Error("Not owner");
      }),
    ).rejects.toThrow("Not owner");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("owner Settings initialization: protected snapshot never creates defaults and reserve refuses until explicit save", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "native-rates-test-"));
  let current = true;
  const guard = () => {
    if (!current) throw new Error("Owner revoked");
  };
  try {
    const rates = new IntercomRates(path.join(directory, "rates.json"));
    expect(await rates.snapshot(guard)).toEqual({
      initialized: false,
      settings: null,
      windowMs: 3600000,
    });
    await expect(rates.reserve(randomUUID(), "report", "parent", {}, guard)).rejects.toThrow(
      "initialization required",
    );
    expect(await rates.snapshot(guard)).toMatchObject({ initialized: false });
    await rates.set(
      {
        messageId: randomUUID(),
        settings: { report: 1, followup: 1, channel: 1, seat: 1 },
      },
      guard,
    );
    const view = await rates.snapshot(guard);
    expect(view).toMatchObject({ initialized: true, settings: { report: 1 } });
    view.settings!.report = 0;
    expect((await rates.snapshot(guard)).settings?.report).toBe(1);
    current = false;
    await expect(rates.snapshot(guard)).rejects.toThrow("Owner revoked");
    current = true;
    expect(
      await new IntercomRates(path.join(directory, "rates.json")).snapshot(guard),
    ).toMatchObject({ initialized: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
