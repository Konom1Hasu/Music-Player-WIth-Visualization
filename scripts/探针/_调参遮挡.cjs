/*
 * 调参遮挡实测 + 让位验证（2026-10-14）：设置弹层为频谱让位的几何验证。
 *
 * 背景：用户反馈「调节参数时不好看到实际的效果，因为被设置窗口和背景模糊挡住」。
 *   修复：滚到 SELF-MUSIC VISUALIZER 区块时自动进入「调参预览态」——
 *   遮罩去模糊/去底色 + 设置面板向左让位（左缘贴画布左缘），频谱 100% 露出。
 *   本探针驱动产物 exe 验证：
 *     A 段（滚到 sm-viz）：data-viz-preview 挂上、面板 x≈0（贴左）、
 *       频谱画布与面板无重叠（canvas.x > modal 右缘）、遮罩 blur(0px)+transparent；
 *     B 段（滚回顶部）：恢复 —— 面板 x≈420（居中）、blur(18px)。
 *   每段各截一张图（dist/_调参遮挡-让位后.png / -恢复.png）。
 *
 * 用法：node scripts\探针\_调参遮挡.cjs
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

const profile = path.join(os.tmpdir(), 'rhine-occl-' + Date.now());
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let err = '';
const child = spawn(EXE, ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-sandbox', '--window-size=1920,1080'],
  { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: EXE_DIR });
child.stderr.on('data', (d) => (err += String(d)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const RE = /DevTools listening on (ws:\/\/[^\s]+)/;

/* 复用同一个测量表达式（#stage 1920×1080 逻辑坐标，已按缩放换算） */
const MEASURE = `(() => {
  const stage = document.querySelector('#stage');
  const sr = stage.getBoundingClientRect();
  const s = sr.width / 1920;
  const L = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
    return { x: Math.round((r.left - sr.left)/s), y: Math.round((r.top - sr.top)/s), w: Math.round(r.width/s), h: Math.round(r.height/s) }; };
  const cs = (el) => el ? getComputedStyle(el) : null;
  const modal = document.querySelector('.settings-modal');
  const backdrop = document.querySelector('.modal-backdrop');
  const canvas = document.querySelector('#detail-content .song-viz-body canvas');
  const mc = cs(modal), bc = cs(backdrop);
  return JSON.stringify({
    previewAttr: backdrop ? (backdrop.dataset.vizPreview || null) : null,
    modal: L(modal),
    canvas: L(canvas),
    backdropCss: bc ? { bg: bc.backgroundColor, blur: bc.backdropFilter || bc.webkitBackdropFilter } : null,
    modalScrollTop: modal ? Math.round(modal.scrollTop) : null
  });
})()`;

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? '  →  ' + detail : ''}`);
  if (!ok) failures++;
};

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
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (r && r.result && r.result.exceptionDetails) console.log('  [eval 异常]', JSON.stringify(r.result.exceptionDetails).slice(0, 200));
    return r.result && r.result.result ? r.result.result.value : null;
  };
  const shot = async (file) => {
    const s = await send('Page.captureScreenshot', { format: 'png' });
    if (s.result && s.result.data) {
      const out = path.join(root, 'dist', file);
      fs.writeFileSync(out, Buffer.from(s.result.data, 'base64'));
      console.log('  ✓ dist/' + file);
    }
  };

  await ev("localStorage.setItem('rhine-viztest','1');'ok'");
  await ev(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('rhine-music', 1);
      r.onupgradeneeded = () => { try { r.result.createObjectStore('songs', { keyPath: 'id' }); } catch (e) {} };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction('songs', 'readwrite');
      tx.objectStore('songs').put({ id: 'occl1', title: '遮挡实测', artist: 'Rhine Lab', album: '几何测试', duration: 214, fav: false, plays: 1, pos: 0, order: 1 });
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    return 'ok';
  })()`);
  await send('Page.reload', { ignoreCache: false });
  await wait(1500);

  for (let i = 0; i < 90; i++) {
    const st = await ev("(()=>{const s=document.querySelector('#stage');return s?s.getAttribute('data-mode')+'/'+s.getAttribute('data-boot'):'none';})()");
    if (i % 12 === 11) console.log('  等界面… ' + st);
    if (/^(archive|detail)\//.test(String(st))) break;
    await wait(500);
  }
  await ev("(()=>{window.dispatchEvent(new CustomEvent('rhine-track',{detail:0}));return 'ok';})()");
  for (let i = 0; i < 30; i++) {
    const st = await ev("(()=>{const s=document.querySelector('#stage');return s?s.getAttribute('data-mode'):null;})()");
    if (st === 'detail') break;
    await wait(500);
  }
  await wait(2000);

  // 打开设置弹层
  await ev("(()=>{const b=document.querySelector('[data-action=\"settings\"]');if(b)b.click();return b?'clicked':'no-btn';})()");
  await wait(1400);

  /* ---- A 段：滚到「可视化调节」→ 应进入让位态 ---- */
  await ev("(()=>{const m=document.querySelector('.sm-viz');if(!m)return 'no-smviz';m.scrollIntoView({block:'start'});return 'scrolled';})()");
  await wait(1000);   // 等 IntersectionObserver + 0.32s 让位过渡完成
  const a = JSON.parse(await ev(MEASURE));
  console.log('=== A 段（让位态） ===');
  console.log(JSON.stringify(a, null, 1));
  check('A · data-viz-preview 已挂上', a.previewAttr === '1', 'attr=' + a.previewAttr);
  check('A · 设置面板贴左（x≈0）', a.modal && a.modal.x <= 4, 'modal.x=' + (a.modal && a.modal.x));
  check('A · 频谱画布与面板无重叠（全露出）', !!(a.canvas && a.modal && a.canvas.x >= a.modal.x + a.modal.w), `canvas.x=${a.canvas && a.canvas.x}, modal 右缘=${a.modal && (a.modal.x + a.modal.w)}`);
  check('A · 遮罩已去模糊', !!a.backdropCss && /blur\(0(px)?\)|none/.test(a.backdropCss.blur), 'blur=' + (a.backdropCss && a.backdropCss.blur));
  check('A · 遮罩已去底色', !!a.backdropCss && /rgba\(0, 0, 0, 0\)|transparent/.test(a.backdropCss.bg), 'bg=' + (a.backdropCss && a.backdropCss.bg));
  await shot('_调参遮挡-让位后.png');

  /* ---- B 段：滚回顶部 → 应恢复 ---- */
  await ev("(()=>{const m=document.querySelector('.settings-modal');if(m)m.scrollTop=0;return 'ok';})()");
  await wait(1000);
  const b = JSON.parse(await ev(MEASURE));
  console.log('=== B 段（恢复态） ===');
  console.log(JSON.stringify(b, null, 1));
  check('B · data-viz-preview 已摘除', b.previewAttr === null, 'attr=' + b.previewAttr);
  check('B · 设置面板回到居中（x≈420）', b.modal && Math.abs(b.modal.x - 420) <= 4, 'modal.x=' + (b.modal && b.modal.x));
  check('B · 遮罩模糊已恢复', !!b.backdropCss && /blur\(18px\)/.test(b.backdropCss.blur), 'blur=' + (b.backdropCss && b.backdropCss.blur));
  await shot('_调参遮挡-恢复.png');

  /* ---- C 段：关闭弹层 → 重新打开（回归：finishModalClose 里新增的 dispose 不破坏关闭路径） ---- */
  await ev("(()=>{const b=document.querySelector('[data-action=\"close-modal\"]');if(b)b.click();return 'ok';})()");
  await wait(900);
  const closed = await ev("(()=>{return document.querySelector('.modal-backdrop')===null?'closed':'still';})()");
  check('C · 弹层已关闭', closed === 'closed', closed);
  await ev("(()=>{const b=document.querySelector('[data-action=\"settings\"]');if(b)b.click();return 'ok';})()");
  await wait(900);
  const reopened = await ev("(()=>{return document.querySelector('.settings-modal')?'open':'none';})()");
  check('C · 弹层可再次打开', reopened === 'open', reopened);
  const c = JSON.parse(await ev(MEASURE));
  check('C · 新弹层无让位残留（居中 + 模糊）', c.previewAttr === null && c.modal && Math.abs(c.modal.x - 420) <= 4, `attr=${c.previewAttr}, x=${c.modal && c.modal.x}`);

  child.kill();
  console.log();
  console.log(failures === 0 ? '===== 让位验证通过（11 项全绿） =====' : `===== 让位验证未通过（${failures} 项失败） =====`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); try { child.kill(); } catch {} process.exit(1); });
