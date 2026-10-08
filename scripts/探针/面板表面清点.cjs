/*
 * 面板表面清点：连上产物 exe 的渲染进程，把"哪些元素是视觉上的面板/表面"列出来
 * —— 元素的类名、背景色、是否有 backdrop-filter、以及它在屏幕上的区域大小。
 *
 * 目的：做"玻璃质感"之前先摸清现状，别凭猜去改 CSS。
 * 用法：node scripts\探针\面板表面清点.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');   // 本脚本在 scripts\探针\ 下，仓库根要上两级
const EXE = [
  path.join(root, 'dist', '音乐播放器-win32-x64', '音乐播放器.exe'),
  path.join(root, 'dist', '音乐播放器-win32-x64', 'electron.exe'),
].find((p) => fs.existsSync(p));
if (!EXE) {
  console.error('找不到产物 exe');
  process.exit(1);
}
const EXE_DIR = path.dirname(EXE);
const PORT = 41739;

function killPort() {
  try {
    const out = require('node:child_process').execSync('netstat -ano', { encoding: 'utf8' });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (line.includes(':' + PORT) && /LISTENING/i.test(line)) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && /^\d+$/.test(pid)) pids.add(pid);
      }
    }
    for (const pid of pids) {
      try {
        require('node:child_process').execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
        console.log('  已清掉占用 ' + PORT + ' 的进程 PID=' + pid);
      } catch {}
    }
  } catch {}
}
killPort();

const profile = path.join(require('node:os').tmpdir(), 'rhine-surface-' + Date.now());
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let stderr = '';
const child = spawn(
  EXE,
  ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-sandbox', '--window-size=1600,1000'],
  { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: EXE_DIR },
);
child.stderr.on('data', (d) => (stderr += String(d)));

function wsUrlFromStderr() {
  const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
  return m ? m[1] : null;
}

async function waitForWs(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const u = wsUrlFromStderr();
    if (u) return u;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

async function httpJson(url) {
  const res = await fetch(url);
  return res.json();
}

async function main() {
  const browserWs = await waitForWs(20000);
  if (!browserWs) {
    console.error('拿不到 DevTools ws。stderr:\n' + stderr.slice(-1500));
    process.exit(1);
  }
  const port = new URL(browserWs).port;
  const list = await httpJson(`http://127.0.0.1:${port}/json/list`);
  console.log('targets:');
  for (const t of list) console.log('  ' + t.type + '  ' + t.url);

  const page = list.find((t) => t.type === 'page' && /127\.0\.0\.1:41739/.test(t.url));
  if (!page) {
    console.error('找不到页面 target');
    process.exit(1);
  }

  /* node 22 自带 WebSocket 全局，不用引 ws 包 */
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params) =>
    new Promise((res) => {
      const i = ++id;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  await send('Runtime.enable');
  await send('Page.enable');
  await new Promise((r) => setTimeout(r, 2000));

  const evalIn = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      console.error('exception:', JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    }
    return r.result && r.result.result ? r.result.result.value : null;
  };

  /* 打开诊断入口 + 往曲库塞一首假歌：界面只在"有曲目"时才渲染完整面板
     （空库下停在欢迎屏，清点不到东西）。做法照抄 scripts\右侧切换验证.cjs。 */
  await evalIn(`localStorage.setItem('rhine-diag', '1'); localStorage.setItem('rhine-viztest', '1'); 'ok'`);
  const seeded = await evalIn(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('rhine-music', 1);
      r.onupgradeneeded = () => { try { r.result.createObjectStore('songs', { keyPath: 'id' }); } catch (e) {} };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const song = {
      id: 'testsurface', title: '表面清点测试', artist: 'Rhine Lab',
      album: '验证用', duration: 180, fav: false, plays: 0, pos: 0, order: 1,
    };
    await new Promise((res, rej) => {
      const tx = db.transaction('songs', 'readwrite');
      tx.objectStore('songs').put(song);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    return 'seeded-ok';
  })()`);
  console.log('  塞入测试曲目: ' + seeded);

  await send('Page.reload', { ignoreCache: false });
  await new Promise((r) => setTimeout(r, 1500));

  /* 等曲库读进来 + 进档案态。
     ★ 开屏动画一整套跑完要 ~30 秒（access → logo → auth → scan → welcome →
       array → select → inspect → detail），别用 20 秒就放弃 —— 会误判成"界面没就绪"。
       轮询给 45 秒。 */
  for (let i = 0; i < 90; i++) {
    const st = await evalIn(`(() => {
      const s = document.querySelector('#stage');
      return s ? (s.getAttribute('data-mode') + '/' + s.getAttribute('data-boot')) : 'none';
    })()`);
    if (i % 10 === 9) console.log('    · 等界面… ' + ((i + 1) * 0.5).toFixed(1) + 's (' + st + ')');
    if (/^(archive|detail)\//.test(String(st))) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  /* 打开详情（面板最全的形态） */
  await evalIn(`(() => { window.dispatchEvent(new CustomEvent('rhine-track', { detail: 0 })); return 'ok'; })()`);
  await new Promise((r) => setTimeout(r, 1500));

  /* 等详情区就绪（工具栏出现）——空壳详情不算，见右侧切换验证的说明 */
  for (let i = 0; i < 60; i++) {
    const ok = await evalIn(`(() => {
      const s = document.querySelector('#stage');
      const v = document.querySelector('.song-viz');
      return (s && s.getAttribute('data-mode') === 'detail') && v && /viz-mode|lyric-mode/.test(v.className)
        ? 'ready' : 'wait';
    })()`);
    if (ok === 'ready') break;
    await new Promise((r) => setTimeout(r, 500));
  }

  const dump = await evalIn(`(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const bg = cs.backgroundColor;
      const bf = cs.backdropFilter || cs.webkitBackdropFilter;
      const hasBorder = cs.borderTopWidth !== '0px' || cs.borderLeftWidth !== '0px';
      const isTransparent = bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent';
      const r = el.getBoundingClientRect();
      // 只收"有实底或有毛玻璃"的、且够大的元素 = 视觉上的面板
      const bigEnough = r.width >= 120 && r.height >= 40;
      if (!bigEnough) continue;
      if (isTransparent && (!bf || bf === 'none')) continue;
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && typeof el.className === 'string') ? el.className : '',
        id: el.id || '',
        bg,
        bf: bf && bf !== 'none' ? bf : '',
        border: hasBorder ? cs.borderTopColor + ' ' + cs.borderTopWidth : '',
        radius: cs.borderRadius,
        box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        shadow: cs.boxShadow && cs.boxShadow !== 'none' ? cs.boxShadow.slice(0, 60) : '',
      });
    }
    return JSON.stringify(out, null, 1);
  })()`);

  console.log('');
  console.log('=== 视觉面板清点（有实底或有毛玻璃的较大元素）===');
  console.log(dump);

  try { child.kill(); } catch {}
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  try { child.kill(); } catch {}
  process.exit(1);
});
