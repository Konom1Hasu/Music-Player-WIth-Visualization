const { contextBridge, ipcRenderer } = require('electron');

/* ================= IPC 白名单（安全收口） =================
   preload 是 renderer 唯一能摸到主进程的门口。原来 send/on 是**任意 channel 直通**：
   页面里任何一段脚本（包括被注入的第三方内容、或 UI 里渲染出来的歌词/标题里
   藏着的 payload）都能往主进程塞任意 channel，也能监听任意 channel。
   这里改成严格白名单：不在表里的 channel 一律丢弃，不做转发、不报错给页面。

   ★ 表里的每一项都必须是**全仓真实存在**的：
     · SEND_WHITELIST  —— 渲染层发、主进程 ipcMain.on 收（含一处旧的兼容通道）
     · ON_WHITELIST    —— 主进程 webContents.send 发、渲染层收
   新增通道时必须同步这张表，否则那个功能会"静默失效"（表现为点了没反应）。 */
const SEND_WHITELIST = new Set([
  // 曲库恢复：reader 页回报写入端进度 / 收尾
  'recover-ack'
]);
const ON_WHITELIST = new Set([
  // 主进程 → 主界面
  'win-state', 'media-key', 'hotkey-status',
  // 曲库恢复：主进程 → writer 页
  'recover-to-writer'
]);
const warnOnce = new Set();
function reject(kind, channel) {
  // channel 可能是任意值（Symbol / 对象 / 带 toString 的怪东西），拼 key 本身要防一手
  let key = kind + ':?';
  try { key = kind + ':' + String(channel); } catch (e) { /* 保持兜底 key */ }
  if (warnOnce.has(key)) return;
  // 上限 50：异常通道名不该把这张表撑成内存增长点
  if (warnOnce.size >= 50) return;
  warnOnce.add(key);
  // 只提示一次，避免被高频调用刷爆控制台；不抛异常，页面逻辑不受影响
  try { console.warn('[preload] 忽略未授权的 IPC 通道（' + kind + '）：' + String(channel)); } catch (e) { /* ignore */ }
}

contextBridge.exposeInMainWorld('desktop', {
  // 发往主进程：只放行白名单里的通道
  send: (channel, data) => {
    if (!SEND_WHITELIST.has(channel)) { reject('send', channel); return; }
    ipcRenderer.send(channel, data);
  },
  // 收主进程消息：同样只放行白名单里的通道
  on: (channel, cb) => {
    if (!ON_WHITELIST.has(channel)) { reject('on', channel); return; }
    if (typeof cb !== 'function') return;
    ipcRenderer.on(channel, (_e, data) => cb(data));
  },
  // 在当前目录及上级目录搜索并绑定歌词（返回 .lrc 文本，找不到返回 null）
  findLyrics: (filePath, title, artist) => ipcRenderer.invoke('find-lyrics', filePath, title, artist),
  // NCM 解密：传入 .ncm 文件字节，返回 { bytes, ext, title, artist, album } 或 { error }
  convertNcm: (buf) => ipcRenderer.invoke('convert-ncm', buf),
  // B 站缓存：弹出文件夹选择框 → { ok, dir, items:[{title,artist,audioPath,path,cover,...}] } | { canceled } | { error }
  scanBiliCache: () => ipcRenderer.invoke('bili-scan'),
  // 把 B 站缓存的原始 .m4s 变成可播放副本（去掉自定义头 / 建硬链接）→ { ok, path, url, size } | { error }
  prepareBiliAudio: (originalPath, force) => ipcRenderer.invoke('prepare-bili-audio', originalPath, force),
  // 把可播放副本留一份到曲库目录（与源缓存解耦：源删了也能播）→ { ok, path, url, size } | { error }
  keepBiliAudio: (originalPath) => ipcRenderer.invoke('bili-keep', originalPath),
  // 本地保留副本的占用情况 → { ok, count, bytes, dir } | { error }
  localAudioInfo: () => ipcRenderer.invoke('local-audio-info'),
  // 读音频字节，用于 blob 兜底播放 → { bytes, mime, size } | { error }
  readAudio: (p) => ipcRenderer.invoke('read-audio', p),
  // 轻量探活：只 stat 不读字节 → { ok, path, size, fixed } | { ok:false, error }
  // 用于在采用本地副本前确认它还在盘上（老版本存过 8.3 短名路径）
  audioExists: (p) => ipcRenderer.invoke('audio-exists', p),
  // 全局快捷键注册状态（媒体键是否被游戏占用）→ { media, fallback, detail }
  getHotkeyStatus: () => ipcRenderer.invoke('get-hotkey-status'),
  // 取内嵌封面（NCM / MP3 / FLAC / M4A / WAV / OGG / APE…）：
  // 传 { path } 或 { bytes, name } → { ok, dataUrl, size, mime, source } | { error }
  readCover: (arg) => ipcRenderer.invoke('read-cover', arg),
  /* ===== 曲库恢复（--recover-library 专用）=====
     read 页把旧源的记录交出来；write 页接收主进程转发来的记录写进新版曲库。
     数据只在进程间搬运，不落盘到音乐目录 —— 遵守数据管控里"派生数据不导出"的约束。 */
  recoverChunk: (payload) => ipcRenderer.invoke('recover-from-reader', payload),
  recoverListen: (cb) => {
    if (ON_WHITELIST.has('recover-to-writer') && typeof cb === 'function') {
      ipcRenderer.on('recover-to-writer', (_e, payload) => cb(payload));
    }
  },
  recoverAck: (payload) => {
    if (SEND_WHITELIST.has('recover-ack')) ipcRenderer.send('recover-ack', payload);
  }
});
