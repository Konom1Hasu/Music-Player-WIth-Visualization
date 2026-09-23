#Requires -Version 5.1
<#
.SYNOPSIS
    给界面拍快照，并把画面转成可直接阅读的 ASCII 灰度图。

.DESCRIPTION
    本项目的 UI 验证一直有个硬伤：改完界面只能靠人看。这个脚本把三步串起来：

      1. 起一个本地 HTTP 静态服务，承载指定的构建产物目录
         （不能用 file:// —— 产物的 module script 与绝对路径在 file:// 下都会失败）
      2. 用无头 Chromium 渲染并截图（`--screenshot`）
      3. 把 PNG 转成 ASCII 灰度图打印出来，于是"读不了图"的会话也能实际看到布局

    第 3 步由 scripts\截图转文本.js 完成（纯 Node 实现 PNG 解码，无第三方依赖）。

.PARAMETER Root
    要渲染的目录（含 index.html）。默认 app-rhine\dist。

.PARAMETER Out
    截图的输出路径。默认 dist\快照.png。

.PARAMETER Cols
    ASCII 渲染的列数，默认 110。列越多细节越多。

.PARAMETER Width / Height
    浏览器视口尺寸，默认 1600x900。

.PARAMETER BudgetMs
    虚拟时间预算（毫秒）。渲染带启动动画的界面时要给足，
    例如 RhineLabUI 的片头约 34 秒，需要 60000 左右。

.PARAMETER Page
    相对 Root 的页面路径，默认 index.html。

.PARAMETER Swiftshader
    用软件 GL 渲染 WebGL（无显卡环境必需，但会很慢）。

.PARAMETER KeepOpen
    截图后保留静态服务（便于自己在浏览器里看同一地址）。

.EXAMPLE
    # 渲染 RhineLabUI 底座（完整片头 + 三维阵列）
    .\scripts\渲染快照.ps1 -BudgetMs 60000 -Swiftshader

.EXAMPLE
    # 渲染封面 3D 的离线桩环境（需先生成 dist\_cover3d）
    .\scripts\渲染快照.ps1 -Root dist\_cover3d -BudgetMs 8000 -Swiftshader -Cols 104
#>
[CmdletBinding()]
param(
    [string]$Root,
    [string]$Out,
    [int]$Cols = 110,
    [int]$Width = 1600,
    [int]$Height = 900,
    [int]$BudgetMs = 6000,
    [string]$Page = 'index.html',
    [switch]$Swiftshader,
    [switch]$KeepOpen
)

$ErrorActionPreference = 'Stop'

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "    $m" -ForegroundColor Green }
function Write-Warn2($m){ Write-Host "    $m" -ForegroundColor Yellow }

$RepoRoot = Split-Path -Parent $PSScriptRoot
if (-not $Root) { $Root = Join-Path $RepoRoot 'app-rhine\dist' }
if (-not $Out)  { $Out  = Join-Path $RepoRoot 'dist\快照.png' }
# ★ 一律转成绝对路径：`--screenshot=相对路径` 会被浏览器按**它自己的 CWD** 解析，
#   与 PowerShell 的当前目录不保证一致 —— 表现就是"命令跑完但截图没生成"。
$Root = [IO.Path]::GetFullPath($Root)
$Out  = [IO.Path]::GetFullPath($Out)
$OutDir = Split-Path -Parent $Out
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if (-not (Test-Path (Join-Path $Root $Page))) {
    throw "在 $Root 里找不到 $Page —— 先构建（例如 cd app-rhine && npm run build）"
}

# ---------------------------------------------------------------- 找浏览器
Write-Step '查找无头浏览器'
# 顺序有讲究：本机实测 **Edge 的 --screenshot 稳定出图**；Chrome 在同样参数下会报
# "无法对其数据目录执行读写操作" 从而不出图。所以 Edge 优先，Chrome 只作兜底。
$cands = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ }
if (-not $cands) { throw '找不到 Chrome / Edge。' }
$cands | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }

# ---------------------------------------------------------------- 起静态服务
Write-Step '启动本地静态服务'
$serverJs = Join-Path $OutDir '_serve.js'
# 注意：始终写自己这份实现，**不要**复用 dist\_shot_serve.js ——
# 那一版把握手地址写成 "$handshake.url"（多一层后缀），与本脚本找的文件名不一致，
# 会直接导致"静态服务没有就绪"。（踩过的坑。）
$js = @'
const http=require('http'),fs=require('fs'),path=require('path');
const ROOT=path.resolve(process.argv[2]),HAND=process.argv[3];
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.glb':'model/gltf-binary','.woff2':'font/woff2','.mp3':'audio/mpeg','.ogg':'audio/ogg','.wav':'audio/wav','.txt':'text/plain; charset=utf-8'};
function safe(u){let p=decodeURIComponent(String(u).split('?')[0].split('#')[0]);if(p.endsWith('/'))p+='index.html';
 const a=path.resolve(ROOT,'.'+p);if(a!==ROOT&&!a.startsWith(ROOT+path.sep))return null;return a;}
