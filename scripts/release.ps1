#Requires -Version 5.1
<#
.SYNOPSIS
    发布一个新版本：升版本号 → 查文档 → 跑验证 → 构建 → 提交 → 打标签 → 推送。

.DESCRIPTION
    把「代码改了、文档/更新日志忘了改」变成**发布流程里过不去的一步**。

    顺序是这样的（任何一步失败就停住，不会带着不一致的状态往下走）：

      1. 检查工作区是否干净（有改动会问你是否先提交）
      2. 计算/校验新版本号（-Bump patch|minor|major，或 -Version x.y.z）
      3. **要求 docs\更新日志.md 里已有新版本的段落**（没有就生成骨架并停下，
         等你写完再跑一次）—— 这是"文档先行"的强制点
      4. 写入 app\package.json 的版本号与 README 顶部的「当前版本」
      5. 跑三套验证：文档一致性 / 数据管控 / 设置持久化
      6. 构建便携版（确保 dist 产物是最新的）
      7. git commit + 打附注标签 vX.Y.Z
      8. 推送分支与标签（走 push-to-github.ps1，自带受限网络适配）

.PARAMETER Bump
    版本号递增方式：patch / minor / major。与 -Version 二选一。

.PARAMETER Version
    显式指定新版本号，例如 1.2.0。

.PARAMETER Message
    提交信息。默认由版本号与更新日志的首行标题拼出来。

.PARAMETER NoPush
    只做到打标签，不推送。

.PARAMETER NoBuild
    跳过构建（只改文档时可用）。

.PARAMETER Yes
    不再交互确认（适合脚本化调用）。

.EXAMPLE
    # 升修订号并发版（最常用）
    .\scripts\release.ps1 -Bump patch

.EXAMPLE
    # 指定版本号，只到打标签为止
    .\scripts\release.ps1 -Version 1.2.0 -NoPush

.EXAMPLE
    # 只改了文档，不想重新构建
    .\scripts\release.ps1 -Bump patch -NoBuild
#>
[CmdletBinding()]
param(
    [ValidateSet('patch', 'minor', 'major')]
    [string]$Bump,

    [string]$Version,

    [string]$Message,

    [switch]$NoPush,
    [switch]$NoBuild,
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Write-Warn2($m){ Write-Host "    $m" -ForegroundColor Yellow }
function Write-Dim($m)  { Write-Host "    $m" -ForegroundColor DarkGray }

# 显式按 UTF-8 读文本。
# ★ 不能用 Get-Content -Raw：PowerShell 5.1 对「无 BOM 的 UTF-8」会按 ANSI/GBK 解码，
#   中文被破坏后 package.json 直接不是合法 JSON（ConvertFrom-Json 报错），
#   README 里的中文标记也匹配不到 —— 表现为"版本号没被写进去"。
function Read-Utf8([string]$p) {
    return [System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8)
}

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not $Bump -and -not $Version) {
    throw '请指定 -Bump patch|minor|major，或 -Version x.y.z。'
}

# ---------------------------------------------------------------- 1. 工作区
Write-Step '检查工作区'

$dirty = @(git status --porcelain)
if ($dirty.Count -gt 0) {
    Write-Warn2 "有 $($dirty.Count) 处未提交改动，发布前需要先提交它们："
    $dirty | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    if (-not $Yes) {
        $ans = Read-Host '现在提交这些改动？(Y/n)'
        if ($ans -ne '' -and $ans -notmatch '^[Yy]') { throw '已取消：请先自行提交或 stash，再运行发布。' }
    }
    else { Write-Dim '-Yes 已指定，自动提交' }
    git add -A
    $pre = if ($Message) { $Message } else { 'chore: 发布前提交待发布改动' }
    $env:GIT_CONFIG_COUNT = $null
    git commit -m $pre | Out-Null
    Write-Ok '已提交待发布改动'
}
else { Write-Ok '工作区干净' }

# ---------------------------------------------------------------- 2. 版本号
Write-Step '计算新版本号'

$pkgPath  = Join-Path $Root 'app\package.json'
$readmePath = Join-Path $Root 'README.md'
$logPath  = Join-Path $Root 'docs\更新日志.md'

