#Requires -Version 5.1
<#
.SYNOPSIS
    把本仓库推送到 GitHub（自动适配受限网络环境）。

.DESCRIPTION
    一条命令搞定"提交 → 推送 → 推标签"，并且会自动绕开两类常见障碍：

      障碍一（TLS）：本机装了 Steam++ / Watt Toolkit 这类加速器时，它把 github.com 的 DNS
        劫持到 127.0.0.1 并用自己的根证书做中间人。走 schannel 的 git 能信任它；但如果
        schannel 本身不可用（AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS），
        就只能改用 git 自带的 openssl 后端，而它只认自己的 CA bundle —— 于是报
        "unable to get local issuer certificate"。
        → 脚本自动合并「git 自带公共根证书 + 本机自签名根证书」成 bundle，
          用环境变量把 openssl 后端与 sslCAInfo 传给 git（不写进 .git/config）。

      障碍二（凭证）：git 把 credential.helper=manager 解析成 shell 包装脚本，
        于是要先起 MSYS 的 sh.exe；某些受限环境禁止创建命名管道，sh.exe 起不来，
        凭证助手没被调用 → "could not read Username"。
        → 脚本直接调用 git-credential-manager.exe（不经过 sh）取出已缓存的凭证，
          拼成 Authorization 头经环境变量交给 git。**全程不打印 token**。

    在正常环境里这两条分支都不会触发，脚本就是普通的 git push。

.PARAMETER RepoUrl
    GitHub 仓库地址。**可以省略** —— 省略时沿用已有的 origin，
    所以日常更新只需要跑 `.\scripts\push-to-github.ps1`。

.PARAMETER Branch
    分支名，默认 main。

.PARAMETER Pull
    推送前先从远端拉取并合并（远端有本仓库没有的提交时用）。

.PARAMETER NoAutoFix
    关闭自动适配，只用最朴素的 git push。

.PARAMETER Check
    只探测推送通道是否可用，不做任何推送。

.EXAMPLE
    # 日常更新：提交并推送（沿用已有 origin）
    .\scripts\push-to-github.ps1

.EXAMPLE
    # 首次推送，指定仓库地址
    .\scripts\push-to-github.ps1 -RepoUrl 'https://github.com/yourname/music-player.git'

.EXAMPLE
    # 远端建仓时勾了 README，需要先合并
    .\scripts\push-to-github.ps1 -Pull

.EXAMPLE
    # 只检查通道
    .\scripts\push-to-github.ps1 -Check
#>
[CmdletBinding()]
param(
    [string]$RepoUrl,
    [string]$Branch = 'main',
    [switch]$Pull,
    [switch]$NoAutoFix,
    [switch]$Check
)

$ErrorActionPreference = 'Stop'

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Write-Warn2($m){ Write-Host "    $m" -ForegroundColor Yellow }
function Write-Dim($m)  { Write-Host "    $m" -ForegroundColor DarkGray }

# ================================================================ 环境变量式 git 配置
# 用 GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n 传配置，
# 而不是写进 .git/config：只在本次命令生效，不会污染仓库配置。
$script:GitCfg = [ordered]@{}

function Set-GitCfg([string]$k, [string]$v) { $script:GitCfg[$k] = $v }

function Apply-GitCfg {
    if ($script:GitCfg.Count -eq 0) {
        foreach ($n in @('GIT_CONFIG_COUNT','GIT_CONFIG_KEY_0','GIT_CONFIG_VALUE_0',
                         'GIT_CONFIG_KEY_1','GIT_CONFIG_VALUE_1','GIT_CONFIG_KEY_2','GIT_CONFIG_VALUE_2')) {
            Remove-Item "Env:$n" -ErrorAction SilentlyContinue
        }
        return
    }
    $env:GIT_CONFIG_COUNT = [string]$script:GitCfg.Count
    $i = 0
    foreach ($k in $script:GitCfg.Keys) {
        Set-Item -Path "Env:GIT_CONFIG_KEY_$i"   -Value $k
        Set-Item -Path "Env:GIT_CONFIG_VALUE_$i" -Value $script:GitCfg[$k]
        $i++
    }
}

