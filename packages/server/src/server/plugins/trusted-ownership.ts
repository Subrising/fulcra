import { execFileSync } from "node:child_process";
import type { Stats } from "node:fs";
import path from "node:path";

// Windows files carry no POSIX uid or mode, so ownership is proved from the ACL instead: the owner must be this user,
// SYSTEM, Administrators or TrustedInstaller (root or this user on POSIX), and no other principal may hold a write,
// delete, change-permissions or take-ownership right, including GENERIC_ALL and GENERIC_WRITE. SIDs only, no name
// translation (language independent; an unresolvable principal cannot throw); InheritOnly entries are skipped.
export const WINDOWS_WRITE_MASK = 852310 + 0x10000000 + 0x40000000;
const WINDOWS_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$p = $env:FULCRA_TRUST_PATH
$mask = [long]$env:FULCRA_TRUST_MASK
$acl = Get-Acl -LiteralPath $p
$sid = [Security.Principal.SecurityIdentifier]
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$ok = @($me, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
if ($ok -notcontains $acl.GetOwner($sid).Value) { 'UNSAFE'; exit 0 }
foreach ($r in $acl.GetAccessRules($true, $true, $sid)) {
  if ($r.AccessControlType -ne 'Allow') { continue }
  if ($r.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
  if ($ok -contains $r.IdentityReference.Value) { continue }
  $rights = [long][BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$r.FileSystemRights), 0)
  if (($rights -band $mask) -ne 0) { 'UNSAFE'; exit 0 }
}
'SAFE'
`;

/** The absolute Windows PowerShell path. A bare "powershell.exe" would run one planted in the current folder. */
export function windowsPowershell(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(
    env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

export type WindowsAclProbe = (file: string) => boolean;

/** True when the Windows ACL says only this user or the OS can change `file`. Fails closed. */
export const windowsAclIsSafe: WindowsAclProbe = (file) => {
  try {
    const out = execFileSync(
      windowsPowershell(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_ACL_SCRIPT],
      {
        env: { ...process.env, FULCRA_TRUST_PATH: file, FULCRA_TRUST_MASK: String(WINDOWS_WRITE_MASK) },
        encoding: "utf8",
        timeout: 20000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return out.trim() === "SAFE";
  } catch {
    return false;
  }
};

/**
 * True when a trusted-distribution path must be refused. POSIX: group/other write bit, or an owner
 * that is neither root nor this user (`checkOwner: false` keeps the mode-only rule some callers use).
 * Windows: the ACL rule above.
 */
export function unsafeOwnership(
  file: string,
  stat: Stats,
  options: {
    checkOwner?: boolean;
    platform?: NodeJS.Platform;
    aclIsSafe?: WindowsAclProbe;
  } = {},
): boolean {
  const { checkOwner = true, platform = process.platform, aclIsSafe = windowsAclIsSafe } = options;
  if (platform === "win32") return !aclIsSafe(file);
  if (stat.mode & 0o022) return true;
  return checkOwner && stat.uid !== 0 && stat.uid !== process.getuid?.();
}
