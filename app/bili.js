/* ================= B 站缓存解析（纯逻辑，不依赖 Electron） =================
   B 站缓存的两种常见布局：
     ① 手机端  Android/data/tv.danmaku.bili/download/<av 或 ep 号>/<cid>/
          entry.json              元数据（标题 / UP 主 / 封面链接）
          danmaku.xml
          <清晰度>/index.json
          <清晰度>/audio.m4s      ← 音频，只要这个
          <清晰度>/video.m4s      ← 视频，不要
     ② PC 客户端 / 第三方工具：entry.json 与 audio.m4s 同级或子目录

   产出只有四样：歌名、歌手、audio.m4s、封面。

   为什么不直接把 .m4s 丢给 <audio>：
   Chromium 按扩展名判 MIME，.m4s 属未知类型 → 直接拒播；file:// 的原生 Range（拖进度）
   同样依赖类型识别。所以在 <userData>/bili_audio 下建一个 .m4a 硬链接：
   同盘瞬时完成、不占额外空间（跨盘自动退化为复制），类型正确、可随意拖动，
   原始缓存文件一个字节都不动。

   说明：本文件不 require('electron')，可被 node 直接引入做离线测试。
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { pathToFileURL } = require('url');

const md5hex = (s) => crypto.createHash('md5').update(String(s)).digest('hex');

/* 方括号里这些内容属于"标签"，不是歌名/歌手 */
const NOISE = /^(mv|pv|op|ed|live|4k|8k|1080p|720p|60fps|hdr|hi-?res|无损|高音质|试听|完整版|中文字幕|中字|字幕|官方|official|翻唱|cover|纯音乐|伴奏|inst|instrumental|现场|重置版|高清|超清|合集|搬运|转载|补档|音乐|歌曲|新曲|初投稿|av\d+|bv[\w]+|\d{4}|\d+年)$/i;

function stripNoise(title) {
  return String(title || '')
    .replace(/[【\[（(]([^】\]）)]{1,20})[】\]）)]/g, (m, inner) => (NOISE.test(String(inner).trim()) ? ' ' : m))
    .replace(/\s*(?:高清|超清|4K|1080P|720P|无损|Hi-?Res|中文字幕|完整版)\s*版?\s*$/i, ' ')
    .replace(/[|｜]/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/* 从原始标题猜 歌名 / 歌手：覆盖 B 站音乐区最常见的几种写法，猜不到由 UP 主名兜底。
   uname 会参与判定：搬运/官方号的账号名常常含歌手名（实测 "PYKAMIA搬运站" 含 "PYKAMIA"），
   于是 "X - Y" 哪边是歌手就能定下来，不用靠猜顺序。 */
function normUname(u) {
  return String(u || '')
    .replace(/(搬运站|搬运|官方|音乐|频道|字幕组|字幕|哔哩哔哩|bilibili|official|channel|music)/gi, '')
    .replace(/[\s\-_—–~·,，。.()（）\[\]【】"'“”‘’]/g, '')
    .toLowerCase();
}
function parseBiliTitle(raw, uname) {
  const t = String(raw || '').trim();
  const U = normUname(uname);
  let artist = '', title = '', leadTag = '';
  // ①【歌手/作品】歌名【标签】
  const lead = t.match(/^[【\[]([^】\]]{1,40})[】\]]\s*(.+)$/);
  if (lead && !NOISE.test(lead[1].trim())) { leadTag = lead[1].trim(); artist = leadTag; title = lead[2].trim(); }
  // ② 歌名【歌手】
  if (!artist) {
    const tail = t.match(/^(.+?)\s*[【\[（(]([^】\]）)]{1,40})[】\]）)]\s*$/);
    if (tail && !NOISE.test(tail[2].trim())) { title = tail[1].trim(); artist = tail[2].trim(); }
  }
  /* ③ 分隔符拆成两段时，用 UP 主名 / 前导方括号来定顺序：
       · 有一边命中 UP 主名 → 那边是歌手（实测 "【Milthm】PYKAMIA - Fantasia Sonata Reflection"
         配 "PYKAMIA搬运站"：PYKAMIA 命中 → 歌手 PYKAMIA、歌名 Fantasia Sonata Reflection）
       · 有前导【作品名】→ 后半是歌名（搬运区写法）
       · 都没有 → 按 "歌名 - 歌手" */
  if (!title || artist === leadTag) {
    const body = title || t;
    const parts = body.split(/\s*(?:[-–—－]\s|\s*[/／]\s*)\s*/).map((x) => x.trim()).filter(Boolean);
    if (parts.length === 2) {
      const a = parts[0], b = parts[1];
      const aHit = !!U && (normUname(a).indexOf(U) >= 0 || U.indexOf(normUname(a)) >= 0);
      const bHit = !!U && (normUname(b).indexOf(U) >= 0 || U.indexOf(normUname(b)) >= 0);
      if (aHit && !bHit) { artist = a; title = b; }
      else if (bHit && !aHit) { artist = b; title = a; }
      else if (leadTag) { artist = a; title = b; }
      else { title = a; artist = b; }
    } else if (parts.length > 2) {
      title = parts[parts.length - 1];
      artist = parts.slice(0, -1).join(' ');
    }
  }
  if (!title) title = t;
  title = stripNoise(title).replace(/[【\[（(]\s*[】\]）)]/g, '').trim();
  artist = String(artist).replace(/[|｜].*$/, '').trim();
  if (!title) title = stripNoise(raw) || '未知歌曲';
  return { title: title, artist: artist };
}

