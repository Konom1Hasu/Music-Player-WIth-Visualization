// 音乐播放器：把本地音乐库映射成"档案"，驱动三维档案阵列，并提供传输控制。
// 后端能力（NCM 解密 / B 站缓存 / 读封面 / 歌词 / 读音频）复用 Electron 的 window.desktop。
import { setRecords, type ArchiveRecord } from "./data";
import {
  Spectrum,
  analysisWindow,
  SPECTRUM_WINDOW,
  SPECTRUM_BANDS,
  SPECTRUM_F_MIN,
  SPECTRUM_F_MAX_RATIO,
  SPECTRUM_KICK_FROM,
  SPECTRUM_KICK_TO,
  SPECTRUM_KICK_REF_ATTACK,
  SPECTRUM_KICK_REF_RELEASE,
  SPECTRUM_KICK_FLOOR,
  SPECTRUM_KICK_GAIN,
  SPECTRUM_TR_REF_ATTACK,
  SPECTRUM_TR_REF_RELEASE,
  SPECTRUM_TR_FLOOR,
  SPECTRUM_TR_GAIN,
  SPECTRUM_TR_BOOST,
  SPECTRUM_TR_BANDS_REF,
  SPECTRUM_TR_FROM,
  vizParams,
  setVizParams,
  clampVizParams,
  clampHeadroom,
  KICK_PUMP_MIN,
  type VizParams,
  type SpectrumPalette,
  type SpectrumMode,
} from "./spectrum";
import {
  beatmapOf,
  hasBeatmap,
  requestBeatmaps,
  requestBeatmapNow,
  setBeatmapHooks,
  setBeatmapEnabled,
  beatmapEnabled,
  beatmapStatus,
  type BeatMap,
} from "./beatmap";

/* ---------- 可视化参数：默认 1.3.0 原值，启动时可从旧版导入一次 ----------
   旧版播放器的调音面板把 平衡/峰宽/抖动/鼓点/峰高 存在 localStorage 的 mp_* 里，
   但那份存储属于 **file:// 域**，新版是 http://127.0.0.1:41739 域 —— 同源策略下读不到，
   所以走主进程开隐藏页去读（app/main.js 的 import-legacy-settings）。
   用户调过的值（例如 平衡 63、峰高 1.45）就是他习惯的观感，比"原版默认值"更该用。 */
const LS_VIZ = "rhine-viz-params";
const LS_VIZ_IMPORTED = "rhine-viz-imported";
let vizModePref = "mix";
function loadVizParams() {
  try {
    const raw = localStorage.getItem(LS_VIZ);
    if (!raw) return;
    const stored = clampVizParams(JSON.parse(raw) as Partial<VizParams>);
    const head = clampHeadroom(stored);
    setVizParams(head);
    /* 已经导入过旧设置的机器（存储里是 鼓点 0）会一直"左峰顶满"，
       这里夹回 KICK_PUMP_MIN 并把结果写回存储，免得每次启动都要再夹一遍。
       ★ 只写一次就收敛：head 与 stored 一致时不再写。 */
    if (head.kickPump !== stored.kickPump) saveVizParams();
  } catch {
    /* ignore */
  }
}
function saveVizParams() {
  try {
    localStorage.setItem(LS_VIZ, JSON.stringify({ ...vizParams }));
  } catch {
    /* ignore */
  }
}
loadVizParams();
/** 一次性把旧版调音参数导进来（导入成功后写进 rhine-viz-params，不再重复导入）。 */
export async function importLegacyVizSettings(): Promise<boolean> {
  let already = false;
  try {
    already = localStorage.getItem(LS_VIZ_IMPORTED) === "1";
  } catch {
    /* ignore */
  }
  if (already || !desktop?.importLegacySettings) return false;
  let res: any = null;
  try {
    res = await desktop.importLegacySettings();
  } catch {
    return false;
  }
  if (!res || res.error || !res.values) return false;
  const v = res.values as Record<string, string>;
  const int = (k: string, lo: number, hi: number) => {
    const n = parseInt(String(v[k] ?? ""), 10);
    return isFinite(n) && n >= lo && n <= hi ? n : null;
  };
  const next: Partial<VizParams> = {};
  const tilt = int("mp_tilt", 0, 100);
  if (tilt !== null) next.tilt = tilt; // 频谱平衡（越大左侧整体越高）
  const bw = int("mp_bassw2", 20, 80);
  if (bw !== null) next.bassSigma = bw / 1000; // 峰宽（σ = 值/1000）
  const jit = int("mp_jit2", 40, 200);
  if (jit !== null) next.jitterK = jit / 100; // 抖动倍率
  const kick = int("mp_kick", 0, 60);
  if (kick !== null) next.kickPump = kick / 100; // 鼓点泵动（0 = 左峰一直顶满，下面会被闸门夹到 KICK_PUMP_MIN）
  const peak = int("mp_peakh", 55, 145);
  if (peak !== null) next.peakTarget = peak / 100; // 峰高（左峰静态高度目标）
  /* 夹一道"留余量"闸门：旧版的 鼓点 0 / 峰高 ≥1.25 都会让左峰一直顶满（原版面板自己也这么标注），
     用户明确要求"可视化左侧不要一直顶满"，所以这两项不再照搬旧值。 */
  const applied = clampVizParams(clampHeadroom(next));
  if (!Object.keys(applied).length) return false;
  setVizParams(applied);
  saveVizParams();
  if (typeof v.mp_viz === "string" && /^(mix|timbre|bars|ring|wave)$/.test(v.mp_viz)) vizModePref = v.mp_viz;
  try {
    localStorage.setItem(LS_VIZ_IMPORTED, "1");
  } catch {
    /* ignore */
  }
  if (spectrum) spectrum.applyParams();
  const brief = [
    `平衡 ${Math.round(vizParams.tilt)}`,
    `峰宽 ${(vizParams.bassSigma * 1000).toFixed(0)}`,
    `抖动 ${(vizParams.jitterK * 100).toFixed(0)}`,
    `鼓点 ${(vizParams.kickPump * 100).toFixed(0)}`,
    `峰高 ${vizParams.peakTarget.toFixed(2)}`,
  ].join(" / ");
  /* 夹过闸门要说一句：用户看到"鼓点 40"而不是旧版的 0，得知道为什么 */
  const kickRaw = next.kickPump;
  const note = typeof kickRaw === "number" && kickRaw < KICK_PUMP_MIN
    ? `（旧版 鼓点 ${(kickRaw * 100).toFixed(0)} 会让左峰一直顶满，已按原版留余量的 ${(KICK_PUMP_MIN * 100).toFixed(0)} 收住）`
    : "";
  toast(`已导入旧版调音设置：${brief}${note}`);
  return true;
}

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
  /* B 站缓存专用：
     · s.path      = 原始 .m4s 路径（外部缓存目录，随时可能被清理）
     · s.localPath = **固化进曲库目录的本地副本**（与源缓存彻底解耦，源删了也照播）
     · s.missing   = 源已不在、又没有固化副本 → 这一首真的播不了（如实标出来，
                     不让它伪装成"B 站缓存"等用户点了才报错）
     · triedHeal 是本次会话内的自愈标记，不落库 */
  localPath?: string;
  missing?: boolean;
  triedHeal?: boolean;
  /* 离线预分析出来的"乐谱"（节拍网格 + 能量包络，见 beatmap.ts）。
     ★ 它是**派生数据**：算不出来就 undefined，可视化退回纯在线模式，
       绝不能参与任何"能不能播"的判断 —— 那一类判断只看音源。 */
  bm?: BeatMap | null;
}

const desktop = (window as any).desktop as
  | {
      convertNcm?: (buf: ArrayBuffer) => Promise<any>;
      readCover?: (arg: { path: string }) => Promise<any>;
      findLyrics?: (p: string, t: string, a: string) => Promise<string | null>;
      scanBiliCache?: () => Promise<any>;
      prepareBiliAudio?: (p: string, force?: boolean) => Promise<any>;
      keepBiliAudio?: (p: string) => Promise<any>;
      localAudioInfo?: () => Promise<any>;
      importLegacySettings?: () => Promise<any>;
      readAudio?: (p: string) => Promise<any>;
      /** 轻量探活：只 stat 不读字节 → { ok, path, size, fixed } | { ok:false, error } */
      audioExists?: (p: string) => Promise<any>;
      on?: (channel: string, cb: (data: any) => void) => void;
      getHotkeyStatus?: () => Promise<any>;
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
/* ★ 变速必须"保音调"（time-stretch 而不是 resample）。
   两个属性名都要设：Chromium 认 `preservesPitch`，而 webkit 内核 / 旧版 Electron
   只认 `webkitPreservesPitch`。不显式打开的话，0.75× 会明显发闷、1.5× 会变成"花栗鼠"
   —— 用户听播客/有声书最常用的就是这两档，观感差距极大。
   这里显式设 true，并在设置面板把结果读出来给用户看（见 rateToolsMarkup），
   因为"浏览器默认值"是随版本变化的，不能靠猜。 */
function applyPreservePitch() {
  let supported = false;
  try {
    if ("preservesPitch" in audio) {
      (audio as any).preservesPitch = true;
      supported = true;
    }
    if ("webkitPreservesPitch" in audio) {
      (audio as any).webkitPreservesPitch = true;
      supported = true;
    }
  } catch {
    /* ignore */
  }
  return supported;
}
const PRESERVE_PITCH_SUPPORTED = applyPreservePitch();
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

/* ---------- 排列顺序 ----------
   用户要求"歌曲列表添加多种排列顺序"。曲目顺序就是档案阵列的顺序（records 由 songs 生成），
   所以这里排的是**同一份数据**：列表与阵列一起变。
   所有跨引用都走 id（播放头、下一首队列、正在播放的那首），重排不会串位；
   但**下标**会变，所以排完必须把"当前这一首的新下标"告诉终端（见 applySort），
   否则右侧档案信息／详情还停在旧下标上 —— 又是"显示的和正在播放的不符"那一类问题。 */
const SORT_LABEL: Record<string, string> = {
  import: "导入顺序",
  title: "曲名",
  artist: "艺术家",
  album: "专辑",
  duration: "时长",
  plays: "播放次数",
  recent: "最近添加",
};
const LS_SORT = "rhine-sort";
let sortMode: string = (() => {
  try {
    const v = localStorage.getItem(LS_SORT);
    return v && v in SORT_LABEL ? v : "import";
  } catch {
    return "import";
  }
})();
function sortSongs() {
  const cmpText = (a: string, b: string) => String(a || "").localeCompare(String(b || ""), "zh-Hans-CN");
  if (sortMode === "title") songs.sort((a, b) => cmpText(a.title, b.title) || (a.order || 0) - (b.order || 0));
  else if (sortMode === "artist")
    songs.sort((a, b) => cmpText(a.artist, b.artist) || cmpText(a.title, b.title) || (a.order || 0) - (b.order || 0));
  else if (sortMode === "album")
    songs.sort((a, b) => cmpText(a.album, b.album) || cmpText(a.title, b.title) || (a.order || 0) - (b.order || 0));
  else if (sortMode === "duration") songs.sort((a, b) => (a.duration || 0) - (b.duration || 0) || (a.order || 0) - (b.order || 0));
  else if (sortMode === "plays") songs.sort((a, b) => (b.plays || 0) - (a.plays || 0) || (a.order || 0) - (b.order || 0));
  else if (sortMode === "recent") songs.sort((a, b) => (b.order || 0) - (a.order || 0));
  /* import（默认）：导入顺序，也就是 order 升序 */
  else songs.sort((a, b) => (a.order || 0) - (b.order || 0));
}
function applySort(announce = false) {
  sortSongs();
  notify();
  const i = currentIndex();
  if (i >= 0) window.dispatchEvent(new CustomEvent("rhine-track", { detail: i }));
  if (announce) toast(`排列顺序：${SORT_LABEL[sortMode]}`);
}
export function setSortMode(mode: string) {
  if (!(mode in SORT_LABEL)) return;
  sortMode = mode;
  try {
    localStorage.setItem(LS_SORT, mode);
  } catch {
    /* ignore */
  }
  /* ★ 重排放在下一轮任务里做，**不在 change 事件里同步重排整库**：
     重排会重建档案记录、重画列表、刷新三维阵列（很重），而它是在
     `<select>` 的原生 change 分发过程中被调用的 —— 无头环境里那条路径会卡住主线程，
     真机上虽然没问题，但把"选完立刻做重活"拆开本来也更稳。 */
  window.setTimeout(() => {
    try {
      applySort(true);
    } catch {
      /* ignore */
    }
  }, 0);
}
export function sortModeMarkup(): string {
  return Object.entries(SORT_LABEL)
    .map(([v, label]) => `<option value="${v}"${v === sortMode ? " selected" : ""}>${label}</option>`)
    .join("");
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
    ["rememberPos", "REMEMBER LAST POSITION", "记住最后在听的那一首与位置，用于下次接着听；关掉则不写任何进度"],
    ["resumeLast", "RESUME LAST TRACK", "启动时恢复上次那一首与位置"],
    ["openOnPlay", "OPEN ARCHIVE ON PLAY", "起播时自动打开这首歌的档案"],
  ];
  return rows
    .map(
      ([key, title, desc]) =>
        `<label><div><strong>${title}</strong><span>${desc}</span></div><input type="checkbox" data-playpref="${key}"${playbackPrefs[key] ? " checked" : ""}/><i class="toggle"></i></label>`,
    )
    .join("");
}
/* ---------- B 站缓存的音源（"导入的放不出来"就是这里断的） ----------
   库里存的是【原始 .m4s 路径】（s.path，导入时由 bili.js 的 audioPath 写入）。
   另外导入时会把"可播放副本"复制一份到 <userData>\library\audio（s.localPath）——
   这是**与源缓存解耦**的那一份，源文件夹被删掉/移走也能照常播放。

   要能播，两件事都得做：

   ① 主进程按需生成"可播放副本"（prepare-bili-audio → bili.ensureM4a）：
      电脑端缓存会在 mp4 前面塞 9 字节自定义头，Chromium 的解复用器不认，直接 MediaError 4。
      副本剥掉头才认。会话副本落在**临时目录**（退出即销毁），所以源还在时每次启动都要重建；
      源没了就只能靠 s.localPath 那份本地副本。
   ② UI 挂在本机静态服务上（http://127.0.0.1:41739），`file://` 音源会被 Chromium 拦掉
      （Not allowed to load local resource）→ 必须用 read-audio 读回字节转成 blob 再喂给 <audio>。

   取音源的优先级：**本地保留副本（s.localPath）→ 会话副本（从源缓存现做）→ 源缓存本身**。
   三样都没有时给一条明确的提示（"源缓存已被删除，本地副本也不在"），而不是静默无声。 */
