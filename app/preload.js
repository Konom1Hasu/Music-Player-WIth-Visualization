const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  send: (channel, data) => ipcRenderer.send(channel, data),
  on: (channel, cb) => ipcRenderer.on(channel, (_e, data) => cb(data)),
  // 在当前目录及上级目录搜索并绑定歌词（返回 .lrc 文本，找不到返回 null）
  findLyrics: (filePath, title, artist) => ipcRenderer.invoke('find-lyrics', filePath, title, artist),
  // 渲染模式切换（软件模式下次启动生效）
  setRenderMode: (mode) => ipcRenderer.send('set-render-mode', mode),
  // GPU 渲染状态自检
  getGpuStatus: () => ipcRenderer.invoke('get-gpu-status'),
  // 显示器信息（刷新率等）
  getDisplayInfo: () => ipcRenderer.invoke('get-display-info'),
  // NCM 解密：传入 .ncm 文件字节，返回 { bytes, ext, title, artist, album } 或 { error }
  convertNcm: (buf) => ipcRenderer.invoke('convert-ncm', buf),
  // B 站缓存：弹出文件夹选择框 → { ok, dir, items:[{title,artist,audioPath,path,cover,...}] } | { canceled } | { error }
  scanBiliCache: () => ipcRenderer.invoke('bili-scan'),
  // 同上，但直接扫指定目录（不弹框）
  scanBiliDir: (dir) => ipcRenderer.invoke('bili-scan-dir', dir),
  // 把 B 站缓存的原始 .m4s 变成可播放副本（去掉自定义头 / 建硬链接）→ { ok, path, url, size } | { error }
  prepareBiliAudio: (originalPath, force) => ipcRenderer.invoke('prepare-bili-audio', originalPath, force),
  // 读音频字节，用于 blob 兜底播放 → { bytes, mime, size } | { error }
  readAudio: (p) => ipcRenderer.invoke('read-audio', p),
  // 全局快捷键注册状态（媒体键是否被游戏占用）→ { media, fallback, detail }
  getHotkeyStatus: () => ipcRenderer.invoke('get-hotkey-status'),
  // 取内嵌封面（NCM / MP3 / FLAC / M4A / WAV / OGG / APE…）：
  // 传 { path } 或 { bytes, name } → { ok, dataUrl, size, mime, source } | { error }
  readCover: (arg) => ipcRenderer.invoke('read-cover', arg),
  // 旧通道：只认 NCM（保留兼容）
  ncmCover: (arg) => ipcRenderer.invoke('ncm-cover', arg)
});
