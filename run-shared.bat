@echo off
setlocal

REM Launch installed Umi Claw sharing the dev data directory.
REM Do NOT run alongside electron-vite dev: both write data/config/app.json.

set "CLAW_DATA_DIR=%~dp0data"
set "CLAW_EXE=D:\Umi Claw\Umi Claw.exe"

if not exist "%CLAW_EXE%" (
  echo [ERROR] exe not found: %CLAW_EXE%
  pause
  exit /b 1
)
if not exist "%CLAW_DATA_DIR%" (
  echo [ERROR] data dir not found: %CLAW_DATA_DIR%
  pause
  exit /b 1
)

echo Starting Umi Claw with data: %CLAW_DATA_DIR%
start "" "%CLAW_EXE%"
endlocal
