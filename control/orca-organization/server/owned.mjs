import { execFileSync } from "node:child_process";

// "Owned by this user and private" checks, in one place.
//   POSIX:   the file uid and mode bits, exactly as the call sites always checked them.
//   Windows: there is no uid or mode, so the ACL decides. The owner must be this user, SYSTEM, Administrators or
//            TrustedInstaller, and no other principal may hold a right in the mask. Anything unreadable fails closed.
// FileSystemRights masks: WRITE = WriteData|AppendData|WriteExtendedAttributes|DeleteSubdirectoriesAndFiles|
// WriteAttributes|Delete|ChangePermissions|TakeOwnership. PRIVATE adds ReadData|ReadExtendedAttributes|ExecuteFile.
const WRITE_MASK = 852310;
const PRIVATE_MASK = WRITE_MASK | 1 | 8 | 32;

const SCRIPT = `
$ErrorActionPreference = 'Stop'
$p = $env:FULCRA_ACL_PATH
$mask = [int]$env:FULCRA_ACL_MASK
$acl = Get-Acl -LiteralPath $p
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$ok = @($me, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$sid = [Security.Principal.SecurityIdentifier]
if ($ok -notcontains $acl.GetOwner($sid).Value) { 'UNSAFE'; exit 0 }
foreach ($r in $acl.Access) {
  if ($r.AccessControlType -ne 'Allow') { continue }
  if (($ok -notcontains $r.IdentityReference.Translate($sid).Value) -and (([int]$r.FileSystemRights -band $mask) -ne 0)) { 'UNSAFE'; exit 0 }
}
'SAFE'
`;

/** Runs the ACL rule for one path. Returns true only for a clear SAFE answer. */
export function windowsAclProbe(file, mask) {
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT],
      {
        env: { ...process.env, FULCRA_ACL_PATH: file, FULCRA_ACL_MASK: String(mask) },
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
function windowsSafe(file, stat, mask, probe) {
  // An ACL change moves ctime, so a cached answer never outlives the state it described.
  const key = `${mask}|${file}|${stat?.ino}|${stat?.ctimeMs}|${stat?.mtimeMs}`;
  if (!cache.has(key)) {
    if (cache.size > 2000) cache.clear();
    cache.set(key, probe(file, mask) === true);
  }
  return cache.get(key);
}

const uid = () => process.getuid?.();

/** True when this user owns the file. POSIX: uid. Windows: the ACL owner rule, with no limit on other principals. */
export function ownedByMe(stat, file, { platform = process.platform, probe = windowsAclProbe } = {}) {
  if (platform === "win32") return windowsSafe(file, stat, 0, probe);
  return stat.uid === uid();
}

/** True when this user owns the file and nobody else has any access. POSIX: uid and no group/other mode bits. */
export function privateOwned(stat, file, { platform = process.platform, probe = windowsAclProbe } = {}) {
  if (platform === "win32") return windowsSafe(file, stat, PRIVATE_MASK, probe);
  return stat.uid === uid() && (stat.mode & 0o077) === 0;
}

/** True when this user (or root) owns the file and nobody else can change it. For code that will be run or trusted. */
export function trustedCode(stat, file, { platform = process.platform, probe = windowsAclProbe } = {}) {
  if (platform === "win32") return windowsSafe(file, stat, WRITE_MASK, probe);
  return (stat.mode & 0o022) === 0 && [0, uid()].includes(stat.uid);
}
