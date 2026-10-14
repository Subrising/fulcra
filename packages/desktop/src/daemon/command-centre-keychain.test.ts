import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  createCommandCentreKeychain,
  createSecurityCommand,
  type KeychainCommandResult,
} from "./command-centre-keychain.js";
const service = "ai.fulcra.command-centre." + "a".repeat(64);
const password = "b".repeat(64);

test("generated secret goes only to stdin, with an exact owned service", async () => {
  const calls: { args: string[]; input?: string }[] = [];
  const keychain = createCommandCentreKeychain(async (args, input) => {
    calls.push({ args, input });
    return input === undefined
      ? { code: 0, stdout: password + "\n", stderr: "" }
      : { code: 0, stdout: "", stderr: "security> security> " };
  }, "darwin");
  await keychain.set(service, password);
  expect(calls).toEqual([
    {
      args: ["-i"],
      input: `add-generic-password -U -s ${service} -a daemon -w ${password}\nquit\n`,
    },
    { args: ["find-generic-password", "-s", service, "-a", "daemon", "-w"], input: undefined },
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
    expect(calls).toEqual([["-i"], ["find-generic-password", "-s", service, "-a", "daemon", "-w"]]);
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

test.runIf(process.platform !== "win32").each([0, 1])(
  "a fake security binary stores the secret before quit exits %s",
  async (quitCode) => {
    const directory = await mkdtemp(path.join(tmpdir(), "security-fake-"));
    const binary = path.join(directory, "security");
    try {
      await writeFile(
        binary,
        `#!${process.execPath}
const fs = require("node:fs");
const file = __filename + ".item";
if (process.argv[2] === "-i") {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", part => text += part);
  process.stdin.on("end", () => {
    const match = text.match(/-w ([a-f0-9]{64})/);
    if (!match) process.exit(2);
    fs.writeFileSync(file, match[1]);
    process.stderr.write("security> security: unknown command quit\\n");
    process.exit(${quitCode});
  });
} else if (process.argv[2] === "find-generic-password") {
  if (!fs.existsSync(file)) process.exit(44);
  process.stdout.write(fs.readFileSync(file, "utf8") + "\\n");
} else process.exit(2);
`,
        { mode: 0o700 },
      );
      const keychain = createCommandCentreKeychain(createSecurityCommand(binary), "darwin");
      await keychain.set(service, password);
      expect(await keychain.get(service)).toBe(password);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test.each([null, "c".repeat(64)])(
  "a missing or different readback cannot confirm a write (%s)",
  async (stored) => {
    const keychain = createCommandCentreKeychain(
      async (_args, input) =>
        input === undefined
          ? { code: stored === null ? 44 : 0, stdout: stored ?? "", stderr: "" }
          : { code: 0, stdout: "", stderr: "" },
      "darwin",
    );
    await expect(keychain.set(service, password)).rejects.toThrow("operation-failed");
  },
);
