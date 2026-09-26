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
  /* B 站缓存专用：s.path 是原始 .m4s 路径；triedBlob 记住"这一首已用 blob 播过"，
     避免播放失败时反复重建副本 / 反复读字节。都不落库（落库的只有持久字段）。 */
  triedBlob?: boolean;
  triedHeal?: boolean;
}

const desktop = (window as any).desktop as
  | {
      convertNcm?: (buf: ArrayBuffer) => Promise<any>;
      readCover?: (arg: { path: string }) => Promise<any>;
      findLyrics?: (p: string, t: string, a: string) => Promise<string | null>;
      scanBiliCache?: () => Promise<any>;
      prepareBiliAudio?: (p: string, force?: boolean) => Promise<any>;
      readAudio?: (p: string) => Promise<any>;
      on?: (channel: string, cb: (data: any) => void) => void;
    }
  | undefined;

let songs: Song[] = [];
let currentId: string | null = null;
/* 真正装进 <audio> 元素的是哪一首。启动时"记得上次播放的那首"只填界面不装音频，
   所以 currentId 和 loadedId 要分开：前者是"界面上的当前曲目"，后者是"音频里的那一首"。 */
let loadedId: string | null = null;
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
  /* ★ 曲库本身变了（导入 / 移除 / 批量修标签）之后必须重画播放条与播放列表。
     原来这里只通知"档案数据变了"（终端会重排阵列），播放器自己的界面要等下一次
     播放 / 暂停 / 换曲才重建 —— 用户看到的就是"在列表里点了 ✕，这首歌还在那儿"，
     于是认为删除功能坏了（其实库里已经删掉了，只是那一行 DOM 没重建）。
     顺带修掉同样的一个老毛病：往已有曲库里导入新歌，列表也不会当场多出这几行。 */
  renderNow();
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
/* 落库：曲目记录里**不带位置**。位置只有 localStorage 的一条全局播放头（见 savePlayhead），
   所以这里一律把 pos 抹成 0 再写 —— 否则内存里那一首恢复用的 pos 会跟着
   "收藏 / 改信息 / 补时长"这些无关的落库一起写回去，变成"这首歌又记住了上次位置"。
   用副本写，不改动内存里的对象。 */
