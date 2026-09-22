#Requires -Version 5.1
<#
.SYNOPSIS
    准备 git 推送通道：让 git 能穿过本机的加速器（Steam++ / Watt Toolkit）访问 GitHub。

.DESCRIPTION
    适用场景
    --------
    本机装了 SteamTools / Watt Toolkit（Steam++）这类加速器时，它会把 github.com 的 DNS
    劫持到 127.0.0.1 并用自己的根证书做 TLS 中间人。这个根证书装在 Windows 证书库里，
    所以走 **schannel** 的 git 天然信任它，推送正常。

    但在某些受限环境里 schannel 完全不可用：

        schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)

    此时改用 git 自带的 **openssl** 后端就能连上（它不依赖 Windows 加密服务），
    代价是它只认自己的 CA bundle，不认识加速器的根证书，于是报：

        SSL certificate problem: unable to get local issuer certificate

    本脚本就是为这条路准备的：把 git 自带的公共根证书 + 本机证书库里的
    自签根证书（加速器的中间人 CA）合并成一个 bundle，然后用环境变量把
    `http.sslBackend=openssl` 与 `http.sslCAInfo=<bundle>` 传给 git。

    用环境变量而不是写进 .git/config：**不改动仓库配置**，只在本次命令生效，
    不会影响你在自己终端里的正常 git 行为。

.PARAMETER Test
    生成 bundle 后立刻用 `git ls-remote` 验证通道是否可用。

.PARAMETER PrintEnv
    只打印需要设置的环境变量，不执行任何 git 命令。

.PARAMETER SetEnv
    直接把 GIT_CONFIG_* 写进**当前进程环境**（后续 git 子进程自动继承）。
    $env: 是进程级变量，所以即使在子作用域里调用也能生效。

.PARAMETER EmitPath
    只把生成的 bundle 路径写到管道（配合 -Quiet 供其它脚本调用）。
    push-to-github.ps1 的 TLS 兜底就是走这条路。

.PARAMETER Quiet
    抑制流程输出，只保留结果。

.EXAMPLE
    .\scripts\setup-push-tls.ps1 -Test

.EXAMPLE
    # 自己手动跑：先把环境变量设进当前会话，再正常用 git
    .\scripts\setup-push-tls.ps1 -SetEnv
    git push origin main

.EXAMPLE
    # 别的脚本里取路径
    $bundle = & .\scripts\setup-push-tls.ps1 -EmitPath -Quiet
