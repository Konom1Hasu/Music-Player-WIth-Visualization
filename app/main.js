const { app, BrowserWindow, ipcMain, screen, powerSaveBlocker, globalShortcut, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');

/* ================= 内嵌封面 =================
   cover.js 负责按格式精确定位封面：ID3v2(APIC/PIC，MP3 主力) · FLAC(PICTURE) · MP4/M4A(covr) ·
   OGG/Opus(注释里的 base64) · WAV/AIFF(id3 块) · APE(尾部标签) · 最后退回同目录封面图片。
   图片类型识别也统一用它那份，避免两处实现走偏。 */
const coverLib = require('./cover.js');
const sniffImageMime = coverLib.sniffImageMime;

/* ================= 数据管控（Data Control） =================
   背景：本程序能解出两类"派生数据" —— ① 从 .ncm 解出的 mp3/flac；② 从 B 站缓存里剥掉
   私有头得到的可播放 m4a。这两类数据都属于原平台的受限内容，一旦被随手复制出去，
   就成了非法传播源。因此这里做三层管控：

     ① 最小落盘：派生数据只允许存在于"本次会话专属"的临时目录，进程退出即整体销毁；
        解密结果本身只走内存（Buffer → 渲染进程），从不写到用户音乐目录。
     ② 不可导出：程序不提供任何"另存为 / 导出 / 分享"能力，没有任何 IPC 能把派生数据
        写到调用方指定的路径。渲染进程拿到的只有内存中的字节。
     ③ 可追溯：每次解密 / 提取都写一条本地审计记录（时间 + 操作 + 来源文件），
        用户可随时查看与清空。审计文件只在本机 userData 下，不上传、不外发。

   注意：覆盖写入 + 删除只是"尽力而为"的威慑（SSD 的磨损均衡使彻底擦除无法保证），
   真正的保底手段是"根本不长期落盘"——也就是第 ① 层。 */
const APP_VERSION = (function () {
  try { return require('./package.json').version || '0.0.0'; } catch (e) { return '0.0.0'; }
})();

const SESSION_ID = crypto.randomBytes(6).toString('hex');
const SESSION_TMP = path.join(os.tmpdir(), 'mp-session-' + SESSION_ID);
const SESSION_AUDIO_DIR = path.join(SESSION_TMP, 'audio');

let sessionTmpReady = false;
function ensureSessionTmp() {
  if (!sessionTmpReady) {
    try { fs.mkdirSync(SESSION_AUDIO_DIR, { recursive: true }); } catch (e) { /* ignore */ }
    markHidden(SESSION_TMP);
    sessionTmpReady = true;
  }
  return SESSION_TMP;
}
/* 给临时目录打上隐藏属性：阻止"顺手翻到并拷走"。attrib 不存在时静默跳过。 */
function markHidden(p) {
  try {
    const c = spawn('attrib', ['+h', p], { stdio: 'ignore', windowsHide: true });
    c.on('error', function () { /* ignore */ });
  } catch (e) { /* ignore */ }
}

/* 覆盖写零后再删除。budget 是本次会话允许覆盖的总字节数，超出部分只删不擦，
   避免退出时因为几十个大文件而卡住。 */
const WIPE_BUDGET = 256 * 1024 * 1024;
let wipedBytes = 0;
function wipeFile(p) {
  let st = null;
  try { st = fs.statSync(p); } catch (e) { return; }

  /* ★★ 硬链接保护（真实事故的修复）★★
     链接数 > 1 表示这个目录项和别处共享同一个 inode —— 例如 bili.js 曾经用
     fs.linkSync 把用户的缓存文件"链"进来当可播放副本。此时用 'r+' 整天覆写 0
     会**透过硬链接把源文件也写坏**，而随后的 unlink 只摘掉自己这个目录项，
     源文件还在、内容却已经全变成 0。实测后果：用户的 B 站缓存音频原地变成全零，
     再播放就是 MediaError 4（"格式不支持或文件头异常"）。
     所以这里只摘目录项，绝不覆写别人也指着的 inode。 */
  if (st.isFile() && st.nlink > 1) {
    try { fs.unlinkSync(p); } catch (e) { /* ignore */ }
    return;
  }

  if (st.isFile() && st.size > 0 && wipedBytes < WIPE_BUDGET) {
    try {
      const fd = fs.openSync(p, 'r+');
      const chunk = Buffer.alloc(Math.min(1 << 20, st.size));
      let left = st.size;
      while (left > 0) {
        const n = Math.min(chunk.length, left);
        fs.writeSync(fd, chunk, 0, n);
        left -= n;
      }
      try { fs.fsyncSync(fd); } catch (e) { /* ignore */ }
      fs.closeSync(fd);
      wipedBytes += st.size;
    } catch (e) { /* 打开失败就只删 */ }
  }
  try { fs.unlinkSync(p); } catch (e) { /* ignore */ }
}
function wipeDir(dir) {
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of list) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) wipeDir(p);
    else wipeFile(p);
  }
  try { fs.rmdirSync(dir); } catch (e) { /* ignore */ }
}
/* 启动时清掉上一次异常退出（崩溃/强杀）留下的会话目录 */
function sweepStaleSessions() {
  try {
    const base = os.tmpdir();
    for (const name of fs.readdirSync(base)) {
      if (name.indexOf('mp-session-') !== 0) continue;
      const p = path.join(base, name);
      if (p === SESSION_TMP) continue;
      wipeDir(p);
    }
  } catch (e) { /* ignore */ }
}
/* 升级清理：1.0.x 把 B 站可播放副本长期写在 <userData>\bili_audio，
   那些是派生数据、不该长期驻留。1.1.0 起副本改到会话临时目录，
   这里把历史遗留目录一次性擦除（目录不存在时几乎零开销）。
   注意：只删我们生成的副本，不碰用户的 B 站缓存原文件。 */
function purgeLegacyAudioCache() {
  try {
    const legacy = path.join(app.getPath('userData'), 'bili_audio');
    if (fs.existsSync(legacy)) wipeDir(legacy);
  } catch (e) { /* ignore */ }
}
function shutdownSessionTmp() {
  try { wipeDir(SESSION_TMP); } catch (e) { /* ignore */ }
}

