#Requires -Version 5.1
<#
.SYNOPSIS
    构建「音乐播放器」便携版。

.DESCRIPTION
    把 app/ 下的应用源码同步到一个完整的 Electron 便携运行时目录，
    产出可以直接双击运行、也可以整体拷贝带走的绿色版。

    运行时的获取顺序：
      1. -RuntimeDir 指定的目录
      2. 已经构建好的 dist\音乐播放器-win32-x64\
      3. 从镜像下载 Electron 发行包并解压

.PARAMETER ElectronVersion
    Electron 版本号，默认 31.7.7。

.PARAMETER RuntimeDir
    已有的 Electron win32-x64 解压目录（含 electron.exe 或 音乐播放器.exe）。

.PARAMETER OutDir
    输出目录，默认 dist\音乐播放器-win32-x64。

.PARAMETER Mirror
    Electron 下载镜像前缀。

.PARAMETER Force
    即使运行时已存在，也重新下载 / 覆盖。

.EXAMPLE
    .\scripts\build-portable.ps1

.EXAMPLE
    .\scripts\build-portable.ps1 -RuntimeDir 'D:\electron\electron-v31.7.7-win32-x64'
#>
[CmdletBinding()]
param(
    [string]$ElectronVersion = '31.7.7',
    [string]$RuntimeDir,
    [string]$OutDir,
    [string]$Mirror = 'https://npmmirror.com/mirrors/electron',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# ---------------------------------------------------------------- 路径
$Root   = Split-Path -Parent $PSScriptRoot
$AppDir = Join-Path $Root 'app'
if (-not $OutDir) { $OutDir = Join-Path $Root 'dist\音乐播放器-win32-x64' }
$ExeName = '音乐播放器.exe'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 1. 校验源码
Write-Step "校验应用源码：$AppDir"
if (-not (Test-Path $AppDir)) { throw "找不到 app 目录：$AppDir" }

$required = @('index.html', 'main.js', 'preload.js', 'mini.html', 'package.json')
$missing  = @()
foreach ($f in $required) {
    if (-not (Test-Path (Join-Path $AppDir $f))) { $missing += $f }
}
if ($missing.Count -gt 0) { throw "app 目录缺少必需文件：$($missing -join ', ')" }
Write-Ok "必需文件齐全（$($required.Count) 个）"

$optional = @('bili.js', 'cover.js', 'ncmdump.exe')
foreach ($f in $optional) {
    if (Test-Path (Join-Path $AppDir $f)) { Write-Ok "可选模块存在：$f" }
    else { Write-Warn2 "可选模块缺失：$f（对应功能会不可用）" }
}

# ---------------------------------------------------------------- 2. 准备运行时
Write-Step '准备 Electron 运行时'

function Test-Runtime([string]$dir) {
    if (-not $dir) { return $false }
    if (-not (Test-Path $dir)) { return $false }
    $hasPak = Test-Path (Join-Path $dir 'resources.pak')
    $hasExe = (Test-Path (Join-Path $dir $ExeName)) -or (Test-Path (Join-Path $dir 'electron.exe'))
    return ($hasPak -and $hasExe)
}

$runtimeReady = (-not $Force) -and (Test-Runtime $OutDir)

if ($runtimeReady) {
    Write-Ok "复用已有运行时：$OutDir"
}
else {
    # 2a. 从指定目录拿
    if (Test-Runtime $RuntimeDir) {
        Write-Step "从指定目录复制运行时：$RuntimeDir"
        New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
        Copy-Item (Join-Path $RuntimeDir '*') $OutDir -Recurse -Force
    }
    else {
        # 2b. 下载
        $zipName = "electron-v$ElectronVersion-win32-x64.zip"
        $url     = "$Mirror/$ElectronVersion/$zipName"
        $tmpZip  = Join-Path $env:TEMP $zipName
        if (Test-Path $tmpZip) { Remove-Item $tmpZip -Force }

        Write-Step "下载 Electron $ElectronVersion（约 100 MB）"
        Write-Ok $url
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        } catch { }
        $downloaded = $false
        try {
            Invoke-WebRequest -Uri $url -OutFile $tmpZip -UseBasicParsing
            $downloaded = $true
        }
        catch {
            Write-Warn2 "镜像下载失败：$($_.Exception.Message)"
        }

        if (-not $downloaded) {
            $alt = "https://github.com/electron/electron/releases/download/v$ElectronVersion/$zipName"
            Write-Step "改用 GitHub 官方源下载"
            Write-Ok $alt
            Invoke-WebRequest -Uri $alt -OutFile $tmpZip -UseBasicParsing
        }

        $sizeMB = [math]::Round((Get-Item $tmpZip).Length / 1MB, 1)
        Write-Ok "下载完成：$sizeMB MB"

        Write-Step '解压运行时'
        if (Test-Path $OutDir) { Remove-Item $OutDir -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
        Expand-Archive -Path $tmpZip -DestinationPath $OutDir -Force
        Remove-Item $tmpZip -Force
        Write-Ok '解压完成'
    }

    # 2c. 把 electron.exe 改名成产品名
    $rawExe = Join-Path $OutDir 'electron.exe'
    if (Test-Path $rawExe) {
        $target = Join-Path $OutDir $ExeName
        if (Test-Path $target) { Remove-Item $target -Force }
        Rename-Item $rawExe $ExeName
        Write-Ok "electron.exe -> $ExeName"
    }
    if (Test-Path (Join-Path $OutDir 'resources\default_app.asar')) {
        Remove-Item (Join-Path $OutDir 'resources\default_app.asar') -Force
        Write-Ok '移除 default_app.asar'
    }
}

# ---------------------------------------------------------------- 3. 同步 app
$TargetApp = Join-Path $OutDir 'resources\app'
Write-Step "同步源码：app\ -> resources\app"

if (Test-Path $TargetApp) { Remove-Item $TargetApp -Recurse -Force }
New-Item -ItemType Directory -Force -Path $TargetApp | Out-Null
Copy-Item (Join-Path $AppDir '*') $TargetApp -Recurse -Force

$copied = Get-ChildItem $TargetApp -Recurse -File
Write-Ok "已复制 $($copied.Count) 个文件"

# 校验关键文件哈希一致
foreach ($f in $required) {
    $a = (Get-FileHash (Join-Path $AppDir $f) -Algorithm MD5).Hash
    $b = (Get-FileHash (Join-Path $TargetApp $f) -Algorithm MD5).Hash
    if ($a -ne $b) { throw "同步校验失败：$f" }
}
Write-Ok '哈希校验通过'

# ---------------------------------------------------------------- 4. 报告
$totalMB = [math]::Round((Get-ChildItem $OutDir -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
$appMB   = [math]::Round(($copied | Measure-Object Length -Sum).Sum / 1MB, 1)

Write-Host ''
Write-Host '构建完成' -ForegroundColor Green
Write-Host "  产物目录 : $OutDir"
Write-Host "  启动程序 : $(Join-Path $OutDir $ExeName)"
Write-Host "  应用体积 : $appMB MB"
Write-Host "  总体积   : $totalMB MB"
Write-Host ''
Write-Host '可执行 scripts\install.ps1 安装到本机，或直接把上面整个文件夹拷走使用。' -ForegroundColor DarkGray