#>
[CmdletBinding()]
param(
    [switch]$Test,
    [switch]$PrintEnv,
    [switch]$EmitPath,
    [switch]$SetEnv,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$Root    = Split-Path -Parent $PSScriptRoot
$CaDir   = Join-Path $Root 'dist\git-ca'
$Bundle  = Join-Path $CaDir 'ca-bundle.pem'

# -Quiet 供其它脚本调用时抑制流程输出（Write-Host 不走管道，所以不会污染 -EmitPath 的返回值）
function Write-Step($m) { if (-not $Quiet) { Write-Host "==> $m" -ForegroundColor Cyan } }
function Write-Ok($m)   { if (-not $Quiet) { Write-Host "    $m" -ForegroundColor Green } }
function Write-Warn2($m){ if (-not $Quiet) { Write-Host "    $m" -ForegroundColor Yellow } }

# ---------------------------------------------------------------- 1. 基准 CA
Write-Step '收集 CA 证书'

$gitCas = @(
    'C:\Program Files\Git\mingw64\etc\ssl\certs\ca-bundle.crt',
    'C:\Program Files\Git\mingw64\ssl\certs\ca-bundle.crt',
    'C:\Program Files\Git\usr\ssl\certs\ca-bundle.crt'
) | Where-Object { Test-Path $_ }

if (-not $gitCas) {
    # 退路：用 Node 自带的 CA 包
    $nodeCa = Join-Path (Split-Path (Get-Command node -ErrorAction SilentlyContinue).Source) '..\..\..\nodejs\node_modules\npm\node_modules\ca\lib\certs.js'
    throw "找不到 git 自带的 CA bundle，请确认已安装 Git for Windows。"
}
if ($gitCas.Count -gt 1) { Write-Warn2 "找到多个候选，使用第一个：$($gitCas[0])" }

$out = [System.IO.File]::ReadAllText($gitCas[0], [System.Text.Encoding]::ASCII)
Write-Ok "基准公共根证书：$($gitCas[0])  ($([math]::Round($out.Length/1KB,1)) KB)"

# ---------------------------------------------------------------- 2. 追加本机自签根证书
# 只追加"自签"（Subject == Issuer）的根证书，也就是本机安装的中间人/私有 CA。
# 公共根证书已经在基准 bundle 里，不必重复。
$selfSigned = Get-ChildItem 'Cert:\LocalMachine\Root' -ErrorAction SilentlyContinue |
    Where-Object { $_.Subject -eq $_.Issuer -and $_.NotAfter -gt (Get-Date) }

$added = @()
foreach ($c in $selfSigned) {
    $b64 = [Convert]::ToBase64String($c.RawData)
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.AppendLine('# ' + ($c.Subject -replace ',', ' / '))
    [void]$sb.AppendLine('-----BEGIN CERTIFICATE-----')
    for ($i = 0; $i -lt $b64.Length; $i += 64) {
        [void]$sb.AppendLine($b64.Substring($i, [Math]::Min(64, $b64.Length - $i)))
    }
    [void]$sb.AppendLine('-----END CERTIFICATE-----')
    $out += "`n" + $sb.ToString()

    $cn = ($c.Subject -split ',')[0]
    $added += $cn
}

New-Item -ItemType Directory -Force -Path $CaDir | Out-Null
[System.IO.File]::WriteAllText($Bundle, $out, (New-Object System.Text.UTF8Encoding($false)))

Write-Ok "合并 $($added.Count) 张本机自签根证书："
# 这两处原先是裸 Write-Host，会绕过 -Quiet —— 由 push-to-github.ps1 调用时刷屏。
if (-not $Quiet) {
    $added | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
}
Write-Ok "bundle: $Bundle  ($([math]::Round((Get-Item $Bundle).Length/1KB,1)) KB)"
if (-not $Quiet) {
    Write-Host ''
    Write-Host '    注意：bundle 里含有本机私有 CA，它只应当留在本机 ——' -ForegroundColor DarkGray
    Write-Host "    dist\ 已被 .gitignore 排除，所以不会被提交。" -ForegroundColor DarkGray
}

# ---------------------------------------------------------------- 3. 只输出路径（供其它脚本调用）
if ($EmitPath) {
    # Write-Output 走管道 → 调用方用 & $setup -EmitPath -Quiet 即可拿到纯路径
    Write-Output $Bundle
    return
}

# ---------------------------------------------------------------- 4. 直接设置到当前进程环境
if ($SetEnv) {
    # $env: 是进程级变量，即使本脚本是子作用域，后续 git 子进程也能继承
    $env:GIT_CONFIG_COUNT    = '2'
    $env:GIT_CONFIG_KEY_0    = 'http.sslBackend'
    $env:GIT_CONFIG_VALUE_0  = 'openssl'
    $env:GIT_CONFIG_KEY_1    = 'http.sslCAInfo'
    $env:GIT_CONFIG_VALUE_1  = $Bundle
    Write-Ok "已设置 GIT_CONFIG_* 环境变量（本次进程内生效）"
    return
}

# ---------------------------------------------------------------- 5. 打印环境变量
if ($PrintEnv) {
    Write-Host ''
    Write-Host '在本次会话里执行这几行，之后的 git 命令就能直连 GitHub：' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '    $env:GIT_CONFIG_COUNT   = "2"' -ForegroundColor White
    Write-Host '    $env:GIT_CONFIG_KEY_0   = "http.sslBackend"' -ForegroundColor White
    Write-Host '    $env:GIT_CONFIG_VALUE_0 = "openssl"' -ForegroundColor White
    Write-Host '    $env:GIT_CONFIG_KEY_1   = "http.sslCAInfo"' -ForegroundColor White
    Write-Host "    `$env:GIT_CONFIG_VALUE_1 = `"$Bundle`"" -ForegroundColor White
    Write-Host ''
    return
}

# ---------------------------------------------------------------- 6. 验证通道
if ($Test) {
    Write-Step '验证通道（git ls-remote，只读，不需要凭证）'
    $env:GIT_CONFIG_COUNT   = '2'
    $env:GIT_CONFIG_KEY_0   = 'http.sslBackend'
    $env:GIT_CONFIG_VALUE_0 = 'openssl'
    $env:GIT_CONFIG_KEY_1   = 'http.sslCAInfo'
    $env:GIT_CONFIG_VALUE_1 = $Bundle
    $env:GIT_TERMINAL_PROMPT = '0'

    Push-Location $Root
    try {
        $url = git remote get-url origin 2>$null
        if (-not $url) { Write-Warn2 '仓库还没有配置 origin，跳过验证'; return }
        Write-Ok "origin = $url"
        $old = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try { $res = @(& git ls-remote $url 2>&1); $code = $LASTEXITCODE }
        finally { $ErrorActionPreference = $old }
        if ($code -eq 0) {
            Write-Ok '通道可用 ✓'
            $res | Select-Object -First 8 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
        }
        else {
            Write-Warn2 "通道仍然不通（退出码 $code）"
            $res | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
        }
    }
    finally { Pop-Location }
    return
}

Write-Host ''
Write-Host '完成。加 -Test 验证通道，或加 -PrintEnv 只打印环境变量。' -ForegroundColor DarkGray
