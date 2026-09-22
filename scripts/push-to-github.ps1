#Requires -Version 5.1
<#
.SYNOPSIS
    把本仓库推送到 GitHub。

.DESCRIPTION
    新手友好的一步到位脚本：
      1. 检查 git 是否可用、是否在仓库根目录
      2. 检查提交身份（user.name / user.email）是否已配置
      3. 设置或更新 origin 远程地址
      4. 若远端仓库非空，先拉取并合并（避免 non-fast-forward 报错）
      5. 推送到 main 分支并打印结果

    脚本本身不保存任何凭证 —— 认证交给 git 的凭据管理器
    （Windows 上通常是 Git Credential Manager，会弹出浏览器登录窗口）。

.PARAMETER RepoUrl
    GitHub 仓库地址，HTTPS 或 SSH 均可。
    例如 https://github.com/yourname/music-player.git
          git@github.com:yourname/music-player.git

.PARAMETER Branch
    分支名，默认 main。

.PARAMETER Pull
    推送前先从远端拉取并合并（远端仓库已存在内容时用）。

.EXAMPLE
    .\scripts\push-to-github.ps1 -RepoUrl 'https://github.com/yourname/music-player.git'

.EXAMPLE
    # 远端已经建过仓库、带 README 的情况
    .\scripts\push-to-github.ps1 -RepoUrl 'git@github.com:yourname/music-player.git' -Pull
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RepoUrl,

    [string]$Branch = 'main',

    [switch]$Pull
)

$ErrorActionPreference = 'Stop'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------- 0. 环境检查
Write-Step '检查环境'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw '找不到 git，请先安装 Git for Windows：https://git-scm.com/download/win'
}
Write-Ok "git $(git --version)"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Test-Path (Join-Path $root '.git'))) {
    throw "当前目录不是 git 仓库：$root"
}
Write-Ok "仓库根目录：$root"

# 去掉网址末尾的 .git 之外的空格与斜杠
$RepoUrl = $RepoUrl.Trim()

# ---------------------------------------------------------------- 1. 提交身份
Write-Step '检查提交身份'

$name  = git config user.name
$email = git config user.email
if (-not $name -or -not $email) {
    Write-Warn2 '尚未配置提交身份（user.name / user.email）'
    $name  = Read-Host '请输入 git 用户名（会显示在提交记录里）'
    $email = Read-Host '请输入 git 邮箱（建议用 GitHub 账号邮箱）'
    git config user.name  $name
    git config user.email $email
}
Write-Ok "user.name  = $(git config user.name)"
Write-Ok "user.email = $(git config user.email)"

# ---------------------------------------------------------------- 2. 确认有提交
Write-Step '检查提交记录'
$count = git rev-list --count HEAD 2>$null
if (-not $count -or [int]$count -eq 0) { throw '还没有任何提交，请先提交再推送。' }
Write-Ok "共 $count 个提交，最新：$(git log -1 --pretty=format:'%h %s')"

$dirty = git status --porcelain
if ($dirty) {
    Write-Warn2 '有未提交的改动：'
    $dirty | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    $ans = Read-Host '是否先提交这些改动？(Y/n)'
    if ($ans -eq '' -or $ans -match '^[Yy]') {
        git add -A
        $msg = Read-Host '提交信息（直接回车使用默认）'
        if (-not $msg) { $msg = 'chore: 更新' }
        git commit -m $msg | Out-Null
        Write-Ok '已提交'
    }
}

# ---------------------------------------------------------------- 3. 设置远程
Write-Step '设置 origin 远程地址'

$existing = git remote 2>$null
if ($existing -contains 'origin') {
    $old = git remote get-url origin
    if ($old -ne $RepoUrl) {
        git remote set-url origin $RepoUrl
        Write-Ok "已更新：$old -> $RepoUrl"
    }
    else {
        Write-Ok "已是目标地址：$RepoUrl"
    }
}
else {
    git remote add origin $RepoUrl
    Write-Ok "已添加：$RepoUrl"
}

# 确保分支名正确
$cur = git rev-parse --abbrev-ref HEAD
if ($cur -ne $Branch) {
    Write-Ok "当前分支 $cur -> 重命名为 $Branch"
    git branch -M $Branch
}

# ---------------------------------------------------------------- 4. 可选：先拉取
if ($Pull) {
    Write-Step "从 origin/$Branch 拉取并合并"
    git fetch origin $Branch
    if ($LASTEXITCODE -ne 0) { throw "git fetch 失败（退出码 $LASTEXITCODE），请核对仓库地址与权限。" }
    # --allow-unrelated-histories：远端是网页上建的仓库（带 README）时必需
    git pull --no-rebase --allow-unrelated-histories origin $Branch
    if ($LASTEXITCODE -ne 0) { throw "git pull 失败（退出码 $LASTEXITCODE），请手动解决冲突后重试。" }
    Write-Ok '合并完成'
}

# ---------------------------------------------------------------- 5. 推送
Write-Step "推送到 origin/$Branch"
Write-Host '    首次推送会弹出 GitHub 登录窗口（Git Credential Manager）' -ForegroundColor DarkGray
Write-Host ''

git push -u origin $Branch
# 注意：PowerShell 5.1 的 $ErrorActionPreference = 'Stop' 不覆盖原生命令的退出码，
# 必须显式检查，否则推送失败也会打印"推送成功"。
if ($LASTEXITCODE -ne 0) {
    Write-Host ''
    Write-Host "推送失败（git 退出码 $LASTEXITCODE）" -ForegroundColor Red
    Write-Host ''
    Write-Host '常见原因与解决办法：' -ForegroundColor Yellow
    Write-Host '  · 认证失败 / 要求密码 —— GitHub 已取消密码认证，需用 Personal Access Token：' -ForegroundColor DarkGray
    Write-Host '      https://github.com/settings/tokens  →  Generate new token (classic)  →  勾选 repo' -ForegroundColor DarkGray
    Write-Host '      然后在弹出的登录框里，用户名填 GitHub 用户名，密码粘贴 token' -ForegroundColor DarkGray
    Write-Host '  · 远端已有内容导致 non-fast-forward —— 加 -Pull 参数后再试' -ForegroundColor DarkGray
    Write-Host '  · 仓库地址写错或没有权限 —— 用 git remote -v 核对' -ForegroundColor DarkGray
    Write-Host '  · 想改用 SSH —— git remote set-url origin git@github.com:用户名/仓库.git' -ForegroundColor DarkGray
    Write-Host '  · 已装 GitHub CLI 的话，先执行 gh auth login 最省事' -ForegroundColor DarkGray
    Write-Host ''
    exit 1
}

Write-Host ''
Write-Host '推送成功' -ForegroundColor Green
$web = $RepoUrl -replace '\.git$', '' -replace '^git@github\.com:', 'https://github.com/'
Write-Host "  仓库地址 : $web"
Write-Host "  分支     : $Branch"
Write-Host ''
Write-Host '如果认证失败，通常是以下原因：' -ForegroundColor DarkGray
Write-Host '  · 密码认证已被 GitHub 取消 —— 需用 Personal Access Token 代替密码' -ForegroundColor DarkGray
Write-Host '    生成地址：https://github.com/settings/tokens （勾选 repo 权限）' -ForegroundColor DarkGray
Write-Host '  · 或改用 SSH：git remote set-url origin git@github.com:用户名/仓库.git' -ForegroundColor DarkGray
Write-Host '  · 或安装 GitHub CLI 后执行 gh auth login' -ForegroundColor DarkGray
