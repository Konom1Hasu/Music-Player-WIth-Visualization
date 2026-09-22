#Requires -Version 5.1
<#
.SYNOPSIS
    回滚 app/index.html 到 versions\ 里的某个历史版本。

.DESCRIPTION
    把 versions\ 下的快照复制成 app/index.html，并（默认）立刻重新构建运行时，
    使改动生效。执行前会自动把当前 app/index.html 备份到 dist\版本备份\，
    所以随时可以再切回来。

    版本来源见 versions\README.md。

.PARAMETER Version
    目标版本。支持完整文件名（Q1_preWave.html）、文件名前缀（Q1）、
    或关键字（preWave）。唯一匹配即可。

.PARAMETER List
    只列出所有可用版本，不做改动。

.PARAMETER NoBuild
    只替换源码，不重新构建运行时。

.EXAMPLE
    .\scripts\use-version.ps1 -List

.EXAMPLE
    .\scripts\use-version.ps1 -Version Q1

.EXAMPLE
    .\scripts\use-version.ps1 -Version R1_installed_final.html -NoBuild
#>
[CmdletBinding()]
param(
    [string]$Version,
    [switch]$List,
    [switch]$NoBuild
)

$ErrorActionPreference = 'Stop'

$Root     = Split-Path -Parent $PSScriptRoot
$Versions = Join-Path $Root 'versions'
$Target   = Join-Path $Root 'app\index.html'
$BackupDir = Join-Path $Root 'dist\版本备份'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    $msg" -ForegroundColor Yellow }

if (-not (Test-Path $Versions)) { throw "找不到版本目录：$Versions" }

$all = Get-ChildItem $Versions -Filter '*.html' -File | Sort-Object Name
if ($all.Count -eq 0) { throw "$Versions 里没有任何 .html 快照。" }

# 备份目录（dist 已被 .gitignore 排除，不会污染仓库）
$backups = @()
if (Test-Path $BackupDir) {
    $backups = Get-ChildItem $BackupDir -Filter '*.html' -File | Sort-Object Name
}

# ---------------------------------------------------------------- 列出版本
function Show-Versions {
    Write-Host ''
    Write-Host '可用版本（versions\，来自历史快照）：' -ForegroundColor Cyan
    $all | ForEach-Object {
        Write-Host ("    {0,-26} {1,8:N1} KB" -f $_.Name, ($_.Length / 1KB))
    }

    if ($backups.Count -gt 0) {
        Write-Host ''
        Write-Host '本机备份（dist\版本备份\，每次回滚自动生成）：' -ForegroundColor Cyan
        $backups | ForEach-Object {
            Write-Host ("    {0,-46} {1,8:N1} KB" -f $_.Name, ($_.Length / 1KB))
        }
    }

    Write-Host ''
    Write-Host '  用 -Version <名称|前缀|关键字> 切换到其中一个' -ForegroundColor DarkGray
    Write-Host '  详细说明见 versions\README.md' -ForegroundColor DarkGray
    Write-Host ''
    $cur = (Get-FileHash $Target -Algorithm MD5).Hash
    $match = (@($all) + @($backups)) | Where-Object { (Get-FileHash $_.FullName -Algorithm MD5).Hash -eq $cur }
    if ($match) {
        Write-Host "  当前 app\index.html 等于：$($match[0].Name)" -ForegroundColor Green
    }
    else {
        Write-Host '  当前 app\index.html 不在存档 / 备份中（是开发中的最新版）' -ForegroundColor DarkGray
    }
    Write-Host ''
}

if ($List -or -not $Version) {
    Show-Versions
    return
}

# ---------------------------------------------------------------- 匹配版本
# 先在历史快照里找，再在本地备份里找
function Find-Version([string]$key, $pool) {
    if (-not $pool -or @($pool).Count -eq 0) { return @() }
    $r = @($pool | Where-Object { $_.Name -eq $key })
    if ($r.Count -eq 0) { $r = @($pool | Where-Object { $_.Name -eq "$key.html" }) }
    if ($r.Count -eq 0) { $r = @($pool | Where-Object { $_.Name -like "$key*" }) }
    if ($r.Count -eq 0) { $r = @($pool | Where-Object { $_.Name -like "*$key*" }) }
    return $r
}

$key  = $Version.Trim()
$pick = Find-Version $key $all
if (@($pick).Count -eq 0) { $pick = Find-Version $key $backups }

if (@($pick).Count -eq 0) {
    Write-Warn2 "没有匹配到版本：$Version"
    Show-Versions
    exit 1
}
if (@($pick).Count -gt 1) {
    Write-Warn2 '匹配到多个版本，请写得更精确：'
    $pick | ForEach-Object { Write-Host "      $($_.Name)" }
    exit 1
}
$pick = @($pick)[0]

# ---------------------------------------------------------------- 备份当前
Write-Step '备份当前版本'
if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null }

$curHash = (Get-FileHash $Target -Algorithm MD5).Hash
$curName = ($all | Where-Object { (Get-FileHash $_.FullName -Algorithm MD5).Hash -eq $curHash } | Select-Object -First 1).Name
$stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
$bakName = if ($curName) { "index-$stamp-$($curName -replace '\.html$','')" } else { "index-$stamp-当前开发版" }
$bakPath = Join-Path $BackupDir "$bakName.html"
Copy-Item $Target $bakPath -Force
Write-Ok "已备份到 dist\版本备份\$bakName.html"

# ---------------------------------------------------------------- 替换
Write-Step "回滚到 $($pick.Name)"
Copy-Item $pick.FullName $Target -Force
$newHash = (Get-FileHash $Target -Algorithm MD5).Hash
if ($newHash -ne (Get-FileHash $pick.FullName -Algorithm MD5).Hash) { throw '复制校验失败' }
Write-Ok "$($pick.Name)  ->  app\index.html"
Write-Ok "MD5 $newHash"

# 记录当前版本，方便下次查看
[IO.File]::WriteAllText((Join-Path $BackupDir '当前版本.txt'),
    "$($pick.Name)`r`n$newHash`r`n$stamp`r`n", (New-Object System.Text.UTF8Encoding($true)))

# ---------------------------------------------------------------- 重建
if (-not $NoBuild) {
    Write-Step '重新构建运行时'
    & (Join-Path $PSScriptRoot 'build-portable.ps1') | Out-Null
    Write-Ok '构建完成，已生效'
}
else {
    Write-Warn2 '跳过了构建，运行时里的还是旧内容 —— 需要时手动跑 scripts\build-portable.ps1'
}

Write-Host ''
Write-Host "已切换到 $($pick.Name)" -ForegroundColor Green
Write-Host "  备份位置 : dist\版本备份\$bakName.html"
Write-Host "  切回方法 : .\scripts\use-version.ps1 -Version $bakName"
Write-Host '  注意     : 早期快照不含 B 站缓存 / 迷你悬浮窗 / 多歌手识别等功能' -ForegroundColor DarkGray
if ((git -C $Root rev-parse --is-inside-work-tree 2>$null) -eq 'true') {
    Write-Host '  提示     : app\index.html 现在与 git 里的最新版不同，' -ForegroundColor DarkGray
    Write-Host '             想直接回到最新版可执行 git checkout -- app/index.html' -ForegroundColor DarkGray
}
Write-Host ''
