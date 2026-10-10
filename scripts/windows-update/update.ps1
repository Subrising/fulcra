<#
Fulcra Windows update. Builds a branch or tag into a new folder, stops the app,
switches the "current" junction, starts the new build, checks health and rolls back on failure.
Usage:
  update.ps1 -Ref integrate/0.2.13            full update
  update.ps1 -Ref integrate/0.2.13 -Check     checks only, stops nothing, builds nothing
  update.ps1 -Ref integrate/0.2.13 -BuildOnly build into a new folder, no switch
  update.ps1 -Switch <build folder>           switch to a built folder (no build)
  update.ps1 -Rollback                        switch back to the previous build
#>
param(
  [string]$Ref,
  [string]$Switch,
  [switch]$Check,
  [switch]$BuildOnly,
  [switch]$Rollback,
  [string]$Repo = 'https://github.com/Subrising/fulcra.git',
  [int]$HealthSeconds = 150
)
$ErrorActionPreference = 'Stop'
$Home_ = 'C:\Users\dzgra'
$Root = Join-Path $Home_ 'fulcra-update'
$Builds = Join-Path $Home_ 'fulcra-builds'
$Current = Join-Path $Home_ 'fulcra-current'
$StateFile = Join-Path $Root 'state.json'
$Lock = Join-Path $Root 'lock'
$Log = Join-Path $Root 'update.log'
$Node = Join-Path $Home_ 'tools\node24'
$PaseoHome = Join-Path $Home_ 'AppData\Roaming\Orca\daemon'
$SongStudio = Join-Path $Home_ 'song-studio'
$Legacy = Join-Path $Home_ 'fulcra\packages\desktop\release-preview\win-unpacked'

function Say([string]$m) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m
  Write-Host $line
  Add-Content -Path $Log -Value $line
}
function Fail([string]$m) { Say "FAIL: $m"; throw $m }
function ReadState {
  if (Test-Path $StateFile) { return Get-Content $StateFile -Raw | ConvertFrom-Json }
  return [pscustomobject]@{ current = $Legacy; previous = $Legacy }
}
function WriteState($s) { $s | ConvertTo-Json | Set-Content -Path $StateFile -Encoding ASCII }
function PaseoCmd([string]$build) { Join-Path $build 'resources\bin\paseo.cmd' }
function Paseo([string]$build, [string[]]$a) {
  $env:PASEO_HOME = $PaseoHome
  $env:Path = "$Node;" + $env:Path
  # cmd /c keeps native stderr from becoming a terminating error under $ErrorActionPreference = 'Stop'.
  $line = '"' + (PaseoCmd $build) + '" ' + ($a -join ' ') + ' 2>&1'
  $out = cmd /c $line | Out-String
  return [pscustomobject]@{ code = $LASTEXITCODE; text = $out }
}
function PointJunction([string]$target) {
  if (Test-Path $Current) { cmd /c "rmdir `"$Current`"" | Out-Null }
  cmd /c "mklink /J `"$Current`" `"$target`"" | Out-Null
  if (-not (Test-Path (Join-Path $Current 'Fulcra.exe'))) { Fail "junction does not reach Fulcra.exe in $target" }
}
function GuiProcesses {
  Get-CimInstance Win32_Process -Filter "Name='Fulcra.exe'" |
    Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notmatch '\.[mc]?js' }
}
function DaemonProcesses {
  Get-CimInstance Win32_Process -Filter "Name='Fulcra.exe'" |
    Where-Object { $_.CommandLine -match '\.[mc]?js|--type=' }
}

# --- Song Studio check. Refuse when a chat on this daemon could stop. ---
function SongStudioCheck([string]$build) {
  $r = Paseo $build @('ls', '-a', '--json')
  if ($r.code -ne 0) {
    if ($r.text -match 'not running|ECONNREFUSED|unreachable') { Say 'daemon not running: no chats to stop'; return @() }
    Fail "paseo ls failed: $($r.text.Trim())"
  }
  $agents = @(($r.text | ConvertFrom-Json))
  $blocking = @()
  foreach ($a in $agents) {
    $text = "$($a.name) $($a.cwd)"
    if ($text -match 'song-studio|song studio|songstudio') { $blocking += "$($a.name) ($($a.status), Song Studio)" }
    elseif ($a.status -notin @('idle', 'closed', 'archived', 'error')) { $blocking += "$($a.name) ($($a.status))" }
  }
  Say ("chats on this daemon: {0}; blocking: {1}" -f $agents.Count, $blocking.Count)
  return $blocking
}

