/*
 * 视觉重心·对比出图（2026-10-14 第二轮，供用户选方案）
 *
 * 背景：用户反馈「视觉重心太靠左，视觉上左比右大约为 6:4」。
 *   量化实锤：实测档 79 帧「左半(bar0-47) / 右半(bar48-95)」柱高总和比 ≈ 6.5 : 3.5，质心在 40.4% 处。
 *   纯平移对比例改善有限（k=8 才到 5.7:4.3）——因为「左重」的主体是左半低频『地毯』，不是那几根塔。
 *
 * 本脚本把 4 个候选方案做出实拍对比：
 *   v0     现状（k=0）                       —— 对照
 *   v4     平移 4 格                          —— 塔离开左缘；比例 6.2:3.8，质心 43.7%
 *   cyc8   循环移位 8 格（卷回左端）           —— 质心 ≈46%（接近中线）、左端不空、不丢内容
 *   v4g16s 平移 4 + 右半渐强 ×1.6 + 软钳       —— 比例 5.6:4.4（数值最平衡）；右半柱高被放大
 *
 * 场景（3 组）：
 *   · 合成信号        dist/频谱画面-柱高.json frames[0]（实拍图同场景）
 *   · 真实·典型帧     实测档 79 帧中 L:R 比最接近中位的一帧（f058）
 *   · 真实·最左重帧   实测档 79 帧中 L:R 比最大的一帧（f069，bar4-8 五连顶天塔）
 *
 * 手法：与 _sm2渲染.cjs 相同的冻结渲染（打桩 applyExternalBars/decay + 直写 bars/peaks/gauges）。
 * 输出：dist/_重心帧图/*.png + dist/视觉重心对比.html
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
const N = 96, HALF = 48;

/* ===== 数据 ===== */
const dataSyn = JSON.parse(fs.readFileSync(path.join(root, 'dist', '频谱画面-柱高.json'), 'utf8'));
const synFrame = dataSyn.frames[0];
const dataReal = JSON.parse(fs.readFileSync(path.join(root, 'dist', '_sm2出图.json'), 'utf8'));
const realRow = dataReal.rows.find((r) => r.name.includes('实测档'));
if (!realRow) { console.error('找不到实测档行'); process.exit(1); }
const frames79 = realRow.frames;

