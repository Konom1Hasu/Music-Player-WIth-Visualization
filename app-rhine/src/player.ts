// 音乐播放器：把本地音乐库映射成"档案"，驱动三维档案阵列，并提供传输控制。
// 后端能力（NCM 解密 / B 站缓存 / 读封面 / 歌词 / 读音频）复用 Electron 的 window.desktop。
import { setRecords, type ArchiveRecord } from "./data";
import { Spectrum, analysisWindow, SPECTRUM_WINDOW, SPECTRUM_BANDS, type SpectrumPalette } from "./spectrum";

export interface Song {
  id: string;
  file?: File;
  srcUrl?: string;
  path?: string;
  filePath?: string;
  ncmPath?: string;
  title: string;
  artist: string;
  album: string;
  cover?: string;
  duration: number;
  fav: boolean;
  plays: number;
  pos: number;
  lrc?: string;
  order: number;
}

const desktop = (window as any).desktop as
  | {
      convertNcm?: (buf: ArrayBuffer) => Promise<any>;
      readCover?: (arg: { path: string }) => Promise<any>;
      findLyrics?: (p: string, t: string, a: string) => Promise<string | null>;
      scanBiliCache?: () => Promise<any>;
      readAudio?: (p: string) => Promise<any>;
    }
  | undefined;

let songs: Song[] = [];
let currentId: string | null = null;
let mode = "list"; // list | order | single | shuffle
/* 诊断开关：URL 参数或 localStorage（探针页刷新后仍要生效，于是也认 localStorage）。
   只把内部对象挂到 window 上，不改变任何播放 / 频谱行为。 */
const LS_VIZ_TEST = (() => {
  try {
    return localStorage.getItem("rhine-viztest") === "1";
  } catch {
    return false;
  }
})();
const LS_DIAG = (() => {
  try {
    return localStorage.getItem("rhine-diag") === "1";
  } catch {
    return false;
  }
})();
const VIZ_TEST = new URLSearchParams(location.search).get("viztest") === "1" || LS_VIZ_TEST;
const DIAG = new URLSearchParams(location.search).get("diag") === "1" || LS_DIAG;
const LIB_LOAD_TIMEOUT = 8000;
let orderSeq = 0;
let currentUrl: string | null = null;
let pendingSeek = 0;
let posSavedAt = 0;
const audio = new Audio();
audio.preload = "metadata";
const listeners: (() => void)[] = [];

export function onLibraryChange(fn: () => void) {
  listeners.push(fn);
}
function notify() {
  syncRecords();
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      /* ignore */
    }
  });
}
export function getSongs(): Song[] {
  return songs;
}
export function currentSong(): Song | null {
  return songs.find((s) => s.id === currentId) ?? null;
}
export function currentIndex(): number {
  return songs.findIndex((s) => s.id === currentId);
}
export function isPlaying(): boolean {
  return !audio.paused;
}
export function currentTime(): number {
  return audio.currentTime || 0;
}
export function duration(): number {
  return audio.duration || 0;
}
export function playMode(): string {
  return mode;
}

