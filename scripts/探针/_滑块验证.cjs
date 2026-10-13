/*
 * 滑块验证：驱动产物 exe →
 *   ① 频谱在跑（新引擎，viztest 合成信号真实链）；
 *   ② 系统设置里「可视化调节」= 16 滑块，初值 = 出厂默认；
 *   ③ 拖动实时生效（head 160→300 整体压低；smooth 1→3 更平滑）＋ localStorage 持久化；
 *   ④ RESET 按钮 → 清存储 + 回默认。
 * 用法：node scripts\探针\_滑块验证.cjs
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

try {
  const out = execSync('netstat -ano', { encoding: 'utf8' });
  for (const line of out.split(/\r?\n/)) {
    if (line.includes(':' + PORT) && /LISTENING/i.test(line)) {
      const pid = line.trim().split(/\s+/).pop();
      if (/^\d+$/.test(pid)) { try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch {} }
    }
  }
} catch {}

const profile = path.join(os.tmpdir(), 'rhine-slider-' + Date.now());
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
  await ev(`(async () => {
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
  console.log('塞入曲目 ok');

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
  await wait(2000);

  /* ① 频谱在跑 */
  const bars0 = await ev("(()=>{const sp=window.__spectrum; return sp? Array.from(sp.bars).slice(0,6).map(v=>+v.toFixed(4)) : null;})()");
  console.log('① bars 样例:', JSON.stringify(bars0));
  if (!bars0) { console.error('✗ 频谱没起来'); try { child.kill(); } catch {} process.exit(1); }

  /* ② 打开设置面板，检查 16 滑块 */
  await ev("(()=>{document.querySelector('[data-action=\"settings\"]').click();return 'clicked';})()");
  await wait(1400);
  const panel = await ev(`(()=>{
    const sliders = document.querySelectorAll('[data-sm-slider]');
    const vals = {}; sliders.forEach(s => { vals[s.dataset.smSlider] = Number(s.value); });
    return JSON.stringify({ count: sliders.length, reset: !!document.querySelector('[data-action="sm-viz-reset"]'), vals });
  })()`);
  console.log('② 面板:', panel);
  const p = JSON.parse(panel);
  const okDefaults = p.count === 16 && p.vals.head === 160 && p.vals.steepq === 160 && p.vals.smooth === 1 && p.vals.knee === 78;
  console.log(`   16 滑块 + 默认值: ${okDefaults ? '✓' : '✗'}`);

  /* ③ 实时生效：head 160 → 300（整体压低）
     ⚠ 活体 bars 随时间变化，单次读数噪声可达 ±4% → 多采样取中位数。 */
  const meanBars = "(()=>{const sp=window.__spectrum; const b=Array.from(sp.bars); return +(b.reduce((a,x)=>a+x,0)/b.length).toFixed(5);})()";
  const sampleN = async (n = 12, gap = 120) => { const a = []; for (let i = 0; i < n; i++) { a.push(await ev(meanBars)); await wait(gap); } return a; };
  const med = (a) => { const s = [...a].filter((v) => typeof v === 'number').sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const b0 = await sampleN(); const m0 = med(b0);
  await ev(`(()=>{const el=document.querySelector('[data-sm-slider="head"]'); el.value='300'; el.dispatchEvent(new Event('input',{bubbles:true})); return el.value;})()`);
  await wait(700);
  const b1 = await sampleN(); const m1 = med(b1);
  const delta1 = ((m1 - m0) / m0) * 100;
  console.log(`③ head 160→300：bars 均值中位数 ${m0} → ${m1}（${delta1.toFixed(1)}%，应 ≤ -5%）${delta1 <= -5 ? ' ✓' : ' ✗'}`);
  console.log(`   before: ${b0.map((v) => (+v).toFixed(4)).join(' ')}`);
  console.log(`   after : ${b1.map((v) => (+v).toFixed(4)).join(' ')}`);
  const stored1 = await ev("localStorage.getItem('rhine-sm-display')");
  console.log(`   存储: ${stored1}`);

  /* ③b smooth 1 → 3（相邻柱差变小 = 更平滑） */
  const jag = "(()=>{const sp=window.__spectrum; const b=Array.from(sp.bars); let s=0,n=0; for(let i=1;i<b.length;i++){s+=Math.abs(b[i]-b[i-1]);n++;} return +(s/n).toFixed(5);})()";
  const sampleJag = async (n = 12, gap = 120) => { const a = []; for (let i = 0; i < n; i++) { a.push(await ev(jag)); await wait(gap); } return a; };
  const j0 = await sampleJag(); const jm0 = med(j0);
  await ev(`(()=>{const el=document.querySelector('[data-sm-slider="smooth"]'); el.value='3'; el.dispatchEvent(new Event('input',{bubbles:true})); return el.value;})()`);
  await wait(700);
  const j1 = await sampleJag(); const jm1 = med(j1);
  const delta2 = ((jm1 - jm0) / jm0) * 100;
  console.log(`③b smooth 1→3：相邻柱差中位数 ${jm0} → ${jm1}（${delta2.toFixed(1)}%，应 ≤ -10%）${delta2 <= -10 ? ' ✓' : ' ✗'}`);

  /* ④ 重置 */
  await ev("(()=>{document.querySelector('[data-action=\"sm-viz-reset\"]').click();return 'ok';})()");
  await wait(500);
  const afterReset = await ev("(()=>JSON.stringify({stored: localStorage.getItem('rhine-sm-display'), head: document.querySelector('[data-sm-slider=\"head\"]').value, smooth: document.querySelector('[data-sm-slider=\"smooth\"]').value}))()");
  console.log('④ RESET 后:', afterReset);

  /* ⑤ 截图设置面板（post-reset，显示全套 16 滑块 UI）
     等 toast 自动消失 + 滚到面板顶部（标题 / RESET 按钮进视野） */
  await wait(3200);
  await ev("(()=>{const el=document.querySelector('.sm-viz'); if(el){el.scrollIntoView({block:'start'});return 'scrolled';} return 'no-el';})()");
  await wait(700);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result && shot.result.data) {
    fs.writeFileSync(path.join(root, 'dist', '滑块面板-设置.png'), Buffer.from(shot.result.data, 'base64'));
    console.log('  ✓ dist/滑块面板-设置.png');
  }

  child.kill();
  process.exit(0);
})().catch((e) => { console.error(e); try { child.kill(); } catch {} process.exit(1); });
