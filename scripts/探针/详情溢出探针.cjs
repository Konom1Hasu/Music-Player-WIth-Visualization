/*
 * 详情溢出探针：驱动产物 exe，分别塞「超长标题」与「正常标题」各一首，进详情态。
 * 逐个元素量「内容宽 vs 容器宽」「右边界 vs 详情区右边界」，
 * 把越界/被裁切的元素揪出来，并在截图前打印当时 DOM 状态（截图与断言同一个瞬间）。
 *
 * 用法：node scripts\探针\详情溢出探针.cjs
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

const profile = path.join(os.tmpdir(), 'rhine-overflow-' + Date.now());
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let err = '';
const child = spawn(EXE, ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-sandbox', '--window-size=1600,1000'],
  { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: EXE_DIR });
child.stderr.on('data', (d) => (err += String(d)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const RE = /DevTools listening on (ws:\/\/[^\s]+)/;

// 最坏输入：很长的中英混排标题 + 很长的歌手 + 很长的专辑
const LONG = {
  id: 'ovf1',
  title: 'The Longest Song Title Ever Written In This Library 关于一个很长的名字到底会不会溢出边界这件事',
  artist: 'Rhine Lab Music Production Committee feat. 某某某',
  album: '超长专辑名称测试卷（Deluxe Edition Remastered 2026）',
};
// 常态输入：普通长度
const SHORT = {
  id: 'ovf1',
  title: 'Rhine Lab Theme',
  artist: 'Joyce Moore',
  album: 'Internal Database Vol.01',
};

const ROUNDS = [
  { label: '长标题', song: LONG, png: '详情排版-长标题.png', withEnv: true },
  { label: '正常标题', song: SHORT, png: '详情排版-正常标题.png', withEnv: false },
];

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

  const MEASURE = `(() => {
    const box = (el) => { const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) }; };
    const host = document.querySelector('#detail-content');
    if (!host) return JSON.stringify({ error: 'no #detail-content' });
    const hostBox = host.getBoundingClientRect();
    const nav = document.querySelector('.system-nav');
    const navBox = nav ? nav.getBoundingClientRect() : null;
    const out = [];
    for (const el of host.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 && r.height < 1) continue;
      const reasons = [];
      /* 阈值给 5px：line-height 不是整数时，scrollHeight 会比 clientHeight
         多 2~4px（浏览器按整像素向上取整），那不是溢出，是舍入。 */
      const dx = el.scrollWidth - el.clientWidth;
      if (el.clientWidth > 0 && dx > 5) reasons.push('scrollX+' + dx);
      const dy = el.scrollHeight - el.clientHeight;
      if (el.clientHeight > 0 && dy > 5 && cs.overflowY !== 'auto' && cs.overflowY !== 'scroll') reasons.push('scrollY+' + dy);
      if (r.right > hostBox.right + 2) reasons.push('overflowRight+' + Math.round(r.right - hostBox.right));
      if (r.left < hostBox.left - 2) reasons.push('overflowLeft+' + Math.round(hostBox.left - r.left));
      if (!reasons.length) continue;
      out.push({ tag: el.tagName.toLowerCase(), cls: (typeof el.className === 'string' ? el.className : ''), id: el.id || '',
        text: (el.textContent || '').trim().slice(0, 34), box: box(el),
        scrollW: el.scrollWidth, clientW: el.clientWidth, reasons });
    }
    const R = (el) => { if (!el) return null; const r = el.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), Math.round(r.right)]; };
    const SEC = (el) => { const cs = getComputedStyle(el);
      return { t: el.tagName.toLowerCase(), c: (typeof el.className === 'string' ? el.className : ''),
               h: el.offsetHeight, mt: parseFloat(cs.marginTop) || 0, mb: parseFloat(cs.marginBottom) || 0 }; };
    const host2 = document.querySelector('#detail-content');
    return JSON.stringify({
      sections: [...host2.children].map(SEC),
      vizParts: [...host2.querySelectorAll('.song-viz > *, .song-viz-body > *, .song-viz-head > *')].map(SEC),
      hostBox: box(host),
      hostScroll: { scrollH: host.scrollHeight, clientH: host.clientHeight,
                    overflowY: getComputedStyle(host).overflowY,
                    scrollsBy: Math.max(0, host.scrollHeight - host.clientHeight) },
      stageY: (() => { const s = document.querySelector('#stage').getBoundingClientRect();
                       const hb = host.getBoundingClientRect();
                       const sc = new DOMMatrix(getComputedStyle(document.querySelector('#stage')).transform).a;
                       return Math.round((hb.top - s.top) / sc); })(),
      hostStageBottom: (() => { const s = document.querySelector('#stage').getBoundingClientRect();
                       const hb = host.getBoundingClientRect();
                       const sc = new DOMMatrix(getComputedStyle(document.querySelector('#stage')).transform).a;
                       return Math.round((hb.bottom - s.top) / sc); })(),
      navBox: navBox ? [Math.round(navBox.x), Math.round(navBox.y), Math.round(navBox.width), Math.round(navBox.height)] : null,
      navOpacity: nav ? getComputedStyle(nav).opacity : null,
      kicker: R(document.querySelector('.detail-kicker')),
      songHead: R(document.querySelector('.song-head')),
      h2: R(document.querySelector('.song-head h2')),
      titleCn: R(document.querySelector('.detail-title-cn')),
      vizBody: R(document.querySelector('.song-viz-body')),
      canvas: R(document.querySelector('.song-viz-body canvas')),
      actions: R(document.querySelector('.detail-actions')),
      items: out,
    }, null, 1);
  })()`;

  const report = [];
  for (const round of ROUNDS) {
    const seed = JSON.stringify(round.song);
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
    console.log(`\n[${round.label}] 塞入曲目: ${ok}`);

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
    await wait(1500);

    const rep = await ev(MEASURE);
    report.push(`########## ${round.label}\n` + rep);

    const shot = await send('Page.captureScreenshot', { format: 'png' });
    if (shot.result && shot.result.data) {
      fs.writeFileSync(path.join(root, 'dist', round.png), Buffer.from(shot.result.data, 'base64'));
      console.log('  ✓ dist/' + round.png);
    }
    const hb = JSON.parse(rep).hostBox;
    const shot2 = await send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: Math.max(0, hb.x - 30), y: Math.max(0, hb.y - 30), width: hb.w + 60, height: hb.h + 60, scale: 2 },
    });
    if (shot2.result && shot2.result.data) {
      fs.writeFileSync(path.join(root, 'dist', round.png.replace('.png', '-放大.png')), Buffer.from(shot2.result.data, 'base64'));
      console.log('  ✓ dist/' + round.png.replace('.png', '-放大.png'));
    }
  }

  fs.writeFileSync(path.join(root, 'dist', '详情溢出-report.json'), report.join('\n\n'));
  console.log('\n  ✓ dist/详情溢出-report.json');

  child.kill();
  process.exit(0);
})().catch((e) => { console.error(e); try { child.kill(); } catch {} process.exit(1); });
