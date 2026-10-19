import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import type { ResourceProcess } from "./session-resources.js";

const exec = promisify(execFile);

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
  installRoots: z.array(z.object({pid: z.number().int().positive(), birth: z.string().regex(/^\d+$/)})).max(128).nullable().optional(),
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

export function parseWindowsResourceSnapshot(output: string): ResourceProcess[] {
  const snapshot = snapshotSchema.parse(JSON.parse(output.trim().replace(/^\uFEFF/, "")));
  const protectedPids = new Set<number>();
  let unknownInstall = !snapshot.installRoots;
  for (const root of snapshot.installRoots ?? []) {
    if (!snapshot.processes.some((row) => row.Id === root.pid && row.StartTicks === root.birth)) unknownInstall = true;
    else protectedPids.add(root.pid);
  }
  for (let pass = 0; pass < snapshot.processes.length; pass++) {
    const size = protectedPids.size;
    for (const row of snapshot.processes) if (row.Parent !== null && protectedPids.has(row.Parent)) protectedPids.add(row.Id);
    if (size === protectedPids.size) break;
  }
  return snapshot.processes.flatMap((row) => {
    if (!row.Id || !row.StartTicks || row.Parent === null) return [];
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
        protectionReason:
          protectedPids.has(row.Id) ? "install-tree" : unknownInstall ? "install-unknown" : snapshot.queueState === "clear" ? undefined : `queue-${snapshot.queueState}`,
      },
    ];
  });
}

export async function readWindowsResourceProcesses(
  policyFile?: string,
): Promise<ResourceProcess[]> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "session-resource-table-"));
  const script = path.join(directory, "read.ps1");
  try {
    await fs.writeFile(script, WINDOWS_RESOURCE_SCRIPT, { mode: 0o600 });
    const pending = exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        script,
        "-PolicyPath",
        policyFile ?? path.join(directory, "missing-policy.json"),
      ],
      { timeout: 15_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    );
    pending.child.stdin?.end();
    return parseWindowsResourceSnapshot((await pending).stdout);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export function protectedSessionDirectory(cwd: string, title?: string | null): boolean {
  return (
    /\b(?:Song|Video) Studio\b/i.test(title ?? "") ||
    /Fulcra.*(?:install|release|update)|(?:install|release).*Fulcra/i.test(title ?? "") ||
    /(?:^|[\\/])(?:orca-service-releases[^\\/]*|fulcra-(?:releases?|install(?:er)?|updates?))(?:[\\/]|$)/i.test(cwd) ||
    /(?:^|[\\/])(?:song-studio|video-studio)(?:[\\/]|$)/i.test(cwd) ||
    /^[A-Za-z]:[\\/](?:Games|Videos|Steam)(?:[\\/]|$)/i.test(cwd)
  );
}
