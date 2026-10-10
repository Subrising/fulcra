import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { createWindowsCommandCentreKeychain } from "./command-centre-keychain-windows.js";

const service = "ai.fulcra.command-centre." + "a".repeat(64);
const password = "b".repeat(64);
// A stand-in for Electron safeStorage: reversible, and visibly not plain text.
const fake = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (text: string) => Buffer.from([...text].reverse().join("") + "!enc"),
  decryptString: (data: Buffer) => [...data.toString().slice(0, -4)].reverse().join(""),
});

async function setup(available = true) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cc-keychain-"));
  const filePath = path.join(dir, "command-centre-secrets.json");
  return { filePath, keychain: createWindowsCommandCentreKeychain({ safeStorage: fake(available), filePath }) };
}

test("stores the secret encrypted and reads it back", async () => {
  const { filePath, keychain } = await setup();
  expect(await keychain.get(service)).toBeNull();
  await keychain.set(service, password);
  expect(await keychain.get(service)).toBe(password);
  expect(await readFile(filePath, "utf8")).not.toContain(password);
});

test("keeps the clear error when OS encryption is unavailable", async () => {
  const { keychain } = await setup(false);
  await expect(keychain.set(service, password)).rejects.toThrow("unavailable-platform");
  await expect(keychain.get(service)).rejects.toThrow("unavailable-platform");
});

test("refuses a foreign service name or a non-generated secret", async () => {
  const { keychain } = await setup();
  await expect(keychain.get("other")).rejects.toThrow("invalid-service");
  await expect(keychain.set(service, "x")).rejects.toThrow("invalid-generated-credential");
});
