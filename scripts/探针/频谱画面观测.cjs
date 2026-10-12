/*
 * 频谱画面观测：驱动产物 exe，进详情态（合成信号 viztest），把频谱那块截下来 + 抓柱高快照。
 *
 * 用途：算法换成 SelfMusic 档（96 段 → 150 柱，见 selfmusic-spectrum.ts）之后，
 *   "画布上长什么样"要能被人看到、也能被脚本读到。这个脚本一次做两件事：
 *     ① 截两张图（全页 + 频谱放大）—— 给人看；
 *     ② 连采 N 帧 `__spectrum` 的 bars / display / peaks，落 JSON —— 给量化用。
 *   两者都存进 dist\（本地 scratch 区）。
 *
 * 用法：node scripts\探针\频谱画面观测.cjs [采样帧数，默认 24]
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
const N_SAMPLE = Number(process.argv[2] || 24);

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

const profile = path.join(os.tmpdir(), 'rhine-vizshot-' + Date.now());
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
  if (!ws) { console.error('拿不到 ws'); try { child.kill(); } catch {} process.exit(1); }
  const port = new URL(ws).port;
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /127\.0\.0\.1:41739/.test(t.url));
  if (!page) { console.error('找不到页面 target'); try { child.kill(); } catch {} process.exit(1); }

  const sock = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  sock.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => sock.addEventListener('open', r, { once: true }));
  await send('Runtime.enable'); await send('Page.enable');
  await wait(2500);
  const ev = async (x) => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); return r.result && r.result.result ? r.result.result.value : null; };

  await ev("localStorage.setItem('rhine-diag','1');localStorage.setItem('rhine-viztest','1');'ok'");

  const seed = JSON.stringify(SONG);
  const ok = await ev(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('rhine-music', 1);
      r.onupgradeneeded = () => { try { r.result.createObjectStore('songs', { keyPath: 'id' }); } catch (e) {} };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const song = Object.assign({ duration: 214, fav: false, plays: 3, pos: 0, order: 1 }, ${seed});
    await new Promise((res, rej) => {
      const tx = db.transaction('songs', 'readwrite');
      tx.objectStore('songs').put(song);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    return 'seeded';
  })()`);
  console.log('塞入曲目:', ok);

  await send('Page.reload', { ignoreCache: false });
  await wait(1500);
  for (let i = 0; i < 90; i++) {
    const st = await ev("(()=>{const s=document.querySelector('#stage');return s?s.getAttribute('data-mode')+'/'+s.getAttribute('data-boot'):'none';})()");
    if (/^(archive|detail)\//.test(String(st))) break;
    await wait(500);
  }
  await ev("(()=>{window.dispatchEvent(new CustomEvent('rhine-track',{detail:0}));return 'ok';})()");
  await wait(2000);
  for (let i = 0; i < 30; i++) {
    const st = await ev("(()=>{const s=document.querySelector('#stage');return s?s.getAttribute('data-mode'):null;})()");
    if (st === 'detail') break;
    await wait(500);
  }
  await wait(2500);

  /* 截图前状态自证：确认真的在可视化形态、canvas 可见、有 __spectrum */
  const state = await ev(`(()=>{
    const cv = document.querySelector('#p-detail-spectrum') || document.querySelector('.song-viz-body canvas') || document.querySelector('.song-viz canvas');
    const viz = document.querySelector('.song-viz');
    const body = document.querySelector('.song-viz-body');
    const sp = window.__spectrum;
    return JSON.stringify({
      mode: document.querySelector('#stage')?.getAttribute('data-mode'),
      algo: localStorage.getItem('rhine-viz-algo') || '(default=selfmusic)',
      vizCls: viz ? viz.className : null,
      canvasDisplay: cv ? getComputedStyle(cv).display : null,
      canvasBox: cv ? (()=>{const r=cv.getBoundingClientRect();return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)];})() : null,
      bodyBox: body ? (()=>{const r=body.getBoundingClientRect();return [Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)];})() : null,
      hasSpectrum: !!sp,
      canvasWH: sp && sp.canvas ? [sp.canvas.width, sp.canvas.height] : null,
    });
  })()`);
  console.log('截图前状态:', state);

  /* 连采柱高快照：bars（算法输出，直接画的目标）/ display（插值后的即时绘制值）/ peaks（峰值线） */
  const frames = [];
  for (let k = 0; k < N_SAMPLE; k++) {
    const one = await ev(`(()=>{
      const sp = window.__spectrum; if (!sp) return null;
      return JSON.stringify({ bars: Array.from(sp.bars), disp: Array.from(sp.display), peaks: Array.from(sp.peaks) });
    })()`);
    if (one) frames.push(JSON.parse(one));
    await wait(60);
  }
  const jsonPath = path.join(root, 'dist', '频谱画面-柱高.json');
  fs.writeFileSync(jsonPath, JSON.stringify({ sampledAt: new Date().toISOString(), n: frames.length, frames }, null, 0));
  console.log(`  ✓ dist/频谱画面-柱高.json（${frames.length} 帧）`);

  const st = JSON.parse(state);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result && shot.result.data) {
    fs.writeFileSync(path.join(root, 'dist', '频谱画面-全页.png'), Buffer.from(shot.result.data, 'base64'));
    console.log('  ✓ dist/频谱画面-全页.png');
  }
  if (st.canvasBox) {
    const [x, y, w, h] = st.canvasBox;
    const shot2 = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: Math.max(0, x - 6), y: Math.max(0, y - 6), width: Math.min(w + 12, 3000), height: h + 12, scale: 3 },
    });
    if (shot2.result && shot2.result.data) {
      fs.writeFileSync(path.join(root, 'dist', '频谱画面-放大.png'), Buffer.from(shot2.result.data, 'base64'));
      console.log('  ✓ dist/频谱画面-放大.png');
    }
  }

  child.kill();
  process.exit(0);
})().catch((e) => { console.error(e); try { child.kill(); } catch {} process.exit(1); });