/* ---------- 持久化（IndexedDB 存 File blob + 封面） ---------- */
const idb = (() => {
  let db: IDBDatabase | null = null;
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      if (db) return resolve(db);
      const req = indexedDB.open("rhine-music", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("songs", { keyPath: "id" });
      req.onsuccess = () => {
        db = req.result;
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
  return {
    async put(s: Song) {
      const d = await open();
      return new Promise<void>((res, rej) => {
        const t = d.transaction("songs", "readwrite");
        t.objectStore("songs").put(s);
        t.oncomplete = () => res();
        t.onerror = () => rej(t.error);
      });
    },
    async del(id: string) {
      const d = await open();
      return new Promise<void>((res, rej) => {
        const t = d.transaction("songs", "readwrite");
        t.objectStore("songs").delete(id);
        t.oncomplete = () => res();
        t.onerror = () => rej(t.error);
      });
    },
    async all(): Promise<Song[]> {
      const d = await open();
      return new Promise((res, rej) => {
        const t = d.transaction("songs", "readonly");
        const r = t.objectStore("songs").getAll();
        r.onsuccess = () => res((r.result as Song[]) || []);
        r.onerror = () => rej(r.error);
      });
    },
  };
})();
const persist = (s: Song) => {
  idb.put(s).catch(() => {});
};

/* ---------- 工具 ---------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s: string) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
const niceName = (name: string) => {
  const base = name.replace(/\.[^.]+$/, "");
  const m = base.split(/\s+-\s+/);
  return m.length >= 2 ? { artist: m[0].trim(), title: m.slice(1).join(" - ").trim() } : { artist: "", title: base };
};
function defaultCover(title: string, artist: string) {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const g = c.getContext("2d")!;
  const grd = g.createLinearGradient(0, 0, 256, 256);
  grd.addColorStop(0, "#f0eae3");
  grd.addColorStop(1, "#a3754a");
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = "#060706";
  g.textAlign = "center";
  g.font = "bold 72px system-ui";
  g.fillText((title || "·").slice(0, 1).toUpperCase(), 128, 150);
  g.font = "14px system-ui";
  g.fillText((artist || "RHINE LAB").slice(0, 16), 128, 200);
  return c.toDataURL("image/jpeg", 0.85);
}
function coverToDataUrl(src: string) {
  return new Promise<string | null>((res) => {
    if (!src) return res(null);
    if (src.indexOf("data:") === 0) return res(src);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      const m = 512;
      c.width = c.height = m;
      const g = c.getContext("2d")!;
      const s = Math.min(m / img.width, m / img.height);
      g.drawImage(img, 0, 0, img.width * s, img.height * s);
      res(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => res(null);
    img.src = src;
  });
}
/* ID3 文本帧解码。
   ★ 这里以前写死了 UTF-8，于是中文标签必然乱码，两种情况都踩中：
     ① 编码字节 1（带 BOM 的 UTF-16，中文 MP3 最常见）—— 跳过 2 字节后按 UTF-8 解，
        整条变成"�"或成串怪字；
     ② 编码字节 0（规范上是 ISO-8859-1，但国内大量标签实际写的是 GBK/GB18030）。
   现在按编码字节分派；对"标称 Latin-1"的再做一次判别：先严格试 UTF-8，
   不成立且高位字节占多数时按 GB18030 解，只有真的是拉丁文本才落回 windows-1252。 */
function decodeTagText(bytes: Uint8Array): string {
  if (!bytes || !bytes.length) return "";
  const enc = bytes[0];
  const body = bytes.subarray(1);
  const run = (label: string, input: Uint8Array = body, fatal = false) => {
    try {
      return new TextDecoder(label, { fatal }).decode(input);
    } catch {
      return "";
    }
  };
  let text = "";
  if (enc === 1) {
    // 显式看 BOM 决定字节序：TextDecoder("utf-16") 在部分运行时里不按大端 BOM 切换
    const be = body.length >= 2 && body[0] === 0xfe && body[1] === 0xff;
    const le = body.length >= 2 && body[0] === 0xff && body[1] === 0xfe;
    text = run(be ? "utf-16be" : "utf-16le", be || le ? body.subarray(2) : body);
  } else if (enc === 2) text = run("utf-16be");
  else if (enc === 3) text = run("utf-8");
  else {
    const utf8 = run("utf-8", body, true); // 有些工具标 0 但真的写 UTF-8
    if (utf8) text = utf8;
    else {
      let high = 0;
      for (let i = 0; i < body.length; i++) if (body[i] >= 0x80) high++;
      const gbk = high / Math.max(1, body.length) > 0.5 ? run("gb18030") : "";
      text =
        gbk && !gbk.includes("\uFFFD") && /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(gbk)
          ? gbk
          : run("windows-1252");
    }
  }
  return text.replace(/\0+$/g, "").replace(/\0+/g, " / ").trim();
}
/** ID3v1（文件末尾 128 字节）—— 没有 v2 标签的老文件靠它兜底。 */
function parseId3v1(tail: Uint8Array) {
  const out = { title: "", artist: "", album: "" };
  if (!tail || tail.length < 128) return out;
  const t = tail.subarray(tail.length - 128);
  if (String.fromCharCode(t[0], t[1], t[2]) !== "TAG") return out;
  const field = (from: number, len: number) => decodeTagText(new Uint8Array([0, ...t.subarray(from, from + len)]));
  out.title = field(3, 30);
  out.artist = field(33, 30);
  out.album = field(63, 30);
  return out;
}
/* 精简 ID3v2：标题/歌手/专辑 + 内嵌封面 */
function parseID3(buf: Uint8Array) {
  const out: { title: string; artist: string; album: string; cover: string | null } = { title: "", artist: "", album: "", cover: null };
  try {
    if (buf.length < 10 || String.fromCharCode(buf[0], buf[1], buf[2]) !== "ID3") return out;
    const major = buf[3];
    const v4 = major === 4;
    const idLen = major === 2 ? 3 : 4; // ID3v2.2 的帧头是 3 字节 ID + 3 字节长度
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    let i = 10;
    const end = Math.min(buf.length, 10 + size);
    while (i + idLen + (idLen === 3 ? 3 : 6) <= end) {
      const id = String.fromCharCode(...buf.subarray(i, i + idLen));
      const sz = v4
        ? ((buf[i + 4] & 0x7f) << 21) | ((buf[i + 5] & 0x7f) << 14) | ((buf[i + 6] & 0x7f) << 7) | (buf[i + 7] & 0x7f)
        : idLen === 3
          ? (buf[i + 3] << 16) | (buf[i + 4] << 8) | buf[i + 5]
          : (buf[i + 4] << 24) | (buf[i + 5] << 16) | (buf[i + 6] << 8) | buf[i + 7];
      const d = buf.subarray(i + idLen + (idLen === 3 ? 3 : 6), i + idLen + (idLen === 3 ? 3 : 6) + (sz > 0 ? sz : 0));
      if (id === "TIT2" || id === "TT2") out.title = decodeTagText(d);
      else if (id === "TPE1" || id === "TP1") out.artist = decodeTagText(d);
      else if (id === "TALB" || id === "TAL") out.album = decodeTagText(d);
      else if (id === "APIC" || id === "PIC") {
        const utf16 = d[0] === 1 || d[0] === 2;
        let p = 0;
        if (d[0] === 0 || d[0] === 3) p = 1;
        while (p < d.length && d[p] !== 0) p++; // MIME
        p++;
        if (id === "PIC") p += 3; // v2.2 多一个 3 字节图片格式
        if (utf16) {
          // UTF-16 描述以 00 00 结尾，逐字节找第一个 0 会提前截断
          while (p + 1 < d.length && !(d[p] === 0 && d[p + 1] === 0)) p += 2;
          p += 2;
        } else {
          while (p < d.length && d[p] !== 0) p++;
          p++;
        }
        if (p < d.length) out.cover = URL.createObjectURL(new Blob([d.slice(p) as BlobPart], { type: "image/jpeg" }));
      }
      if (!sz) break;
      i += idLen + (idLen === 3 ? 3 : 6) + sz;
    }
  } catch {
    /* ignore */
  }
  return out;
}
/** 同时读头尾：v2 标签在文件头，v1 在文件尾，缺哪个补哪个。 */
async function readTags(blob: Blob) {
  const head = new Uint8Array(await blob.slice(0, 1024 * 1024).arrayBuffer());
  const meta = parseID3(head);
  if (!meta.title || !meta.artist || !meta.album) {
    try {
      const tail = new Uint8Array(await blob.slice(Math.max(0, blob.size - 128)).arrayBuffer());
      const v1 = parseId3v1(tail);
      if (!meta.title) meta.title = v1.title;
      if (!meta.artist) meta.artist = v1.artist;
      if (!meta.album) meta.album = v1.album;
    } catch {
      /* ignore */
    }
  }
  return meta;
}

/* ---------- 歌曲 → 档案映射 ----------
   字段一律按播放器信息填：原来照搬档案语义的"科室 / 编目范围 / 相关人物 / 权限"
   分别改成 艺术家 / 时长 / 专辑 / 来源格式，检索列与选中提示也读这几个字段。 */
const LANES = ["音乐 Ⅰ", "音乐 Ⅱ", "音乐 Ⅲ", "音乐 Ⅳ", "音乐 Ⅴ"];
const clockText = (sec: number) => {
  if (!isFinite(sec) || sec <= 0) return "—";
  const s = Math.floor(sec);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};
function toRecord(s: Song, index: number): ArchiveRecord {
  const no = String(index + 1).padStart(3, "0");
  return {
    id: "X-" + no,
    title: s.title,
    en: s.artist || s.title,
    department: s.artist || "未知艺术家",
    category: LANES[index % LANES.length],
    date: clockText(s.duration),
    lead: s.album || "未知专辑",
    clearance: sourceLabel(s),
    abstract: `${s.artist || "未知艺术家"} · ${s.album || "未知专辑"}${s.duration ? " · " + clockText(s.duration) : ""}${s.fav ? " · 已收藏" : ""}`,
    findings: [],
    source: "",
  };
}
function syncRecords() {
  setRecords(
    songs.map(toRecord),
    LANES,
  );
}

/* ---------- 播放控制 ---------- */
function selectSong(id: string) {
  // 离开这首之前把最后的位置落一次（下次播放它时用来续上）
  const leaving = songs.find((x) => x.id === currentId);
  if (leaving && audio.currentTime > 3) {
    leaving.pos = audio.currentTime;
    persist(leaving);
  }
  currentId = id;
  const s = songs.find((x) => x.id === id);
  if (!s) return;
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
  if (s.srcUrl) audio.src = s.srcUrl;
  else if (s.file) {
    currentUrl = URL.createObjectURL(s.file);
    audio.src = currentUrl;
  }
  pendingSeek = s.pos > 3 ? s.pos : 0;
  posSavedAt = s.pos > 3 ? s.pos : 0;
  if (DIAG) (window as any).__lastLoad = { id: s.id, title: s.title, pos: s.pos, pendingSeek, urlKind: s.srcUrl ? "url" : s.file ? "blob" : "none" };
  spectrum?.resetPeaks();
  renderNow();
  // 让三维档案阵列与详情区跟上正在播放的这一首（播放列表与档案阵列是同一份数据）
  const index = songs.findIndex((x) => x.id === id);
  if (index >= 0) {
    window.dispatchEvent(new CustomEvent("rhine-track", { detail: index }));
  }
}
export function playAt(i: number) {
  if (!songs.length) return;
  i = ((i % songs.length) + songs.length) % songs.length;
  const s = songs[i];
  /* 点的就是当前这首：不要重新加载（重新赋 audio.src 会回到 0 秒），
     暂停中就接着放、正在放就保持 —— 这就是"点歌不要重新播放"。 */
  if (s.id === currentId) {
    if (audio.paused) audio.play().catch(() => {});
    return;
  }
  selectSong(s.id);
  s.plays = (s.plays || 0) + 1;
  persist(s);
  audio.play().catch(() => {});
}
/* 诊断开关：?viztest=1 / ?diag=1 时把播放内核挂到 window 上，自动化核对"点歌续播"用 */
if (VIZ_TEST || DIAG) (window as any).__playAt = playAt;
/* 「下一首播放」：把曲目排到当前这首后面（不动曲库顺序，只在队列里记 id） */
let nextQueue: string[] = [];
export function queueNext(id: string) {
  const s = songs.find((x) => x.id === id);
  if (!s) return;
  const cur = currentSong();
  if (cur && cur.id === id) {
    toast("这首正在播放");
    return;
  }
  nextQueue = nextQueue.filter((x) => x !== id);
  nextQueue.unshift(id);
  renderList();
  toast(`下一首播放：《${s.title}》`);
}
export function queuedIds(): string[] {
  return nextQueue.slice();
}
export function togglePlay() {
  if (!currentId) {
    if (songs.length) playAt(0);
    return;
  }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}
export function playNext() {
  // 「下一首播放」队列优先
  while (nextQueue.length) {
    const id = nextQueue.shift() as string;
    const at = songs.findIndex((x) => x.id === id);
    if (at >= 0) return playAt(at);
  }
  const i = currentIndex();
  if (mode === "shuffle") {
    if (songs.length < 2) return playAt(0);
    let j: number;
    do {
      j = Math.floor(Math.random() * songs.length);
    } while (songs[j].id === currentId);
    return playAt(j);
  }
  if (mode === "order") {
    if (i < songs.length - 1) playAt(i + 1);
    return;
  }
  playAt((i + 1) % songs.length);
}
export function playPrev() {
  if (!songs.length) return;
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  playAt((currentIndex() - 1 + songs.length) % songs.length);
}
export function cycleMode() {
  const keys = ["list", "order", "single", "shuffle"];
  mode = keys[(keys.indexOf(mode) + 1) % keys.length];
  try {
    localStorage.setItem("rhine-music-mode", mode);
  } catch {
    /* ignore */
  }
  renderNow();
}
export function toggleFav(id: string) {
  const s = songs.find((x) => x.id === id);
  if (!s) return;
  s.fav = !s.fav;
  persist(s);
  renderNow();
}
export function removeSong(id: string) {
  const i = songs.findIndex((x) => x.id === id);
  if (i < 0) return;
  const wasCurrent = id === currentId;
  songs.splice(i, 1);
  idb.del(id).catch(() => {});
  if (wasCurrent) {
    if (songs.length) {
      currentId = null;
      selectSong(songs[Math.min(i, songs.length - 1)].id);
      audio.currentTime = 0;
    } else {
      currentId = null;
      audio.pause();
      audio.removeAttribute("src");
    }
  }
  notify();
}

/* ---------- 导入 ---------- */
async function addFiles(fileList: FileList | File[]) {
  const arr = [...fileList].filter(
    (f) => (f.type && f.type.startsWith("audio/")) || /\.(mp3|flac|wav|m4a|aac|ogg|opus|webm|aiff?|ncm)$/i.test(f.name),
  );
  if (!arr.length) {
    toast("没有找到音频文件");
    return;
  }
  toast(`正在解析 ${arr.length} 首歌曲…`);
  let added = 0;
  for (const f of arr) {
    let title = "",
      artist = "",
      album = "",
      cover: string | null = null;
    let audioFile = f;
    let ncmPath = "";
    if (/\.ncm$/i.test(f.name)) {
      ncmPath = (f as any).path || "";
      if (desktop?.convertNcm) {
        try {
          const res = await desktop.convertNcm(await f.arrayBuffer());
          if (res && res.error) {
            toast(`《${f.name}》解密失败：${res.error}`);
            continue;
          }
          const ext = (res && res.ext) || "mp3";
          audioFile = new File([res.bytes], f.name.replace(/\.ncm$/i, "." + ext), { type: ext === "flac" ? "audio/flac" : "audio/mpeg" });
          title = (res && res.title) || "";
          artist = (res && res.artist) || "";
          album = (res && res.album) || "";
        } catch {
          toast(`《${f.name}》解密失败，已跳过`);
          continue;
        }
      } else {
        toast("NCM 解密需在桌面版使用");
        continue;
      }
    }
    try {
      const meta = await readTags(audioFile);
      if (!title) title = meta.title;
      if (!artist) artist = meta.artist;
      if (!album) album = meta.album;
      if (!cover) cover = meta.cover;
    } catch {
      /* ignore */
    }
    const filePath = (f as any).path || "";
    if (!cover && desktop?.readCover && filePath) {
      try {
        const rc = await desktop.readCover({ path: filePath });
        if (rc && rc.dataUrl) cover = rc.dataUrl;
      } catch {
        /* ignore */
      }
    }
    const fb = niceName(f.name);
    if (!title) title = fb.title || f.name.replace(/\.[^.]+$/, "");
    if (!artist) artist = fb.artist || "未知艺术家";
    if (!album) album = "未知专辑";
    if (cover) cover = await coverToDataUrl(cover);
    const song: Song = {
      id: uid(),
      file: audioFile,
      ncmPath,
      filePath,
      title,
      artist,
      album,
      cover: cover || defaultCover(title, artist),
      duration: 0,
      fav: false,
      plays: 0,
      pos: 0,
      order: orderSeq++,
    };
    songs.push(song);
    persist(song);
    probeDuration(song);
    added++;
    if (desktop?.findLyrics && filePath) {
      desktop.findLyrics(filePath, title, artist).then((t) => {
        if (t && t.trim()) {
          song.lrc = t;
          persist(song);
          // 歌词是异步补上的：通知详情区重绘一次歌词页签
          if (song.id === currentId) window.dispatchEvent(new CustomEvent("rhine-lyrics"));
        }
      }).catch(() => {});
    }
  }
  notify();
  if (!currentId && songs.length) selectSong(songs[0].id);
  toast(`导入完成：新增 ${added} 首`);
}
function probeDuration(s: Song) {
  const tmp = new Audio();
  const url = s.srcUrl || (s.file ? URL.createObjectURL(s.file) : "");
  tmp.preload = "metadata";
  tmp.onloadedmetadata = () => {
    s.duration = tmp.duration || 0;
    persist(s);
  };
  tmp.onerror = () => {};
  tmp.src = url;
}

/* ---------- 旧曲库的乱码修复 ----------
   0.0 之前的版本用 UTF-8 硬解 ID3，中文标题/歌手已经被写进曲库。
   只对"看起来就是乱码"的条目重跑一次识别并修回来（不扫全库，避免拖慢启动）。 */
const MOJIBAKE_LATIN = /[\u00a0-\u00ff]/;
const HAS_CJK = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
function looksBroken(text: string | undefined): boolean {
  if (!text) return false;
  if (text.includes("\uFFFD")) return true;
  if (HAS_CJK.test(text) || !MOJIBAKE_LATIN.test(text)) return false;
  const hits = (text.match(/[\u00a0-\u00ff]/g) || []).length;
  return hits / text.length >= 0.4;
}
let tagsRepaired = false;
async function repairTags() {
  if (tagsRepaired) return;
  tagsRepaired = true;
  let fixed = 0;
  for (const s of songs) {
    if (!s.file) continue;
    if (!looksBroken(s.title) && !looksBroken(s.artist) && !looksBroken(s.album)) continue;
    try {
      const meta = await readTags(s.file);
      let changed = false;
      const take = (next: string, current: string, looks: boolean) => {
        if (!next || next === current) return current;
        if (!looks && !looksBroken(current)) return current;
        changed = true;
        return next;
      };
      s.title = take(meta.title, s.title, looksBroken(s.title));
      s.artist = take(meta.artist, s.artist, looksBroken(s.artist));
      s.album = take(meta.album, s.album, looksBroken(s.album));
      if (changed) {
        persist(s);
        fixed++;
      }
    } catch {
      /* ignore */
    }
  }
  if (fixed) {
    notify();
    toast(`已修正 ${fixed} 首曲目的乱码标签`);
  }
}

export async function importFolder() {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.setAttribute("webkitdirectory", "");
  input.onchange = () => {
    addFiles(input.files || []);
  };
  input.click();
}
export async function importFiles() {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.accept = "audio/*,.ncm";
  input.onchange = () => {
    addFiles(input.files || []);
  };
  input.click();
}
export async function importBili() {
  if (!desktop?.scanBiliCache) {
    toast("B站缓存导入需在桌面版使用");
    return;
  }
  toast("正在扫描 B 站缓存…");
  let res: any;
  try {
    res = await desktop.scanBiliCache();
  } catch (e) {
    toast("扫描失败");
    return;
  }
  if (!res || res.canceled) return;
  if (res.error) {
    toast("扫描出错：" + res.error);
    return;
  }
  const items = res.items || [];
  if (!items.length) {
    toast("没有找到 B 站缓存");
    return;
  }
  let added = 0;
  for (const it of items) {
    const song: Song = {
      id: uid(),
      srcUrl: it.path,
      path: it.audioPath || "",
      title: (it.title || "").trim() || "未知歌曲",
      artist: (it.artist || "").trim() || "未知艺术家",
      album: it.album || "B站缓存",
      cover: it.cover || defaultCover(it.title || "未知歌曲", it.artist || ""),
      duration: it.durationHint || 0,
      fav: false,
      plays: 0,
      pos: 0,
      order: orderSeq++,
    };
    songs.push(song);
    persist(song);
    added++;
  }
  notify();
  if (!currentId && songs.length) selectSong(songs[0].id);
  toast(`B站缓存导入：新增 ${added} 首`);
}

/* ---------- UI（挂在 #stage 内，和终端共用一套网格与配色） ---------- */
let bar: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let nowTitleEl: HTMLElement | null = null;
let nowArtistEl: HTMLElement | null = null;
let specEl: HTMLElement | null = null;
let toastTimer: number | undefined;
let lrcCache: { id: string; lines: { t: number; txt: string }[] } | null = null;
const SPEC_BARS = 52;

/** 终端把整套界面挂在 #stage（1920×1080，按窗口等比缩放）里；
 *  播放器也必须挂进去，否则窗口一缩放，播放条就和界面脱节。 */
function stageRoot(): HTMLElement {
  return (document.querySelector("#stage") as HTMLElement | null) ?? document.body;
}

/** 复用终端自己的 #toast（同一个提示条，不另起一套）。 */
function toast(msg: string) {
  const el = document.querySelector<HTMLElement>("#toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove("visible"), 2600);
}

const MODE_LABEL: Record<string, string> = { list: "列表循环", order: "顺序播放", single: "单曲循环", shuffle: "随机播放" };
const MODE_GLYPH: Record<string, string> = { list: "↻", order: "⇢", single: "①", shuffle: "⤨" };
const MODE_EN: Record<string, string> = { list: "LOOP", order: "IN ORDER", single: "REPEAT ONE", shuffle: "SHUFFLE" };

function renderNow() {
  const s = currentSong();
  if (nowTitleEl) nowTitleEl.textContent = s ? s.title : "尚无曲目";
  if (nowArtistEl)
    nowArtistEl.textContent = s
      ? `${s.artist}${s.album ? " · " + s.album : ""}`
      : "在终端中导入音乐，档案阵列即成为播放列表";
  const modeEl = bar?.querySelector<HTMLElement>("#p-mode");
  if (modeEl) {
    modeEl.textContent = MODE_GLYPH[mode] ?? "↻";
    modeEl.classList.toggle("lit", mode !== "list");
    modeEl.title = "播放模式：" + (MODE_LABEL[mode] ?? mode);
  }
  const favEl = bar?.querySelector<HTMLElement>("#p-fav");
  if (favEl) {
    favEl.textContent = s && s.fav ? "♥" : "♡";
    favEl.classList.toggle("lit", Boolean(s && s.fav));
    favEl.title = s ? (s.fav ? "取消收藏" : "收藏当前曲目") : "收藏";
  }
  const playIcon = bar?.querySelector("#p-play-icon");
  if (playIcon)
    playIcon.innerHTML = audio.paused
      ? '<path d="M6 3.6 20 12 6 20.4z"/>'
      : '<path d="M5.6 3.6h4.8v16.8H5.6zM13.6 3.6h4.8v16.8h-4.8z"/>';
  // 详情区若正开着，同步它的播放键与状态字样
  const exp = document.querySelector<HTMLElement>('.detail-content .export-button[data-action="play-now"]');
  if (exp) exp.innerHTML = `${audio.paused ? "PLAY" : "PAUSE"} <span>${audio.paused ? "▶" : "■"}</span>`;
  const kicker = document.querySelector<HTMLElement>(".detail-content .song-mode-kicker");
  if (kicker && songs.length)
    kicker.textContent = `${audio.paused ? "READY" : "PLAYING"} · ${MODE_EN[mode] ?? "LOOP"}`;
  renderList();
}

/* 频谱计算搬到 Web Worker：120 段 × 512 点的 Goertzel 每次约 6 万次乘加，
   放主线程会跟三维场景抢帧。worker 失败就退回同步计算（见 vizFrame）。
   分析节拍固定 30Hz（worker 每 33ms 一帧），缓冲在两侧轮流用、靠 transfer 归还，
   避免每帧 new 出垃圾；渲染循环本身跑满 60fps（见 vizFrame 的时间预算）。 */
let spectrumWorker: Worker | null = null;
let workerEver = false;
let workerFrames = 0;
let pendingFreq: Float32Array | null = null;
let workerMsAvg = 0; // worker 单次分析耗时（诊断用）
let workerSentAt = 0;
let workerRttAvg = 0;
function initSpectrumWorker() {
  try {
    const src = `
      const N = ${SPECTRUM_WINDOW}, B = ${SPECTRUM_BANDS}, LOG101 = Math.log10(101);
      const hann = new Float32Array(N);
      for (let i = 0; i < N; i++) hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
      let bandK = null, sr = 0, kickRef = 0;
      onmessage = (e) => {
        const t0 = performance.now();
        const td = e.data.td;
        const rate = e.data.sr || 48000;
        if (!bandK || rate !== sr) {
          sr = rate;
          bandK = new Float32Array(B);
          for (let b = 0; b < B; b++) bandK[b] = (42 * Math.pow(16000 / 42, b / (B - 1)) / sr) * N;
        }
        const mags = new Float32Array(B);
        let mx = 1e-9;
        for (let b = 0; b < B; b++) {
          const k = bandK[b], co = 2 * Math.cos(2 * Math.PI * k / N);
          let s1 = 0, s2 = 0;
          for (let i = 0; i < N; i++) { const s0 = td[i] * hann[i] + co * s1 - s2; s2 = s1; s1 = s0; }
          const m = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - co * s1 * s2)) / (N / 4);
          mags[b] = m;
          if (m > mx) mx = m;
        }
        const out = new Float32Array(B + 1);
        for (let b = 0; b < B; b++) out[b] = Math.log10(1 + 100 * Math.min(1, mags[b] / mx)) / LOG101;
        let low = 0;
        for (let b = 2; b <= 8; b++) low += mags[b];
        low /= 7;
        if (kickRef <= 0) kickRef = low;
        const rise = (low - kickRef) / Math.max(kickRef, 1e-6);
        out[B] = Math.max(0, Math.min(1, (rise - 0.08) * 2.2));
        kickRef += (low - kickRef) * 0.05;
        postMessage(out, [out.buffer]);
        // 时域缓冲还回去，下一帧继续用同一块内存（不产生垃圾）
        postMessage({ __td: td, ms: performance.now() - t0 }, [td.buffer]);
      };`;
    spectrumWorker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    spectrumWorker.onmessage = (e) => {
      const d = e.data;
      if (d && d.__td) {
        workerRttAvg += (performance.now() - workerSentAt - workerRttAvg) * 0.1;
        workerMsAvg += (d.ms - workerMsAvg) * 0.1;
        if (tdBufs.length < 2) tdBufs.push(new Float32Array(d.__td));
        return;
      }
      pendingFreq = new Float32Array(d);
      workerEver = true;
      if (VIZ_TEST) (window as any).__workerHits = ((window as any).__workerHits || 0) + 1;
    };
    spectrumWorker.onerror = () => {
      spectrumWorker = null;
      workerEver = false;
    };
  } catch (e) {
    spectrumWorker = null;
  }
}
const tdBufs: Float32Array[] = [];
let tdRotate = 0;


/* ---------- 频谱：1.3.0 版独立播放器的自研频谱（见 spectrum.ts） ---------- */
let actx: AudioContext | null = null;
let analyserNode: AnalyserNode | null = null;
let freqData: Uint8Array<ArrayBuffer> | null = null;
let timeData: Float32Array<ArrayBuffer> | null = null;
let vizDenied = false;
let vizRaf = 0;
let vizLast = 0;
let spectrum: Spectrum | null = null;
/* ?viztest=1：不播音乐，用合成信号跑频谱 —— 用来在无音频的环境里核对频谱观感
   （音高固定 55Hz 低音 + 440Hz / 2.4kHz，低音每 4 秒来一次"鼓点"）。 */
let vizTestPhase = 0;
function vizTestTimeData(out: Float32Array) {
  const sr = actx?.sampleRate ?? 48000;
  vizTestPhase += 1;
  const beat = Math.pow(Math.max(0, Math.sin((vizTestPhase / 120) * Math.PI * 2)), 8);
  for (let i = 0; i < out.length; i++) {
    const t = i / sr;
    let s = (0.35 + 0.5 * beat) * Math.sin(2 * Math.PI * 55 * t);
    s += 0.18 * Math.sin(2 * Math.PI * 440 * t + vizTestPhase * 0.02);
    s += 0.1 * Math.sin(2 * Math.PI * 2400 * t);
    s += 0.04 * (Math.random() * 2 - 1);
    out[i] = s * 0.7;
  }
  return beat;
}

function spectrumPalette(): Partial<SpectrumPalette> {
  return document.body.classList.contains("rhine-night")
    ? { light: "#dcbb8c", strong: "#c08b52", base: "#4b4a3b", ring: "#c08b52" }
    : { light: "#c9a878", strong: "#9b7247", base: "#252820", ring: "#9b7247" };
}

async function ensureAnalyser(): Promise<AnalyserNode | null> {
  if (analyserNode || vizDenied) return analyserNode;
  try {
    const Ctor: typeof AudioContext | undefined =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) {
      vizDenied = true;
      return null;
    }
    const ctx = new Ctor();
    if (ctx.state !== "running") await ctx.resume().catch(() => {});
    // 取不到运行中的上下文就绝不接管音频：宁可没有频谱，也不能没有声音。
    if (ctx.state !== "running") {
      vizDenied = true;
      void ctx.close().catch(() => {});
      return null;
    }
    const source = ctx.createMediaElementSource(audio);
    const node = ctx.createAnalyser();
    node.fftSize = 1024; // 与 1.3.0 的分析窗长一致
    node.smoothingTimeConstant = 0.6;
    source.connect(node);
    node.connect(ctx.destination);
    actx = ctx;
    analyserNode = node;
    freqData = new Uint8Array(node.frequencyBinCount);
    timeData = new Float32Array(node.fftSize);
    initSpectrumWorker();
  } catch {
    vizDenied = true;
  }
  return analyserNode;
}
/* 播放条的 52 格刻度直接取频谱柱（跟着渲染节拍走，且只在高度真的变了才写 DOM） */
let tickLast = 0;
function paintTicks(now = 0) {
  if (!specEl || !spectrum) return;
  if (now && now - tickLast < 30) return;
  tickLast = now;
  const bars = spectrum.levels;
  const kids = specEl.children;
  const step = bars.length / kids.length;
  const vArr: number[] = [];
  for (let i = 0; i < kids.length; i++) {
    let sum = 0;
    const from = Math.floor(i * step);
    const to = Math.max(from + 1, Math.floor((i + 1) * step));
    for (let b = from; b < to && b < bars.length; b++) sum += bars[b];
    vArr.push(Math.min(1, sum / (to - from)));
  }
  for (let i = 0; i < kids.length; i++) {
    const v = vArr[i];
    const px = Math.max(2, Math.round(2 + v * 24));
    const el = kids[i] as HTMLElement;
    if (el.style.height !== px + "px") {
      el.style.height = px + "px";
      el.style.opacity = String(0.34 + v * 0.66);
    }
  }
}
/* 诊断对象：?viztest=1 时暴露到 window.__rhineViz，用于自动化核对帧率与观感指标 */
const vizDiag: Record<string, unknown> = { frames: 0, fps: 0, worker: false, workerMs: 0, rttMs: 0 };
function vizFrame(ts: number) {
  vizRaf = 0;
  /* 渲染节拍：播放中 60fps（16ms 预算），暂停后 15fps（只画收起动画）。
     分析节拍另算 —— worker 每 33ms 才喂一次数据，中间这些帧靠 Spectrum.render()
     把显示值朝目标值插值，所以柱高是连续滑动的。
     1.4.7 之前这里是 33ms 的整帧预算，等于把渲染也锁在 30fps，那才是"帧率不够"。 */
  const dt = vizLast ? Math.min(0.1, (ts - vizLast) / 1000) : 0.033;
  const budget = VIZ_TEST || !audio.paused ? 15 : 64;
  if (ts - vizLast < budget) {
    vizRaf = requestAnimationFrame(vizFrame);
    return;
  }
  vizLast = ts;
  /* 播放中按 60fps 渲染；暂停后降到 15fps —— 不用停循环，收起动画本身就是频谱的一部分，
     停掉的话暂停瞬间画面会僵在最后一帧。 */
  const busy = VIZ_TEST || !audio.paused;
  if (spectrum) {
    let advance = false;
    if (VIZ_TEST) {
      // 时域缓冲由循环自己保证（不依赖 ensureAnalyser —— 没有音频上下文时也要能跑）
      if (!timeData) timeData = new Float32Array(1024);
      vizTestTimeData(timeData);
      spectrum.update(timeData, actx?.sampleRate);
      advance = true;
    } else if (analyserNode) {
      if (!timeData) timeData = new Float32Array(analyserNode.fftSize);
      analyserNode.getFloatTimeDomainData(timeData);
      /* 频谱在 Web Worker 里算（1.3.0 的做法）：Goertzel 放主线程会和三维场景抢帧 ——
         用户在 1.4.5 反馈"可视化帧率很低"就是这条。
         分析节拍固定 30Hz（= 每 33ms 一帧，足够跟上鼓点），worker 起不来时退回同步。 */
      if (spectrumWorker && workerEver) {
        if (ts - workerSentAt >= 33) {
          const n = analysisWindow(timeData);
          let buf = tdBufs.length ? (tdBufs[tdRotate++ % tdBufs.length] as Float32Array) : null;
          if (!buf || buf.length !== n) buf = new Float32Array(n);
          buf.set(timeData.subarray(timeData.length - n));
          workerSentAt = ts;
          spectrumWorker.postMessage({ td: buf, sr: actx?.sampleRate ?? 48000 }, [buf.buffer]);
        }
        if (pendingFreq) {
          spectrum.applyBands(pendingFreq);
          pendingFreq = null;
        }
      } else {
        spectrum.update(timeData, actx?.sampleRate);
        if (spectrumWorker && ++workerFrames > 120) {
          // 等了 120 帧还没有回包（worker 被策略挡住等）→ 停掉它，永久走同步路径
          try { spectrumWorker.terminate(); } catch (e) { /* ignore */ }
          spectrumWorker = null;
        }
      }
      advance = true;
    }
    if (!advance) spectrum.decay();
    spectrum.render(dt);
  }
  paintTicks(ts);
  const d = vizDiag as any;
  d.frames++;
  d.rendered = (d.rendered || 0) + 1;
  d.dt = Math.round(dt * 1000);
  d.busy = busy;
  /* 帧间隔分布：中位数与 p90 比"平均帧率"更能看出卡顿（探针用它判断是否真顺） */
  if (DIAG) {
    (d.intervals || (d.intervals = [])).push(Math.round(dt * 1000));
    if (d.intervals.length > 240) d.intervals.shift();
  }
  d.worker = Boolean(spectrumWorker);
  d.workerMs = Math.round(workerMsAvg * 100) / 100;
  d.rttMs = Math.round(workerRttAvg * 100) / 100;
  d.workerOn = Boolean(spectrumWorker && workerEver);
  vizRaf = requestAnimationFrame(vizFrame);
}
function vizStop() {
  if (vizRaf) cancelAnimationFrame(vizRaf);
  vizRaf = 0;
}
async function startViz() {
  const node = await ensureAnalyser();
  if (!node) return;
  if (actx && actx.state !== "running") await actx.resume().catch(() => {});
  if (!vizRaf) vizRaf = requestAnimationFrame(vizFrame);
}
/* 窗口最小化 / 隐藏时停掉频谱循环：Electron 里关掉了背景节流，
   不主动停就等于一直在算没人看的帧。 */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) vizStop();
  else if (!audio.paused) void startViz();
});

