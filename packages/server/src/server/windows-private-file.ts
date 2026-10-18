import { spawnSync } from "node:child_process";
import path from "node:path";

// Windows PowerShell 5.1 ships with Windows. No native Node addon is required.
// Flush(true) commits file bytes; MoveFileExW(9) commits the same-directory rename.
// https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw
const commitScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
public static class FulcraPrivateCommit {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  private static extern bool MoveFileExW(string source, string target, uint flags);
  public static void Write(string target, string content) {
    string parent = Path.GetDirectoryName(target);
    string temporary = Path.Combine(parent, ".fulcra-" + Guid.NewGuid().ToString("N"));
    var owner = WindowsIdentity.GetCurrent().User;
    var security = new FileSecurity();
    security.SetOwner(owner);
    security.SetAccessRuleProtection(true, false);
    security.AddAccessRule(new FileSystemAccessRule(owner, FileSystemRights.FullControl, AccessControlType.Allow));
    try {
      using (var file = new FileStream(temporary, FileMode.CreateNew, FileSystemRights.FullControl,
          FileShare.None, 4096, FileOptions.None, security)) {
        byte[] bytes = Convert.FromBase64String(content);
        file.Write(bytes, 0, bytes.Length);
        file.Flush(true);
      }
      // No COPY_ALLOWED: a cross-volume copy cannot replace the atomic rename.
      if (!MoveFileExW(temporary, target, 0x1 | 0x8))
        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      if (File.Exists(temporary)) File.Delete(temporary);
    }
  }
}
'@
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  [FulcraPrivateCommit]::Write($request.path, $request.content)
  exit 0
} catch {
  # Do not write exception text: requests can contain credentials and private paths.
  [Console]::Error.WriteLine('Windows durable file commit failed.')
  exit 1
}
`;

export function writeWindowsPrivateFileAtomicSync(
  filePath: string,
  data: string | NodeJS.ArrayBufferView,
): void {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("Windows SystemRoot is unavailable.");
  const bytes =
    typeof data === "string"
      ? Buffer.from(data)
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const result = spawnSync(
    path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(commitScript, "utf16le").toString("base64"),
    ],
    {
      input: JSON.stringify({ path: path.resolve(filePath), content: bytes.toString("base64") }),
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  // A timeout can follow a successful rename. The caller retains its receipt and reconciles.
  if (result.error || result.signal || result.status !== 0)
    throw new Error("Windows durable file commit failed.");
}