/* ---------- 本地审计日志（只在本机 userData，可查看可清空） ---------- */
const AUDIT_MAX = 500;
function auditFile() { return path.join(app.getPath('userData'), 'audit.log'); }
function audit(event, info) {
  try {
    const rec = {
      t: new Date().toISOString(),
      v: APP_VERSION,
      sid: SESSION_ID,
      event: event
    };
    if (info) {
      if (info.src) rec.src = String(info.src);
      if (info.bytes) rec.bytes = Number(info.bytes) || 0;
      if (info.ext) rec.ext = String(info.ext);
      if (info.result) rec.result = String(info.result);
    }
    const f = auditFile();
    let lines = [];
    try { lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch (e) { lines = []; }
    lines.push(JSON.stringify(rec));
    if (lines.length > AUDIT_MAX) lines = lines.slice(lines.length - AUDIT_MAX);
    fs.writeFileSync(f, lines.join('\n') + '\n', 'utf8');
  } catch (e) { /* 审计失败不影响主流程 */ }
}
function auditCount() {
  try { return fs.readFileSync(auditFile(), 'utf8').split('\n').filter(Boolean).length; }
  catch (e) { return 0; }
}

/* ---------- NCM 专用：封面在该格式里是明文挂在头部的 ----------
   NCM 布局： CTENFDAM(8) 00 00 keyLen(4) key | metaLen(4) meta | CRC(4) 间隔(5) imgSize(4) img | 加密音频
   标准布局读不出来时，退回"按图片魔术字节扫描 + 按结束标记截断"。 */
function ncmCover(buf) {
  if (!buf || buf.length < 32) return null;
  if (buf.toString('latin1', 0, 8) !== 'CTENFDAM') return null;
  // ① 标准布局
  try {
    const keyLen = buf.readUInt32LE(10);
    let pos = 14 + keyLen;
    const metaLen = buf.readUInt32LE(pos);
    pos += 4 + metaLen + 4 + 5;
    const imgSize = buf.readUInt32LE(pos);
    pos += 4;
    if (imgSize > 512 && imgSize < 20 * 1024 * 1024 && pos + imgSize <= buf.length) {
      const img = buf.subarray(pos, pos + imgSize);
      const mime = sniffImageMime(img);
      if (mime) return { bytes: img, mime: mime };
    }
  } catch (e) { /* 落到扫描兜底 */ }
  // ② 兜底：扫描图片起始魔术字节，再按 JPEG EOI(FFD9) / PNG IEND 截断
  const lim = Math.min(buf.length, 4 * 1024 * 1024);
  for (let i = 0; i < lim - 12; i++) {
    if (buf[i] === 0xFF && buf[i + 1] === 0xD8 && buf[i + 2] === 0xFF) {
      const end = buf.indexOf(Buffer.from([0xFF, 0xD9]), i + 3);
      if (end > i + 512) return { bytes: buf.subarray(i, end + 2), mime: 'image/jpeg' };
    }
    if (buf[i] === 0x89 && buf[i + 1] === 0x50 && buf[i + 2] === 0x4E && buf[i + 3] === 0x47) {
      const end = buf.indexOf(Buffer.from('IEND', 'latin1'), i + 8);
      if (end > i + 512) return { bytes: buf.subarray(i, end + 8), mime: 'image/png' };
    }
  }
  return null;
}
/* NCM 那一份解析（也用于旧的 ncm-cover 通道，保持兼容） */
function ncmCoverReply(arg) {
  try {
    let buf = null;
    if (arg && arg.path) {
      if (!fs.existsSync(arg.path)) return { error: '文件不存在：' + arg.path };
      buf = fs.readFileSync(arg.path);
    } else if (arg && arg.bytes) {
      buf = Buffer.from(arg.bytes);
    }
    if (!buf) return { error: '没有拿到 NCM 数据' };
    const c = ncmCover(buf);
    if (!c) return { error: '这个 NCM 里没有内嵌封面' };
    return { ok: true, dataUrl: 'data:' + c.mime + ';base64,' + c.bytes.toString('base64'), size: c.bytes.length, mime: c.mime, source: 'ncm' };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}
/* arg: { path }（主进程自己读文件）或 { bytes, name }（渲染层读的用户自选文件） */
ipcMain.handle('read-cover', (_e, arg) => {
  try {
    const name = (arg && arg.name) || (arg && arg.path) || '';
    if (/\.ncm$/i.test(String(name))) return ncmCoverReply(arg);
    const c = coverLib.extractCover({
      path: arg && arg.path, bytes: arg && arg.bytes, name: String(name),
      headBytes: 4 * 1024 * 1024, tailBytes: 2 * 1024 * 1024,
    });
    if (!c || !c.bytes) return { error: '这个文件里没有内嵌封面，也没找到同目录封面图片' };
    return {
      ok: true,
      dataUrl: 'data:' + c.mime + ';base64,' + c.bytes.toString('base64'),
      size: c.bytes.length, mime: c.mime, source: c.source,
    };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});
/* 旧通道：只认 NCM（老的渲染层仍会调用，保留以免兼容性回退） */
ipcMain.handle('ncm-cover', (_e, arg) => ncmCoverReply(arg));

/* ================= 主进程全局兜底 =================
   任何一处未捕获异常原本都会让整个播放器直接消失（实例：小窗缩放时 setSize 收到小数 →
   "TypeError: Error processing argument at index 1, conversion failure" → 窗口全没了，
   用户只能看到一个英文报错框）。这里把异常写进日志并保持运行 ——
   局部功能（某次缩放）出错不该赔上整个程序。日志：userData/main-error.log */
function logMainError(tag, err) {
  try {
    const p = path.join(app.getPath('userData'), 'main-error.log');
    fs.appendFileSync(p, `[${new Date().toISOString()}] (${tag}) ${(err && err.stack) || err}\n`);
  } catch (e) { /* ignore */ }
  console.error('[主进程 ' + tag + ']', err);
}
process.on('uncaughtException', (err) => logMainError('异常', err));
process.on('unhandledRejection', (reason) => logMainError('未处理的 Promise 拒绝', reason));

// 强制 GPU 硬件加速：避免单独启动时 Chromium 退回软件渲染
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// 不设 enable-gpu-rasterization —— 让 2D 画布走 CPU 光栅（Skia）再上传合成：
// 单独运行时 GPU 被系统降频节流，主线程不会被 GPU 光栅回压阻塞，循环保持高帧率。
// 不设 force-discrete-gpu —— 用直连显示器的核显（Intel UHD），避免跨显卡回拷。
// 不设 disable-direct-composition —— blt 呈现会把多窗口合成串行化到主进程：
// 开小窗后主窗口 rAF 减半的元凶。保留 flip-model（DComp），它对多窗口是并行呈现。
app.commandLine.appendSwitch('disable-features',
  'CalculateNativeWinOcclusion,BatterySaverMode,IntensiveWakeUpThrottling,ThrottleDisplayFrequency,ThrottleFrameRate');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
// 关键：启用 Chromium 的硬件媒体键处理 + 媒体会话服务。
// Electron 默认关闭该特性（以免与 globalShortcut 抢键），结果耳机/键盘媒体键
// 根本不会送到页面的 Media Session → 单击/双击耳机毫无反应。开启后媒体键才能生效。
app.commandLine.appendSwitch('enable-features', 'HardwareMediaKeyHandling,MediaSessionService');
// 注意：不设 disable-frame-rate-limit / disable-gpu-vsync —— 会把呈现改坏（无节流撕裂）。

// 读取渲染模式设置（软件渲染需在 ready 前禁用硬件加速）
let userSettings = {};
try {
  const sp = path.join(app.getPath('userData'), 'settings.json');
  if (fs.existsSync(sp)) userSettings = JSON.parse(fs.readFileSync(sp, 'utf8')) || {};
} catch (e) { /* ignore */ }
if (userSettings.renderMode === 'software') app.disableHardwareAcceleration();

let mainWin = null;
let miniWin = null;
let miniResizeStart = null; // 缩放时 {sx, sy, w, h, scale}
let miniOpacity = 1;       // 小窗透明度（会话内记忆）
let miniKeepTopTimer = null; // 周期重申置顶的定时器

/* ================= 内嵌 UI 静态服务 =================
   app-rhine（Vite 构建的 RhineLabUI 三维终端）用了 ES module + 绝对路径 /assets/...，
   file:// 下两者都失效，所以必须在 localhost 起一个静态服务再 loadURL。
   只监听 127.0.0.1 的随机端口，不对外。 */
const UI_DIR = path.join(__dirname, 'ui');
let uiServer = null;
let uiServerUrl = null;
/* 固定端口：保证 http://127.0.0.1:<port> 这个"源"跨启动稳定，
   否则 IndexedDB 里的曲库 / 收藏 / 播放进度每次重启都会读不到。 */
const UI_PORT = Number(process.env.RHINE_UI_PORT) || 41739;
function startUiServer() {
  return new Promise((resolve, reject) => {
    if (uiServerUrl) return resolve(uiServerUrl);
    if (!fs.existsSync(path.join(UI_DIR, 'index.html'))) {
      return reject(new Error('内嵌 UI 不存在：' + UI_DIR));
    }
    const MIME = {
      '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
      '.glb': 'model/gltf-binary', '.woff2': 'font/woff2', '.ogg': 'audio/ogg',
      '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8',
      '.pdf': 'application/pdf'
    };
    uiServer = http.createServer((req, res) => {
      try {
        let p = decodeURIComponent(String(req.url || '/').split('?')[0].split('#')[0]);
        if (p === '/') p = '/index.html';
        const file = path.normalize(path.join(UI_DIR, p));
        if (file !== UI_DIR && !file.startsWith(UI_DIR + path.sep)) {
          res.writeHead(403); res.end('forbidden'); return;
        }
        fs.readFile(file, (err, data) => {
          if (err) { res.writeHead(404); res.end('not found'); return; }
          res.writeHead(200, {
            'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-cache'
          });
          res.end(data);
        });
      } catch (e) { res.writeHead(500); res.end(); }
    });
    uiServer.on('error', reject);
    /* ★ 端口必须固定。界面跑在 http://127.0.0.1:<port>，而 IndexedDB 是按"源"隔离的
       （scheme + host + port 三者一起算）—— 用 listen(0) 每次启动随机端口，
       等于每次都是全新的存储域：曲库、收藏、播放进度全部读不回来。
       端口被占用时才退回随机端口（此时会记一条日志说明本次存储域是新的）。 */
    let settled = false;
    const tryListen = (port, allowFallback) => {
      uiServer.once('error', (err) => {
        if (settled) return;
        if (allowFallback && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
          logMainError('UI 服务', new Error(
            '端口 ' + port + ' 不可用，改用随机端口：本次曲库存储域与上次不同'));
          tryListen(0, false);
          return;
        }
        settled = true;
        reject(err);
      });
      uiServer.listen(port, '127.0.0.1', () => {
        if (settled) return;
        settled = true;
        uiServerUrl = 'http://127.0.0.1:' + uiServer.address().port + '/';
        resolve(uiServerUrl);
      });
    };
    tryListen(UI_PORT, true);
  });
}

async function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1380,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    title: 'RHINE LAB · ANALYSIS OS',
    backgroundColor: '#e8e5e1',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
      backgroundThrottling: false // 最小化/隐藏时 rAF 仍满帧 → 小窗可视化不暂停
    }
  });
  /* 主界面 = RhineLabUI 三维档案终端（Vite 构建，走 localhost 静态服务）。
     若内嵌 UI 缺失，退回 terminal.html（单面板 3D），再退 index.html。 */
  try {
    const url = await startUiServer();
    mainWin.loadURL(url);
  } catch (e) {
    logMainError('UI 服务', e);
    if (fs.existsSync(path.join(__dirname, 'terminal.html'))) {
      mainWin.loadFile(path.join(__dirname, 'terminal.html'));
    } else {
      mainWin.loadFile(path.join(__dirname, 'index.html'));
    }
  }
  // 不设 setFrameRate：可视化循环已由页面内定时器自驱动（不依赖 rAF），
  // 显式 setFrameRate 会在双窗口时干扰合成器的 BeginFrame 调度
  // 主窗口最小化/隐藏时把状态告诉页面：可视化循环降频，把 CPU/GPU 让给别的应用。
  // 注意 main.js 里关掉了 CalculateNativeWinOcclusion，所以拿不到"被遮挡"事件，
  // 只能靠 minimize/hide（这已经覆盖了最常见的情况）。
  const pushWinState = () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    let minimized = false;
    try { minimized = mainWin.isMinimized() || !mainWin.isVisible(); } catch (e) { /* ignore */ }
    try { mainWin.webContents.send('win-state', { minimized: minimized }); } catch (e) { /* ignore */ }
  };
  mainWin.on('minimize', pushWinState);
  mainWin.on('restore', pushWinState);
  mainWin.on('hide', pushWinState);
  mainWin.on('show', pushWinState);
  // 切回窗口时补注册：游戏退出/切桌面后往往立刻就能拿回媒体键（幂等，不会误报）
  mainWin.on('focus', () => { try { registerMediaHotkeys(); } catch (e) { /* ignore */ } });
  mainWin.on('closed', () => { mainWin = null; });
}

