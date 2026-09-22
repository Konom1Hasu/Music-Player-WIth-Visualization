/* ================= 内嵌封面提取（纯逻辑，无 electron 依赖，可单独 node 测试） =================
   支持：
     · MP3 / ID3v1 时代以后的 ID3v2.2(PIC) · ID3v2.3/2.4(APIC)
     · FLAC 的 PICTURE 元数据块
     · M4A / MP4 的 moov.udta.meta.ilist.covr（moov 在文件末尾也能捞到）
     · OGG / Opus 的 METADATA_BLOCK_PICTURE / COVERART 注释
     · WAV / AIFF 里的 id3 块
     · APE 标签的 Cover Art (Front)
     · 全部落空时，退回"同目录/上级目录里叫 cover/folder/front… 的图片"
   设计原则（都是踩过的坑）：
     1. 不信任标签里写的长度：一律用图片自身的魔术字节确认类型，并按结束标记（JPEG FFD9 / PNG IEND）
        裁掉尾巴上的垃圾字节 —— 有些打标工具会把长度写大。
     2. 封面可能落在"头部读到的范围之外"（大 padding 块、moov 在末尾、APE 尾部标签），
        所以文件级接口会：先读头部 → 拿到结构后按需精确补读 → 再读尾部兜底。
     3. 一处失败不影响其它格式：各解析器互相独立，返回 null 就继续下一个。
*/
const fs = require('fs');
const path = require('path');

const MAX_IMAGE = 16 * 1024 * 1024;   // 超过这个大小的"图"基本是解析错了
const MIN_IMAGE = 512;

/* ---------------- 图片识别与裁剪 ---------------- */
function sniffImageMime(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4D) return 'image/bmp';
  return null;
}
/* 按结束标记裁掉尾部垃圾（长度写大了、后面还挂着别的数据等情况） */
function trimImage(b, mime) {
  if (!b || !b.length) return b;
  if (mime === 'image/jpeg') {
    for (let i = b.length - 2; i > 16; i--) if (b[i] === 0xFF && b[i + 1] === 0xD9) return b.subarray(0, i + 2);
  } else if (mime === 'image/png') {
    const i = b.indexOf('IEND', 8, 'latin1');
    if (i > 0) return b.subarray(0, i + 8);
  } else if (mime === 'image/gif') {
    for (let i = b.length - 1; i > 8; i--) if (b[i] === 0x3B) return b.subarray(0, i + 1);
  }
  return b;
}
/* 图片是否带正常结束标记（JPEG 的 FFD9 / PNG 的 IEND / GIF 的 3B）。
   用途：帧长被读错时会切出一张"看着像图但被截断"的残图，
   残图不能赢过完整图 —— 见 pickBest。 */
function hasEndMarker(b, mime) {
  if (!b || b.length < 32) return false;
  if (mime === 'image/jpeg') {
    for (let i = b.length - 2; i > b.length - 512 && i > 16; i--) if (b[i] === 0xFF && b[i + 1] === 0xD9) return true;
    return false;
  }
  if (mime === 'image/png') return b.indexOf('IEND', 8, 'latin1') > 0;
  if (mime === 'image/gif') return b[b.length - 1] === 0x3B;
  return true;
}
function makeResult(bytes, mime, source, extra) {
  if (!bytes || bytes.length < MIN_IMAGE || bytes.length > MAX_IMAGE) return null;
  const m = sniffImageMime(bytes) || mime;
  if (!m) return null;
  const complete = hasEndMarker(bytes, m);
  const cut = trimImage(bytes, m);
  return Object.assign({ bytes: Buffer.from(cut), mime: m, source: source, complete: complete }, extra || {});
}
/* 多个候选（多张 APIC、两遍解析结果等）里挑最可靠的：
   完整图 > 残图；同一档里正面封面(类型 3)优先，再看尺寸（尺寸≈画质） */
function pickBest(list) {
  const scored = (list || []).filter(x => x && x.bytes);
  if (!scored.length) return null;
  scored.sort((a, b) =>
    ((b.complete ? 1 : 0) - (a.complete ? 1 : 0)) ||
    ((b.picType === 3 ? 1 : 0) - (a.picType === 3 ? 1 : 0)) ||
    (b.bytes.length - a.bytes.length));
  return scored[0];
}