$pkg = Read-Utf8 $pkgPath | ConvertFrom-Json
$oldVersion = $pkg.version
if ($oldVersion -notmatch '^(\d+)\.(\d+)\.(\d+)$') { throw "package.json 里的版本号格式不对：$oldVersion" }
$major = [int]$Matches[1]; $minor = [int]$Matches[2]; $patch = [int]$Matches[3]

if ($Version) {
    $newVersion = $Version.Trim()
    if ($newVersion -notmatch '^(\d+)\.(\d+)\.(\d+)$') { throw "版本号格式必须是 x.y.z：$newVersion" }
}
else {
    switch ($Bump) {
        'major' { $major++; $minor = 0; $patch = 0 }
        'minor' { $minor++; $patch = 0 }
        'patch' { $patch++ }
    }
    $newVersion = "$major.$minor.$patch"
}

# 新版本必须比旧版本大。
# ★ 局部变量千万不要用 $A / $B / $a / $b 这类只差大小写的名字：PowerShell 变量名
#   不区分大小写，`$A = $a.Split('.')` 实际上是在给参数 $a 赋值；而 $a 被声明成
#   [string]，数组赋回去会被**静默转成字符串** "1 1 3"，于是 $A[2] 取到的是字符 '1'
#   而不是数字 3，两边永远"相等"，版本比较恒返回 0。参数名与局部名因此取得完全不一样。
function Compare-Ver([string]$Left, [string]$Right) {
    $verL = @($Left.Split('.')  | ForEach-Object { [int]$_ })
    $verR = @($Right.Split('.') | ForEach-Object { [int]$_ })
    for ($i = 0; $i -lt 3; $i++) {
        if ($verL[$i] -gt $verR[$i]) { return 1 }
        if ($verL[$i] -lt $verR[$i]) { return -1 }
    }
    return 0
}
if ((Compare-Ver $newVersion $oldVersion) -le 0) {
    throw "新版本号 $newVersion 必须大于当前版本 $oldVersion。"
}
Write-Ok "$oldVersion -> $newVersion"
if (git tag --list | Where-Object { $_ -eq "v$newVersion" }) { throw "标签 v$newVersion 已存在，换一个版本号。" }

# ---------------------------------------------------------------- 3. 更新日志（文档先行）
Write-Step '检查更新日志'

$log = Read-Utf8 $logPath
if ($log -notmatch [regex]::Escape("## [$newVersion]")) {
    Write-Warn2 "docs\更新日志.md 里没有 [${newVersion}] 段落"
    $stamp = Get-Date -Format 'yyyy'
    $skeleton = @"
## [$newVersion] — $stamp

**主题：**（一句话说清这个版本干了什么）

### 新增

- （没有就删掉这一节）

### 变更

- `app\package.json`：版本号 ``$oldVersion`` → **``$newVersion``**

### 修复

- （没有就删掉这一节）

---

"@
    # 插到第一个版本段落之前（也就是最上面）
    $first = [regex]::Match($log, '(?m)^##\s*\[[0-9]+\.[0-9]+\.[0-9]+\]')
    if ($first.Success) {
        $newLog = $log.Substring(0, $first.Index) + $skeleton + $log.Substring($first.Index)
    } else {
        $newLog = $log.TrimEnd() + "`n`n" + $skeleton
    }
    [System.IO.File]::WriteAllText($logPath, $newLog, (New-Object System.Text.UTF8Encoding($false)))

    Write-Host ''
    Write-Host '已经生成骨架，请把内容写实。' -ForegroundColor Yellow
    Write-Host "  文件：$logPath" -ForegroundColor DarkGray
    Write-Host "  要求：把「主题」写清楚，并在 新增 / 变更 / 修复 里列出实际改动，" -ForegroundColor DarkGray
    Write-Host "        删掉用不到的节（段落内容太短会被文档检查判为占位）。" -ForegroundColor DarkGray
    Write-Host ''
    Write-Host '写完后再跑一次本脚本，就会继续往下走：' -ForegroundColor Yellow
    Write-Host "    .\scripts\release.ps1 -Version $newVersion" -ForegroundColor White
    Write-Host ''
    exit 1
}
Write-Ok "更新日志里已有 [$newVersion] 段落"

# ---------------------------------------------------------------- 4. 写入版本号
Write-Step '写入版本号'

