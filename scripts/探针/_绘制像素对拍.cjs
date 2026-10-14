/*
 * 绘制像素对拍（端到端）：驱动产物 exe，喂一帧**已知柱高**，把画布像素读回来量几何。
 *
 * 为什么要它：离线脚本（scripts\频谱离线观测.mjs）验的是"spectrum.ts 发出了什么绘制指令"，
 * 但真实链路还有三截在它之外 —— 引擎 → publishRefFrame → 真画布光栅化。
 * 这里补上这三截：冻结渲染（打桩 applyExternalBars/decay）后直写 bars/peaks，
 * 再用 getImageData 逐列扫，量出：
 *   · 柱数 = 96（不是 150：v2.7.7 删掉了 96→150 重采样）
 *   · 每根柱的左边缘 / 宽度 / 顶端 y（= 贴底 + 槽位 70% 那条公式）
 *   · 顶盖：悬在柱顶之上、厚 2 CSS px（画布像素 = 2×比例）
 *   · 真实链路上有没有"半根柱 / 错位 / 缺顶盖"
 *
 * ★ 观察者效应（README 里也写过）：getImageData 读两三次后光栅后端会从 GPU 切到 CPU，
 *   边缘像素会变一点。所以：先读一次热身、再读一次用于判定；容差按像素给（±2px），
 *   不拿"边缘抗锯齿的灰度值"当判据。
 *
 * 用法：node scripts\探针\_绘制像素对拍.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const EXE = [
  path.join(root, 'dist', '音乐播放器-win32-x64', '音乐播放器.exe'),
  path.join(root, 'dist', '音乐播放器-win32-x64', 'electron.exe'),
].find((p) => fs.existsSync(p));
if (!EXE) { console.error('找不到产物 exe'); process.exit(1); }
const EXE_DIR = path.dirname(EXE);
const PORT = 41739;

/* 残留实例占着内嵌 UI 端口 → bind 失败 → 退回 terminal.html（那页没有频谱） */
try {
  const out = execSync('netstat -ano', { encoding: 'utf8' });
  for (const line of out.split(/\r?\n/)) {
    if (line.includes(':' + PORT) && /LISTENING/i.test(line)) {
      const pid = line.trim().split(/\s+/).pop();
      if (/^\d+$/.test(pid)) { try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch {} }
    }
  }
} catch {}

let pass = 0, fail = 0;
const ok = (cond, name, detail = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name + (detail ? '  ' + detail : '')); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  ' + detail : '')); }
};

const profile = path.join(os.tmpdir(), 'rhine-pixcmp-' + Date.now());
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let err = '';
const child = spawn(EXE, ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-sandbox', '--window-size=1600,1000'],
  { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: EXE_DIR });
