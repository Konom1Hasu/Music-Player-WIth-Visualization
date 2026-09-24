// 音乐播放器：把本地音乐库映射成"档案"，驱动三维档案阵列，并提供传输控制。
// 后端能力（NCM 解密 / B 站缓存 / 读封面 / 歌词 / 读音频）复用 Electron 的 window.desktop。
import { setRecords, type ArchiveRecord } from "./data";

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
let orderSeq = 0;
let currentUrl: string | null = null;
let pendingSeek = 0;
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
/* 精简 ID3：标题/歌手/专辑 + 内嵌封面 */
function parseID3(buf: Uint8Array) {
  const out: { title: string; artist: string; album: string; cover: string | null } = { title: "", artist: "", album: "", cover: null };
  try {
    if (buf.length < 10 || String.fromCharCode(buf[0], buf[1], buf[2]) !== "ID3") return out;
    const v4 = buf[3] === 4;
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    let i = 10;
    const end = Math.min(buf.length, 10 + size);
    while (i + 10 <= end) {
      const id = String.fromCharCode(buf[i], buf[i + 1], buf[i + 2], buf[i + 3]);
      const sz = v4
        ? ((buf[i + 4] & 0x7f) << 21) | ((buf[i + 5] & 0x7f) << 14) | ((buf[i + 6] & 0x7f) << 7) | (buf[i + 7] & 0x7f)
        : (buf[i + 4] << 24) | (buf[i + 5] << 16) | (buf[i + 6] << 8) | buf[i + 7];
      const d = buf.subarray(i + 10, i + 10 + sz);
      const txt = () => {
        let s = 0;
        if (d[0] === 1) s = 2;
        else if (d[0] === 0) s = 1;
        try {
          return new TextDecoder("utf-8").decode(d.subarray(s)).replace(/\0+$/, "");
        } catch {
          return "";
        }
      };
      if (id === "TIT2") out.title = txt();
      else if (id === "TPE1") out.artist = txt();
      else if (id === "TALB") out.album = txt();
      else if (id === "APIC") {
        let p = 0;
        if (d[0] === 0 || d[0] === 3) p = 1;
        while (p < d.length && d[p] !== 0) p++;
        p++;
        while (p < d.length && d[p] !== 0) p++;
        p++;
        out.cover = URL.createObjectURL(new Blob([d.slice(p) as BlobPart], { type: "image/jpeg" }));
      }
      if (sz === 0 || id === "\0\0\0\0") break;
      i += 10 + sz;
    }
  } catch {
    /* ignore */
  }
  return out;
}

