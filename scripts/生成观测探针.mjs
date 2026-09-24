// 观测探针：注入到构建产物里，读"点歌续播"与"频谱帧率/毛刺"两件事的实测数据。
// 用法（由 scripts\生成观测探针.ps1 调用，必须在 npm run build 之后）：
//   node scripts\生成观测探针.mjs <dist 目录>
// 产物：<dist>\_probe.html，配合 scripts\观测探针.ps1 起服务 + 无头渲染。
import fs from "node:fs";
import path from "node:path";

const dist = path.resolve(process.argv[2] || "app-rhine/dist");
const index = path.join(dist, "index.html");
if (!fs.existsSync(index)) {
  console.error("找不到 " + index + " —— 先 npm run build");
  process.exit(2);
}
/* 一律按 Buffer 读、按 UTF-8 解码：Node 的 readFileSync(p,'utf8') 是可靠的，
   但 fs.writeFileSync(p, s, 'utf8') 在某些组合下会按本地代码页落盘，
   之前用 PowerShell 版就从这里丢过一次内容（产物只剩 57 字节）。 */
const rawIndex = fs.readFileSync(index, "utf8");

const COVER =
  "<svg xmlns='http://www.w3.org/2000/svg' width='512' height='512'><rect width='512' height='512' fill='#1c1d17'/><circle cx='256' cy='256' r='190' fill='none' stroke='#e8e5e1' stroke-width='26'/></svg>";

/* 20 秒 8kHz 单声道静音 WAV（约 160KB）：够长，能把"续播到 12 秒"和"从头开始"区分开，
   又不能太大 —— 之前用 44.1kHz/30 秒（2.6MB）时注入页到了 7MB，
   浏览器解析 + IndexedDB 写入在虚拟时间下超过了预算，曲库干脆读不进来。 */
const wav =
  "data:audio/wav;base64," +
  (() => {
    const rate = 8000;
    const secs = 20;
    const n = rate * secs;
    const buf = Buffer.alloc(44 + n * 2);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(36 + n * 2, 4);
    buf.write("WAVEfmt ", 8);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36);
    buf.writeUInt32LE(n * 2, 40);
    return buf.toString("base64");
  })();

