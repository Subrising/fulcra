import { execFile } from "node:child_process";

// Shared credential store secrets live in the OS credential store under one service name, with the
// account id as the item name. Every backend passes secret values over stdin and
// never in argv, where other local users could read them from the process table.
export const CREDENTIALS_SERVICE = "ai.fulcra.credentials";

export interface CredentialBackend {
  readonly kind:
    | "macos-keychain"
    | "windows-credential-manager"
    | "linux-secret-service"
    | "memory";
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

export class CredentialBackendUnavailableError extends Error {
  constructor(detail: string) {
    super(`The credential store is unavailable: ${detail}`);
    this.name = "CredentialBackendUnavailableError";
  }
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
}

export type CommandRunner = (
  file: string,
  args: string[],
  stdin?: string,
) => Promise<CommandResult>;

const SERVICE_PATTERN = /^ai\.fulcra\.[a-z0-9.-]{1,120}$/;
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.:_-]{0,127}$/;
const MAX_VALUE_LENGTH = 16_384;

function assertItem(service: string, account: string): void {
  if (!SERVICE_PATTERN.test(service)) throw new Error("Invalid credential service name");
  if (!ACCOUNT_PATTERN.test(account)) throw new Error("Invalid credential account name");
}

function assertValue(value: string): void {
  if (!value || value.length > MAX_VALUE_LENGTH) throw new Error("Invalid credential value");
}

// Only what the platform tools need: secret-tool reaches the session bus through the DBus/XDG
// variables, and PowerShell needs the Windows system directories.
const PASSED_ENVIRONMENT = [
  "PATH",
  "HOME",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "SystemRoot",
  "windir",
  "TEMP",
  "TMP",
  "USERPROFILE",
] as const;

function commandEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASSED_ENVIRONMENT) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

// stderr is discarded: `security` prints item attributes there and nothing from it is needed.
// A hung tool is killed after 15 s and reported as a failure.
export function runCommand(file: string, args: string[], stdin?: string): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        env: commandEnvironment(),
        timeout: 15_000,
        killSignal: "SIGKILL",
        maxBuffer: 65_536,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout) => {
        if (!error) {
          resolve({ exitCode: 0, stdout });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") resolve({ exitCode: 127, stdout: "" });
        else resolve({ exitCode: typeof error.code === "number" ? error.code : 1, stdout: "" });
      },
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(stdin ?? "");
  });
}

function stripTrailingNewline(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  return value.endsWith("\n") ? value.slice(0, -1) : value;
}

// ---------------------------------------------------------------------------------------------
// macOS Keychain. The shared credential store goes through a small JavaScript-for-Automation helper
// run by /usr/bin/osascript (present on every Mac) that calls the Security framework directly
// (SecItemCopyMatching/Update/Add/Delete). The request, including the secret, arrives on stdin as JSON,
// so there is no argv exposure and no command-line length limit: `security -i` could not store an
// access token plus refresh token of a few kilobytes. Items keep the helper as their trusted reader.
//
// Legacy plugin items (`ai.fulcra.plugin.<id>`) were created with `security add-generic-password`,
// whose access list trusts only /usr/bin/security; they are read (never written) with that tool so
// the import does not raise a keychain prompt.
export const SECURITY_BINARY = "/usr/bin/security";
export const OSASCRIPT_BINARY = "/usr/bin/osascript";
const KEYCHAIN_NOT_FOUND = 44;
const LEGACY_PLUGIN_SERVICE = /^ai\.fulcra\.plugin\./;

// Security framework dictionary keys by value: JXA does not bridge the kSec* CF constants.
export const MACOS_KEYCHAIN_HELPER = String.raw`
ObjC.import("Foundation");
ObjC.import("Security");
function run() {
  const input = $.NSString.alloc.initWithDataEncoding(
    $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, $.NSUTF8StringEncoding).js;
  const req = JSON.parse(input);
  const q = $.NSMutableDictionary.alloc.init;
  q.setObjectForKey($("genp"), $("class"));
  q.setObjectForKey($(req.service), $("svce"));
  q.setObjectForKey($(req.account), $("acct"));
  if (req.op === "get") {
    q.setObjectForKey($.NSNumber.numberWithBool(true), $("r_Data"));
    q.setObjectForKey($("m_LimitOne"), $("m_Limit"));
    const out = Ref();
    const status = $.SecItemCopyMatching(q, out);
    if (status === -25300) return JSON.stringify({ status: "absent" });
    if (status !== 0) return JSON.stringify({ status: "error", code: status });
    const data = ObjC.castRefToObject(out[0]);
    return JSON.stringify({ status: "ok", value: $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js });
  }
  if (req.op === "delete") {
    const status = $.SecItemDelete(q);
    if (status === 0 || status === -25300) return JSON.stringify({ status: "ok" });
    return JSON.stringify({ status: "error", code: status });
  }
  if (req.op === "set") {
    const data = $(req.value).dataUsingEncoding($.NSUTF8StringEncoding);
    const update = $.NSMutableDictionary.alloc.init;
    update.setObjectForKey(data, $("v_Data"));
    let status = $.SecItemUpdate(q, update);
    if (status === -25300) {
      q.setObjectForKey(data, $("v_Data"));
      q.setObjectForKey($(req.service), $("labl"));
      status = $.SecItemAdd(q, null);
    }
    return JSON.stringify(status === 0 ? { status: "ok" } : { status: "error", code: status });
  }
  return JSON.stringify({ status: "error", code: "op" });
}
`;