const readJsonSafe = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } };
const toFileUrl = (p) => pathToFileURL(p).href;

/* 建可播放的 .m4a。两种情况：
   ① 文件本来就是标准 mp4（手机端 audio.m4s）→ 硬链接（同盘瞬时、不占额外空间）。
   ② 文件前面有自定义头（实测电脑端在 mp4 前塞了 9 个 ASCII '0'）→ **必须去掉头另存一份**。
      硬链接会把那 9 字节一起带过去，而 Chromium 的解复用器不像我们自己的解析器那样跳过它，
      会直接判为非法文件 —— 表现正是"能导入但无法播放"。
      ffmpeg 实测：原文件 `Invalid data found when processing input`；
      去掉前 9 字节后 `Duration 00:02:11 / aac 44100Hz stereo` 正常。
   注意：去掉头时必须**先摘掉目标目录项再写新文件** —— 直接覆盖会透过硬链接写到源文件上，
   把用户的缓存改坏（源文件与硬链接共享同一个 inode）。 */
function copyWithoutPrefix(src, dest, offset) {
  const fd = fs.openSync(src, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const out = fs.openSync(dest, 'w');
    try {
      const CH = 1024 * 1024;
      const buf = Buffer.alloc(CH);
      let pos = offset;
      while (pos < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(CH, size - pos), pos);
        if (n <= 0) break;
        fs.writeSync(out, buf, 0, n);
        pos += n;
      }
    } finally { fs.closeSync(out); }
  } finally { fs.closeSync(fd); }
}