const probe = `
<script>
/* 诊断开关写进 localStorage：探针页会自己刷新一次，URL 参数在刷新后不保证还在。 */
try { localStorage.setItem('rhine-viztest', '1'); localStorage.setItem('rhine-diag', '1'); } catch (e) {}
const MSG = [];
function post(m) { MSG.push(m); }
function flush(tag) {
  fetch('/metrics', { method: 'POST', body: '### ' + tag + '\\n' + MSG.join('\\n') }).catch(() => {});
  MSG.length = 0;
}
post('探针已注入，t=' + Math.round(performance.now()) + 'ms');
flush('心跳');
window.addEventListener('error', (e) => post('页面错误 ' + e.message));
/* ---------- 1. 预置两首曲目：第二首带"上次停在 88 秒"的位置 ----------
   首屏加载时 initPlayer() 早就把空库读完了，所以这里预置完之后刷新一次页面，
   第二次加载才是"曲库里本来就有歌"的真实状态（也正是用户看到的现象）。 */
const req = indexedDB.open("rhine-music", 1);
req.onupgradeneeded = () => req.result.createObjectStore("songs", { keyPath: "id" });
req.onsuccess = () => {
  const tx = req.result.transaction("songs", "readwrite");
  const st = tx.objectStore("songs");
  st.put({ id: "seed-a", title: "星环坠落的夜晚", artist: "MOONLIGHT DECADE", album: "ARCHIVE Ⅰ",
    cover: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(${JSON.stringify(COVER)}),
    srcUrl: ${JSON.stringify(wav)},
    duration: 30, fav: true, plays: 3, pos: 0, order: 0, lrc: "" });
  st.put({ id: "seed-b", title: "续播测试曲", artist: "PROBE", album: "ARCHIVE Ⅱ",
    cover: "data:image/svg+xml;charset=utf-8," + encodeURIComponent(${JSON.stringify(COVER)}),
    srcUrl: ${JSON.stringify(wav)},
    duration: 30, fav: false, plays: 0, pos: 12, order: 1, lrc: "" });
  tx.oncomplete = () => {
    const nth = sessionStorage.getItem('probe-seeded') ? '二' : '一';
    post('预置曲目已写入（第 ' + nth + ' 次加载）');
    flush('预置');
    if (!sessionStorage.getItem('probe-seeded')) {
      sessionStorage.setItem('probe-seeded', '1');
      /* 等应用把这一轮（空）曲库读完、进入可交互之后再刷新：
         太快刷新会和 initPlayer 抢 IndexedDB。 */
      const go = () => setTimeout(() => location.reload(), 300);
      if (document.readyState === 'complete') go();
      else window.addEventListener('load', go);
    }
  };
};

/* ---------- 2. 监听 audio 的加载/播放动作：谁在重新赋 src、谁把时间清零 ---------- */
const realPlay = HTMLMediaElement.prototype.play;
window.__loads = [];
window.__plays = [];
HTMLMediaElement.prototype.play = function () {
  window.__plays.push([Math.round(performance.now()), Math.round(this.currentTime * 100) / 100, String(this.src).slice(0, 16)]);
  return realPlay.apply(this, arguments);
};
let srcDesc = '';
try {
  const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  Object.defineProperty(HTMLMediaElement.prototype, 'src', {
    get() { return d.get.call(this); },
    set(v) { window.__loads.push([Math.round(performance.now()), String(v).slice(0, 24), Math.round(this.currentTime * 100) / 100]); return d.set.call(this, v); },
    configurable: true,
  });
} catch (e) { srcDesc = String(e); }
window.__seenRows = 0;

/* ---------- 3. 等界面起来 → 点第二首 → 记录时间轴 ---------- */
function waitFor(fn, ms) {
  return new Promise((res) => {
    const t0 = performance.now();
    const tick = () => {
      let v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return res(v);
      if (performance.now() - t0 > ms) return res(null);
      setTimeout(tick, 120);
    };
    tick();
  });
}
const ROWS = () => {
  const r = document.querySelectorAll('#player-playlist [data-i]');
  return r.length >= 2 ? r : null;
};

/* A. 首屏（预置完成后自动刷新一次，这次才是"曲库本来就有歌"） */
setTimeout(async () => {
  const rows = await waitFor(ROWS, 25000);
  post('播放列表行数 = ' + (rows ? rows.length : 0) + (rows ? '（' + rows[0].textContent.trim().slice(0, 24) + ' / ' + rows[1].textContent.trim().slice(0, 24) + '）' : ''));
  /* 直接读一次 IndexedDB，确认预置数据真的在库里（排除"读不出来"和"没写进去"） */
  await new Promise((res) => {
    const t0 = performance.now();
    const r = indexedDB.open('rhine-music', 1);
    r.onsuccess = () => {
      const g = r.result.transaction('songs', 'readonly').objectStore('songs').getAll();
      g.onsuccess = () => {
        post('IndexedDB 直读：' + g.result.length + ' 首，用时 ' + Math.round(performance.now() - t0) + 'ms，'
          + g.result.map((s) => s.id + '(pos=' + s.pos + ',order=' + s.order + ')').join(' '));
        res();
      };
      g.onerror = () => { post('IndexedDB 直读失败 ' + g.error); res(); };
    };
    r.onerror = () => { post('IndexedDB 打不开 ' + r.error); res(); };
  });
  if (!rows) {
    const pl = document.querySelector('#player-playlist');
    post('诊断：#player-playlist ' + (pl ? '存在，子节点 ' + pl.children.length + '，display=' + getComputedStyle(pl).display + '，hidden=' + pl.hidden : '不存在'));
    const bar = document.querySelector('#player-bar');
    post('诊断：#player-bar ' + (bar ? '存在' : '不存在') + '，data-i 元素总数 = ' + document.querySelectorAll('[data-i]').length);
    post('诊断：__audioEl=' + (window.__audioEl ? '有' : '无') + '，__spectrum=' + (window.__spectrum ? '有' : '无') + '，stage.mode=' + (document.querySelector('#stage') ? document.querySelector('#stage').dataset.mode : '?'));
    post('诊断：#loading ' + (document.querySelector('#loading') ? '还在（说明启动没走完）' : '已移除') + '，error-state=' + (document.querySelector('.error-state') ? '有' : '无'));
    flush('点歌续播');
    return;
  }

  /* 先点第一首（上次位置 0），再点第二首（上次位置 12 秒 = 上次没听完） */
  rows[0].click();
  await new Promise((r) => setTimeout(r, 2500));
  const a = window.__audioEl;
  post('点第一首后 = ' + (a ? a.currentTime.toFixed(2) : '?') + ' 秒（这首预置位置 0）');

  const t0 = performance.now();
  rows[1].click();
  const timeline = [];
  for (let i = 0; i < 16; i++) {
    await new Promise((r) => setTimeout(r, 250));
    timeline.push(Math.round(performance.now() - t0) + 'ms:' + (a ? a.currentTime.toFixed(2) : '?'));
  }
  post('src 赋值（毫秒 / src 前缀 / 赋值前 currentTime）= ' + JSON.stringify(window.__loads));
  post('play() 调用（毫秒 / 调用时 currentTime / src 前缀）= ' + JSON.stringify(window.__plays));
  post('播放内核记的加载动作 = ' + JSON.stringify(window.__lastLoad || null));
  post('续播落点 = ' + JSON.stringify(window.__lastSeek || null));
  post('点第二首后的时间轴 = ' + timeline.join('  '));
  const t = a ? a.currentTime : -1;
  post('结论：点第二首后停在 ' + t.toFixed(2) + ' 秒（预置上次位置 12 秒）→ '
    + (t > 6 ? '续播生效（接着上次放）' : (t > 0.05 ? '从头开始（位置没接上）' : '仍停在 0（没播起来）')));
  flush('点歌续播');
}, 6000);

/* B. 频谱：帧率 / worker 耗时 / 毛刺指标。
     不挂 ?viztest=1 —— 那条分支走的是合成信号，不经过 worker 与真实音频链；
     但 ?diag=1 会把频谱实例挂出来，所以这里能直接量。 */
let smoothAcc = 0, smoothN = 0;
/* 逐帧对照：相邻两次采样（~16ms）之间每根柱的平均变化量。
   这个数大就是"毛刺感"的直接来源 —— 每帧都在抖，看着就毛。 */
let prevBars = null, shimmerAcc = 0, shimmerN = 0;
setInterval(() => {
  const sp = window.__spectrum;
  if (!sp) return;
  const v = Array.from(sp.levels);
  let d = 0;
  for (let i = 1; i < v.length; i++) d += Math.abs(v[i] - v[i - 1]);
  smoothAcc += d / (v.length - 1);
  smoothN++;
  if (prevBars) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s += Math.abs(v[i] - prevBars[i]);
    shimmerAcc += s / v.length;
    shimmerN++;
  }
  prevBars = v;
}, 16);
setTimeout(async () => {
  const sp = await waitFor(() => window.__spectrum || null, 25000);
  const vd = await waitFor(() => window.__rhineViz || null, 25000);
  if (!sp) {
    post('FAIL 没有频谱实例（音频没播起来 / 音频上下文没起来）');
    post('诊断：__audioEl = ' + (window.__audioEl ? '有' : '无') + '，audio.paused = ' + (window.__audioEl ? window.__audioEl.paused : '?')
      + '，audio.currentTime = ' + (window.__audioEl ? window.__audioEl.currentTime.toFixed(2) : '?')
      + '，readyState = ' + (window.__audioEl ? window.__audioEl.readyState : '?'));
    flush('频谱');
    return;
  }
  const r0 = vd ? (vd.rendered || 0) : 0;
  const w0 = window.__workerHits || 0;
  smoothAcc = 0; smoothN = 0; prevBars = null; shimmerAcc = 0; shimmerN = 0;
  await new Promise((r) => setTimeout(r, 4000));
  if (vd) {
    const r1 = vd.rendered || 0;
    const fps = (r1 - r0) / 4;
    const iv = (vd.intervals || []).slice().sort((a, b) => a - b);
    const med = iv.length ? iv[Math.floor(iv.length / 2)] : 0;
    const p90 = iv.length ? iv[Math.floor(iv.length * 0.9)] : 0;
    post('4 秒内渲染帧数 = ' + (r1 - r0) + '  →  实测 ' + fps.toFixed(1) + ' fps（单帧 dt ' + vd.dt + ' ms，busy=' + vd.busy + '）'
      + (fps > 45 ? '  ✓ 流畅' : fps > 25 ? '  △ 一般' : '  ✗ 偏卡'));
    post('帧间隔 中位数 ' + med + 'ms / p90 ' + p90 + 'ms / 最差 ' + (iv.length ? iv[iv.length - 1] : 0) + 'ms（样本 ' + iv.length + '）');
    post('worker 在用 = ' + vd.workerOn + '（回包 ' + ((window.__workerHits || 0) - w0) + ' 次/4 秒），单次分析 '
      + vd.workerMs + ' ms，往返 ' + vd.rttMs + ' ms');
  } else {
    post('没有 __rhineViz（说明频谱循环没在跑）');
  }
  const vals = Array.from(sp.levels);
  const max = Math.max.apply(null, vals);
  const pegged = vals.filter((v) => v > 0.98).length;
  /* 毛刺的三段对照：worker 原始频段 → 流水线目标值 → 显示值。
     逐段下降就说明去毛刺确实在起作用（用同一份信号比，不依赖合成信号）。 */
  const rough = (arr) => {
    let d = 0;
    for (let i = 1; i < arr.length; i++) d += Math.abs(arr[i] - arr[i - 1]);
    return d / (arr.length - 1);
  };
  const snap = sp.snapshot ? sp.snapshot() : null;
  if (snap) {
    post('毛刺三段对照（相邻柱高差平均）: worker 原始频段 ' + rough(snap.freq).toFixed(4)
      + '  →  流水线目标 ' + rough(snap.bars).toFixed(4)
      + '  →  显示值 ' + rough(snap.show).toFixed(4));
  }
  post('柱数 = ' + vals.length + '，最高 = ' + max.toFixed(3) + '，顶到 0.98 以上的 = ' + pegged);
  post('毛刺指标（相邻柱高差的平均，越小越平滑）= ' + (smoothN ? (smoothAcc / smoothN).toFixed(4) : '—'));
  post('逐帧抖动（每 16ms 每根柱的平均变化量）= ' + (shimmerN ? (shimmerAcc / shimmerN).toFixed(5) : '—')
    + '（样本 ' + shimmerN + '）');
  post('前 12 根 = ' + vals.slice(0, 12).map((v) => v.toFixed(2)).join(' '));
  post('第 5~10 根 = ' + vals.slice(4, 10).map((v) => v.toFixed(2)).join(' '));
  flush('频谱');
}, 34000);
</script>
`;

const out = rawIndex.replace("</head>", probe + "</head>");
if (out === rawIndex) {
  console.error("注入失败：index.html 里没有 </head>");
  process.exit(3);
}
const target = path.join(dist, "_probe.html");
fs.writeFileSync(target, out, "utf8");
console.log("已生成 " + target);