/* ---------- 歌词 ---------- */
function lrcLines(s: Song | null): { t: number; txt: string }[] {
  if (!s || !s.lrc) return [];
  if (lrcCache && lrcCache.id === s.id) return lrcCache.lines;
  const mm = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/;
  const lines: { t: number; txt: string }[] = [];
  s.lrc.split(/\r?\n/).forEach((line) => {
    const m = line.match(mm);
    if (m) {
      const t = +m[1] * 60 + +m[2] + +(m[3] || 0) / 1000;
      const txt = line.replace(/\[[^\]]*\]/g, "").trim();
      if (txt) lines.push({ t, txt });
    }
  });
  lines.sort((a, b) => a.t - b.t);
  lrcCache = { id: s.id, lines };
  return lines;
}
/** 详情区只有一行"当前歌词"字幕：跟着播放进度整行替换，不做滚动列表。 */
function stepLyrics() {
  const el = document.querySelector<HTMLElement>("#p-lyric-line");
  if (!el) return;
  const s = currentSong();
  const lines = lrcLines(s);
  if (!lines.length) {
    el.textContent = s && s.lrc ? "" : "♪ 无歌词";
    el.classList.remove("on");
    return;
  }
  const cur = audio.currentTime || 0;
  let idx = 0;
  for (let i = 0; i < lines.length; i++) if (lines[i].t <= cur) idx = i;
  const text = lines[idx].txt;
  if (el.textContent !== text) el.textContent = text;
  el.classList.add("on");
}