function ensureM4a(audioPath, userDataDir, force) {
  const dir = path.join(userDataDir, 'bili_audio');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
  const dest = path.join(dir, md5hex(audioPath).slice(0, 16) + '.m4a');
  // 源文件是否有前置头
  let offset = 0;
  const sniff = kindCache.get(audioPath);
  if (sniff && typeof sniff.mp4Offset === 'number') offset = sniff.mp4Offset;
  else {
    try {
      const fd = fs.openSync(audioPath, 'r');
      const n = Math.min(8192, fs.fstatSync(fd).size);
      const head = Buffer.alloc(n);
      fs.readSync(fd, head, 0, n, 0);
      fs.closeSync(fd);
      offset = findMp4Start(head);
    } catch (e) { offset = 0; }
  }
  if (offset > 0) {
    // 目标必须是"独立的、去掉头"的副本。旧版本留下的是硬链接（inode 与源相同、长度与源相同）
    // → 判定为无效，摘掉目录项后重写（摘目录项不会影响源文件）。
    let reusable = false;
    try {
      if (!force && fs.existsSync(dest)) {
        const st = fs.statSync(dest), ss = fs.statSync(audioPath);
        reusable = (st.ino !== ss.ino) && (st.size === ss.size - offset);
        if (!reusable) fs.unlinkSync(dest);
      }
    } catch (e) { /* ignore */ }
    if (!reusable) {
      try { copyWithoutPrefix(audioPath, dest, offset); } catch (e) { return null; }
    }
    return dest;
  }
  try { if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest; } catch (e) { /* ignore */ }
  try { if (fs.existsSync(dest)) fs.unlinkSync(dest); fs.linkSync(audioPath, dest); return dest; }
  catch (e) {
    try { fs.copyFileSync(audioPath, dest); return dest; } catch (e2) { return null; }
  }
}

function fileToDataUrl(p) {
  try {
    const buf = fs.readFileSync(p);
    if (buf.length < 512 || buf.length > 8 * 1024 * 1024) return null;
    // 按文件头判类型，不迷信扩展名（缓存里的封面常被存成 .jpg 却是 PNG）
    let mime = 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50) mime = 'image/png';
    else if (buf[0] === 0x47 && buf[1] === 0x49) mime = 'image/gif';
    else if (buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57) mime = 'image/webp';
    else if (buf[0] === 0x42 && buf[1] === 0x4d) mime = 'image/bmp';
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  } catch (e) { return null; }
}

function httpGetBinary(url, depth, timeoutMs) {
  depth = depth || 0;
  timeoutMs = timeoutMs || 15000;
  return new Promise((resolve) => {
    if (depth > 4 || !url) return resolve(null);
    let u;
    try { u = new URL(url); } catch (e) { return resolve(null); }
    const mod = (u.protocol === 'https:') ? https : http;
    const req = mod.get(u, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com/', 'Accept': 'image/*,*/*' }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        let next = null;
        try { next = new URL(res.headers.location, u).href; } catch (e) { /* ignore */ }
        return resolve(httpGetBinary(next, depth + 1, timeoutMs));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      const chunks = []; let total = 0;
      res.on('data', (c) => { total += c.length; if (total > 12 * 1024 * 1024) { try { req.destroy(); } catch (e) {} return; } chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch (e) {} resolve(null); });
  });
}

/* 封面：先用缓存目录里已有的图片；没有再按 entry.json 的 cover 链接下载并缓存 */
async function resolveCover(entryDir, coverUrl, opts) {
  const dirs = [entryDir];
  try {
    for (const e of fs.readdirSync(entryDir, { withFileTypes: true })) {
      if (e.isDirectory()) dirs.push(path.join(entryDir, e.name));
    }
  } catch (e) { /* ignore */ }
  const cands = [];
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { continue; }
    for (const f of files) {
      if (!f.isFile() || !/\.(jpe?g|png|webp|bmp)$/i.test(f.name)) continue;
      cands.push(path.join(d, f.name));
    }
  }
  // 封面优先级：电脑端的单集封面就叫 image.jpg（group.jpg 是合集封面，别用错）；
  // 手机端常见 cover.jpg/folder.jpg；其余图片垫底。
  const covScore = (p) => {
    const n = path.basename(p).toLowerCase();
    if (/^image\.(jpe?g|png|webp|bmp)$/.test(n)) return 3;
    if (/cover|folder|poster|thumb/.test(n)) return 2;
    return 1;
  };
  cands.sort((a, b) => covScore(b) - covScore(a));
  for (const c of cands) {
    try { if (fs.statSync(c).size > 1024) { const d = fileToDataUrl(c); if (d) return d; } } catch (e) { /* ignore */ }
  }
  if (coverUrl && opts && opts.fetchCover !== false) {
    const dir = path.join(opts.userDataDir, 'bili_cover');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* ignore */ }
    const dest = path.join(dir, md5hex(coverUrl).slice(0, 16) + '.jpg');
    let buf = null;
    try { if (fs.existsSync(dest)) buf = fs.readFileSync(dest); } catch (e) { /* ignore */ }
    if (!buf || buf.length < 1024) {
      buf = await httpGetBinary(coverUrl);
      if (buf && buf.length > 1024) { try { fs.writeFileSync(dest, buf); } catch (e) { /* ignore */ } }
    }
    if (buf && buf.length > 1024) return 'data:image/jpeg;base64,' + buf.toString('base64');
  }
  return null;
}