# ================================================================ git 调用封装
# git 的进度信息写在 stderr（"To https://..."、"Writing objects"），
# 而 EAP=Stop 下把 stderr 并入管道会被 PowerShell 当成终止性错误 —— 必须放宽 EAP。
function Invoke-GitCapture {
    param([string[]]$GitArgs)
    Apply-GitCfg
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $out = & git @GitArgs 2>&1
        $code = $LASTEXITCODE
    }
    finally { $ErrorActionPreference = $old }
    return [pscustomobject]@{
        Code   = $code
        Text   = (($out | ForEach-Object { "$_" }) -join "`n")
        Lines  = @($out | ForEach-Object { "$_" })
    }
}

function Show-GitResult($r, [string]$indent = '    ') {
    foreach ($l in $r.Lines) { Write-Host "$indent$l" -ForegroundColor DarkGray }
}

# ================================================================ 错误分类
function Get-FailureKind([string]$text) {
    if ($text -match 'SSL certificate|unable to get local issuer|certificate verify failed|SSL_ERROR|SEC_E_NO_CREDENTIALS|AcquireCredentialsHandle|schannel') {
        return 'tls'
    }
    if ($text -match "could not read Username|couldn't create signal pipe|terminal prompts disabled|Authentication failed|Invalid username or password|Support for password authentication was removed") {
        return 'credential'
    }
    if ($text -match 'Could not resolve host|Failed to connect|Connection timed out|Connection refused|unable to access') {
        return 'network'
    }
    if ($text -match 'non-fast-forward|fetch first|rejected') { return 'nonfastforward' }
    return 'unknown'
}

# ================================================================ 兜底一：TLS 通道
function Enable-OpensslChannel {
    $setup = Join-Path $PSScriptRoot 'setup-push-tls.ps1'
    if (-not (Test-Path $setup)) { Write-Warn2 '找不到 setup-push-tls.ps1，跳过 TLS 兜底'; return $false }

    # -Quiet：抑制 setup 脚本那 50 多行证书清单，这里只报结论
    $bundle = & $setup -EmitPath -Quiet
    if (-not $bundle -or -not (Test-Path $bundle)) { Write-Warn2 'CA bundle 生成失败'; return $false }

    Set-GitCfg 'http.sslBackend' 'openssl'
    Set-GitCfg 'http.sslCAInfo'  $bundle
    Write-Ok "已启用 openssl 后端 + 本机 CA bundle"
    Write-Dim $bundle
    return $true
}

# ================================================================ 兜底二：缓存凭证
function Resolve-GcmExe {
    $cands = @()
    $g = Get-Command 'git-credential-manager.exe' -ErrorAction SilentlyContinue
    if ($g) { $cands += $g.Source }
    $gitExe = (Get-Command git -ErrorAction SilentlyContinue).Source
    if ($gitExe) {
        $gitRoot = Split-Path (Split-Path $gitExe -Parent) -Parent
        $cands += (Join-Path $gitRoot 'mingw64\bin\git-credential-manager.exe')
        $cands += (Join-Path $gitRoot 'mingw64\libexec\git-core\git-credential-manager.exe')
    }
    $cands += 'C:\Program Files\Git\mingw64\bin\git-credential-manager.exe'
    foreach ($c in $cands) { if ($c -and (Test-Path $c)) { return $c } }
    return $null
}