function createMiniWindow() {
  if (miniWin && !miniWin.isDestroyed()) { miniWin.show(); return; }
  miniWin = new BrowserWindow({
    width: 330,
    height: 356,
    // 最小值原来写死 270×280（被内容撑出来的），而默认是 330×356 →
    // 只能缩 60×76 px，用户感觉"只能放大不能缩小"。现在内容会随窗口自适应
    // （mini.html 里按宽高分档隐藏封面/歌词/透明度条/进度条），所以最小值可以放得很低。
    minWidth: 150,
    minHeight: 96,
    maxWidth: 720,
    maxHeight: 900,
    frame: false,
    transparent: false, // 透明窗口在 Windows 上强制昂贵合成路径，拖累主窗口
    backgroundColor: '#141828',
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false
    }
  });
  miniWin.loadFile(path.join(__dirname, 'mini.html'));
  // 置顶用最高 'screen-saver' 层级：盖过全屏/无边框游戏窗口，游戏里也看得见
  miniWin.setAlwaysOnTop(true, 'screen-saver');
  // 点击穿透：小窗默认不吃鼠标事件（forward 让页面仍能收到 mousemove），
  // 只有光标悬停到按钮/进度条/拖动栏等控件上时，页面才通过 mini-set-ignore 临时恢复可点。
  // 这样打游戏时鼠标划过小窗不会误点到它。
  miniIgnoreState = null; miniRegions = [];
  try { miniWin.setIgnoreMouseEvents(true, { forward: true }); miniIgnoreState = true; } catch (e) { /* ignore */ }
  startMiniPoll();   // 光标轮询：穿透状态自愈，避免'快速移动后立刻按下拖不动'
  if (miniOpacity < 1) miniWin.setOpacity(miniOpacity);
  // 周期重申置顶：无边框全屏游戏运行时会重新抢占 Z 序
  if (miniKeepTopTimer) clearInterval(miniKeepTopTimer);
  miniKeepTopTimer = setInterval(() => {
    if (!miniWin || miniWin.isDestroyed()) { clearInterval(miniKeepTopTimer); miniKeepTopTimer = null; return; }
    try { miniWin.setAlwaysOnTop(true, 'screen-saver'); miniWin.moveTop(); } catch (e) { /* ignore */ }
  }, 800);
  // 拖动结束后自动吸附屏幕边缘
  let snapTimer = null;
  miniWin.on('moved', () => {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => snapMiniToEdge(), 180);
  });  miniWin.on('closed', () => {
    if (miniKeepTopTimer) { clearInterval(miniKeepTopTimer); miniKeepTopTimer = null; }
    miniWin = null;
  });
}
function snapMiniToEdge() {
  if (!miniWin || miniWin.isDestroyed()) return;
  const TH = 48;
  const disp = screen.getDisplayMatching(miniWin.getBounds());
  const wa = disp.workArea;
  const b = miniWin.getBounds();
  let x = b.x, y = b.y;
  if (Math.abs(b.x - wa.x) < TH) x = wa.x;
  else if (Math.abs((wa.x + wa.width) - (b.x + b.width)) < TH) x = wa.x + wa.width - b.width;
  if (Math.abs(b.y - wa.y) < TH) y = wa.y;
  else if (Math.abs((wa.y + wa.height) - (b.y + b.height)) < TH) y = wa.y + wa.height - b.height;
  // setPosition 同样只接受整数（分数缩放的显示器上 workArea 可能是小数），必须取整 + 兜异常
  x = Math.round(toNum(x, b.x)); y = Math.round(toNum(y, b.y));
  if (x !== b.x || y !== b.y) {
    try { miniWin.setPosition(x, y); } catch (e) { /* ignore */ }
  }
}

/* 单实例锁：避免重复启动导致双实例同时播放/渲染 → 卡顿 */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
  });

  app.whenReady().then(() => {
    // 数据管控：清掉上次崩溃/强杀残留的会话临时目录（派生数据不留宿）
    sweepStaleSessions();
    // 数据管控：擦除 1.0.x 遗留在 userData 里的长期副本（升级清理）
    purgeLegacyAudioCache();
    /* --recover-library：只跑曲库恢复，不开主界面 */
    if (RECOVER_MODE || INGEST_MODE) {
      const job = RECOVER_MODE ? runRecovery() : runIngest();
      job
        .then((stats) => {
          const mb = (stats.bytes / 1048576).toFixed(1);
          const detail = INGEST_MODE
            ? [
              '从交接区读了 ' + stats.total + ' 条记录，其中音频 ' + stats.files + ' 个（' + mb + ' MB）',
              '写入新版曲库：新增 ' + stats.added + ' 首，跳过重复 ' + stats.skipped + ' 首',
              '交接区已清理。',
              '',
              '重新打开音乐播放器即可看到这些曲目。',
            ].join('\n')
            : [
              '旧源：' + (stats.origins.length ? stats.origins.join('、') : '（没有找到可恢复的旧源）'),
              '读到记录 ' + stats.total + ' 条，其中音频 ' + stats.files + ' 个（' + mb + ' MB）',
              '写入当前 profile 曲库：新增 ' + stats.added + ' 首，跳过与现有曲目重复的 ' + stats.skipped + ' 首',
              '',
              '跨 profile 的交接区：' + RECOVER_BUNDLE,
              '在"当前 profile"里再跑一次 --recover-ingest 即可把它吃进当前曲库。',
              '旧数据没有被修改，也没有往音乐目录写文件。',
            ].join('\n');
          dialog.showMessageBoxSync({ type: 'info', title: '曲库恢复完成', message: '曲库恢复完成', detail, buttons: ['好'] });
        })
        .catch((e) => {
          dialog.showMessageBoxSync({ type: 'error', title: '曲库恢复失败', message: '曲库恢复失败', detail: String((e && e.message) || e), buttons: ['好'] });
        })
        .finally(() => app.quit());
      return;
    }
    // 阻止显示睡眠 + 应用挂起：保持系统与显卡持续活跃
    powerSaveBlocker.start('prevent-display-sleep');
    powerSaveBlocker.start('prevent-app-suspension');
    createMainWindow();
    registerMediaHotkeys(); // 全局媒体快捷键（独占全屏游戏里也能用）
    setTimeout(notifyHotkeyState, 1500);   // 媒体键注册失败就提示备用键（不再静默失效）
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
  });
  app.on('window-all-closed', () => { app.quit(); });

  /* 退出前销毁本次会话的派生数据。
     覆盖擦除是同步 I/O，所以先拦住退出，擦完再真正退出；并加 4 秒兜底，
     避免任何异常导致程序关不掉。quitCleanupDone 防止 app.quit() 递归回到这里。 */
  let quitCleanupDone = false;
  app.on('will-quit', (e) => {
    try { globalShortcut.unregisterAll(); } catch (err) { /* ignore */ }
    if (quitCleanupDone) return;
    e.preventDefault();
    const hardExit = setTimeout(() => {
      quitCleanupDone = true;
      try { app.quit(); } catch (err) { app.exit(0); }
    }, 4000);
    setTimeout(() => {
      try { shutdownSessionTmp(); } catch (err) { /* ignore */ }
      clearTimeout(hardExit);
      quitCleanupDone = true;
      try { app.quit(); } catch (err) { app.exit(0); }
    }, 0);
  });
}

/* 媒体键动作：统一转给渲染进程处理（渲染侧带防抖，避免两条通路各触发一次） */
function mediaAction(action) {
  if (!mainWin || mainWin.isDestroyed()) return;
  mainWin.webContents.send('media-key', action);
}

