/*
 * 「还原 + 更激进」定档渲染：驱动产物 exe（viztest + rhine-diag），冻结渲染四档 × 3 帧 → 截图。
 * 数据源：dist/_sm2出图.json（旧引擎素材 / 新·原版裸 / 新·默认 / 新·更激进）。
 * 冻结手法与 _激进渲染.cjs 相同：打桩 applyExternalBars/update/decay + 直写
 * bars / prevBars / display / peaks。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const EXE = [
  path.join(root, 'dist', '音乐播放器-win32-x64', '音乐播放器.exe'),
  path.join(root, 'dist', '音乐播放器-win32-x64', 'electron.exe'),
].find((p) => fs.existsSync(p));
if (!EXE) { console.error('找不到产物 exe'); process.exit(1); }
const EXE_DIR = path.dirname(EXE);
const PORT = 41739;

const data = JSON.parse(fs.readFileSync(path.join(root, 'dist', '_sm2出图.json'), 'utf8'));
const FRAME_IDS = [0, 5, 10];
const jobs = data.rows.map((r) => ({
  name: r.name,
  frames: FRAME_IDS.map((f) => ({ id: f, data: r.frames[f] })),
}));

try {
  const out = execSync('netstat -ano', { encoding: 'utf8' });
  for (const line of out.split(/\r?\n/)) {
    if (line.includes(':' + PORT) && /LISTENING/i.test(line)) {
      const pid = line.trim().split(/\s+/).pop();
      if (/^\d+$/.test(pid)) { try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch {} }
    }
  }
} catch {}

const profile = path.join(os.tmpdir(), 'rhine-sm2shot-' + Date.now());
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let err = '';
const child = spawn(EXE, ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-sandbox', '--window-size=1600,1000'],
  { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: EXE_DIR });
child.stderr.on('data', (d) => (err += String(d)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const RE = /DevTools listening on (ws:\/\/[^\s]+)/;
const SONG = { id: 'tl1', title: 'Viz Check', artist: 'Rhine Lab', album: 'Probe Vol.01' };
const slug = (s) => s.replace(/[^\w\u4e00-\u9fa5]+/g, '').slice(0, 14);

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
    window.__origAEB = sp.applyExternalBars.bind(sp);
    sp.applyExternalBars = () => {};
    sp.update = () => {};
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
  console.log('canvas:', JSON.stringify(canvasBox));
  if (!canvasBox || !canvasBox.w) throw new Error('canvas 不可见');

  fs.mkdirSync(path.join(root, 'dist', '_sm2帧图'), { recursive: true });
  const manifest = [];
  for (const job of jobs) {
    for (const fr of job.frames) {
      const set = await ev(`(()=>{
        const sp = window.__spectrum;
        const d = ${JSON.stringify(fr.data)};
        for (let i = 0; i < sp.bars.length; i++) { const v = i < d.length ? d[i] : 0; sp.bars[i] = v; sp.prevBars[i] = v; sp.display[i] = v; sp.peaks[i] = v; }
        return JSON.stringify({ n: d.length, h0: sp.display[0], h10: sp.display[10], h75: sp.display[75] });
      })()`);
      await wait(450);
      const hash = crypto.createHash('md5').update(Buffer.from(Float32Array.from(fr.data).buffer)).digest('hex').slice(0, 8);
      const shot = await send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: Math.max(0, canvasBox.x - 4), y: Math.max(0, canvasBox.y - 4), width: canvasBox.w + 8, height: canvasBox.h + 8, scale: 3 },
      });
      const name = `还原-${slug(job.name)}-f${String(fr.id).padStart(3, '0')}.png`;
      if (shot.result && shot.result.data) {
        fs.writeFileSync(path.join(root, 'dist', '_sm2帧图', name), Buffer.from(shot.result.data, 'base64'));
        console.log(`  ✓ ${name}  data=${hash}  probe=${set}`);
        manifest.push({ name, job: job.name, frame: fr.id, hash });
      } else {
        console.log(`  ✗ ${name} 截图失败`);
      }
    }
  }
  fs.writeFileSync(path.join(root, 'dist', '_sm2帧图', '_manifest.json'), JSON.stringify(manifest, null, 2));

  child.kill();
  console.log('完成', manifest.length, '张 → dist/_sm2帧图/');
  process.exit(0);
})().catch((e) => { console.error('出错:', e && e.message ? e.message : e); try { child.kill(); } catch {} process.exit(1); });