function Enable-CachedCredentialChannel([string]$url) {
    # 只对 HTTPS 远程有效；SSH 走的是密钥，不需要凭证头
    if ($url -notmatch '^https?://') { Write-Warn2 '远程不是 HTTPS，跳过凭证兜底'; return $false }

    $hostName = ([Uri]$url).Host
    $gcm = Resolve-GcmExe
    if (-not $gcm) { Write-Warn2 '找不到 git-credential-manager.exe，跳过凭证兜底'; return $false }

    # 直接调用 exe（不经过 sh 包装脚本），用 PowerShell 的管道喂输入
    $req = "protocol=https`nhost=$hostName`n`n"
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $raw = @($req | & $gcm get 2>$null) } catch { $raw = @() }
    finally { $ErrorActionPreference = $old }

    $user = $null; $pass = $null
    foreach ($line in $raw) {
        if ($line -match '^username=(.*)$') { $user = $Matches[1] }
        elseif ($line -match '^password=(.*)$') { $pass = $Matches[1] }
    }
    if (-not $user -or -not $pass) {
        Write-Warn2 "凭据管理器里没有 $hostName 的缓存凭证"
        Write-Dim '先在本机终端手动 push 一次完成登录，之后就能自动取用'
        return $false
    }

    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes("$user`:$pass"))
    Set-GitCfg 'http.extraheader' "Authorization: Basic $b64"
    # 只报告"拿到了"，不报告内容
    Write-Ok "已启用缓存凭证（user=$user，token 长度 $($pass.Length)，内容不打印）"
    $pass = $null
    return $true
}

# ================================================================ 0. 环境检查
Write-Step '检查环境'

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw '找不到 git，请先安装 Git for Windows：https://git-scm.com/download/win'
}
Write-Ok "git $(git --version)"

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not (Test-Path (Join-Path $root '.git'))) { throw "当前目录不是 git 仓库：$root" }
Write-Ok "仓库根目录：$root"

# ================================================================ 1. 提交身份
Write-Step '检查提交身份'
if (-not (git config user.name))  { git config user.name  (Read-Host '请输入 git 用户名') }
if (-not (git config user.email)) { git config user.email (Read-Host '请输入 git 邮箱') }
Write-Ok "user.name  = $(git config user.name)"
Write-Ok "user.email = $(git config user.email)"

# ================================================================ 2. 提交记录
Write-Step '检查提交记录'
$count = git rev-list --count HEAD 2>$null
if (-not $count -or [int]$count -eq 0) { throw '还没有任何提交，请先提交再推送。' }
Write-Ok "共 $count 个提交，最新：$(git log -1 --pretty=format:'%h %s')"

$dirty = git status --porcelain
if ($dirty -and -not $Check) {
    Write-Warn2 '有未提交的改动：'
    $dirty | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    $ans = Read-Host '是否先提交这些改动？(Y/n)'
    if ($ans -eq '' -or $ans -match '^[Yy]') {
        git add -A
        $msg = Read-Host '提交信息（直接回车使用默认）'
        if (-not $msg) { $msg = 'chore: 更新' }
        $env:GIT_CONFIG_COUNT = $null
        $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        git commit -m $msg | Out-Null
        $ErrorActionPreference = $old
        Write-Ok '已提交'
    }
}

# ================================================================ 3. 远程地址
Write-Step '确定 origin 远程地址'

$hasOrigin = (git remote 2>$null) -contains 'origin'
if (-not $RepoUrl) {
    if (-not $hasOrigin) {
        throw '没有指定 -RepoUrl，且仓库里没有 origin。请加 -RepoUrl 指定仓库地址。'
    }
    $RepoUrl = (git remote get-url origin).Trim()
    Write-Ok "沿用已有 origin：$RepoUrl"
}
else {
    $RepoUrl = $RepoUrl.Trim()
    if ($hasOrigin) {
        $old = git remote get-url origin
        if ($old -ne $RepoUrl) { git remote set-url origin $RepoUrl; Write-Ok "已更新：$old -> $RepoUrl" }
        else { Write-Ok "已是目标地址：$RepoUrl" }
    }
    else { git remote add origin $RepoUrl; Write-Ok "已添加：$RepoUrl" }
}