/* ================= 全局快捷键 =================
   媒体键注册**可能失败**：大型游戏（实测鸣潮、异环这类 UE 游戏）会自己占用
   MediaPlayPause 等键，RegisterHotKey 拿不到，而 `globalShortcut.register` 失败时
   是**静默返回 false** 的 —— 旧代码完全没检查返回值，所以"耳机键突然没用了"
   在程序里毫无痕迹。现在：记录每个键的注册结果、失败就周期性重试（游戏退出/切窗口
   后可能就能拿回来）、并把状态报给界面（首次失败时提示可用的备用键）。 */
const hotkeyState = { media: false, fallback: false, detail: {} };
let hotkeyRetryTimer = null;
function regHotkey(key, fn) {
  let ok = false;
  try { ok = globalShortcut.register(key, fn); } catch (e) { ok = false; }
  hotkeyState.detail[key] = ok;
  return ok;
}
function registerMediaHotkeys() {
  const d = hotkeyState.detail || {};
  /* ★ 只注册"还没成功"的键。之前每次重试都把全部键重注册一遍，而 Electron 对
     【已被本程序占用】的键会返回 false（GlobalShortcutListener 里有 IsRegistered 检查）——
     于是重试反而把正常状态改写成"失败"：界面误报"被占用"、重试也永不停止。 */
  const tryReg = (key, fn) => (d[key] === true ? true : regHotkey(key, fn));
  // 耳机/键盘媒体键：单击=播放暂停、双击=下一首、三击=上一首（系统映射为媒体键）
  const m1 = tryReg('MediaPlayPause', () => mediaAction('play'));
  const m2 = tryReg('MediaNextTrack', () => mediaAction('next'));
  const m3 = tryReg('MediaPreviousTrack', () => mediaAction('prev'));
  // 部分耳机/驱动发的是单独的"播放 / 暂停 / 停止"媒体键，而不是 MediaPlayPause，一并接住
  const m4 = tryReg('MediaStop', () => mediaAction('pause'));
  const m5 = tryReg('MediaPlay', () => mediaAction('play'));
  const m6 = tryReg('MediaPause', () => mediaAction('pause'));
  hotkeyState.media = m1 || m2 || m3 || m4 || m5 || m6;
  // 备用组合键：媒体键被游戏占走时用这些（Ctrl+Alt+空格 比字母键更不容易撞车）
  const f1 = tryReg('CommandOrControl+Alt+P', () => mediaAction('play'));
  const f2 = tryReg('CommandOrControl+Alt+N', () => mediaAction('next'));
  const f3 = tryReg('CommandOrControl+Alt+B', () => mediaAction('prev'));
  const f4 = tryReg('CommandOrControl+Alt+Space', () => mediaAction('play'));
  hotkeyState.fallback = f1 || f2 || f3 || f4;
  // 小窗控制键（游戏里鼠标拖不动时靠这些）——见下面 nudgeMini/scaleMini
  regHotkey('CommandOrControl+Alt+Left', () => nudgeMini(-MINI_STEP, 0));
  regHotkey('CommandOrControl+Alt+Right', () => nudgeMini(MINI_STEP, 0));
  regHotkey('CommandOrControl+Alt+Up', () => nudgeMini(0, -MINI_STEP));
  regHotkey('CommandOrControl+Alt+Down', () => nudgeMini(0, MINI_STEP));
  regHotkey('CommandOrControl+Alt+0', () => scaleMini(20, 20));
  regHotkey('CommandOrControl+Alt+9', () => scaleMini(-20, -20));
  regHotkey('CommandOrControl+Alt+L', () => setMiniLock(!miniLocked));
  // 失败的重试：游戏退出、切到桌面后往往就能拿回来
  if (!hotkeyRetryTimer) {
    hotkeyRetryTimer = setInterval(() => {
      if (hotkeyState.media && hotkeyState.fallback) { clearInterval(hotkeyRetryTimer); hotkeyRetryTimer = null; return; }
      registerMediaHotkeys();
    }, 6000);
  }
  return hotkeyState;
}
/* 把注册状态报给界面（只报一次，避免反复弹提示） */
let hotkeyNoticeSent = false;
function notifyHotkeyState() {
  if (hotkeyNoticeSent) return;
  if (!mainWin || mainWin.isDestroyed()) return;
  if (hotkeyState.media && hotkeyState.fallback) return;
  hotkeyNoticeSent = true;
  try { mainWin.webContents.send('hotkey-status', JSON.parse(JSON.stringify(hotkeyState))); } catch (e) { /* ignore */ }
}

/* ================= 小窗：位移 / 缩放 / 穿透锁定 =================
   设计原因：
     · 拖动曾经"很奇怪"：缩放用的是渲染层 e.screenX 再除显示器缩放，但 Chromium 的
       screenX 本来就是 DIP（已含缩放）→ 再除一次，125% 缩放下窗口增长比光标慢 20%。
       现在位移/缩放全部改用主进程的 screen.getCursorScreenPoint()，两边同一坐标系，
       彻底不涉及 scaleFactor。
     · 点击穿透原本靠"页面 mousemove → IPC → 主进程"，快速移动后立刻按下时状态还没切过来
       → "有时候拖不动"。现在主进程按 50ms 轮询光标位置（页面只回报可交互矩形），
       即使某个 mousemove 丢了也会在 50ms 内自愈。
     · 独占全屏/原始输入的游戏里，overlay 根本收不到鼠标事件（系统层面限制）。
       所以加了全局快捷键位移/缩放，以及"穿透锁定"开关。 */
function nudgeMini(dx, dy) {
  if (!miniWin || miniWin.isDestroyed()) return;
  try {
    const b = miniWin.getBounds();
    miniWin.setPosition(Math.round(toNum(b.x) + dx), Math.round(toNum(b.y) + dy));
  } catch (e) { /* ignore */ }
}
function scaleMini(dw, dh) {
  if (!miniWin || miniWin.isDestroyed()) return;
  try {
    const s = miniWin.getSize();
    const w = Math.round(Math.max(MINI_MIN_W, Math.min(MINI_MAX_W, toNum(s[0], 330) + dw)));
    const h = Math.round(Math.max(MINI_MIN_H, Math.min(MINI_MAX_H, toNum(s[1], 356) + dh)));
    miniWin.setSize(w, h);
  } catch (e) { /* ignore */ }
}
function setMiniLock(v) {
  miniLocked = !!v;
  if (miniWin && !miniWin.isDestroyed()) {
    try { miniWin.webContents.send('mini-lock-state', miniLocked); } catch (e) { /* ignore */ }
  }
  if (mainWin && !mainWin.isDestroyed()) {
    try { mainWin.webContents.send('mini-lock-changed', miniLocked); } catch (e) { /* ignore */ }
  }
  if (miniLocked) setMiniIgnore(true);
}

/* ---------------- IPC：小窗与主窗口通信 ---------------- */
ipcMain.on('mini-open', () => createMiniWindow());
ipcMain.on('mini-close', () => { if (miniWin && !miniWin.isDestroyed()) { miniWin.destroy(); miniWin = null; } });
/* 小窗页面回报"可交互矩形"（相对视口），主进程据此判断光标是否该让窗口吃鼠标事件 */
ipcMain.on('mini-set-regions', (_e, regions) => {
  if (!Array.isArray(regions)) return;
  miniRegions = regions.slice(0, 40).map((r) => ({
    x: toNum(r && r.x), y: toNum(r && r.y), w: toNum(r && r.w), h: toNum(r && r.h)
  })).filter((r) => r.w > 0 && r.h > 0);
});
/* 低延迟通路（页面 mousemove 直接切换，比 50ms 轮询更快）；锁定穿透时忽略 */
ipcMain.on('mini-set-ignore', (_e, v) => {
  if (miniLocked) return;
  setMiniIgnore(!!v);
});
ipcMain.on('mini-lock', (_e, v) => setMiniLock(v === undefined ? !miniLocked : !!v));
ipcMain.handle('get-hotkey-status', () => hotkeyState);

/* 小窗数据转发。拆成两条通道，原因：原来是一条 **50 次/秒的大包**，
   每次都带上封面 data URL（几百 KB）+ Array.from(bars) 新建的普通数组 ——
   等于每秒几十 MB 的 IPC 流量，小窗那边还会每帧重设一次 <img src> 并读 scrollWidth
   （强制同步布局）。开着别的应用时，这些开销会直接表现为整机卡顿。
   ① mini-meta：标题/歌手/专辑/封面/主题色 —— 只在换歌、换主题、换封面时发一次
   ② mini-bars：96 根柱（Float32Array 整体拷贝，比普通数组便宜得多）+ 时间/播放状态/歌词 —— 每帧发
   主进程只做转发，不解析内容。 */
