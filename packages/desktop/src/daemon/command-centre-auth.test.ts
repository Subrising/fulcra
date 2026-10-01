import { expect, test } from "vitest";
import { commandCentreCredential } from "./command-centre-auth.js";

test("password-less desktop generates once and reconnects using a fake Keychain", async () => {
  const values = new Map<string, string>();
  const keychain = {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async set(key: string, value: string) {
      values.set(key, value);
    },
  };
  const all = await Promise.all(
    Array.from({ length: 10 }, () =>
      commandCentreCredential({ home: "/fixture/home", enabled: true, keychain }),
    ),
  );
  const a = all[0];
  expect(new Set(all).size).toBe(1);
  const b = await commandCentreCredential({ home: "/fixture/home", enabled: true, keychain });
  expect(a).toMatch(/^[a-f0-9]{64}$/);
  expect(b).toBe(a);
  expect(values.size).toBe(1);
  expect([...values.keys()][0]).toMatch(/^ai\.fulcra\.command-centre\./);
  expect(
    await commandCentreCredential({ home: "/fixture/other", enabled: false, keychain }),
  ).toBeNull();
  expect(values.size).toBe(1);
});
test("existing auth is never replaced; storage failure refuses enable", async () => {
  const keychain = {
    async get() {
      return null;
    },
    async set() {
      throw Error("locked");
    },
  };
  expect(
    await commandCentreCredential({
      home: "/fixture",
      enabled: true,
      existingPassword: "existing",
      keychain,
    }),
  ).toBe("existing");
  await expect(
    commandCentreCredential({ home: "/fixture", enabled: true, keychain }),
  ).rejects.toThrow("locked");
});

test("IR-4 a read-only credential lookup cannot rotate a running daemon's secret", async () => {
  let writes = 0;
  const keychain = {
    async get() {
      return null;
    },
    async set() {
      writes++;
    },
  };
  await expect(
    commandCentreCredential({ enabled: true, home: "/fixture", keychain, create: false }),
  ).rejects.toThrow("credential missing");
  expect(writes).toBe(0);
});

test.each([
  [null, "not-found-after-write"],
  ["different-fake-value", "readback-mismatch"],
])("names readback failure without credential values", async (readback, cause) => {
  let reads = 0;
  const keychain = {
    async get() {
      return ++reads === 1 ? null : readback;
    },
    async set() {},
  };
  await expect(
    commandCentreCredential({ enabled: true, home: "/fixture/readback", keychain }),
  ).rejects.toThrow(String(cause));
});