/* 递归收集 entry.json 与所有【可能是媒体】的文件（深度上限 7 层 + 条目上限防跑飞）。
   注意：不再用文件名筛音频 —— B 站缓存里的音轨名字五花八门
   （audio.m4s / 0.m4s / 30280.m4s / sound.m4s / 干脆没扩展名…），按名字筛会把它们全漏掉，
   也容易把同名的视频轨收进来。统一按扩展名收成候选，随后逐个读内容判定音/视频。 */
const MEDIA_EXT = /\.(m4s|mp4|m4a|aac|mp3|flac|ogg|oga|opus|webm|ts)$/i;
function collect(rootDir) {
  const entries = [], cands = [];
  const stack = [{ d: rootDir, depth: 0 }];
  let guard = 0;
  while (stack.length && guard < 40000) {
    const cur = stack.pop(); guard++;
    let list;
    try { list = fs.readdirSync(cur.d, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of list) {
      const full = path.join(cur.d, e.name);
      if (e.isDirectory()) { if (cur.depth < 7) stack.push({ d: full, depth: cur.depth + 1 }); }
      else if (/^(entry\.json|videoInfo\.json|\.videoInfo)$/i.test(e.name)) entries.push(full);
      else if (MEDIA_EXT.test(e.name)) cands.push(full);
    }
  }
  return { entries: entries, cands: cands };
}

/* 内容判定（带缓存）：读 mp4 盒子看 stsd 里是音频轨还是视频轨。
   B 站的 m4s 都是"moov 在文件开头"的结构，所以只读前 1.5MB 就够，不必整个文件读进来。 */
const kindCache = new Map();
function sniffKind(p) {
  if (kindCache.has(p)) return kindCache.get(p);
  let size = 0;
  try { size = fs.statSync(p).size; } catch (e) { /* ignore */ }
  if (size > 0 && size < 1024) {
    const r = { kind: 'tiny', size: size };
    kindCache.set(p, r); return r;
  }
  let info = null;
  try { info = probeM4a(p, 1.5 * 1024 * 1024); } catch (e) { info = null; }
  let kind = info ? info.kind : 'other';
  // 内容读不出来时才退回名字提示（只作兜底，不作主判据）
  if (kind === 'other') {
    const n = path.basename(p).toLowerCase();
    if (/audio|sound|music|\.m4a$|\.aac$|\.mp3$|\.flac$|\.opus$|\.ogg$/.test(n)) kind = 'audio';
    else if (/video|\.mp4$|\.webm$|\.ts$/.test(n)) kind = 'video';
  }
  // 注意顺序：先把 info 铺进去，再写 kind/size —— 反过来会让 info.kind（'other'）
  // 覆盖掉上面名字兜底修正出来的 kind，导致"内容读不出来但名字明确"的文件被整批漏掉。
  const rec = Object.assign({}, info || {}, { kind: kind, size: size });
  kindCache.set(p, rec);
  return rec;
}

/* ================= 音质 =================
   B 站缓存里同一集常常有多个清晰度子目录（16/32/64/80/30280…），每个目录里都有一份 audio.m4s。
   旧实现取"层级最浅"的那个，同层多个时等于按文件系统返回顺序随便挑一个 ——
   完全可能挑中 64kbps 那路、把 192kbps 丢在一边，听起来就是"音质被搞坏了"。
   现在按「音质标签排名 → 文件体积」取最优，并把真实码率解析出来给人看。 */
const QUALITY_RANK = {
  '30251': 10, '30250': 9, '30280': 8, '30232': 7, '30216': 6,      // 音频流 id
  '125': 6.5, '126': 6.5, '127': 6.5,                                // 8K / HDR
  '120': 5.5, '116': 5.2, '112': 5,                                  // 4K / 1080P60 / 1080P+
  '80': 4.6, '74': 4.4, '64': 4, '32': 3.2, '16': 3, '6': 2.6        // 1080P / 720P / 480P / 360P
};
function qualityTagOf(p) { return path.basename(path.dirname(p)); }
function qualityRank(p) { return QUALITY_RANK[qualityTagOf(p)] || 0; }

/* 在某个 entry 目录下挑最优音轨：先比音质标签，再比体积（同集时长相同 → 体积即码率） */
function pickBestAudio(entryDir, audios) {
  const cands = audios
    .filter((a) => a.indexOf(entryDir) === 0)
    .map((a) => {
      let size = 0;
      try { size = fs.statSync(a).size; } catch (e) { /* ignore */ }
      return { path: a, rank: qualityRank(a), size, tag: qualityTagOf(a), sniff: kindCache.get(a) || null };
    })
    .sort((x, y) => (y.rank - x.rank) || (y.size - x.size));
  return { best: cands[0] || null, all: cands };
}

/* 解析 m4a/fMP4：采样率、声道、时长 → 估算真实码率（B 站的 m4s 是分片 mp4，
   mvhd 的时长常常是 0，得退回 mdhd 或把 moof/trun 里每个采样的时长加起来） */
/* 找到 mp4 真正的起点。
   B 站电脑端（PC 客户端）会在 m4s 前面塞一小段自定义头 —— 实测是 9 个 ASCII '0'
   （hex: 30×9），后面才是标准 mp4（ftyp 的首字节在偏移 13）。直接按 0 偏移解盒子会全军覆没：
   所有文件都被判成"未知类型"，整个缓存一条都导不进来。
   这里从前往后扫，找第一个"合法盒子长度 + 紧跟已知类型"的位置。 */
const MP4_HEAD_TAGS = ['ftyp', 'moov', 'moof', 'mdat', 'free', 'skip', 'styp', 'sidx', 'wide'];
function findMp4Start(buf) {
  const lim = Math.min(buf.length - 8, 8192);
  for (let i = 0; i <= lim; i++) {
    const type = buf.toString('latin1', i + 4, i + 8);
    if (MP4_HEAD_TAGS.indexOf(type) < 0) continue;
    const size = buf.readUInt32BE(i);
    if (size === 1 || (size >= 8 && i + size <= buf.length)) return i;
  }
  return 0;
}

function probeM4a(p, maxBytes) {
  let buf;
  try {
    if (maxBytes && maxBytes > 0) {
      // 只读前 maxBytes：用于"这是音频还是视频"的快速判定（moov/stsd 在开头）。
      // 注意码率要的是完整文件，所以最终报告音质时必须不带 maxBytes 再读一次。
      const fd = fs.openSync(p, 'r');
      try {
        const st = fs.fstatSync(fd);
        const n = Math.min(st.size, maxBytes);
        buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, 0);
      } finally { fs.closeSync(fd); }
    } else {
      buf = fs.readFileSync(p);
    }
  } catch (e) { return null; }
  const fullSize = maxBytes ? (function () { try { return fs.statSync(p).size; } catch (e) { return buf.length; } })() : buf.length;
  const base = findMp4Start(buf);
  if (base > 0) buf = buf.subarray(base);
  const info = { size: fullSize, sampleRate: 0, channels: 0, durationSec: 0, kbps: 0, codec: '', hasAudio: false, hasVideo: false, videoCodec: '', mp4Offset: base };
  const boxAt = (off) => {
    if (off + 8 > buf.length) return null;
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let head = 8;
    if (size === 1) {
      if (off + 16 > buf.length) return null;
      size = Number(buf.readBigUInt64BE(off + 8)); head = 16;
    } else if (size === 0) size = buf.length - off;
    if (size < head || off + size > buf.length) return null;
    return { type, size, head, start: off, body: off + head, end: off + size };
  };
  const kids = (b, from) => {
    const arr = []; let o = (from != null ? from : b.body);
    while (o < b.end) { const c = boxAt(o); if (!c) break; arr.push(c); o = c.start + c.size; }
    return arr;
  };
  const pick = (list, t) => list.find((b) => b.type === t);
  const top = [];
  { let o = 0; while (o < buf.length) { const b = boxAt(o); if (!b) break; top.push(b); o = b.start + b.size; } }
  let timescale = 0, mdhdDur = 0, mediaTs = 0;
  const moov = pick(top, 'moov');
  if (moov) {
    const mvhd = pick(kids(moov), 'mvhd');
    if (mvhd) {
      const ver = buf.readUInt8(mvhd.body);
      timescale = ver === 1 ? buf.readUInt32BE(mvhd.body + 20) : buf.readUInt32BE(mvhd.body + 12);
      const dur = ver === 1 ? Number(buf.readBigUInt64BE(mvhd.body + 24)) : buf.readUInt32BE(mvhd.body + 16);
      if (timescale) info.durationSec = dur / timescale;
    }
    for (const trak of kids(moov).filter((b) => b.type === 'trak')) {
      const mdia = pick(kids(trak), 'mdia');
      if (!mdia) continue;
      const mdhd = pick(kids(mdia), 'mdhd');
      if (mdhd) {
        const ver = buf.readUInt8(mdhd.body);
        const ts = ver === 1 ? buf.readUInt32BE(mdhd.body + 20) : buf.readUInt32BE(mdhd.body + 12);
        const du = ver === 1 ? Number(buf.readBigUInt64BE(mdhd.body + 24)) : buf.readUInt32BE(mdhd.body + 16);
        // 关键：trun 里的采样时长用【轨道时基 mdhd】（音频通常 44100），不是 mvhd 的影片时基（通常 1000）。
        // 用错的话，20 秒会被算成 883 秒，码率就变成 4kbps。
        if (ts) mediaTs = ts;
        if (ts && du) mdhdDur = du / ts;
      }
      const minf = pick(kids(mdia), 'minf');
      const stbl = minf ? pick(kids(minf), 'stbl') : null;
      const stsd = stbl ? pick(kids(stbl), 'stsd') : null;
      if (!stsd) continue;
      // stsd: version/flags(4) + entry_count(4)，之后是 sample entry
      for (const e of kids(stsd, stsd.body + 8)) {
        if (e.type === 'mp4a' || e.type === 'enca' || e.type === 'ac-3' || e.type === 'ec-3' || e.type === 'Opus' || e.type === 'fLaC' || e.type === 'alac') {
          info.hasAudio = true;
          info.codec = e.type === 'Opus' ? 'Opus' : (e.type === 'fLaC' ? 'FLAC' : (e.type === 'alac' ? 'ALAC' : 'AAC'));
          if (e.type === 'Opus') { info.channels = buf.readUInt16BE(e.body + 16); info.sampleRate = 48000; }
          else {
            info.channels = buf.readUInt16BE(e.body + 16);
            const sr = buf.readUInt32BE(e.body + 24);      // 16.16 定点
            info.sampleRate = sr >>> 16;
          }
        } else if (e.type === 'avc1' || e.type === 'avc3' || e.type === 'hvc1' || e.type === 'hev1' || e.type === 'vp09' || e.type === 'av01' || e.type === 'encv' || e.type === 'mp4v') {
          info.hasVideo = true;
          info.videoCodec = e.type;
        }
      }
    }
  }
  if (info.durationSec <= 0 && mdhdDur > 0) info.durationSec = mdhdDur;
  if (info.durationSec <= 0) {
    // 分片 mp4：累加所有 trun 的采样时长
    let total = 0, ts = mediaTs || timescale;
    for (const moof of top.filter((b) => b.type === 'moof')) {
      for (const traf of kids(moof).filter((b) => b.type === 'traf')) {
        let defDur = 0;
        const tfhd = pick(kids(traf), 'tfhd');
        if (tfhd) {
          const fl = buf.readUInt32BE(tfhd.body) & 0xFFFFFF;
          let o = tfhd.body + 4;
          if (fl & 0x01) o += 8;
          if (fl & 0x02) o += 4;
          if (fl & 0x08) defDur = buf.readUInt32BE(o);
        }
        for (const trun of kids(traf).filter((b) => b.type === 'trun')) {
          const fl = buf.readUInt32BE(trun.body) & 0xFFFFFF;
          const cnt = buf.readUInt32BE(trun.body + 4);
          let o = trun.body + 8;
          if (fl & 0x01) o += 4;
          if (fl & 0x04) o += 4;
          for (let i = 0; i < cnt; i++) {
            if (fl & 0x100) { total += buf.readUInt32BE(o); o += 4; } else { total += defDur; }
            if (fl & 0x200) o += 4;
            if (fl & 0x400) o += 4;
            if (fl & 0x800) o += 4;
          }
        }
      }
    }
    if (total > 0 && ts) info.durationSec = total / ts;
  }
  if (info.durationSec > 0) info.kbps = Math.round((fullSize * 8) / info.durationSec / 1000);
  /* kind：只按内容判定，文件名完全不参与。
     视频轨存在但没有音频轨 → 'video'；有音频轨 → 'audio'（B 站的 audio.m4s 是纯音频，
     但也有工具会把音视频各存一份同名碎片，这里以"有没有音频轨"为准）。 */
  info.kind = info.hasAudio ? 'audio' : (info.hasVideo ? 'video' : 'other');
  return info;
}