ipcMain.on('mini-meta', (_e, data) => {
  if (miniWin && !miniWin.isDestroyed()) miniWin.webContents.send('mini-meta', data);
});
ipcMain.on('mini-bars', (_e, data) => {
  if (miniWin && !miniWin.isDestroyed()) miniWin.webContents.send('mini-bars', data);
});
/* 兼容旧通道名 */
ipcMain.on('mini-state', (_e, data) => {
  if (miniWin && !miniWin.isDestroyed()) miniWin.webContents.send('mini-meta', data);
});
/* 渲染模式（软件模式下次启动生效） */
ipcMain.on('set-render-mode', (_e, mode) => {
  userSettings.renderMode = mode === 'software' ? 'software' : 'gpu';
  try { fs.writeFileSync(path.join(app.getPath('userData'), 'settings.json'), JSON.stringify(userSettings)); } catch (e) { /* ignore */ }
});
/* GPU 渲染状态自检 + 当前显卡名 */
ipcMain.handle('get-gpu-status', () => {
  try {
    let device = '';
    try {
      const i = app.getGPUInfo('basic');
      const a = (i && i.auxAttributes) || {};
      device = a.gl_renderer || a.gl_vendor || '';
    } catch (e) { /* ignore */ }
    return { features: app.getGPUFeatureStatus(), device };
  } catch (e) { return { features: {}, device: '' }; }
});
/* 显示器信息（刷新率） */
ipcMain.handle('get-display-info', () => {
  try {
    const w = mainWin && !mainWin.isDestroyed() ? mainWin : BrowserWindow.getAllWindows()[0];
    const d = w ? screen.getDisplayMatching(w.getBounds()) : screen.getPrimaryDisplay();
    return { refreshRate: d.refreshRate || 60, scaleFactor: d.scaleFactor || 1, internal: !!d.internal };
  } catch (e) { return { refreshRate: 60, scaleFactor: 1, internal: false }; }
});
/* 小窗透明度 */
ipcMain.on('mini-opacity', (_e, v) => {
  miniOpacity = Math.max(0.3, Math.min(1, toNum(v, 1)));   // NaN 会让 setOpacity 抛同样的转换错误
  if (miniWin && !miniWin.isDestroyed()) miniWin.setOpacity(miniOpacity);
});
/* 小窗尺寸上下限：构造 BrowserWindow 与拖拽 clamp 必须用同一组常量，
   否则会出现"拖到某处卡住不动"的错觉。内容自适应在 mini.html 里按宽高分档处理。 */
const MINI_MIN_W = 150, MINI_MIN_H = 96, MINI_MAX_W = 720, MINI_MAX_H = 900;
const MINI_STEP = 14;              // 全局快捷键每次移动的像素
let miniRegions = [];              // 小窗页面回报的可交互矩形（视口坐标）
let miniLocked = false;            // 穿透锁定：锁定后整窗穿透，只能用快捷键移动
let miniIgnoreState = null;        // 当前 setIgnoreMouseEvents 状态（避免重复调用）
let miniPollTimer = null;

function setMiniIgnore(v) {
  if (!miniWin || miniWin.isDestroyed()) return;
  if (miniIgnoreState === v) return;
  miniIgnoreState = v;
  try { miniWin.setIgnoreMouseEvents(v, { forward: true }); } catch (e) { /* ignore */ }
}
/* 光标是否落在"可交互矩形"内。全部用主进程坐标（光标点 - 窗口原点），不涉及缩放比 */
function miniCursorHit() {
  if (!miniWin || miniWin.isDestroyed()) return false;
  let pt, b;
  try { pt = screen.getCursorScreenPoint(); b = miniWin.getBounds(); } catch (e) { return false; }
  const x = toNum(pt.x) - toNum(b.x), y = toNum(pt.y) - toNum(b.y);
  if (x < 0 || y < 0 || x > toNum(b.width) || y > toNum(b.height)) return false;
  for (const r of miniRegions) {
    if (x >= r.x - 2 && x <= r.x + r.w + 2 && y >= r.y - 2 && y <= r.y + r.h + 2) return true;
  }
  return false;
}
function startMiniPoll() {
  if (miniPollTimer) return;
  miniPollTimer = setInterval(() => {
    if (!miniWin || miniWin.isDestroyed()) { clearInterval(miniPollTimer); miniPollTimer = null; return; }
    if (miniLocked) { setMiniIgnore(true); return; }
    setMiniIgnore(!miniCursorHit());
  }, 50);
}

/* 小窗缩放（右下角手柄）
   ── 曾经崩过一次主进程：`setSize(nw, nh)` 的 nw/nh 是浮点数，
   Electron 原生层要求整数（宽度、高度都会走 int 转换），一旦传入小数就抛
   "TypeError: Error processing argument at index 1, conversion failure"，
   而且是**主进程未捕获异常**（整个窗口直接挂掉）。所以这里必须：
     ① 所有参与运算的值先 Number() 化并检查 isFinite；
     ② 最终 setSize 传 Math.round 后的整数；
     ③ scale 兜底成 1（避免除零得到 Infinity，同样会触发 int 转换失败）。 */
function toNum(v, dflt) {
  const n = Number(v);
  return isFinite(n) ? n : (dflt || 0);
}
ipcMain.on('mini-resize-start', () => {
  if (!miniWin || miniWin.isDestroyed()) return;
  let pt, size;
  try { pt = screen.getCursorScreenPoint(); size = miniWin.getSize(); } catch (e) { return; }
  // 起点用主进程光标坐标（与后面的当前位置同一坐标系），不再用渲染层的 screenX：
  // Chromium 的 screenX 已经是 DIP（含缩放），旧代码又除了一次 scaleFactor，
  // 结果 125% 缩放下拖拽比光标慢 20% —— 这就是"拖动很奇怪"的来源。
  miniResizeStart = { cx: toNum(pt.x), cy: toNum(pt.y), w: toNum(size[0], 330), h: toNum(size[1], 356) };
});
ipcMain.on('mini-resize-move', () => {
  if (!miniResizeStart || !miniWin || miniWin.isDestroyed()) return;
  let pt;
  try { pt = screen.getCursorScreenPoint(); } catch (e) { return; }
  const rawW = miniResizeStart.w + (toNum(pt.x) - miniResizeStart.cx);
  const rawH = miniResizeStart.h + (toNum(pt.y) - miniResizeStart.cy);
  if (!isFinite(rawW) || !isFinite(rawH)) return;
  // 与 BrowserWindow 的 min/max 保持一致；两处必须同步，否则会出现"拖到某尺寸就卡住"
  const nw = Math.round(Math.max(MINI_MIN_W, Math.min(MINI_MAX_W, rawW)));
  const nh = Math.round(Math.max(MINI_MIN_H, Math.min(MINI_MAX_H, rawH)));
  try { miniWin.setSize(nw, nh); }
  catch (e) { /* 缩放过程中窗口被关掉等极端情况，忽略即可，不能让主进程崩 */ }
});
ipcMain.on('mini-resize-end', () => { miniResizeStart = null; });
/* 小窗移动改用原生 app-region 拖动（mini.html 的 .row 上 -webkit-app-region: drag），
   由系统直接拖动窗口、完全跟手；原先"每 16ms 轮询光标 + setPosition"的方案有量化延迟，
   观感卡顿，已移除。拖动结束后仍由下面的 moved 事件做边缘吸附。 */