/* 代表帧：中位帧 / 最左重帧 */
const ratioOf = (b) => {
  let l = 0, r = 0;
  for (let i = 0; i < N; i++) { if (i < HALF) l += b[i]; else r += b[i]; }
  return r > 1e-9 ? l / r : Infinity;
};
const med = (a) => { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const ratiosPer = frames79.map(ratioOf);
const medR = med(ratiosPer);
let midIdx = 0, maxIdx = 0;
ratiosPer.forEach((v, i) => {
  if (Math.abs(v - medR) < Math.abs(ratiosPer[midIdx] - medR)) midIdx = i;
  if (v > ratiosPer[maxIdx]) maxIdx = i;
});

/* ===== 方案 ===== */
const shift = (src, k) => { const o = new Array(N).fill(0); for (let i = k; i < N; i++) o[i] = src[i - k]; return o; };
const cycleShift = (src, k) => { const o = new Array(N); for (let i = 0; i < N; i++) o[i] = src[((i - k) % N + N) % N]; return o; };
const rightGain = (b, g0, start) => b.map((h, i) => i < start ? h : h * (1 + g0 * (i - start) / (N - 1 - start)));
const softClip = (x) => x <= 0.9 ? x : 0.9 + 0.1 * Math.tanh((x - 0.9) / 0.1);

const PLANS = [
  { id: 'v0',     label: '现状（不动）',                fn: (b) => b },
  { id: 'v4',     label: '平移 4 格',                   fn: (b) => shift(b, 4) },
  { id: 'cyc8',   label: '循环移位 8 格',               fn: (b) => cycleShift(b, 8) },
  { id: 'v4g16s', label: '平移 4 格 + 右半渐强（软钳）', fn: (b) => rightGain(shift(b, 4), 0.6, 24).map(softClip) },
];

const JOBS = [
  { name: '合成信号', frames: [{ id: 'syn', bars: synFrame.bars, peaks: synFrame.peaks, gauges: synFrame.gauges }] },
  { name: '真实·典型帧', frames: [{ id: 'f' + String(midIdx).padStart(3, '0'), bars: frames79[midIdx], peaks: frames79[midIdx] }] },
  { name: '真实·最左重帧', frames: [{ id: 'f' + String(maxIdx).padStart(3, '0'), bars: frames79[maxIdx], peaks: frames79[maxIdx] }] },
];

/* ===== 指标（给每张图标注） ===== */
function metrics(b) {
  let l = 0, r = 0, ws = 0, s = 0;
  for (let i = 0; i < N; i++) { const h = b[i] ?? 0; if (i < HALF) l += h; else r += h; s += h; ws += i * h; }
  const ratio = r > 1e-9 ? l / r : Infinity;
  const lp = ratio / (1 + ratio) * 10;
  return { lr: `${lp.toFixed(1)}:${(10 - lp).toFixed(1)}`, centroid: (s > 1e-9 ? ws / s : 47.5) / (N - 1) * 100 };
}

/* ===== 启动 ===== */
try {
  const out = execSync('netstat -ano', { encoding: 'utf8' });
  for (const line of out.split(/\r?\n/)) {
    if (line.includes(':' + PORT) && /LISTENING/i.test(line)) {
      const pid = line.trim().split(/\s+/).pop();
      if (/^\d+$/.test(pid)) { try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch {} }
    }
  }
} catch {}

const profile = path.join(os.tmpdir(), 'rhine-gravity-' + Date.now());
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let err = '';
const child = spawn(EXE, ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-sandbox', '--window-size=1600,1000'],
  { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: EXE_DIR });
child.stderr.on('data', (d) => (err += String(d)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const RE = /DevTools listening on (ws:\/\/[^\s]+)/;
const SONG = { id: 'tl1', title: 'Viz Check', artist: 'Rhine Lab', album: 'Probe Vol.01' };

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

  const st1 = await ev(`(()=>{
    const sp = window.__spectrum; if (!sp) return 'no-spectrum';
    sp.applyExternalBars = () => {};
    sp.decay = () => {};
    document.body.classList.remove('rhine-night');
    return 'frozen; bars=' + sp.bars.length;
  })()`);
  console.log('打桩:', st1);
  if (st1 === 'no-spectrum') throw new Error('没有 __spectrum');

  await send('Page.bringToFront');
  await wait(300);

  const canvasBox = JSON.parse(await ev(`(()=>{
    const cv = document.querySelector('#p-detail-spectrum') || document.querySelector('.song-viz-body canvas') || document.querySelector('.song-viz canvas');
    if (!cv) return 'null';
    const r = cv.getBoundingClientRect();
    return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height });
  })()`));
  if (!canvasBox || !canvasBox.w) throw new Error('canvas 不可见');

  fs.mkdirSync(path.join(root, 'dist', '_重心帧图'), { recursive: true });
  const manifest = [];
  for (const job of JOBS) {
    for (const fr of job.frames) {
      for (const plan of PLANS) {
        const bars = plan.fn(fr.bars);
        const peaks = plan.fn(fr.peaks);
        const m = metrics(bars);
        const g = fr.gauges ? JSON.stringify(fr.gauges) : 'null';
        await ev(`(()=>{
          const sp = window.__spectrum;
          const b = ${JSON.stringify(bars)};
          const p = ${JSON.stringify(peaks)};
          for (let i = 0; i < sp.bars.length; i++) { sp.bars[i] = b[i] || 0; sp.peaks[i] = p[i] || 0; }
          const g = ${g};
          if (g) { sp.gauges.kick = g.kick; sp.gauges.bass = g.bass; sp.gauges.vocal = g.vocal; sp.gauges.cymbal = g.cymbal; }
          return 'ok';
        })()`);
        await wait(400);
        const shot = await send('Page.captureScreenshot', {
          format: 'png',
          clip: { x: Math.max(0, canvasBox.x - 4), y: Math.max(0, canvasBox.y - 4), width: canvasBox.w + 8, height: canvasBox.h + 8, scale: 3 },
        });
        const name = `${job.name}-${fr.id}-${plan.id}.png`;
        if (shot.result && shot.result.data) {
          fs.writeFileSync(path.join(root, 'dist', '_重心帧图', name), Buffer.from(shot.result.data, 'base64'));
          console.log(`  ✓ ${name}  (左:右 ${m.lr} / 质心 ${m.centroid.toFixed(1)}%)`);
          manifest.push({ job: job.name, frame: fr.id, plan: plan.id, label: plan.label, name, lr: m.lr, centroid: m.centroid.toFixed(1) });
        } else {
          console.log(`  ✗ ${name} 截图失败`);
        }
      }
    }
  }

  /* ===== 对比页 ===== */
  const cell = (m) => `<figure><img src="_重心帧图/${encodeURIComponent(m.name)}"><figcaption><b>${m.label}</b><br><span class="metric">左:右 = ${m.lr} ｜ 质心 ${m.centroid}%</span></figcaption></figure>`;
  const sec = (title, fname, sub) => {
    const ms = manifest.filter((m) => m.job === title);
    return `<h2>${sub}</h2><div class="row">${ms.map(cell).join('')}</div>`;
  };
  const jSyn = JOBS[0], jTyp = JOBS[1], jMax = JOBS[2];
  const curMed = metrics(frames79[midIdx]), curMax = metrics(frames79[maxIdx]);
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>视觉重心对比</title>
<style>
  body { margin: 0; padding: 24px 28px 60px; background: #f2efe9; color: #3c3a30;
         font: 14px/1.65 "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  h2 { font-size: 15px; margin: 26px 0 10px; color: #6b6455; }
  p.note { margin: 0 0 6px; color: #6b6455; }
  p.note b { color: #3c3a30; }
  .row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  figure { margin: 0; background: #fff; border: 1px solid #d8d2c6; border-radius: 8px; padding: 8px; }
  figure img { width: 100%; display: block; border-radius: 4px; }
  figcaption { text-align: center; padding-top: 6px; color: #6b6455; font-size: 12.5px; line-height: 1.5; }
  figcaption b { color: #3c3a30; }
  .metric { color: #948a76; }
</style></head><body>
<h1>视觉重心 · 方案对比</h1>
<p class="note">你的感受已量化实锤：真实音乐 79 帧统计 <b>左:右 ≈ 6.5 : 3.5</b>（你说 6:4，一致）。「左重」的主体不全是那几根塔 ——
左半（低频区）整片『地毯』都在贡献重量，所以单靠平移对比例改善有限（平移 8 格也只到 5.7:4.3）。</p>
<p class="note">四种方案横向对比（每张图下方标注该帧的 左:右比 与 质心位置；质心 50% = 正中央）：</p>
<p class="note">· <b>现状</b>：参照。<br>
· <b>平移 4 格</b>：塔离开左缘、最直观的「右移一点」；代价：最左 4 格留空（贴底细线）。<br>
· <b>循环移位 8 格</b>：内容整体右移，被挤出右端的部分卷回左端 —— 重心 ≈ 46%（接近正中）、左端不空、不丢内容；
代价：卷回左端的是超高音内容（播放时左下角的小柱会比其他区域闪得快一点，留意看能否接受）。<br>
· <b>平移 4 格 + 右半渐强（软钳）</b>：比例与质心最平衡（≈5.5:4.5 / 47%）；
代价：右半柱高被放大显示（不再是 1:1 波形，最高处有软压缩保护不撞顶）。</p>
${sec(jSyn.name, '', '① 合成信号（实拍图同场景）')}
${sec(jTyp.name, '', `② 真实音乐 · 典型帧（79 帧中位，现况左:右 ${curMed.lr}）`)}
${sec(jMax.name, '', `③ 真实音乐 · 最左重帧（现况左:右 ${curMax.lr}，问题最极端的时刻）`)}
<p class="note" style="margin-top:22px">看的时候重点感受：<b>画面重心是否往中间来了</b>、右半是否显得「有内容」，
以及各方案的代价（左端空白 / 右侧柱高放大）能否接受。选一档告诉我，或提出调整方向。</p>
</body></html>`;
  fs.writeFileSync(path.join(root, 'dist', '视觉重心对比.html'), html);
  console.log('  ✓ dist/视觉重心对比.html');

  child.kill();
  console.log('完成', manifest.length, '张 → dist/_重心帧图/');
  process.exit(0);
})().catch((e) => { console.error('出错:', e && e.message ? e.message : e); try { child.kill(); } catch {} process.exit(1); });
