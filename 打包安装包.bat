@echo off
chcp 65001 >nul
rem ============================================================
rem  Music Player - build the one-click installer (Setup.exe)
rem  Same as: powershell -ExecutionPolicy Bypass -File scripts\build-installer.ps1
rem
rem  Output: dist\<installer-out-folder>\<product>-Setup-<version>.exe
rem  Needs Inno Setup 6 (ISCC.exe). Install it with:
rem      winget install -e --id JRSoftware.InnoSetup
rem
rem  NOTE: KEEP THIS FILE PURE ASCII. cmd.exe re-reads a batch file by byte
rem        offset, so any multi-byte character (a Chinese path or a Chinese
rem        script name inside a comment is enough) desyncs the parser and the
rem        rest of the file runs as garbage commands such as 'Needs' /
rem        'wershell' - that is exactly what happened once. So folder and
rem        script names are written as placeholders below.
rem        The repository's doc-consistency check now fails if any .bat file
rem        under the repo root or scripts/ contains a non-ASCII byte.
rem ============================================================
setlocal
cd /d "%~dp0"

where powershell >nul 2>nul
if errorlevel 1 (
  echo [ERROR] PowerShell not found in PATH.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-installer.ps1" %*
set RC=%ERRORLEVEL%

echo.
if not "%RC%"=="0" (
  echo [FAILED] exit code = %RC%
  pause
  exit /b %RC%
)

echo Done. The Setup.exe is in the "dist" folder (subfolder for installers).
pause
exit /b 0
