import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CREDENTIALS_SERVICE,
  MACOS_KEYCHAIN_HELPER,
  OSASCRIPT_BINARY,
  POWERSHELL_BINARY,
  SECRET_TOOL_BINARY,
  SECURITY_BINARY,
  createLinuxSecretServiceBackend,
  createMacosKeychainBackend,
  createMemoryCredentialBackend,
  createPlatformCredentialBackend,
  createWindowsCredentialManagerBackend,
  runCommand,
  type CommandResult,
} from "./credential-backend.js";

const SECRET = JSON.stringify({
  accessToken: 'CANARY-credential-0123456789 "quoted"',
  scheme: "bearer",
});

interface Call {
  file: string;
  args: string[];
  stdin: string | undefined;
}

// A fake OS store behind each platform's command-line tool. It records every call so the tests can
// prove the secret never appears in argv.
function recordingRunner(handler: (call: Call) => CommandResult) {
  const calls: Call[] = [];
  return {
    calls,
    async run(file: string, args: string[], stdin?: string): Promise<CommandResult> {
      const call = { file, args, stdin };
      calls.push(call);
      return handler(call);
    },
  };
}

function expectSecretNotInArgv(calls: Call[]): void {
  for (const call of calls) expect(call.args.join(" ")).not.toContain("CANARY");
}

describe("macOS keychain backend (fake helper)", () => {
  // Emulates the osascript Security-framework helper: the request arrives as JSON on stdin.
  function fakeHelper(options: { failDelete?: boolean } = {}) {
    const items = new Map<string, string>();
    const runner = recordingRunner(({ file, args, stdin }) => {
      if (file === SECURITY_BINARY) {
        const key = `${args[args.indexOf("-s") + 1]}/${args[args.indexOf("-a") + 1]}`;
        const value = items.get(key);
        return value === undefined
          ? { exitCode: 44, stdout: "" }
          : { exitCode: 0, stdout: `${value}\n` };
      }
      const request = JSON.parse(stdin ?? "{}") as {
        op: string;
        service: string;
        account: string;
        value?: string;
      };
      const key = `${request.service}/${request.account}`;
      if (request.op === "set") items.set(key, request.value ?? "");
      if (request.op === "get") {
        const value = items.get(key);
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            value === undefined ? { status: "absent" } : { status: "ok", value },
          ),
        };
      }
      if (request.op === "delete" && !options.failDelete) items.delete(key);
      return { exitCode: 0, stdout: JSON.stringify({ status: "ok" }) };
    });
    return { items, runner };
  }

  it("sends every request, secret included, on stdin to the helper and deletes with confirmation", async () => {
    const { runner } = fakeHelper();
    const backend = createMacosKeychainBackend(runner.run);
    const account = randomUUID();

    await expect(backend.get(CREDENTIALS_SERVICE, account)).resolves.toBeNull();
    await backend.set(CREDENTIALS_SERVICE, account, SECRET);
    await expect(backend.get(CREDENTIALS_SERVICE, account)).resolves.toBe(SECRET);
    await backend.delete(CREDENTIALS_SERVICE, account);
    await expect(backend.get(CREDENTIALS_SERVICE, account)).resolves.toBeNull();

    expect(runner.calls.every((call) => call.file === OSASCRIPT_BINARY)).toBe(true);
    expect(runner.calls[0].args).toEqual(["-l", "JavaScript", "-e", MACOS_KEYCHAIN_HELPER]);
    expectSecretNotInArgv(runner.calls);
  });

  it("reports a delete the keychain did not carry out, instead of success", async () => {
    const { runner } = fakeHelper({ failDelete: true });
    const backend = createMacosKeychainBackend(runner.run);
    await backend.set(CREDENTIALS_SERVICE, "abc", SECRET);
    await expect(backend.delete(CREDENTIALS_SERVICE, "abc")).rejects.toThrow(
      "keychain delete failed",
    );
  });

  it("reports a failed write instead of pretending it stored the secret", async () => {
    const runner = recordingRunner(() => ({
      exitCode: 0,
      stdout: JSON.stringify({ status: "error" }),
    }));
    const backend = createMacosKeychainBackend(runner.run);
    await expect(backend.set(CREDENTIALS_SERVICE, randomUUID(), SECRET)).rejects.toThrow(
      "keychain write failed",
    );
  });

  it("reads legacy plugin items with /usr/bin/security and never writes them", async () => {
    const { items, runner } = fakeHelper();
    items.set("ai.fulcra.plugin.organization/jira:token", "legacy-value");
    const backend = createMacosKeychainBackend(runner.run);
    await expect(backend.get("ai.fulcra.plugin.organization", "jira:token")).resolves.toBe(
      "legacy-value",
    );
    expect(runner.calls[0].file).toBe(SECURITY_BINARY);
    await expect(
      backend.set("ai.fulcra.plugin.organization", "jira:token", "x"),
    ).rejects.toThrow("read-only");
    await expect(
      backend.delete("ai.fulcra.plugin.organization", "jira:token"),
    ).rejects.toThrow("read-only");
  });

  it("refuses service and account names outside the Fulcra namespace", async () => {
    const backend = createMacosKeychainBackend(
      recordingRunner(() => ({ exitCode: 0, stdout: "" })).run,
    );
    await expect(backend.get("com.apple.other", "x")).rejects.toThrow("Invalid credential service");
    await expect(backend.get(CREDENTIALS_SERVICE, "-w")).rejects.toThrow(
      "Invalid credential account",
    );
    await expect(backend.get(CREDENTIALS_SERVICE, "a b")).rejects.toThrow(
      "Invalid credential account",
    );
  });
});

