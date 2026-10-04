/* 右侧切换（可视化 / 歌词）端到端验证
   ------------------------------------------------------------------
   为什么不能只查源码字符串：滚动是否真的把当前行挪到了容器中线、
   高亮是否真的只有一行、切换是否真的换了形态与显隐 —— 这些只有让**真实渲染进程**
   自己量才行。

   ★ 驱动对象 = 本项目的 Electron，不是外部 Chrome。
     Electron 自带一份 Chromium，`--remote-debugging-port` 一样能用 CDP ——
     而且不需要联网、不需要翻墙、拿到的就是用户真正看到的那个渲染进程
     （外部 Chrome 还要另开静态服务把 app/ui 挂上去，多一层失真）。
     产物里的 `electron.exe` 与重命名后的 `音乐播放器.exe` 是同一个运行时，
     用前者启动可以直接指定 resources/app，不会去读 userData 里的安装副本。

   做法（CDP over WebSocket，不引第三方依赖 —— node 22 自带 WebSocket）：
     ① 用 electron.exe 启动项目源码目录（--remote-debugging-port=0）
     ② 往曲库 IndexedDB 注入一首带 LRC 的假曲目
     ③ 真实点击"歌词"按钮 → 量形态 / aria-pressed / 落库
     ④ 喂一个歌词时间 → 量高亮行号、是否只有一行、滚动是否落到容器中线
     ⑤ 切回"可视化" → 量画布重现、歌词列表隐藏

   ⚠️ headless 不能用来量这些：headless 下 rAF 被压到 33Hz、20ms 定时器压到 27Hz
      （scripts 里另有探针量证过），滚动过渡与高亮都测不准。所以这里跑**有头** Electron。 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
/* 截图落到 dist/（构建产物目录，不进版本、文档一致性检查也豁免它）——
   写进 scripts/ 会被"结构图里必须逐个列名"的检查抓成缺失项（踩过）。 */
const OUT = path.join(root, 'dist', '歌词模式截图.png');

/* 驱动对象 = 产物里的播放器 exe（Electron 运行时），不用外部 Chrome：
   本机 Chrome 需要翻墙才能启动，不能作为验证前提。
   ★ 用**产物里的 exe + 产物里的 app/**，而不是 electron.exe + 源码 app/：
     在 Windows 上，用 play.exe 跨目录启动会因 GPU 进程反复崩溃直接退出
     （--disable-gpu 也压不住，日志里 "GPU process isn't usable. Goodbye."）。
     从 exe 自己的目录启动、读同级的 resources/app 才是它正常工作、也是用户实际用的形态。
     所以本脚本跑之前要先把源码同步进 resources/app（见 README 的验证一节）。 */
const EXE = [
  path.join(root, 'dist', '音乐播放器-win32-x64', '音乐播放器.exe'),
  path.join(root, 'dist', '音乐播放器-win32-x64', 'electron.exe'),
].find((p) => fs.existsSync(p));
const EXE_DIR = EXE ? path.dirname(EXE) : '';
/* 产物里的 app 目录（exe 真正读的那份代码）。 */
const APP_DIR = EXE ? path.join(EXE_DIR, 'resources', 'app') : '';

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (e ? '  → ' + e : '')); }
};

