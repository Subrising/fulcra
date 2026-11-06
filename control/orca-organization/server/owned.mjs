import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  return path.win32.join(
    env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

// SIDs only (GetOwner and GetAccessRules with SecurityIdentifier): no name translation, so it is language independent
// and an unresolvable principal (for example ALL APPLICATION PACKAGES) cannot throw. InheritOnly entries (flag 2) do not apply
// to the object itself and are skipped; the flag is tested as an integer, never as an enum.
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
  if (([int]$r.PropagationFlags -band 2) -ne 0) { continue }
  if ($trusted -contains $r.IdentityReference.Value) { continue }
  $rights = [long][BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$r.FileSystemRights), 0)
  if (($rights -band $mask) -ne 0) { 'UNSAFE'; exit 0 }
}
'SAFE'
`;

/** Runs the ACL rule for one path. owner is "me" or "trusted". true for SAFE, false for UNSAFE, undefined otherwise.
 * runFile is for tests only (an execFileSync stand-in; no shell). */
export function windowsAclProbe(file, mask, owner = "trusted", runFile = execFileSync) {
  try {
    const out = runFile(
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
        // FU-678 wanted no console window: windowsHide gives CREATE_NO_WINDOW. FU-714: never add detached here.
        // libuv maps it to DETACHED_PROCESS, and powershell.exe then writes nothing to the pipe, so every
        // private path refuses and the daemon cannot start on Windows.
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    // FU-716: only the two script answers are definite. Empty or other output (for example a PowerShell
    // that wrote nothing) is not an answer: it refuses as undefined and is never saved.
    const answer = out.trim();
    if (answer === "SAFE") return true;
    if (answer === "UNSAFE") return false;
    return undefined;
  } catch {
    // An error is not an answer: the caller refuses, and does not save it.
    return undefined;
  }
}

const cache = new Map();
const STORE_LIMIT = 2000;

/** FU-678: a plugin start is a new process, so the answers also live in a small file shared by all of them. */
export function aclCacheFile(env = process.env) {
  // No per-user folder means no file: a shared folder such as C:\Windows\Temp lets another user plant SAFE answers.
  const local = env.LOCALAPPDATA;
  if (!local || !path.win32.isAbsolute(local)) return undefined;
  // FU-716: v2, so no false saved by the detached 0.2.44 RC1 build (empty output) is read again.
  return path.win32.join(local, "Fulcra", "acl-cache-v2.json");
}
/** With no file, the store keeps answers in memory only. */
export function fileStore(file) {
  let loaded;
  const load = () => {
    if (loaded) return loaded;
    loaded = new Map();
    if (!file) return loaded;
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      for (const [k, v] of Object.entries(data)) if (typeof v === "boolean") loaded.set(k, v);
    } catch {
      /* No file, or a damaged file: start empty. A missing answer only means one more check. */
    }
    return loaded;
  };
  return {
    get: (key) => load().get(key),
    set: (key, value) => {
      const map = load();
      if (map.size > STORE_LIMIT) map.clear();
      map.set(key, value);
      if (!file) return;
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        const temp = `${file}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(Object.fromEntries(map)), { mode: 0o600 });
        renameSync(temp, file);
      } catch {
        /* A cache that cannot be saved costs one more check; it never changes an answer. */
      }
    },
  };
}
let defaultStore;
/** For tests: forget the in-process answers, as a new process would. */
export function resetAclMemoryCache() {
  cache.clear();
}
function windowsSafe(file, stat, mask, owner, probe, store) {
  // Without a file state there is nothing to bind an answer to, so always check.
  if (!stat) return probe(file, mask, owner) === true;
  // An ACL change moves ctime, so a cached answer never outlives the state it described.
  const key = `${owner}|${mask}|${file}|${stat.ino}|${stat.ctimeMs}|${stat.mtimeMs}`;
  if (cache.has(key)) return cache.get(key);
  const shared =
    store ?? (probe === windowsAclProbe ? (defaultStore ??= fileStore(aclCacheFile())) : undefined);
  let answer = shared?.get(key);
  if (typeof answer !== "boolean") {
    const result = probe(file, mask, owner);
    if (result === undefined) return false;
    answer = result === true;
    shared?.set(key, answer);
  }
  if (cache.size > STORE_LIMIT) cache.clear();
  cache.set(key, answer);
  return answer;
}

const uid = () => process.getuid?.();

/** True when this user owns the file. POSIX: uid. Windows: this user is exactly the ACL owner; others are not limited. */
export function ownedByMe(
  stat,
  file,
  { platform = process.platform, probe = windowsAclProbe, store } = {},
) {
  if (platform === "win32") return windowsSafe(file, stat, 0, "me", probe, store);
  return stat.uid === uid();
}

/** True when this user owns the file and nobody else has any access. POSIX: uid and no group/other mode bits. */
export function privateOwned(
  stat,
  file,
  { platform = process.platform, probe = windowsAclProbe, store } = {},
) {
  if (platform === "win32") return windowsSafe(file, stat, PRIVATE_MASK, "me", probe, store);
  return stat.uid === uid() && (stat.mode & 0o077) === 0;
}

/** True when this user (or root) owns the file and nobody else can change it. For code that will be run or trusted. */
export function trustedCode(
  stat,
  file,
  { platform = process.platform, probe = windowsAclProbe, store } = {},
) {
  if (platform === "win32") return windowsSafe(file, stat, WRITE_MASK, "trusted", probe, store);
  return (stat.mode & 0o022) === 0 && [0, uid()].includes(stat.uid);
}