describe("Linux Secret Service backend (fake secret-tool)", () => {
  it("stores from stdin, looks up and clears by service and account attributes", async () => {
    const items = new Map<string, string>();
    const tool = recordingRunner(({ args, stdin }) => {
      const key = `${args[args.indexOf("service") + 1]}/${args[args.indexOf("account") + 1]}`;
      if (args[0] === "store") {
        items.set(key, stdin ?? "");
        return { exitCode: 0, stdout: "" };
      }
      if (args[0] === "lookup") {
        const value = items.get(key);
        return value === undefined ? { exitCode: 1, stdout: "" } : { exitCode: 0, stdout: value };
      }
      if (args[0] === "clear") {
        items.delete(key);
        return { exitCode: 0, stdout: "" };
      }
      return { exitCode: 2, stdout: "" };
    });
    const backend = createLinuxSecretServiceBackend(tool.run);
    const account = randomUUID();

    await backend.set(CREDENTIALS_SERVICE, account, SECRET);
    await expect(backend.get(CREDENTIALS_SERVICE, account)).resolves.toBe(SECRET);
    await backend.delete(CREDENTIALS_SERVICE, account);
    await expect(backend.get(CREDENTIALS_SERVICE, account)).resolves.toBeNull();

    expect(tool.calls.every((call) => call.file === SECRET_TOOL_BINARY)).toBe(true);
    expect(tool.calls[0].stdin).toBe(SECRET);
    expectSecretNotInArgv(tool.calls);
  });

  it("reports a failed clear, and a clear that left the secret readable, instead of success", async () => {
    const failing = createLinuxSecretServiceBackend(
      recordingRunner(({ args }) =>
        args[0] === "clear" ? { exitCode: 1, stdout: "" } : { exitCode: 0, stdout: SECRET },
      ).run,
    );
    await expect(failing.delete(CREDENTIALS_SERVICE, "abc")).rejects.toThrow(
      "secret delete failed",
    );
    const silent = createLinuxSecretServiceBackend(
      recordingRunner(({ args }) =>
        args[0] === "clear" ? { exitCode: 0, stdout: "" } : { exitCode: 0, stdout: SECRET },
      ).run,
    );
    await expect(silent.delete(CREDENTIALS_SERVICE, "abc")).rejects.toThrow("secret delete failed");
  });

  it("reports a missing secret-tool and a failed store", async () => {
    const missing = createLinuxSecretServiceBackend(
      recordingRunner(() => ({ exitCode: 127, stdout: "" })).run,
    );
    await expect(missing.get(CREDENTIALS_SERVICE, "abc")).rejects.toThrow("secret-tool missing");
    await expect(missing.set(CREDENTIALS_SERVICE, "abc", SECRET)).rejects.toThrow(
      "secret store failed",
    );
  });
});

