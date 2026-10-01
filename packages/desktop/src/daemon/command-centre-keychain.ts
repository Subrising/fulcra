import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { CommandCentreKeychain } from "./command-centre-auth.js";
const execute = promisify(execFile);

export interface KeychainCommandResult {
  code: number | string | null;
  stdout: string;
  stderr: string;
}
export type KeychainCommand = (args: string[], input?: string) => Promise<KeychainCommandResult>;

function failure(result: KeychainCommandResult): string | null {
  // Never retain a tool error: it can include item attributes or the input value.
  if (/user interaction is not allowed|errSecInteractionNotAllowed|\b-25308\b/i.test(result.stderr))
    return "interaction-not-allowed";
  if (/errSecAuthFailed|\b-25293\b/i.test(result.stderr)) return "authentication-failed";
  if (/keychain.*locked/i.test(result.stderr)) return "keychain-locked";
  if (/errSecDuplicateItem|\b-25299\b/i.test(result.stderr)) return "duplicate-item";
  if (result.code !== 0) return "operation-failed";
  // security -i can exit zero after a command failed and a later quit succeeded.
  const diagnostic = result.stderr.replace(/security>\s*/g, "").trim();
  return diagnostic ? "operation-failed" : null;
}

export function createCommandCentreKeychain(
  command: KeychainCommand,
  platform: string = process.platform,
): CommandCentreKeychain {
  function validate(service: string) {
    if (platform !== "darwin") throw Error("Command Centre Keychain: unavailable-platform");
    if (!/^ai\.fulcra\.command-centre\.[a-f0-9]{64}$/.test(service))
      throw Error("Command Centre Keychain: invalid-service");
  }
  async function run(args: string[], input?: string) {
    try {
      return await command(args, input);
    } catch {
      // eslint-disable-next-line preserve-caught-error
      throw Error("Command Centre Keychain: operation-failed");
    }
  }
  return {
    async get(service) {
      validate(service);
      const result = await run(["find-generic-password", "-s", service, "-a", "daemon", "-w"]);
      if (result.code === 44) return null;
      const cause = failure(result);
      if (cause) throw Error(`Command Centre Keychain: ${cause}`);
      // Remove only the CLI terminator, not credential whitespace.
      return result.stdout.replace(/\r?\n$/, "");
    },
    async set(service, password) {
      validate(service);
      // Generated credentials are hex, never arbitrary setup tokens. This ensures
      // stdin cannot inject another security command; do not widen without replacing
      // the interactive adapter with a Security-framework implementation.
      if (!/^[a-f0-9]{64}$/.test(password))
        throw Error("Command Centre Keychain: invalid-generated-credential");
      const result = await run(
        ["-i"],
        `add-generic-password -U -s ${service} -a daemon -w ${password}\nquit\n`,
      );
      const cause = failure(result);
      if (cause) throw Error(`Command Centre Keychain: ${cause}`);
    },
  };
}

const command: KeychainCommand = async (args, input) => {
  if (input === undefined) {
    try {
      const result = await execute("/usr/bin/security", args, { timeout: 15000, maxBuffer: 4096 });
      return { code: 0, stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const result = error as { code?: number | string; stderr?: string };
      return { code: result.code ?? null, stdout: "", stderr: result.stderr ?? "" };
    }
  }
  return new Promise<KeychainCommandResult>((resolve) => {
    const child = spawn("/usr/bin/security", args, {
      stdio: ["pipe", "ignore", "pipe"],
      timeout: 15000,
      killSignal: "SIGKILL",
    });
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(0, 4096);
    });
    child.stdin.once("error", () => resolve({ code: null, stdout: "", stderr: "" }));
    child.once("error", () => resolve({ code: null, stdout: "", stderr: "" }));
    child.once("close", (code) => resolve({ code, stdout: "", stderr }));
    child.stdin.end(input);
  });
};
/** Tests inject a command adapter and never access an OS Keychain. */
export const commandCentreKeychain = createCommandCentreKeychain(command);
