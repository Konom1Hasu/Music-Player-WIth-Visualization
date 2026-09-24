# 生成频谱探针页：在构建产物 index.html 里注入"预置曲目 + 回传柱高"的脚本。
# 必须在 npm run build 之后运行（Vite 会清空 dist）。
param(
    [string]$Dist = 'D:\harness work\音乐播放器\app-rhine\dist'
)
$ErrorActionPreference = 'Stop'
$index = [IO.File]::ReadAllText((Join-Path $Dist 'index.html'), [Text.Encoding]::UTF8)
$seed = @'
<script>
  const COVER_SVG = "<svg xmlns='http://www.w3.org/2000/svg' width='512' height='512'><rect width='512' height='512' fill='#1c1d17'/><circle cx='256' cy='256' r='190' fill='none' stroke='#e8e5e1' stroke-width='26'/></svg>";
  const req = indexedDB.open("rhine-music", 1);
  req.onupgradeneeded = () => req.result.createObjectStore("songs", { keyPath: "id" });
  req.onsuccess = () => {
    const tx = req.result.transaction("songs", "readwrite");
    tx.objectStore("songs").put({ id: "seed-viz", title: "星环坠落的夜晚", artist: "MOONLIGHT DECADE", album: "ARCHIVE Ⅰ", cover: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(COVER_SVG), duration: 232, fav: true, plays: 17, pos: 88, order: 0, lrc: "" });
  };
  setTimeout(() => {
    const sp = window.__spectrum;
    if (!sp) { fetch('/metrics', { method: 'POST', body: 'no spectrum instance' }); return; }
    const vals = Array.from(sp.levels);
    const max = Math.max.apply(null, vals), min = Math.min.apply(null, vals);
    const mean = vals.reduce((a, c) => a + c, 0) / vals.length;
    const pegged = vals.filter(v => v > 0.98).length;
    const lines = [
      'bars = ' + vals.length,
      'min/max/mean = ' + min.toFixed(3) + ' / ' + max.toFixed(3) + ' / ' + mean.toFixed(3),
      '顶到 0.98 以上的柱数 = ' + pegged,
      '前 12 根 = ' + vals.slice(0, 12).map(v => v.toFixed(2)).join(' '),
      '第 5~10 根（低频峰区）= ' + vals.slice(4, 10).map(v => v.toFixed(2)).join(' '),
      '中段 40~46 = ' + vals.slice(40, 46).map(v => v.toFixed(2)).join(' '),
      '高频 110~119 = ' + vals.slice(110, 120).map(v => v.toFixed(2)).join(' '),
    ];
    fetch('/metrics', { method: 'POST', body: lines.join('\n') }).catch(() => {});
  }, 8000);
</script>
'@
$out = $index.Replace('</head>', $seed + '</head>')
[IO.File]::WriteAllText((Join-Path $Dist '_viz_probe.html'), $out, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "已生成 $Dist\_viz_probe.html"