/* ---------- 歌曲 → 档案映射 ---------- */
const LANES = ["音乐 Ⅰ", "音乐 Ⅱ", "音乐 Ⅲ", "音乐 Ⅳ", "音乐 Ⅴ"];
function toRecord(s: Song, index: number): ArchiveRecord {
  const no = String(index + 1).padStart(3, "0");
  return {
    id: "X-" + no,
    title: s.title,
    en: s.artist || s.title,
    department: s.artist || "未知艺术家",
    category: LANES[index % LANES.length],
    date: "AUDIO",
    lead: s.album || "未知专辑",
    clearance: "AUTHORIZED",
    abstract: `${s.artist || "未知艺术家"} · ${s.album || "未知专辑"}${s.duration ? " · " + Math.round(s.duration) + "s" : ""}`,
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
  vizPeaks.fill(0);
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
  selectSong(s.id);
  s.plays = (s.plays || 0) + 1;
  persist(s);
  audio.play().catch(() => {});
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
      const meta = parseID3(new Uint8Array(await audioFile.slice(0, 1024 * 1024).arrayBuffer()));
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
  if (kicker) kicker.textContent = `${audio.paused ? "READY" : "PLAYING"} · ${MODE_EN[mode] ?? "LOOP"}`;
  renderList();
}

/* ---------- 频谱：Web Audio 分析当前播放的音频元素 ---------- */
let actx: AudioContext | null = null;
let analyserNode: AnalyserNode | null = null;
let freqData: Uint8Array<ArrayBuffer> | null = null;
let vizDenied = false;
let vizRaf = 0;
const DETAIL_BARS = 127;
const levels = new Float32Array(DETAIL_BARS);
const vizPeaks = new Float32Array(DETAIL_BARS);

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
    node.fftSize = 2048;
    node.smoothingTimeConstant = 0.7;
    source.connect(node);
    node.connect(ctx.destination);
    actx = ctx;
    analyserNode = node;
    freqData = new Uint8Array(node.frequencyBinCount);
  } catch {
    vizDenied = true;
  }
  return analyserNode;
}
function readLevels() {
  if (!analyserNode || !freqData) return false;
  analyserNode.getByteFrequencyData(freqData);
  const nyquist = (actx?.sampleRate ?? 48000) / 2;
  const binHz = nyquist / freqData.length;
  const minBin = Math.max(1, Math.floor(42 / binHz));
  const maxBin = Math.max(minBin + DETAIL_BARS, Math.min(freqData.length - 1, Math.ceil(16000 / binHz)));
  const ratio = maxBin / minBin;
  for (let i = 0; i < DETAIL_BARS; i++) {
    const from = Math.max(0, Math.floor(minBin * Math.pow(ratio, i / DETAIL_BARS)));
    const to = Math.max(from + 1, Math.floor(minBin * Math.pow(ratio, (i + 1) / DETAIL_BARS)));
    let peak = 0;
    for (let b = from; b < to && b < freqData.length; b++) if (freqData[b] > peak) peak = freqData[b];
    const tilt = 0.66 + 0.72 * (i / DETAIL_BARS); // 高频能量天然低，做一点倾斜补偿
    const target = Math.min(1, Math.pow(peak / 255, 0.86) * tilt * 1.5);
    const cur = levels[i];
    levels[i] = target > cur ? cur + (target - cur) * 0.58 : cur + (target - cur) * 0.13;
    vizPeaks[i] = Math.max(levels[i], vizPeaks[i] - 0.011);
  }
  return true;
}
function paintTicks() {
  if (!specEl) return;
  const kids = specEl.children;
  const step = DETAIL_BARS / kids.length;
  for (let i = 0; i < kids.length; i++) {
    let sum = 0;
    const from = Math.floor(i * step);
    const to = Math.max(from + 1, Math.floor((i + 1) * step));
    for (let b = from; b < to && b < DETAIL_BARS; b++) sum += levels[b];
    const v = Math.min(1, sum / (to - from));
    const el = kids[i] as HTMLElement;
    el.style.height = Math.max(2, Math.round(2 + v * 24)) + "px";
    el.style.opacity = String(0.34 + v * 0.66);
  }
}
function paintDetail() {
  const cv = document.querySelector<HTMLCanvasElement>("#p-detail-spectrum");
  if (!cv) return;
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  const W = cv.width;
  const H = cv.height;
  const night = document.body.classList.contains("rhine-night");
  const ink = night ? "#f0eee5" : "#252820";
  const ghost = night ? "#4b4a3b" : "#b6b1a6";
  const accent = night ? "#c08b52" : "#9b7247";
  ctx.clearRect(0, 0, W, H);
  const pitch = W / DETAIL_BARS;
  const barW = Math.max(2, Math.round(pitch * 0.6));
  for (let i = 0; i < DETAIL_BARS; i++) {
    const x = i * pitch;
    ctx.fillStyle = ghost;
    ctx.fillRect(x, H - 3, barW, 3); // 静默基线，和终端的刻度条一致
    const v = levels[i];
    if (v > 0.01) {
      const h = Math.max(3, Math.round(v * (H - 6)));
      ctx.fillStyle = ink;
      ctx.fillRect(x, H - 3 - h, barW, h);
    }
    const p = vizPeaks[i];
    if (p > 0.05) {
      ctx.fillStyle = accent;
      ctx.fillRect(x, Math.max(0, H - 4 - Math.round(p * (H - 6))), barW, 2);
    }
  }
}
function vizFrame() {
  vizRaf = 0;
  const live = readLevels();
  paintDetail();
  paintTicks();
  const busy = live && (!audio.paused || levels.some((v) => v > 0.012));
  if (busy) vizRaf = requestAnimationFrame(vizFrame);
}
async function startViz() {
  const node = await ensureAnalyser();
  if (!node) return;
  if (actx && actx.state !== "running") await actx.resume().catch(() => {});
  if (!vizRaf) vizRaf = requestAnimationFrame(vizFrame);
}

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
/** 歌词页签里高亮当前行（详情区里的歌词是终端"文档"的一部分）。 */
function stepLyrics() {
  const box = document.querySelector<HTMLElement>(".song-lyrics");
  if (!box) return;
  const lines = lrcLines(currentSong());
  if (!lines.length) return;
  const cur = audio.currentTime || 0;
  let idx = 0;
  for (let i = 0; i < lines.length; i++) if (lines[i].t <= cur) idx = i;
  const kids = box.querySelectorAll<HTMLElement>(".lyric-line");
  kids.forEach((el, i) => el.classList.toggle("cur", i === idx));
  const active = kids[idx];
  if (active && box.scrollHeight > box.clientHeight + 4) {
    const top = active.offsetTop - box.clientHeight / 2 + active.offsetHeight / 2;
    box.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
  }
}