$cur = git rev-parse --abbrev-ref HEAD
if ($cur -ne $Branch) { git branch -M $Branch; Write-Ok "分支 $cur -> $Branch" }

# ================================================================ 4. 打通推送通道
Write-Step '探测推送通道'
$probe = Invoke-GitCapture @('ls-remote', '--heads', 'origin')
$tlsFixed = $false
$credFixed = $false

if ($probe.Code -eq 0) {
    Write-Ok '直连可用（schannel + 凭据管理器均正常）'
}
elseif ($NoAutoFix) {
    Write-Warn2 '通道探测失败，且已指定 -NoAutoFix，不再尝试兜底'
    Show-GitResult $probe
}
else {
    Write-Warn2 "直连失败（退出码 $($probe.Code)），开始自动适配"
    $kind = Get-FailureKind $probe.Text
    Write-Dim "判定类型：$kind"

    if ($kind -eq 'tls' -or $kind -eq 'unknown') {
        Write-Dim '尝试：改用 openssl 后端 + 合并本机 CA'
        $tlsFixed = Enable-OpensslChannel
        if ($tlsFixed) { $probe = Invoke-GitCapture @('ls-remote', '--heads', 'origin') }
    }

    if ($probe.Code -ne 0 -and $kind -ne 'network') {
        $kind2 = Get-FailureKind $probe.Text
        if ($kind2 -eq 'credential' -or $kind2 -eq 'tls' -or $kind2 -eq 'unknown') {
            Write-Dim '尝试：直接取缓存凭证作为 Authorization 头'
            $credFixed = Enable-CachedCredentialChannel $RepoUrl
            if ($credFixed) { $probe = Invoke-GitCapture @('ls-remote', '--heads', 'origin') }
        }
    }

    if ($probe.Code -eq 0) {
        Write-Ok '通道已打通'
    }
    else {
        Write-Host ''
        Write-Host '通道仍然不通' -ForegroundColor Red
        Show-GitResult $probe
        Write-Host ''
        Write-Host '下一步：' -ForegroundColor Yellow
        Write-Host '  · 关掉 Steam++ / Watt Toolkit 对 GitHub 的加速，再重试（最省事）' -ForegroundColor DarkGray
        Write-Host '  · 单独跑 .\scripts\setup-push-tls.ps1 -Test 看 TLS 是否通了' -ForegroundColor DarkGray
        Write-Host '  · 单独跑 .\scripts\push-to-github.ps1 -Check 复现本次探测' -ForegroundColor DarkGray
        Write-Host '  · 远端有本仓库没有的提交时加 -Pull' -ForegroundColor DarkGray
        Write-Host ''
        exit 1
    }
}

if ($Check) {
    Write-Host ''
    Write-Host '通道检查完成（未推送）' -ForegroundColor Green
    exit 0
}

# ================================================================ 5. 可选：先拉取
if ($Pull) {
    Write-Step "从 origin/$Branch 拉取并合并"
    $f = Invoke-GitCapture @('fetch', 'origin', $Branch)
    if ($f.Code -ne 0) { Show-GitResult $f; throw "git fetch 失败（退出码 $($f.Code)）" }
    # --allow-unrelated-histories：远端是网页上建的仓库（带 README）时必需
    $p = Invoke-GitCapture @('pull', '--no-rebase', '--allow-unrelated-histories', 'origin', $Branch)
    Show-GitResult $p
    if ($p.Code -ne 0) { throw "git pull 失败（退出码 $($p.Code)），请手动解决冲突后重试。" }
    Write-Ok '合并完成'
}

# ================================================================ 6. 推送
Write-Step "推送到 origin/$Branch"
if (-not $tlsFixed -and -not $credFixed) {
    Write-Dim '首次推送会弹出 GitHub 登录窗口（Git Credential Manager）'
}
Write-Host ''

