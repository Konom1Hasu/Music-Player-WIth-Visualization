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
    安装完成后立即启动程序（根目录的 安装.bat 默认就带这个参数）。

.PARAMETER NoLaunch
    安装完成不启动。安装.bat 传了 -Launch，所以要用双击的方式装而不启动，就加这个。

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
    [switch]$NoLaunch,
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
    # ★ 防误删护栏：$InstallDir 是 -InstallDir 传进来的自由参数，也可能是别人脚本里
    #   拼错的路径。直接 `Remove-Item -Recurse -Force` 会把盘符根、共享目录或用户
    #   自己的文件夹整个清掉 —— 这个错没法回滚，所以清空之前先做归属校验。
    $installFull = [IO.Path]::GetFullPath($InstallDir)
    $trimmed     = $installFull.TrimEnd([char[]]@('\', '/'))
    $depth       = ([regex]::Matches($trimmed, '\\')).Count

    # (1) 拒绝盘符根 / UNC 根 / 明显过短的路径
    if ($trimmed -match '^[A-Za-z]:$' -or $installFull -match '^\\\\[^\\\\]+\\\\[^\\\\]+\\?$' -or $depth -lt 2 -or $trimmed.Length -lt 6) {
        throw "安全保护：安装目录 $InstallDir 是盘符根或层级过短（至少要到 X:\Apps\音乐播放器 这种深度），已拒绝删除。请指定专属子目录（如 D:\Apps\音乐播放器）后重试。"
    }
    # 拒绝系统目录本身及其上层
    $systemDirs = @($env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData, $env:LOCALAPPDATA, $env:APPDATA, $env:USERPROFILE) |
        Where-Object { $_ } | ForEach-Object { $_.TrimEnd([char[]]@('\', '/')) }
    foreach ($sys in $systemDirs) {
        if ($trimmed -eq $sys -or $sys.StartsWith($trimmed + '\')) {
            throw "安全保护：安装目录 $InstallDir 是系统目录或其上层（$sys 就在里面），已拒绝删除。请指定专属子目录（如 D:\Apps\音乐播放器）后重试。"
        }
    }
    # 拒绝成为本仓库的父目录（说明路径拼到项目外面上去了）
    $rootFull = ([IO.Path]::GetFullPath($Root)).TrimEnd([char[]]@('\', '/'))
    if ($rootFull.StartsWith($trimmed + '\')) {
        throw "安全保护：安装目录 $InstallDir 是本项目目录的上层，已拒绝删除。请指定专属子目录（如 D:\Apps\音乐播放器）后重试。"
    }

    # (2) 非空目录必须"看得出是本程序装过的"才允许清空
    $existing = @(Get-ChildItem -LiteralPath $installFull -Force -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) {
        $looksLikeOurs = $false
        if (Test-Path -LiteralPath (Join-Path $installFull $ExeName) -PathType Leaf)            { $looksLikeOurs = $true }
        if (Test-Path -LiteralPath (Join-Path $installFull '卸载.bat') -PathType Leaf)          { $looksLikeOurs = $true }
        if (Test-Path -LiteralPath (Join-Path $installFull 'resources\app\package.json') -PathType Leaf) { $looksLikeOurs = $true }
        if (-not $looksLikeOurs) {
            throw "安全保护：目标目录 $InstallDir 非空且不像本程序的旧安装目录，已拒绝删除。请指定专属子目录（如 D:\Apps\音乐播放器）或手动清空后重试。"
        }
    }

    Write-Ok '清理旧版本'
    try { Remove-Item -LiteralPath $installFull -Recurse -Force -ErrorAction Stop }
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

if ($Launch -and -not $NoLaunch) {
    Write-Step '启动程序'
    Start-Process -FilePath $targetExe -WorkingDirectory $InstallDir
    Write-Ok '已启动（本窗口可以关掉）'
}
