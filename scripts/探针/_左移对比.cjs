/*
 * 左峰右移·对比出图（2026-10-14，供用户选位移量）
 *
 * 背景：用户看完 v2.7.7 实拍图（频谱画面-放大.png）后要求「左侧的峰可以稍微右移一点」。
 *   这里把「数组平移」的候选效果做出来给用户选：
 *       display[i] = (i >= k) ? C[i - k] : 0     ← 内容整体右移 k 格，最左 k 格为 0
 *   平移同时作用于 bars 与 peaks（顶盖跟随柱体）；绘制层对 0 值自然画 2px 底线。
 *   ★ 该变换与将来正式实现（绘制层/输入侧平移）完全同式，图 = 落地后的画面。
 *
 * 数据（两组）：
 *   · 合成信号：dist/频谱画面-柱高.json frames[0]（= 实拍图「频谱画面-放大.png」同场景，
 *     左侧 bar2-3 顶天的那一帧）
 *   · 真实音乐：dist/_sm2出图.json「出厂默认用户实测档」frames[0] / frames[10]
 *
 * 手法：与 _sm2渲染.cjs 相同的冻结渲染（打桩 applyExternalBars/decay + 直写 bars/peaks/gauges）。
 * 输出：dist/_左移帧图/*.png + dist/左峰右移对比.html
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

const K_LIST = [0, 1, 2];

/* 读数据 */
const dataSyn = JSON.parse(fs.readFileSync(path.join(root, 'dist', '频谱画面-柱高.json'), 'utf8'));
const synFrame = dataSyn.frames[0];
const dataReal = JSON.parse(fs.readFileSync(path.join(root, 'dist', '_sm2出图.json'), 'utf8'));
const realRow = dataReal.rows.find((r) => r.name.includes('实测档'));
if (!realRow) { console.error('找不到实测档行'); process.exit(1); }

const jobs = [
  {
    name: '合成信号',
    frames: [{ id: 'syn', bars: synFrame.bars, peaks: synFrame.peaks, gauges: synFrame.gauges }],
  },
  {
    name: '真实音乐',
    frames: [0, 10].map((i) => ({
      id: 'f' + String(i).padStart(3, '0'),
      bars: realRow.frames[i],
      peaks: realRow.frames[i],   // 出图数据没有独立 peaks（渲染脚本一直用 bars 当 peaks）
    })),
  },
];

/** 数组右移 k 格：out[i] = i>=k ? src[i-k] : 0 */
function shiftArr(src, k) {
  const out = new Array(src.length).fill(0);
  for (let i = k; i < src.length; i++) out[i] = src[i - k];
  return out;
}

try {
  const out = execSync('netstat -ano', { encoding: 'utf8' });
  for (const line of out.split(/\r?\n/)) {
    if (line.includes(':' + PORT) && /LISTENING/i.test(line)) {
      const pid = line.trim().split(/\s+/).pop();
      if (/^\d+$/.test(pid)) { try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch {} }
    }
  }
} catch {}

const profile = path.join(os.tmpdir(), 'rhine-lshift-' + Date.now());
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

  fs.mkdirSync(path.join(root, 'dist', '_左移帧图'), { recursive: true });
  const manifest = [];
  for (const job of jobs) {
    for (const fr of job.frames) {
      for (const k of K_LIST) {
        const bars = shiftArr(fr.bars, k);
        const peaks = shiftArr(fr.peaks, k);
        const g = fr.gauges ? JSON.stringify(fr.gauges) : 'null';
        const set = await ev(`(()=>{
          const sp = window.__spectrum;
          const b = ${JSON.stringify(bars)};
          const p = ${JSON.stringify(peaks)};
          for (let i = 0; i < sp.bars.length; i++) { sp.bars[i] = b[i] || 0; sp.peaks[i] = p[i] || 0; }
          const g = ${g};
          if (g) { sp.gauges.kick = g.kick; sp.gauges.bass = g.bass; sp.gauges.vocal = g.vocal; sp.gauges.cymbal = g.cymbal; }
          return 'k=' + ${k};
        })()`);
        await wait(400);
        const shot = await send('Page.captureScreenshot', {
          format: 'png',
          clip: { x: Math.max(0, canvasBox.x - 4), y: Math.max(0, canvasBox.y - 4), width: canvasBox.w + 8, height: canvasBox.h + 8, scale: 3 },
        });
        const name = `${job.name}-${fr.id}-左移${k}.png`;
        if (shot.result && shot.result.data) {
          fs.writeFileSync(path.join(root, 'dist', '_左移帧图', name), Buffer.from(shot.result.data, 'base64'));
          console.log(`  ✓ ${name}`);
          manifest.push({ job: job.name, frame: fr.id, k, name });
        } else {
          console.log(`  ✗ ${name} 截图失败`);
        }
      }
    }
  }

  /* 对比页（浅底、两组 × 三档） */
  const cell = (m) => `<figure><img src="_左移帧图/${encodeURIComponent(m.name)}"><figcaption>左移 ${m.k} 格</figcaption></figure>`;
  const syn = manifest.filter((m) => m.job === '合成信号');
  const rx = manifest.filter((m) => m.job === '真实音乐');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>左峰右移对比</title>
<style>
  body { margin: 0; padding: 24px 28px 60px; background: #f2efe9; color: #3c3a30;
         font: 14px/1.6 "Segoe UI", "Microsoft YaHei", sans-serif; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  h2 { font-size: 15px; margin: 26px 0 10px; color: #6b6455; }
  p.note { margin: 0 0 4px; color: #6b6455; }
  .row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  figure { margin: 0; background: #fff; border: 1px solid #d8d2c6; border-radius: 8px; padding: 8px; }
  figure img { width: 100%; display: block; border-radius: 4px; }
  figcaption { text-align: center; padding-top: 6px; color: #6b6455; }
</style></head><body>
<h1>左峰右移 · 对比</h1>
<p class="note">变换方式（与将来正式实现同一式）：<b>display[i] = 原数据[i − k]</b>，最左 k 格为 0（画成 2px 底线）。
看的是「左侧的峰」相对左边缘的位置 —— 选一档，或告诉我们别的方式。</p>
<h2>① 合成信号（实拍图「频谱画面-放大.png」同场景：左侧 bar2–3 顶天的那帧）</h2>
<div class="row">${syn.map(cell).join('')}</div>
<h2>② 真实音乐（190.0s 起第 0 帧）</h2>
<div class="row">${rx.filter((m) => m.frame === 'f000').map(cell).join('')}</div>
<h2>③ 真实音乐（190.0s 起第 10 帧）</h2>
<div class="row">${rx.filter((m) => m.frame === 'f010').map(cell).join('')}</div>
</body></html>`;
  fs.writeFileSync(path.join(root, 'dist', '左峰右移对比.html'), html);
  console.log('  ✓ dist/左峰右移对比.html');

  child.kill();
  console.log('完成', manifest.length, '张 → dist/_左移帧图/');
  process.exit(0);
})().catch((e) => { console.error('出错:', e && e.message ? e.message : e); try { child.kill(); } catch {} process.exit(1); });