# --- Health: daemon, controller pipe, one paseo ls. ---
function HealthCheck([string]$build, [string]$serverId, [int]$minAgents, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  $problems = @()
  do {
    $problems = @()
    $st = Paseo $build @('daemon', 'status')
    if ($st.text -notmatch 'localDaemon:\s*running') { $problems += 'daemon is not running' }
    elseif ($serverId -and $st.text -notmatch [regex]::Escape($serverId)) { $problems += 'serverId changed' }
    $pipeFile = Join-Path $PaseoHome 'command-centre\control.pipe'
    if (-not (Test-Path $pipeFile)) { $problems += 'controller pipe file missing' }
    else {
      $name = (Get-Content $pipeFile -Raw).Trim() -replace '^\\\\\.\\pipe\\', ''
      try {
        $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', $name, [System.IO.Pipes.PipeDirection]::InOut)
        $c.Connect(3000); $c.Dispose()
      } catch { $problems += 'controller pipe does not accept a connection' }
    }
    if ($problems.Count -eq 0) {
      $ls = Paseo $build @('ls', '-a', '--json')
      if ($ls.code -ne 0) { $problems += 'paseo ls failed' }
      elseif (@(($ls.text | ConvertFrom-Json)).Count -lt $minAgents) { $problems += 'fewer chats than before the update' }
    }
    if ($problems.Count -eq 0) { return $true }
    Start-Sleep -Seconds 5
  } while ((Get-Date) -lt $deadline)
  Say ("health problems: " + ($problems -join '; '))
  return $false
}

function StopApp([string]$build) {
  foreach ($g in @(GuiProcesses)) {
    $p = Get-Process -Id $g.ProcessId -ErrorAction SilentlyContinue
    if ($p) { [void]$p.CloseMainWindow() }
  }
  $end = (Get-Date).AddSeconds(30)
  while (@(GuiProcesses).Count -gt 0 -and (Get-Date) -lt $end) { Start-Sleep -Seconds 1 }
  if (@(GuiProcesses).Count -gt 0) { Fail 'the app window did not close in 30 s; nothing was stopped further' }
  $r = Paseo $build @('daemon', 'stop')
  Say "daemon stop: exit $($r.code)"
  $end = (Get-Date).AddSeconds(60)
  while (@(DaemonProcesses).Count -gt 0 -and (Get-Date) -lt $end) { Start-Sleep -Seconds 1 }
  if (@(DaemonProcesses).Count -gt 0) { Fail 'daemon processes still run after a graceful stop' }
}
function StartApp {
  Start-Process -FilePath (Join-Path $Current 'Fulcra.exe') -WorkingDirectory $Current
}

# --- Build ---
function Build([string]$ref) {
  New-Item -ItemType Directory -Force -Path $Builds | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $safe = ($ref -replace '[^A-Za-z0-9._-]', '_')
  $dir = Join-Path $Builds "$stamp-$safe"
  $env:Path = "$Node;" + $env:Path
  Say "clone $ref into $dir"
  git clone --quiet --depth 1 --branch $ref $Repo $dir
  if ($LASTEXITCODE -ne 0) { Fail 'git clone failed' }
  $sha = (git -C $dir rev-parse HEAD).Trim()
  Say "commit $sha"
  Push-Location $dir
  try {
    Say 'npm ci'
    cmd /c "npm ci > `"$dir\npm-ci.log`" 2>&1"
    if ($LASTEXITCODE -ne 0) { Fail "npm ci failed (see $dir\npm-ci.log)" }
    Say 'preview build (includes the packaged smoke test)'
    cmd /c "node scripts\orca-preview-build.mjs windows > `"$dir\build.log`" 2>&1"
    if ($LASTEXITCODE -ne 0) { Fail "build failed (see $dir\build.log)" }
  } finally { Pop-Location }
  $unpacked = Join-Path $dir 'packages\desktop\release-preview\win-unpacked'
  if (-not (Test-Path (Join-Path $unpacked 'Fulcra.exe'))) { Fail 'build did not produce Fulcra.exe' }
  # Written after the build: the build refuses a source tree with extra files.
  Set-Content -Path (Join-Path $dir 'BUILD-COMMIT.txt') -Value $sha -Encoding ASCII
  Say "built $unpacked"
  return $unpacked
}

