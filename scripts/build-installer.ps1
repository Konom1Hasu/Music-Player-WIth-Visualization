#Requires -Version 5.1
<#
.SYNOPSIS
    把便携版打成一个一键安装包（单文件 Setup.exe，Inno Setup 6）。

.DESCRIPTION
    流程：
      1. 调用 build-portable.ps1 准备 dist\音乐播放器-win32-x64（除非 -NoBuild）
      2. 校验便携目录里界面产物齐全（resources\app\ui\index.html 必须引用到产物）
      3. 用 ISCC.exe 编译 installer\music-player.iss，版本号取自 app\package.json
      4. 打印 Setup.exe 的路径、体积与 SHA256

    安装包本身是"按用户"的（PrivilegesRequired=lowest）：用户双击后直接装进
    %LOCALAPPDATA%\Programs\音乐播放器，不弹 UAC、不需要管理员。

    ISCC.exe 找不到时会给出安装办法（winget / choco / 官网），不会静默跳过：
    没有编译器就谈不上"打安装包"，这里当错误处理。

.PARAMETER Version
    覆盖安装包版本号（默认读 app\package.json 的 version）。

.PARAMETER OutDir
    输出目录，默认 dist\安装包。

.PARAMETER NoBuild
    跳过便携版构建，直接用已有的 dist\音乐播放器-win32-x64。

.PARAMETER Quiet
    把 ISCC 的编译输出折叠成一行（CI 里用）。

.EXAMPLE
    .\scripts\build-installer.ps1

.EXAMPLE
    .\scripts\build-installer.ps1 -NoBuild -Version 2.1.1
#>
[CmdletBinding()]
param(
    [string]$Version,
    [string]$OutDir,
    [switch]$NoBuild,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root        = Split-Path -Parent $PSScriptRoot
$AppDir      = Join-Path $Root 'app'
$PortableDir = Join-Path $Root 'dist\音乐播放器-win32-x64'
$IsccScript  = Join-Path $Root 'installer\music-player.iss'
$ExeName     = '音乐播放器.exe'

if (-not $OutDir) { $OutDir = Join-Path $Root 'dist\安装包' }
$OutDir = [IO.Path]::GetFullPath($OutDir)

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 1. 版本号
if (-not $Version) {
    $pkgText = [IO.File]::ReadAllText((Join-Path $AppDir 'package.json'))
    $m = [regex]::Match($pkgText, '"version"\s*:\s*"([^"]+)"')
    if (-not $m.Success) { throw "读不到 app\package.json 里的 version" }
    $Version = $m.Groups[1].Value
}
if ($Version -notmatch '^\d+\.\d+\.\d+') { throw "版本号不像语义化版本：$Version" }
Write-Step "安装包版本：$Version"

# ---------------------------------------------------------------- 2. 便携版产物
if (-not $NoBuild) {
    Write-Step '先构建便携版（build-portable.ps1）'
    & (Join-Path $PSScriptRoot 'build-portable.ps1')
    if ($LASTEXITCODE -ne 0) { throw "build-portable.ps1 失败（退出码 $LASTEXITCODE）" }
}

if (-not (Test-Path (Join-Path $PortableDir $ExeName))) {
    throw "找不到 $PortableDir\$ExeName —— 先执行 scripts\build-portable.ps1"
}
# 界面产物必须真的在包里：少了它，装出来的程序会退回旧界面（2.0.1 踩过的坑）
$uiIndex = Join-Path $PortableDir 'resources\app\ui\index.html'
$uiAssets = Join-Path $PortableDir 'resources\app\ui\assets'
if (-not (Test-Path $uiIndex)) { throw "便携目录里没有 resources\app\ui\index.html —— 界面产物没同步进去" }
$uiJs = @(Get-ChildItem $uiAssets -Filter 'index-*.js' -File -ErrorAction SilentlyContinue)
if ($uiJs.Count -ne 1) { throw "resources\app\ui\assets 下的 index-*.js 不是恰好一个（$($uiJs.Count) 个）" }
if (-not (Select-String -Path $uiIndex -Pattern $uiJs[0].Name -Quiet)) {
    throw "resources\app\ui\index.html 没有引用 $($uiJs[0].Name)：包里是旧界面"
}
Write-Ok "便携版就绪（界面产物 $($uiJs[0].Name)）"

# ---------------------------------------------------------------- 3. 找 ISCC
Write-Step '查找 Inno Setup 编译器（ISCC.exe）'
$candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
    (Join-Path $env:ProgramData 'chocolatey\bin\ISCC.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
)
$iscc = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $iscc) {
    $cmd = Get-Command 'ISCC.exe' -ErrorAction SilentlyContinue
    if ($cmd) { $iscc = $cmd.Source }
}
if (-not $iscc) {
    throw @"
找不到 ISCC.exe（Inno Setup 6 的命令行编译器）。
任选一种装法：
    winget install -e --id JRSoftware.InnoSetup
    choco install innosetup -y
    或到 https://jrsoftware.org/isdl.php 下载安装（默认路径即可被本脚本找到）
装完再跑一次本脚本即可。
"@
}
Write-Ok $iscc

# ---------------------------------------------------------------- 4. 编译
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

Write-Step '编译安装包（Inno Setup）'
Write-Ok "源：$IsccScript"
Write-Ok "出：$OutDir"
# ★ 直接把 ISCC 的输出接到控制台，不做重定向、也不走管道：
#   受限环境里给子进程建管道会 EPERM（浏览器 / vite 都踩过这个坑），
#   而这里本来也不需要抓输出去解析 —— 成败只看产物文件在不在。
$isccArgs = @(
    $(if ($Quiet) { '/Q' } else { '/Qp' }),
    "/DMyAppVersion=$Version",
    "/O$OutDir"
)
# 安装包图标"有就带上"：判断放在这一侧，.iss 里只做 #ifdef ——
# 于是任何 6.x 的 ISCC 都能编译，不受 ISPP 路径变量差异影响。
# （向导刻意没有许可页；MIT 声明由 build-portable.ps1 放进 resources\app\LICENSE.txt）
if (Test-Path (Join-Path $Root 'installer\app.ico')) { $isccArgs += '/DHasIcon=1'; Write-Ok '带上安装包图标 installer\app.ico' }
$isccArgs += $IsccScript

& $iscc @isccArgs
$rc = $LASTEXITCODE
if ($rc -ne 0) { throw "ISCC 编译失败（退出码 $rc）：上面的报错来自 Inno Setup 编译器" }

$setup = Join-Path $OutDir "音乐播放器-Setup-$Version.exe"
if (-not (Test-Path $setup)) {
    $any = Get-ChildItem $OutDir -Filter '*.exe' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($any) { $setup = $any.FullName } else { throw "编译结束但 $OutDir 里没有 Setup.exe" }
}

$sizeMB = [math]::Round((Get-Item $setup).Length / 1MB, 1)
$sha    = (Get-FileHash $setup -Algorithm SHA256).Hash

Write-Host ''
Write-Host '安装包完成' -ForegroundColor Green
Write-Host "  文件   : $setup"
Write-Host "  体积   : $sizeMB MB"
Write-Host "  SHA256 : $sha"
Write-Host "  安装   : 双击它即可（按用户安装，不需要管理员）"