/* ---------- 列表与播放条 ---------- */
function renderList() {
  if (!listEl) return;
  const s = currentSong();
  listEl.innerHTML =
    `<div class="p-head"><b>ARCHIVE ARRAY ／ 播放列表</b><span>${String(songs.length).padStart(2, "0")} TRACKS</span><button class="p-theme" title="昼 / 夜配色">◐</button></div>` +
    (songs.length
      ? songs
          .map(
            (x, i) =>
              `<div class="p-row${x.id === currentId ? " active" : ""}" data-i="${i}"><span class="p-idx">${String(i + 1).padStart(2, "0")}</span><span class="p-meta"><b>${esc(x.title)}</b><small>${esc(x.artist)}${x.album ? " · " + esc(x.album) : ""}${x.fav ? " ／ ♥" : ""}</small></span><button class="p-fav${x.fav ? " on" : ""}" data-fav="${x.id}" title="收藏">${x.fav ? "♥" : "♡"}</button><button class="p-del" data-del="${x.id}" title="移除">✕</button></div>`,
          )
          .join("")
      : `<div class="p-empty">尚无曲目。点击 ＋ 导入音乐文件，右键 ＋ 导入整个文件夹。</div>`);
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
    const row = t.closest("[data-i]") as HTMLElement | null;
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
  const s = songs[index];
  if (!s) return "";
  const total = String(songs.length).padStart(3, "0");
  const status = audio.paused ? "READY" : "PLAYING";
  const fav = s.fav ? "♥" : "♡";
  return `
  <div class="detail-kicker"><span>TRACK ${esc(s.id.slice(-3).toUpperCase().padStart(3, "0"))}</span><span class="song-mode-kicker">${status} · ${MODE_EN[mode] ?? "LOOP"}</span></div>
  <div class="song-head">
    <div class="song-cover">${s.cover ? `<img src="${s.cover}" alt="${esc(s.title)} 封面"/>` : ""}</div>
    <div class="song-head-text">
      <h2>${esc(s.title)}</h2>
      <div class="detail-title-cn">${esc(s.artist)}<span>${esc(s.album)}</span></div>
    </div>
  </div>
  <div class="detail-rule"></div>
  <dl class="metadata">
    <div><dt>DURATION / 时长</dt><dd>${mmss(s.duration)}</dd></div>
    <div><dt>PLAYED / 播放次数</dt><dd><i></i>${s.plays || 0} 次</dd></div>
    <div><dt>FORMAT / 来源</dt><dd>${esc(sourceLabel(s))}</dd></div>
    <div><dt>POSITION / 上次进度</dt><dd>${s.pos > 3 ? mmss(s.pos) : "从头开始"}</dd></div>
  </dl>
  <div class="song-viz">
    <div class="panel-label">SPECTRUM / 实时频谱</div>
    <canvas id="p-detail-spectrum" width="${636 * 2}" height="${72 * 2}" aria-hidden="true"></canvas>
    <div class="song-viz-axis"><span>LOW 40Hz</span><span>MID 1kHz</span><span>HIGH 16kHz</span></div>
  </div>
  <div class="detail-tabs" role="tablist"><button id="tab-overview" class="active" role="tab" aria-controls="tab-panel" aria-selected="true" data-tab="overview">01 <span>曲目</span></button><button id="tab-notes" role="tab" aria-controls="tab-panel" aria-selected="false" data-tab="notes">02 <span>歌词</span></button><button id="tab-history" role="tab" aria-controls="tab-panel" aria-selected="false" data-tab="history">03 <span>播放记录</span></button><i class="tab-indicator" aria-hidden="true"></i></div>
  <div id="tab-panel" class="tab-panel" role="tabpanel">${songTabMarkup("overview", index)}</div>
  <div class="detail-actions"><button class="solid-button" data-action="fav-track" aria-pressed="${s.fav}">${s.fav ? "− REMOVE FROM SAVED" : "＋ SAVE TRACK"}<span>${fav} ${s.fav ? "已收藏" : "收藏曲目"}</span></button><button class="export-button" data-action="play-now">${audio.paused ? "PLAY" : "PAUSE"} <span>${audio.paused ? "▶" : "■"}</span></button></div>
  <div class="detail-footnote"><span>${esc(s.artist)} · ${esc(s.album)}</span><span>${String(index + 1).padStart(3, "0")} / ${total}</span></div>`;
}
export function songTabMarkup(tab: string, index: number): string {
  const s = songs[index];
  if (!s) return "";
  if (tab === "notes") {
    const lines = lrcLines(s);
    if (!lines.length)
      return `<div class="panel-label">LYRICS / 歌词</div><p class="song-lyrics-empty">这首歌还没有歌词。把同名 .lrc 文件放在音乐旁边，重新导入即可自动匹配。</p>`;
    return `<div class="panel-label">LYRICS / 歌词 <span style="color:#807b70">·  点击任意一行跳转</span></div><div class="song-lyrics">${lines
      .map((l) => `<div class="lyric-line" data-t="${l.t}"><b>${mmss(l.t)}</b>${esc(l.txt)}</div>`)
      .join("")}</div>`;
  }
  if (tab === "history") {
    const rows: [string, string][] = [
      ["PLAY COUNT / 播放次数", `${s.plays || 0} 次`],
      ["LAST POSITION / 上次进度", s.pos > 3 ? mmss(s.pos) : "从头开始"],
      ["FAVORITE / 收藏", s.fav ? "已收藏" : "未收藏"],
      ["LIBRARY ORDER / 入库顺序", `第 ${(s.order || 0) + 1} 首`],
    ];
    return (
      `<div class="panel-label">PLAYBACK LOG / 播放记录</div>` +
      rows.map(([k, v]) => `<div class="song-record"><b>${k}</b><span>${esc(v)}</span></div>`).join("")
    );
  }
  return `<div class="panel-label">OVERVIEW / 曲目摘要</div><p>${esc(s.artist)} 的《${esc(s.title)}》，收录于《${esc(s.album)}》。${
    s.duration ? "全长 " + mmss(s.duration) + "。" : ""
  }当前档案阵列共 ${songs.length} 首曲目，第 ${index + 1} 首正在被读取。</p>`;
}
/** 详情区渲染完成后调用：接管频谱画布与歌词点击。 */
export function mountSongDetail(root: ParentNode) {
  const box = (root as HTMLElement).querySelector?.(".song-lyrics") as HTMLElement | null;
  box?.addEventListener("click", (e) => {
    const line = (e.target as HTMLElement).closest<HTMLElement>(".lyric-line");
    if (!line) return;
    const t = Number(line.getAttribute("data-t"));
    if (Number.isFinite(t)) audio.currentTime = t;
  });
  if (vizRaf) return;
  const live = analyserNode && !audio.paused;
  paintDetail();
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
  const s = currentSong();
  if (s && dur) {
    s.pos = cur;
    if (!(s as any)._savedAt || Date.now() - (s as any)._savedAt > 5000) {
      (s as any)._savedAt = Date.now();
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
  if (pendingSeek > 3 && audio.duration && pendingSeek < audio.duration - 5) {
    try {
      audio.currentTime = pendingSeek;
    } catch {
      /* ignore */
    }
  }
  pendingSeek = 0;
});
audio.addEventListener("play", () => {
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

/* ---------- 昼 / 夜配色（参考图 A 暖白纸面 ↔ 图 B 青石板） ---------- */
export function toggleNight(force?: boolean) {
  const night =
    force === undefined ? !document.body.classList.contains("rhine-night") : force;
  document.body.classList.toggle("rhine-night", night);
  try {
    localStorage.setItem("rhine-night", night ? "1" : "0");
  } catch {
    /* ignore */
  }
  paintDetail();
}

/* ---------- 初始化 ---------- */
export async function initPlayer() {
  try {
    mode = localStorage.getItem("rhine-music-mode") || "list";
  } catch {
    /* ignore */
  }
  try {
    if (localStorage.getItem("rhine-night") === "1") document.body.classList.add("rhine-night");
  } catch {
    /* ignore */
  }
  buildUI();
  try {
    // ★ 不能让启动流程被 IndexedDB 卡住：某些环境（虚拟时间、隐私模式、DB 被占用）
    //   下 open/getAll 可能既不成功也不失败，await 就永久挂起 → 开屏一直停在加载层。
    //   这里加超时兜底，超时就当作空库继续启动。
    const saved = await Promise.race([
      idb.all(),
      new Promise<Song[]>((resolve) => setTimeout(() => resolve([]), 1500)),
    ]);
    if (saved.length) {
      songs = saved.sort((a, b) => (a.order || 0) - (b.order || 0));
      orderSeq = songs.reduce((m, s) => Math.max(m, s.order || 0), 0) + 1;
      currentId = null;
    }
  } catch {
    /* ignore */
  }
  // 始终同步一次：空库时写入"导入音乐"占位档案，保证三维阵列有内容可显示
  syncRecords();
}