/* ---------- 列表与播放条 ---------- */
/* 列表只在"内容真的变了"时重建：renderNow() 在播放 / 暂停 / 收藏 / 换曲时都会被调用，
   每次都重写 300 多行曲目的 innerHTML 会把主线程整块占住（用户反馈卡顿的来源之一）。
   签名里带当前曲目、队列、收藏与曲目数，任一变化才重建。 */
let listSig = "";
function listSignature() {
  let sig = songs.length + "|" + currentId + "|" + nextQueue.join(",");
  for (let i = 0; i < songs.length; i++) sig += (songs[i].fav ? "1" : "0");
  return sig;
}
function renderList() {
  if (!listEl) return;
  const sig = listSignature();
  if (sig === listSig) return;
  listSig = sig;
  const s = currentSong();
  const queued = new Set(nextQueue);
  listEl.innerHTML =
    `<div class="p-head"><b>ARCHIVE ARRAY ／ 播放列表</b><span>${String(songs.length).padStart(2, "0")} TRACKS${nextQueue.length ? " · 队列 " + nextQueue.length : ""}</span><button class="p-theme" title="深色 / 浅色主题">◐</button></div>` +
    (songs.length
      ? songs
          .map(
            (x, i) =>
              `<div class="p-row${x.id === currentId ? " active" : ""}${queued.has(x.id) ? " queued" : ""}" data-i="${i}"><span class="p-idx">${String(i + 1).padStart(2, "0")}</span><span class="p-meta"><b>${esc(x.title)}</b><small>${esc(x.artist)}${x.album ? " · " + esc(x.album) : ""}${x.fav ? " ／ ♥" : ""}${queued.has(x.id) ? " ／ 下一首" : ""}</small></span><button class="p-queue" data-queue="${x.id}" title="下一首播放">↳</button><button class="p-fav${x.fav ? " on" : ""}" data-fav="${x.id}" title="收藏">${x.fav ? "♥" : "♡"}</button><button class="p-del" data-del="${x.id}" title="移除">✕</button></div>`,
          )
          .join("")
      : `<div class="p-empty">尚无曲目。点击 ＋ 导入音乐文件，右键 ＋ 导入整个文件夹，也可以把文件直接拖进窗口。</div>`);
  if (s && listEl.classList.contains("open")) {
    const idx = songs.findIndex((x) => x.id === s.id);
    listEl.querySelector(`[data-i="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }
}
function buildUI() {
  if (bar) return;
  const root = stageRoot();
  bar = document.createElement("div");
  bar.id = "player-bar";
  bar.innerHTML = `
    <div class="p-top">
      <span class="p-label">NOW PLAYING <i>／</i> 正在播放</span>
      <div class="p-controls">
        <button id="p-prev" title="上一首"><svg viewBox="0 0 24 24" width="13" height="13"><path d="M6 4h2.4v16H6zM20 4v16l-10-8z"/></svg></button>
        <button id="p-play" title="播放 / 暂停"><svg id="p-play-icon" viewBox="0 0 24 24" width="15" height="15"><path d="M6 3.6 20 12 6 20.4z"/></svg></button>
        <button id="p-next" title="下一首"><svg viewBox="0 0 24 24" width="13" height="13"><path d="M15.6 4H18v16h-2.4zM4 4v16l10-8z"/></svg></button>
        <i class="p-sep" aria-hidden="true"></i>
        <button id="p-mode" title="播放模式">↻</button>
        <button id="p-rate" title="播放速度">1×</button>
        <button id="p-fav" title="收藏当前曲目">♡</button>
        <button id="p-import" title="导入音乐（右键 ＝ 导入整个文件夹）">＋</button>
        <button id="p-list" title="播放列表 ／ 档案阵列">☰</button>
      </div>
    </div>
    <div class="p-mid">
      <div class="p-now"><span id="p-now-title">尚无曲目</span><small id="p-now-artist"></small></div>
      <div id="p-spectrum" class="p-spectrum" aria-hidden="true">${'<i></i>'.repeat(SPEC_BARS)}</div>
    </div>
    <div class="p-bot">
      <span class="p-time" id="p-time-cur">0:00</span>
      <input id="p-seek" type="range" min="0" max="1000" value="0" title="播放进度" aria-label="播放进度"/>
      <span class="p-time" id="p-time-dur">0:00</span>
      <i class="p-sep" aria-hidden="true"></i>
      <span class="p-vol-glyph" title="音量">VOL</span>
      <input id="p-vol" type="range" min="0" max="100" value="80" title="音量" aria-label="音量"/>
    </div>`;
  root.appendChild(bar);
  nowTitleEl = bar.querySelector("#p-now-title");
  nowArtistEl = bar.querySelector("#p-now-artist");
  specEl = bar.querySelector("#p-spectrum");

  listEl = document.createElement("div");
  listEl.id = "player-playlist";
  root.appendChild(listEl);

  bar.querySelector("#p-import")!.addEventListener("click", () => {
    importFiles();
  });
  bar.querySelector("#p-import")!.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    importFolder();
  });
  bar.querySelector("#p-mode")!.addEventListener("click", cycleMode);
  bar.querySelector("#p-prev")!.addEventListener("click", playPrev);
  bar.querySelector("#p-play")!.addEventListener("click", togglePlay);
  bar.querySelector("#p-next")!.addEventListener("click", playNext);
  bar.querySelector("#p-fav")!.addEventListener("click", () => {
    const s = currentSong();
    if (s) toggleFav(s.id);
    else toast("还没有正在播放的曲目");
  });
  bar.querySelector("#p-list")!.addEventListener("click", () => listEl!.classList.toggle("open"));
  /* 播放速度：1× → 1.25× → 1.5× → 2× → 0.75× 循环（原来独立播放器有的倍速） */
  const rateBtn = bar.querySelector("#p-rate") as HTMLButtonElement;
  const rates = [1, 1.25, 1.5, 2, 0.75];
  let rateIndex = 0;
  try {
    const saved = Number(localStorage.getItem("rhine-rate") || "1");
    const at = rates.indexOf(saved);
    if (at >= 0) rateIndex = at;
  } catch {
    /* ignore */
  }
  const applyRate = () => {
    const r = rates[rateIndex];
    audio.playbackRate = r;
    rateBtn.textContent = (r === 1 ? "1" : String(r)) + "×";
    rateBtn.classList.toggle("lit", r !== 1);
    rateBtn.title = "播放速度：" + r + "×（点击切换）";
    try {
      localStorage.setItem("rhine-rate", String(r));
    } catch {
      /* ignore */
    }
  };
  rateBtn.addEventListener("click", () => {
    rateIndex = (rateIndex + 1) % rates.length;
    applyRate();
  });
  applyRate();
  /* 音量（原来独立播放器有的音量条）；与设置里的背景音乐音量互不影响 */
  const volEl = bar.querySelector("#p-vol") as HTMLInputElement;
  let savedVolume = 0.8;
  try {
    const v = Number(localStorage.getItem("rhine-volume"));
    if (isFinite(v) && v >= 0 && v <= 1) savedVolume = v;
  } catch {
    /* ignore */
  }
  audio.volume = savedVolume;
  volEl.value = String(Math.round(savedVolume * 100));
  volEl.addEventListener("input", () => {
    const v = Number(volEl.value) / 100;
    audio.volume = v;
    try {
      localStorage.setItem("rhine-volume", String(v));
    } catch {
      /* ignore */
    }
  });
  bar.querySelector("#p-seek")!.addEventListener("input", (e) => {
    if (audio.duration) audio.currentTime = (Number((e.target as HTMLInputElement).value) / 1000) * audio.duration;
  });
  listEl.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    if (t.classList.contains("p-theme")) {
      toggleNight();
      return;
    }
    const fav = t.getAttribute("data-fav");
    const del = t.getAttribute("data-del");
    const queue = t.getAttribute("data-queue");
    const row = t.closest("[data-i]") as HTMLElement | null;
    if (queue) {
      queueNext(queue);
      return;
    }
    if (fav) {
      toggleFav(fav);
      return;
    }
    if (del) {
      removeSong(del);
      return;
    }
    if (row) playAt(Number(row.getAttribute("data-i")));
  });
  renderNow();
  paintTicks();
}

/* ---------- 详情区：把"档案内容"改造成曲目面板 ---------- */
export function hasSongs(): boolean {
  return songs.length > 0;
}
export function songAt(index: number): Song | null {
  return songs[index] ?? null;
}
export function toggleFavAt(index: number) {
  const s = songs[index];
  if (s) toggleFav(s.id);
}
const mmss = (s: number) => {
  if (!isFinite(s) || s <= 0) return "--:--";
  s = Math.floor(s);
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};
function sourceLabel(s: Song): string {
  if (s.srcUrl) return "B 站缓存";
  const name = s.filePath || (s.file ? s.file.name : "");
  const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toUpperCase();
  if (s.ncmPath) return "NCM → " + (ext || "MP3");
  if (ext) return ext + (s.file ? "" : " · 已入库");
  return "本地文件";
}
export function songDetailMarkup(index: number): string {
  const s = songs[index] ?? null;
  const empty = !s;
  const total = String(songs.length).padStart(3, "0");
  const status = empty ? "NO LIBRARY" : audio.paused ? "READY" : "PLAYING";
  const title = s ? s.title : "尚无曲目";
  const artist = s ? s.artist : "音乐库为空";
  const album = s ? s.album : "把音乐文件拖进窗口，或按下方 ＋ 导入";
  const facts: [string, string][] = empty
    ? [
        ["DURATION / 时长", "—"],
        ["PLAYED / 播放次数", "—"],
        ["FORMAT / 来源", "—"],
        ["FAVORITE / 收藏", "—"],
      ]
    : [
        ["DURATION / 时长", mmss(s!.duration)],
        ["PLAYED / 播放次数", `${s!.plays || 0} 次`],
        ["FORMAT / 来源", sourceLabel(s!)],
        ["FAVORITE / 收藏", s!.fav ? "已收藏" : "未收藏"],
      ];
  const actions = empty
    ? `<button class="solid-button" data-action="import-music">＋ IMPORT MUSIC<span>导入音乐</span></button>`
    : `<button class="solid-button" data-action="fav-track" aria-pressed="${s!.fav}">${s!.fav ? "− REMOVE FROM SAVED" : "＋ SAVE TRACK"}<span>${s!.fav ? "♥ 已收藏" : "♡ 收藏曲目"}</span></button>`;
  return `
  <div class="detail-kicker"><span>TRACK ${empty ? "000" : esc(s!.id.slice(-3).toUpperCase())}</span><span class="song-mode-kicker">${status} · ${MODE_EN[mode] ?? "LOOP"}</span></div>
  <div class="song-head">
    <div class="song-cover">${s && s.cover ? `<img src="${s.cover}" alt="${esc(s.title)} 封面"/>` : ""}</div>
    <div class="song-head-text">
      <h2>${esc(title)}</h2>
      <div class="detail-title-cn">${esc(artist)}<span>${esc(album)}</span></div>
    </div>
  </div>
  <div class="detail-rule"></div>
  <dl class="metadata">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${k.startsWith("PLAYED") ? "<i></i>" : ""}${esc(v)}</dd></div>`).join("")}</dl>
  <div class="song-viz">
    <div class="song-viz-head"><span class="panel-label">SPECTRUM / 实时频谱</span><span class="song-viz-note">40Hz – 16kHz · 对数分频 · 96 段</span></div>
    <canvas id="p-detail-spectrum" width="${Math.round(636 * 1.5)}" height="${Math.round(477 * 1.5)}" aria-hidden="true"></canvas>
    <div class="song-viz-axis"><span>LOW 40Hz</span><span>MID 1kHz</span><span>HIGH 16kHz</span></div>
    <div class="song-lyric-line" id="p-lyric-line"></div>
  </div>
  <div class="detail-actions">${empty ? actions : ""}<button class="export-button" data-action="play-now">${audio.paused ? "PLAY" : "PAUSE"} <span>${audio.paused ? "▶" : "■"}</span></button></div>
  <div class="detail-footnote"><span>${esc(artist)} · ${esc(album)}</span><span>${empty ? "000" : String(index + 1).padStart(3, "0")} / ${total}</span></div>`;
}
/** 详情区渲染完成后调用：接管频谱画布并点亮当前歌词行。 */
export function mountSongDetail(root: ParentNode) {
  stepLyrics();
  const cv = (root as HTMLElement).querySelector?.("#p-detail-spectrum") as HTMLCanvasElement | null;
  if (cv) {
    // 面板每次重绘都是新画布，因此频谱实例跟着重建（画布尺寸决定柱宽与渐变）
    spectrum = new Spectrum(cv, actx?.sampleRate ?? 48000);
    spectrum.setPalette(spectrumPalette());
    spectrum.setMode("mix");
    // 诊断开关：?viztest=1 时把实例与帧率对象挂到 window 上，便于自动化核对（见功能说明）
    if (VIZ_TEST || DIAG) {
      (window as any).__audioEl = audio;
      (window as any).__rhineViz = vizDiag;
      if (VIZ_TEST) (window as any).__spectrum = spectrum;
    }
  }
  if (vizRaf) return;
  const live = (analyserNode && !audio.paused) || VIZ_TEST;
  if (live) vizRaf = requestAnimationFrame(vizFrame);
}

/* ---------- 事件 ---------- */
audio.addEventListener("timeupdate", () => {
  const cur = audio.currentTime || 0;
  const dur = audio.duration || 0;
  const seek = document.querySelector("#p-seek") as HTMLInputElement | null;
  if (seek && dur) seek.value = String(Math.round((cur / dur) * 1000));
  const tc = document.querySelector("#p-time-cur");
  const td = document.querySelector("#p-time-dur");
  if (tc) tc.textContent = fmt(cur);
  if (td) td.textContent = fmt(dur);
  /* 位置只为"下次接着放"而存：内存里逐帧更新，落库有两条保护 ——
     （a）每 4 秒一次的兜底落库（用户反馈"点歌还是从头开始"就是把进度丢在了崩溃/强杀上），
     （b）暂停 / 切歌 / 关窗时各落一次，与原来一致。 */
  const s = currentSong();
  if (s && dur) {
    s.pos = cur;
    if (cur - posSavedAt >= 4) {
      posSavedAt = cur;
      persist(s);
    }
  }
  stepLyrics();
});
audio.addEventListener("loadedmetadata", () => {
  const s = currentSong();
  if (s && audio.duration) {
    s.duration = audio.duration;
    persist(s);
  }
  /* 续播：把上次这首停在的位置接上。两处保护 ——
     ① 位置离曲尾太近（不足 5 秒或不足 4%）就从头上放，不然一进来就结束；
     ② 只有真的落上了才清 pendingSeek，避免某些容器上 loadedmetadata 早于可寻址、
        currentTime 赋值被丢掉之后没人再补一次（见下面的 playing 兜底）。 */
  if (pendingSeek > 3 && audio.duration && pendingSeek < audio.duration - Math.max(5, audio.duration * 0.04)) {
    try {
      audio.currentTime = pendingSeek;
      if (DIAG) (window as any).__lastSeek = { at: "loadedmetadata", want: pendingSeek, got: audio.currentTime };
      if (Math.abs(audio.currentTime - pendingSeek) < 1) pendingSeek = 0;
    } catch {
      pendingSeek = 0;
    }
  } else {
    if (DIAG) (window as any).__lastSeek = { at: "loadedmetadata", want: pendingSeek || 0, got: -1, skipped: true };
    pendingSeek = 0;
  }
});
/* 播放真正开始后再补一次续播：个别容器在 loadedmetadata 阶段还寻址不了 */
audio.addEventListener("playing", () => {
  if (pendingSeek > 3 && audio.currentTime < 1 && audio.duration > pendingSeek + 5) {
    try {
      audio.currentTime = pendingSeek;
    } catch {
      /* ignore */
    }
  }
  if (audio.currentTime >= Math.max(1, pendingSeek - 1)) pendingSeek = 0;
});audio.addEventListener("play", () => {
  renderNow();
  void startViz();
});
audio.addEventListener("pause", () => {
  const s = currentSong();
  if (s) {
    s.pos = audio.currentTime || 0;
    (s as any)._savedAt = Date.now();
    persist(s);
  }
  renderNow();
});
audio.addEventListener("ended", () => {
  if (!songs.length) return;
  if (mode === "single") {
    audio.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  playNext();
});
const fmt = (s: number) => {
  if (!isFinite(s)) return "0:00";
  s = Math.max(0, Math.floor(s));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
};

/* 拖拽导入：文件/文件夹直接拖进窗口（原来独立播放器就有的入口） */
window.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});
window.addEventListener("drop", (e) => {
  const dt = (e as DragEvent).dataTransfer;
  if (!dt) return;
  e.preventDefault();
  if (dt.files && dt.files.length) void addFiles(dt.files);
});
/* 关窗/切到后台时把当前位置落一次，保证下次播放能续上 */
window.addEventListener("pagehide", savePosition);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) savePosition();
});
function savePosition() {
  const s = currentSong();
  if (s && audio.currentTime > 3) {
    s.pos = audio.currentTime;
    persist(s);
  }
}