/* ---------------- ID3v2（MP3 / WAV 的 id3 块 / AIFF） ---------------- */
function syncsafe(b, o) {
  return ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
}
function deUnsync(b) {
  const out = Buffer.alloc(b.length);
  let n = 0;
  for (let i = 0; i < b.length; i++) {
    out[n++] = b[i];
    if (b[i] === 0xFF && b[i + 1] === 0x00) i++;   // FF 00 → FF
  }
  return out.subarray(0, n);
}
/* APIC(ID3v2.3/2.4): 编码(1) mime(latin1 NUL 结尾) 图片类型(1) 描述(编码相关) 图片数据 */
function parseApic(fb) {
  if (fb.length < 16) return null;
  const enc = fb[0];
  let p = 1;
  while (p < fb.length && fb[p] !== 0) p++;
  const mime = fb.toString('latin1', 1, p).toLowerCase();
  p++;                                  // 跳过 mime 结尾的 0
  const picType = fb[p]; p++;           // 图片类型（3 = 正面封面）
  if (enc === 1 || enc === 2) {         // UTF-16：描述按双字节找 0000
    while (p + 1 < fb.length && !(fb[p] === 0 && fb[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    while (p < fb.length && fb[p] !== 0) p++;
    p++;
  }
  return { data: fb.subarray(p), mime: /^image\//.test(mime) ? mime : '', picType: picType };
}
/* PIC(ID3v2.2): 编码(1) 格式(3, 如 JPG/PNG) 图片类型(1) 描述 图片数据 */
function parsePic(fb) {
  if (fb.length < 12) return null;
  const enc = fb[0];
  const fmt = fb.toString('latin1', 1, 4).toUpperCase();
  const picType = fb[4];
  let p = 5;
  if (enc === 1 || enc === 2) {
    while (p + 1 < fb.length && !(fb[p] === 0 && fb[p + 1] === 0)) p += 2;
    p += 2;
  } else {
    while (p < fb.length && fb[p] !== 0) p++;
    p++;
  }
  const mime = fmt === 'PNG' ? 'image/png' : fmt === 'GIF' ? 'image/gif' : 'image/jpeg';
  return { data: fb.subarray(p), mime: mime, picType: picType };
}
/* ID3v2.4 的帧长按规范是 syncsafe，但**现实中不少打标工具写的是普通大端**
   （于是 5MB 的帧被读成 1.25MB，帧链一断，后面的封面就永远找不到）。
   单遍推断在"错值恰好也落在像帧名的字节上"时无解，所以 findId3Cover 会走两遍：
   先按规范 syncsafe 整链走一遍，走不出封面就按普通大端再走一遍，谁先拿到封面用谁。 */
function pickFrameSize(region, q, ver, bodyStart, mode) {
  const len = region.length;
  const plain = region.readUInt32BE(q + 4);
  if (ver !== 4) return plain;
  const ss = syncsafe(region, q + 4);
  if (mode === 'plain') return plain;
  if (mode === 'syncsafe') return ss;
  if (ss === plain) return ss;
  const endsOk = (s) => {
    const at = bodyStart + s;
    if (s <= 0 || at > len) return false;
    if (at + 4 > len) return true;                                  // 正好到（读到的）标签末尾
    return /^[A-Z0-9]{4}$/.test(region.toString('latin1', at, at + 4));
  };
  if (endsOk(ss)) return ss;                                        // 规范写法优先
  if (endsOk(plain)) return plain;                                  // 容错：普通大端
  return ss;
}

/* 在 buf 的 off 处解析 ID3v2 标签，返回封面 */
function findId3Cover(buf, off, sourceTag, sizeMode) {
  off = off || 0;
  if (buf.length < off + 10 || buf.toString('latin1', off, off + 3) !== 'ID3') return null;
  const ver = buf[off + 3], flags = buf[off + 5];
  if (ver < 2 || ver > 4) return null;
  const tagSize = syncsafe(buf, off + 6);
  const tagEnd = off + 10 + tagSize;
  let p = off + 10;
  if (flags & 0x40) {                                  // 扩展头
    if (ver >= 4) p += syncsafe(buf, p);
    else p += 4 + buf.readUInt32BE(p);
  }
  const avail = Math.min(tagEnd, buf.length);
  let region = buf.subarray(p, avail);
  if (flags & 0x80) region = deUnsync(region);         // 整标签去同步（v2.2/2.3）
  const modes = sizeMode ? [sizeMode] : (ver === 4 ? ['syncsafe', 'plain'] : ['syncsafe']);
  const found = [];
  for (const mode of modes) {
    const list = walkId3Frames(region, ver, sourceTag, mode);
    if (list.length) found.push.apply(found, list);
  }
  return pickBest(found);
}
function walkId3Frames(region, ver, sourceTag, sizeMode) {
  const out = [];
  let q = 0;
  const lead = ver < 3 ? 6 : 10;
  const idRe = ver < 3 ? /^[A-Z0-9]{3}$/ : /^[A-Z0-9]{4}$/;
  while (q + lead <= region.length) {
    const id = region.toString('latin1', q, q + (ver < 3 ? 3 : 4));
    if (!idRe.test(id)) break;
    let fsize, fflags = 0;
    if (ver < 3) fsize = (region[q + 3] << 16) | (region[q + 4] << 8) | region[q + 5];
    else {
      fsize = pickFrameSize(region, q, ver, q + lead, sizeMode);
      fflags = region.readUInt16BE(q + 8);
    }
    const bodyStart = q + lead;
    if (fsize <= 0) { q = bodyStart; continue; }
    if (bodyStart + fsize > region.length) break;      // 帧体超出（封面在更后面）：交给文件级精确读取
    let fb = region.subarray(bodyStart, bodyStart + fsize);
    if (ver === 4 && (fflags & 0x02)) fb = deUnsync(fb);   // v2.4 帧级去同步
    if (id === 'APIC' || id === 'PIC') {
      const c = id === 'APIC' ? parseApic(fb) : parsePic(fb);
      if (c) { const r = makeResult(c.data, c.mime, sourceTag, { picType: c.picType }); if (r) out.push(r); }
    }
    q = bodyStart + fsize;
  }
  return out;
}

/* ---------------- FLAC PICTURE 块 ---------------- */
function parseFlacPicture(b) {
  if (b.length < 32) return null;
  try {
    const picType = b.readUInt32BE(0);
    const mimeLen = b.readUInt32BE(4);
    if (mimeLen > 256) return null;
    const mime = b.toString('latin1', 8, 8 + mimeLen).toLowerCase();
    let p = 8 + mimeLen;
    const descLen = b.readUInt32BE(p); p += 4 + descLen;
    p += 16;                                  // 宽 高 色深 色数
    const dataLen = b.readUInt32BE(p); p += 4;
    if (dataLen <= 0 || dataLen > MAX_IMAGE) return null;
    const data = b.subarray(p, Math.min(p + dataLen, b.length));
    return { data: data, mime: /^image\//.test(mime) ? mime : '', picType: picType };
  } catch (e) { return null; }
}
function findFlacCover(buf, off, sourceTag) {
  off = off || 0;
  if (buf.length < off + 8 || buf.toString('latin1', off, off + 4) !== 'fLaC') return null;
  const cand = [];
  let p = off + 4;
  while (p + 4 <= buf.length) {
    const last = (buf[p] & 0x80) !== 0;
    const type = buf[p] & 0x7f;
    const len = (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
    const start = p + 4;
    if (start + len > buf.length) break;             // 缓冲不够：交给文件级精确读取
    if (type === 6) {
      const c = parseFlacPicture(buf.subarray(start, start + len));
      if (c) { const r = makeResult(c.data, c.mime, sourceTag, { picType: c.picType }); if (r) cand.push(r); }
    }
    p = start + len;
    if (last) break;
  }
  return pickBest(cand);
}

/* ---------------- MP4 / M4A 的 covr ---------------- */
function walkAtoms(buf, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let hdr = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      const big = buf.readUInt32BE(p + 8) * 4294967296 + buf.readUInt32BE(p + 12);
      if (!isFinite(big) || big < 16) break;
      size = big; hdr = 16;
    } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) { out.push({ type: type, body: p + hdr, end: end, declEnd: p + size, truncated: true }); break; }
    out.push({ type: type, body: p + hdr, end: p + size });
    p += size;
  }
  return out;
}
function findMp4Cover(buf, start, end, sourceTag) {
  start = start || 0;
  end = end === undefined ? buf.length : end;
  const containers = { moov: 1, udta: 1, trak: 1, mdia: 1, minf: 1, stbl: 1, ilst: 1, '----': 1 };
  for (const a of walkAtoms(buf, start, end)) {
    if (a.type === 'covr') {
      const cand = [];
      for (const d of walkAtoms(buf, a.body, a.end)) {
        if (d.type !== 'data') continue;
        let r = makeResult(buf.subarray(d.body + 8, d.end), '', sourceTag);   // 版本/标志(4) + 语言(4) 之后才是图片
        if (!r) r = makeResult(buf.subarray(d.body, d.end), '', sourceTag);
        if (r) cand.push(r);
      }
      const best = pickBest(cand);
      if (best) return best;
    } else if (containers[a.type]) {
      const r = findMp4Cover(buf, a.type === 'meta' ? a.body + 4 : a.body, a.end, sourceTag);
      if (r) return r;
    } else if (a.type === 'meta') {
      const r = findMp4Cover(buf, a.body + 4, a.end, sourceTag);
      if (r) return r;
    } else if (a.truncated) {
      return null;                                  // 原子跨出缓冲：交给文件级精确读取
    }
  }
  return null;
}

/* ---------------- OGG / Opus 的注释里那张 base64 图 ---------------- */
function findOggCover(buf, sourceTag) {
  const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const grab = (key) => {
    const at = buf.indexOf(key, 0, 'latin1');
    if (at < 0) return null;
    let p = at + key.length;
    while (p < buf.length && (b64.indexOf(String.fromCharCode(buf[p])) >= 0 || buf[p] === 0x3D)) p++;
    const s = buf.toString('latin1', at + key.length, p).replace(/=+$/, '');
    if (s.length < 64) return null;
    try { return Buffer.from(s, 'base64'); } catch (e) { return null; }
  };
  let raw = grab('METADATA_BLOCK_PICTURE=');
  if (raw) { const c = parseFlacPicture(raw); if (c) { const r = makeResult(c.data, c.mime, sourceTag, { picType: c.picType }); if (r) return r; } }
  raw = grab('COVERART=');
  if (raw) { const r = makeResult(raw, '', sourceTag); if (r) return r; }
  return null;
}

/* ---------------- WAV / AIFF 里的 id3 块 ---------------- */
function findRiffCover(buf, sourceTag) {
  const tag = buf.toString('latin1', 0, 4);
  if (tag !== 'RIFF' && tag !== 'FORM') return null;
  let p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString('latin1', p, p + 4);
    let size = buf.readUInt32LE(p + 4);
    if (tag === 'FORM') size = buf.readUInt32BE(p + 4);
    if (size < 0 || p + 8 + size > buf.length) break;
    if (id === 'id3 ' || id === 'ID3 ' || id === 'id32') {
      const r = findId3Cover(buf.subarray(p + 8, p + 8 + size), 0, sourceTag);
      if (r) return r;
    }
    p += 8 + size + (size % 2);
  }
  return null;
}

/* ---------------- APE 尾部标签的 Cover Art (Front) ---------------- */
function findApeCover(buf, sourceTag) {
  const at = buf.lastIndexOf(Buffer.from('APETAGEX', 'latin1'));
  if (at < 0 || at + 32 > buf.length) return null;
  try {
    const tagSize = buf.readUInt32LE(at + 12);
    const count = buf.readUInt32LE(at + 16);
    if (tagSize < 32 || count <= 0 || count > 256) return null;
    let p = at - (tagSize - 32);                     // 条目区在 footer 之前
    if (p < 0) return null;
    for (let i = 0; i < count && p + 8 <= at; i++) {
      const vlen = buf.readUInt32LE(p);
      p += 8;
      let e = p; while (e < buf.length && buf[e] !== 0) e++;
      const key = buf.toString('latin1', p, e);
      p = e + 1;
      if (vlen < 0 || p + vlen > buf.length) break;
      if (/^cover art/i.test(key)) {
        const val = buf.subarray(p, p + vlen);
        const z = val.indexOf(0, 0, 'latin1');       // 值是"文件名 00 图片数据"
        const data = z >= 0 && z < 260 ? val.subarray(z + 1) : val;
        const r = makeResult(data, '', sourceTag + ':ape');
        if (r) return r;
      }
      p += vlen;
    }
  } catch (e) { /* ignore */ }
  return null;
}

/* ---------------- 按内容分发（不只看扩展名） ---------------- */
function extractFromBuffer(buf, ext, opts) {
  opts = opts || {};
  const tag = opts.source || 'embedded';
  if (!buf || buf.length < 32) return null;
  const e = String(ext || '').toLowerCase().replace(/^\./, '');
  const magic4 = buf.toString('latin1', 0, 4);
  const tries = [];
  if (magic4 === 'fLaC' || e === 'flac') tries.push(() => findFlacCover(buf, 0, tag + ':flac'));
  if (buf.toString('latin1', 0, 3) === 'ID3' || e === 'mp3') tries.push(() => findId3Cover(buf, 0, tag + ':id3v2'));
  if (magic4 === 'RIFF' || magic4 === 'FORM' || e === 'wav' || e === 'aiff' || e === 'aif') tries.push(() => findRiffCover(buf, tag + ':riff'));
  if (buf.toString('latin1', 4, 8) === 'ftyp' || e === 'm4a' || e === 'mp4' || e === 'm4b' || e === 'aac' || e === 'mov') tries.push(() => findMp4Cover(buf, 0, buf.length, tag + ':mp4'));
  if (magic4 === 'OggS' || e === 'ogg' || e === 'opus' || e === 'oga') tries.push(() => findOggCover(buf, tag + ':vorbis'));
  tries.push(() => findApeCover(buf, tag));                       // APE 尾标签（有的 mp3/flac 也挂）
  tries.push(() => findId3Cover(buf, 0, tag + ':id3v2'));          // 扩展名不对但其实是 ID3（少数 m4a/wav 会改名）
  for (const t of tries) {
    let r = null;
    try { r = t(); } catch (err) { r = null; }
    if (r && r.bytes) return r;
    if (r && r.incomplete) return r;                              // 让上层补读
  }
  return null;
}

/* ---------------- 同目录的封面图片（没有内嵌图时的兜底） ---------------- */
const SIBLING_NAMES = ['cover', 'folder', 'front', 'album', 'albumart', 'artwork', 'thumb', 'image', 'poster', '封面'];
const IMG_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
function findSiblingCover(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath, path.extname(filePath));
  const dirs = [dir, path.dirname(dir)];
  for (const d of dirs) {
    let names = null;
    try { names = fs.readdirSync(d); } catch (e) { continue; }
    const lower = names.map(n => n.toLowerCase());
    const pick = (want) => {
      for (const ext of IMG_EXTS) {
        const i = lower.indexOf((want + ext).toLowerCase());
        if (i >= 0) return path.join(d, names[i]);
      }
      return null;
    };
    let hit = pick(base);
    if (!hit) for (const n of SIBLING_NAMES) { hit = pick(n); if (hit) break; }
    if (hit) {
      try {
        const st = fs.statSync(hit);
        if (st.size < MIN_IMAGE || st.size > MAX_IMAGE) continue;
        const bytes = fs.readFileSync(hit);
        const r = makeResult(bytes, '', 'sibling');
        if (r) { r.file = hit; return r; }
      } catch (e) { /* continue */ }
    }
  }
  return null;
}

/* ---------------- 文件级接口 ---------------- */
function readAt(fd, offset, len) {
  const b = Buffer.alloc(Math.max(0, len));
  if (!b.length) return b;
  try { fs.readSync(fd, b, 0, b.length, offset); } catch (e) { return b; }
  return b;
}
const readU32 = (fd, off) => { const b = readAt(fd, off, 4); return b.length < 4 ? -1 : b.readUInt32BE(0); };

/* ID3v2 标签比头部缓冲还大：按标签声明的长度精确读一次（上限 32MB，防坏标签让我们读整盘） */
function id3CoverFromFd(fd, size, sourceTag) {
  const h = readAt(fd, 0, 10);
  if (h.length < 10 || h.toString('latin1', 0, 3) !== 'ID3') return null;
  const tagSize = syncsafe(h, 6);
  const total = 10 + tagSize;
  if (total <= 10 || total > 32 * 1024 * 1024 || total > size) return null;
  return findId3Cover(readAt(fd, 0, total), 0, (sourceTag || 'file') + ':id3v2');
}
/* FLAC：只按块头 seek 走一遍元数据链，只在遇到 PICTURE 时才读块体（大 PADDING 也不会白读） */
function flacCoverFromFd(fd, size, sourceTag) {
  const magic = readAt(fd, 0, 4);
  if (magic.toString('latin1', 0, 4) !== 'fLaC') return null;
  let p = 4, best = null, guard = 0;
  while (p + 4 <= size && guard++ < 512) {
    const h = readAt(fd, p, 4);
    if (h.length < 4) break;
    const last = (h[0] & 0x80) !== 0, type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    if (type === 6) {
      if (len <= 0 || len > MAX_IMAGE + 4096) return best;
      const c = parseFlacPicture(readAt(fd, p + 4, len));
      if (c) {
        const r = makeResult(c.data, c.mime, (sourceTag || 'file') + ':flac', { picType: c.picType });
        if (r) { if (c.picType === 3) return r; if (!best) best = r; }
      }
    }
    p += 4 + len;
    if (last) break;
  }
  return best;
}
/* MP4/M4A：按顶层原子 seek 走一遍，只在 moov 处读它的内容（moov 在文件末尾同样能找到） */
function mp4CoverFromFd(fd, size, sourceTag) {
  let p = 0, guard = 0;
  while (p + 8 <= size && guard++ < 4096) {
    const h = readAt(fd, p, 16);
    if (h.length < 8) break;
    let aSize = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    let hdr = 8;
    if (aSize === 1) {
      if (h.length < 16) break;
      aSize = h.readUInt32BE(8) * 4294967296 + h.readUInt32BE(12);
      hdr = 16;
    } else if (aSize === 0) aSize = size - p;
    if (aSize < hdr || p + aSize > size) break;
    if (type === 'moov') {
      const body = readAt(fd, p + hdr, Math.min(aSize - hdr, 32 * 1024 * 1024));
      const r = findMp4Cover(body, 0, body.length, (sourceTag || 'file') + ':mp4');
      if (r && r.bytes) return r;
    }
    p += aSize;
  }
  return null;
}
/* opts: { path, bytes, name, headBytes, tailBytes }
   返回 { bytes, mime, source, picType? } 或 null（不抛异常，交给调用方 toast）
   顺序：头部缓冲 → 按格式精确 walk（大标签/大 padding/moov 在末尾）→ 尾部缓冲 → 同目录图片 */
function extractCover(opts) {
  opts = opts || {};
  const headBytes = opts.headBytes || 4 * 1024 * 1024;
  const tailBytes = opts.tailBytes || 2 * 1024 * 1024;
  const ext = path.extname(opts.name || opts.path || '');

  if (opts.bytes) {                                   // 渲染层给的内存数据（用户手选文件）
    const buf = Buffer.from(opts.bytes);
    const r = extractFromBuffer(buf, ext, { source: 'file' });
    return r && r.bytes ? r : null;
  }
  if (!opts.path) return null;
  const st = fs.statSync(opts.path);
  if (!st.isFile() || st.size < 128) return null;
  const fd = fs.openSync(opts.path, 'r');
  try {
    const head = readAt(fd, 0, Math.min(st.size, headBytes));
    let r = extractFromBuffer(head, ext, { source: 'file' });
    if (r && r.bytes) return r;
    const magic4 = head.toString('latin1', 0, 4);
    const magic3 = head.toString('latin1', 0, 3);
    if (magic3 === 'ID3' || /mp3/i.test(ext)) { r = id3CoverFromFd(fd, st.size, 'file'); if (r && r.bytes) return r; }
    if (magic4 === 'fLaC' || /flac/i.test(ext)) { r = flacCoverFromFd(fd, st.size, 'file'); if (r && r.bytes) return r; }
    if (head.toString('latin1', 4, 8) === 'ftyp' || /^(m4a|mp4|m4b|aac|mov)$/i.test(ext.replace(/^\./, ''))) {
      r = mp4CoverFromFd(fd, st.size, 'file'); if (r && r.bytes) return r;
    }
    /* 尾部兜底：APE 标签整块挂在末尾；也有把 ID3v2 画在尾部、或者 mdat 后面挂图的怪文件 */
    if (st.size > head.length) {
      const tLen = Math.min(st.size, tailBytes);
      const tail = readAt(fd, st.size - tLen, tLen);
      const r3 = extractFromBuffer(tail, ext, { source: 'file:tail' });
      if (r3 && r3.bytes) return r3;
    }
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* ignore */ }
  }
  return findSiblingCover(opts.path);                 // 最后才退回同目录图片
}

module.exports = {
  sniffImageMime, trimImage, extractCover, extractFromBuffer,
  findId3Cover, findFlacCover, findMp4Cover, findOggCover, findRiffCover, findApeCover,
  findSiblingCover, parseFlacPicture,
};
