#Requires -Version 5.1
<#
.SYNOPSIS
    把旧版留在 IndexedDB 里的曲库恢复进新版（不会修改旧数据，也不会往音乐目录写文件）。

.DESCRIPTION
    新版把界面从"随机端口"改成了固定端口 41739，而 **IndexedDB 是按"源"隔离的**
    （scheme + host + port）—— 随机端口等于每次启动都换存储域，于是旧版导入过的曲目
    在新版里读不到。它们其实都还在磁盘上：

      · 当前 profile 的 file:// 源      —— 早期独立播放器，音频以 Blob 存在 IndexedDB 里
      · 当前 profile 的若干 http://127.0.0.1:<随机端口> 源 —— 1.4.0 之前的终端界面
      · 另一个 profile（%APPDATA%\music-player-desktop）的 file:// 源

    一个进程只能访问一个 profile 的存储，所以跨 profile 那一份要分两步走：
    本脚本先跑"当前 profile"（第 1 步），再可选地跑"旧 profile"（第 2 步，把东西放进
    系统临时目录的交接区），最后回到当前 profile 把交接区吃进去（第 3 步）。

.PARAMETER OldProfile
    旧 profile 的目录，默认 %APPDATA%\music-player-desktop。不存在就跳过第 2 步。

.PARAMETER SkipCurrent
    跳过第 1 步（只处理旧 profile 与交接区）。

.PARAMETER OnlyIngest
    只跑第 3 步（把交接区吃进当前 profile）。

.EXAMPLE
    .\scripts\恢复旧曲库.ps1
#>
[CmdletBinding()]
param(
    [string]$OldProfile = (Join-Path $env:APPDATA 'music-player-desktop'),
    [switch]$SkipCurrent,
    [switch]$OnlyIngest
)

$ErrorActionPreference = 'Stop'
function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Write-Warn2($m){ Write-Host "    $m" -ForegroundColor Yellow }

$RepoRoot = Split-Path -Parent $PSScriptRoot
$Exe = Join-Path $RepoRoot 'dist\音乐播放器-win32-x64\音乐播放器.exe'
if (-not (Test-Path $Exe)) {
    # 没构建过就用 app 目录 + 已装的 Electron 跑
    throw "找不到 $Exe —— 先执行 scripts\build-portable.ps1 构建便携版"
}
Write-Ok "启动程序：$Exe"

$bundle = Join-Path $env:TEMP 'rhine-recover'

if (-not $OnlyIngest) {
    if (-not $SkipCurrent) {
        Write-Step '第 1 步：恢复"当前 profile"里的旧曲库'
        Write-Warn2 '会打开两个进度窗口（读取端 + 写入端），读完自动关闭并弹出结果框'
        & $Exe --recover-library
        if ($LASTEXITCODE -ne 0) { Write-Warn2 "退出码 $LASTEXITCODE（可能只是弹框后手动关闭）" }
    }
    if (Test-Path $OldProfile) {
        Write-Step "第 2 步：恢复旧 profile 的曲库（$OldProfile）"
        Write-Warn2 '这一步用的是旧 profile 的存储目录，恢复结果同时会放进系统临时目录的交接区'
        & $Exe "--user-data-dir=$OldProfile" --recover-library
        if ($LASTEXITCODE -ne 0) { Write-Warn2 "退出码 $LASTEXITCODE" }
    } else {
        Write-Warn2 "旧 profile 不存在，跳过：$OldProfile"
    }
}

if (Test-Path $bundle) {
    Write-Step '第 3 步：把交接区吃进当前 profile 的曲库'
    & $Exe --recover-ingest
    if ($LASTEXITCODE -ne 0) { Write-Warn2 "退出码 $LASTEXITCODE" }
} else {
    Write-Warn2 "没有交接区（$bundle），第 3 步跳过"
}

Write-Host ''
Write-Ok '完成。重新打开音乐播放器即可看到恢复出来的曲目。'
Write-Host '    说明：恢复的是曲目本身（音频 + 标题/歌手/专辑/封面/时长）。' -ForegroundColor DarkGray
Write-Host '    旧版存在歌曲里的播放次数与进度只在旧库里，未做逐条映射。' -ForegroundColor DarkGray
