import { execFileSync } from "node:child_process";
import type { Stats } from "node:fs";

// Windows files carry no POSIX uid or mode, so ownership is proved from the ACL instead: the owner
// must be this user, SYSTEM, Administrators or TrustedInstaller, and no other principal may hold a
// write, delete, change-permissions or take-ownership right. 852310 is that set of FileSystemRights.
const WINDOWS_ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$p = $env:FULCRA_TRUST_PATH
$acl = Get-Acl -LiteralPath $p
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$ok = @($me, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$sid = [Security.Principal.SecurityIdentifier]
if ($ok -notcontains $acl.GetOwner($sid).Value) { 'UNSAFE'; exit 0 }
foreach ($r in $acl.Access) {
  if ($r.AccessControlType -ne 'Allow') { continue }
  if (($ok -notcontains $r.IdentityReference.Translate($sid).Value) -and (([int]$r.FileSystemRights -band 852310) -ne 0)) { 'UNSAFE'; exit 0 }
}
'SAFE'
`;

export type WindowsAclProbe = (file: string) => boolean;

/** True when the Windows ACL says only this user or the OS can change `file`. Fails closed. */
export const windowsAclIsSafe: WindowsAclProbe = (file) => {
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS_ACL_SCRIPT],
      { env: { ...process.env, FULCRA_TRUST_PATH: file }, encoding: "utf8", timeout: 20000, windowsHide: true },
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
