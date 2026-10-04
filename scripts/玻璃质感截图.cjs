/*
 * 玻璃质感截图：驱动产物 exe，进详情态截一张、打开设置弹层截一张。
 * 用法：node scripts\玻璃质感截图.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const EXE = [
  path.join(root, 'dist', '音乐播放器-win32-x64', '音乐播放器.exe'),
  path.join(root, 'dist', '音乐播放器-win32-x64', 'electron.exe'),
].find((p) => fs.existsSync(p));
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

const profile = path.join(os.tmpdir(), 'rhine-glass-' + Date.now());
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let err = '';
const child = spawn(EXE, ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-sandbox', '--window-size=1600,1000'],
  { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: EXE_DIR });
child.stderr.on('data', (d) => (err += String(d)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const RE = /DevTools listening on (ws:\/\/[^\s]+)/;

(async () => {
  let ws = null; const t0 = Date.now();
  while (Date.now() - t0 < 20000) { const m = RE.exec(err); if (m) { ws = m[1]; break; } await wait(200); }
  if (!ws) { console.error('拿不到 ws'); process.exit(1); }
  const port = new URL(ws).port;
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /127\.0\.0\.1:41739/.test(t.url));
  if (!page) { console.error('找不到页面 target'); process.exit(1); }

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
    await new Promise((res, rej) => {
      const tx = db.transaction('songs', 'readwrite');
      tx.objectStore('songs').put({ id: 'glass1', title: '玻璃质感预览', artist: 'Rhine Lab', album: '材质测试', duration: 214, fav: false, plays: 3, pos: 0, order: 1 });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    return 'ok';
  })()`);
  await send('Page.reload', { ignoreCache: false });
  await wait(1500);

  // 等进详情态（开屏最多 ~35s）
  for (let i = 0; i < 90; i++) {
    const st = await ev("(()=>{const s=document.querySelector('#stage');return s?s.getAttribute('data-mode')+'/'+s.getAttribute('data-boot'):'none';})()");
    if (i % 12 === 11) console.log('  等界面… ' + st);
    if (/^(archive|detail)\//.test(String(st))) break;
    await wait(500);
  }
  await ev("(()=>{window.dispatchEvent(new CustomEvent('rhine-track',{detail:0}));return 'ok';})()");
  await wait(2000);
  // 确保 detail
  for (let i = 0; i < 30; i++) {
    const st = await ev("(()=>{const s=document.querySelector('#stage');return s?s.getAttribute('data-mode'):null;})()");
    if (st === 'detail') break;
    await wait(500);
  }
  await wait(1500);

  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  if (shot1.result && shot1.result.data) {
    fs.writeFileSync(path.join(root, 'dist', '玻璃-详情区.png'), Buffer.from(shot1.result.data, 'base64'));
    console.log('  ✓ dist/玻璃-详情区.png');
  }

  // 打开设置弹层
  await ev("(()=>{const b=document.querySelector('[data-action=\"settings\"]');if(b)b.click();return b?'clicked':'no-btn';})()");
  await wait(1500);
  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  if (shot2.result && shot2.result.data) {
    fs.writeFileSync(path.join(root, 'dist', '玻璃-设置弹层.png'), Buffer.from(shot2.result.data, 'base64'));
    console.log('  ✓ dist/玻璃-设置弹层.png');
  }

  // 打印详情面板的实际 computed 玻璃属性，自证
  const prove = await ev(`(() => {
    const d = document.querySelector('#detail-content');
    const cs = d ? getComputedStyle(d) : null;
    return JSON.stringify({
      detailBg: cs ? cs.backgroundColor : null,
      detailBackdrop: cs ? (cs.backdropFilter || cs.webkitBackdropFilter) : null,
      detailRadius: cs ? cs.borderRadius : null,
    });
  })()`);
  console.log('  详情区 computed: ' + prove);

  child.kill();
  process.exit(0);
})().catch((e) => { console.error(e); try { child.kill(); } catch {} process.exit(1); });
