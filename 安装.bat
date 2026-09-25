@echo off
chcp 65001 >nul
rem ============================================================
rem  Music Player - one-click install (build if needed + install
rem  + shortcuts + launch)
rem
rem  Steps this file performs, in order:
rem    1. build-portable.ps1   (builds the UI, reuses the Electron
rem                             runtime already in dist\ if present)
rem    2. install.ps1          (copy to %LOCALAPPDATA%\Programs\, make
rem                             desktop + start-menu shortcuts, write
rem                             the uninstaller, then start the app)
rem
rem  Double-click this file and you are done - there is no separate
rem  "build first, then install" step and no extra keypress on
rem  success. Use scripts\install.ps1 directly for options such as
rem  -NoBuild / -NoShortcuts / -InstallDir.
rem
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

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" -Launch %*
set RC=%ERRORLEVEL%

if not "%RC%"=="0" (
  echo.
  echo [FAILED] exit code = %RC%
  echo See the messages above; nothing was installed.
  pause
  exit /b %RC%
)

exit /b 0