/* 自动搜索歌词：在音频文件所在目录及其上级目录查找匹配的 .lrc 文件 */
function normL(s) {
  return (s || '').toLowerCase().replace(/[\s\-_—–~·,，。.()（）\[\]【】"'“”‘’]/g, '');
}
ipcMain.handle('find-lyrics', (_e, filePath, title, artist) => {
  try {
    if (!filePath || typeof filePath !== 'string') return null;
    const dir = path.dirname(filePath);
    const dirs = [dir, path.dirname(dir)];
    const base = normL(path.basename(filePath).replace(/\.[^.]+$/, ''));
    const nTitle = normL(title), nArtist = normL(artist);
    const matches = (f) => {
      const nb = normL(f.replace(/\.lrc$/i, ''));
      const nbStripped = nb.replace(/^\d+/, ''), baseStripped = base.replace(/^\d+/, '');
      if (nTitle && (nb === nTitle || nb.includes(nTitle) || nTitle.includes(nb))) return true;
      if (nTitle && nArtist && nb.includes(nTitle) && nb.includes(nArtist)) return true;
      if (nbStripped && baseStripped && (nbStripped === baseStripped || nbStripped.includes(baseStripped) || baseStripped.includes(nbStripped))) return true;
      return false;
    };
    for (const d of dirs) {
      let files;
      try { files = fs.readdirSync(d); } catch (e) { continue; }
      const hit = files.find(f => /\.lrc$/i.test(f) && matches(f));
      if (hit) return fs.readFileSync(path.join(d, hit), 'utf8');
    }
    return null;
  } catch (e) { return null; }
});

/* ================= NCM 解密（整合 ncmdump 功能） =================
   .ncm 标准布局：
     ① "CTENFDAM"(8) + 00 00(2) + keyLen(4) + keyData(keyLen)
     ② metaLen(4) + metaData(metaLen)
     ③ CRC(4) + 间隔(5) + imgSize(4) + imageData(imgSize)
     ④ audioData(剩余)  ← 音频在这一段，必须跳过 ②③ 才能拿到正确起点
   之前实现直接从 ① 之后取音频，等于把元数据和封面当成音频解密 → 大量文件解析失败。 */
/* AES-128-ECB 解密（不自动填充；长度非 16 整数倍时截断，避免抛异常） */
function aesEcbDecrypt(key, data) {
  const len = data.length - (data.length % 16);
  if (len <= 0) return Buffer.alloc(0);
  const d = crypto.createDecipheriv('aes-128-ecb', key, null);
  d.setAutoPadding(false); // 手动处理 PKCS7 填充
  return Buffer.concat([d.update(data.subarray(0, len)), d.final()]);
}
/* 判断解出来的字节是否像音频（fLaC / ID3 / MPEG 帧同步） */
function looksLikeAudio(b) {
  if (!b || b.length < 4) return false;
  if (b[0] === 0x66 && b[1] === 0x4C && b[2] === 0x61 && b[3] === 0x43) return true; // "fLaC"
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return true;                  // "ID3"
  if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return true;                          // MPEG 帧同步
  return false;
}
/* 解密 .ncm 字节 → 明文音频（mp3/flac）+ 元数据 */
function decryptNcmBuffer(buf) {
  const CORE = Buffer.from('687A4852416D736F356B496E4562616F', 'hex');
  const META = Buffer.from('2331346C6A6B5F215C5D26306C343935', 'hex');
  if (buf.length < 14 || buf.toString('latin1', 0, 8) !== 'CTENFDAM') throw new Error('非有效的 NCM 文件');

  // ---- ① 密钥段 ----
  const keyLen = buf.readUInt32LE(10);
  let pos = 14;
  if (keyLen <= 0 || pos + keyLen > buf.length) throw new Error('NCM 头损坏');
  let keyData = Buffer.from(buf.subarray(pos, pos + keyLen)); pos += keyLen;
  for (let i = 0; i < keyData.length; i++) keyData[i] ^= 0x64;
  keyData = aesEcbDecrypt(META, keyData);
  if (keyData.length < 21) throw new Error('密钥段解密失败');
  keyData = keyData.subarray(17); // 去掉 "neteasecloudmusic"
  const klen = keyData.readUInt32LE(0);
  if (klen <= 0 || 4 + klen > keyData.length) throw new Error('密钥长度异常');
  let key = aesEcbDecrypt(CORE, keyData.subarray(4, 4 + klen));
  if (key.length < 16) throw new Error('AES 密钥解密失败');
  key = key.subarray(0, 16);
  // 候选音频起点：标准布局（跳过 ②③）与两种回退布局，取第一个能解出音频头的
  const cands = [pos];

  // ---- ② 元数据段（同时得到标准布局的下一个偏移） ----
  let meta = { title: '', artist: '', album: '' };
  try {
    const metaLen = buf.readUInt32LE(pos);
    pos += 4;
    if (metaLen > 0 && pos + metaLen <= buf.length) {
      const mdRaw = Buffer.from(buf.subarray(pos, pos + metaLen));
      pos += metaLen;
      cands.push(pos); // 回退方案：只跳过元数据、不跳 CRC/封面
      const md = Buffer.from(mdRaw);
      for (let i = 0; i < md.length; i++) md[i] ^= 0x63;
      // 去 "163 key(Don't modify):"（22 字节）→ base64 解码 → AES 解密 → 去 "music:"（6 字节）
      const plain = aesEcbDecrypt(META, Buffer.from(md.subarray(22).toString('utf8'), 'base64'));
      const j = JSON.parse(plain.subarray(6).toString('utf8'));
      const artist = Array.isArray(j.artist)
        ? j.artist.map(a => (Array.isArray(a) ? a[0] : a)).filter(Boolean).join(' / ')
        : '';
      meta = { title: j.musicName || j.name || '', artist, album: j.album || '' };
    }
  } catch (e) { /* 元数据失败不影响音频 */ }

  // ---- ③ CRC(4) + 间隔(5) + 封面 ----
  try {
    pos += 4 + 5;
    const imgSize = buf.readUInt32LE(pos); pos += 4;
    if (imgSize > 0 && pos + imgSize <= buf.length) pos += imgSize;
    cands.unshift(pos); // 标准布局优先级最高
  } catch (e) { /* 忽略 */ }

  // ---- ④ 音频段：按候选起点逐个尝试，取能解出合法音频头的 ----
  let usedStart = -1;
  const tryStart = (start) => {
    if (start < 0 || start + 16 > buf.length) return false;
    const blk = aesEcbDecrypt(key, buf.subarray(start, start + 16));
    if (!looksLikeAudio(blk)) return false;
    usedStart = start;
    return true;
  };
  for (const start of cands) { if (tryStart(start)) break; }
  // 兜底扫描：加密音频长度必为 16 的整数倍 → 起点满足 (fileSize - off) % 16 === 0，
  // 只需按 16 对齐在头部区域试解第一块。覆盖各种 NCM 变体的字段差异。
  if (usedStart < 0) {
    const scanLimit = Math.min(buf.length - 16, 14 + keyLen + 1024 * 1024);
    let off = 14 + keyLen;
    off += (16 - ((buf.length - off) % 16)) % 16;
    for (; off <= scanLimit; off += 16) { if (tryStart(off)) break; }
  }
  if (usedStart < 0) throw new Error('未找到音频段起点（keyLen=' + keyLen + '，可能是不受支持的 NCM 变体）');
  let audio = aesEcbDecrypt(key, Buffer.from(buf.subarray(usedStart)));
  if (!audio.length) throw new Error('音频段解密失败');
  if (audio.length > 16) {
    const pad = audio[audio.length - 1];
    if (pad >= 1 && pad <= 16) audio = audio.subarray(0, audio.length - pad);
  }
  if (!looksLikeAudio(audio)) throw new Error('音频段解密异常（格式不受支持或被截断）');
  const isFlac = audio[0] === 0x66 && audio[1] === 0x4C && audio[2] === 0x61 && audio[3] === 0x43;
  return { bytes: audio, ext: isFlac ? 'flac' : 'mp3', title: meta.title || '', artist: meta.artist || '', album: meta.album || '' };
}
/* ---------- 随包携带的 ncmdump.exe（官方实现，兼容所有 NCM 变体） ----------
   ncmdump 会把解出的 mp3/flac 连同完整 ID3（标题/歌手/专辑/封面）一起写出，
   所以这里只需返回音频字节，元数据交给渲染端的 ID3 解析即可。

   数据管控：解出的文件只写在【本次会话专属】的临时目录里，读完立刻覆盖擦除并删除；
   全程不碰用户的音乐目录，也不返回任何可写盘的句柄。 */
function convertNcmWithExe(buf) {
  return new Promise(resolve => {
    const exe = path.join(__dirname, 'ncmdump.exe');
    if (!fs.existsSync(exe)) return resolve(null);
    let root;
    try { root = fs.mkdtempSync(path.join(ensureSessionTmp(), 'ncm-')); } catch (e) { return resolve(null); }
    const ncmPath = path.join(root, 'in.ncm');
    const outDir = path.join(root, 'out');
    try {
      fs.writeFileSync(ncmPath, buf);
      fs.mkdirSync(outDir, { recursive: true });
    } catch (e) { wipeDir(root); return resolve(null); }
    let settled = false;
    const finish = v => { if (settled) return; settled = true; resolve(v); };
    let child;
    try {
      // stdio:'ignore' —— 不需要它的输出，也避免管道在某些环境下受限
      child = spawn(exe, ['-o', outDir, ncmPath], { stdio: 'ignore', windowsHide: true });
    } catch (e) { wipeDir(root); return finish(null); }
    child.on('error', () => { wipeDir(root); finish(null); });
    child.on('exit', code => {
      try {
        if (code !== 0) { wipeDir(root); return finish(null); }
        const files = fs.readdirSync(outDir).filter(f => /\.(mp3|flac)$/i.test(f));
        if (!files.length) { wipeDir(root); return finish(null); }
        const name = files[0];
        const bytes = fs.readFileSync(path.join(outDir, name));
        const ext = /\.flac$/i.test(name) ? 'flac' : 'mp3';
        wipeDir(root);   // 覆盖擦除 + 删除，不等 GC
        finish(bytes.length ? { bytes, ext, title: '', artist: '', album: '' } : null);
      } catch (e) { wipeDir(root); finish(null); }
    });
    // 超时保护（大文件也给足时间）
    setTimeout(() => {
      if (settled) return;
      try { child.kill(); } catch (e) { /* ignore */ }
      wipeDir(root);
      finish(null);
    }, 120000);
  });
}
ipcMain.handle('convert-ncm', async (_e, arr) => {
  const buf = Buffer.isBuffer(arr) ? arr : Buffer.from(arr);
  // 先校验容器魔数：只处理真正的 NCM，不做"拿任意文件来试解"的通用解密器
  if (!buf || buf.length < 32 || buf.toString('latin1', 0, 8) !== 'CTENFDAM') {
    audit('ncm-decrypt', { result: 'rejected:not-ncm', bytes: buf ? buf.length : 0 });
    return { error: '不是有效的 NCM 文件（缺少 CTENFDAM 头）' };
  }
  // 首选：随包 ncmdump.exe（官方实现，兼容性最好）
  try {
    const viaExe = await convertNcmWithExe(buf);
    if (viaExe && viaExe.bytes && viaExe.bytes.length) {
      audit('ncm-decrypt', { result: 'ok:exe', bytes: viaExe.bytes.length, ext: viaExe.ext });
      return viaExe;
    }
  } catch (e) { /* 继续回退 */ }
  // 回退：内置 JS 解密（结果同样只在内存里）
  try {
    const r = decryptNcmBuffer(buf);
    audit('ncm-decrypt', { result: 'ok:builtin', bytes: r && r.bytes ? r.bytes.length : 0, ext: r && r.ext });
    return r;
  }
  catch (e) {
    audit('ncm-decrypt', { result: 'failed' });
    return { error: String((e && e.message) || e) };
  }
});
ipcMain.on('mini-control', (_e, action) => {
  if (!mainWin || mainWin.isDestroyed()) return;
  const code = {
    play: "document.getElementById('playBtn').click()",
    prev: "document.getElementById('prevBtn').click()",
    next: "document.getElementById('nextBtn').click()",
    mode: "document.getElementById('modeBtn').click()"
  }[action];
  if (code) {
    mainWin.webContents.executeJavaScript(code);
    return;
  }
  if (typeof action === 'string' && action.indexOf('seek:') === 0) {
    const frac = parseFloat(action.slice(5));
    if (isFinite(frac)) {
      mainWin.webContents.executeJavaScript(
        `(function(){ var a=document.getElementById('audio'); if(a.duration) a.currentTime = ${frac} * a.duration; })()`);
    }
  }
});

/* ================= B 站缓存解析（IPC 层） =================
   解析逻辑全在 ./bili.js（不依赖 Electron，可离线用 node 直接测试）。
   这里只负责：弹文件夹选择框 → 调用 bili.scan → 把结果交给渲染进程。

   数据管控：可播放副本（剥掉私有头的 m4a）不再落到 userData 长期驻留，
   而是写进【本次会话专属】临时目录，退出即销毁；下次启动由渲染端的
   ensureAllPlayable() 从原始缓存路径重新生成。封面缓存仍在 userData（只是图片）。 */
const bili = require('./bili');

function biliOpts() {
  ensureSessionTmp();
  return { userDataDir: app.getPath('userData'), audioDir: SESSION_AUDIO_DIR };
}

ipcMain.handle('bili-scan', async (_e, presetDir) => {
  let dir = presetDir;
  if (!dir) {
    const r = await dialog.showOpenDialog(mainWin, {
      title: '选择 B 站缓存文件夹（含 entry.json / audio.m4s）',
      buttonLabel: '扫描这个文件夹',
      properties: ['openDirectory']
    });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { canceled: true };
    dir = r.filePaths[0];
  }
  try {
    const items = await bili.scan(dir, biliOpts());
    audit('bili-scan', { src: dir, result: 'ok', bytes: items.length });
    return { ok: true, dir: dir, items: items };
  } catch (e) {
    audit('bili-scan', { src: dir, result: 'failed' });
    return { error: String((e && e.message) || e) };
  }
});
ipcMain.handle('bili-scan-dir', async (_e, dir) => {
  try {
    const items = await bili.scan(dir, biliOpts());
    audit('bili-scan', { src: dir, result: 'ok', bytes: items.length });
    return { ok: true, dir: dir, items: items };
  } catch (e) {
    audit('bili-scan', { src: dir, result: 'failed' });
    return { error: String((e && e.message) || e) };
  }
});

/* 把 B 站缓存的原始 .m4s 变成"可播放副本"，供渲染进程在播放前调用。
   force = true 时强制重建（播放报"格式不支持"时的自愈路径）。
   注意：旧版本留下的副本是硬链接，与源文件共享 inode —— 绝不能直接覆盖，
   bili.ensureM4a 内部会先摘掉目录项再写新文件，源缓存不受影响。
   副本一律落在会话临时目录，不写进 userData，退出时整体擦除。 */
ipcMain.handle('prepare-bili-audio', (_e, originalPath, force) => {
  try {
    if (!originalPath || typeof originalPath !== 'string') return { error: '缺少原始路径' };
    if (!fs.existsSync(originalPath)) return { error: '原始文件不存在：' + originalPath };
    ensureSessionTmp();
    const out = bili.ensureM4a(originalPath, SESSION_AUDIO_DIR, !!force);
    if (!out) return { error: '生成可播放副本失败' };
    const size = fs.statSync(out).size;
    audit('bili-extract', { src: originalPath, bytes: size, ext: 'm4a', result: 'ok' });
    return { ok: true, path: out, url: require('url').pathToFileURL(out).href, size: size };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});

/* ---------- 数据管控：策略自检 / 审计日志 ---------- */
ipcMain.handle('get-data-policy', () => {
  return {
    version: APP_VERSION,
    sessionId: SESSION_ID,
    auditCount: auditCount(),
    policy: {
      // 解密结果只在内存中传递，从不写入用户音乐目录
      decryptInMemory: true,
      // 派生数据（解出的音频 / 剥离头的副本）只存在于会话临时目录
      derivedScope: 'session-temp',
      tempCleanup: 'on-quit',
      // 程序不提供任何导出 / 另存为 / 分享能力
      exportApi: false,
      // 只处理真正的 NCM 容器，不做通用解密
      ncmMagicCheck: true,
      // 本地审计可追溯，可一键清空
      auditLog: true,
      auditFile: auditFile()
    }
  };
});
ipcMain.handle('clear-audit-log', () => {
  try { fs.rmSync(auditFile(), { force: true }); return { ok: true, count: 0 }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

/* 读随包资源（目前只有 3D 磁带模型）。
   为什么需要这条通道：页面是 file:// 加载的，Chromium 禁止 file:// 页面对本地文件发
   XHR/fetch，所以 GLTFLoader 没法直接 load('assets/xxx.glb') —— 会撞 CORS。
   这里由主进程读字节交给渲染进程，再用 loader.parse() 解析。
   只放行白名单里的文件名：不接受任意路径（否则就成了通用读文件接口）。 */
const ASSET_ALLOW = new Set(['archive-cassette.glb', 'archive-assembly.glb']);
ipcMain.handle('read-asset', (_e, name) => {
  try {
    if (!name || typeof name !== 'string' || !ASSET_ALLOW.has(name)) {
      return { error: '不在白名单内的资源：' + String(name) };
    }
    const p = path.join(__dirname, 'assets', name);
    if (!fs.existsSync(p)) return { error: '资源不存在：' + name };
    const st = fs.statSync(p);
    if (st.size > 64 * 1024 * 1024) return { error: '资源过大' };
    return { bytes: fs.readFileSync(p), size: st.size };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});
/* ================= 曲库恢复（--recover-library） =================
   背景：新版把界面从"随机端口"改成了固定端口 41739（IndexedDB 按"源"隔离，
   随机端口等于每次启动都换存储域）。而旧版留下来的曲库分散在三处：
     · 当前 profile 的 file:// 源（早期独立播放器，音频以 Blob 存在 IndexedDB 里）
     · 当前 profile 的若干 http://127.0.0.1:<随机端口> 源（1.4.0 之前的终端界面）
     · 另一个 profile（%APPDATA%\music-player-desktop）的 file:// 源
   本模式把这几处的东西读出来、写进新版自己的曲库 —— 全程只读旧数据，
   也不往音乐目录写文件（派生数据不导出的约束，见文件头的数据管控说明）。

   用法：
     音乐播放器.exe --recover-library                       # 恢复当前 profile 的全部旧源
     音乐播放器.exe --user-data-dir="<旧 profile>" --recover-library   # 恢复另一个 profile
*/
const RECOVER_MODE = process.argv.includes('--recover-library');
const INGEST_MODE = process.argv.includes('--recover-ingest');
/* 跨 profile 的交接区：旧 profile 恢复出来的东西先放这里（系统临时目录），
   由当前 profile 再吃进去 —— 与已有的"会话临时目录"同一套做法，绝不写进音乐目录，
   吃完即删。 */
const RECOVER_BUNDLE = path.join(os.tmpdir(), 'rhine-recover');
let recoverWriter = null;
let recoverStats = { origins: [], total: 0, files: 0, bytes: 0, added: 0, skipped: 0, finished: 0, bundle: RECOVER_BUNDLE };

ipcMain.handle('recover-from-reader', (_e, payload) => {
  try {
    if (!payload) return { ok: false };
    if (payload.done) {
      const s = payload.summary || {};
      recoverStats.origins.push(s.origin || '?');
      recoverStats.total += s.total || 0;
      recoverStats.files += s.files || 0;
      recoverStats.bytes += s.bytes || 0;
      return { ok: true };
    }
    /* 顺手留一份跨 profile 交接件（只在临时目录，且由 ingest 或下次启动清理） */
    try {
      fs.mkdirSync(RECOVER_BUNDLE, { recursive: true });
      if (payload.bytes && payload.bytes.byteLength) {
        const name = String(payload.fileName || ('track-' + (payload.index + 1) + '.' + (payload.ext || 'mp3')))
          .replace(/[\\/:*?"<>|]/g, '_').slice(-120);
        const file = path.join(RECOVER_BUNDLE, String(recoverStats.files).padStart(5, '0') + '-' + name);
        fs.writeFileSync(file, Buffer.from(payload.bytes));
        payload.bundleFile = path.basename(file);
      }
      if (payload.cover && payload.cover.byteLength) {
        const cfile = path.join(RECOVER_BUNDLE, 'cover-' + String(payload.index) + '-' + Math.random().toString(36).slice(2, 8) + '.bin');
        fs.writeFileSync(cfile, Buffer.from(payload.cover));
        payload.bundleCover = path.basename(cfile);
      }
      if (payload.bundleFile || payload.bundleCover) {
        fs.appendFileSync(path.join(RECOVER_BUNDLE, '清单.jsonl'), JSON.stringify({
          file: payload.bundleFile || null, cover: payload.bundleCover || null,
          origin: payload.origin, db: payload.db, store: payload.store, index: payload.index,
          fields: payload.fields || {}, fileName: payload.fileName || null, ext: payload.ext || null
        }) + '\n');
      }
    } catch (e) { logMainError('曲库恢复', e); }
    if (recoverWriter && !recoverWriter.isDestroyed()) recoverWriter.webContents.send('recover-to-writer', payload);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});
ipcMain.on('recover-ack', (_e, payload) => {
  if (!payload) return;
  if (typeof payload.added === 'number') recoverStats.added = payload.added;
  if (typeof payload.skipped === 'number') recoverStats.skipped = payload.skipped;
  if (payload.finished) recoverStats.finished++;
});

const RECOVER_PRELOAD = path.join(__dirname, 'preload.js');
function makeRecoverWindow() {
  return new BrowserWindow({
    width: 900, height: 700, show: true, title: '曲库恢复 · RHINE LAB',
    backgroundColor: '#14150f',
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: RECOVER_PRELOAD, spellcheck: false }
  });
}
/* 在某个 http 源上临时起一个只读静态服务（旧端口上的数据只有在该源里才读得到） */
function serveForOrigin(port, dir) {
  return new Promise((resolve) => {
    const srv = http.createServer((q, s) => {
      let p = decodeURIComponent(String(q.url || '/').split('?')[0].split('#')[0]);
      if (p === '/') p = '/index.html';
      const file = path.normalize(path.join(dir, p));
      if (file !== dir && !file.startsWith(dir + path.sep)) { s.writeHead(403); s.end('forbidden'); return; }
      fs.readFile(file, (err, data) => {
        if (err) { s.writeHead(404); s.end('not found'); return; }
        s.writeHead(200, { 'Content-Type': /\.html$/.test(file) ? 'text/html; charset=utf-8' : 'application/octet-stream' });
        s.end(data);
      });
    });
    srv.on('error', () => resolve(null));
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}
async function runRecovery() {
  /* ① 先开"写入端"：新版自己的源（固定端口） */
  const baseUrl = await startUiServer().catch(() => null);
  if (!baseUrl) throw new Error('无法启动内嵌 UI 服务，写不进新版曲库');
  recoverWriter = makeRecoverWindow();
  await recoverWriter.loadURL(baseUrl + 'recover.html?mode=write');
  /* ② 找出所有旧源 */
  const idbDir = path.join(app.getPath('userData'), 'IndexedDB');
  const oldPorts = [];
  try {
    for (const name of fs.readdirSync(idbDir)) {
      const m = /^http_127\.0\.0\.1_(\d+)\.indexeddb\.leveldb$/.exec(name);
      if (!m) continue;
      const port = Number(m[1]);
      if (port === UI_PORT) continue; // 新版自己的源，跳过
      oldPorts.push(port);
    }
  } catch (e) { logMainError('曲库恢复', e); }
  const servers = [];
  const targets = [];
  if (fs.existsSync(path.join(idbDir, 'file__0.indexeddb.leveldb'))) {
    targets.push({
      label: 'file://（独立播放器）',
      origin: 'file://',
      url: 'file://' + path.join(__dirname, 'recover.html').replace(/\\/g, '/') + '?mode=read',
    });
  }
  for (const port of oldPorts) {
    const srv = await serveForOrigin(port, __dirname);
    if (!srv) continue;
    servers.push(srv);
    const origin = 'http://127.0.0.1:' + port;
    targets.push({ label: origin, origin, url: origin + '/recover.html?mode=read' });
  }
  logMainError('曲库恢复', new Error('待恢复的旧源：' + (targets.map((t) => t.label).join('、') || '无')));
  /* ③ 逐个源读出来（顺序执行，避免同时搬几 GB） */
  for (const t of targets) {
    const win = makeRecoverWindow();
    try {
      await win.loadURL(t.url);
      // 该源读完时 reader 会送来 { done: true, summary:{ origin } }，主进程据此收尾
      const deadline = Date.now() + 1000 * 60 * 30;
      while (!recoverStats.origins.includes(t.origin) && !win.isDestroyed() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
      }
    } catch (e) {
      logMainError('曲库恢复', e);
    } finally {
      if (!win.isDestroyed()) win.close();
    }
  }
  /* ④ 等写入端把队列写完 */
  const deadline = Date.now() + 1000 * 60 * 5;
  let last = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    if (recoverStats.added === last) {
      if (++stable >= 4) break;
    } else {
      stable = 0;
      last = recoverStats.added;
    }
  }
  servers.forEach((s) => { try { s.close(); } catch (e) { /* ignore */ } });
  if (recoverWriter && !recoverWriter.isDestroyed()) recoverWriter.close();
  return recoverStats;
}

/* --recover-ingest：把交接区里的东西吃进"当前 profile"的曲库（跨 profile 恢复的第二步） */
async function runIngest() {
  const baseUrl = await startUiServer().catch(() => null);
  if (!baseUrl) throw new Error('无法启动内嵌 UI 服务');
  if (!fs.existsSync(RECOVER_BUNDLE)) {
    throw new Error('交接区不存在：' + RECOVER_BUNDLE + '\n（先跑一次 --recover-library）');
  }
  recoverWriter = makeRecoverWindow();
  await recoverWriter.loadURL(baseUrl + 'recover.html?mode=write');
  const manifestPath = path.join(RECOVER_BUNDLE, '清单.jsonl');
  const lines = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean) : [];
  recoverStats.total = lines.length;
  for (const line of lines) {
    let meta;
    try { meta = JSON.parse(line); } catch (e) { continue; }
    const payload = { fields: meta.fields || {}, origin: 'bundle', db: 'bundle', store: 'bundle', index: meta.index || 0, fileName: meta.fileName || undefined, ext: meta.ext || undefined };
    try {
      if (meta.file) {
        const p = path.join(RECOVER_BUNDLE, meta.file);
        const buf = fs.readFileSync(p);
        payload.bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        recoverStats.files++;
        recoverStats.bytes += buf.length;
      }
      if (meta.cover) {
        const p = path.join(RECOVER_BUNDLE, meta.cover);
        if (fs.existsSync(p)) {
          const buf = fs.readFileSync(p);
          payload.cover = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
        }
      }
    } catch (e) { logMainError('曲库恢复', e); continue; }
    if (recoverWriter.isDestroyed()) break;
    recoverWriter.webContents.send('recover-to-writer', payload);
    if (recoverStats.files % 25 === 0) await new Promise((r) => setTimeout(r, 300)); // 别把写入端淹了
  }
  recoverWriter.webContents.send('recover-to-writer', { done: true });
  /* 等写入端把队列写完（added 连续 5 秒不再增长就认为收尾） */
  const deadline = Date.now() + 1000 * 60 * 10;
  let last = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    if (recoverStats.added === last) { if (++stable >= 5) break; } else { stable = 0; last = recoverStats.added; }
  }
  if (recoverWriter && !recoverWriter.isDestroyed()) recoverWriter.close();
  /* 吃干净了再删交接区 */
  try { fs.rmSync(RECOVER_BUNDLE, { recursive: true, force: true }); } catch (e) { logMainError('曲库恢复', e); }
  return recoverStats;
}

ipcMain.handle('read-audio', (_e, p) => {
  try {
    if (!p || typeof p !== 'string' || !fs.existsSync(p)) return { error: '文件不存在' };
    const st = fs.statSync(p);
    if (st.size > 300 * 1024 * 1024) return { error: '文件过大（>300MB）' };
    const buf = fs.readFileSync(p);
    const mime = /\.(m4a|m4s|mp4)$/i.test(p) ? 'audio/mp4'
      : (/\.flac$/i.test(p) ? 'audio/flac'
        : (/\.wav$/i.test(p) ? 'audio/wav'
          : (/\.ogg$|\.opus$/i.test(p) ? 'audio/ogg' : 'audio/mpeg')));
    return { bytes: buf, mime: mime, size: st.size };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});
