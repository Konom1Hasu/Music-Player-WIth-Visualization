/*
 * 活路径 smoke：真实音频 → 整曲 PCM 模式（驱动产物 exe）
 * 验证自研档在**真实播放**（非 viztest）下的取数链：
 *   ① __smState().mode === 'pcm'（切歌时整曲解码成功，没退流式）；
 *   ② rate = 文件原生采样率（ref.wav = 48000），durMs ≈ 文件时长；
 *   ③ 播放中 posMs（平滑时钟）持续推进、bars 非零、dtMs 合理。
 * 素材：dist/_ref视频帧/ref.wav（真实音乐，48000Hz 立体声 16bit）。
 * 用法：node scripts\探针\_活路径smoke.cjs
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
const WAV = path.join(root, 'dist', '_ref视频帧', 'ref.wav');
if (!fs.existsSync(WAV)) { console.error('找不到 dist/_ref视频帧/ref.wav'); process.exit(1); }

try {
  const out = execSync('netstat -ano', { encoding: 'utf8' });
  for (const line of out.split(/\r?\n/)) {
    if (line.includes(':' + PORT) && /LISTENING/i.test(line)) {
      const pid = line.trim().split(/\s+/).pop();
      if (/^\d+$/.test(pid)) { try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch {} }
    }
  }
} catch {}

const profile = path.join(os.tmpdir(), 'rhine-smpcm-' + Date.now());
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let err = '';
const child = spawn(EXE, ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-sandbox', '--window-size=1600,1000'],
  { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: EXE_DIR });
child.stderr.on('data', (d) => (err += String(d)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const RE = /DevTools listening on (ws:\/\/[^\s]+)/;

const SONG = {
  id: 'tl_pcm', title: 'PCM Smoke', artist: 'Rhine Lab', album: 'Probe Vol.01',
  duration: 351, fav: false, plays: 0, pos: 0, order: 1,
  path: WAV.replace(/\\/g, '/'),
};

let FAIL = 0;
const check = (label, ok, extra) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) FAIL++;
};

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

  /* 诊断开（不打开 viztest —— 本 smoke 必须走真实播放链） */
  await ev("localStorage.setItem('rhine-diag','1');'ok'");

  const seed = JSON.stringify(SONG);
  await ev(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('rhine-music', 1);
      r.onupgradeneeded = () => { try { r.result.createObjectStore('songs', { keyPath: 'id' }); } catch (e) {} };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const song = Object.assign({}, ${seed});
    await new Promise((res, rej) => {
      const tx = db.transaction('songs', 'readwrite');
      tx.objectStore('songs').put(song);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    return 'seeded';
  })()`);
  console.log('塞入曲目（path = ref.wav）ok');

  await send('Page.reload', { ignoreCache: false });
  await wait(1500);
  let mode = 'none';
  for (let i = 0; i < 90; i++) {
    mode = String(await ev("(()=>{const s=document.querySelector('#stage');return s?s.getAttribute('data-mode'):'none';})()"));
    if (/^(archive|detail)$/.test(mode)) break;
    await wait(500);
  }
  console.log(`启动就绪：data-mode=${mode}`);

  /* 选中 → 起播（PLAY TRACK = openFile → playAt + audio.play） */
  await ev("(()=>{window.dispatchEvent(new CustomEvent('rhine-track',{detail:0}));return 'ok';})()");
  await wait(1500);
  const clickRet = await ev("(()=>{const b=document.querySelector('.read-file')||document.querySelector('[data-action=\"open\"]'); if(b){b.click();return 'clicked';} return 'no-btn';})()");
  console.log(`起播入口：${clickRet}`);

  /* 轮询：期待进入 pcm 模式（整曲解码 + 原生率解析） */
  let o = null;
  for (let i = 0; i < 80; i++) {
    const s = await ev("window.__smState ? JSON.stringify(window.__smState()) : null");
    o = s ? JSON.parse(s) : null;
    if (o && o.mode === 'pcm') break;
    await wait(500);
  }
  console.log('__smState =', JSON.stringify(o));
  check("① 真实播放进入整曲 PCM 模式（mode === 'pcm'）", !!o && o.mode === 'pcm', o ? `mode=${o.mode}` : '无 __smState');
  check('② 采样率 = 文件原生率 48000', !!o && o.rate === 48000, o ? `rate=${o.rate}` : '');
  check('② 时长 ≈ 文件时长（350000~353000ms）', !!o && o.durMs > 350000 && o.durMs < 353000, o ? `durMs=${o.durMs}` : '');
  check('② 引擎采样率已跟随（engineRate=48000）', !!o && o.engineRate === 48000, o ? `engineRate=${o.engineRate}` : '');

  /* ③ 位置推进 + bars 有值（等 2.2s 再读一次） */
  await wait(2200);
  const b = JSON.parse(String(await ev("JSON.stringify(window.__smState())")));
  console.log('__smState(2.2s 后) =', JSON.stringify(b));
  check('③ 平滑时钟位置推进（posMs 增大）', !!b && b.posMs > (o ? o.posMs : 0), `${o ? o.posMs : '?'} → ${b ? b.posMs : '?'}`);
  check('③ 帧间隔在合理区间（5~80ms）', !!b && b.dtMs > 5 && b.dtMs < 80, b ? `dtMs=${b.dtMs}` : '');
  check('③ 柱高有值（bars 非空且非零）', !!b && Array.isArray(b.bars) && b.bars.some((v) => v > 0), b ? JSON.stringify(b.bars) : '');

  child.kill();
  console.log(`\n结果：${FAIL === 0 ? '全部通过 ✓' : FAIL + ' 项失败 ✗'}`);
  process.exit(FAIL === 0 ? 0 : 1);
})().catch((e) => { console.error(e); try { child.kill(); } catch {} process.exit(1); });
