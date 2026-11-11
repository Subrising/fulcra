@echo off
rem Fulcra boot daemon start (FU-470 option C, FU-780).
rem The scheduled task "Fulcra Daemon At Boot" runs this as the user with S4U (no stored password):
rem at boot, and every 5 minutes, so a daemon comes back after a Windows sign-out stopped the app daemon.
rem It starts a daemon only when none runs. "paseo daemon start" then answers "already_running" with exit 0,
rem and this script exits 0 and writes nothing to the log. Any other answer goes to the log.
rem It starts nothing while one of these is fresh: newer than the last boot AND under 12 hours old. An older
rem one is stale and is ignored, so the boot trigger always starts a daemon. The 12 h limit covers a resume
rem from hibernate, which keeps the last boot time.
rem - the update lock folder (fulcra-update\lock): an update replaces the build the daemon runs from;
rem - daemon-stopped-on-purpose.json in the daemon home: the app stopped its daemon on purpose (Stop, a quit
rem   with "Keep running after quit" off, an app update). The app removes it when it starts its daemon again.
rem FULCRA_BOOT_PASEO, FULCRA_BOOT_LOG, FULCRA_BOOT_HOME and FULCRA_UPDATE_LOCK override paths, and
rem FULCRA_BOOT_LASTBOOT overrides the last boot time, for a dry run.
setlocal
set "PASEO_HOME=%FULCRA_BOOT_HOME%"
if not defined PASEO_HOME set "PASEO_HOME=%USERPROFILE%\AppData\Roaming\Orca\daemon"
set "LOG=%FULCRA_BOOT_LOG%"
if not defined LOG set "LOG=%USERPROFILE%\fulcra-boot-start.log"
set "CLI=%FULCRA_BOOT_PASEO%"
if not defined CLI set "CLI=%USERPROFILE%\fulcra-bin\paseo.cmd"
set "LOCK=%FULCRA_UPDATE_LOCK%"
if not defined LOCK set "LOCK=%USERPROFILE%\fulcra-update\lock"
set "MARKER=%PASEO_HOME%\daemon-stopped-on-purpose.json"
set "HOLD="
set "CHECK=%LOCK%"
if exist "%LOCK%" call :fresh
if defined HOLD exit /b 0
set "CHECK=%MARKER%"
if exist "%MARKER%" call :fresh
if defined HOLD exit /b 0
set "OUT=%TEMP%\fulcra-boot-start-%RANDOM%.out"
call "%CLI%" daemon start --json > "%OUT%" 2>&1
set "RC=%ERRORLEVEL%"
findstr /c:"already_running" "%OUT%" >nul 2>&1
if not errorlevel 1 if "%RC%"=="0" (
  del "%OUT%" >nul 2>&1
  exit /b 0
)
>> "%LOG%" echo %date% %time% boot start, exit %RC%
type "%OUT%" >> "%LOG%"
del "%OUT%" >nul 2>&1
exit /b %RC%

:fresh
rem Sets HOLD when %CHECK% was written after the last boot and less than 12 hours ago.
for /f "usebackq delims=" %%R in (`powershell -NoProfile -Command "$t = (Get-Item -LiteralPath $env:CHECK -Force).LastWriteTime; $b = if ($env:FULCRA_BOOT_LASTBOOT) { [datetime]$env:FULCRA_BOOT_LASTBOOT } else { (Get-CimInstance Win32_OperatingSystem).LastBootUpTime }; if ($t -gt $b -and $t -gt (Get-Date).AddHours(-12)) { 'hold' }"`) do set "HOLD=%%R"
exit /b 0