(async () => {
  console.log('=== 右侧切换（可视化 / 歌词）端到端验证 ===\n');
  if (!EXE || !APP_DIR || !fs.existsSync(path.join(APP_DIR, 'main.js'))) {
    console.log('  · 找不到产物 exe / resources/app（先跑一次打包），跳过端到端');
    console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
    process.exit(0);
  }
  console.log('  exe    : ' + path.relative(root, EXE));
  console.log('  app    : ' + path.relative(root, APP_DIR));

  /* ★ 先确认产物里的 app 与源码同步了 —— 不然量的是旧代码，
     结论全错（这一坑项目里真实发生过：修好的 longPath 没进 exe）。
     比 main.js 与 ui/index.html 引用的 bundle 是否一致即可。 */
  {
    const crypto = require('crypto');
    const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex').slice(0, 12);
    const pairs = [
      ['main.js', path.join(root, 'app', 'main.js'), path.join(APP_DIR, 'main.js')],
      ['preload.js', path.join(root, 'app', 'preload.js'), path.join(APP_DIR, 'preload.js')],
    ];
    const refUi = fs.readFileSync(path.join(root, 'app', 'ui', 'index.html'), 'utf8');
    const dBundle = (/assets\/(index-[\w-]+\.js)/.exec(refUi) || [])[1] || '';
    const gotUi = fs.readFileSync(path.join(APP_DIR, 'ui', 'index.html'), 'utf8');
    const gBundle = (/assets\/(index-[\w-]+\.js)/.exec(gotUi) || [])[1] || '';
    let synced = true;
    for (const [name, a, b] of pairs) {
      const same = fs.existsSync(b) && md5(a) === md5(b);
      if (!same) { synced = false; console.log('  ✗ ' + name + ' 与源码不一致（产物是旧的）'); }
    }
    const bundleFile = path.join(APP_DIR, 'ui', 'assets', gBundle);
    if (!fs.existsSync(bundleFile)) { synced = false; console.log('  ✗ 产物 ui/assets 里没有 ' + gBundle); }
    else {
      const body = fs.readFileSync(bundleFile, 'utf8');
      if (!body.includes('song-viz-body') || !body.includes('view-lyric')) {
        synced = false; console.log('  ✗ 产物 bundle 里没有本轮新特性（song-viz-body / view-lyric）');
      }
    }
    if (!synced) {
      console.log('     —— 先把源码同步进 resources/app 再跑本脚本（见 README 验证一节）。');
      console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
      process.exit(1);
    }
    console.log('  app 目录 : 与源码一致（' + dBundle + '，含本轮新特性）\n');
  }

  /* ★ 先清掉上一次跑残留的实例：主进程的内嵌 UI 服务用**固定端口**
     （RHINE_UI_PORT，默认 41739 —— 固定是为了让 IndexedDB 的源跨启动稳定）。
     上一轮没杀干净时，新实例 bind 失败 → main.js 退回 terminal.html（单面板 3D），
     那页里根本没有 .song-viz，表现就是"详情区已渲染出 .song-viz 舞台 ✗"（踩过）。
     这里用 netstat + taskkill 把占用者清掉，验证才可重复。 */
  try {
    const { execSync } = require('child_process');
    const out = execSync('netstat -ano', { encoding: 'utf8' });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      if (/:41739\b/.test(line) && /LISTENING/.test(line)) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && /^\d+$/.test(pid) && pid !== '0') pids.add(pid);
      }
    }
    for (const pid of pids) {
      try { execSync('taskkill /F /PID ' + pid, { stdio: 'ignore' }); console.log('  · 清掉占用 41739 的残留进程 PID ' + pid); } catch (e) {}
    }
    if (pids.size) await new Promise((r) => setTimeout(r, 800));
  } catch (e) { /* netstat 不可用就跳过，后面有兜底判定 */ }

  /* profile 一律放系统临时目录：放项目里会残留 SingletonLock，
     下次启动直接报"无法对其数据目录执行读写操作"。 */
  const profile = path.join(os.tmpdir(), 'rhine-lyric-cdp-' + Date.now());
  /* ★ 必须清掉环境里的 ELECTRON_RUN_AS_NODE：
     本机（以及不少 CI 容器）把它设成 1 —— 那是给"把播放器 exe 当 node 用"的探针准备的
     （项目里 `ELECTRON_RUN_AS_NODE=1 音乐播放器.exe script.js` 就是靠它）。
     带着它启动，Electron 会退化成一个纯 Node 进程，根本不创建渲染进程、
     更不会监听 --remote-debugging-port，表现就是"连不上 DevTools"（踩过）。
     显式删掉这个键，才能拿到真正的 Electron 运行时。 */
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const proc = spawn(EXE, [
    '--remote-debugging-port=0',         // 让 Chromium 自己挑端口
    `--user-data-dir=${profile}`,
    '--no-sandbox',
    '--window-size=1600,1000',
  ], { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: EXE_DIR });   // cwd 必须是 exe 自己那层

  /* 从 stderr 里读 DevTools 端口（Chromium 会打印 "DevTools listening on ws://..."） */
  let wsUrl = '';
  const found = await new Promise((resolve) => {
    const scan = (d) => {
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(String(d));
      if (m) { wsUrl = m[1]; resolve(true); }
    };
    proc.stderr.on('data', scan);
    proc.stdout.on('data', scan);
    setTimeout(() => resolve(false), 20000);
  });
  const cleanup = () => {
    try { proc.kill(); } catch (e) {}
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
  };
  if (!found) {
    console.log('  ✗ 没能连上 DevTools（Electron 没起来或没开调试端口）');
    cleanup();
    console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
    process.exit(1);
  }

  /* 连到页面 target 的 WebSocket（浏览器级 ws 要再查一次 /json/list） */
  const httpBase = wsUrl.replace(/^ws:\/\//, 'http://').replace(/\/devtools\/browser\/.*$/, '');
  let page = null;
  for (let i = 0; i < 60; i++) {
    const list = await fetch(httpBase + '/json/list').then((r) => r.json()).catch(() => []);
    /* 挑"我们的应用页"：主界面是内嵌 UI（http://127.0.0.1:41739 起的静态服务）。
       不要挑 about:blank（往它写 IndexedDB 会落到别的域，应用读不到 —— 踩过）。 */
    page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl &&
      /127\.0\.0\.1:41739/.test(String(t.url || '')))
      || list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl &&
        !String(t.url || '').startsWith('about:') && !String(t.url || '').startsWith('devtools:') &&
        !String(t.url || '').startsWith('chrome:'));
    if (page) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!page) {
    console.log('  ✗ 找不到应用页面 target');
    cleanup();
    process.exit(1);
  }
  console.log('  页面 target: ' + decodeURIComponent(page.url) + '\n');
  /* 主界面应该是内嵌 UI 的 index.html（走 http://127.0.0.1:41739）。
     跟这个不符就说明 main.js 退回了 terminal.html —— 那时后面的断言全无意义，
     直接说清楚原因，不要让人对着"找不到 .song-viz"瞎猜。 */
  if (!/127\.0\.0\.1:41739/.test(decodeURIComponent(page.url))) {
    console.log('  ✗ 加载的不是内嵌 UI（index.html），而是 ' + decodeURIComponent(page.url));
    console.log('     —— 多半是 41739 被占用导致 startUiServer 失败、退回 terminal.html。');
    console.log('     先确认没有别的播放器实例在跑，再重跑本脚本。');
    cleanup();
    process.exit(1);
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((r) => {
    const id = ++msgId;
    pending.set(id, r);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Runtime.enable');
  await send('Page.enable');
  /* ⚠️ 连上之后不能立刻求值：target 的 url 虽然已经是我们的页面，
     但执行上下文可能还处在"导航刚提交"的过渡态 —— 此时 indexedDB
     会抛 SecurityError（opaque origin）。等主文档的执行上下文稳定再动。 */
  await new Promise((r) => setTimeout(r, 2000));

  const evalIn = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    const res = r && r.result;
    if (res && res.exceptionDetails) {
      console.log('    [eval 异常] ' + (res.exceptionDetails.exception && res.exceptionDetails.exception.description || res.exceptionDetails.text));
      return null;
    }
    if (res && res.result) {
      if (res.result.subtype === 'error') return null;
      return res.result.value;
    }
    return null;
  };

  /* ---------- 先往曲库里塞一首带歌词的假歌 ----------
     界面只在"有曲目"时才渲染 .song-viz。空库下截不到任何东西，
     所以先写进应用真正读取的那个 IndexedDB（rhine-music / songs）。
     歌词用真实 LRC 时间轴（含 [mm:ss.xx] 标签），才能验证游标与滚动。
     ⚠️ 时间戳必须按真实 LRC 规范生成：秒只能 00~59，超过要进位到分。
       曾经这里写 `[00:${i*12}]`，i≥9 时就变成 `[00:108.00]` —— 解析器不认，
       12 行只剩 9 行，后面的行号断言全部对不上（踩过）。 */
  const LYRICS = (() => {
    const zh = ['夜色漫过档案架', '屏幕的蓝在呼吸', '我把频率调到最安静的那一档',
      '鼓点落下来的瞬间', '所有数据都在流动', '莱茵的灯还亮着',
      '这一句是第六十秒', '接着往下走', '低频在脚下铺开',
      '高频穿过玻璃顶', '我们把噪音调成音乐', '最后一段留给静默'];
    const stamp = (sec) =>
      `[${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}.00]`;
    return zh.map((t, i) => `${stamp(i * 12)}${t}`).join('\n');
  })();

  /* 诊断入口（__rhineLyricSeek / __rhineStepLyrics / __libraryLoaded）只在
     diag / viztest 下挂载。这里用 localStorage 打开（UI 由主进程的固定端口服务加载，
     URL 参数不好带；应用同时认 localStorage，刷新后仍生效）。 */
  await evalIn(`localStorage.setItem('rhine-diag', '1'); localStorage.setItem('rhine-viztest', '1'); 'ok'`);
  await evalIn(`window.__LYRICS_TEXT = ${JSON.stringify(LYRICS)}; 'ok'`);

  const seeded = await evalIn(`(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('rhine-music', 1);
      r.onupgradeneeded = () => { try { r.result.createObjectStore('songs', { keyPath: 'id' }); } catch (e) {} };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const song = {
      id: 'testlyric', title: '歌词滚动测试', artist: 'Rhine Lab',
      album: '验证用', duration: 180, fav: false, plays: 0, pos: 0, order: 1,
      lrc: window.__LYRICS_TEXT,
    };
    await new Promise((res, rej) => {
      const tx = db.transaction('songs', 'readwrite');
      tx.objectStore('songs').put(song);
      tx.oncomplete = res; tx.onerror = () => rej(tx.error);
    });
    return 'seeded-ok';
  })()`);
  ok('已把带歌词的测试曲目写入曲库', seeded === 'seeded-ok', String(seeded));

  /* 刷新让应用重新读库并渲染详情区 */
  await send('Page.reload', { ignoreCache: false });
  await new Promise((r) => setTimeout(r, 1200));

  /* 先确认应用**真的把这首读进来了**（内存里的曲库 + 档案记录）。
     读不进来就一切免谈，直接报清楚是哪一层没到。 */
  let libState = '';
  for (let i = 0; i < 40; i++) {
    libState = await evalIn(`(() => {
      const s = document.querySelector('#stage');
      return JSON.stringify({
        mode: s ? s.getAttribute('data-mode') : null,
        boot: s ? s.getAttribute('data-boot') : null,
        rows: document.querySelectorAll('.song-row,.song-item').length,
        tracks: document.querySelectorAll('[data-track]').length,
      });
    })()`) || '';
    try { if (JSON.parse(libState).mode === 'archive') break; } catch (e) {}
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log('  应用状态: ' + libState);
  const libOk = await evalIn(`(() => {
    try { return typeof window.__libraryLoaded === 'number' ? window.__libraryLoaded : -1; } catch (e) { return -1; }
  })()`);
  console.log('  __libraryLoaded: ' + (libOk === -1 ? '（未暴露，需 ?viztest/--diag）' : libOk));

  /* 让应用打开这首歌的详情。
     应用正常路径是"选中档案 → 进 detail"。曲库只有这一首，
     所以直接派发 rhine-track(0)（换歌/选中同一件事），等价于点开它。 */
  await evalIn(`(() => { window.dispatchEvent(new CustomEvent('rhine-track', { detail: 0 })); return 'dispatched'; })()`);
  await new Promise((r) => setTimeout(r, 1500));

  /* 还不行就退一步：点档案卡片本身（等价于用户"点歌曲名打开档案"）。 */
  let modeNow = await evalIn(`(() => { const s = document.querySelector('#stage'); return s ? s.getAttribute('data-mode') : null; })()`);
  if (modeNow !== 'detail') {
    await evalIn(`(() => {
      const card = document.querySelector('.archive-card, [data-track], .archive-item, #archive-list > *');
      if (card) card.click();
      return card ? 'clicked' : 'no-card';
    })()`);
    await new Promise((r) => setTimeout(r, 1500));
    modeNow = await evalIn(`(() => { const s = document.querySelector('#stage'); return s ? s.getAttribute('data-mode') : null; })()`);
  }
  console.log('  打开详情后 mode = ' + modeNow);

  /* 等详情区就绪（工具栏出现）。
     ★ 不能只等 `.song-viz` 出现 —— 开屏阶段 DOM 里就有一份**空壳**详情
       （songDetailMarkup 在空库时也会渲染，类名里不带 viz/lyric，也没有工具栏）。
       必须等 .song-viz 拿到 viz-mode/lyric-mode 且工具栏在位。 */
  let ready = false;
  let lastState = '';
  for (let i = 0; i < 60; i++) {
    const st = await evalIn(`(() => {
      const s = document.querySelector('#stage');
      const v = document.querySelector('.song-viz');
      return JSON.stringify({
        mode: s ? s.getAttribute('data-mode') : null,
        boot: s ? s.getAttribute('data-boot') : null,
        vizCls: v ? v.className : null,
        hasBar: !!document.querySelector('#p-view-toggle'),
      });
    })()`);
    lastState = st || '';
    try {
      const o = JSON.parse(st || '{}');
      ready = o.mode === 'detail' && !!o.vizCls && /viz-mode|lyric-mode/.test(o.vizCls) && o.hasBar;
    } catch (e) { ready = false; }
    if (ready) break;
    if (i % 8 === 7) console.log('    · 等待详情区…（' + ((i + 1) * 0.5).toFixed(1) + 's）' + lastState);
    await new Promise((r) => setTimeout(r, 500));
  }
  ok('详情区已就绪（detail 模式 + 切换工具栏在位）', !!ready, ready ? '' : lastState);
  if (!ready) {
    const d = await evalIn(`(() => {
      const dc = document.querySelector('#detail-content');
      return JSON.stringify({
        lib: window.__libraryLoaded,
        detailHead: dc ? dc.textContent.slice(0, 120) : 'no-#detail-content',
        hasEmptyCls: dc ? dc.classList.contains('empty-library') : null,
        vizHtml: (document.querySelector('.song-viz') || {}).outerHTML ? document.querySelector('.song-viz').outerHTML.slice(0, 300) : null,
      });
    })()`);
    console.log('    [诊断] ' + d);
  }

  if (ready) {
    const r1 = JSON.parse((await evalIn(`(() => {
      const R = {};
      const q = (s) => document.querySelector(s);
      const viz = q('.song-viz');
      R.boxExists = !!viz;
      R.btnExists = !!q('#p-view-toggle');
      R.listExists = !!q('#p-lyric-list');
      R.canvasExists = !!q('#p-detail-spectrum');
      R.modeBefore = viz ? viz.className : '';
      const btn = q('[data-action="view-lyric"]');
      if (btn) btn.click();
      R.modeAfter = q('.song-viz') ? q('.song-viz').className : '';
      R.pressed = q('#p-view-toggle') ? q('#p-view-toggle').getAttribute('aria-pressed') : null;
      /* ★ 反白按钮必须是"歌词"那颗。
         踩过：applyDetailView() 原来只改 aria-pressed、不搬 .on 类，
         而 setDetailView() 刻意不重绘详情区 → .on 永远停在渲染那一刻的"可视化"上，
         截图看着像没切过去（页面其实已经是歌词态，只有按钮在说谎）。 */
      R.onBtnText = (q('#p-view-toggle button.on') || {}).textContent || '';
      /* ★ 歌词模式下画布必须真的 display:none。
         踩过：隐藏规则 \"(.song-viz.lyric-mode canvas)\"（特异度 0,2,1）
         赢不过 §2911 的 \"(#detail-content.song-mode .song-viz-body canvas)\"（1,2,2），
         于是画布照旧 block，频谱就透在歌词后面。 */
      const cv = q('#p-detail-spectrum');
      R.canvasDisplay = cv ? getComputedStyle(cv).display : null;
      R.lyricScrollDisplay = q('#p-lyric-scroll') ? getComputedStyle(q('#p-lyric-scroll')).display : null;
      R.rows = document.querySelectorAll('.lyric-row').length;
      R.stored = localStorage.getItem('rhine-detail-view');
      return JSON.stringify(R);
    })()`)) || '{}');
    ok('顶部工具栏有切换开关', !!r1.btnExists, JSON.stringify(r1));
    ok('默认是可视化形态', /viz-mode/.test(r1.modeBefore || ''), r1.modeBefore);
    ok('点"歌词"后切到歌词形态', /lyric-mode/.test(r1.modeAfter || ''), r1.modeAfter);
    ok('aria-pressed 变为 true（无障碍状态同步）', r1.pressed === 'true', String(r1.pressed));
    ok('★ 反白的是"歌词"那颗按钮（不只是 aria-pressed）', r1.onBtnText === '歌词',
      '反白按钮 = ' + JSON.stringify(r1.onBtnText));
    ok('★ 歌词模式下频谱画布真的隐藏了（CSS 特异度没被 id 规则压掉）',
      r1.canvasDisplay === 'none', 'canvas display = ' + r1.canvasDisplay);
    ok('★ 歌词模式下歌词列表真的可见了',
      r1.lyricScrollDisplay === 'block', 'lyric-scroll display = ' + r1.lyricScrollDisplay);
    ok('切换状态已落库（rhine-detail-view）', r1.stored === 'lyric', String(r1.stored));
    ok('歌词列表已构建出行（12 行 LRC 应全部解析）', r1.rows === 12, '行数 ' + r1.rows);
    if (r1.rows !== 12) {
      const d = await evalIn(`(async () => {
        const all = await new Promise((res, rej) => {
          const r = indexedDB.open('rhine-music', 1);
          r.onsuccess = () => {
            const q = r.result.transaction('songs', 'readonly').objectStore('songs').getAll();
            q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
          };
          r.onerror = () => rej(r.error);
        });
        return JSON.stringify({
          dbCount: all.length,
          dbSongs: all.map((s) => ({ id: s.id, hasLrc: !!s.lrc, lrcLen: (s.lrc || '').length })),
          listHTML: (document.querySelector('#p-lyric-list') || {}).outerHTML,
          lineText: (document.querySelector('#p-lyric-line') || {}).textContent,
        });
      })()`);
      console.log('    [诊断] ' + d);
    }

    if (r1.rows > 0) {
      /* 推进度 → 量高亮与滚动。
         每行间隔 12 秒（[00:00] [00:12] [00:24] [00:36] [00:48] …）：
           · 42 秒 → 落在第 4 行（索引 3，"鼓点落下来的瞬间"）—— 刻意不选首行，
             这样"高亮停在第 0 行"这类假通过会立刻暴露。
         假曲目没有真实音源，audio.currentTime 推不动，所以走诊断入口
         __rhineLyricSeek（内部就是 timeupdate 那条 stepLyrics 路径）。 */
      const hook = await evalIn(`(() => { const h = typeof window.__rhineLyricSeek === 'function'; if (h) window.__rhineLyricSeek(42); return h; })()`);
      ok('诊断入口已挂上（__rhineLyricSeek）', hook === true, String(hook));
      /* ★ 列表滚动带 0.42s 过渡、详情面板本身还有开屏动画：
         立刻量会量到动画中途的位置（踩过两次：-103px / -41px，
         而稳态其实是 +4px）。等足 1.5s 让两层动画都落定再量。 */
      await new Promise((r) => setTimeout(r, 1500));
      const r2 = JSON.parse((await evalIn(`(() => {
        const list = document.querySelector('#p-lyric-list');
        const rows = [...document.querySelectorAll('.lyric-row')];
        const on = rows.filter((r) => r.classList.contains('on'));
        const R = { rowCount: rows.length, onCount: on.length,
          onIndex: on.length ? rows.indexOf(on[0]) : -1,
          onText: on.length ? on[0].textContent : '' };
        if (on.length && list) {
          const box = list.parentElement.getBoundingClientRect();
          const rr = on[0].getBoundingClientRect();
          R.rowCenterOffset = Math.round((rr.top + rr.height / 2) - (box.top + box.height / 2));
          R.translated = getComputedStyle(list).transform;
          R.rowH = Math.round(rr.height);
          /* ★ 高亮行的字号与字重：用户要求"高亮还要放大"，
             必须比普通行大一截才看得出（16 → 22px）。 */
          const cs = getComputedStyle(on[0]);
          R.onFontSize = parseFloat(cs.fontSize);
          R.onFontWeight = cs.fontWeight;
          const other = rows.find((r) => !r.classList.contains('on'));
          R.otherFontSize = other ? parseFloat(getComputedStyle(other).fontSize) : null;
          R.onBorderLeft = cs.borderLeftWidth;
        }
        return JSON.stringify(R);
      })()`)) || '{}');
      ok('推进到 42 秒后有且只有一行高亮', r2.onCount === 1, '实际 ' + r2.onCount);
      ok('★ 高亮的是 42 秒对应的那一行（第 4 行）', r2.onIndex === 3,
        '第 ' + r2.onIndex + ' 行: ' + r2.onText);
      ok('★ 当前行被滚到容器中线附近（±40px 内）',
        typeof r2.rowCenterOffset === 'number' && Math.abs(r2.rowCenterOffset) <= 40,
        '偏移 ' + r2.rowCenterOffset + 'px（行高 ' + r2.rowH + 'px）');
      ok('★ 列表确实被平移了（不是静止的）',
        r2.translated && r2.translated !== 'none', String(r2.translated));
      ok('★ 高亮行明显比普通行大（放大 ≥ 1.3 倍）',
        typeof r2.onFontSize === 'number' && typeof r2.otherFontSize === 'number' &&
          r2.onFontSize / r2.otherFontSize >= 1.3,
        '高亮 ' + r2.onFontSize + 'px / 普通 ' + r2.otherFontSize + 'px');
      ok('★ 高亮行够大（≥ 20px）且加粗', r2.onFontSize >= 20 && Number(r2.onFontWeight) >= 600,
        r2.onFontSize + 'px / weight ' + r2.onFontWeight);

      /* 截图前把当时真实的 DOM 状态打出来：截图与断言必须指向同一个瞬间 */
      const shotState = await evalIn(`(() => {
        const viz = document.querySelector('.song-viz');
        const cs = (el) => el ? getComputedStyle(el).display : null;
        return JSON.stringify({
          vizCls: viz ? viz.className : null,
          lyricScrollDisplay: cs(document.getElementById('p-lyric-scroll')),
          canvasDisplay: cs(document.getElementById('p-detail-spectrum')),
          onBtn: (document.querySelector('#p-view-toggle button.on') || {}).textContent,
        });
      })()`);
      console.log('    [截图前状态自证] ' + shotState);
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      if (shot.result && shot.result.data) {
        fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
        ok('已产出歌词模式截图', fs.statSync(OUT).size > 20000,
          (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB');
      }
    }

    /* 切回可视化 */
    const r3 = JSON.parse((await evalIn(`(() => {
      const b = document.querySelector('[data-action="view-viz"]');
      if (b) b.click();
      const v = document.querySelector('.song-viz');
      const cv = document.querySelector('#p-detail-spectrum');
      const sc = document.querySelector('.lyric-scroll');
      return JSON.stringify({
        cls: v ? v.className : '',
        canvasShown: cv ? getComputedStyle(cv).display !== 'none' : false,
        scrollShown: sc ? getComputedStyle(sc).display !== 'none' : false,
        onBtnText: (document.querySelector('#p-view-toggle button.on') || {}).textContent || '',
        stored: localStorage.getItem('rhine-detail-view'),
      });
    })()`)) || '{}');
    ok('切回可视化后类名复位', /viz-mode/.test(r3.cls || ''), r3.cls);
    ok('可视化形态下画布可见', r3.canvasShown === true, String(r3.canvasShown));
    ok('可视化形态下歌词列表隐藏', r3.scrollShown === false, String(r3.scrollShown));
    ok('★ 切回后反白回到"可视化"那颗（两个方向都要搬 .on）', r3.onBtnText === '可视化',
      '反白按钮 = ' + JSON.stringify(r3.onBtnText));
    ok('切回后状态也落库', r3.stored === 'viz', String(r3.stored));
  }

  try { ws.close(); } catch (e) {}
  cleanup();

  console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
  process.exit(fail ? 1 : 0);
})();