const persist = (s: Song) => {
  idb.put(s.pos ? { ...s, pos: 0 } : s).catch(() => {});
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
/* ============================ 用户偏好（播放行为） ============================
   都在"系统设置 → 播放行为"里可改，存 localStorage：

   ★ 位置只保留**一条**：localStorage 的"全局播放头"（最后一次在听的那首 + 位置）。
     曲目记录（IndexedDB 里的 Song.pos）从这一版起一律是 0 ——
     用户明确要求"每首歌都不该记住自己的上次位置，切走再切回来从头放"。
     以前是每首歌各自攒 pos（timeupdate / pause / 切歌 / 关窗四条写路径），
     于是每首都有各自的续播点；现在这四条路径全部只更新那一条播放头。

     rememberPos：是否记这条播放头（默认开）。关掉后**完全不写**进度，启动也不续播；
     resumeLast：启动时是否自动把播放条恢复到上次那首与上次进度（默认开，随 rememberPos 走）；
     openOnPlay：起播时是否自动打开该曲目的档案详情（默认开）。
       关掉就只播不跳转，停在档案阵列里。 */
export interface PlaybackPrefs {
  rememberPos: boolean;
  resumeLast: boolean;
  openOnPlay: boolean;
}
const LS_PLAY_PREFS = "rhine-play-prefs";
export const playbackPrefs: PlaybackPrefs = (() => {
  const d: PlaybackPrefs = { rememberPos: true, resumeLast: true, openOnPlay: true };
  try {
    const raw = localStorage.getItem(LS_PLAY_PREFS);
    if (raw) {
      const o = JSON.parse(raw) as Partial<PlaybackPrefs>;
      if (typeof o.rememberPos === "boolean") d.rememberPos = o.rememberPos;
      if (typeof o.resumeLast === "boolean") d.resumeLast = o.resumeLast;
      if (typeof o.openOnPlay === "boolean") d.openOnPlay = o.openOnPlay;
    }
  } catch {
    /* ignore */
  }
  return d;
})();
function savePlaybackPrefs() {
  try {
    localStorage.setItem(LS_PLAY_PREFS, JSON.stringify(playbackPrefs));
  } catch {
    /* ignore */
  }
}
/** 记住进度：关掉之后所有写 pos / 写播放头的地方都要先过这一关 */
const rememberPos = () => playbackPrefs.rememberPos;
/** 改偏好：关掉"记住进度"（或"启动恢复"）时顺手把已经存下来的进度清掉（否则下次还会接着上次） */
export function setPlaybackPref(key: keyof PlaybackPrefs, value: boolean) {
  playbackPrefs[key] = value;
  savePlaybackPrefs();
  if (key === "rememberPos" || (key === "resumeLast" && !value)) {
    if (!playbackPrefs.rememberPos || !playbackPrefs.resumeLast) {
      for (const s of songs) if (s.pos) {
        s.pos = 0;
        persist(s);
      }
      try {
        localStorage.removeItem(LS_PLAYHEAD);
      } catch {
        /* ignore */
      }
      // 正在等着的续播点也一起作废，否则本次会话里还会往上次的位置跳一下
      pendingSeek = 0;
      posSavedAt = 0;
      markRestored(false);
    }
  }
  renderNow();
}
/* 系统设置 → 播放行为。三个开关的实现都在这一侧，标记也放在一起，
   免得 main.ts 的模板里再抄一份文案与 data 属性名。
   样式复用 .settings-list label（与 REDUCED MOTION 同一行式），不新增 CSS。 */
export function playbackSettingsMarkup(): string {
  const rows: [keyof PlaybackPrefs, string, string][] = [
    ["rememberPos", "REMEMBER LAST POSITION", "只记\"最后一次在听的那首 + 位置\"这一条，用于下次启动接着听；关掉后不写任何进度。任何一首歌都不会单独记住自己的上次位置，切走再切回一律从头播"],
    ["resumeLast", "RESUME LAST TRACK", "启动时把播放条恢复到上次在听的那一首与位置"],
    ["openOnPlay", "OPEN ARCHIVE ON PLAY", "起播时自动打开这首歌的档案详情"],
  ];
  return rows
    .map(
      ([key, title, desc]) =>
        `<label><div><strong>${title}</strong><span>${desc}</span></div><input type="checkbox" data-playpref="${key}"${playbackPrefs[key] ? " checked" : ""}/><i class="toggle"></i></label>`,
    )
    .join("");
}
/* ---------- B 站缓存的音源（"导入的放不出来"就是这里断的） ----------
   库里存的是【原始 .m4s 路径】（s.path，导入时由 bili.js 的 audioPath 写入）。要能播，两件事都得做：

   ① 主进程按需生成"可播放副本"（prepare-bili-audio → bili.ensureM4a）：
      电脑端缓存会在 mp4 前面塞 9 字节自定义头，Chromium 的解复用器不认，直接 MediaError 4。
      副本剥掉头才认。副本落在**会话临时目录**，退出即销毁 —— 所以每次启动都得重新生成。
   ② UI 挂在本机静态服务上（http://127.0.0.1:41739），`file://` 音源会被 Chromium 拦掉
      （Not allowed to load local resource）→ 必须用 read-audio 读回字节转成 blob 再喂给 <audio>。

   旧界面 app/index.html 一直靠"启动 ensureAllPlayable + 播放失败自愈 + blob 兜底"这三条撑住，
   终端界面重写时整段丢了：只把按钮搬了过来，音源这一路是坏的 —— 于是"导入的不能放"。
   现在改成播放前**按需**备好（不搞启动时全库重建，那是几十 MB 的白写）：先确保副本，
   能读字节就用 blob，读不到才退回 file:// 碰碰运气。 */
function fileUrlToPath(url: string): string {
  try {
    return decodeURIComponent(String(url || "").replace(/^file:\/\/\//i, "").replace(/^file:\/\//i, ""));
  } catch {
    return "";
  }
}
/** 让主进程备好可播放副本并把新地址写回 s.srcUrl；返回"地址变了没有"。
    幂等：副本已经正确时主进程直接返回原路径，几乎零开销。 */
async function ensurePlayableSource(s: Song, force = false): Promise<boolean> {
  if (!s || !s.path || !desktop?.prepareBiliAudio) return false;
  try {
    const r = await desktop.prepareBiliAudio(s.path, !!force);
    if (r && r.ok && r.url) {
      const changed = s.srcUrl !== r.url;
      s.srcUrl = r.url;
      return changed;
    }
  } catch {
    /* ignore */
  }
  return false;
}
/** 把音频文件读成 blob 地址（绕开 file:// 限制）。读不到返回空串。 */
async function blobUrlOf(s: Song): Promise<string> {
  const p = fileUrlToPath(s.srcUrl || "") || s.path || "";
  if (!p || !desktop?.readAudio) return "";
  try {
    const res = await desktop.readAudio(p);
    if (res && res.bytes && res.bytes.byteLength) {
      const url = URL.createObjectURL(new Blob([res.bytes], { type: res.mime || "audio/mp4" }));
      s.triedBlob = true;
      return url;
    }
  } catch {
    /* ignore */
  }
  return "";
}
/* 起播前把待续播位置准备好（内存值，不落库） */
function armPendingSeek(s: Song) {
  pendingSeek = rememberPos() && s.pos > 3 ? s.pos : 0;
  posSavedAt = rememberPos() && s.pos > 3 ? s.pos : 0;
}
function diagLoad(s: Song) {
  if (!DIAG) return;
  (window as any).__lastLoad = {
    id: s.id,
    title: s.title,
    pos: s.pos,
    pendingSeek,
    urlKind: s.srcUrl ? (s.path ? "bili" : "url") : s.file ? "blob" : "none",
  };
}
/** 装 B 站缓存那一路的音源：副本 → blob → file://（依次退）。异步，装好再 play。 */
let loadSeq = 0;
async function loadBiliAudio(s: Song, autoplay: boolean) {
  const token = ++loadSeq;
  loadedId = null; // 装好之前不算"已装载"，用户这时点它 playAt 会真的来加载
  armPendingSeek(s);
  diagLoad(s);
  if (autoplay) audio.pause(); // 先把上一首停住，免得异步备源期间它还在响
  await ensurePlayableSource(s, false);
  if (token !== loadSeq || currentId !== s.id) return;
  const blob = await blobUrlOf(s);
  if (token !== loadSeq || currentId !== s.id) {
    if (blob) URL.revokeObjectURL(blob);
    return;
  }
  // blob 记进 currentUrl，下次切歌时连同上一首的一起回收
  if (blob) {
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = blob;
  }
  /* 读不到字节就退回 file://：本机多数情况会被 Chromium 拦掉，但真拦了会触发 error
     自愈（重建副本 → 再试 blob），不会把这一首彻底闷死。 */
  audio.src = blob || s.srcUrl || "";
  loadedId = s.id;
  if (autoplay) audio.play().catch(() => {});
}
/** 只把音频装进 <audio> 元素（不碰界面状态）。启动时的"恢复上次曲目"不走这里。 */
function loadSongAudio(s: Song, autoplay = false) {
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
  s.triedBlob = false;
  s.triedHeal = false;
  if (s.srcUrl) {
    // B 站缓存：副本要在会话临时目录里重新生成，而且必须绕开 file:// 限制 —— 异步装载
    void loadBiliAudio(s, autoplay);
    return;
  }
  loadedId = null;
  if (s.file) {
    currentUrl = URL.createObjectURL(s.file);
    audio.src = currentUrl;
  }
  loadedId = s.id;
  armPendingSeek(s);
  diagLoad(s);
}
function selectSong(id: string, autoplay = false) {
  /* ★ 离开这一首时**不落位置**了：以前这里会把 audio.currentTime 写进 leaving.pos 再落库，
     于是每首歌都攒下自己的"上次听到哪"。现在只有全局播放头那一条，切歌就等于把它换成新的一首。
     内存里也一并清掉 —— 启动恢复时会把位置摆在那一首的 s.pos 上，不清的话
     来回切几次它还会拿着那个旧位置去续播。 */
  const leaving = songs.find((x) => x.id === currentId);
  if (leaving && leaving.id !== id) {
    leaving.pos = 0;
    pendingSeek = 0;
    posSavedAt = 0;
  }
  currentId = id;
  const s = songs.find((x) => x.id === id);
  if (!s) return;
  loadSongAudio(s, autoplay);
  spectrum?.resetPeaks();
  renderNow();
  // 让三维档案阵列与详情区跟上正在播放的这一首（播放列表与档案阵列是同一份数据）
  const index = songs.findIndex((x) => x.id === id);
  if (index >= 0) {
    window.dispatchEvent(new CustomEvent("rhine-track", { detail: index }));
  }
}
/** 收起播放列表抽屉（它和播放条共用同一个宽度，是压在三维档案阵列上的浮层）。 */
function closePlaylist() {
  listEl?.classList.remove("open");
}
/* 起播之后把终端切到"这首歌的档案"（系统设置 → 播放行为 · openOnPlay，默认开）。
   ★ 两个入口必须一致：在播放列表里点一行、和在档案上点播放，结果都要"档案被打开"。
   ★ 打开档案前先收起播放列表抽屉：那是 880×560 的浮层，正好盖住左侧的三维档案阵列，
     不收起的话"先在列表里点歌、再去点别的档案"会被它整块吃掉 —— 用户反馈的"切换失灵"。
   （事件只在 player 这一侧派发，终端收到后自己决定进不进详情：开屏、弹窗、编辑态、
     360° 查看器占着画面时不抢。） */
function followWithArchive(index: number) {
  if (index < 0 || !playbackPrefs.openOnPlay) return;
  closePlaylist();
  window.dispatchEvent(new CustomEvent("rhine-open-track", { detail: index }));
}
export function playAt(i: number) {
  if (!songs.length) return;
  i = ((i % songs.length) + songs.length) % songs.length;
  const s = songs[i];
  /* 点的就是当前这首、而且**真的装进 audio 元素**了：不要重新加载（重新赋 audio.src
     会回到 0 秒），暂停中就接着放、正在放就保持 —— 这就是"点歌不要重新播放"。
     判据用 currentId === loadedId：启动时"记得上次播放的那首"只填了界面，
     还没装进 audio，那时候点它必须真的去加载。
     ★ 但"把画面跟到这首"照旧要做（原来这里直接 return）：先在列表里点歌、再去点别的档案
     把选中态挪走之后，再点回列表里这一首，档案阵列就再也切不回它了。 */
  if (s.id === currentId && s.id === loadedId) {
    if (audio.paused) audio.play().catch(() => {});
    window.dispatchEvent(new CustomEvent("rhine-track", { detail: i }));
    followWithArchive(i);
    return;
  }
  selectSong(s.id, true);
  markRestored(false);
  s.plays = (s.plays || 0) + 1;
  persist(s);
  /* 普通文件（objectURL）在这里起播；B 站缓存那一类的音源是异步备好的
     （要重新生成副本 + 读字节转 blob），由 loadBiliAudio 自己起播 ——
     这里再 play() 一次只会把上一首的残留音源又推起来。 */
  if (!s.srcUrl) audio.play().catch(() => {});
  followWithArchive(i);
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
  const s = currentSong();
  if (!s) return;
  /* ★ 启动时"恢复上次在听的那一首"只把界面填出来 —— `currentId` 有了，但 `loadedId`
     还是 null（音频没装进 <audio>）。以前这里直接 audio.play()，等于对着空元素喊播放：
     一声不响，用户必须先点列表里的**别的**一首（走 playAt → 真的加载）才能播 ——
     用户反馈的"刚打开必须切到下一首才能正常播放"就是这一句。
     现在先确认"这一首真的装进去了"，没装就走完整条加载（playAt 会带着播放）。 */
  if (loadedId !== s.id) {
    playAt(currentIndex());
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
/* ---------- 媒体键（耳机 / 键盘上的播放暂停、上一首、下一首） ----------
   两条通路都要接住：
     · 主进程用 globalShortcut 接系统媒体键，再通过 'media-key' 发过来（app/main.js 的 mediaAction）；
     · navigator.mediaSession 的 action handler（系统媒体面板 / 部分蓝牙耳机自己走这条路）。
   ★ 整合进终端时这两条一起丢了：按键下去在主进程有记录，渲染侧却没有任何监听，
     所以耳机键完全没反应。旧实现在 app/index.html 的 handleMediaKey()，
     两条通路可能同时触发，所以保留 300ms 防抖。 */
let lastMediaKeyAt = 0;
function handleMediaKey(action: string) {
  if (typeof action !== "string") return;
  const now = performance.now();
  if (now - lastMediaKeyAt < 300) return;
  lastMediaKeyAt = now;
  if (action === "play" || action === "playpause") {
    if (songs.length) togglePlay();
  } else if (action === "pause") {
    if (!audio.paused) audio.pause();
  } else if (action === "next") {
    playNext();
  } else if (action === "prev") {
    playPrev();
  }
}
desktop?.on?.("media-key", handleMediaKey);
if ("mediaSession" in navigator) {
  try {
    navigator.mediaSession.setActionHandler("play", () => handleMediaKey("play"));
    navigator.mediaSession.setActionHandler("pause", () => handleMediaKey("pause"));
    navigator.mediaSession.setActionHandler("nexttrack", () => handleMediaKey("next"));
    navigator.mediaSession.setActionHandler("previoustrack", () => handleMediaKey("prev"));
  } catch {
    /* 个别环境不支持 mediaSession：不影响主进程那条通路 */
  }
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
  /* 「下一首播放」队列里可能还留着这一首的 id：不清掉的话，列表头的"队列 N"会永远多算一个，
     而且按下一首时会先空转一次（playNext 里虽然会跳过已不存在的 id，但那一下是白等的）。 */
  nextQueue = nextQueue.filter((x) => x !== id);
  if (wasCurrent) {
    if (songs.length) {
      currentId = null;
      selectSong(songs[Math.min(i, songs.length - 1)].id);
      audio.currentTime = 0;
    } else {
      currentId = null;
      loadedId = null;
      audio.pause();
      audio.removeAttribute("src");
    }
  }
  /* notify() 现在会把播放列表一起重画（见上面的注释），所以删完这一行立刻消失。 */
  notify();
}

/* ---------- 导入 ---------- */
/** 曲目的"身份键"，用来判重（同一个文件不会被导入两次）。
    优先级：B 站缓存的原始 .m4s 路径 → 本地文件绝对路径（Electron 里 File.path）
    → 文件名 + 体积（浏览器里没有路径时的兜底）。
    ★ 键必须来自**两边都有的同一份字段**：库里已有的曲目和正要导入的这一首，
      用的是同一个函数算键，所以"同一个文件再导一次""同一个缓存文件夹再导一次"
      都会命中。返回空串表示判不了身份，这种一律照旧导入（宁可重复也不误吞）。 */
function songKey(s: Song): string {
  if (s.srcUrl && s.path) return "bili:" + s.path.toLowerCase();
  if (s.filePath) return "file:" + s.filePath.toLowerCase();
  if (s.file) return "blob:" + s.file.name.toLowerCase() + "\u0001" + s.file.size;
  return "";
}
/** 已经导入过的身份键集合（导入前取一次快照） */
function existingKeys(): Set<string> {
  const set = new Set<string>();
  for (const s of songs) {
    const k = songKey(s);
    if (k) set.add(k);
  }
  return set;
}
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
  /* ★ 判重：同一个文件（同一路径，或同名同体积）不再重复导入。
     集合在整个循环里累积 —— 一次拖进来两个相同文件时，第二个也会被跳过。 */
  const seen = existingKeys();
  let dup = 0;
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
    /* 判重放在这一行的位置：标签已解析完，但还没建曲目、没落库 ——
       ★ 必须早于 readTags / 封面读取之外的所有副作用，尤其不能先 persist 再判重。 */
    const key = songKey({ file: audioFile, filePath, srcUrl: undefined, path: undefined, ncmPath } as Song);
    if (key) {
      if (seen.has(key)) {
        dup++;
        continue;
      }
      seen.add(key);
    }
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
  if (added && dup) toast(`导入完成：新增 ${added} 首，跳过重复 ${dup} 首`);
  else if (!added && dup) toast(`这些曲目已经在曲库里了（跳过重复 ${dup} 首）`);
  else toast(`导入完成：新增 ${added} 首`);
}
/* 探时长：B 站缓存那一路的 file:// 音源会被拦，失败时"确保副本 → 读字节转 blob"再测一次，
   否则列表里这一首的时长永远是 0:00。 */
function probeDuration(s: Song) {
  const tmp = new Audio();
  let url = s.srcUrl || (s.file ? URL.createObjectURL(s.file) : "");
  let done = false;
  const drop = (u: string) => {
    if (u.startsWith("blob:")) URL.revokeObjectURL(u);
  };
  tmp.preload = "metadata";
  tmp.onloadedmetadata = () => {
    if (done) return;
    done = true;
    if (tmp.duration) {
      s.duration = tmp.duration;
      persist(s);
    }
    drop(url);
  };
  tmp.onerror = () => {
    if (done) return;
    drop(url);
    if (!s.path || !desktop?.readAudio) return;
    done = true;
    void (async () => {
      await ensurePlayableSource(s, false);
      const b = await blobUrlOf(s);
      if (!b) return;
      const t2 = new Audio();
      t2.preload = "metadata";
      t2.onloadedmetadata = () => {
        if (t2.duration) {
          s.duration = t2.duration;
          persist(s);
        }
        URL.revokeObjectURL(b);
      };
      t2.onerror = () => URL.revokeObjectURL(b);
      t2.src = b;
    })();
  };
  if (url) tmp.src = url;
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
  /* ★ 提示必须写"请选择"：这一步会弹系统的文件夹选择框（主进程的 bili-scan），
     并不会自己去猜缓存目录。从前写的是"正在扫描 B 站缓存…"，
     用户会以为程序已经自己找到了，然后莫名其妙冒出个选文件夹的框。 */
  toast("请选择 B 站缓存文件夹（含 entry.json 或 audio.m4s）");
  let res: any;
  try {
    res = await desktop.scanBiliCache();
  } catch (e) {
    toast("扫描失败");
    return;
  }
  if (!res || res.canceled) {
    toast("已取消");
    return;
  }
  if (res.error) {
    toast("扫描出错：" + res.error);
    return;
  }
  const items = res.items || [];
  if (!items.length) {
    toast("这个文件夹里没有识别到 B 站缓存（需要 entry.json 或 audio.m4s）");
    return;
  }
  let added = 0;
  /* 判重：同一个缓存文件夹再导入一次时，原始 .m4s 路径没变 → 全部命中，不再堆重复曲目。
     集合在循环里累积，同一个文件夹里出现两条同源记录也只进一条。 */
  const seen = existingKeys();
  let dup = 0;
  for (const it of items) {
    const key = it.audioPath ? "bili:" + String(it.audioPath).toLowerCase() : "";
    if (key) {
      if (seen.has(key)) {
        dup++;
        continue;
      }
      seen.add(key);
    }
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
  if (added && dup) toast(`B站缓存导入：新增 ${added} 首，跳过重复 ${dup} 首`);
  else if (!added && dup) toast(`这些 B 站缓存已经在曲库里了（跳过重复 ${dup} 首）`);
  else toast(`B站缓存导入：新增 ${added} 首`);
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
/* ?viztest=1：不播音乐，用合成信号跑频谱 —— 用来在无音频的环境里核对频谱观感。
   信号要有**真实音乐的频谱形状**：粉噪打底（每倍频程 −3dB，高频自然衰减）＋ 一条低频
   基音与它的谐波 ＋ 每 4 秒一次的鼓点包络。
   早先这里是"55Hz + 440Hz + 2.4kHz 三个纯音"——纯音经过 1024 点 Hann 加窗后
   旁瓣泄漏很宽，120 个对数频段的读数几乎一样大，本帧峰值归一后全部贴到 1.0，
   看起来就是"柱子全顶满"，完全没法用来看观感。 */
let vizTestPhase = 0;
let vizNoiseLp = 0; // 粉噪的一阶低通状态（跨帧连续，噪声才连贯）
let vizNoiseIdx = 0; // 已生成的采样总数（时间轴连续，避免每帧从头开始）
const VIZ_NOISE_HP = 0.55; // 粉噪的高频衰减（一阶低通系数）
function vizTestTimeData(out: Float32Array) {
  const sr = actx?.sampleRate ?? 48000;
  vizTestPhase += 1;
  const beat = Math.pow(Math.max(0, Math.sin((vizTestPhase / 120) * Math.PI * 2)), 8);
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const t = (vizNoiseIdx + i) / sr;
    /* 频谱形状要**像真实音乐**：低频厚、高频薄（一阶低通 ＝ −6dB/oct，再叠白噪垫底）。
       早先用"三个纯音"，1024 点 Hann 加窗后旁瓣泄漏很宽，120 个对数频段读数几乎一样，
       本帧峰值归一后整排都贴到 1.0，看起来就是"柱子全顶满"——完全没法用来看观感。 */
    vizNoiseLp += (Math.random() * 2 - 1 - vizNoiseLp) * VIZ_NOISE_HP;
    let s = vizNoiseLp * 0.9 + (Math.random() * 2 - 1) * 0.1;
    // 低频基音 + 谐波（受鼓点包络调制），给低频那根"细针"一点真实素材
    const env = 0.35 + 0.65 * beat;
    s +=
      env *
      (0.26 * Math.sin(2 * Math.PI * 55 * t) +
        0.12 * Math.sin(2 * Math.PI * 110 * t) +
        0.05 * Math.sin(2 * Math.PI * 220 * t));
    // 中高频人声区：窄带扫频（随鼓点起伏）
    s += env * 0.06 * Math.sin(2 * Math.PI * (700 + 400 * Math.sin(2 * Math.PI * 0.3 * t)) * t);
    out[i] = Math.max(-1, Math.min(1, s * 0.5));
  }
  vizNoiseIdx += n;
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
/* 播放列表搜索：只过滤显示，不动曲库顺序 —— 行上的 data-i 始终是 songs 里的真实下标，
   所以过滤状态下点行、删除、收藏、下一首播放都照旧作用于正确的曲目。 */
let listQuery = "";
let rowsEl: HTMLElement | null = null;
let countEl: HTMLElement | null = null;
let searchEl: HTMLInputElement | null = null;
/** 当前搜索词命中的曲目下标（空词 = 全部）。曲名 / 艺术家 / 专辑都参与匹配。 */
function matchedIndexes(): number[] {
  const q = listQuery.trim().toLowerCase();
  const out: number[] = [];
  for (let i = 0; i < songs.length; i++) {
    if (!q) {
      out.push(i);
      continue;
    }
    const s = songs[i];
    if ((s.title + "\u0001" + s.artist + "\u0001" + s.album).toLowerCase().includes(q)) out.push(i);
  }
  return out;
}
function listSignature() {
  let sig = songs.length + "|" + currentId + "|" + nextQueue.join(",");
  /* 签名里必须带上曲目文本：删掉一首、或者改了某一首的标题 / 艺术家 / 专辑之后，
     只比"数量 + 收藏"是看不出差别的 —— 那种情况下列表会继续显示旧的文字。
     （renderNow 每次都会算一遍，所以这里只做最便宜的字符串拼接。） */
  for (let i = 0; i < songs.length; i++)
    sig += (songs[i].fav ? "1" : "0") + "\u0001" + songs[i].title + "\u0002" + songs[i].artist + "\u0002" + songs[i].album;
  return sig;
}
function renderList() {
  if (!listEl || !rowsEl) return;
  /* 搜索词也进签名：词一变就必须重画（数量、收藏、文字都没变时旧逻辑会直接 return） */
  const sig = listSignature() + "\u0003" + listQuery;
  if (sig === listSig) return;
  listSig = sig;
  const s = currentSong();
  const queued = new Set(nextQueue);
  const ids = matchedIndexes();
  const q = listQuery.trim();
  /* 表头右侧：平时显示总数，搜索时显示"命中 / 总数" */
  if (countEl)
    countEl.textContent =
      (q ? `${ids.length} / ${songs.length} 首匹配` : `${String(songs.length).padStart(2, "0")} TRACKS`) +
      (nextQueue.length ? ` · 队列 ${nextQueue.length}` : "");
  rowsEl.innerHTML = songs.length
    ? ids.length
      ? ids
          .map((i) => {
            const x = songs[i];
            return `<div class="p-row${x.id === currentId ? " active" : ""}${queued.has(x.id) ? " queued" : ""}" data-i="${i}"><span class="p-idx">${String(i + 1).padStart(2, "0")}</span><span class="p-meta"><b>${esc(x.title)}</b><small>${esc(x.artist)}${x.album ? " · " + esc(x.album) : ""}${x.fav ? " ／ ♥" : ""}${queued.has(x.id) ? " ／ 下一首" : ""}</small></span><button class="p-queue" data-queue="${x.id}" title="下一首播放">↳</button><button class="p-fav${x.fav ? " on" : ""}" data-fav="${x.id}" title="收藏">${x.fav ? "♥" : "♡"}</button><button class="p-del" data-del="${x.id}" title="移除">✕</button></div>`;
          })
          .join("")
      : `<div class="p-empty">没有匹配「${esc(q)}」的曲目。<br/>换个关键词，或点搜索框右边的 ✕ 清除。</div>`
    : `<div class="p-empty">尚无曲目。点击 ＋ 导入音乐文件，右键 ＋ 导入整个文件夹，也可以把文件直接拖进窗口。</div>`;
  if (s && listEl.classList.contains("open")) {
    const idx = songs.findIndex((x) => x.id === s.id);
    // 正在播放的这一首被过滤掉了就不跳（否则会滚到一个不存在的位置）
    if (idx >= 0 && ids.includes(idx)) rowsEl.querySelector(`[data-i="${idx}"]`)?.scrollIntoView({ block: "nearest" });
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
        <button id="p-bili" title="导入 B 站缓存（选择本机缓存文件夹，自动识别其中的音频）" aria-label="导入 B 站缓存"><svg viewBox="0 0 24 24" width="14" height="14" style="fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round"><rect x="3" y="7.4" width="18" height="12.4" rx="2.6"/><path d="M8 3.6 12 7l4-3.4"/></svg></button>
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
  /* 表头 + 搜索框放在一个 sticky 壳里，滚动时都留在顶上；
     曲目行单独放 #p-rows —— 重画只碰 #p-rows，搜索框不会因为重画丢焦点 / 丢输入。 */
  listEl.innerHTML =
    `<div class="p-sticky"><div class="p-head"><b>ARCHIVE ARRAY ／ 播放列表</b><span id="p-count"></span><button class="p-theme" title="深色 / 浅色主题">◐</button></div>` +
    `<div class="p-search-row"><input id="p-search" type="search" placeholder="搜索曲名 / 艺术家 / 专辑" autocomplete="off" spellcheck="false" aria-label="搜索歌曲"/><button id="p-search-clear" title="清除搜索（ESC）" aria-label="清除搜索">✕</button></div></div>` +
    `<div id="p-rows"></div>`;
  root.appendChild(listEl);
  rowsEl = listEl.querySelector("#p-rows");
  countEl = listEl.querySelector("#p-count");
  searchEl = listEl.querySelector("#p-search");
  searchEl?.addEventListener("input", () => {
    listQuery = searchEl!.value;
    renderList();
  });
  /* 搜索框里的键自己消化掉：ESC 清词（再按一次收抽屉），回车播放第一条命中的曲目。
     stopPropagation 是必须的 —— 终端那一层也监听 keydown，不拦住的话
     ESC 会去关详情、回车会去"读取档案"。 */
  searchEl?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      if (searchEl!.value) {
        searchEl!.value = "";
        listQuery = "";
        renderList();
      } else {
        closePlaylist();
      }
      return;
    }
    if (e.key === "Enter") {
      e.stopPropagation();
      const ids = matchedIndexes();
      if (ids.length) playAt(ids[0]);
    }
  });
  listEl.querySelector("#p-search-clear")?.addEventListener("click", () => {
    if (!searchEl) return;
    searchEl.value = "";
    listQuery = "";
    renderList();
    searchEl.focus();
  });

  bar.querySelector("#p-import")!.addEventListener("click", () => {
    importFiles();
  });
  bar.querySelector("#p-import")!.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    importFolder();
  });
  /* B 站缓存：后端一直在（app\bili.js 负责真正的"识别"——按 mp4 盒子的 stsd
     判断哪个 .m4s 是音频轨，再补齐标题 / UP 主 / 封面），但**整合进终端时把入口丢了**：
     importBili() 一直没人调用，界面上也没有按钮，旧界面的 #biliBtn 没搬过来。
     这里补回播放条上的入口，紧挨着导入按钮。 */
  bar.querySelector("#p-bili")!.addEventListener("click", () => {
    void importBili();
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
  /* 抽屉点外面就收起。它是压在左侧三维档案阵列上的浮层（880×560），
     一直开着的话，点在阵列卡片上的那一下会被它整块吃掉、什么都不会发生 ——
     用户看到的就是"先点列表播放、再点其他档案切换失灵"。
     点 ☰ 自己不算"外面"，否则它会先把抽屉关掉、紧接着又被 toggle 打开。 */
  document.addEventListener("pointerdown", (e) => {
    if (!listEl?.classList.contains("open")) return;
    const t = e.target;
    if (!(t instanceof Element) || t.closest("#player-playlist") || t.closest("#p-list")) return;
    closePlaylist();
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
  <div class="detail-actions">${empty ? actions : ""}<button class="solid-button" data-action="edit-track">✎ EDIT INFO<span>修改歌曲信息</span></button><button class="export-button" data-action="play-now">${audio.paused ? "PLAY" : "PAUSE"} <span>${audio.paused ? "▶" : "■"}</span></button></div>
  <div class="detail-footnote"><span>${esc(artist)} · ${esc(album)}</span><span>${empty ? "000" : String(index + 1).padStart(3, "0")} / ${total}</span></div>`;
}

/* ============================ 歌曲信息编辑 / 封面读取 ============================
   这一块是"手工修曲库"的入口，补的是从旧版独立播放器迁过来时丢掉的两件事：
   ① 歌曲信息可改（标题 / 艺术家 / 专辑，落库并立刻反映到档案阵列、播放条与三维封面板）；
   ② 封面读取（从音频文件里重新抠内嵌封面 / 找同目录 cover 图 / 自己选一张本地图片）。
   改完不必重开：封面会通过 rhine-cover 事件同步给终端与三维场景。 */
let editIndex = -1;
let editDraft = { title: "", artist: "", album: "" };
const EDIT_STATUS_ID = "p-edit-status";
function editStatus(msg: string, kind: "ok" | "warn" = "ok") {
  const el = document.getElementById(EDIT_STATUS_ID);
  if (!el) {
    toast(msg);
    return;
  }
  el.textContent = msg;
  el.dataset.kind = kind;
}
/** 编辑态的详情区：左侧封面 + 字段，右侧一列行动作；下方保留频谱 */
export function songEditMarkup(index: number): string {
  const s = songs[index];
  if (!s) return songDetailMarkup(index);
  editIndex = index;
  editDraft = { title: s.title || "", artist: s.artist || "", album: s.album || "" };
  const hasPath = Boolean(s.filePath && !s.srcUrl);
  const coverSrc = s.cover || "";
  return `
  <div class="detail-kicker"><span>EDIT TRACK ${esc(s.id.slice(-3).toUpperCase())}</span><span class="song-mode-kicker">INFO / 歌曲信息</span></div>
  <div class="edit-grid">
    <div class="edit-cover">
      <div class="edit-cover-box" id="p-edit-cover" title="把图片拖进来，或点下面的按钮选一张">
        ${coverSrc ? `<img src="${coverSrc}" alt="${esc(s.title)} 封面" id="p-edit-cover-img"/>` : `<span class="edit-cover-empty">NO COVER<br/>无封面</span>`}
      </div>
      <div class="edit-cover-actions">
        <button class="edit-mini" data-action="edit-cover-file">读取本地图片</button>
        <button class="edit-mini" data-action="edit-cover-embed"${hasPath ? "" : ` disabled title="这一首没有本地文件路径，读不到内嵌封面"`}>重新读取内嵌封面</button>
        <button class="edit-mini" data-action="edit-cover-none">恢复默认封面</button>
      </div>
      <div class="edit-note">支持把图片直接拖到上面的方框里</div>
    </div>
    <div class="edit-fields">
      <label class="edit-field"><span>标题 / TITLE</span><input type="text" id="p-edit-title" maxlength="120" autocomplete="off" spellcheck="false" value="${esc(editDraft.title)}"/></label>
      <label class="edit-field"><span>艺术家 / ARTIST</span><input type="text" id="p-edit-artist" maxlength="120" autocomplete="off" spellcheck="false" value="${esc(editDraft.artist)}"/></label>
      <label class="edit-field"><span>专辑 / ALBUM</span><input type="text" id="p-edit-album" maxlength="120" autocomplete="off" spellcheck="false" value="${esc(editDraft.album)}"/></label>
      <div class="edit-hint">
        <button class="edit-mini" data-action="edit-reread">重新识别元数据</button>
        <span>从音频文件里再读一次标题 / 艺术家 / 专辑 / 内嵌封面（会覆盖上面的输入）</span>
      </div>
      <div class="edit-status" id="${EDIT_STATUS_ID}" data-kind="ok">改完点右下角 SAVE 保存；ESC 取消。</div>
    </div>
  </div>
  <div class="song-viz">
    <div class="song-viz-head"><span class="panel-label">SPECTRUM / 实时频谱</span><span class="song-viz-note">编辑时仍在播放 · 频谱照常</span></div>
    <canvas id="p-detail-spectrum" width="${Math.round(636 * 1.2)}" height="${Math.round(300 * 1.2)}" aria-hidden="true"></canvas>
  </div>
  <div class="detail-actions">
    <button class="solid-button" data-action="edit-cancel">✕ DISCARD<span>放弃修改</span></button>
    <button class="export-button" data-action="edit-save">SAVE <span>✓</span></button>
  </div>
  <div class="detail-footnote"><span>${esc(editDraft.artist)} · ${esc(editDraft.album)}</span><span>${String(index + 1).padStart(3, "0")} / ${String(songs.length).padStart(3, "0")}</span></div>`;
}
/** 编辑态渲染完成后调用：接管字段、封面按钮与频谱画布 */
export function mountSongEdit(root: ParentNode) {
  const host = root as HTMLElement;
  const q = <T extends HTMLElement>(sel: string) => host.querySelector(sel) as T | null;
  const readFields = () => {
    editDraft.title = (q<HTMLInputElement>("#p-edit-title")?.value ?? "").trim();
    editDraft.artist = (q<HTMLInputElement>("#p-edit-artist")?.value ?? "").trim();
    editDraft.album = (q<HTMLInputElement>("#p-edit-album")?.value ?? "").trim();
    return editDraft;
  };
  for (const id of ["#p-edit-title", "#p-edit-artist", "#p-edit-album"]) {
    q<HTMLInputElement>(id)?.addEventListener("input", readFields);
  }
  const pickCover = q<HTMLElement>("[data-action='edit-cover-file']");
  pickCover?.addEventListener("click", (e) => {
    e.stopPropagation();
    pickCoverImage();
  });
  q<HTMLElement>("[data-action='edit-cover-embed']")?.addEventListener("click", (e) => {
    e.stopPropagation();
    void reloadEmbeddedCover();
  });
  q<HTMLElement>("[data-action='edit-cover-none']")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const s = songs[editIndex];
    if (!s) return;
    s.cover = defaultCover(s.title, s.artist);
    persist(s);
    paintEditCover(s.cover);
    markCoverChanged();
    editStatus("已恢复默认封面（点 SAVE 才会写进曲库… 这一项已即时生效）");
  });
  q<HTMLElement>("[data-action='edit-reread']")?.addEventListener("click", (e) => {
    e.stopPropagation();
    void rereadMetadata();
  });
  /* 把图片拖到封面上 = 读取本地图片 */
  const box = q<HTMLElement>("#p-edit-cover");
  if (box) {
    const stop = (ev: Event) => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    box.addEventListener("dragover", (ev) => {
      stop(ev);
      box.classList.add("drop");
    });
    box.addEventListener("dragleave", () => box.classList.remove("drop"));
    box.addEventListener("drop", (ev) => {
      stop(ev);
      box.classList.remove("drop");
      const f = (ev as DragEvent).dataTransfer?.files?.[0];
      if (f) void useCoverImage(f);
    });
    // 点封面方框本身也走"选图片"（比去点小按钮顺手）
    box.addEventListener("click", (e) => {
      e.stopPropagation();
      pickCoverImage();
    });
  }
  // 频谱照常：编辑时音乐还在放，画布不能黑着
  const cv = host.querySelector("#p-detail-spectrum") as HTMLCanvasElement | null;
  if (cv) {
    spectrum = new Spectrum(cv, actx?.sampleRate ?? 48000);
    spectrum.setPalette(spectrumPalette());
    spectrum.setMode("mix");
    if (VIZ_TEST || DIAG) (window as any).__rhineViz = vizDiag;
  }
  if (!vizRaf) {
    const live = (analyserNode && !audio.paused) || VIZ_TEST;
    if (live || spectrum) vizRaf = requestAnimationFrame(vizFrame);
  }
}
/** 选一张本地图片当封面（隐藏的 file input，选中后自动清理） */
function pickCoverImage() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.style.display = "none";
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    input.remove();
    if (f) void useCoverImage(f);
  });
  document.body.appendChild(input);
  input.click();
}
/** 把用户给的图片压到 512×512 JPEG 存进曲库（和导入时的处理保持一致，避免库里塞大图） */
async function useCoverImage(file: File) {
  const s = songs[editIndex];
  if (!s) return;
  if (!/^image\//i.test(file.type) && !/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name)) {
    editStatus("这不是图片文件（支持 PNG / JPG / WebP / GIF / BMP）", "warn");
    return;
  }
  const raw = await new Promise<string | null>((res) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result || ""));
    fr.onerror = () => res(null);
    fr.readAsDataURL(file);
  });
  const dataUrl = raw ? await coverToDataUrl(raw) : null;
  if (!dataUrl) {
    editStatus("这张图片读不出来，换一张试试", "warn");
    return;
  }
  s.cover = dataUrl;
  persist(s);
  paintEditCover(dataUrl);
  markCoverChanged();
  editStatus(`封面已设为「${file.name}」（约 ${Math.round(dataUrl.length / 1024)}KB，已写进曲库）`);
}
/** 从音频文件重新抠内嵌封面 / 同目录封面图 */
async function reloadEmbeddedCover() {
  const s = songs[editIndex];
  if (!s) return;
  if (s.srcUrl) {
    editStatus("这一首是 B 站缓存导入的，源文件是 m4s，读不到内嵌封面 —— 可以自己选一张图片当封面", "warn");
    return;
  }
  editStatus("正在从音频文件里读封面…");
  let got: string | null = null;
  if (desktop?.readCover && s.filePath) {
    try {
      const rc = await desktop.readCover({ path: s.filePath });
      if (rc && rc.dataUrl) got = rc.dataUrl;
      if (rc && rc.error) editStatus("内嵌封面读取失败：" + rc.error, "warn");
    } catch (e) {
      editStatus("内嵌封面读取失败：" + String((e as any)?.message || e), "warn");
    }
  }
  if (!got && s.file) {
    try {
      const meta = await readTags(s.file);
      if (meta.cover) got = meta.cover;
      if (meta.title && !editDraft.title) editDraft.title = meta.title;
      if (meta.artist && !editDraft.artist) editDraft.artist = meta.artist;
      if (meta.album && !editDraft.album) editDraft.album = meta.album;
      stampEditFields();
    } catch {
      /* ignore */
    }
  }
  if (!got) {
    editStatus("这个文件里没有内嵌封面，同目录也没有 cover / folder 图片", "warn");
    return;
  }
  const dataUrl = await coverToDataUrl(got);
  if (!dataUrl || dataUrl === s.cover) {
    editStatus("读到的封面和现在这张一样", "warn");
    return;
  }
  s.cover = dataUrl;
  persist(s);
  paintEditCover(dataUrl);
  markCoverChanged();
  editStatus("封面已按音频文件里的内嵌封面 / 同目录图片更新");
}
/** 整条重新识别：标题 / 艺术家 / 专辑 / 封面都从文件里重读一遍，填进表单（点 SAVE 才落库） */
async function rereadMetadata() {
  const s = songs[editIndex];
  if (!s) return;
  if (!s.file) {
    editStatus("这一首没有原始文件（已入库的旧曲目），读不到标签 —— 可以手工填", "warn");
    return;
  }
  editStatus("正在重新识别…");
  try {
    const meta = await readTags(s.file);
    const fb = niceName(s.file.name);
    editDraft.title = meta.title || fb.title || editDraft.title;
    editDraft.artist = meta.artist || fb.artist || editDraft.artist;
    editDraft.album = meta.album || editDraft.album;
    stampEditFields();
    if (meta.cover) {
      const dataUrl = await coverToDataUrl(meta.cover);
      if (dataUrl) {
        s.cover = dataUrl;
        persist(s);
        paintEditCover(dataUrl);
        markCoverChanged();
      }
    }
    editStatus("重新识别完成：标题 / 艺术家 / 专辑已填好，点 SAVE 保存");
  } catch (e) {
    editStatus("重新识别失败：" + String((e as any)?.message || e), "warn");
  }
}
function stampEditFields() {
  const set = (id: string, v: string) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el && el.value !== v) el.value = v;
  };
  set("p-edit-title", editDraft.title);
  set("p-edit-artist", editDraft.artist);
  set("p-edit-album", editDraft.album);
}
function paintEditCover(src: string) {
  const box = document.getElementById("p-edit-cover");
  if (!box) return;
  let img = box.querySelector("img") as HTMLImageElement | null;
  if (!img) {
    box.querySelector(".edit-cover-empty")?.remove();
    img = document.createElement("img");
    img.id = "p-edit-cover-img";
    box.appendChild(img);
  }
  img.src = src;
}
/** 封面变了：让终端与三维场景跟着换（main.ts 监听 rhine-cover） */
function markCoverChanged() {
  window.dispatchEvent(new CustomEvent("rhine-cover", { detail: { index: editIndex } }));
}
/** 保存编辑里的三个文本字段 */
export function applySongEdit(): { ok: boolean; message: string } {
  const s = songs[editIndex];
  if (!s) return { ok: false, message: "没有正在编辑的曲目" };
  const t = (editDraft.title || "").trim();
  const a = (editDraft.artist || "").trim();
  const b = (editDraft.album || "").trim();
  if (!t && !a && !b) return { ok: false, message: "标题、艺术家、专辑不能全空" };
  s.title = t || "未命名曲目";
  s.artist = a || "未知艺术家";
  s.album = b || "未知专辑";
  persist(s);
  const changed = [];
  if (s.id === currentId) changed.push("播放条");
  changed.push("档案阵列", "详情面板");
  return { ok: true, message: `已保存《${s.title}》（${changed.join(" / ")}已同步）` };
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
      if (VIZ_TEST) {
        (window as any).__spectrum = spectrum;
        // 合成信号的峰值：用来核对 ?viztest=1 的时域数据到底有没有在跑
        (window as any).__vizTestProbe = () => {
          const out = new Float32Array(1024);
          const beat = vizTestTimeData(out);
          let peak = 0;
          for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
          return { beat, peak, sr: actx?.sampleRate ?? 0 };
        };
      }
    }
  }
  if (vizRaf) return;
  const live = (analyserNode && !audio.paused) || VIZ_TEST;
  if (live) vizRaf = requestAnimationFrame(vizFrame);
}

/* 播放失败自愈（B 站缓存这一路）：副本被会话清理、头没剥干净、file:// 被拦时，
   强制重建副本，再退回 blob 播放。旧界面 app/index.html 里就有这一段，重写时一并丢了 ——
   于是导入进来的曲目点了没反应也没提示。每首只自愈一次，避免来回重试。 */
let playbackErrorHandling = false;
audio.addEventListener("error", async () => {
  const s = currentSong();
  const code = audio.error ? audio.error.code : 0;
  const why =
    code === 4 ? "格式不支持或文件头异常" : code === 3 ? "解码失败" : code === 2 ? "读取失败" : code === 1 ? "读取被中止" : "未知错误";
  const name = s ? `《${s.title}》` : "当前曲目";
  if (s && s.path && desktop?.prepareBiliAudio && !playbackErrorHandling && !s.triedHeal) {
    playbackErrorHandling = true;
    s.triedHeal = true;
    try {
      toast(`${name}${why}，正在重建可播放副本…`);
      await ensurePlayableSource(s, true); // force = 强制重建
      if (currentId === s.id) {
        const blob = await blobUrlOf(s);
        if (blob) {
          if (currentUrl && currentUrl !== blob) URL.revokeObjectURL(currentUrl);
          currentUrl = blob;
        }
        const src = blob || s.srcUrl || "";
        if (src && src !== audio.src) {
          audio.src = src;
          loadedId = s.id;
          audio.play().catch(() => {});
          playbackErrorHandling = false;
          return;
        }
      }
    } catch {
      /* 落到下面的提示 */
    }
    playbackErrorHandling = false;
  }
  toast(`${name}无法播放：${why}${code ? `（MediaError ${code}）` : ""}`);
});

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
  /* ★ 进度只保留**一条**：localStorage 里的"全局播放头"（最后一次在听的那首 + 位置）。
     用户明确要求：**每首曲目都不该记住自己的上次位置** —— 切走再切回来一律从头放。
     所以这里不再往 s.pos 写、也不再为进度落库，位置只由下面的 savePlayhead() 覆盖写一条。 */
  const s = currentSong();
  if (s && dur) {
    // 播放条上那行"上次听到这里"的提示，一旦真的开始播就撤掉
    markRestored(false);
  }
  /* localStorage 里的播放头（上次在听哪首、听到哪）—— 每次 timeupdate 覆盖写，
     量很小，换来的是"不管是正常关窗还是被强杀，下次启动都能显示上次的位置"。 */
  savePlayhead();
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
  if (rememberPos() && pendingSeek > 3 && audio.currentTime < 1 && audio.duration > pendingSeek + 5) {
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
  /* 暂停时同样不往这一首上写位置，只更新那一条全局播放头 */
  savePlayhead();
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
/* 关窗/切到后台时把"全局播放头"落一次，保证下次启动能接着上次那首听 */
window.addEventListener("pagehide", savePosition);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) savePosition();
});
function savePosition() {
  savePlayhead();
}

/* ---------- 启动时恢复"上次播放的那一首 + 上次的位置" ----------
   目标很具体：**软件启动后，播放条上要显示上次在听的那首和它的进度**，
   这样一眼能看出上次听到哪，按播放就从那儿继续。

   为什么不用 `currentId = 上次那首` 就算完：那等于告诉 playAt()"这首已经装好了"，
   于是点它会走 early-return、根本不加载。所以：
     · 只调 `selectSong(id)`——它负责记住"界面上的当前曲目"并渲染播放条与列表，
       不碰 audio 元素（加载音频的那几句在 `loadSongAudio()` 里）；
     · 再用 `loadedId = null` 标明"还没装进 audio"，点播放时就真的会去加载。 */
const LS_PLAYHEAD = "rhine-playhead";
function savePlayhead() {
  /* 关了"记住进度"就一个字都不落，并且把之前已经存下的播放头清掉 ——
     否则下次启动还是会被 restorePlayhead 捡起来显示"上次听到这里"。
     ★ 位置直接取 audio.currentTime，不再从 s.pos 取：曲目记录里已经不保存位置了
     （只有"正在放的那一首"这一刻的实时位置会被写进这条播放头）。 */
  if (!rememberPos()) {
    try {
      localStorage.removeItem(LS_PLAYHEAD);
    } catch {
      /* ignore */
    }
    return;
  }
  const s = currentSong();
  if (!s) return;
  const live = s.id === loadedId ? audio.currentTime || 0 : 0;
  try {
    localStorage.setItem(LS_PLAYHEAD, JSON.stringify({ id: s.id, pos: Math.max(0, live) }));
  } catch {
    /* ignore */
  }
}
function restorePlayhead() {
  /* 两个偏好都要求才恢复：rememberPos 管"记不记"，resumeLast 管"启动要不要接上"。
     任一为假都不该在启动时把播放条摆到上次那首的位置上（这就是"还在记录进度"的观感来源）。 */
  if (!rememberPos() || !playbackPrefs.resumeLast) return;
  let saved: { id?: string; pos?: number } | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(LS_PLAYHEAD) || "null");
  } catch {
    saved = null;
  }
  if (!saved || !saved.id) return;
  const s = songs.find((x) => x.id === saved!.id);
  if (!s) return; // 这首已经被移除了
  const pos = saved.pos || s.pos || 0;
  if (pos > 3) s.pos = pos;
  currentId = s.id;
  loadedId = null; // 还没装进 audio
  /* 播放条：曲名 / 艺术家 / 进度 / 时间都按上次的位置显示。
     audio 元素还是空的，时长取库里记的 duration。 */
  renderNow();
  const seek = document.querySelector("#p-seek") as HTMLInputElement | null;
  const tc = document.querySelector("#p-time-cur");
  const td = document.querySelector("#p-time-dur");
  const dur = s.duration || 0;
  if (seek && dur > 0) seek.value = String(Math.round((Math.min(pos, dur) / dur) * 1000));
  if (tc) tc.textContent = fmt(pos);
  if (td) td.textContent = dur > 0 ? fmt(dur) : "--:--";
  markRestored(true);
  if (DIAG) (window as any).__restored = { id: s.id, title: s.title, pos, dur };
  // 让档案阵列与详情面板也停在上一首上（用户看到的是"上次听的这首"）
  const index = songs.findIndex((x) => x.id === s.id);
  if (index >= 0) window.dispatchEvent(new CustomEvent("rhine-track", { detail: index }));
}
/** 给播放条加一个"接着上次听"的提示，并在用户真的起播后清掉 */
function markRestored(on: boolean) {
  const el = document.querySelector<HTMLElement>("#p-now-title");
  if (!el) return;
  const wrap = el.parentElement;
  if (!wrap) return;
  wrap.classList.toggle("resumed", on);
  const old = wrap.querySelector<HTMLElement>(".p-resume");
  if (on && !old) {
    const tag = document.createElement("em");
    tag.className = "p-resume";
    tag.textContent = "上次听到这里 · 按播放继续";
    wrap.appendChild(tag);
  } else if (!on && old) {
    old.remove();
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
/** 清理历史遗留的重复曲目（同一个文件 / 同一个 B 站缓存源只留一条）。
    用户要"重复歌曲不再导入"，但库里可能已经堆了重复，所以启动时顺手清一次。
    ★ 只认**硬的**身份键：`file:`（本地文件绝对路径）与 `bili:`（原始 .m4s 路径）——
      同一路径必然是同一个文件。浏览器模式的 `blob:` 键（文件名 + 体积）判据不够硬，
      不参与自动清理，宁可留着让用户自己删。
    保哪一条：优先收藏过的，其次播放次数多的，再其次 order 最小的（最早导入的那条）；
    被合并掉的那些把收藏与播放次数并进保留的那条。 */
function dedupeLibrary(): number {
  const byKey = new Map<string, Song[]>();
  for (const s of songs) {
    const k = songKey(s);
    if (!k || (!k.startsWith("file:") && !k.startsWith("bili:"))) continue;
    const list = byKey.get(k);
    if (list) list.push(s);
    else byKey.set(k, [s]);
  }
  const drop = new Set<string>();
  const remap = new Map<string, string>(); // 被合并掉的 id → 保留下来的那条 id
  let removed = 0;
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) =>
      Number(b.fav) - Number(a.fav) || (b.plays || 0) - (a.plays || 0) || (a.order || 0) - (b.order || 0),
    );
    const keep = list[0];
    for (const s of list.slice(1)) {
      keep.fav = keep.fav || s.fav;
      keep.plays = (keep.plays || 0) + (s.plays || 0);
      drop.add(s.id);
      remap.set(s.id, keep.id);
      removed++;
    }
    persist(keep);
  }
  if (!removed) return 0;
  songs = songs.filter((s) => !drop.has(s.id));
  for (const id of drop) {
    idb.del(id).catch(() => {});
    nextQueue = nextQueue.filter((x) => x !== id);
  }
  if (currentId && drop.has(currentId)) {
    currentId = remap.get(currentId) ?? null;
    loadedId = null;
  }
  /* ★ 播放头也得改指：它记的是"上次在听的那一首"。如果那一条正好是被合并掉的重复，
     restorePlayhead() 会找不到这首直接 return —— 播放条空着（或停在第 0 档），
     而用户记得的是"上次明明在听某一首"，也就是反馈的
     "显示的曲目标题不是上次打开时最后播放的歌曲名"。改成指向保留的那条。 */
  try {
    const raw = localStorage.getItem(LS_PLAYHEAD);
    if (raw) {
      const ph = JSON.parse(raw) as { id?: string; pos?: number } | null;
      const next = ph && ph.id ? remap.get(ph.id) : undefined;
      if (next) {
        localStorage.setItem(LS_PLAYHEAD, JSON.stringify({ ...ph, id: next }));
      }
    }
  } catch {
    /* ignore */
  }
  return removed;
}
function applyLibrary(saved: Song[]) {
  if (saved.length) {
    songs = saved.sort((a, b) => (a.order || 0) - (b.order || 0));
    orderSeq = songs.reduce((m, s) => Math.max(m, s.order || 0), 0) + 1;
    currentId = null;
    loadedId = null;
    /* ★ 读回来的 pos 一律清零：曲目记录从这一版起不再保存"上次位置"，
       只有启动时那一条全局播放头（restorePlayhead）会把位置摆到播放条上。
       旧版本写进库里的那些值就此作废，不会再让某首歌"从中间开始放"。 */
    for (const s of songs) s.pos = 0;
  }
  if (VIZ_TEST) (window as any).__libraryLoaded = songs.length;
  /* 曲库到位后顺手清一次历史重复（同一文件只留一条），再恢复播放条 / 阵列 / 列表 */
  const cleaned = dedupeLibrary();
  restorePlayhead();
  notify();
  renderNow();
  if (cleaned) window.setTimeout(() => toast(`已清理 ${cleaned} 首重复曲目`), 1200);
}
