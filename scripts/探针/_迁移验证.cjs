/*
 * 迁移验证（2026-10-14）：确认「参数复刻」的存储迁移真的发生。
 *
 * 背景：exe 的 localStorage['rhine-sm-display'] 存的是 v2.7.5 时代的旧档
 *   （knee78/detail50/timbre45… 12 项与 SelfMusic 面板不符），会遮住 v2.7.6 起
 *   升级的「用户实测档」。player.ts 已改为 v2 格式 + 一次性迁移（旧档不沿用）。
 *
 * ★ 本脚本用**真实用户目录**启动产物 exe（**不带 --user-data-dir**）——
 *   这正是迁移发生的环境；跑完自动关掉实例。
 * 检查：
 *   ① localStorage['rhine-sm-display'] 是否已是 v2 格式（{v:2,values:{…}}）
 *   ② values 16 项是否 = 实测档（0/95/0/60/300/80/100/114/39/93/16/100/110/95/100/1）
 *   ③ 面板滑块（若在 DOM）回显值是否一致
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const EXE = path.join(root, 'dist', '音乐播放器-win32-x64', '音乐播放器.exe');
if (!fs.existsSync(EXE)) { console.error('找不到产物 exe'); process.exit(1); }
const EXE_DIR = path.dirname(EXE);
const PORT = 41739;

const EXPECT = { smooth: 0, knee: 95, detail: 0, leftpump: 60, head: 300, right: 80, agc: 100,
  steepq: 114, tilt: 39, timbre: 93, tint: 16, expanda: 100, surge: 110, release: 95,
  valley: 100, idle: 1 };

try {
  const out = execSync('netstat -ano', { encoding: 'utf8' });
  for (const line of out.split(/\r?\n/)) {
    if (line.includes(':' + PORT) && /LISTENING/i.test(line)) {
      const pid = line.trim().split(/\s+/).pop();
      if (/^\d+$/.test(pid)) { try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch {} }
    }
  }
} catch {}

const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
let err = '';
/* ★ 不带 --user-data-dir → 使用真实用户目录（迁移目标环境） */
const child = spawn(EXE, ['--remote-debugging-port=0', '--no-sandbox'], { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: EXE_DIR });
child.stderr.on('data', (d) => (err += String(d)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const RE = /DevTools listening on (ws:\/\/[^\s]+)/;

(async () => {
  let ws = null; const t0 = Date.now();
  while (Date.now() - t0 < 20000) { const m = RE.exec(err); if (m) { ws = m[1]; break; } await wait(200); }
  if (!ws) throw new Error('拿不到 ws');
  const port = new URL(ws).port;
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && /41739|app:\/\/|file:/.test(t.url)) || list.find((t) => t.type === 'page');
  if (!page) throw new Error('找不到页面');

  const sock = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pend = new Map();
  sock.addEventListener('message', (e) => { const m = JSON.parse(String(e.data)); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); sock.send(JSON.stringify({ id: i, method, params })); });
  await new Promise((r) => sock.addEventListener('open', r, { once: true }));
  await send('Runtime.enable'); await send('Page.enable');
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true });
    if (r && r.result && r.result.exceptionDetails) {
      console.log('  [eval 异常]', JSON.stringify(r.result.exceptionDetails).slice(0, 240));
    }
    return r.result && r.result.result ? r.result.result.value : null;
  };
  /* 等主界面就绪（#stage 退出 boot）：真实 profile 首次启动可能较慢 —— 页面未完成导航时
     evaluate 会落进 about:blank 的旧上下文（localStorage 访问直接抛 SecurityError） */
  let stageSt = 'none';
  for (let i = 0; i < 60; i++) {
    stageSt = await ev("(()=>{const s=document.querySelector('#stage');return s?s.getAttribute('data-mode')+'/'+s.getAttribute('data-boot'):'none';})()");
    if (typeof stageSt === 'string' && /^(archive|detail)\//.test(stageSt)) break;
    await wait(500);
  }
  console.log('stage:', stageSt);
  await wait(1200);

  console.log('页面:', page.url);
  const raw = await ev("localStorage.getItem('rhine-sm-display')");
  console.log();
  console.log('===① 迁移后的存档 ===');
  console.log(raw);

  let okFormat = false, okValues = false, diffs = [];
  try {
    const parsed = JSON.parse(raw);
    okFormat = Number(parsed.v) === 2 && parsed.values && typeof parsed.values === 'object';
    if (okFormat) {
      for (const [k, want] of Object.entries(EXPECT)) {
        const got = Number(parsed.values[k]);
        if (got !== want) diffs.push(`${k}: ${got} ≠ ${want}`);
      }
      okValues = diffs.length === 0;
    }
  } catch (e) { /* 格式错 */ }
  console.log('② 格式 v2:', okFormat ? '✓' : '✗');
  console.log('② 16 项值 = 实测档:', okValues ? '✓' : '✗  ' + diffs.join('; '));

  /* ③ 面板回显（面板可能未渲染，尽力而为） */
  const ui = await ev(`(()=>{
    const ks = ['smooth','knee','detail','leftpump','head','right','agc','steepq','tilt','timbre','tint','expanda','surge','release','valley','idle'];
    const out = {};
    for (const k of ks) { const el = document.querySelector('[data-sm-slider="' + k + '"]'); out[k] = el ? el.value : null; }
    return JSON.stringify(out);
  })()`);
  console.log('③ 面板滑块回显:', ui);

  child.kill();
  const all = okFormat && okValues;
  console.log();
  console.log(all ? '===== 迁移验证通过 =====' : '===== 迁移验证未通过 =====');
  process.exit(all ? 0 : 1);
})().catch((e) => { console.error('出错:', e && e.message ? e.message : e); try { child.kill(); } catch {} process.exit(1); });