$pkgText = Read-Utf8 $pkgPath
$pkgText = $pkgText -replace '("version"\s*:\s*")[^"]+(")', "`${1}$newVersion`${2}"
[System.IO.File]::WriteAllText($pkgPath, $pkgText, (New-Object System.Text.UTF8Encoding($false)))
Write-Ok "app\package.json -> $newVersion"

$rmText = Read-Utf8 $readmePath
$rmNew = $rmText -replace '(\*\*当前版本\s*v)[0-9]+\.[0-9]+\.[0-9]+(\*\*)', "`${1}$newVersion`${2}"
if ($rmNew -ne $rmText) {
    [System.IO.File]::WriteAllText($readmePath, $rmNew, (New-Object System.Text.UTF8Encoding($false)))
    Write-Ok "README.md 当前版本 -> v$newVersion"
}
else { Write-Warn2 'README 里没找到「**当前版本 vX.Y.Z**」标记，跳过' }

# ---------------------------------------------------------------- 5. 验证
Write-Step '运行验证'

$checks = @(
    @{ name = '文档一致性'; file = 'scripts\文档一致性验证.js' },
    @{ name = '数据管控';   file = 'scripts\数据管控验证.js' },
    @{ name = '设置持久化'; file = 'scripts\设置持久化验证.js' }
)
foreach ($c in $checks) {
    $p = Join-Path $Root $c.file
    if (-not (Test-Path $p)) { Write-Warn2 "跳过（找不到 $($c.file)）"; continue }
    $out = & node $p 2>&1
    $code = $LASTEXITCODE
    $tail = ($out | Select-Object -Last 1)
    if ($code -ne 0) {
        Write-Host "    ✗ $($c.name)：$tail" -ForegroundColor Red
        $out | ForEach-Object { Write-Host "        $_" -ForegroundColor DarkGray }
        throw "$($c.name) 验证未通过。文档/代码不一致时不允许发布。"
    }
    Write-Ok "$($c.name)：$tail"
}

# ---------------------------------------------------------------- 6. 构建
if ($NoBuild) { Write-Step '构建'; Write-Dim '已指定 -NoBuild，跳过' }
else {
    Write-Step '构建便携版'
    & (Join-Path $Root 'scripts\build-portable.ps1') | Out-Null
    if ($LASTEXITCODE -ne 0) { throw '构建失败。' }
    Write-Ok '构建完成'
}

# ---------------------------------------------------------------- 7. 提交 + 标签
Write-Step '提交并打标签'

if (-not $Message) {
    # 从更新日志该版本的「主题」那行取一句
    $m = [regex]::Match($log, "##\s*\[" + [regex]::Escape($newVersion) + "\]\s*—[^\n]*\n+(\*\*主题：\*\*[^\n]*)")
    $theme = if ($m.Success) { ($m.Groups[1].Value -replace '^\*\*主题：\*\*\s*', '').Trim() } else { '' }
    $Message = if ($theme) { "release(v$newVersion): $theme" } else { "release(v$newVersion)" }
}

git add -A
$old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
git commit -q -m $Message 2>&1 | Out-Null
$ErrorActionPreference = $old
if ($LASTEXITCODE -ne 0) { throw "提交失败（可能没有实际变更）。" }
Write-Ok "已提交：$Message"

git tag -a "v$newVersion" -m "v$newVersion`n`n$Message`n`n详见 docs/更新日志.md 的 [$newVersion] 条目。"
Write-Ok "已打标签 v$newVersion"

# ---------------------------------------------------------------- 8. 推送
if ($NoPush) {
    Write-Step '推送'
    Write-Dim '已指定 -NoPush，跳过。手动推送：.\scripts\push-to-github.ps1'
}
else {
    Write-Step '推送分支与标签'
    & (Join-Path $Root 'scripts\push-to-github.ps1')
    if ($LASTEXITCODE -ne 0) { throw '推送失败 —— 提交与标签已在本地完成，修好通道后再跑 .\scripts\push-to-github.ps1 即可。' }
}

Write-Host ''
Write-Host "发布完成：v$newVersion" -ForegroundColor Green
Write-Host '  package.json / README / 更新日志 / 标签 都已同步' -ForegroundColor DarkGray
Write-Host ''
