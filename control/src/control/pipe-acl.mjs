import { execFile } from "node:child_process";
import { powershellExe } from "../../orca-organization/server/owned.mjs";

// Windows named pipes: Node creates the pipe with the default security descriptor, which also lets Everyone open it
// for reading. This replaces the DACL with exactly SYSTEM, Administrators and this user (protected, no inheritance),
// then reads it back and refuses anything wider. Fails closed: the caller must not serve on a pipe this cannot secure.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public class FulcraPipe{
[DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)]public static extern IntPtr CreateFile(string n,uint a,uint s,IntPtr sa,uint d,uint f,IntPtr t);
[DllImport("kernel32.dll")]public static extern bool CloseHandle(IntPtr h);
[DllImport("kernel32.dll")]public static extern IntPtr LocalFree(IntPtr h);
[DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string s,uint r,out IntPtr sd,out uint l);
[DllImport("advapi32.dll")]public static extern bool GetSecurityDescriptorDacl(IntPtr sd,out bool present,out IntPtr dacl,out bool defaulted);
[DllImport("advapi32.dll")]public static extern uint SetSecurityInfo(IntPtr h,int t,uint i,IntPtr o,IntPtr g,IntPtr d,IntPtr s);
[DllImport("advapi32.dll")]public static extern uint GetSecurityInfo(IntPtr h,int t,uint i,out IntPtr o,out IntPtr g,out IntPtr d,out IntPtr s,out IntPtr sd);
[DllImport("advapi32.dll",CharSet=CharSet.Unicode)]public static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr sd,uint r,uint i,out IntPtr s,out uint l);
}
'@
$name = $env:FULCRA_PIPE_NAME
$me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sddl = "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;$me)"
$h = [FulcraPipe]::CreateFile($name, 0x60000, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)
if ($h -eq [IntPtr](-1)) { throw 'cannot open pipe' }
try {
  $sd = [IntPtr]::Zero; $len = [uint32]0
  if (-not [FulcraPipe]::ConvertStringSecurityDescriptorToSecurityDescriptor($sddl, 1, [ref]$sd, [ref]$len)) { throw 'bad sddl' }
  $present = $false; $dacl = [IntPtr]::Zero; $def = $false
  [FulcraPipe]::GetSecurityDescriptorDacl($sd, [ref]$present, [ref]$dacl, [ref]$def) | Out-Null
  if ([FulcraPipe]::SetSecurityInfo($h, 6, [uint32]2147483652, [IntPtr]::Zero, [IntPtr]::Zero, $dacl, [IntPtr]::Zero) -ne 0) { throw 'set failed' }
  $o=[IntPtr]::Zero;$g=[IntPtr]::Zero;$d=[IntPtr]::Zero;$s=[IntPtr]::Zero;$rsd=[IntPtr]::Zero
  if ([FulcraPipe]::GetSecurityInfo($h, 6, 4, [ref]$o, [ref]$g, [ref]$d, [ref]$s, [ref]$rsd) -ne 0) { throw 'read failed' }
  $p = [IntPtr]::Zero; $l = [uint32]0
  [FulcraPipe]::ConvertSecurityDescriptorToStringSecurityDescriptor($rsd, 1, 4, [ref]$p, [ref]$l) | Out-Null
  "ME=$me"
  "SDDL=" + [Runtime.InteropServices.Marshal]::PtrToStringUni($p)
} finally { [FulcraPipe]::CloseHandle($h) | Out-Null }
`;

/** Pure check on the SDDL read back from the pipe: protected DACL, only allowed SIDs, no deny tricks. */
export function pipeDaclIsPrivate(sddl, me) {
  const match = /^D:(P?)((?:\([^)]*\))+)$/.exec(String(sddl).trim());
  if (!match || match[1] !== "P") return false;
  const allowed = new Set(["SY", "BA", "S-1-5-18", "S-1-5-32-544", me]);
  const aces = [...match[2].matchAll(/\(([^)]*)\)/g)].map((m) => m[1].split(";"));
  return aces.length > 0 && aces.every((a) => a.length >= 6 && a[0] === "A" && allowed.has(a[5]));
}

/** Locks a listening pipe to this user. Rejects unless the read-back DACL is private. */
export async function restrictPipeToUser(name, { run = defaultRun } = {}) {
  let out;
  try {
    out = await run(name);
  } catch {
    throw Error("Controller pipe could not be secured");
  }
  const me = /^ME=(.+)$/m.exec(out)?.[1]?.trim();
  const sddl = /^SDDL=(.+)$/m.exec(out)?.[1]?.trim();
  if (!me || !sddl || !pipeDaclIsPrivate(sddl, me)) throw Error("Controller pipe is not private");
}

function defaultRun(name) {
  return new Promise((resolve, reject) =>
    execFile(
      powershellExe(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT],
      {
        env: { ...process.env, FULCRA_PIPE_NAME: name },
        encoding: "utf8",
        timeout: 30000,
        windowsHide: true,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
}

/**
 * Wraps a connection handler so nothing is served until open() is called. A connection accepted while closed is
 * destroyed: it may have been made before the pipe DACL was locked, so it is not trusted to be this user's.
 */
export function gateConnections(handler, { startOpen = false } = {}) {
  let isOpen = startOpen;
  return {
    handler(connection) {
      if (!isOpen) {
        connection.destroy();
        return;
      }
      handler(connection);
    },
    open() {
      isOpen = true;
    },
  };
}