child.stderr.on('data', (d) => (err += String(d)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const RE = /DevTools listening on (ws:\/\/[^\s]+)/;
const SONG = { id: 'px1', title: 'Pixel Check', artist: 'Rhine Lab', album: 'Probe Vol.01' };

(async () => {
  let ws = null; const t0 = Date.now();
  while (Date.now() - t0 < 20000) { const m = RE.exec(err); if (m) { ws = m[1]; break; } await wait(200); }
  if (!ws) throw new Error('拿不到 ws');
  const port = new URL(ws).port;
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /127\.0\.0\.1:41739/.test(t.url));
  if (!page) throw new Error('找不到页面 target');

  const sock = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  sock.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => sock.addEventListener('open', r, { once: true }));
  await send('Runtime.enable'); await send('Page.enable');
  await wait(2500);
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : null; };

  await ev("localStorage.setItem('rhine-diag','1');localStorage.setItem('rhine-viztest','1');'ok'");
  await ev(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('rhine-music', 1);
      r.onupgradeneeded = () => { try { r.result.createObjectStore('songs', { keyPath: 'id' }); } catch (e) {} };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const song = Object.assign({ duration: 214, fav: false, plays: 3, pos: 0, order: 1 }, ${JSON.stringify(SONG)});
    await new Promise((res, rej) => { const tx = db.transaction('songs', 'readwrite'); tx.objectStore('songs').put(song); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    return 'seeded';
  })()`);
  await send('Page.reload', { ignoreCache: false });
  await wait(1500);
  for (let i = 0; i < 90; i++) {
    const st = await ev("(()=>{const s=document.querySelector('#stage');return s?s.getAttribute('data-mode')+'/'+s.getAttribute('data-boot'):'none';})()");
    if (/^(archive|detail)\//.test(String(st))) break;
    await wait(500);
  }
  await ev("(()=>{window.dispatchEvent(new CustomEvent('rhine-track',{detail:0}));return 'ok';})()");
  await wait(1500);
  for (let i = 0; i < 30; i++) {
    const st = await ev("(()=>{const s=document.querySelector('#stage');return s?s.getAttribute('data-mode'):null;})()");
    if (st === 'detail') break;
    await wait(500);
  }
  await wait(2500);
  await send('Page.bringToFront');
  await wait(300);

  /* 冻结渲染 + 写入已知的一帧（柱高 0.20→0.80 斜坡；顶盖 = 柱高 + 0.15） */
  const st1 = await ev(`(()=>{
    const sp = window.__spectrum; if (!sp) return 'no-spectrum';
    sp.applyExternalBars = () => {};
    sp.decay = () => {};
    const N = sp.bars.length;
    for (let i = 0; i < N; i++) {
      const v = 0.20 + 0.60 * (i / (N - 1));
      sp.bars[i] = v;
      sp.peaks[i] = v + 0.15;
    }
    const cv = sp.canvas || document.querySelector('#p-detail-spectrum') || document.querySelector('.song-viz canvas');
    if (!cv) return 'no-canvas';
    cv.__px = cv;
    return JSON.stringify({ n: N, w: cv.width, h: cv.height, cw: cv.clientWidth, ch: cv.clientHeight });
  })()`);
  console.log('冻结与写值:', st1);
  if (st1 === 'no-spectrum' || st1 === 'no-canvas') {
    /* 失败时把现场状态打出来（80% 的"看不到频谱"都是详情区没挂上 / 探针开关没生效） */
    const dump = await ev(`(()=>JSON.stringify({
      viztestLS: localStorage.getItem('rhine-viztest'),
      mode: (document.querySelector('#stage') || { getAttribute: () => null }).getAttribute('data-mode'),
      hasViz: !!document.querySelector('.song-viz'),
      hasCanvas: !!document.querySelector('#p-detail-spectrum'),
      sSpectrum: typeof window.__spectrum, sSmState: typeof window.__smState,
    }))()`);
    throw new Error(st1 + ' → ' + dump);
  }
  const meta = JSON.parse(st1);
  await wait(500);

  /* 读像素：先热身一次（光栅后端切换），第二次用于判定。
     逐列收集**所有**着墨带（连续 y），不设"带与带之间最多隔几像素"的限制 ——
     顶盖在自己的峰值高度上，离柱顶可能有一百多像素（峰值比柱高高 0.15 时就是 ~105px），
     早先设 12px 空隙上限的写法会把它整条漏掉。 */
  const readPix = () => ev(`(()=>{
    const cv = document.querySelector('#p-detail-spectrum') || document.querySelector('.song-viz canvas');
    const ctx = cv.getContext('2d');
    const img = ctx.getImageData(0, 0, cv.width, cv.height);
    const d = img.data, w = cv.width, h = cv.height;
    const cols = [];
    for (let x = 0; x < w; x++) {
      const bands = [];
      let y0 = -1;
      for (let y = 0; y < h; y++) {
        const on = d[(y * w + x) * 4 + 3] > 24;
        if (on && y0 < 0) y0 = y;
        if (!on && y0 >= 0) { bands.push([y0, y - 1]); y0 = -1; }
      }
      if (y0 >= 0) bands.push([y0, h - 1]);
      cols.push(bands.length ? bands : null);
    }
    return JSON.stringify({ w, h, cols });
  })()`);
  await readPix();
  const raw = JSON.parse(await readPix());

  /* 期望几何：与 spectrum.ts 同一套公式（常量照 visualizer.py 抄） */
  const s = meta.w / meta.cw;
  const PAD_X = 6.0, USABLE_PAD = 8.0, RATIO = 0.70, CAP_THICK = 2.0, CAP_GAP = 3.0, CAP_MIN = 0.004;
  const N = meta.n;
  const padX = PAD_X * s;
  const usable = raw.h - USABLE_PAD * s;
  const slot = (raw.w - padX * 2) / N;
  const barW = Math.min(slot, Math.max(s * 1.0, slot * RATIO));
  const barOf = (i) => {
    const v = 0.20 + 0.60 * (i / (N - 1));
    const bh = Math.max(2 * s, v * usable);
    return { x0: padX + i * slot + (slot - barW) / 2, x1: padX + i * slot + (slot - barW) / 2 + barW, top: raw.h - bh, v, cap: v + 0.15 };
  };
  console.log('画布 ' + raw.w + '×' + raw.h + '，显示 ' + meta.cw + '，比例 ' + s.toFixed(3) +
    '，槽位 ' + slot.toFixed(3) + 'px，柱宽 ' + barW.toFixed(3) + 'px');

  const inked = raw.cols.filter(Boolean).length;
  ok(inked > 0, '画布上有墨（真的画出来了）', inked + ' 列');
  ok(N === 96, '柱数 = 96（引擎频段数，不再是 150 柱重采样）', 'N=' + N);

  /* 1) 每根柱：柱心那一列的最下面一条带必须是"柱"（贴底、顶 = h − bh），
        它上面还应有一条"顶盖"带（悬在峰值高度之上，厚 2×比例）。 */
  let edgeBad = 0, topBad = 0, baseBad = 0, capBad = 0, capMissing = 0;
  let maxTopD = 0, maxBaseD = 0, maxCapD = 0;
  const samples = [];
  for (let i = 0; i < N; i++) {
    const b = barOf(i);
    const cx = Math.round((b.x0 + b.x1) / 2);
    const bands = raw.cols[cx];
    if (!bands) { edgeBad++; continue; }
    const bar = bands[bands.length - 1]; // 最下面那条 = 柱
    const dTop = Math.abs(bar[0] - b.top);
    const dBase = Math.abs(bar[1] - (raw.h - 1));
    maxTopD = Math.max(maxTopD, dTop);
    maxBaseD = Math.max(maxBaseD, dBase);
    if (dTop > 2.5) topBad++;
    if (dBase > 2.5) baseBad++;
    /* 顶盖：柱上面最近的一条带（跳过顶部左上角那几条指示条带） */
    const above = bands.filter((bd) => bd[1] < bar[0] - 1 && bd[0] > 30);
    if (!above.length) { capMissing++; continue; }
    const capBand = above[above.length - 1];
    const ph = Math.max(2 * s, b.cap * usable);
    const capTopExp = raw.h - ph - CAP_GAP * s;
    const dCapTop = Math.abs(capBand[0] - capTopExp);
    const dThick = Math.abs((capBand[1] - capBand[0] + 1) - CAP_THICK * s);
    maxCapD = Math.max(maxCapD, dCapTop, dThick);
    if (dCapTop > 2.5 || dThick > 2.5) capBad++;
    if (i % 24 === 0) {
      samples.push(`柱${i}: 顶${bar[0]}(期望${b.top.toFixed(0)}) 底${bar[1]} 顶盖${capBand[0]}(期望${capTopExp.toFixed(0)})`);
    }
  }
  ok(edgeBad === 0, '每根柱的柱心都有墨（没有半根 / 错位 / 缺柱）', edgeBad + ' 根异常');
  ok(topBad === 0, '柱顶 y = h − max(2px, v×(h−8s))（容差 2.5px）', 'maxΔ=' + maxTopD.toFixed(2) + 'px');
  ok(baseBad === 0, '所有柱贴底（柱带下缘 = h−1）', 'maxΔ=' + maxBaseD.toFixed(2) + 'px');
  ok(capMissing === 0, '每根柱都有峰值顶盖（cap = v+0.15 > 0.004）', capMissing + ' 根缺顶盖');
  ok(capBad === 0, '顶盖 y = h − ph − 3×比例、厚 = 2×比例（容差 2.5px）', 'maxΔ=' + maxCapD.toFixed(2) + 'px');
  if (samples.length) console.log('  ' + samples.join('　'));

  /* 3) 柱宽比例：总着墨列数（含顶盖列）应当 ≈ N × 柱宽，且明显小于 N × 槽位 ——
        后者说明柱宽没按 70% 收窄。 */
  const expectedInk = N * barW;
  const fullSlot = N * slot;
  ok(Math.abs(inked - expectedInk) <= N * 2,
    '总着墨列数 ≈ 柱数 × 柱宽（70% 槽位）', inked + ' vs 期望 ' + expectedInk.toFixed(0) + '±' + (N * 2) +
    '（满槽位会是 ' + fullSlot.toFixed(0) + '）');
  ok(inked < fullSlot - N, '柱宽确实窄于槽位（柱间有留白）', '差 ' + (fullSlot - inked).toFixed(0) + ' 列');

  /* 4) 左上角四路指示条：label_w/mw/mh/gap = 30/38/5/10（×比例），起点 (8, 6) */
  const gx = 8 * s, gy = 6 * s, mw = 38 * s, mh = 5 * s, labelW = 30 * s, gap = 10 * s;
  let tracksFound = 0;
  for (let k = 0; k < 4; k++) {
    const x = Math.round(gx + k * (labelW + mw + gap) + labelW + mw / 2);
    const bands = raw.cols[x];
    if (!bands) continue;
    const band = bands.find((bd) => Math.abs(bd[0] - gy) <= 2.5 && Math.abs((bd[1] - bd[0] + 1) - mh) <= 2.5);
    if (band) tracksFound++;
  }
  ok(tracksFound === 4, '左上角四条音色指示条都在（y=6×比例、厚 5×比例，按 78×比例 步进）',
    tracksFound + '/4');

  console.log('\n' + '='.repeat(56));
  console.log(fail === 0 ? '★ 绘制像素对拍（产物 exe）：' + pass + ' 项全绿'
    : '✗ 绘制像素对拍：' + pass + ' 通过 / ' + fail + ' 失败');
  console.log('='.repeat(56));
  child.kill();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('出错:', e && e.message ? e.message : e); try { child.kill(); } catch {} process.exit(1); });