describe("Windows Credential Manager backend (fake PowerShell)", () => {
  it("sends the target and secret on stdin to a fixed encoded script", async () => {
    const items = new Map<string, string>();
    const shell = recordingRunner(({ stdin }) => {
      const request = JSON.parse(stdin ?? "{}") as { op: string; target: string; value?: string };
      if (request.op === "set") {
        items.set(request.target, request.value ?? "");
        return { exitCode: 0, stdout: "" };
      }
      if (request.op === "get") {
        const value = items.get(request.target);
        return value === undefined ? { exitCode: 44, stdout: "" } : { exitCode: 0, stdout: value };
      }
      if (request.op === "delete") {
        return items.delete(request.target)
          ? { exitCode: 0, stdout: "" }
          : { exitCode: 44, stdout: "" };
      }
      return { exitCode: 2, stdout: "" };
    });
    const backend = createWindowsCredentialManagerBackend(shell.run);
    const account = randomUUID();

    await backend.set(CREDENTIALS_SERVICE, account, SECRET);
    expect([...items.keys()]).toEqual([`${CREDENTIALS_SERVICE}/${account}`]);
    await expect(backend.get(CREDENTIALS_SERVICE, account)).resolves.toBe(SECRET);
    await backend.delete(CREDENTIALS_SERVICE, account);
    await expect(backend.get(CREDENTIALS_SERVICE, account)).resolves.toBeNull();

    expect(shell.calls.every((call) => call.file === POWERSHELL_BINARY)).toBe(true);
    // Every call runs the same script; only stdin differs.
    expect(new Set(shell.calls.map((call) => call.args.join(" "))).size).toBe(1);
    expectSecretNotInArgv(shell.calls);
  });
});

describe("Windows Credential Manager error mapping (fake PowerShell)", () => {
  it("treats only ERROR_NOT_FOUND as absent; any other failure is an error", async () => {
    const accessDenied = createWindowsCredentialManagerBackend(
      recordingRunner(() => ({ exitCode: 1, stdout: "" })).run,
    );
    await expect(accessDenied.get(CREDENTIALS_SERVICE, "abc")).rejects.toThrow(
      "credential read failed",
    );
    await expect(accessDenied.delete(CREDENTIALS_SERVICE, "abc")).rejects.toThrow(
      "credential delete failed",
    );
    const missing = createWindowsCredentialManagerBackend(
      recordingRunner(() => ({ exitCode: 44, stdout: "" })).run,
    );
    await expect(missing.get(CREDENTIALS_SERVICE, "abc")).resolves.toBeNull();
    await expect(missing.delete(CREDENTIALS_SERVICE, "abc")).resolves.toBeUndefined();
  });
});

describe("platform selection and memory backend", () => {
  it("picks the OS store per platform and none elsewhere", () => {
    expect(createPlatformCredentialBackend("darwin")?.kind).toBe("macos-keychain");
    expect(createPlatformCredentialBackend("win32")?.kind).toBe("windows-credential-manager");
    expect(createPlatformCredentialBackend("linux")?.kind).toBe("linux-secret-service");
    expect(createPlatformCredentialBackend("aix")).toBeNull();
  });

  it("keeps values in memory for tests", async () => {
    const backend = createMemoryCredentialBackend();
    await backend.set(CREDENTIALS_SERVICE, "abc", SECRET);
    await expect(backend.get(CREDENTIALS_SERVICE, "abc")).resolves.toBe(SECRET);
    await backend.delete(CREDENTIALS_SERVICE, "abc");
    await expect(backend.get(CREDENTIALS_SERVICE, "abc")).resolves.toBeNull();
  });
});

// One real round-trip through the login keychain, on a throwaway item in the ai.fulcra.test.*
// namespace that the test deletes. It never touches ai.fulcra.credentials or any existing item.
describe.runIf(process.platform === "darwin")("macOS keychain backend (real keychain)", () => {
  it("stores, reads, overwrites and deletes 4 KB tokens plus refresh JSON on a throwaway ai.fulcra.test item", async () => {
    const service = `ai.fulcra.test.backend-${randomUUID().slice(0, 8)}`;
    const account = randomUUID();
    const backend = createMacosKeychainBackend(runCommand);
    const large = JSON.stringify({
      accessToken: `CANARY-${"a".repeat(4089)}`,
      refreshToken: `CANARY-${"r".repeat(4089)}`,
      email: "fixture@example.test",
      scheme: "basic",
      note: "é漢字",
    });
    try {
      await expect(backend.get(service, account)).resolves.toBeNull();
      await backend.set(service, account, large);
      await expect(backend.get(service, account)).resolves.toBe(large);
      await backend.set(service, account, SECRET);
      await expect(backend.get(service, account)).resolves.toBe(SECRET);
    } finally {
      await backend.delete(service, account);
    }
    await expect(backend.get(service, account)).resolves.toBeNull();
  }, 60_000);
});