const srv=http.createServer((q,s)=>{const a=safe(q.url);if(!a){s.writeHead(403);s.end('forbidden');return;}
 fs.stat(a,(e,st)=>{if(e||!st.isFile()){s.writeHead(404);s.end('not found');return;}
 s.writeHead(200,{'Content-Type':MIME[path.extname(a).toLowerCase()]||'application/octet-stream','Content-Length':st.size});
 fs.createReadStream(a).pipe(s);});});
srv.listen(0,'127.0.0.1',()=>{fs.writeFileSync(HAND,'http://127.0.0.1:'+srv.address().port+'/');});
setTimeout(()=>{srv.close();process.exit(0);},1000*60*10);
'@
[System.IO.File]::WriteAllText($serverJs, $js, (New-Object System.Text.UTF8Encoding($false)))

$handshake = Join-Path $OutDir '_serve.url'
Remove-Item $handshake -Force -ErrorAction SilentlyContinue
$nodeExe = (Get-Command node -ErrorAction Stop).Source
# ★ Start-Process 的 -ArgumentList **不会自动加引号**，而本仓库路径含空格
#   （D:\harness work\…）。不显式引起来，node 会把 "D:\harness" 当成脚本路径，
#   报 Cannot find module —— 服务起不来、握手文件永不出现，表现为"静态服务没有就绪"。
$argList = @('"' + $serverJs + '"', '"' + $Root + '"', '"' + $handshake + '"')
$server = Start-Process -FilePath $nodeExe -ArgumentList $argList -PassThru -WindowStyle Hidden
$url = $null
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-Path $handshake) { $url = ([System.IO.File]::ReadAllText($handshake)).Trim(); break }
}
if (-not $url) { try { $server | Stop-Process -Force } catch {} ; throw '静态服务没有就绪' }
Write-Ok "http://… 已就绪：$url"

try {
    # ---------------------------------------------------------------- 截图
    Write-Step '无头渲染并截图'
    $png = $Out
    $eargs = @(
        '--headless=new', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
        '--disable-crash-reporter', '--disable-breakpad',
        "--user-data-dir=$(Join-Path $OutDir '_prof')",
        "--window-size=$Width,$Height",
        "--virtual-time-budget=$BudgetMs"
    )
    if ($Swiftshader) {
        $eargs += @('--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required')
    } else {
        $eargs += '--disable-gpu'
    }

    # 逐个尝试候选浏览器：谁先出图用谁。
    # ★ 两个坑：
    #   ① 浏览器会把更新服务/崩溃上报的告警写到 stderr（例如 "Failed to open named pipe
    #      server process …"），EAP=Stop 下会被当成终止性错误直接中断脚本 ——
    #      那些告警对渲染没影响，所以临时放宽 EAP，只按"截图文件是否生成"判成败。
    #   ② Chrome 在本机会报"无法对其数据目录执行读写操作"从而不出图，Edge 正常，
    #      所以不能写死单个浏览器。
    $browser = $null
    foreach ($b in $cands) {
        Remove-Item $png -Force -ErrorAction SilentlyContinue
        # 每个浏览器用独立的 profile，避免互相锁住
        $prof = Join-Path $OutDir ('_prof_' + [IO.Path]::GetFileNameWithoutExtension($b))
        Remove-Item $prof -Recurse -Force -ErrorAction SilentlyContinue
        $tryArgs = @($eargs | Where-Object { $_ -notlike '--user-data-dir=*' }) +
                   @("--user-data-dir=$prof", "--screenshot=$png", ($url + $Page))
        $oldEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            # ★ 这里**不做任何重定向**：`2>&1` 会让 PowerShell 为子进程建立管道，
            #   而受限环境禁止命名管道/管道 stdio，浏览器会起不来且毫无输出
            #   （表现就是"未出图、连一句日志都没有"）。让它直接inherit控制台即可。
            & $b @tryArgs
        } finally { $ErrorActionPreference = $oldEap }
        # ★ 浏览器进程返回时截图**还没落盘**（实测还要零点几秒），所以必须轮询等待，
        #   不能立刻 Test-Path —— 否则会误判"未出图"，而文件随后就写出来了
        #   （日志里能看到 "bytes written"，但脚本已经放弃）。
        $deadline = (Get-Date).AddSeconds(25)
        while (-not (Test-Path $png) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
        if (Test-Path $png) { $browser = $b; break }
        Write-Warn2 "$([IO.Path]::GetFileName($b)) 未出图，换下一个候选"
    }
    if (-not $browser) {
        Write-Warn2 '排错提示：若之前有超时残留的无头浏览器进程，新实例会被它们接管后直接退出'
        Write-Warn2 '（既不出图也没有输出）。用下面的命令清掉残留再试：'
        Write-Host '    Get-Process msedge,chrome -EA SilentlyContinue | Stop-Process -Force' -ForegroundColor DarkGray
        throw '所有候选浏览器都没出图'
    }
    Write-Ok "$([IO.Path]::GetFileName($browser)) → $png  ($([math]::Round((Get-Item $png).Length/1KB,1)) KB)"

    # ---------------------------------------------------------------- 转文本
    Write-Step '把画面转成 ASCII（无图像能力的会话也能读）'
    & node (Join-Path $PSScriptRoot '截图转文本.js') $png $Cols
}
finally {
    if (-not $KeepOpen) { try { $server | Stop-Process -Force } catch {} }
    else { Write-Warn2 "静态服务保留在 PID $($server.Id)：$url" }
}