# --- Main ---
New-Item -ItemType Directory -Force -Path $Root | Out-Null
$anc = $PID; $guard = 0
while ($anc -and $guard++ -lt 12) {
  $pr = Get-CimInstance Win32_Process -Filter "ProcessId=$anc" -ErrorAction SilentlyContinue
  if (-not $pr) { break }
  if ($pr.Name -eq 'Fulcra.exe') { Fail 'this script runs under Fulcra; run it from a normal PowerShell or ssh' }
  $anc = $pr.ParentProcessId
}
if (-not $Ref -and -not $Switch -and -not $Rollback) { Fail 'give -Ref, -Switch or -Rollback' }
if (-not (Test-Path $StateFile)) { WriteState (ReadState) }
$state = ReadState
if (-not (Test-Path $Current)) { PointJunction $state.current }

$ownLock = $false
try { New-Item -ItemType Directory -Path $Lock -ErrorAction Stop | Out-Null; $ownLock = $true }
catch { if ($Check) { Say 'lock exists (another update runs?)' } else { Fail "lock folder exists: $Lock. Another update runs, or a past run was killed. Remove the folder if no update runs." } }
try {
  Say "--- start: ref='$Ref' switch='$Switch' rollback=$Rollback check=$Check buildOnly=$BuildOnly"
  $target = $null
  if ($Rollback) { $target = $state.previous }
  elseif ($Switch) { $target = $Switch }

  if ($Check) {
    $free = [int]((Get-PSDrive C).Free / 1GB)
    Say "free disk: $free GB"
    if ($free -lt 15) { Fail 'less than 15 GB free' }
    if ($Ref) { git ls-remote --exit-code --heads --tags $Repo $Ref | Out-Null; if ($LASTEXITCODE -ne 0) { Fail "ref not found: $Ref" }; Say "ref $Ref exists" }
    $blocking = SongStudioCheck $state.current
    if ($blocking.Count -gt 0) { Say ('WOULD REFUSE: chats would stop: ' + ($blocking -join ', ')); exit 3 }
    Say 'check passed: no chat blocks a restart'
    exit 0
  }

  if ($Ref) {
    $target = Build $Ref
    if ($BuildOnly) { Say "build only: $target"; exit 0 }
  }
  if (-not (Test-Path (Join-Path $target 'Fulcra.exe'))) { Fail "no Fulcra.exe in $target" }

  # Song Studio check, before anything stops.
  $blocking = SongStudioCheck $state.current
  if ($blocking.Count -gt 0) { Say ('REFUSED: these chats would stop: ' + ($blocking -join ', ')); exit 3 }

  # Record the state to keep.
  $before = Paseo $state.current @('daemon', 'status')
  $serverId = ''
  if ($before.text -match 'serverId:\s*(\S+)') { $serverId = $Matches[1] }
  $lsBefore = Paseo $state.current @('ls', '-a', '--json')
  $minAgents = 0
  if ($lsBefore.code -eq 0) { $minAgents = @(($lsBefore.text | ConvertFrom-Json)).Count }
  Say "before: serverId=$serverId chats=$minAgents"

  $old = $state.current
  Say 'stop app'
  StopApp $old
  PointJunction $target
  $new = [pscustomobject]@{ current = $target; previous = $old }
  WriteState $new
  Say "switched current -> $target (previous: $old)"
  StartApp
  if (HealthCheck $Current $serverId $minAgents $HealthSeconds) {
    Say "HEALTHY: now running $target"
  } else {
    Say 'UNHEALTHY: rolling back'
    try { StopApp $Current } catch { Say "stop of the new build failed: $_" }
    PointJunction $old
    WriteState ([pscustomobject]@{ current = $old; previous = $target })
    StartApp
    if (HealthCheck $Current $serverId $minAgents $HealthSeconds) { Say "ROLLED BACK: running $old" } else { Say 'ROLLBACK ALSO UNHEALTHY: read the daemon log' }
    exit 2
  }
} catch {
  Say ("ERROR: " + $_.Exception.Message + " at line " + $_.InvocationInfo.ScriptLineNumber)
  throw
} finally {
  if ($ownLock -and (Test-Path $Lock)) { Remove-Item $Lock -Recurse -Force -ErrorAction SilentlyContinue }
}