function fileUrlToPath(url: string): string {
  try {
    return decodeURIComponent(String(url || "").replace(/^file:\/\/\//i, "").replace(/^file:\/\//i, ""));
  } catch {
    return "";
  }
}
/* 会话副本目录名形如 mp-session-<sid>，落在系统临时目录，**随进程退出即销毁**。
   ★ 所以凡是 mp-session-* 的路径，**一律不可信** —— 不只是"别人的会话"，
     连"当前会话"的也不该被持久化进曲库（重启就没了）。
     历史遗留记录里就存着
       file:///C:/Users/KONOMI~1/AppData/Local/Temp/mp-session-07c53b8c53d7/audio/xxx.m4a
     它既带 8.3 短名、又指向早已消失的会话，却被当成兜底音源一路放行到 <audio>，
     于是每次播放都报"文件不存在"，且报错**一个字节都不变**（因为记录从没被重写）。
   → 判定标准：路径里出现 mp-session- 就判死，强制走 s.path 重建。 */
function isStaleSessionPath(p: string): boolean {
  return /[\\/]mp-session-[0-9a-f]+[\\/]/i.test(String(p || ""));
}
/** 上一次"取音源"失败的原因（源文件不存在 / 生成副本失败），供报错提示用 */
let lastSourceError = "";
/** 取"现在能读的音频文件路径"：
    ① 本地保留副本（与源缓存解耦）—— 有就直接用；
    ② 会话副本：让主进程从源缓存现做（源还在时才可能成功）；
    ③ 都拿不到 → 返回空串，并把原因记在 lastSourceError 里。
    force = true 时跳过 ①（播放报错后的自愈：强制从源重建）。
   ★ ① 必须确认副本在盘上：老版本存过 8.3 短名路径，盲目采用会一路读到失败。
   ★ 这里**不再**碰 s.srcUrl —— 它是"上一次算出来的结果"，可能早已失效。
     以前把它当兜底（fileUrlToPath(s.srcUrl)）正是"报错一直不变"的元凶：
     旧记录里的 srcUrl 指向已消失的会话目录，却被无条件拿去读。 */
async function playablePathOf(s: Song, force = false): Promise<string> {
  if (s.localPath && !force) {
    if (await audioReadableExists(s.localPath)) return s.localPath;
    s.localPath = undefined; // 副本已不在，丢掉失效引用
  }
  if (s.path && desktop?.prepareBiliAudio) {
    try {
      const r = await desktop.prepareBiliAudio(s.path, !!force);
      if (r && r.ok && r.path) {
        s.srcUrl = r.url || s.srcUrl;
        lastSourceError = "";
        /* ★ 搭个便车：源还在、副本也刚做出来了 —— 顺手固化一份到曲库目录，
           下次源被删就不必再求人。fire-and-forget，不拖慢播放启动；
           失败也无妨（下次播放会再试一遍）。 */
        if (!s.localPath) void solidifySong(s);
        return r.path;
      }
      lastSourceError = (r && r.error) || "生成可播放副本失败";
    } catch (e) {
      lastSourceError = String((e as any)?.message || e);
    }
  }
  if (s.localPath) return s.localPath;
  lastSourceError = lastSourceError || "这一首没有可用的本地副本";
  return "";
}
/** ★ 把这首歌的音源**固化一份到播放器内部**（<userData>\library\audio），
    从此与外部 B 站缓存目录彻底解耦 —— 源被删、被移走都照播。

    这就是"导入的缓存应该解析一份进播放器并保护起来"的落地动作。
    两个触发点：
      · 导入扫描（新版已直接落盘，见导入流程）；
      · 播放时搭便车（源还在、但当初没固化成功的存量曲目 —— 补救路径）。
    幂等且可失败：同一个源算出的目标文件名固定，已存在直接返回；
    失败不打扰播放，只是下次再试。同一首歌并发去重，避免重复写盘。 */
const solidifyingIds = new Set<string>();
async function solidifySong(s: Song): Promise<boolean> {
  if (!s || !s.path) return false;
  if (s.localPath) return true;               // 已经有固化副本，不必再做
  if (!desktop?.keepBiliAudio) return false;
  if (solidifyingIds.has(s.id)) return false;
  solidifyingIds.add(s.id);
  try {
    const kr = await desktop.keepBiliAudio(s.path);
    if (kr && kr.ok && kr.path) {
      s.localPath = kr.path;
      /* 固化副本成了 → 曲目的音源地址就指向它（长效）。别的地方若还残留
         会话路径/短名，一并换成这份 —— 曲库里只留能长期用的地址。 */
      const cur = fileUrlToPath(s.srcUrl || "");
      if (!s.srcUrl || !cur || isStaleSessionPath(cur)) s.srcUrl = s.localPath;
      persist(s);
      return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    solidifyingIds.delete(s.id);
  }
}
/* 曲库里有没有"需要还原成长名"的路径 —— 见 healsSongPathsOnce。
   懒执行：第一次真正播放 B 站曲目时才探，不在启动路径上加开销。 */
let pathHealDone = false;
/** 一次性把曲库里存的 8.3 短名路径修成长名，并**清掉失效的 srcUrl**。
    背景：老版本导入 B 站缓存时，系统文件夹选择框返回的短名
    （C:\Users\KONOMI~1\...）被原样存进了 s.path / s.localPath。
    短名在 Node 里读得到，所以以前一直"看着没问题"；但它拼出的
    file:// URL 带 %7E1，Chromium 判非法 → MediaError 4
    （"格式不支持或文件头异常"）。主进程的 audio-exists 会无条件还原成长名，
    这里拿它把库里的旧值就地换掉，之后启动都不必再修。

    ★ 同时清理 srcUrl：历史记录里存过指向 **早已销毁的会话目录** 的 URL
      （mp-session-07c53b8c53d7），它让每次播放都报同一个错、且永远不变。
      这类值直接抹掉 —— 下次播放会由 playablePathOf 从 s.path 重新生成，
      生成出来的才是本次会话真正有效的地址。

    ★ 并如实标出"音源缺失"：源没了、固化副本也没有的曲目是真的播不了。
      提前探一次、在列表上标出来，比让用户点进去才吃到报错好得多。 */
async function healsSongPathsOnce(): Promise<void> {
  if (pathHealDone) return;
  pathHealDone = true;
  if (!desktop?.audioExists) return;
  for (const s of songs) {
    let dirty = false;
    /* 失效的会话 URL / 带短名的 URL：一律清掉，让播放时重新生成 */
    if (s.srcUrl) {
      const asPath = fileUrlToPath(s.srcUrl);
      if (isStaleSessionPath(asPath)) { s.srcUrl = undefined; dirty = true; }
    }
    /* 固化副本：短名还原 + 探活。副本已不在就丢掉这个失效引用
       （源还在时，播放会顺带重新固化一份）。 */
    let copyOk = false;
    if (s.localPath) {
      try {
        const r = await desktop.audioExists(s.localPath);
        if (r && r.ok) {
          copyOk = true;
          if (r.fixed && r.path) { s.localPath = r.path; dirty = true; }
        } else {
          s.localPath = undefined; dirty = true;
        }
      } catch {
        copyOk = true; // 探不通就不下结论，别误清
      }
    }
    /* 源路径：短名还原 + 存在性 → 决定要不要标"音源缺失" */
    if (s.path) {
      let srcOk = false;
      try {
        const r = await desktop.audioExists(s.path);
        if (r && r.ok) {
          srcOk = true;
          if (r.fixed && r.path) { s.path = r.path; dirty = true; }
        }
      } catch {
        srcOk = true; // 探不通当作还在，不下"缺失"的结论
      }
      const miss = !srcOk && !copyOk;
      if (!!s.missing !== miss) { s.missing = miss; dirty = true; }
    }
    if (dirty) persist(s);
  }
}
/** 让主进程确认"这份音频现在还能读到"（只 stat，不读字节，很轻）。
    没接上桌面端（网页版）时一律返回 true —— 不改变原有行为。 */
async function audioReadableExists(p: string): Promise<boolean> {
  if (!p) return false;
  if (!desktop?.audioExists) return true;
  try {
    const r = await desktop.audioExists(p);
    return !!(r && r.ok);
  } catch {
    return true; // 探不通就当它还在，交给后面的 readAudio 去报真正的错
  }
}

async function ensurePlayableSource(s: Song, force = false): Promise<boolean> {
  /* ① 固化副本优先：有、且在盘上 → 直接用它，**根本不必碰源缓存**。
     ★ 但必须先确认这份副本真的还在：老版本把 8.3 短名路径写进了 localPath
       （C:\Users\KONOMI~1\...），或者用户手工清过 library\audio —— 盲目采用
       会让 blobUrlOf 一路拿到读不到的文件，弹出"文件不存在：C:\Users\KONOMI~1\..."。
     以前这里的条件是 `s.localPath && s.srcUrl !== s.localPath` —— 已固化且已同步时
     条件为假，于是**继续往下从源重建**，白白多写一份临时副本；源已被删时还会
     白失败一次。现在改成"能读就收工"。 */
  if (!force && s.localPath) {
    if (await audioReadableExists(s.localPath)) {
      const changed = s.srcUrl !== s.localPath;
      s.srcUrl = s.localPath;
      return changed;
    }
    /* 副本没了：丢掉这个失效引用，往下走让主进程从源重建。
       源也被删时，由 playablePathOf 给出"原始文件不存在"的准确原因。 */
    s.localPath = undefined;
    persist(s);
  }
  /* ② 从源缓存现做一份会话副本（临时的，只为喂给 <audio>）。 */
  const p = await playablePathOf(s, force);
  if (!p) return false;
  const changed = s.srcUrl !== p;
  s.srcUrl = p;
  return changed;
}/** 把音频文件读成 blob 地址（绕开 file:// 限制）。读不到返回空串。
    force = true：跳过本地保留副本，强制从源缓存重建会话副本（自愈路径）。
   ★ 兜底顺序：playablePathOf（会重建）→ srcUrl（**必须探活**）→ s.path（**必须探活**）。
     以前是 (await playablePathOf(...)) || fileUrlToPath(s.srcUrl) || s.path —— 中间那环
     完全不校验，把已消失会话目录里的路径直接喂给 readAudio，报错很误导（说"格式不支持"）。
     现在每一环都先确认"文件真的在盘上"，不在就跳过并给出准确原因。 */
async function blobUrlOf(s: Song, force = false): Promise<string> {
  if (!desktop?.readAudio) return "";
  let p = await playablePathOf(s, force);
  if (!p) {
    /* ① 上一次算出的 srcUrl：只在"文件确实还在、且不是临时会话路径"时才用 */
    const cached = fileUrlToPath(s.srcUrl || "");
    if (cached && !isStaleSessionPath(cached) && (await audioReadableExists(cached))) p = cached;
  }
  if (!p) {
    /* ② 原始源缓存路径：同样先探活（源被删/被移走时给准确提示，而不是伪装成格式错误） */
    const raw = s.path || "";
    if (raw && !isStaleSessionPath(raw) && (await audioReadableExists(raw))) p = raw;
  }
  if (!p) {
    lastSourceError = lastSourceError || "源缓存已被删除，本地副本也不在";
    return "";
  }
  try {
    const res = await desktop.readAudio(p);
    if (res && res.bytes && res.bytes.byteLength) {
      return URL.createObjectURL(new Blob([res.bytes], { type: res.mime || "audio/mp4" }));
    }
    lastSourceError = (res && res.error) || "读不到音频字节";
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
/** 装 B 站缓存那一路的音源：**走内存读取（blob）**。
    ────────────────────────────────────────────────────────────
    这里曾经改成"副本 file:// 直读优先、失败再降级 blob"，理由是省一次 IPC + 少占内存。
    **那个改动是错的**，用户反馈"导入的 B 站缓存提示格式不支持或文件头异常"就是它：
      · UI 挂在 http://127.0.0.1:41739（本机静态服务）上，**file:// 音源会被 Chromium 拦掉**
        （Not allowed to load local resource）—— 见本文件上方"两件事都得做"那段注释的 ②；
      · 被拦之后 <audio> 报 MediaError 4（"格式不支持或文件头异常"），
        于是每一首都得先失败一次、再走 error 自愈降级，既慢又一定会弹红提示。
    实测证明"直读"在这套架构下根本走不通。**正确做法：一律 read-audio 读字节 → Blob → objectURL**，
    这条路径一直可用，且能绕开协议限制。代价（整份载入内存）是这个架构下必须接受的。 */
let loadSeq = 0;
async function loadBiliAudio(s: Song, autoplay: boolean) {
  const token = ++loadSeq;
  loadedId = null; // 装好之前不算"已装载"，用户这时点它 playAt 会真的来加载
  armPendingSeek(s);
  diagLoad(s);
  if (autoplay) audio.pause(); // 先把上一首停住，免得异步备源期间它还在响
  /* 首次走这条路时，把曲库里历史遗留的 8.3 短名路径修成长名。
     一次性、很轻（每首两次 stat），但能彻底断掉"文件不存在：C:\Users\KONOMI~1\..."。 */
  await healsSongPathsOnce();
  await ensurePlayableSource(s, false);
  if (token !== loadSeq || currentId !== s.id) return;
  /* 读字节转 blob。这是该路径唯一可行的装载方式（file:// 会被拦）。 */
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
  audio.src = blob || "";
  loadedId = s.id;
  if (autoplay) audio.play().catch(() => {});
}
/** 系统设置里的"音频质量"一行：把几件"默认行为不透明"的事摊开给用户看。
    为什么需要这一行：
      · 变速是否保音调（preservesPitch）是**浏览器默认值**，随版本会变，
        而且用户完全无从得知 —— 0.75× 发闷、1.5× 变尖时只会以为"这软件不行"；
      · 频谱要接管音频图（Web Audio 的 source → analyser → destination），
        这件事值得写清楚，否则用户无法判断音质有没有被牺牲；
        顺手讲明白"接管后还能做什么优化"（只剩采样率对齐）；
      · 如果频谱因为环境原因起不来，原因必须可见（原来是彻底静默的）。 */
export function audioQualityMarkup(): string {
  return (
    `<label><div><strong>PITCH ／ TIME-STRETCH</strong><span>` +
    `变速不变调：0.75× 不发闷、1.5× 不变尖` +
    `</span></div>` +
    `<span id="aq-pitch" class="settings-value">读取中…</span></label>` +
      `<label><div><strong>ANALYSER ROUTING</strong><span>` +
    `频谱分析链路状态。采样率跟随音频设备` +
    `</span></div>` +
    `<span id="aq-route" class="settings-value">读取中…</span></label>` +
    `<label><div><strong>COVER ACCENT</strong><span>` +
    `用封面主色作为强调色` +
    `</span></div>` +
    `<input type="checkbox" id="aq-cover-accent" ${coverAccentOn ? "checked" : ""}/><i class="toggle"></i></label>` +
      `<label><div><strong>BEAT PRE-ANALYSIS</strong><span>` +
      `播放前离线分析整首（后台跑，不影响播放）：鼓点提前点亮、每 4 拍换形态、副歌预热` +
      `</span></div>` +
    `<span id="aq-beatmap" class="settings-value">读取中…</span>` +
    `<input type="checkbox" id="aq-beatmap-toggle" ${beatEnabledPref ? "checked" : ""}/><i class="toggle"></i></label>`
  );
}
/** 填充 audioQualityMarkup() 里的两个占位。打开设置面板后调一次。 */
export function fillAudioQualityInfo() {
  const pitch = document.querySelector<HTMLElement>("#aq-pitch");
  if (pitch) {
    if (PRESERVE_PITCH_SUPPORTED) {
      // 再读一次真实值：属性可写、也读得出来，才是真的生效
      const v = (audio as any).preservesPitch ?? (audio as any).webkitPreservesPitch;
      pitch.textContent = v === false ? "⚠ 未能启用" : "✓ 已启用（保音调）";
    } else {
      pitch.textContent = "⚠ 此环境不支持";
    }
  }
  const route = document.querySelector<HTMLElement>("#aq-route");
  if (route) {
    if (vizDenied) {
      route.textContent = "频谱未启动";
      route.title = "原因：" + (vizDenyReason || "未知") + "（播放不受影响）";
    } else if (analyserNode && actx) {
      const khz = (actx.sampleRate / 1000).toFixed(1);
      route.textContent = "已接入 · " + khz + "kHz";
      route.title =
        `分析链路已建立：采样率跟随音频设备（${khz}kHz），避免与音源对不齐时多一级重采样。` +
        `注意 Web Audio 图必须连到 destination，否则既无声也无频谱。`;
    } else {
      route.textContent = "尚未启用";
      route.title = "首次播放时会建立分析链路";
    }
  }
  fillBeatmapInfo();
}
/** 预分析这一行的状态：有没有乐谱、这首的 BPM、队列里还剩几首。
    ★ 为什么要显示：这个功能"看不见"——算没算出来、算得对不对，用户无从判断。
      把 BPM 写出来，用户一眼就能核（听感对不上就是算错了，而不是"软件玄学"）。 */
function fillBeatmapInfo() {
  const el = document.querySelector<HTMLElement>("#aq-beatmap");
  if (!el) return;
  if (!beatEnabledPref) {
    el.textContent = "已关闭";
    el.title = "关掉后可视化退回纯在线模式（鼓点只能被动响应，会有约 30ms 的感知延迟）";
    return;
  }
  const s = currentSong();
  const bm = beatmapOf(s);
  const st = beatmapStatus();
  if (bm) {
    const n = bm.beats.length;
    el.textContent = bm.bpm > 0 ? `✓ ${bm.bpm.toFixed(1)} BPM · ${n} 拍` : `✓ 包络已就绪（无稳定节拍）`;
    el.title =
      `《${s?.title || ""}》已分析：${bm.dur.toFixed(1)} 秒、` +
      (bm.bpm > 0 ? `${bm.bpm.toFixed(1)} BPM（拍长 ${bm.period.toFixed(3)} 秒）、${n} 个拍点。` : "这首歌没有稳定的节拍网格，只用了响度包络做副歌预热。") +
      ` 后台队列还有 ${st.queued} 首待分析。`;
  } else if (st.busy) {
    el.textContent = "分析中…";
    el.title = "这首歌正在后台分析（不占用播放，算完自动生效）";
  } else {
    el.textContent = "尚未分析";
    el.title = hasBeatmap(s) ? "" : "开始播放后会在后台分析当前与后面两首";
  }
}
/** 系统设置里的"封面维护"一行：一键重读全部封面。
    复用 .settings-list label 那套行式版式（和 REDUCED MOTION / 播放行为三项一致）。 */
export function coverToolsMarkup(): string {
  return (
    `<label><div><strong>RE-READ ALL COVERS</strong><span>` +
    `从本地文件重读内嵌封面，读完自动保存并刷新列表与档案阵列` +
    `</span></div>` +
    `<button type="button" class="edit-mini" data-action="reread-covers" style="pointer-events:auto">重新读取全部封面</button></label>`
  );
}
/** 系统设置里的"本地音频副本"一行：显示占用 + 一个"补齐未固化"的按钮。
    ★ 为什么需要按钮：这份副本是**与外部缓存解耦**的保障 ——
      早期版本导入的曲目可能只有源路径、没有副本，源一删就永远播不了
      （《scualee》就是这么变成僵尸条目的）。按钮把"源还在的那些"一次性补齐。
      刻意不做一键清空：副本删了就播不了，那是自毁。 */
export function localAudioMarkup(): string {
  return (
    `<label><div><strong>LOCAL AUDIO COPIES</strong><span>` +
    `导入时固化进播放器的可播放副本，源文件夹删掉后仍能播。这里显示它占的盘` +
    `</span></div>` +
    `<span id="local-audio-info" class="settings-value">读取中…</span>` +
    `<button type="button" class="edit-mini" data-action="solidify-all" style="pointer-events:auto">补齐未固化的</button></label>`
  );
}
/** 把"源还在、但还没固化"的 B 站曲目一次性补齐到播放器内部。
    源已被删的固不了 —— 那些属于"音源缺失"，如实计数告知，不假装成功。 */
export async function solidifyAllMissing(): Promise<void> {
  const targets = songs.filter((s) => s.path && !s.localPath);
  if (!targets.length) {
    toast("所有 B 站曲目都已固化在播放器内部");
    return;
  }
  toast(`正在固化 ${targets.length} 首…`);
  let ok = 0;
  let miss = 0;
  for (const s of targets) {
    if (await solidifySong(s)) ok++;
    else miss++;
  }
  notify();
  if (miss) toast(`已固化 ${ok} 首；${miss} 首的源缓存已不在，无法再固化`);
  else toast(`已固化 ${ok} 首，与源缓存解耦完成`);
}
/** 填充 localAudioMarkup() 里那个占位（打开设置面板后异步取一次） */
export async function fillLocalAudioInfo() {
  const el = document.querySelector<HTMLElement>("#local-audio-info");
  if (!el) return;
  if (!desktop?.localAudioInfo) {
    el.textContent = "需在桌面版使用";
    return;
  }
  try {
    const r = await desktop.localAudioInfo();
    if (r && r.ok) {
      const mb = (Number(r.bytes) || 0) / 1024 / 1024;
      el.textContent = `${r.count} 个 · ${mb >= 1024 ? (mb / 1024).toFixed(2) + " GB" : mb.toFixed(1) + " MB"}`;
    } else el.textContent = "读取失败";
  } catch {
    el.textContent = "读取失败";
  }
}
/** 一键重新读取全部封面。
    · 逐首走主进程的 read-cover（NCM / MP3 / FLAC / M4A / WAV / OGG / APE…），
      读到就换算成统一尺寸的 dataURL 落库（和导入时的处理一致）；
    · 没有本地路径的曲目（浏览器模式 / 只有 File 对象）跳过 —— 没有可读的文件；
    · 进度用 toast 报，最后给一条汇总；读完 notify() + 派发 rhine-cover，
      列表、档案阵列、三维封面板与详情一起刷新。 */
export async function rereadAllCovers() {
  if (!desktop?.readCover) {
    toast("重新读取封面需在桌面版使用");
    return;
  }
  const targets = songs.filter((s) => Boolean(s.filePath || s.ncmPath));
  if (!targets.length) {
    toast("没有可重读封面的曲目（它们没有本地文件路径）");
    return;
  }
  let ok = 0,
    same = 0,
    bad = 0;
  for (let i = 0; i < targets.length; i++) {
    const s = targets[i];
    if (i === 0 || (i + 1) % 8 === 0 || i + 1 === targets.length)
      toast(`正在重新读取封面 ${i + 1}/${targets.length}…《${s.title}》`);
    try {
      const rc = await desktop.readCover({ path: s.filePath || s.ncmPath || "" });
      if (rc && rc.dataUrl) {
        const next = (await coverToDataUrl(rc.dataUrl)) || rc.dataUrl;
        if (next && next !== s.cover) {
          s.cover = next;
          persist(s);
          ok++;
        } else same++;
      } else bad++;
    } catch {
      bad++;
    }
  }
  notify();
  window.dispatchEvent(new CustomEvent("rhine-cover"));
  toast(
    `封面重读完成：更新 ${ok} 首` +
      (same ? `，${same} 首没有新封面` : "") +
      (bad ? `，${bad} 首读取失败` : ""),
  );
}
/** 只把音频装进 <audio> 元素（不碰界面状态）。启动时的"恢复上次曲目"不走这里。 */function loadSongAudio(s: Song, autoplay = false) {
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
  s.triedHeal = false;
  /* ★ 判据用 s.path（原始源缓存路径，稳定），不要用 s.srcUrl ——
     srcUrl 是"上次算出的可播放地址"，可能是失效的历史值，
     但它的存在不代表这一首是路径型音源。两者都指向路径型音源时走异步装载。 */
  if (s.path || s.srcUrl) {
    // B 站缓存：副本要在会话临时目录里重新生成，而且必须走内存读取绕开 file:// 限制 —— 异步装载
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
  invalidatePrefetch();   // 换了歌，上一轮的预取结论作废
  loadSongAudio(s, autoplay);
  spectrum?.resetPeaks();
  /* 换曲 → 换乐谱：库里已经算好的那份立刻装上，没算过的排进后台队列。
     ★ 顺序有讲究：resetPeaks 之后才 setBeatmap，否则"上一首的拍点"
       会推着这一首刚清空的低频走。 */
  refreshBeatmap();
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
function followWithArchive(index: number, force = false) {
  /* force = true：无视 openOnPlay 偏好，一定要打开 —— 用户"点歌曲名"就是这个意思：
     名字点下去要看到那一首的档案（用户反馈"点击歌曲名没有打开对应的歌曲档案"）。 */
  if (index < 0 || (!force && !playbackPrefs.openOnPlay)) return;
  closePlaylist();
  window.dispatchEvent(new CustomEvent("rhine-open-track", { detail: index }));
}
/** 把某一首设为"当前曲目"但**不播放**（打开档案时用）。
    ★ 用户反馈"档案打开，右侧出现该档案的歌曲信息但和正在播放的不符"：
      以前 openFile() 只切详情，播放器那边还在另一首上 —— 右侧写着这一档案、频谱却在放别的。
      现在打开档案就把播放器切到这一首：播放条 / 详情 / 频谱指向同一首，
      停在 0 秒等用户按播放（**不自动播放**，这条是之前明确要求的）。
      返回是否真的换了曲目。 */
export function focusTrack(index: number): boolean {
  const s = songs[index];
  if (!s) return false;
  if (s.id === currentId && s.id === loadedId) return false; // 已经就是它，别重装音源
  selectSong(s.id, false);
  markRestored(false);
  return true;
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
  invalidatePrefetch();   // 队列变了 → "下一首是谁"变了，预取要重算
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
/* ================= 预取下一首（消除切歌等待） =================
   问题：点"下一首"到出声之间，要串行走完
     prepareBiliAudio（IPC 往返 + 可能重写副本） → readAudio（整份读盘） → setSrc → play
   用户感知到的就是"按了没反应，过半秒才响"。
   做法：播放中判断"离曲尾还有 N 秒"，先把下一首的**音源准备好**（只备源，不播放）：
     · 路径型音源（B 站缓存）：提前让主进程生成副本并把 srcUrl 写回曲目记录，
       于是真正切歌时 ensurePlayableSource 是幂等命中、几乎零开销；
     · 普通文件：无需准备（objectURL 是同步的）。
   为什么只做"备源"而不做"预解码"：预解码要第二个 <audio>，会与 §音频图 里
   那条 MediaElementSource 的归属打架（一个元素只能被一个 AudioContext 接管），
   收益不稳定而风险明确。备源已经能吃掉这条链路上最贵的 IPC + 读盘。 */
const PREFETCH_LEAD_SEC = 12;   // 距曲尾多少秒开始预取
const PREFETCH_LEAD_MIN = 6;    // 短曲目的下限（避免 20 秒的歌一进来就预取）
let prefetchedId = "";          // 已经预取好的曲目 id（避免重复请求）
let prefetchingId = "";         // 正在预取中的曲目 id（避免并发重复）
/** 算"下一首是谁"（与 playNext 的选择逻辑保持一致，但不产生副作用） */
function peekNext(): Song | null {
  if (nextQueue.length) {
    const id = nextQueue[0];
    const s = songs.find((x) => x.id === id);
    if (s) return s;
  }
  const i = currentIndex();
  if (i < 0 || songs.length < 2) return null;
  if (mode === "shuffle") {
    // 随机模式本来就没有"下一首"可言，不预取（随机选到哪首是播放时才知道的）
    return null;
  }
  if (mode === "order") return i < songs.length - 1 ? songs[i + 1] : null;
  return songs[(i + 1) % songs.length];
}
/** 为这首歌备好音源（幂等）。已经在做或已经做过就直接返回。 */
async function prefetchSong(s: Song) {
  if (!s || !s.path) return;                 // 只有路径型音源需要"备"
  if (s.id === prefetchedId || s.id === prefetchingId) return;
  // 已经有本地保留副本 → 它本身就是"永远可用"的地址，不必再动
  if (s.localPath && s.srcUrl === s.localPath) {
    prefetchedId = s.id;
    return;
  }
  prefetchingId = s.id;
  try {
    const changed = await ensurePlayableSource(s, false);
    if (changed) persist(s);
    prefetchedId = s.id;
  } catch {
    /* 预取失败无所谓 —— 真正切歌时还会再走一遍完整链路 */
  } finally {
    if (prefetchingId === s.id) prefetchingId = "";
  }
}
/** 由 timeupdate 驱动：判断该不该预取。开销只有几次比较。 */
function maybePrefetch() {
  if (!songs.length || audio.paused) return;
  const dur = audio.duration;
  if (!dur || !isFinite(dur)) return;
  const lead = Math.max(PREFETCH_LEAD_MIN, Math.min(PREFETCH_LEAD_SEC, dur * 0.15));
  if (dur - audio.currentTime > lead) return;
  const nxt = peekNext();
  if (nxt) void prefetchSong(nxt);
}
/** 换歌 / 队列变化时让预取状态失效（否则会拿旧结论跳过预取） */
function invalidatePrefetch() {
  prefetchedId = "";
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
/** 最近一次收到的键控动作（设置面板那行要显示"刚才那个键被认成了什么"） */
let lastMediaKey: { action: string; source: string; at: number } | null = null;
const MEDIA_LABEL: Record<string, string> = {
  play: "播放 / 暂停",
  pause: "暂停",
  next: "下一首",
  prev: "上一首",
  "volume-up": "音量 +",
  "volume-down": "音量 −",
  playpause: "播放 / 暂停",
};
/** 接受两种形态：老的是纯字符串动作，新的是 {action, source}（主进程会带上键名） */
function handleMediaKey(payload: string | { action?: string; source?: string }) {
  const action = typeof payload === "string" ? payload : String(payload?.action || "");
  const source = typeof payload === "string" ? "mediaSession" : String(payload?.source || "hotkey");
  if (!action) return;
  const now = performance.now();
  if (now - lastMediaKeyAt < 300) return;
  lastMediaKeyAt = now;
  lastMediaKey = { action, source, at: Date.now() };
  paintMediaKeyStatus();
  if (action === "play" || action === "playpause") {
    if (songs.length) togglePlay();
  } else if (action === "pause") {
    if (!audio.paused) audio.pause();
  } else if (action === "next") {
    playNext();
  } else if (action === "prev") {
    playPrev();
  } else if (action === "volume-up") {
    nudgeVolume(0.05);
  } else if (action === "volume-down") {
    nudgeVolume(-0.05);
  }
}
/** 音量 ±：耳机上的音量键（若被绑成组合键）走这条。同步音量条与 localStorage。 */
function nudgeVolume(delta: number) {
  const v = Math.max(0, Math.min(1, (audio.volume || 0) + delta));
  audio.volume = v;
  const volEl = document.querySelector<HTMLInputElement>("#p-vol");
  if (volEl) volEl.value = String(Math.round(v * 100));
  try {
    localStorage.setItem("rhine-volume", String(v));
  } catch {
    /* ignore */
  }
}
desktop?.on?.("media-key", handleMediaKey);
if ("mediaSession" in navigator) {
  try {
    navigator.mediaSession.setActionHandler("play", () => handleMediaKey({ action: "play", source: "mediaSession" }));
    navigator.mediaSession.setActionHandler("pause", () => handleMediaKey({ action: "pause", source: "mediaSession" }));
    navigator.mediaSession.setActionHandler("nexttrack", () => handleMediaKey({ action: "next", source: "mediaSession" }));
    navigator.mediaSession.setActionHandler("previoustrack", () => handleMediaKey({ action: "prev", source: "mediaSession" }));
  } catch {
    /* 个别环境不支持 mediaSession：不影响主进程那条通路 */
  }
}
/* ---------- 设置面板 → HEADPHONE / MEDIA KEYS：自检行 ----------
   旧界面有一行"媒体键自检"，终端界面重写时丢了 —— 于是耳机键失效时界面上毫无痕迹
   （被游戏抢走注册是**静默失败**）。这里补回，并加一条"最近一次"：
   按下耳机键时这一行会写"播放 / 暂停 · 来源 MediaPlayPause"，
   用户就能直接看出"我这个键被系统认成了哪个" —— 有线耳机固件各不相同，这一步最有用。 */
export function mediaKeyStatusMarkup(): string {
  return (
    `<label><div><strong>HEADPHONE / MEDIA KEYS</strong><span id="hotkey-status">读取中…</span></div>` +
    `<span id="media-key-last" class="settings-value">还没收到过按键</span></label>`
  );
}
let hotkeyWatch: number | undefined;
/** 打开设置面板时调一次：读一次注册状态，并起一个轻量轮询刷新"最近一次" */
export async function startMediaKeyWatch() {
  await paintHotkeyStatus();
  if (hotkeyWatch) return;
  hotkeyWatch = window.setInterval(() => {
    if (!document.querySelector("#media-key-last")) {
      window.clearInterval(hotkeyWatch);
      hotkeyWatch = undefined;
      return;
    }
    void paintHotkeyStatus();
    paintMediaKeyStatus();
  }, 700);
}
async function paintHotkeyStatus() {
  const el = document.querySelector<HTMLElement>("#hotkey-status");
  if (!el) return;
  if (!desktop?.getHotkeyStatus) {
    el.textContent = "需在桌面版使用";
    return;
  }
  try {
    const st = await desktop.getHotkeyStatus();
    if (!st) {
      el.textContent = "读取失败";
      return;
    }
    const media = st.media ? "✓ 已接管" : "✕ 被占用";
    const fb = st.fallback ? "✓ 备用组合键可用" : "✕ 备用组合键也被占";
    const failed = Object.entries(st.detail || {})
      .filter(([, ok]) => !ok)
      .map(([k]) => k);
    el.textContent =
      `媒体键 ${media} · ${fb}` +
      (failed.length ? `；未拿到：${failed.join(" / ")}（关闭抢键的程序后会自动重试）` : "");
  } catch {
    el.textContent = "读取失败";
  }
}
function paintMediaKeyStatus() {
  const el = document.querySelector<HTMLElement>("#media-key-last");
  if (!el) return;
  if (!lastMediaKey) {
    el.textContent = "还没收到过按键";
    return;
  }
  const t = new Date(lastMediaKey.at);
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  const ss = String(t.getSeconds()).padStart(2, "0");
  el.textContent = `${MEDIA_LABEL[lastMediaKey.action] || lastMediaKey.action} · 来源 ${lastMediaKey.source} · ${hh}:${mm}:${ss}`;
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
  /* ★ srcUrl 可能是失效的历史值（指向已销毁的会话目录）。
     拿它去试必然 onerror，白等一轮；直接跳过，让下面的 onerror 分支去重建。 */
  const cachedOk = Boolean(s.srcUrl) && !isStaleSessionPath(fileUrlToPath(s.srcUrl || ""));
  let url = (cachedOk ? s.srcUrl : "") || (s.file ? URL.createObjectURL(s.file) : "");
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
  let kept = 0;
  toast(`正在把 ${items.length} 首缓存复制进曲库…`);
  for (const it of items) {
    const key = it.audioPath ? "bili:" + String(it.audioPath).toLowerCase() : "";
    if (key) {
      if (seen.has(key)) {
        dup++;
        continue;
      }
      seen.add(key);
    }
    /* ★ 与源缓存解耦：固化副本。
       新版扫描（主进程 biliOpts 传了 keepDir）**在扫描时就已把可播放副本
       落进曲库目录** <userData>\library\audio —— it.kept 为真，且 it.path 就是
       那份固化副本的地址。这里直接用，不再复制第二遍（以前 scan 写会话目录 +
       这里再复制一遍，同一份内容白写两次盘）。
       只有老版本扫描（没有 kept 字段）才走 keepBiliAudio 兜底补一份。
       两者都拿不到时 localPath 为空 —— 播放时还会再试一次固化并给出明确原因。 */
    let localPath = "";
    if (it.kept && it.path) {
      localPath = fileUrlToPath(String(it.path));
      if (localPath && isStaleSessionPath(localPath)) localPath = ""; // 双保险：会话路径绝不入库
    }
    if (!localPath && desktop?.keepBiliAudio && it.audioPath) {
      try {
        const kr = await desktop.keepBiliAudio(String(it.audioPath));
        if (kr && kr.ok && kr.path) localPath = kr.path;
      } catch {
        /* ignore */
      }
    }
    if (localPath) kept++;
    const song: Song = {
      id: uid(),
      /* ★ srcUrl 只放**长效**地址。
         以前这里写 it.path，而老版 scan 的 it.path 指向会话临时目录
         （mp-session-<sid>/audio/xxx.m4a）—— 进程一退出就失效，却被持久化进曲库。
         这正是《scualee》那条"报错一个字节都不变"的脏记录的来源。
         现在优先用固化副本；真拿不到时才退回 it.path（播放侧还有失效判定兜底）。 */
      srcUrl: localPath || it.path,
      path: it.audioPath || "",
      localPath: localPath || undefined,
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
  const allKept = added > 0 && kept === added;
  if (added && dup) toast(`B站缓存导入：新增 ${added} 首（已固化 ${kept} 份），跳过重复 ${dup} 首`);
  else if (!added && dup) toast(`这些 B 站缓存已经在曲库里了（跳过重复 ${dup} 首）`);
  else if (allKept) toast(`B站缓存导入：新增 ${added} 首，已全部固化进播放器内部（源文件夹删掉也能播）`);
  else toast(`B站缓存导入：新增 ${added} 首（已固化 ${kept} 份，其余未固化）`);
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
      ? '<path d="M7.8 5v14l11-7z"/>'
      : '<path d="M8.6 5.4v13.2"/><path d="M15.4 5.4v13.2"/>';
  // 详情区若正开着，同步它的播放键与状态字样
  const exp = document.querySelector<HTMLElement>('.detail-content .export-button[data-action="play-now"]');
  if (exp) exp.innerHTML = `${audio.paused ? "PLAY" : "PAUSE"} <span>${audio.paused ? "▶" : "■"}</span>`;
  const kicker = document.querySelector<HTMLElement>(".detail-content .song-mode-kicker");
  if (kicker && songs.length)
    kicker.textContent = `${audio.paused ? "READY" : "PLAYING"} · ${MODE_EN[mode] ?? "LOOP"}`;
  /* 封面换了就重算强调色。放在 renderNow 里是"最省心"的挂点 ——
     换歌、改封面、收藏、暂停/播放都会经过这里，而 refreshCoverAccent 自带指纹判重，
     封面没变时只是比一次字符串，几乎零开销。 */
  refreshCoverAccent();
  renderList();
}

/* 频谱计算搬到 Web Worker：120 段 × 1024 点的 Goertzel 每次约 12 万次乘加，
   放主线程会跟三维场景抢帧。worker 失败就退回同步计算（见 analysisTick）。
   ★ 分析节拍 = **1.3.0 的 50Hz**（见下面 VIZ_ANALYSIS_MS 的注释）：
     原来 `ts - workerSentAt >= 33` 让屏幕上的柱高最多滞后一帧半 + worker 往返，
     用户反馈"频谱和音频存在延迟"。现在分析与重画分开：分析 20ms 一 tick、rAF 只重画。
   缓冲在两侧轮流用、靠 transfer 归还，避免每帧 new 出垃圾。 */
let spectrumWorker: Worker | null = null;
let workerEver = false;
let workerFrames = 0;
let pendingFreq: Float32Array | null = null;
let pendingSentAt = 0;
let workerMsAvg = 0; // worker 单次分析耗时（诊断用）
let workerSentAt = 0;
let workerRttAvg = 0;
let dataAgeMs = 0; // 诊断：屏幕上这份频谱数据是多久之前喂进去的
/* 分析节拍：**1.3.0 的是 50Hz（每 20ms 一 tick）**，不是 30Hz。
   依据在原版代码里：`vizInterval()` 在播放中 `return 20`，而 `drawViz()` 每个 tick 都做两件事 ——
   `requestSpectrum()`（把时域数据喂给 worker，**没有任何节流**）与 `computeBars()`
   （跑一阶跟随 + 正弦抖动 + 14 级量化）。所以"流水线节拍 = 50Hz"本身就是 1.3.0 的参数：
   抖动相位每 tick +0.03、一阶跟随 0.70−0.20·i/n、鼓点参考电平每 tick ×0.05 全按这个节拍给。
   ★ 曾经把这里误记成 30Hz 并节流到 33ms —— 结果是柱高最多滞后一帧半、数据平均 16.7ms 才更新，
   用户两次反馈"延迟感严重""没能好好反映高能量音色"就是它，这次按原版改回 20ms。
   节拍由**自己这条定时器**驱动，不挂在 rAF 上：rAF 的 16.7ms 步长会把 20ms 的门变成 33ms。
   rAF 那条循环只负责重画。 */
const VIZ_ANALYSIS_MS = 20;
function initSpectrumWorker() {
  try {
    const src = `
      const N = ${SPECTRUM_WINDOW}, B = ${SPECTRUM_BANDS}, LOG101 = Math.log10(101);
      /* 频段映射照 1.3.0：fMin = 20Hz、fMax = 0.45 × Nyquist（随采样率变）。
         鼓点段位、瞬态参数全部从 spectrum.ts 插值进来 —— 两条分析路径必须同参数，
         否则 worker 生效时观感会和同步路径不一致。 */
      const F_MIN = ${SPECTRUM_F_MIN}, F_MAX_RATIO = ${SPECTRUM_F_MAX_RATIO};
      const K_FROM = ${SPECTRUM_KICK_FROM}, K_TO = ${SPECTRUM_KICK_TO}, K_N = K_TO - K_FROM + 1;
      const K_ATK = ${SPECTRUM_KICK_REF_ATTACK}, K_REL = ${SPECTRUM_KICK_REF_RELEASE};
      const K_FLOOR = ${SPECTRUM_KICK_FLOOR}, K_GAIN = ${SPECTRUM_KICK_GAIN};
      const T_ATK = ${SPECTRUM_TR_REF_ATTACK}, T_REL = ${SPECTRUM_TR_REF_RELEASE};
      const T_FLOOR = ${SPECTRUM_TR_FLOOR}, T_GAIN = ${SPECTRUM_TR_GAIN};
      const T_BOOST = ${SPECTRUM_TR_BOOST}, T_REF = ${SPECTRUM_TR_BANDS_REF}, T_FROM = ${SPECTRUM_TR_FROM};
      const hann = new Float32Array(N);
      for (let i = 0; i < N; i++) hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)));
      let bandK = null, sr = 0, kickRef = 0, transRef = 0;
      const prevMags = new Float32Array(B);
      const fluxPos = new Float32Array(B);
      /* 加窗后的缓冲：每 tick 只乘一遍（复用同一块，不产生垃圾）。 */
      const tw = new Float32Array(N);
      onmessage = (e) => {
        const t0 = performance.now();
        const td = e.data.td;
        const rate = e.data.sr || 48000;
        if (!bandK || rate !== sr) {
          sr = rate;
          bandK = new Float32Array(B);
          const fMax = F_MAX_RATIO * (sr / 2);
          for (let b = 0; b < B; b++) bandK[b] = (F_MIN * Math.pow(fMax / F_MIN, b / (B - 1)) / sr) * N;
        }
        for (let i = 0; i < N; i++) tw[i] = td[i] * hann[i];
        const mags = new Float32Array(B);
        let mx = 1e-9;
        for (let b = 0; b < B; b++) {
          const k = bandK[b], co = 2 * Math.cos(2 * Math.PI * k / N);
          let s1 = 0, s2 = 0;
          for (let i = 0; i < N; i++) { const s0 = tw[i] + co * s1 - s2; s2 = s1; s1 = s0; }
          const m = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - co * s1 * s2)) / (N / 4);
          mags[b] = m;
          if (m > mx) mx = m;
        }
        const out = new Float32Array(B + 1);
        for (let b = 0; b < B; b++) out[b] = Math.log10(1 + 100 * Math.min(1, mags[b] / mx)) / LOG101;
        /* 瞬态强调：谱通量按频段份额加回柱高（与 Spectrum.analyze 同一算法）。 */
        let fluxSum = 0;
        for (let b = T_FROM; b < B; b++) {
          const d = mags[b] - prevMags[b];
          const pos = d > 0 ? d : 0;
          fluxPos[b] = pos;
          prevMags[b] = mags[b];
          fluxSum += pos;
        }
        const flux = fluxSum / Math.max(mx, 1e-9);
        if (transRef <= 0) transRef = flux;
        const trise = (flux - transRef) / Math.max(transRef, 1e-6);
        const onset = Math.max(0, Math.min(1, (trise - T_FLOOR) * T_GAIN));
        transRef += (flux - transRef) * (flux > transRef ? T_ATK : T_REL);
        if (onset > 0 && fluxSum > 0) {
          const kk = (T_BOOST * onset * T_REF) / fluxSum;
          for (let b = T_FROM; b < B; b++) {
            if (fluxPos[b] > 0) out[b] = Math.min(1, out[b] + fluxPos[b] * kk);
          }
        }
        /* 鼓点：低频段 onset（与 Spectrum.analyze 同一公式）。 */
        let low = 0;
        for (let b = K_FROM; b <= K_TO; b++) low += mags[b];
        low /= K_N;
        if (kickRef <= 0) kickRef = low;
        const rise = (low - kickRef) / Math.max(kickRef, 1e-6);
        out[B] = Math.max(0, Math.min(1, (rise - K_FLOOR) * K_GAIN));
        kickRef += (low - kickRef) * (low > kickRef ? K_ATK : K_REL);
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
      pendingSentAt = workerSentAt;
      workerEver = true;
      /* ★ 回包**立刻**出图，不等下一帧 rAF：原来在渲染循环里消费 pendingFreq，
         平均要多等半帧（≈8ms）、最坏一帧（16.7ms）。50Hz 的节拍下这一等就是可见的滞后。 */
      if (spectrum && pendingFreq) {
        /* 与 analysisTick 里同一条：先验按**当前**播放头取样，回包立刻出图也不能漏 */
        spectrum.setPlayhead(audio.currentTime || 0);
        spectrum.applyBands(pendingFreq);
        dataAgeMs = Math.max(0, performance.now() - pendingSentAt);
        pendingFreq = null;
      }
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
/* 为什么放弃接管音频（不再静默）。原来 vizDenied 一置位就永远不再尝试，
   而且界面上**毫无痕迹** —— 用户只看到频谱不动，完全不知道为什么。
   现在记下原因，并在设置里显示出来。
   ★ 但"永久不再尝试"本身也害过人：一次**瞬时**失败（比如构造时上下文还没就绪）
     就会让之后每一次播放都没有频谱，用户只能重启。所以改成**有限重试**：
     vizDenied 只表示"本次没成功"，真正盖棺的是重试次数用尽。 */
let vizDenyReason = "";
let vizDeniedAnnounced = false;
/* 允许的最大尝试次数。成功一次即归零；失败到上限才彻底放弃并提示。
   3 次足以越过"首次播放时上下文未就绪"这类瞬时问题，又不会无限刷屏。 */
const VIZ_MAX_ATTEMPTS = 3;
let vizAttempts = 0;
function announceVizDenied() {
  if (vizDeniedAnnounced) return;
  vizDeniedAnnounced = true;
  toast("频谱不可用：" + (vizDenyReason || "音频分析未能启动") + "（播放不受影响）");
}
let vizRaf = 0;
let vizLast = 0;
/* 分析节拍（20ms，1.3.0 的 50Hz）的定时器句柄。rAF 只管重画，分析由它驱动 ——
   见 VIZ_ANALYSIS_MS 的注释：挂在 rAF 上会被 16.7ms 的步长量化成 33ms。 */
let vizTimer: ReturnType<typeof setTimeout> | null = null;
let vizTickCount = 0; // 诊断：一秒内的分析 tick 数 → vizTickFps
let vizTickT0 = 0;
let vizTickFps = 0;
let spectrum: Spectrum | null = null;
/* 这一 tick 要分析吗：播放中、或 ?viztest 的合成信号。暂停后不需要分析
   （柱高回落由 rAF 那条循环的 decay() 负责）。 */
function vizAnalysing() {
  return VIZ_TEST || (Boolean(analyserNode) && !audio.paused);
}
/** 起分析定时器（幂等：已经在跑就不重复起） */
function armVizAnalysis() {
  if (vizTimer !== null || !vizAnalysing()) return;
  vizTimer = setTimeout(analysisTick, VIZ_ANALYSIS_MS);
}
function stopVizAnalysis() {
  if (vizTimer !== null) clearTimeout(vizTimer);
  vizTimer = null;
}
/* 一个分析 tick：取时域 → 喂 worker（或同步算）→ 出图。
   ★ 原版 drawViz() 就是每 20ms 做这一件事（requestSpectrum + computeBars），这里保持一致。 */
function analysisTick() {
  vizTimer = null;
  /* ★ 播放头 = 先验的取样基准，每个 tick 喂一次。
     worker 回包那条路（onmessage 里立刻出图）也要喂 —— 它不走这个 tick。 */
  if (spectrum) spectrum.setPlayhead(audio.currentTime || 0);
  if (!vizAnalysing()) return;
  /* 诊断：分析 tick 的实测频率（应 ≈50Hz；被节流 / 起不来时这里立刻看出来） */
  vizTickCount++;
  const nowMs = performance.now();
  if (!vizTickT0) vizTickT0 = nowMs;
  if (nowMs - vizTickT0 >= 1000) {
    vizTickFps = Math.round((vizTickCount * 1000) / (nowMs - vizTickT0));
    vizTickCount = 0;
    vizTickT0 = nowMs;
  }
  if (VIZ_TEST) {
    if (!spectrum) return;
    if (!timeData) timeData = new Float32Array(1024);
    vizTestTimeData(timeData);
    spectrum.update(timeData, actx?.sampleRate);
  } else if (analyserNode && spectrum) {
    if (!timeData) timeData = new Float32Array(analyserNode.fftSize);
    analyserNode.getFloatTimeDomainData(timeData);
    if (spectrumWorker && workerEver) {
      const n = analysisWindow(timeData);
      let buf = tdBufs.length ? (tdBufs[tdRotate++ % tdBufs.length] as Float32Array) : null;
      if (!buf || buf.length !== n) buf = new Float32Array(n);
      buf.set(timeData.subarray(timeData.length - n));
      workerSentAt = performance.now();
      spectrumWorker.postMessage({ td: buf, sr: actx?.sampleRate ?? 48000 }, [buf.buffer]);
      /* 回包在 worker 的 onmessage 里立刻出图（不再等 rAF） */
    } else {
      /* worker 不可用（或还没热起来）：主线程同步算 —— 原版没有 worker 时也是这样 */
      spectrum.update(timeData, actx?.sampleRate);
    }
  } else if (spectrum) {
    spectrum.decay();
  }
  if (spectrumWorker) armSpectrumWatchdog();
  armVizAnalysis();
}
/* 首帧同步兜底 + 看门狗：worker 起不来（策略拦截等）就退回主线程同步算。
   原版是 800ms 内没回包就 terminate；这里按 tick 数算（20ms × 40 ≈ 800ms）。 */
function armSpectrumWatchdog() {
  if (!spectrumWorker) return;
  if (workerEver) return;
  if (++workerFrames > 40) {
    try { spectrumWorker.terminate(); } catch (e) { /* ignore */ }
    spectrumWorker = null;
  }
}
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

/* ================= 队列级频谱预分析（"乐谱先验"） =================
   在线的鼓点检测是**因果的**：先听到、才可能亮。一个分析窗 1024 点 ≈ 21ms，
   加上 worker 往返与 60fps 的绘制节拍，屏幕比耳朵晚 30~50ms —— 这个延迟
   **调参救不了**（参数只改灵敏度，改不了因果性），只能靠"提前知道"。
   所以：播放前把整首歌离线过一遍（8kHz 单声道 + 16 段 Goertzel，见 beatmap.ts），
   得到节拍网格与能量包络，播放时按播放头查表。三件可见的收益：
     · 鼓点在拍点**之前** 28ms 就开始升（BEAT_PRE_ROLL）—— 视觉与听觉重新对齐；
     · 每 4 拍换一次柱体形态 —— 可视化跟着小节走，而不是跟着噪声走；
     · 副歌到来前 2.5 秒提前扩动态范围 —— 高潮进来时不显得突然。
   ★ 三条铁律：
     1. 预分析**不许碰音源**（用的是"本来就能读到的副本/源路径"，不生成任何临时文件）；
     2. 算不出来就当没有 —— 可视化退回在线模式，**绝不影响播放**；
     3. 只在后台跑（worker），一次一首，且队列不超过 3 首。 */
let beatEnabledPref = true;
export function beatmapPref(): boolean {
  return beatEnabledPref;
}
export function setBeatmapPref(on: boolean) {
  beatEnabledPref = on;
  try {
    localStorage.setItem("rhine-beatmap", on ? "1" : "0");
  } catch {
    /* ignore */
  }
  setBeatmapEnabled(on);
  if (!on) spectrum?.setBeatmap(null); // 关掉就立刻回到纯在线观感
  else refreshBeatmap();
}
/** 把当前曲目的乐谱装进频谱，并把"当前 + 后面两首"排进预分析队列。
    换曲、开关切换、算完一首之后都走这里。 */
function refreshBeatmap() {
  const s = currentSong();
  spectrum?.setBeatmap(beatmapOf(s));
  if (!beatEnabledPref) return;
  if (s) requestBeatmapNow(s);
  const i = currentIndex();
  if (i >= 0 && songs.length > 1) {
    const next: Song[] = [];
    for (let k = 1; k <= 2; k++) next.push(songs[(i + k) % songs.length]);
    requestBeatmaps(next);
  }
}
/** 预分析要读的音频文件路径。
    ★ 顺序里**没有** playablePathOf —— 那会为主进程生成一份会话临时副本，
     而预分析只是"想看看这首歌长什么样"，不该有任何写盘副作用。
     拿不到就算了（B 站原始 .m4s 未必能独立解码，解不出来就是没有乐谱，仅此而已）。 */
async function analysisPathOf(s: Song): Promise<string> {
  const cands: string[] = [];
  if (s.localPath) cands.push(s.localPath);
  if (s.filePath) cands.push(s.filePath);
  const fromUrl = fileUrlToPath(s.srcUrl || "");
  if (fromUrl && !isStaleSessionPath(fromUrl)) cands.push(fromUrl);
  if (s.path) cands.push(s.path);
  for (const p of cands) {
    if (!p || isStaleSessionPath(p)) continue;
    if (await audioReadableExists(p)) return p;
  }
  return "";
}
function installBeatmapHooks() {
  setBeatmapHooks({
    sourcePath: (s) => analysisPathOf(s as Song),
    readAudio: async (p) => (desktop?.readAudio ? await desktop.readAudio(p) : null),
    saved: (s) => {
      persist(s as Song);
      /* 正在播的这首刚算完 → 立刻装上，不必等下一次换曲。
         先验只影响观感，所以这里直接换是安全的（不会打断音频）。 */
      const cur = currentSong();
      if (cur && cur.id === s.id) spectrum?.setBeatmap(beatmapOf(cur));
    },
  });
}

async function ensureAnalyser(): Promise<AnalyserNode | null> {
  /* 已有分析器就直接用；vizDenied 只表示"上次失败"，只要还没到尝试上限就再试。
     注意：`createMediaElementSource` 成功过一次之后 analyserNode 就不为空，不会重复调用；
     失败路径（构造/恢复上下文抛错）此时并没有真的接管音频，重试是安全的。 */
  if (analyserNode) return analyserNode;
  if (vizDenied && vizAttempts >= VIZ_MAX_ATTEMPTS) return analyserNode;
  vizAttempts += 1;
  try {
    const Ctor: typeof AudioContext | undefined =
      (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) {
      vizDenied = true;
      vizDenyReason = "这个环境没有 Web Audio（AudioContext 不可用）";
      announceVizDenied();
      return null;
    }
    /* ★★ 采样率：**什么都别传**，`new AudioContext()` 就是对的。
       ────────────────────────────────────────────────────────────────
       这里也踩过坑，同样是"可视化全部消失"的直接原因之一，写下来：

       我一度写成 `new Ctor({ sampleRate: 0 })`，注释里还宣称"0 = 由实现选择、跟随硬件"。
       **这是错的。** 按 Web Audio 规范（AudioContextOptions.sampleRate）：
         · sampleRate 的合法区间是 [3000, 768000]，0 是**非法值**；
         · 传 0 会直接抛 `NotSupportedError: The hardware sample rate provided (0)
           is outside the range [3000, 768000]` —— 构造就失败；
         · 规范同时写明：**不传 sampleRate 时，才使用输出设备的首选采样率**。
       所以"跟随硬件设备速率"本来就是 `new AudioContext()`（无参）的默认行为，
       根本不需要也不允许靠传 0 来实现。构造抛错 → 被 catch 置 vizDenied=true →
       永久不再尝试 → **所有歌的频谱都不动**，症状与"旁路"那次一模一样。

       结论：**保持无参构造**。这是这条链路上唯一正确、也最省心的写法。 */
    const ctx = new Ctor();
    if (ctx.state !== "running") await ctx.resume().catch(() => {});
    // 取不到运行中的上下文就绝不接管音频：宁可没有频谱，也不能没有声音。
    if (ctx.state !== "running") {
      vizDenied = true;
      vizDenyReason = "音频上下文没能进入运行状态";
      announceVizDenied();
      void ctx.close().catch(() => {});
      return null;
    }
    /* ★★ 音频图：source → analyser → destination，**必须接回 destination**。
       ─────────────────────────────────────────────────────────────────
       这里曾经犯过一个错，写下来避免再犯（用户反馈"可视化失效了"就是这个原因）：

       我一度以为可以"旁路分析" —— 只写 source.connect(analyser)、不接 destination，
       理由是"<audio> 元素自身的直通输出仍然有效，扬声器照样出声"。
       **这个前提是错的。** `createMediaElementSource()` 的真实语义是：
         · 调用之后，元素解码出的音频**改由图输出**，元素自身的直通被**取代**（不是叠加）；
         · 于是不接 destination = 这条音频链路的终点悬空 = **根本不出声**。
       （至于"analyser 还在不在算"，实测/经验都表明：链路没有连到 destination 时，
       整条图不参与渲染，AnalyserNode 也拿不到有效样本 → 频谱不动。
       这正是"可视化失效"的直接原因。）

       ⚠ 我此前在 docs/架构说明.md 里写的"旁路可行"结论是错的，已一并订正。
       ⚠ 另外：**`createMediaElementSource()` 无法撤销** —— 一旦调用，就再也回不到
         "元素直通扬声器"的状态了。所以"先试旁路、不行再接回来"这种兜底也不成立：
         视频/音频图一旦被接管，只能一路接 destination 走到底。

       ★ 音质优化：本函数**不做任何额外处理** —— 无参构造的 AudioContext 已经跟随
         输出设备速率（规范行为），重采样该省的自然就省了。曾经画蛇添足传过
         `sampleRate: 0`（非法值、直接抛错），见上面那段；不要重蹈。 */
    const source = ctx.createMediaElementSource(audio);
    const node = ctx.createAnalyser();
    node.fftSize = 1024; // 与 1.3.0 的分析窗长一致
    node.smoothingTimeConstant = 0.6;
    source.connect(node);
    node.connect(ctx.destination);   // ← 这一句必须有，否则整条链路悬空、无声且无频谱
    actx = ctx;
    analyserNode = node;
    freqData = new Uint8Array(node.frequencyBinCount);
    timeData = new Float32Array(node.fftSize);
    initSpectrumWorker();
    vizAttempts = 0;        // 成功：重试计数归零
    vizDenied = false;
    vizDenyReason = "";
  } catch (e) {
    vizDenied = true;
    vizDenyReason = String((e as any)?.message || e);
    // 只有尝试次数用尽才真正提示并放弃；否则留给下一次 play 再试。
    if (vizAttempts >= VIZ_MAX_ATTEMPTS) announceVizDenied();
  }
  return analyserNode;
}
/* 播放条的 52 格刻度直接取频谱柱（跟着渲染节拍走，且只在高度真的变了才写 DOM）。
   ★ 去掉原来的 30ms 节流：那会让播放条上的频谱比详情区那一大块慢半拍以上，
     用户反馈的"频谱和音频存在延迟"在看播放条这一条时就是它（DOM 写入按"高度变了才写"
     已经足够便宜，不需要再降频）。 */
let tickLast = 0;
function paintTicks(now = 0) {
  if (!specEl || !spectrum) return;
  if (now) tickLast = now;
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
     1.4.7 之前这里是 33ms 的整帧预算，等于把渲染也锁在 30fps，那才是"帧率不够"。
     ★ 分析（Goertzel + 一阶跟随 + 抖动）**不在这一条循环里**：由 analysisTick() 每 20ms 驱动
     （1.3.0 的 50Hz，见 VIZ_ANALYSIS_MS 的注释）；rAF 只负责重画与回落。 */
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
    if (!busy) spectrum.decay();
    spectrum.render(dt);
  }
  armVizAnalysis();
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
  d.cadenceMs = VIZ_ANALYSIS_MS; // 分析节拍（1.3.0 是 20ms / 50Hz，探针核对这个值）
  d.tickFps = vizTickFps; // 实测的分析 tick 频率（应 ≈50）
  d.workerMs = Math.round(workerMsAvg * 100) / 100;
  d.rttMs = Math.round(workerRttAvg * 100) / 100;
  d.workerOn = Boolean(spectrumWorker && workerEver);
  d.dataAgeMs = Math.round(dataAgeMs * 100) / 100;
  /* 频段映射摘要：核对"是不是 20Hz ~ 0.45×Nyquist、低频峰 ≈42Hz、鼓点取 2–16 带" */
  if (spectrum) {
    const bi = spectrum.bandInfo();
    d.bandHzFirst = bi.firstHz;
    d.bandHzLast = bi.lastHz;
    d.bassPeakHz = bi.bassPeakHz;
    d.kickBands = bi.kickBands;
    d.sampleRate = bi.sampleRate;
    /* 节拍先验（探针核对用）：live=0 表示这一帧没有乐谱，下面几个必须全为 0。
       用 beatInfo() 而不是 snapshot() —— snapshot 会复制四个数组，每帧跑太重。 */
    const b = spectrum.beatInfo();
    d.beat = b;
    d.bpm = b.bpm;
  }
  vizRaf = requestAnimationFrame(vizFrame);
}
function vizStop() {
  if (vizRaf) cancelAnimationFrame(vizRaf);
  vizRaf = 0;
  stopVizAnalysis();
}
async function startViz() {
  const node = await ensureAnalyser();
  if (!node) return;
  if (actx && actx.state !== "running") await actx.resume().catch(() => {});
  if (!vizRaf) vizRaf = requestAnimationFrame(vizFrame);
  armVizAnalysis();
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
/* ★ 歌词游标：不再每次线性重扫。
   lines 是**已按时间排好序**的，而 stepLyrics 挂在 timeupdate 上（每秒数次）。
   线性扫描一首 5 分钟的歌约 100~150 行 → 每秒几百次纯浪费的比较。
   改成单调推进的游标：cur 前进时最多走几格，倒退（seek 往回拖）时才回退，
   两个 while 都是"摊还 O(1)"。 */
let lyricCursor = 0;
let lyricCursorId = "";
/* 诊断用：非 null 时取代 audio.currentTime 作为歌词推进的时间源（见 stepLyrics）。
   正常运行时恒为 null，对真实播放没有任何影响。 */
let lyricTimeOverride: number | null = null;
/** 给自动化验证用：喂一个歌词时间并立刻走一遍 stepLyrics。
    只在诊断开关下导出（见 mountSongDetail），产品运行时不暴露。 */
export function setLyricTimeForTest(sec: number) {
  lyricTimeOverride = isFinite(sec) ? sec : null;
  stepLyrics();
}

/* ★ 详情区正在"展示"的那一首 ≠ 正在"播放"的那一首。
   用户可以在档案阵列里翻看任意一首（详情面板显示 songs[selected]），
   而播放的还停在别处、甚至一首都没在播（启动时 currentId 是空的）。
   歌词是详情区的一部分，必须跟着**展示的那一首**走 —— 否则翻档案时
   明明这首有歌词，面板却写着"♪ 无歌词"（真实踩过：自动化验证里
   currentId=null，详情区显示的歌有 lrc，但歌词列表一口行都没有）。
   mountSongDetail 每次挂载都会把当前展示的曲目 id 写进来。 */
let detailSongId = "";
/** 详情区这首歌：优先用"展示中的那一首"，它不在库里时（或还没挂载过）回落到正在播放的那一首。 */
function detailSong(): Song | null {
  if (detailSongId) {
    const shown = songs.find((s) => s.id === detailSongId);
    if (shown) return shown;
  }
  return currentSong();
}
export function setDetailSongId(id: string) {
  detailSongId = id || "";
}

function stepLyrics() {
  const el = document.querySelector<HTMLElement>("#p-lyric-line");
  const list = document.querySelector<HTMLElement>("#p-lyric-list");
  const s = detailSong();
  const lines = lrcLines(s);

  /* 换歌就重置游标（lines 换了，旧游标毫无意义）。
     ★ 必须放在"分叉前" —— 两种模式（列表 / 单行）共用这一个游标，
       否则从列表切回单行时会拿旧歌的行号去点菜。 */
  if (lyricCursorId !== (s?.id || "")) {
    lyricCursorId = s?.id || "";
    lyricCursor = 0;
    lyricListId = "";      // 换歌 → 歌词列表必须重建（行数与文本都变了）
    lyricLastActive = -1;
    if (list) list.style.transform = "";
  }

  if (!lines.length) {
    const hint = s && s.lrc ? "" : "♪ 无歌词";
    if (el) {
      if (el.textContent !== hint) el.textContent = hint;
      el.classList.remove("on");
    }
    if (list && lyricListId !== "__empty__") {
      lyricListId = "__empty__";
      lyricLastActive = -1;
      list.innerHTML = '<div class="lyric-empty">♪ 这一首没有歌词</div>';
    }
    return;
  }

  /* 歌词时间源：正常取 audio.currentTime。
     ★ 自动化验证里那首假曲目没有真实音源（audio.currentTime 永远是 0），
       没法推播放进度 —— 于是允许在诊断开关（?diag=1 / rhine-diag）下
       从外面喂一个时间，走的是**和 timeupdate 完全相同**的这一条路径，
       验证到的滚动/高亮就是真实行为，不是另写一条捷径。 */
  const cur = lyricTimeOverride !== null ? lyricTimeOverride : audio.currentTime || 0;
  // 向前推进：只要能走到下一行，就走
  while (lyricCursor + 1 < lines.length && lines[lyricCursor + 1].t <= cur) lyricCursor++;
  // 向后回退：seek 往回拖 / 换到新的一首时的兜底
  while (lyricCursor > 0 && lines[lyricCursor].t > cur) lyricCursor--;

  /* ---------- 模式一：单行字幕（可视化模式） ---------- */
  if (el) {
    const text = lines[lyricCursor].txt;
    if (el.textContent !== text) el.textContent = text;
    el.classList.add("on");
  }

  /* ---------- 模式二：滚动列表（歌词模式） ---------- */
  if (list) syncLyricList(list, s, lines, lyricCursor);
}

/** 歌词列表的构建 + 高亮 + 滚动。
    为什么要"签名化重建"：这个函数挂在 timeupdate 上，每秒被调好几次；
    每帧重写 innerHTML 既浪费又会打断 CSS 过渡（滚动会一跳一跳）。
    所以只在**曲目变了**时才重建 DOM，之后每帧只做两件轻活：
      · 换一下高亮类（只动两个元素，不动整棵树）
      · 调一次 transform 把当前行滚到中间 */
let lyricListId = "";
let lyricLastActive = -1;
function syncLyricList(
  list: HTMLElement,
  s: Song | null,
  lines: { t: number; txt: string }[],
  active: number,
) {
  /* ① 构建：只在换歌时做一次。每行带 data-t（该行起始秒数），点击即可跳转。 */
  if (lyricListId !== (s?.id || "")) {
    lyricListId = s?.id || "";
    lyricLastActive = -1;
    list.innerHTML = lines
      .map(
        (ln, i) =>
          `<div class="lyric-row" data-i="${i}" data-t="${ln.t}">${esc(ln.txt)}</div>`,
      )
      .join("");
    list.style.transform = "";
  }
  /* ② 高亮：只改变化的那两行 */
  if (active !== lyricLastActive) {
    const rows = list.children;
    const prev = lyricLastActive >= 0 ? (rows[lyricLastActive] as HTMLElement | undefined) : undefined;
    if (prev) prev.classList.remove("on");
    const now = rows[active] as HTMLElement | undefined;
    if (now) now.classList.add("on");
    lyricLastActive = active;
  }
  /* ③ 滚动：把当前行挪到**可视容器**的垂直中线上。
     用 transform: translateY 而不是 scrollTop —— 前者走合成层，不触发重排，
     配 CSS 的 transition 能得到平滑滚动；后者在部分浏览器里是瞬跳的。
     ★ 中线要取**外层滚动容器**的高度（.lyric-scroll），不是列表自己的 clientHeight：
       .lyric-list 是 absolute、无显式高度，clientHeight 会被内容撑到"所有行加起来"，
       行数少时与可视区差得离谱，行数多时又会把当前行推到窗口外（踩过：
       12 行时看着差 10px 像偶然，5 行时会直接跑偏半屏）。 */
  const row = list.children[active] as HTMLElement | undefined;
  if (!row) return;
  const boxEl = list.parentElement;
  const box = (boxEl ? boxEl.clientHeight : 0) || list.clientHeight || 1;
  const dy = box / 2 - (row.offsetTop + row.offsetHeight / 2);
  list.style.transform = `translateY(${Math.round(dy)}px)`;
}

/** 歌词模式下点击某行 → 跳到那一行。
    刻意**不**自动起播：用户可能只是在浏览歌词，突然放声会吓一跳。
    要听的话点播放条就行 —— 跳转已经把进度放到了那句的开头。
    ★ 只有"展示的这首 == 正在播的这首"时才去动 audio：
      否则用户翻着另一首的歌词点了一行，会把**正在播的那首**拖走（听感上莫名其妙跳了）。 */
export function seekLyricRow(target: HTMLElement): void {
  const row = target.closest<HTMLElement>(".lyric-row");
  if (!row) return;
  const t = Number(row.dataset.t);
  if (!isFinite(t)) return;
  const shown = detailSong();
  if (!shown || shown.id !== currentId) return;
  /* seek 到那一行往前一点点，让"这一行"立刻成为当前行（否则正好卡在边界上，
     高亮会停在前一行，看着像没跳） */
  const to = Math.max(0, t - 0.01);
  try {
    audio.currentTime = to;
  } catch {
    /* 还没加载出可 seek 的时长时忽略 */
  }
  stepLyrics();
}

/* ---------- 右侧面板：可视化 / 歌词 两种形态 ---------- */
export type DetailView = "viz" | "lyric";
const LS_DETAIL_VIEW = "rhine-detail-view";
/** 当前形态。读 localStorage；脏值一律回落 viz（白名单校验，见设置持久化验证）。 */
let detailView: DetailView =
  (() => {
    try {
      return localStorage.getItem(LS_DETAIL_VIEW) === "lyric" ? "lyric" : "viz";
    } catch {
      return "viz";
    }
  })();
export function getDetailView(): DetailView {
  return detailView;
}
/** 切换形态：改状态 → 落库 → 给 .song-viz 换类名 → 补一次歌词同步。
    不重绘整个详情区 —— 那样会重放解密动画、也会重建频谱实例。 */
export function setDetailView(v: DetailView): void {
  if (v !== "viz" && v !== "lyric") return;
  detailView = v;
  try {
    localStorage.setItem(LS_DETAIL_VIEW, v);
  } catch {
    /* 隐私模式下写不了，不影响本次会话 */
  }
  applyDetailView();
  /* 切到歌词模式时列表是新建的，游标与高亮都得重算一次 */
  lyricListId = "";
  lyricLastActive = -1;
  stepLyrics();
}
/** 把当前形态写到 DOM 上（.song-viz 加 viz-mode / lyric-mode）。
    详情区每次重绘都是新节点，所以渲染后要再调一次。
    ★ 反白也要在这里搬 —— setDetailView() **刻意不重绘详情区**（重绘会重放解密动画、
      重建频谱实例），所以渲染时写在 markup 里的 .on 类不会自己跟着状态走：
      切到歌词后 .on 还留在"可视化"那颗上，看着像没切过去（实测截图就说这个谎）。
      这里按状态重新分配 .on，渲染路径与切换路径共用同一份真相。 */
export function applyDetailView(): void {
  const box = document.querySelector<HTMLElement>(".song-viz");
  if (!box) return;
  box.classList.toggle("lyric-mode", detailView === "lyric");
  box.classList.toggle("viz-mode", detailView === "viz");
  const wrap = document.querySelector<HTMLElement>("#p-view-toggle");
  if (wrap) wrap.setAttribute("aria-pressed", detailView === "lyric" ? "true" : "false");
  const on = detailView === "lyric";
  const vizBtn = document.querySelector<HTMLElement>('[data-action="view-viz"]');
  const lyricBtn = document.querySelector<HTMLElement>('[data-action="view-lyric"]');
  if (vizBtn) vizBtn.classList.toggle("on", !on);
  if (lyricBtn) lyricBtn.classList.toggle("on", on);
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
      : `<div class="p-empty">没有匹配「${esc(q)}」的曲目<br/>换个关键词，或点右边的 ✕ 清除</div>`
    : `<div class="p-empty">尚无曲目<br/>点 ＋ 导入音乐，或把文件直接拖进窗口</div>`;
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
        <button id="p-prev" title="上一首"><svg class="ico-line" viewBox="0 0 24 24" width="15" height="15"><path d="M7.4 5.2v13.6"/><path d="M18.6 6.1v11.8L9.8 12z"/></svg></button>
        <button id="p-play" title="播放 / 暂停"><svg id="p-play-icon" class="ico-line" viewBox="0 0 24 24" width="17" height="17"><path d="M7.8 5v14l11-7z"/></svg></button>
        <button id="p-next" title="下一首"><svg class="ico-line" viewBox="0 0 24 24" width="15" height="15"><path d="M16.6 5.2v13.6"/><path d="M5.4 6.1v11.8L14.2 12z"/></svg></button>
        <i class="p-sep" aria-hidden="true"></i>
        <button id="p-mode" title="播放模式">↻</button>
        <button id="p-rate" title="播放速度">1×</button>
        <button id="p-fav" title="收藏当前曲目">♡</button>
        <button id="p-import" title="导入音乐（右键 ＝ 导入整个文件夹）">＋</button>
        <button id="p-bili" title="导入 B 站缓存（选择本机缓存文件夹，自动识别其中的音频）" aria-label="导入 B 站缓存"><svg class="ico-line" viewBox="0 0 24 24" width="15" height="15"><rect x="3.4" y="7.6" width="17.2" height="11.8" rx="2.4"/><path d="M8.4 3.8 12 7.2l3.6-3.4"/></svg></button>
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
    `<div class="p-sticky"><div class="p-head"><b>ARCHIVE ARRAY ／ 播放列表</b><select id="p-sort" class="p-sort" title="排列顺序" aria-label="排列顺序">${sortModeMarkup()}</select><span id="p-count"></span><button class="p-theme" title="深色 / 浅色主题">◐</button></div>` +
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
  /* 排列顺序：改了就重排曲库（列表与档案阵列一起变），并记住选择 */
  listEl.querySelector("#p-sort")?.addEventListener("change", (e) => {
    setSortMode((e.target as HTMLSelectElement).value);
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
    if (audio.duration) audio.currentTime = (Number((e.target as HTMLInputElement).value) / 1000) * audio.duration;  });
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
    if (row) {
      const at = Number(row.getAttribute("data-i"));
      playAt(at);
      /* ★ 点的是**曲名那一段**（.p-meta）：除了播放，还要把这一首的档案打开 ——
         而且无视 openOnPlay 偏好（用户明确要求"点歌曲名就要打开对应的歌曲档案"）。
         点行内其它空白处只播放，保持原来的行为。 */
      if (t.closest(".p-meta")) followWithArchive(at, true);
    }
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
  /* ★ 点播放条的两块区域，两件事：
       · **曲名 / 艺术家那一块（.p-now）** → 打开当前这首歌的档案
         （用户反馈"点击歌曲名没有打开对应的歌曲档案"）
       · **其余空白处（频谱那一块等）** → 回到档案阵列（之前那条需求）
     控件区（按钮 / 进度条 / 音量条 / 列表开关）的点击照旧走各自的处理。 */
  bar.addEventListener("click", (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest("button, input, select, label")) return;
    if (t.closest(".p-now")) window.dispatchEvent(new CustomEvent("rhine-open-current"));
    else window.dispatchEvent(new CustomEvent("rhine-back-archive"));
  });
  const nowBlock = bar.querySelector<HTMLElement>(".p-now");
  if (nowBlock) nowBlock.title = "点击曲名打开这一首的档案；点播放条其它位置回到档案阵列";
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
  /* ★ 判据用 s.path / s.localPath（稳定的字段），不要用 s.srcUrl ——
     它是"上次算出的可播放地址"，会被自愈逻辑清空，拿它判断会让标签在
     "B 站缓存" 和 "本地文件" 之间乱跳。 */
  if (s.path) {
    /* 源没了、固化副本也没有 —— 如实说"播不了"，别让它伪装成普通曲目，
       等用户点进去才吃到报错。 */
    if (s.missing) return "音源缺失";
    /* 固化副本在库目录 = 与源缓存已解耦，源删了也照播 —— 值得如实标出来 */
    if (s.localPath) return "B 站缓存 · 已存本地";
    return "B 站缓存";
  }
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
  const album = s ? s.album : "把音乐文件拖进窗口";
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
  ${empty ? "" : detailViewBarMarkup()}
  <div class="song-viz${detailView === "lyric" ? " lyric-mode" : " viz-mode"}" data-song-id="${empty ? "" : esc(s!.id)}">
    <div class="song-viz-head">
      <span class="panel-label">SPECTRUM / 实时频谱</span>
      ${empty ? "" : detailViewToggleMarkup()}
    </div>
    <div class="song-viz-body">
      <canvas id="p-detail-spectrum" width="${Math.round(636 * 1.5)}" height="${Math.round(477 * 1.5)}" aria-hidden="true"></canvas>
      <div class="lyric-scroll" id="p-lyric-scroll"><div class="lyric-list" id="p-lyric-list"></div></div>
      <div class="lyric-veil top" aria-hidden="true"></div>
      <div class="lyric-veil bottom" aria-hidden="true"></div>
    </div>
    <div class="song-viz-axis"><span>LOW</span><span>MID</span><span>HIGH</span></div>
    <div class="song-lyric-line" id="p-lyric-line"></div>
  </div>
  <div class="detail-actions">${empty ? actions : ""}<button class="solid-button" data-action="edit-track">✎ EDIT INFO<span>修改歌曲信息</span></button><button class="export-button" data-action="play-now">${audio.paused ? "PLAY" : "PAUSE"} <span>${audio.paused ? "▶" : "■"}</span></button></div>
  <div class="detail-footnote"><span>${esc(artist)} · ${esc(album)}</span><span>${empty ? "000" : String(index + 1).padStart(3, "0")} / ${total}</span></div>`;
}

/** 右侧形态切换的分段开关（可视化 ⟷ 歌词）。
    放在详情区顶部工具栏（TRACK 行下面那条），紧邻它要控制的那块内容。
    aria-pressed 表达"现在是不是歌词模式"，键盘与读屏都能识别。 */
function detailViewBarMarkup(): string {
  return (
    `<div class="view-switch-bar">` +
    `<span class="panel-label">RIGHT PANEL / 右侧显示</span>` +
    detailViewToggleMarkup() +
    `</div>`
  );
}
/** 那个开关本体。两个都渲染出来（而不是一个按钮切换文字），
    选中态由 aria-pressed 与 .on 类表达 —— 中文标签能同时看见，不用猜。 */
function detailViewToggleMarkup(): string {
  const on = detailView === "lyric";
  return (
    `<div class="view-toggle" id="p-view-toggle" role="group" aria-label="右侧显示内容" aria-pressed="${on}">` +
    `<button type="button" data-action="view-viz"${on ? "" : ' class="on"'}>可视化</button>` +
    `<button type="button" data-action="view-lyric"${on ? ' class="on"' : ""}>歌词</button>` +
    `</div>`
  );
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
      <div class="edit-note">也可以把图片拖进上面的方框</div>
    </div>
    <div class="edit-fields">
      <label class="edit-field"><span>标题 / TITLE</span><input type="text" id="p-edit-title" maxlength="120" autocomplete="off" spellcheck="false" value="${esc(editDraft.title)}"/></label>
      <label class="edit-field"><span>艺术家 / ARTIST</span><input type="text" id="p-edit-artist" maxlength="120" autocomplete="off" spellcheck="false" value="${esc(editDraft.artist)}"/></label>
      <label class="edit-field"><span>专辑 / ALBUM</span><input type="text" id="p-edit-album" maxlength="120" autocomplete="off" spellcheck="false" value="${esc(editDraft.album)}"/></label>
      <div class="edit-hint">
        <button class="edit-mini" data-action="edit-reread">重新识别元数据</button>
        <span>会覆盖上面的输入</span>
      </div>
      <div class="edit-status" id="${EDIT_STATUS_ID}" data-kind="ok">点 SAVE 保存，ESC 取消</div>
    </div>
  </div>
  <div class="song-viz">
    <div class="song-viz-head"><span class="panel-label">SPECTRUM / 实时频谱</span></div>
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
    spectrum.setMode(vizModePref as SpectrumMode);
    spectrum.setAdvanceInterval(VIZ_ANALYSIS_MS); // 绘制侧的插值跨度 = 分析节拍
    if (VIZ_TEST || DIAG) (window as any).__rhineViz = vizDiag;
  }
  if (!vizRaf) {
    const live = (analyserNode && !audio.paused) || VIZ_TEST;
    if (live || spectrum) vizRaf = requestAnimationFrame(vizFrame);
  }
  armVizAnalysis();
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
  /* 形态（可视化 / 歌词）写在 DOM 上 —— 详情区每次重绘都是新节点，
     类名不会自己跟过来，所以每次挂载都要重新应用一次。 */
  applyDetailView();
  /* ★ 记住"详情区现在展示的是哪一首"：歌词必须跟着展示的那一首走，
     而不是正在播放的那一首（用户可以在阵列里翻看不播的那首）。
     id 由 songDetailMarkup 打在 .song-viz 上，这里读回来。 */
  const vizEl = (root as HTMLElement).querySelector?.(".song-viz") as HTMLElement | null;
  setDetailSongId(vizEl?.dataset.songId || "");
  /* 列表是本轮新建的空壳，先把缓存签名清掉，逼 syncLyricList 重建一次 */
  lyricListId = "";
  lyricLastActive = -1;
  const listEl = (root as HTMLElement).querySelector?.("#p-lyric-list") as HTMLElement | null;
  if (listEl) {
    /* 点某一行 → 跳到那句。挂在容器上做事件委托，不为每行绑一个监听。 */
    listEl.addEventListener("click", (ev) => {
      const t = ev.target as HTMLElement | null;
      if (t) seekLyricRow(t);
    });
    /* ★ 滚动位置量的是 offsetTop，依赖列表已完成布局。
       若在挂载瞬间就量，行高还是 0，滚动会算到错误位置 ——
       所以先在下一帧补一次同步（此时排版已完成）。 */
    requestAnimationFrame(() => stepLyrics());
  }
  stepLyrics();
  const cv = (root as HTMLElement).querySelector?.("#p-detail-spectrum") as HTMLCanvasElement | null;
  if (cv) {
    // 面板每次重绘都是新画布，因此频谱实例跟着重建（画布尺寸决定柱宽与渐变）
    spectrum = new Spectrum(cv, actx?.sampleRate ?? 48000);
    spectrum.setPalette(spectrumPalette());
    spectrum.setMode(vizModePref as SpectrumMode);
    spectrum.setAdvanceInterval(VIZ_ANALYSIS_MS); // 绘制侧的插值跨度 = 分析节拍
    // 诊断开关：?viztest=1 时把实例与帧率对象挂到 window 上，便于自动化核对（见功能说明）
    if (VIZ_TEST || DIAG) {
      (window as any).__audioEl = audio;
      (window as any).__rhineViz = vizDiag;
      /* 歌词推进的诊断入口：给一个秒数 → 等价于"播到那一秒"。
         验证脚本拿它核对高亮行与滚动位置（真实 audio 在无音源时推不动）。 */
      (window as any).__rhineLyricSeek = (sec: number) => setLyricTimeForTest(sec);
      (window as any).__rhineStepLyrics = () => stepLyrics();
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
  armVizAnalysis();
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
      /* B 站这一路走的是"读字节 → blob"，正常情况下不会因为协议被拦（file:// 已不用）。
         到这里还能报错，最可能的就是**副本本身坏了**（头没剥干净、副本被清掉）——
         所以直接重建副本、重读字节。 */
      toast(`${name}${why}，正在重建可播放副本…`);
      await ensurePlayableSource(s, true); // force = 强制重建
      if (currentId === s.id) {
        let blob = await blobUrlOf(s, true); // force：跳过本地副本，先从源缓存重建
        /* 源缓存已经被删掉时上面会失败 —— 退回本地保留副本再试一次，
           用户反馈的"把缓存文件夹删了就不能播"正需要这条兜底。 */
        if (!blob && s.localPath) blob = await blobUrlOf(s, false);
        if (blob) {
          if (currentUrl && currentUrl !== blob) URL.revokeObjectURL(currentUrl);
          currentUrl = blob;
          audio.src = blob;
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
  /* ★ 报错文案的主次必须摆对。
     原来的写法一律以 MediaError 的机械翻译打头（"格式不支持或文件头异常"），
     再把真实原因塞在后面 —— 用户第一眼看到的是"格式不支持"，会以为播放器坏了，
     而真正的原因往往是"源文件已经不在硬盘上"。这是**误导性**的。
     规则：lastSourceError 若已给出明确原因（文件不存在 / 已删除 / 副本不在），
     就让它当主语；MediaError 只在没别的原因时才当主因，否则降为附注。 */
  const reason = lastSourceError;
  const reasonIsClear = !!reason && /不存在|已删除|不在|读不到|被删|没有可用的本地副本/.test(reason);
  const tail = code && !reasonIsClear ? `（MediaError ${code}）` : "";
  const msg = reasonIsClear
    ? `${name}无法播放：${reason}`
    : `${name}无法播放：${why}${code ? `（MediaError ${code}）` : ""}${reason ? ` ／ ${reason}` : ""}`;
  toast(msg);
  return;
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
  maybePrefetch();
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
  /* 深浅一切换，强调色的"底色"就变了（浅色底要深一点才压得住，深色底要亮一点才跳出来），
     所以让封面配色按新的底色重算一次。 */
  refreshCoverAccent();
}

/* ================= 封面主色驱动的强调色（"跟随封面"） =================
   为什么做这个：项目里所有弹层、滑槽、滑块、进度条把手**都已经跟随主题变量**
   （--p-accent 等，见 style.css），也就是说"动态换色"这件事的**基础设施早就齐了**，
   缺的只是一个颜色来源。而封面是每首歌自带、且视觉信息量最大的那一个来源。
   做法：从当前封面缩略图上采样，挑一个"够鲜艳、够亮"的像素做强调色，
   再按当前是深色还是浅色主题做明度修正，最后写成 CSS 变量。
   成本：封面早就被缩成 512px 的 dataURL 了，再缩到 24×24 采一次样即可 —— 开销可忽略。 */
let coverAccentSig = "";     // 已经算过的封面指纹，避免重复采样
let coverAccentOn = true;    // 可在设置里关掉（有些封面配色很脏，用户可能不想要）
export function setCoverAccent(on: boolean) {
  coverAccentOn = on;
  try {
    localStorage.setItem("rhine-cover-accent", on ? "1" : "0");
  } catch {
    /* ignore */
  }
  if (!on) clearCoverAccent();
  else {
    coverAccentSig = "";   // 强制重算
    refreshCoverAccent(true);
  }
}
export function coverAccentEnabled(): boolean {
  return coverAccentOn;
}
/** 把颜色写成主题变量。--p-accent 及其派生色（accent 的浅/深变体）一起给。 */
function applyCoverAccent(rgb: [number, number, number]) {
  const [r, g, b] = rgb;
  const root = document.body;
  root.style.setProperty("--p-accent", `rgb(${r}, ${g}, ${b})`);
  // 派生：hover / 选中态用的"亮一档"
  const lighter = mixChannel(rgb, 1.28);
  const darker = mixChannel(rgb, 0.72);
  root.style.setProperty("--p-accent-lite", `rgb(${lighter[0]}, ${lighter[1]}, ${lighter[2]})`);
  root.style.setProperty("--p-accent-deep", `rgb(${darker[0]}, ${darker[1]}, ${darker[2]})`);
  root.classList.add("cover-accent");
}
function clearCoverAccent() {
  const root = document.body;
  root.classList.remove("cover-accent");
  // 去掉内联变量 → 回落到 style.css 里的主题默认值
  root.style.removeProperty("--p-accent");
  root.style.removeProperty("--p-accent-lite");
  root.style.removeProperty("--p-accent-deep");
}
function mixChannel(rgb: [number, number, number], k: number): [number, number, number] {
  return [
    Math.max(0, Math.min(255, Math.round(rgb[0] * k))),
    Math.max(0, Math.min(255, Math.round(rgb[1] * k))),
    Math.max(0, Math.min(255, Math.round(rgb[2] * k))),
  ];
}
/* 采样算法：不用"平均色"（会退化成灰色），而是按 HSV 挑——
   取饱和度 × 明度的加权，在"够亮、色彩够足"的像素里选得分最高的那一个，
   再对它做聚类平均（把相近颜色的像素一起平掉，得到稳定不跳的色相）。 */
function sampleAccent(img: HTMLImageElement): [number, number, number] | null {
  const N = 24;
  const cv = document.createElement("canvas");
  cv.width = N;
  cv.height = N;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(img, 0, 0, N, N);
  } catch {
    return null;   // 跨域图会抛，直接放弃（本项目的封面都是 dataURL，正常不会）
  }
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, N, N).data;
  } catch {
    return null;
  }
  const dark = document.body.classList.contains("theme-dark");
  let best: [number, number, number] | null = null;
  let bestScore = 0;
  // 第一遍：找得分最高的像素（得分 = 饱和度 × 明度适配权重）
  const px: { r: number; g: number; b: number; h: number; s: number; v: number }[] = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;               // 忽略半透明
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const { h, s, v } = rgbToHsv(r, g, b);
    px.push({ r, g, b, h, s, v });
    /* 太黑或太白都当不了强调色（会跟文字/背景打架）；
       深色主题要偏亮的色（v 0.45~0.95），浅色主题要偏沉一点的色（v 0.30~0.80）。 */
    if (s < 0.22) continue;
    if (dark ? v < 0.40 || v > 0.97 : v < 0.24 || v > 0.86) continue;
    const score = s * (dark ? v : 1 - Math.abs(v - 0.52) * 1.4);
    if (score > bestScore) {
      bestScore = score;
      best = [r, g, b];
    }
  }
  if (!best) return null;
  // 第二遍：把色相相近（±18°）的像素平均一遍，得到更稳的颜色
  const base = rgbToHsv(best[0], best[1], best[2]);
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (const p of px) {
    if (p.s < 0.15) continue;
    let dh = Math.abs(p.h - base.h);
    if (dh > 180) dh = 360 - dh;
    if (dh > 18) continue;
    if (Math.abs(p.v - base.v) > 0.34) continue;
    sr += p.r; sg += p.g; sb += p.b; n++;
  }
  if (!n) return best;
  const avg: [number, number, number] = [
    Math.round(sr / n),
    Math.round(sg / n),
    Math.round(sb / n),
  ];
  // 最后按主题再校一次明度：深色主题宁可亮一点，浅色主题宁可沉一点，保证对比度
  return adjustForTheme(avg, dark);
}
function rgbToHsv(r: number, g: number, b: number) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: mx === 0 ? 0 : d / mx, v: mx };
}
function adjustForTheme(rgb: [number, number, number], dark: boolean): [number, number, number] {
  const { s, v } = rgbToHsv(rgb[0], rgb[1], rgb[2]);
  // 深色主题：v 抬到 0.62 上下；浅色主题：v 压到 0.48 上下
  const targetV = dark ? 0.64 : 0.46;
  const k = v > 0.001 ? Math.max(0.55, Math.min(1.9, targetV / v)) : 1;
  return mixChannel(rgb, k);
}
/** 取当前曲目的封面，算一遍强调色。封面没变就跳过（用 url 前 64 字符当指纹）。 */
export function refreshCoverAccent(force = false) {
  if (!coverAccentOn) return;
  const s = currentSong();
  const src = s?.cover || "";
  if (!src) { clearCoverAccent(); coverAccentSig = ""; return; }
  const sig = src.slice(0, 64) + "|" + src.length + "|" + (document.body.classList.contains("theme-dark") ? "d" : "l");
  if (!force && sig === coverAccentSig) return;
  coverAccentSig = sig;
  const img = new Image();
  img.onload = () => {
    const c = sampleAccent(img);
    if (c) applyCoverAccent(c);
    else clearCoverAccent();   // 采不出合适的颜色（灰度封面等）→ 回落默认主题色
  };
  img.onerror = () => clearCoverAccent();
  img.src = src;
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
  /* 封面强调色偏好：默认开（"跟随封面"是这个界面的主要观感卖点），
     用户可以关掉 —— 关一次就记住。 */
  try {
    const ca = localStorage.getItem("rhine-cover-accent");
    if (ca === "0") coverAccentOn = false;
  } catch {
    /* ignore */
  }
  /* 节拍预分析偏好：默认开（"提前点亮"是这次的主要收益），关一次就记住。 */
  try {
    if (localStorage.getItem("rhine-beatmap") === "0") beatEnabledPref = false;
  } catch {
    /* ignore */
  }
  setBeatmapEnabled(beatEnabledPref);
  installBeatmapHooks();
  buildUI();
  // 先落一份（可能是空库 → 占位档案），保证三维档案阵列一进来就有东西可显示
  syncRecords();
  /* ★ 不 await 读库：IndexedDB 第一次打开要好几秒（实测 1.2–7 秒，取决于库大小与磁盘），
     挡在这里会让开屏、三维阵列和详情面板都跟着等。先按空库把界面立起来，
     读回来之后再通过 notify() 补一次 —— 空库时显示的"导入音乐"占位档案会被真实曲目替换。
     这同时修掉了旧写法的一个真实故障：原来是 1.5 秒的 Promise.race 超时，
     读得慢就整轮当空库，那一轮所有曲目都进不来。 */
  void loadLibraryWithRetry();
  void repairTags();
  /* 旧版的调音参数（平衡/峰宽/抖动/鼓点/峰高）导一次：新版读不到 file:// 域那份存储，
     交给主进程开隐藏页去读（见 app/main.js 的 import-legacy-settings）。 */
  void importLegacyVizSettings();
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
/** 读曲库。库大 + 磁盘忙时打开就要好几秒（实测 397 首的库 getAll 要 2.9 秒，
    冷盘上更久），所以超时预算给到 8 秒；以前是固定 1.5 秒的 Promise.race，
    读得慢就整轮当空库、所有曲目都进不来 —— 那就是用户看到的"曲库像空的"。 */
async function loadLibrary(budget = LIB_LOAD_TIMEOUT): Promise<Song[]> {
  return withTimeout(idb.all(), budget, []).catch(() => []);
}
/** ★ 读库的"空结果"不能当成"曲库是空的"：
    `withTimeout` 超时也会返回空数组，而大库冷启动（3.5 GB 的 blob、刚清过系统缓存）
    完全可能超过 8 秒 —— 表现就是用户反馈的"一打开之前导入的歌曲全不见了"
    （数据其实一条都没少，只是这一轮没读回来，而且**不会重试**）。
    所以：首轮超时（拿到空数组）时提示一句"还在读"，再给 30 秒重读一次，
    真拿到了就补上；两次都空才认。 */
async function loadLibraryWithRetry() {
  const first = await loadLibrary();
  if (first.length) {
    applyLibrary(first);
    return;
  }
  toast("正在读取曲库…（曲库较大时第一次打开会慢一些）");
  const second = await loadLibrary(30000);
  if (second.length) {
    applyLibrary(second);
    toast(`曲库已读取：${second.length} 首`);
  } else {
    applyLibrary([]);
  }
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
  /* 曲库到位后：先按用户选的顺序排好（默认＝导入顺序），再清历史重复、恢复播放条，
     最后刷阵列 / 列表 / 详情 */
  applySort();
  const cleaned = dedupeLibrary();
  restorePlayhead();
  notify();
  renderNow();
  if (cleaned) window.setTimeout(() => toast(`已清理 ${cleaned} 首重复曲目`), 1200);
}
