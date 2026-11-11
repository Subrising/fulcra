@echo off
rem Fulcra boot daemon start (FU-470 option C, FU-780).
rem The scheduled task "Fulcra Daemon At Boot" runs this as the user with S4U (no stored password):
rem at boot, and every 5 minutes, so a daemon comes back after a Windows sign-out stopped the app daemon.
rem It starts a daemon only when none runs. "paseo daemon start" then answers "already_running" with exit 0,
rem and this script exits 0 and writes nothing to the log. Any other answer goes to the log.
rem FULCRA_BOOT_PASEO and FULCRA_BOOT_LOG override the CLI path and the log for a dry run.
setlocal
set "PASEO_HOME=%USERPROFILE%\AppData\Roaming\Orca\daemon"
set "LOG=%FULCRA_BOOT_LOG%"
if not defined LOG set "LOG=%USERPROFILE%\fulcra-boot-start.log"
set "CLI=%FULCRA_BOOT_PASEO%"
if not defined CLI set "CLI=%USERPROFILE%\fulcra-bin\paseo.cmd"
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