/* ---------- 深色主题（整机，不只是播放条） ---------- */
export function toggleNight(force?: boolean) {
  const dark =
    force === undefined ? !document.body.classList.contains("theme-dark") : force;
  document.body.classList.toggle("theme-dark", dark);
  // 播放条 / 播放列表的暗色令牌挂在同一个类上（见 style.css），保证整机一致
  document.body.classList.toggle("rhine-night", dark);
  try {
    localStorage.setItem("rhine-night", dark ? "1" : "0");
  } catch {
    /* ignore */
  }
  spectrum?.setPalette(spectrumPalette());
}

/* ---------- 初始化 ---------- */
export async function initPlayer() {
  try {
    mode = localStorage.getItem("rhine-music-mode") || "list";
  } catch {
    /* ignore */
  }
  try {
    if (localStorage.getItem("rhine-night") === "1") {
      document.body.classList.add("theme-dark");
      document.body.classList.add("rhine-night");
    }
  } catch {
    /* ignore */
  }
  buildUI();
  // 先落一份（可能是空库 → 占位档案），保证三维档案阵列一进来就有东西可显示
  syncRecords();
  /* ★ 不 await 读库：IndexedDB 第一次打开要好几秒（实测 1.2–7 秒，取决于库大小与磁盘），
     挡在这里会让开屏、三维阵列和详情面板都跟着等。先按空库把界面立起来，
     读回来之后再通过 notify() 补一次 —— 空库时显示的"导入音乐"占位档案会被真实曲目替换。
     这同时修掉了旧写法的一个真实故障：原来是 1.5 秒的 Promise.race 超时，
     读得慢就整轮当空库，那一轮所有曲目都进不来。 */
  void loadLibrary().then(applyLibrary);
  void repairTags();
}

