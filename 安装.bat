@echo off
chcp 65001 >nul
rem ============================================================
rem  Music Player - install to this machine
rem  Same as: powershell -ExecutionPolicy Bypass -File scripts\install.ps1
rem  NOTE: keep this file pure ASCII. cmd.exe mis-parses multi-byte
rem        characters that appear before/around a chcp switch.
rem ============================================================
setlocal
cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
  echo [ERROR] PowerShell not found in PATH.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
set RC=%ERRORLEVEL%

echo.
if not "%RC%"=="0" echo [FAILED] exit code = %RC%
pause
exit /b %RC%
