#Requires -Version 5.1
<#
.SYNOPSIS
    把「音乐播放器」安装到本机，并创建桌面 / 开始菜单快捷方式。

.DESCRIPTION
    1. 调用 build-portable.ps1 确保 dist 产物存在
    2. 复制到 %LOCALAPPDATA%\Programs\音乐播放器
    3. 创建桌面与开始菜单快捷方式
    4. 在安装目录写入卸载脚本

    安装是「按用户」的，不需要管理员权限。卸载只需删除安装目录。

.PARAMETER InstallDir
    安装目录，默认 %LOCALAPPDATA%\Programs\音乐播放器。

.PARAMETER Launch
    安装完成后立即启动程序。

.PARAMETER NoBuild
    跳过构建步骤，直接使用已有的 dist 产物。

.PARAMETER NoShortcuts
    不创建快捷方式（只复制文件）。

.EXAMPLE
    .\scripts\install.ps1

.EXAMPLE
    .\scripts\install.ps1 -Launch
#>
[CmdletBinding()]
param(
    [string]$InstallDir,
    [switch]$Launch,
    [switch]$NoBuild,
    [switch]$NoShortcuts
)

$ErrorActionPreference = 'Stop'

$Root     = Split-Path -Parent $PSScriptRoot
$BuildDir = Join-Path $Root 'dist\音乐播放器-win32-x64'
$ExeName  = '音乐播放器.exe'
$AppName  = '音乐播放器'

if (-not $InstallDir) {
    $InstallDir = Join-Path $env:LOCALAPPDATA "Programs\$AppName"
}

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 1. 构建
if (-not $NoBuild) {
    $builder = Join-Path $PSScriptRoot 'build-portable.ps1'
    Write-Step '准备构建产物'
    & $builder
}

$srcExe = Join-Path $BuildDir $ExeName
if (-not (Test-Path $srcExe)) {
    throw "找不到 $srcExe，请先运行 scripts\build-portable.ps1"
}
Write-Ok "构建产物就绪：$BuildDir"

# ---------------------------------------------------------------- 2. 复制
Write-Step "安装到：$InstallDir"

# 若程序正在运行，先提示关闭
$running = Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($ExeName)) -ErrorAction SilentlyContinue
if ($running) {
    Write-Warn2 "检测到程序正在运行，正在结束进程..."
    $running | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 800
}

if (Test-Path $InstallDir) {
    Write-Ok '清理旧版本'
    try { Remove-Item $InstallDir -Recurse -Force -ErrorAction Stop }
    catch { throw "无法清理旧安装目录（可能仍被占用）：$($_.Exception.Message)" }
}
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item (Join-Path $BuildDir '*') $InstallDir -Recurse -Force

$installed = Get-ChildItem $InstallDir -Recurse -File
$sizeMB = [math]::Round(($installed | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Ok "已安装 $($installed.Count) 个文件，共 $sizeMB MB"

$targetExe = Join-Path $InstallDir $ExeName

# ---------------------------------------------------------------- 3. 卸载脚本
Write-Step '写入卸载脚本'

# 真正的卸载逻辑放在 .ps1 里（PowerShell 能可靠处理 UTF-8 中文），
# .bat 只做纯 ASCII 的转发 —— cmd.exe 对「chcp 前后出现的多字节字符」解析不可靠，
# 之前把中文 echo 直接写进 .bat，chcp 之后 cmd 按旧偏移重读文件，注释行被解析成命令。
$uninstPs1 = @'
#Requires -Version 5.1
$ErrorActionPreference = 'SilentlyContinue'
$AppDir  = $PSScriptRoot
$AppName = '音乐播放器'
$ExeName = '音乐播放器.exe'

Write-Host ''
Write-Host '正在卸载 音乐播放器 ...' -ForegroundColor Cyan

Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($ExeName)) |
    Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800

$desktopLnk = Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk"
$startLnk   = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$AppName.lnk"
foreach ($l in @($desktopLnk, $startLnk)) {
    if (Test-Path $l) { Remove-Item $l -Force; Write-Host "  已删除快捷方式：$l" }
}

# 先切到临时目录，否则删不掉自己所在的目录
Set-Location $env:TEMP
if (Test-Path $AppDir) {
    for ($i = 1; $i -le 5; $i++) {
        Remove-Item $AppDir -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path $AppDir)) { break }
        Start-Sleep -Milliseconds 500
    }
}
if (Test-Path $AppDir) {
    Write-Host "  自动清理失败，请手动删除：$AppDir" -ForegroundColor Yellow
} else {
    Write-Host '  安装目录已删除' -ForegroundColor Green
}

Write-Host ''
Write-Host '卸载完成。' -ForegroundColor Green
Write-Host '（用户数据保留在 %APPDATA%\music-player，如需彻底清除请手动删除该目录）' -ForegroundColor DarkGray
Write-Host ''
Read-Host '按回车键退出'
'@

[IO.File]::WriteAllText((Join-Path $InstallDir '卸载.ps1'), $uninstPs1,
    (New-Object System.Text.UTF8Encoding($true)))
Write-Ok '卸载.ps1'

$uninstBat = @"
@echo off
chcp 65001 >nul
rem Keep this file pure ASCII: cmd.exe mis-parses multi-byte characters
rem that appear before or around a chcp switch.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0卸载.ps1"
"@
[IO.File]::WriteAllText((Join-Path $InstallDir '卸载.bat'), $uninstBat,
    (New-Object System.Text.UTF8Encoding($false)))
Write-Ok '卸载.bat'

# ---------------------------------------------------------------- 4. 快捷方式
if (-not $NoShortcuts) {
    Write-Step '创建快捷方式'

    $shell = New-Object -ComObject WScript.Shell

    $targets = @()
    $targets += (Join-Path ([Environment]::GetFolderPath('Desktop')) "$AppName.lnk")
    $startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
    if (Test-Path $startMenu) { $targets += (Join-Path $startMenu "$AppName.lnk") }

    foreach ($lnkPath in $targets) {
        $lnk = $shell.CreateShortcut($lnkPath)
        $lnk.TargetPath       = $targetExe
        $lnk.WorkingDirectory = $InstallDir
        $lnk.IconLocation     = "$targetExe,0"
        $lnk.Description      = '音乐播放器 · 便携桌面版'
        $lnk.Save()
        Write-Ok $lnkPath
    }

    [void][Runtime.InteropServices.Marshal]::ReleaseComObject($shell)
}

# ---------------------------------------------------------------- 5. 完成
Write-Host ''
Write-Host '安装完成' -ForegroundColor Green
Write-Host "  安装目录 : $InstallDir"
Write-Host "  启动程序 : $targetExe"
if (-not $NoShortcuts) {
    Write-Host "  快捷方式 : 桌面 / 开始菜单 -> $AppName"
}
Write-Host "  卸载方式 : 运行安装目录下的 卸载.bat，或直接删除该文件夹"
Write-Host ''

if ($Launch) {
    Write-Step '启动程序'
    Start-Process -FilePath $targetExe -WorkingDirectory $InstallDir
}