# 凭证兜底必须挂在**真正需要认证的这一步**上，而不是前面的探测上：
# 公开仓库的 ls-remote 根本不需要凭证，所以探测成功并不代表能推送。
# 这里在 push 失败且判定为认证 / TLS 类问题时，取缓存凭证重试一次。
$push = Invoke-GitCapture @('push', '-u', 'origin', $Branch)

if ($push.Code -ne 0 -and -not $credFixed -and -not $NoAutoFix) {
    $k = Get-FailureKind $push.Text
    if ($k -eq 'credential' -or $k -eq 'tls') {
        Write-Warn2 "推送被拒（判定：$k），尝试取缓存凭证后重试一次"
        if (Enable-CachedCredentialChannel $RepoUrl) {
            $credFixed = $true
            $push = Invoke-GitCapture @('push', '-u', 'origin', $Branch)
        }
    }
}

Show-GitResult $push

if ($push.Code -ne 0) {
    Write-Host ''
    Write-Host "推送失败（git 退出码 $($push.Code)）" -ForegroundColor Red
    Write-Host ''
    $kind = Get-FailureKind $push.Text
    switch ($kind) {
        'nonfastforward' {
            Write-Host '远端有本仓库没有的提交 —— 加 -Pull 参数后再试：' -ForegroundColor Yellow
            Write-Host "    .\scripts\push-to-github.ps1 -Pull" -ForegroundColor DarkGray
        }
        'credential' {
            Write-Host '认证问题：' -ForegroundColor Yellow
            Write-Host '  · GitHub 已取消密码认证，需用 Personal Access Token' -ForegroundColor DarkGray
            Write-Host '    https://github.com/settings/tokens → Generate new token (classic) → 勾选 repo' -ForegroundColor DarkGray
            Write-Host '  · 或改用 SSH：git remote set-url origin git@github.com:用户名/仓库.git' -ForegroundColor DarkGray
            Write-Host '  · 或安装 GitHub CLI 后 gh auth login' -ForegroundColor DarkGray
        }
        'tls' {
            Write-Host 'TLS 问题：' -ForegroundColor Yellow
            Write-Host '  · .\scripts\setup-push-tls.ps1 -Test' -ForegroundColor DarkGray
            Write-Host '  · 或在 Steam++ 里关掉 GitHub 加速' -ForegroundColor DarkGray
        }
        default {
            Write-Host '  · 用 git remote -v 核对仓库地址' -ForegroundColor DarkGray
            Write-Host '  · 用 .\scripts\push-to-github.ps1 -Check 复现探测' -ForegroundColor DarkGray
        }
    }
    Write-Host ''
    exit 1
}

# ================================================================ 7. 推送版本标签
$tags = @(git tag --list)
if ($tags.Count -gt 0) {
    Write-Step "推送 $($tags.Count) 个版本标签"
    $tp = Invoke-GitCapture @('push', 'origin', '--tags')
    Show-GitResult $tp
    if ($tp.Code -ne 0) {
        Write-Warn2 "标签推送失败（退出码 $($tp.Code)）—— 代码已推送成功，可稍后单独执行 git push origin --tags"
    }
    else {
        $tags | ForEach-Object { Write-Ok $_ }
    }
}
else {
    Write-Warn2 '没有标签可推送（可用 git tag -a v1.1.1 -m "说明" 创建版本标签）'
}

# ================================================================ 8. 完成
$web = $RepoUrl -replace '\.git$', '' -replace '^git@github\.com:', 'https://github.com/'
Write-Host ''
Write-Host '推送成功' -ForegroundColor Green
Write-Host "  仓库地址 : $web"
Write-Host "  分支     : $Branch"
if ($tags.Count -gt 0) { Write-Host "  版本标签 : $($tags -join ', ')" }
if ($tlsFixed)  { Write-Host '  通道     : openssl 后端 + 本机 CA bundle' -ForegroundColor DarkGray }
if ($credFixed) { Write-Host '  凭证     : 直接取自凭据管理器（未打印内容）' -ForegroundColor DarkGray }
Write-Host ''