/* 主入口：给一个文件夹，返回 [{ title, artist, uploader, audioPath, path, cover, folder, rawTitle }] */
async function scan(rootDir, opts) {
  if (!opts || !opts.userDataDir) throw new Error('scan 需要 opts.userDataDir');
  const out = [];
  const found = collect(rootDir);
  // 所有候选逐个读内容判定类型（结果进 kindCache，同一文件只读一次）
  const audioFiles = [], videoFiles = [], otherFiles = [];
  for (const c of found.cands) {
    const k = sniffKind(c);
    if (k.kind === 'audio') audioFiles.push(c);
    else if (k.kind === 'video') videoFiles.push(c);
    else otherFiles.push(c);
  }
  const used = new Set();
  /* 元数据文件去重：电脑端同一目录里同时有 videoInfo.json 和 .videoInfo（内容一模一样），
     不去重会导成两首歌。每个目录只保留一个，优先 videoInfo.json。 */
  const metaPaths = [];
  const seenDir = new Map();
  for (const ep of found.entries) {
    const d = path.dirname(ep);
    const name = path.basename(ep).toLowerCase();
    const prev = seenDir.get(d);
    if (!prev) { seenDir.set(d, ep); metaPaths.push(ep); }
    else if (name === 'videoinfo.json' && path.basename(prev).toLowerCase() !== 'videoinfo.json') {
      const i = metaPaths.indexOf(prev);
      metaPaths[i] = ep; seenDir.set(d, ep);
    }
  }
  for (const ep of metaPaths) {
    const dir = path.dirname(ep);
    const meta = readJsonSafe(ep) || {};
    /* 两种布局：
       ① 手机端 entry.json：page_data.part / user_info.uname / cover
       ② 电脑端 videoInfo.json：title / uname / coverUrl / groupTitle / duration
          （实测示例：title "【Milthm】PYKAMIA - Fantasia Sonata Reflection"、
            uname "PYKAMIA搬运站"、groupTitle "Fantasia Sonata系列"、duration 132） */
    const isPc = /^\.?videoInfo.*\.json$/i.test(path.basename(ep));
    const pd = meta.page_data || {};
    const epObj = meta.ep || {};
    const partStr = pd.part ? String(pd.part).trim() : '';
    const raw = isPc
      ? (meta.title || meta.groupTitle || path.basename(dir))
      : ((partStr && !/^p?\d+$/i.test(partStr)) ? partStr : (meta.title || epObj.title || path.basename(dir)));
    const uname = isPc
      ? (meta.uname || '')
      : ((meta.user_info && meta.user_info.uname) || (meta.owner && meta.owner.name) || epObj.up_name || '');
    const coverUrl = isPc
      ? (meta.coverUrl || meta.groupCoverUrl || '')
      : (meta.cover || epObj.cover || meta.pic || '');
    const pick = pickBestAudio(dir, audioFiles);
    if (!pick.best) continue;
    const audio = pick.best.path;
    const link = ensureM4a(audio, opts.userDataDir);
    if (!link) continue;
    used.add(audio);
    const parsed = parseBiliTitle(raw, uname);
    const cover = await resolveCover(dir, coverUrl, opts);
    const q = probeM4a(audio) || {};
    out.push({
      title: parsed.title,
      artist: parsed.artist || uname || '未知艺术家',
      uploader: uname,
      album: (isPc && meta.groupTitle ? String(meta.groupTitle) : 'B站缓存') + (q.kbps ? ` · ${q.kbps}k` : ''),
      audioPath: audio,
      path: toFileUrl(link),
      cover: cover || null,
      folder: dir,
      durationHint: isPc && meta.duration ? Number(meta.duration) : 0,
      rawTitle: raw,
      // 音质信息 + 备选音轨（同集若有更高音质，界面上可以提示/替换）
      quality: {
        kbps: q.kbps || 0,
        sampleRate: q.sampleRate || 0,
        channels: q.channels || 0,
        durationSec: Math.round(q.durationSec || 0),
        codec: q.codec || '',
        tag: pick.best.tag,
        bytes: pick.best.size,
        candidates: pick.all.length,
        others: pick.all.slice(1).map((c) => ({ tag: c.tag, bytes: c.size, kbps: 0, path: c.path }))
      }
    });
  }
  // 没有 entry.json、只有音频文件的目录：用文件夹名兜底。
  // 必须跳过"已被某个 entry 处理过"的目录里的落选候选 —— 否则同一集里没被选中的
  // 第二个音轨会掉进这里，多出一首"未知歌曲"（实测：一个 entry 目录里两个音轨就多出 1 条垃圾）。
  const entryDirs = found.entries.map((ep) => path.dirname(ep));
  const underEntry = (p) => entryDirs.some((d) => p.indexOf(d + path.sep) === 0);
  for (const a of audioFiles) {
    if (used.has(a)) continue;
    if (underEntry(a)) continue;
    const dir = path.dirname(a);
    let name = path.basename(dir);
    if (/^\d+$/.test(name) || /^[0-9a-f]{16,}$/i.test(name)) name = '';
    const parsed = parseBiliTitle(name);
    const link = ensureM4a(a, opts.userDataDir);
    if (!link) continue;
    out.push({
      title: parsed.title,
      artist: parsed.artist || '未知艺术家',
      uploader: '',
      album: (probeM4a(a) || {}).kbps ? ('B站缓存 ' + (probeM4a(a) || {}).kbps + 'k') : 'B站缓存',
      audioPath: a,
      path: toFileUrl(link),
      cover: await resolveCover(dir, '', opts),
      folder: dir,
      rawTitle: name,
      quality: (function () { const q = probeM4a(a) || {}; return { kbps: q.kbps || 0, sampleRate: q.sampleRate || 0, channels: q.channels || 0, durationSec: Math.round(q.durationSec || 0), codec: q.codec || '', tag: path.basename(dir), bytes: q.size || 0, candidates: 1, others: [] }; })()
    });
  }
  return out;
}

module.exports = { scan: scan, parseBiliTitle: parseBiliTitle, stripNoise: stripNoise, ensureM4a: ensureM4a };
