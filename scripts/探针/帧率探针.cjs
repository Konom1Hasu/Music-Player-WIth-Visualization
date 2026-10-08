/*
 * 帧率探针：驱动产物 exe，进 ?viztest 合成信号模式，实测频谱的**渲染帧率**。
 *
 * 为什么需要它：用户 2026-10-08 要求"帧率要高"。vizFrame 里原来播放中卡了 15ms 的门，
 * 在 60Hz 屏上恰好放行、看不出问题，但在 165Hz 屏上等于"每三帧才画一次"，
 * 实测只有 ~55fps。这个脚本把"帧率够不够"从主观感受变成数字。
 *
 * 判据：
 *   · 实测 fps 应接近显示器刷新率（本机 165Hz）；
 *   · 帧间隔 p90 不应显著大于中位数（否则是"平均高但有卡顿"）。
 *
 * 用法：node scripts\探针\帧率探针.cjs [采样秒数，默认 3]
 *      ★ 必须**有头**运行：headless 下 rAF 会停摆/被降频，量出来的帧率是假的。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');   // 本脚本在 scripts\探针\ 下，仓库根要上两级
const EXE = [
  path.join(root, 'dist', '音乐播放器-win32-x64', '音乐播放器.exe'),
  path.join(root, 'dist', '音乐播放器-win32-x64', 'electron.exe'),
].find((p) => fs.existsSync(p));
if (!EXE) { console.error('找不到产物 exe'); process.exit(1); }
const EXE_DIR = path.dirname(EXE);
const PORT = 41739;
const SECONDS = Number(process.argv[2] || 3);

/* 残留实例占着内嵌 UI 端口 → bind 失败 → 退回 terminal.html（那页没有频谱），
   所以先清掉占用者（见项目约定）。 */
try {
  const out = execSync('netstat -ano', { encoding: 'utf8' });
  for (const line of out.split(/\r?\n/)) {
    if (line.includes(':' + PORT) && /LISTENING/i.test(line)) {
      const pid = line.trim().split(/\s+/).pop();
      if (/^\d+$/.test(pid)) { try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch {} }
    }
  }
} catch {}

const profile = path.join(os.tmpdir(), 'rhine-fps-' + Date.now());
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // 带着它 Electron 退化成纯 Node，不建渲染进程
let err = '';
const child = spawn(EXE, ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-sandbox', '--window-size=1600,1000'],
  { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: EXE_DIR });
child.stderr.on('data', (d) => (err += String(d)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const RE = /DevTools listening on (ws:\/\/[^\s]+)/;

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
  /* ★ 必须把窗口拉到前台：Chromium 对"不可见/未聚焦"的窗口会降频 rAF
     （实测后台只有 ~78Hz，前台才是真实的刷新率）。项目虽关了背景节流，
     但 rAF 的频率仍受可见性影响，量帧率前先 bringToFront。 */
  await send('Page.bringToFront');
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result && r.result.result ? r.result.result.value : null;
  };

  /* 开诊断 + 合成信号。★ VIZ_TEST 里那条 localStorage 分支是**模块加载时**读的，
     所以设完要重新加载页面（下面用 CDP 的 Page.reload）。
     ★ 而 `__spectrum` / `__rhineViz` 只在**详情面板渲染时**才挂到 window 上
     （频谱实例跟着详情画布一起重建），所以必须先塞一首歌、再进详情态 ——
     这与 scripts\探针\详情溢出探针.cjs 走的是同一条进场路径。 */
  await ev("localStorage.setItem('rhine-diag','1');localStorage.setItem('rhine-viztest','1');'ok'");

  /* 塞一首歌，否则进不了详情态 */
  await ev(`(async () => {
    const song = { id: 'fps1', title: 'Rhine Lab Theme (fps probe)', artist: 'Joyce Moore', album: 'Internal Database Vol.01' };
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('rhine-music', 1);
      r.onupgradeneeded = () => { try { r.result.createObjectStore('songs', { keyPath: 'id' }); } catch (e) {} };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction('songs', 'readwrite');
      tx.objectStore('songs').put(song);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
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

  let ready = false; const t1 = Date.now();
  let lastSt = '';
  while (Date.now() - t1 < 20000) {
    const st = await ev(`(() => { const s = document.querySelector('#stage');
      return JSON.stringify({ mode: s && s.getAttribute('data-mode'), viz: !!document.querySelector('.song-viz'), spec: !!window.__spectrum, diag: !!window.__rhineViz }); })()`);
    lastSt = st;
    try {
      const o = JSON.parse(st);
      if (o.mode === 'detail' && o.spec && o.diag) { ready = true; break; }
    } catch {}
    await wait(400);
  }
  if (!ready) { console.error('未就绪（合成信号或诊断没起来）最后状态：' + lastSt); try { child.kill(); } catch {} process.exit(1); }
  await send('Page.bringToFront');
  await wait(1200);

  /* 先空转量一次"页面能给到的 rAF 上界"（同一窗口里的纯空转频率） */
  const rafCeil = await ev(`new Promise((res) => { let n = 0; const t = performance.now();
    const f = () => { n++; if (performance.now() - t < 1000) requestAnimationFrame(f); else res(n); };
    requestAnimationFrame(f); })`);

  await ev('window.__rhineViz.rendered = 0; window.__rhineViz.frames = 0;');
  const tA = Date.now();
  await wait(SECONDS * 1000);
  const spanMs = Date.now() - tA;
  const rendered = await ev('window.__rhineViz.rendered');
  const intervalsRaw = await ev('JSON.stringify(window.__rhineViz.intervals || [])');

  let intervals = [];
  try { intervals = JSON.parse(intervalsRaw || '[]'); } catch {}
  const sorted = intervals.slice().sort((a, b) => a - b);
  const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
  const fps = (rendered / spanMs) * 1000;

  console.log('=== 频谱渲染帧率实测（合成信号，有头运行） ===');
  console.log('  采样时长 ' + (spanMs / 1000).toFixed(2) + ' 秒，画了 ' + rendered + ' 帧');
  console.log('  ★ 实测 fps = ' + fps.toFixed(1));
  console.log('  页面 rAF 空转上界 = ' + rafCeil + ' Hz（显示器刷新率的下限估计）');
  if (sorted.length) {
    console.log('  帧间隔样本 ' + sorted.length + ' 个：p50 ' + pct(0.5) + 'ms　p90 ' + pct(0.9)
      + 'ms　max ' + sorted[sorted.length - 1] + 'ms');
    console.log('  （p90 明显大于 p50 = 虽平均高但有卡顿；两者接近 = 帧率稳定）');
  } else {
    console.log('  （没拿到间隔样本：诊断开关可能没生效）');
  }
  console.log('  分析节拍 cadenceMs = ' + (await ev('window.__rhineViz.cadenceMs')) + 'ms（应为 20）');
  console.log('  worker 生效 = ' + (await ev('window.__rhineViz.workerOn')));

  try { child.kill(); } catch {}
  process.exit(0);
})();