type HelperReply = { status: "ok"; value?: string } | { status: "absent" } | { status: "error" };

export function createMacosKeychainBackend(run: CommandRunner = runCommand): CredentialBackend {
  async function helper(request: Record<string, string>): Promise<HelperReply> {
    const result = await run(
      OSASCRIPT_BINARY,
      ["-l", "JavaScript", "-e", MACOS_KEYCHAIN_HELPER],
      JSON.stringify(request),
    );
    if (result.exitCode !== 0) return { status: "error" };
    try {
      return JSON.parse(result.stdout) as HelperReply;
    } catch {
      return { status: "error" };
    }
  }
  async function readLegacy(service: string, account: string): Promise<string | null> {
    const result = await run(SECURITY_BINARY, [
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
      "-w",
    ]);
    if (result.exitCode === KEYCHAIN_NOT_FOUND) return null;
    if (result.exitCode !== 0) throw new CredentialBackendUnavailableError("keychain read failed");
    return stripTrailingNewline(result.stdout);
  }
  async function get(service: string, account: string): Promise<string | null> {
    assertItem(service, account);
    if (LEGACY_PLUGIN_SERVICE.test(service)) return readLegacy(service, account);
    const reply = await helper({ op: "get", service, account });
    if (reply.status === "absent") return null;
    if (reply.status !== "ok" || typeof reply.value !== "string") {
      throw new CredentialBackendUnavailableError("keychain read failed");
    }
    return reply.value;
  }
  function assertWritable(service: string): void {
    if (LEGACY_PLUGIN_SERVICE.test(service)) throw new Error("Plugin keychain items are read-only");
  }
  return {
    kind: "macos-keychain",
    get,
    async set(service, account, value) {
      assertItem(service, account);
      assertValue(value);
      assertWritable(service);
      const reply = await helper({ op: "set", service, account, value });
      if (reply.status !== "ok" || (await get(service, account)) !== value) {
        throw new CredentialBackendUnavailableError("keychain write failed");
      }
    },
    async delete(service, account) {
      assertItem(service, account);
      assertWritable(service);
      const reply = await helper({ op: "delete", service, account });
      // Removal counts only once a read confirms the item is gone.
      if (reply.status !== "ok" || (await get(service, account)) !== null) {
        throw new CredentialBackendUnavailableError("keychain delete failed");
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Linux Secret Service through libsecret's `secret-tool`. `store` reads the secret from stdin.
// `lookup` exits 1 both for "not found" and for failures, so an unreachable service reads as absent.
// `clear` exits 0 whether or not an item matched and 1 on a service error, so a delete fails on a
// non-zero exit and is then confirmed by a lookup that must find nothing.
export const SECRET_TOOL_BINARY = "secret-tool";

export function createLinuxSecretServiceBackend(
  run: CommandRunner = runCommand,
): CredentialBackend {
  const attributes = (service: string, account: string) => ["service", service, "account", account];
  async function get(service: string, account: string): Promise<string | null> {
    assertItem(service, account);
    const result = await run(SECRET_TOOL_BINARY, ["lookup", ...attributes(service, account)]);
    if (result.exitCode === 127) throw new CredentialBackendUnavailableError("secret-tool missing");
    if (result.exitCode !== 0 || !result.stdout) return null;
    return stripTrailingNewline(result.stdout);
  }
  return {
    kind: "linux-secret-service",
    get,
    async set(service, account, value) {
      assertItem(service, account);
      assertValue(value);
      const result = await run(
        SECRET_TOOL_BINARY,
        ["store", `--label=${service} ${account}`, ...attributes(service, account)],
        value,
      );
      if (result.exitCode !== 0) throw new CredentialBackendUnavailableError("secret store failed");
    },
    async delete(service, account) {
      assertItem(service, account);
      const result = await run(SECRET_TOOL_BINARY, ["clear", ...attributes(service, account)]);
      if (result.exitCode === 127)
        throw new CredentialBackendUnavailableError("secret-tool missing");
      if (result.exitCode !== 0 || (await get(service, account)) !== null) {
        throw new CredentialBackendUnavailableError("secret delete failed");
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Windows Credential Manager through PowerShell and the Win32 CredRead/CredWrite/CredDelete API.
// The script is fixed; the target name and the secret arrive on stdin as one JSON line, so neither
// is interpolated into code or argv. Generic credentials, persisted for the local machine user.
// Only ERROR_NOT_FOUND (1168) is reported as "absent" (exit 44); any other failure is exit 1, so an
// access or service error is never mistaken for a missing item.
export const POWERSHELL_BINARY = "powershell.exe";

const WINDOWS_CREDENTIAL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class FulcraCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredWrite(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CredDelete(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr cred);
}
"@
$request = [Console]::In.ReadLine() | ConvertFrom-Json
if ($request.op -eq 'get') {
  $ptr = [IntPtr]::Zero
  if (-not [FulcraCred]::CredRead($request.target, 1, 0, [ref]$ptr)) {
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 44 }
    exit 1
  }
  $cred = [Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][FulcraCred+CREDENTIAL])
  $value = [Runtime.InteropServices.Marshal]::PtrToStringUni($cred.CredentialBlob, $cred.CredentialBlobSize / 2)
  [FulcraCred]::CredFree($ptr)
  [Console]::Out.Write($value)
  exit 0
}
if ($request.op -eq 'set') {
  $bytes = [Text.Encoding]::Unicode.GetBytes([string]$request.value)
  $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
  $cred = New-Object FulcraCred+CREDENTIAL
  $cred.Type = 1; $cred.TargetName = $request.target; $cred.UserName = $request.account
  $cred.CredentialBlob = $blob; $cred.CredentialBlobSize = $bytes.Length; $cred.Persist = 2
  $ok = [FulcraCred]::CredWrite([ref]$cred, 0)
  [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
  if (-not $ok) { exit 1 }
  exit 0
}
if ($request.op -eq 'delete') {
  if (-not [FulcraCred]::CredDelete($request.target, 1, 0)) {
    if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 44 }
    exit 1
  }
  exit 0
}
exit 2
`;

export function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function createWindowsCredentialManagerBackend(
  run: CommandRunner = runCommand,
): CredentialBackend {
  const encoded = encodePowerShellCommand(WINDOWS_CREDENTIAL_SCRIPT);
  const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
  const target = (service: string, account: string) => `${service}/${account}`;
  return {
    kind: "windows-credential-manager",
    async get(service, account) {
      assertItem(service, account);
      const request = JSON.stringify({ op: "get", target: target(service, account) });
      const result = await run(POWERSHELL_BINARY, args, `${request}\n`);
      if (result.exitCode === 44) return null;
      if (result.exitCode !== 0)
        throw new CredentialBackendUnavailableError("credential read failed");
      return result.stdout;
    },
    async set(service, account, value) {
      assertItem(service, account);
      assertValue(value);
      const request = JSON.stringify({
        op: "set",
        target: target(service, account),
        account,
        value,
      });
      const result = await run(POWERSHELL_BINARY, args, `${request}\n`);
      if (result.exitCode !== 0)
        throw new CredentialBackendUnavailableError("credential write failed");
    },
    async delete(service, account) {
      assertItem(service, account);
      const request = JSON.stringify({ op: "delete", target: target(service, account) });
      const result = await run(POWERSHELL_BINARY, args, `${request}\n`);
      if (result.exitCode !== 0 && result.exitCode !== 44) {
        throw new CredentialBackendUnavailableError("credential delete failed");
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
export function createMemoryCredentialBackend(
  initial: Record<string, string> = {},
): CredentialBackend & { items: Map<string, string> } {
  const items = new Map(Object.entries(initial));
  return {
    kind: "memory",
    items,
    async get(service, account) {
      assertItem(service, account);
      return items.get(`${service}/${account}`) ?? null;
    },
    async set(service, account, value) {
      assertItem(service, account);
      assertValue(value);
      items.set(`${service}/${account}`, value);
    },
    async delete(service, account) {
      assertItem(service, account);
      items.delete(`${service}/${account}`);
    },
  };
}

export function createPlatformCredentialBackend(
  platform: NodeJS.Platform = process.platform,
  run: CommandRunner = runCommand,
): CredentialBackend | null {
  if (platform === "darwin") return createMacosKeychainBackend(run);
  if (platform === "win32") return createWindowsCredentialManagerBackend(run);
  if (platform === "linux") return createLinuxSecretServiceBackend(run);
  return null;
}
