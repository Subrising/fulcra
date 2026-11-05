import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import type { ResourceProcess } from "./session-resources.js";

// This private policy supplies the host's queue receipt directory. Missing or unreadable proof keeps processes.
// Never collect CommandLine, executable paths, script contents, or environment values.
export const WINDOWS_RESOURCE_SCRIPT = String.raw`param([string]$PolicyPath)
$ErrorActionPreference = 'Stop'
$queueState = 'unknown'
$installRoots = $null
if ($PolicyPath -and (Test-Path -LiteralPath $PolicyPath)) {
  try {
    $policyItem = Get-Item -LiteralPath $PolicyPath
    if ($policyItem.Length -gt 65536) { throw 'Policy too large' }
    $policy = Get-Content -LiteralPath $PolicyPath -Raw | ConvertFrom-Json
    if ($null -eq $policy.installRoots -or @($policy.installRoots).Count -gt 128) { throw 'Unknown install roots' }
    $installRoots = @($policy.installRoots | ForEach-Object {
      if ($_.pid -le 0 -or [string]$_.birth -notmatch '^\d+$') { throw 'Invalid install identity' }
      [pscustomobject]@{pid=[int]$_.pid; birth=[string]$_.birth}
    })
    $directory = [string]$policy.queueReceiptDirectory
    if ($policy.version -ne 1 -or $directory -notmatch '^[a-zA-Z]:\\' -or $directory -match '(?i)(^|\\)(Games|Videos|Steam)(\\|$)|song-studio|video-studio') { throw 'Invalid queue policy' }
    $item = Get-Item -LiteralPath $directory
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Uncertain queue directory' }
    $queueState = 'clear'
    foreach ($entry in @(Get-ChildItem -LiteralPath $directory -Filter 'q*.json' -File)) {
      if ($entry.Length -gt 1048576 -or ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Uncertain queue receipt' }
      $receipt = Get-Content -LiteralPath $entry.FullName -Raw | ConvertFrom-Json
      if ($receipt.status -in @('starting','running')) { $queueState='open'; break }
      if ($receipt.status -notin @('waiting','done','failed','cancelled','interrupted')) { throw 'Unknown queue receipt state' }
    }
  } catch { $queueState = 'unknown' }
}
$parents = @{}
Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { $parents[[int]$_.ProcessId]=[int]$_.ParentProcessId }
$rows = @(Get-Process | ForEach-Object {
  $ticks=$null
  try { $ticks=$_.StartTime.ToUniversalTime().Ticks.ToString() } catch {}
  [pscustomobject]@{ Id=$_.Id; Name=$_.ProcessName; StartTicks=$ticks; Parent=$parents[[int]$_.Id]; WorkingSet64=$_.WorkingSet64; PrivateMemorySize64=$_.PrivateMemorySize64 }
})
[pscustomobject]@{ queueState=$queueState; installRoots=$installRoots; processes=$rows } | ConvertTo-Json -Depth 4 -Compress
`;

const snapshotSchema = z.object({
  queueState: z.enum(["clear", "open", "unknown"]),
  installRoots: z
    .array(z.object({ pid: z.number().int().positive(), birth: z.string().regex(/^\d+$/) }))
    .max(128)
    .nullable()
    .optional(),
  processes: z.array(
    z.object({
      Id: z.number().int().nonnegative(),
      Name: z.string(),
      StartTicks: z.string().regex(/^\d+$/).nullable(),
      Parent: z.number().int().nonnegative().nullable(),
      WorkingSet64: z.number().nonnegative(),
      PrivateMemorySize64: z.number().nonnegative(),
    }),
  ),
});

export function parseWindowsResourceSnapshot(
  output: string,
  onStaleInstallRoot?: (root: { pid: number; birth: string }) => void,
): ResourceProcess[] {
  const snapshot = snapshotSchema.parse(JSON.parse(output.trim().replace(/^\uFEFF/, "")));
  const protectedPids = new Set<number>();
  let unknownInstall = !snapshot.installRoots;
  for (const root of snapshot.installRoots ?? []) {
    // A root whose process has exited protects nothing; ignore only that entry.
    if (!snapshot.processes.some((row) => row.Id === root.pid && row.StartTicks === root.birth))
      onStaleInstallRoot?.(root);
    else protectedPids.add(root.pid);
  }
  for (let pass = 0; pass < snapshot.processes.length; pass++) {
    const size = protectedPids.size;
    for (const row of snapshot.processes)
      if (row.Parent !== null && protectedPids.has(row.Parent)) protectedPids.add(row.Id);
    if (size === protectedPids.size) break;
  }
  return snapshot.processes.flatMap((row) => {
    if (!row.Id || !row.StartTicks || row.Parent === null) return [];
    let protectionReason: string | undefined;
    if (protectedPids.has(row.Id)) protectionReason = "install-tree";
    else if (unknownInstall) protectionReason = "install-unknown";
    else if (snapshot.queueState !== "clear") protectionReason = `queue-${snapshot.queueState}`;
    return [
      {
        pid: row.Id,
        ppid: row.Parent,
        birth: row.StartTicks,
        groupId: 0,
        detached: false,
        zombie: false,
        command: row.Name,
        rssKiB: row.WorkingSet64 / 1024,
        privateMemoryBytes: row.PrivateMemorySize64,
        protectionReason,
      },
    ];
  });
}

const READ_TIMEOUT_MS = 15_000;
const READ_MAX_BYTES = 16 * 1024 * 1024;

/**
 * execFile ignores `detached`, so use spawn. DETACHED_PROCESS gives PowerShell no console,
 * so each sample starts no conhost.exe.
 */
function runDetachedPowerShell(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", args, {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | undefined;
    const fail = (error: Error) => {
      failure ??= error;
      child.kill();
    };
    const timer = setTimeout(
      () => fail(new Error(`powershell.exe timed out after ${READ_TIMEOUT_MS} ms`)),
      READ_TIMEOUT_MS,
    );
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > READ_MAX_BYTES) fail(new Error("powershell.exe output exceeded maxBuffer"));
      else chunks.push(chunk);
    });
    child.stderr?.resume();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`powershell.exe exited with code ${code}`));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

export async function readWindowsResourceProcesses(
  policyFile?: string,
  onStaleInstallRoot?: (root: { pid: number; birth: string }) => void,
): Promise<ResourceProcess[]> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "session-resource-table-"));
  const script = path.join(directory, "read.ps1");
  try {
    await fs.writeFile(script, WINDOWS_RESOURCE_SCRIPT, { mode: 0o600 });
    const stdout = await runDetachedPowerShell([
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      script,
      "-PolicyPath",
      policyFile ?? path.join(directory, "missing-policy.json"),
    ]);
    return parseWindowsResourceSnapshot(stdout, onStaleInstallRoot);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export function protectedSessionDirectory(cwd: string, title?: string | null): boolean {
  return (
    /\b(?:Song|Video) Studio\b/i.test(title ?? "") ||
    /Fulcra.*(?:install|release|update)|(?:install|release).*Fulcra/i.test(title ?? "") ||
    /(?:^|[\\/])(?:orca-service-releases[^\\/]*|fulcra-(?:releases?|install(?:er)?|updates?))(?:[\\/]|$)/i.test(
      cwd,
    ) ||
    /(?:^|[\\/])(?:song-studio|video-studio)(?:[\\/]|$)/i.test(cwd) ||
    /^[A-Za-z]:[\\/](?:Games|Videos|Steam)(?:[\\/]|$)/i.test(cwd)
  );
}
