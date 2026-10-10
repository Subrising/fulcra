import { execFileSync } from "node:child_process";
import path from "node:path";

// "Owned by this user and private" checks, in one place.
//   POSIX:   the file uid and mode bits, exactly as the call sites always checked them.
//   Windows: there is no uid or mode, so the ACL decides.
//            ownedByMe and privateOwned: the owner must be exactly this user (as POSIX accepts only this uid).
//            trustedCode: the owner may also be SYSTEM, Administrators or TrustedInstaller (as POSIX also accepts root).
//            In every case no other principal may hold a right in the mask; ACE holders may be this user, SYSTEM,
//            Administrators or TrustedInstaller. Anything unreadable fails closed.
// Rights masks (FileSystemRights): WRITE = WriteData|AppendData|WriteExtendedAttributes|DeleteSubdirectoriesAndFiles|
// WriteAttributes|Delete|ChangePermissions|TakeOwnership plus GENERIC_ALL and GENERIC_WRITE. PRIVATE adds ReadData|
// ReadExtendedAttributes|ExecuteFile and GENERIC_READ and GENERIC_EXECUTE. Sums, not bit-or: JS bit-or is signed 32-bit.
export const WRITE_MASK = 852310 + 0x10000000 + 0x40000000;
export const PRIVATE_MASK = WRITE_MASK + (1 + 8 + 32) + 0x80000000 + 0x20000000;

/** The absolute Windows PowerShell path. A bare "powershell.exe" would run one planted in the current folder. */
export function powershellExe(env = process.env) {
  return path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

// SIDs only (GetOwner and GetAccessRules with SecurityIdentifier): no name translation, so it is language independent
// and an unresolvable principal (for example ALL APPLICATION PACKAGES) cannot throw. InheritOnly entries do not apply
// to the object itself and are skipped.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
$p = $env:FULCRA_ACL_PATH
$mask = [long]$env:FULCRA_ACL_MASK
$acl = Get-Acl -LiteralPath $p
$sid = [Security.Principal.SecurityIdentifier]
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($me, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$owners = if ($env:FULCRA_ACL_OWNER -eq 'me') { @($me) } else { $trusted }
if ($owners -notcontains $acl.GetOwner($sid).Value) { 'UNSAFE'; exit 0 }
foreach ($r in $acl.GetAccessRules($true, $true, $sid)) {
  if ($r.AccessControlType -ne 'Allow') { continue }
  if ($r.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
  if ($trusted -contains $r.IdentityReference.Value) { continue }
  $rights = [long][BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$r.FileSystemRights), 0)
  if (($rights -band $mask) -ne 0) { 'UNSAFE'; exit 0 }
}
'SAFE'
`;

/** Runs the ACL rule for one path. owner is "me" or "trusted". Returns true only for a clear SAFE answer. */
export function windowsAclProbe(file, mask, owner = "trusted") {
  try {
    const out = execFileSync(
      powershellExe(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT],
      {
        env: {
          ...process.env,
          FULCRA_ACL_PATH: file,
          FULCRA_ACL_MASK: String(mask),
          FULCRA_ACL_OWNER: owner,
        },
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
}

const cache = new Map();
function windowsSafe(file, stat, mask, owner, probe) {
  // An ACL change moves ctime, so a cached answer never outlives the state it described.
  const key = `${owner}|${mask}|${file}|${stat?.ino}|${stat?.ctimeMs}|${stat?.mtimeMs}`;
  if (!cache.has(key)) {
    if (cache.size > 2000) cache.clear();
    cache.set(key, probe(file, mask, owner) === true);
  }
  return cache.get(key);
}

const uid = () => process.getuid?.();

/** True when this user owns the file. POSIX: uid. Windows: this user is exactly the ACL owner; others are not limited. */
export function ownedByMe(stat, file, { platform = process.platform, probe = windowsAclProbe } = {}) {
  if (platform === "win32") return windowsSafe(file, stat, 0, "me", probe);
  return stat.uid === uid();
}

/** True when this user owns the file and nobody else has any access. POSIX: uid and no group/other mode bits. */
export function privateOwned(stat, file, { platform = process.platform, probe = windowsAclProbe } = {}) {
  if (platform === "win32") return windowsSafe(file, stat, PRIVATE_MASK, "me", probe);
  return stat.uid === uid() && (stat.mode & 0o077) === 0;
}

/** True when this user (or root) owns the file and nobody else can change it. For code that will be run or trusted. */
export function trustedCode(stat, file, { platform = process.platform, probe = windowsAclProbe } = {}) {
  if (platform === "win32") return windowsSafe(file, stat, WRITE_MASK, "trusted", probe);
  return (stat.mode & 0o022) === 0 && [0, uid()].includes(stat.uid);
}
