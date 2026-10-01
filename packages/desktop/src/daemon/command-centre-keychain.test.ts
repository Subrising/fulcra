import { expect, test } from "vitest";
import {
  createCommandCentreKeychain,
  type KeychainCommandResult,
} from "./command-centre-keychain.js";
const service = "ai.fulcra.command-centre." + "a".repeat(64);
const password = "b".repeat(64);

test("generated secret goes only to stdin, with an exact owned service", async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const keychain = createCommandCentreKeychain(async (args, input) => {
    calls.push({ args, input });
    return { code: 0, stdout: "", stderr: "security> security> " };
  }, "darwin");
  await keychain.set(service, password);
  expect(calls).toEqual([
    {
      args: ["-i"],
      input: `add-generic-password -U -s ${service} -a daemon -w ${password}\nquit\n`,
    },
  ]);
  expect(JSON.stringify(calls[0].args)).not.toContain(password);
});

test.each([" aAZ09\t\n'\"\\$`!;🙂終\r\n", "c".repeat(63), "D".repeat(64)])(
  "refuses unexpected password character classes before invocation",
  async (value) => {
    let calls = 0;
    const keychain = createCommandCentreKeychain(async () => {
      calls++;
      return { code: 0, stdout: "", stderr: "" };
    }, "darwin");
    await expect(keychain.set(service, value)).rejects.toThrow("invalid-generated-credential");
    expect(calls).toBe(0);
  },
);

test.each([
  [
    {
      code: 0,
      stdout: "",
      stderr:
        "security> SecKeychainItemModifyAttributesAndData: User interaction is not allowed. secret-value",
    },
    "interaction-not-allowed",
  ],
  [
    { code: 36, stdout: "", stderr: "errSecAuthFailed -25293 secret-value" },
    "authentication-failed",
  ],
  [
    { code: 0, stdout: "", stderr: "SecKeychainAddGenericPassword: unknown secret-value" },
    "operation-failed",
  ],
] satisfies [KeychainCommandResult, string][])(
  "names failure without retaining tool diagnostics or deleting an existing item",
  async (result, cause) => {
    const calls: string[][] = [];
    const keychain = createCommandCentreKeychain(async (args) => {
      calls.push(args);
      return result;
    }, "darwin");
    let error: unknown;
    try {
      await keychain.set(service, password);
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain(cause);
    expect(String(error)).not.toContain("secret-value");
    expect(error).not.toHaveProperty("cause");
    expect(calls).toEqual([["-i"]]);
  },
);

test("read preserves whitespace and not-found is the only null result", async () => {
  const keychain = createCommandCentreKeychain(
    async () => ({ code: 0, stdout: " value \n", stderr: "" }),
    "darwin",
  );
  expect(await keychain.get(service)).toBe(" value ");
  expect(
    await createCommandCentreKeychain(
      async () => ({ code: 44, stdout: "", stderr: "not found" }),
      "darwin",
    ).get(service),
  ).toBeNull();
});

test("unowned service is refused without invocation", async () => {
  let calls = 0;
  const keychain = createCommandCentreKeychain(async () => {
    calls++;
    throw Error("private value");
  }, "darwin");
  await expect(keychain.set("foreign-service", password)).rejects.toThrow("invalid-service");
  expect(calls).toBe(0);
});