/** 读库兜底：库打开 / 读数据都不返回时按空库继续，开屏不会被卡住。
    注意这是"真的一条都没回来"才生效 —— 只要数据回来了就用真实结果。 */
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const timer = window.setTimeout(() => {
      if (!done) {
        done = true;
        resolve(fallback);
      }
    }, ms);
    const finish = (v: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    p.then(finish, () => finish(fallback));
  });
}
/** 读曲库。库大 + 磁盘忙时打开就要好几秒（实测 7 秒以上），
    所以超时预算给到 8 秒；以前是固定 1.5 秒的 Promise.race，
    读得慢就整轮当空库、所有曲目都进不来 —— 那就是用户看到的"曲库像空的"。 */
async function loadLibrary(): Promise<Song[]> {
  return withTimeout(idb.all(), LIB_LOAD_TIMEOUT, []).catch(() => []);
}
function applyLibrary(saved: Song[]) {
  if (saved.length) {
    songs = saved.sort((a, b) => (a.order || 0) - (b.order || 0));
    orderSeq = songs.reduce((m, s) => Math.max(m, s.order || 0), 0) + 1;
    currentId = null;
  }
  if (VIZ_TEST) (window as any).__libraryLoaded = songs.length;
  // 曲库到位：重排档案阵列、刷新播放列表与详情区（空库时的占位档案会被真实曲目换掉）
  notify();
  renderNow();
}
