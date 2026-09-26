import { InspectionOverlay } from "./inspection-overlay";
import { DocumentDecryption } from "./document-decryption";
import "./document-decryption.css";
import "./decryption.css";
import { escapeHtml } from "./html";
import { normalizeQuality, qualityPresets, type QualityPreset, type RenderQuality } from "./render-quality";
import { qualityMarkup, syncQualityUI } from "./quality-settings";
import "@kitlangton/rolling-number/styles.css";
import "./style.css";
import "./quality-settings.css";
import { createRollingNumber, createRollingText } from "@kitlangton/rolling-number";
import { ArchiveScene } from "./scene";
import { ModelViewer } from "./model-viewer";
import { ContentTransition, SurfaceTransition } from "./ui-transitions";
import { BootSequence } from "./boot";
import { wrap, type ArchiveNavigation } from "./archive-loop";
import {
  records,
  categories,
  archiveColumns,
  columnFiles,
  fileLocation,
  onRecordsChange,
} from "./data";
import {
  initPlayer,
  onLibraryChange,
  getSongs,
  togglePlay,
  playAt,
  focusTrack,
  hasSongs,
  songAt,
  currentIndex,
  songDetailMarkup,
  mountSongDetail,
  songEditMarkup,
  mountSongEdit,
  applySongEdit,
  playbackSettingsMarkup,
  setPlaybackPref,
  setSortMode,
  type PlaybackPrefs,
  toggleFavAt,
  importFiles,
} from "./player";
import { TerminalAudio } from "./audio";
import { audioSettingsMarkup } from "./audio-settings";

const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
import { logo, brandHeading } from "./brand";
import { getOperator, setOperator } from "./operator";

$("#stage").innerHTML = `
  <div id="three-scene" class="three-scene"></div>
  <div class="scene-atmosphere archive-atmosphere"></div>
  <div id="boot-background" class="boot-background"><svg viewBox="0 0 1920 1080" preserveAspectRatio="none"><g fill="none" stroke="#fff" stroke-width="3"><path d="M-210 705C-45 705 182 704 247 567C337 377 99 306 4 435S27 680 169 631C309 584 227 314 279 111S568-113 568-113"/><path d="M1560-80C1374 114 1671 168 1601 323S1371 367 1431 480S1692 666 1559 787S1329 886 1498 1130"/><circle cx="1450" cy="648" r="346"/><circle cx="1450" cy="648" r="348"/></g></svg></div>
  <header class="brand">${brandHeading}</header>
  <nav class="system-nav" aria-label="系统导航">
    <button data-action="search"><span class="nav-glyph">⌕</span> TRACK INDEX <span class="key">/</span></button>
    <button data-action="saved" aria-label="查看收藏曲目" title="收藏曲目">＋ SAVED <span id="saved-count">00</span></button>
    <button data-action="settings" aria-label="系统设置" title="系统设置"><span class="settings-glyph">◷</span></button>
  </nav>
  <button id="skip" class="skip" data-action="skip">ENTER SYSTEM <span>↗</span></button>
  <section id="boot" class="boot" aria-label="系统启动">
    <div class="access-text">ACCESS</div>
    <div class="boot-logo">${logo}</div>
    <div class="auth-status"><span>▪</span> <span id="auth-message"></span><i></i></div>
    <div class="scan"><svg viewBox="0 0 1920 1080" aria-hidden="true"><g fill="none" stroke="#080a08" stroke-width="2" stroke-linecap="round"><path/><path stroke="#fff"/><path/><path/><path/><path/><circle class="orbit-dot" r="8" fill="#ed821b" stroke="none"/><circle class="orbit-dot" r="8" fill="#ed821b" stroke="none"/><circle class="scan-core" cx="960" cy="540" r="5" fill="#080a08" stroke="none"/></g></svg><span>PERMISSION AUTHORIZED</span></div>
    <div class="welcome"><div class="welcome-panel"></div><div class="welcome-heading">WELCOME TO</div><div class="welcome-company"><strong>RHINE LAB.LLC.</strong><strong class="welcome-highlight" aria-hidden="true">RHINE LAB.LLC.</strong></div><div class="welcome-database">INTERNAL DATABASE</div><div class="welcome-logo">${logo}</div></div>
  </section>
  <div id="cinema-caption" class="cinema-caption"></div>
  <svg id="inspection-marks" viewBox="0 0 1920 1080" aria-hidden="true"><path id="inspection-lines"/><g id="inspection-corners"></g><circle id="inspection-point" r="1.8"/></svg>
  <div id="inspection-text" aria-hidden="true">CONFIDENTIALITY:<strong>GENERAL BUSINESS USE</strong></div>
  <section id="archive-ui" class="archive-ui" aria-label="曲目选择">
    <div class="archive-callout"><div class="eyebrow">NOW SELECTED <span>／</span> <span id="archive-category">音乐档案</span></div><button class="file-title" data-action="open">TRACK NUMBER: <span id="selected-id">X-<span id="selected-code">001</span></span><span class="file-open">↗</span></button><div class="callout-rule"><i></i></div><div class="file-summary"><span id="selected-title">尚无曲目</span><span id="selected-clearance">等待导入</span></div><button class="read-file" data-action="open">PLAY TRACK <span>→</span></button></div>
    <div id="hover-label" class="hover-label" hidden>X-<span id="hover-code">001</span> / <span id="hover-title"></span></div>
    <div class="archive-counter"><span class="tiny-label">TRACK / SELECT</span><div><span id="selected-number">01</span><i>/</i><span class="count-total">12</span></div></div>
    <div class="archive-navigation"><button data-action="prev" aria-label="上一个曲目">↑</button><div id="file-ticks" class="file-ticks"></div><button data-action="next" aria-label="下一个曲目">↓</button></div>
    <div class="column-navigation"><button data-action="column-prev" aria-label="上一组">←</button><div><span id="column-number">GROUP <span id="column-index">03</span> / 05</span><strong id="column-name">音乐档案</strong></div><button data-action="column-next" aria-label="下一组">→</button></div>
    <div class="archive-hint"><kbd>←</kbd> <kbd>→</kbd> 切换分组 <span>／</span> <kbd>↑</kbd> <kbd>↓</kbd> 前后曲目 <span>／</span> <kbd>ENTER</kbd> 读取</div>
  </section>
  <section id="detail-ui" class="detail-ui" aria-label="档案内容" hidden>
    <button class="back-button" data-action="back">← <span>TRACK OVERVIEW</span><small>ESC</small></button>
    <div class="object-caption"><span id="object-id">NO.001</span><div>INTERNAL DATABASE</div><small>DRAG TO INSPECT <span>↔</span></small><button class="viewer-open" data-action="model-viewer">360° 查看文档模型 <span>↗</span></button></div>
    <article id="detail-content" class="detail-content"></article>
  </section>
  <div class="powered">POWERED BY <b>RHINE LAB</b><i></i></div>
  <footer class="system-footer"><span><i class="status-light"></i> SESSION AUTHORIZED</span><span><span class="operator-name">${getOperator()}</span> <i>／</i> <span id="clock">00:00:00</span></span><button data-action="replay" title="重播启动流程">REINITIALIZE ↗</button></footer>
  <div id="modal-root"></div><div id="toast" class="toast" role="status"></div>
  <div id="loading" class="loading"><div class="loading-mark">${logo}</div><span>CONNECTING TO INTERNAL DATABASE</span><i></i></div>
`;

$("#boot-background").insertAdjacentHTML(
  "beforeend",
  '<div class="boot-white"></div>',
);
const bootSequence = new BootSequence($("#stage"));

type Mode = "boot" | "archive" | "detail";
let mode: Mode = "boot",
  selected = 0,
  bootOrigin = 0,
  bootApp0 = 0,
  lastStep = "",
  ready = false;
let modal: "search" | "saved" | "settings" | null = null,
  searchQuery = "",
  filter = categories[0];
const reviewParams = new URLSearchParams(location.search);
let frozenTime =
  reviewParams.get("freeze") === "1"
    ? Number(reviewParams.get("time") ?? 0)
    : null;
if (reviewParams.get("review") === "1") {
  $("#stage").dataset.review = "true";
  window.addEventListener("message", (event) => {
    if (
      event.origin !== location.origin ||
      event.source !== window.parent ||
      event.data?.type !== "rhine-review-frame"
    )
      return;
    const t = Number(event.data.time);
    if (!Number.isFinite(t) || t < 0 || t >= 35) return;
    frozenTime = t;
    if (ready && mode !== "boot") setMode("boot");
  });
}
let toastTimer: ReturnType<typeof setTimeout>;
let previousFocus: HTMLElement | null = null;
const detailTransition = new SurfaceTransition($("#detail-ui"), undefined, 180, 180);
const tabTransition = new ContentTransition();
let modalTransition: SurfaceTransition | undefined;
let modalClosing = false;
/* 收尾兜底的计时器与"关完之后要做什么"：关弹窗必须一定会收尾，
   所以把待执行的回调存下来，由 finishModalClose 统一执行（见那里的注释）。 */
let modalCloseTimer: number | undefined;
let pendingModalClose: (() => void) | undefined;
let modalSiblings: { node: HTMLElement; inert: boolean }[] = [];
let pendingDetailFocus = false;
let bookmarkFeedback: Animation | undefined;
function readLocal<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
}
/* 收藏以播放器曲目的 fav 字段为准（saved-count 也按它统计）。 */
const storedPrefs = readLocal<Partial<{ sound: boolean; music: boolean; soundVolume: number; musicVolume: number; reduced: boolean; quality: boolean; rendering: RenderQuality }>>("rhine-settings", {});
const prefs = {
  sound: true,
  music: storedPrefs.sound ?? true,
  soundVolume: .55,
  musicVolume: .5,
  reduced: matchMedia("(prefers-reduced-motion: reduce)").matches,
  quality: true,
  ...storedPrefs,
  rendering: normalizeQuality(storedPrefs.rendering, storedPrefs.quality !== false),
};
const rollingMotion = {
  duration: 460,
  motionBlur: true,
  animated: !prefs.reduced,
};
const numberOptions = {
  ...rollingMotion,
  locales: "en-US",
  format: { minimumIntegerDigits: 2, useGrouping: false },
};
const fileCounter = createRollingNumber($("#selected-number"), {
  ...numberOptions,
  value: 1,
});
const columnCounter = createRollingNumber($("#column-index"), {
  ...numberOptions,
  value: 3,
});
const codeOptions = {
  ...numberOptions,
  format: { minimumIntegerDigits: 3, useGrouping: false },
  value: 1,
};
const textOptions = {
  ...rollingMotion,
  transition: "direct" as const,
  stagger: "none" as const,
};
const selectionTitle = createRollingText($("#selected-title"), {
  ...textOptions,
  text: $("#selected-title").textContent ?? "",
});
const columnTitle = createRollingText($("#column-name"), {
  ...textOptions,
  text: $("#column-name").textContent ?? "",
});
const hoverTitle = createRollingText($("#hover-title"), { ...textOptions, text: "" });
const categoryTitle = createRollingText($("#archive-category"), {
  ...textOptions,
  text: $("#archive-category").textContent ?? "",
});
const clearanceTitle = createRollingText($("#selected-clearance"), {
  ...textOptions,
  text: $("#selected-clearance").textContent ?? "",
});
const rollingTitles = [selectionTitle, columnTitle, hoverTitle, categoryTitle, clearanceTitle];
const selectedCode = createRollingNumber($("#selected-code"), codeOptions);
const hoverCode = createRollingNumber($("#hover-code"), codeOptions);
const audio = new TerminalAudio();
audio.configure(prefs);
let audioPreview = false, audioPreviewRequest = 0;
let scene: ArchiveScene;
/* scene 是模块末尾才 new 出来的，而 updateSelection() 在模块加载期就会被调用一次；
   用它挡一下，避免在三维场景就绪前访问 scene。 */
let sceneReady = false;
let viewer: ModelViewer | undefined;
const accessLog: { id: string; time: string }[] = [];
let columnMemory: (number | undefined)[] = archiveColumns.map((_, lane) => columnFiles(lane)[0]);
function recordAccess() {
  accessLog.unshift({
    id: records[selected].id,
    time: new Date().toLocaleTimeString("en-GB"),
  });
}
function saveAudioPrefs() {
  try {
    localStorage.setItem("rhine-settings", JSON.stringify(prefs));
  } catch {}
  audio.configure(prefs);
}
function savePrefs() {
  saveAudioPrefs();
  if (prefs.reduced) {
    rollingTitles.forEach(title => title.finish());
    detailTransition.finish();
    modalTransition?.finish();
    tabTransition.cancel();
    bookmarkFeedback?.cancel();
  }
  scene?.setReduced(prefs.reduced);
  scene?.setQuality(prefs.rendering);
  viewer?.setQuality(prefs.rendering);
  syncQualityUI(prefs.rendering);
  updateQualitySummary();
  fileCounter.update({ animated: !prefs.reduced && mode === "archive" });
  rollingTitles.forEach(title => title.update({ animated: !prefs.reduced && mode === "archive" }));
  columnCounter.update({ animated: !prefs.reduced && mode === "archive" });
  selectedCode.update({ animated: !prefs.reduced && mode === "archive" });
  hoverCode.update({ animated: !prefs.reduced && mode === "archive" });
  $("#stage").classList.toggle("reduce-motion", prefs.reduced);
}
/* 等比适应窗口，但允许一点横向"过扫描"，把上下那两条空带收窄。
   contain（Math.min）在比 16:9 更高的窗口上会在上下各留一条空带（默认 1380×920 就是各 72px），
   用户看到的就是"顶部和底端太空、界面没有上下拉开"。改成：
     · 纵向按高度装得下 —— 上下永不裁切，空带归零；
     · 横向最多裁掉 SAFE_CROP=40 基准像素/侧（≈4% 宽）：播放条左边距是 59，
       左右两侧的文字与面板也都在 40 以外，所以不会裁到有用内容；
     · 再留一个 1.2 倍上限，窄窗口里不至于放大过头。
   实测（默认窗口 1380×920）：旧 scale 0.7188 → 上下各空 72px；
   新 scale 0.75 → 空带各 55px，横向各裁 30 屏幕像素（= 40 基准像素）。 */
const SAFE_CROP = 40;
const MAX_OVERSCAN = 1.2;
function fit() {
  const contain = Math.min(innerWidth / 1920, innerHeight / 1080);
  const scale = Math.min(innerHeight / 1080, innerWidth / (1920 - SAFE_CROP * 2), contain * MAX_OVERSCAN);
  /* 实际裁掉多少（换算成 1920 基准像素），交给 CSS：
     贴右边缘的面板（.archive-callout 从 970 一直到 1920）会按这个值补一条右内边距，
     免得它右侧的文字被裁掉。16:9 的窗口上这个值是 0，参考版式一点不动。 */
  const crop = Math.max(0, Math.round((1920 * scale - innerWidth) / 2 / scale));
  $("#stage").style.transform = `translate(-50%, -50%) scale(${scale})`;
  $("#stage").style.setProperty("--edge-crop", crop + "px");
  $("#viewport").style.setProperty("--scale", String(scale));
  scene?.resize();
  viewer?.resize();
  updateQualitySummary();
}
window.addEventListener("resize", fit);
fit();
let fileTicks: HTMLButtonElement[] = [];
function rebuildTicks() {
  $("#file-ticks").innerHTML = columnFiles(fileLocation(selected).lane)
    .map(
      (index) => `<button data-select="${index}"></button>`,
    )
    .join("");
  fileTicks = [...$("#file-ticks").querySelectorAll<HTMLButtonElement>("button")];
}
/* 音乐库变化（导入/删除）后：重排档案阵列数据、刷新刻度与选中态、重绘详情。 */
function refreshArchive() {
  if (!records.length) selected = 0;
  else selected = Math.min(selected, records.length - 1);
  columnMemory = archiveColumns.map((_, lane) => columnFiles(lane)[0]);
  rebuildTicks();
  updateSelection();
  if (mode === "detail") renderDetail();
}
onLibraryChange(refreshArchive);
rebuildTicks();

/* 把终端的选中态挪到第 index 份档案：刻度、文字与**三维阵列**一起走。
   换歌（rhine-track）与"起播即打开档案"（rhine-open-track）都走这里，
   免得两处各写一份、还漏掉阵列那一步。 */
function focusArchive(index: number) {
  selected = index;
  columnMemory[fileLocation(selected).lane] = selected;
  rebuildTicks();
  /* ★ 三维阵列必须一起走 —— 这一步以前漏了：换歌只刷了刻度与文字，
     左边那张卡片原地不动，于是"换歌"没有换来档案的升降与波浪动画
     （用户反馈的"没有做到换歌的同时切换档案的动画"）。
     scene.select() 负责抬起新卡片 / 归位旧卡片 / 发出波浪与脉冲；
     不传方向时它取"最近的那一份"，正是"从当前这张换成那一张"的最短一条路。 */
  scene?.select(selected);
  updateSelection();
}

/* 正在播放的曲目变化：三维档案阵列与右侧详情一起跟过去，保持一致 */
window.addEventListener("rhine-track", (event) => {
  const index = Number((event as CustomEvent).detail);
  /* ★ 必须同时确认 records 里有这一条：启动时"恢复上次播放的曲目"会在曲库刚读完、
     而档案记录还没重建的那一瞬间派发这个事件，此时 records 还是空的 ——
     直接往下走会去读 records[i].title 而抛 TypeError，整个启动流程就断在这里。 */
  if (!Number.isFinite(index) || !getSongs().length || !records[index]) return;
  if (index === selected) return;
  focusArchive(index);
  if (mode === "detail") renderDetail();
});
/* 歌词由 player.ts 自己维护：详情区只有一行"当前歌词"字幕，不需要终端重绘 */

/* 起播时把"这首歌的档案"打开（播放器里的 openOnPlay，默认开）。
   ★ 用户要求：点开某首歌就要打开它的档案，无论入口是列表里点一行、
     还是按档案上的播放 —— 播放器两个入口都派发同一件事，这里统一处理。 */
window.addEventListener("rhine-open-track", (event) => {
  const index = Number((event as CustomEvent).detail);
  /* 和 rhine-track 同样的保护：曲库刚读完、档案记录还没重建的那一瞬间不能读 records[i]。
     开屏 / 弹窗 / 编辑态 / 360° 查看器各自占着画面，也不去抢。 */
  if (!Number.isFinite(index) || !getSongs().length || !records[index]) return;
  if (!ready || mode === "boot" || modal || modalClosing || editing || viewer?.isOpen) return;
  const changed = index !== selected;
  if (changed) focusArchive(index);
  if (mode === "detail") {
    /* 已经在详情里就只把内容换成这一首（换歌时才有必要重绘，避免白放一次解密动画） */
    if (changed) renderDetail();
    return;
  }
  setMode("detail");
  audio.play("open");
});

function setMode(next: Mode) {
  const previousMode = mode;
  rollingTitles.forEach(title => title.update({ animated: !prefs.reduced && next === "archive" }));
  if (next !== "archive") {
    rollingTitles.forEach(title => title.finish());
    hoverCode.finish();
    $("#hover-label").hidden = true;
  }
  if (next === "detail" && mode !== "detail") recordAccess();
  mode = next;
  audio.setScene(next);
  if (next !== "boot" && audioPreview) {
    audioPreview = false;
    audioPreviewRequest++;
    audio.configure(prefs);
  }
  $("#stage").dataset.mode = next;
  $("#boot").inert = next !== "boot";
  $("#boot").setAttribute("aria-hidden", String(next !== "boot"));
  $("#archive-ui").inert = next !== "archive" || Boolean(modal);
  $("#archive-ui").setAttribute("aria-hidden", String(next !== "archive"));
  $(".system-nav").inert = next === "boot" || Boolean(modal);
  $(".system-footer").inert = next === "boot" || Boolean(modal);
  if (next === "detail") {
    if (previousMode !== "detail") detailTransition.show(prefs.reduced);
  } else if (previousMode === "detail" || (next === "boot" && !$("#detail-ui").hidden)) {
    pendingDetailFocus = false;
    tabTransition.cancel();
    detailTransition.hide(prefs.reduced || next === "boot");
    if (!modal && next === "archive") $(".read-file").focus({ preventScroll: true });
  }
  $("#detail-ui").inert = next !== "detail" || Boolean(modal);
  scene?.setMode(next === "boot" ? "hidden" : next);
  if (next !== "boot") {
    bootSequence.reset();
    $(".file-title").firstChild!.textContent = "TRACK NUMBER: ";
    $("#stage").dataset.boot = "done";
    $("#cinema-caption").textContent = "";
  }
  if (next === "detail" && previousMode !== "detail") {
    renderDetail();
    pendingDetailFocus = true;
  }
}
function select(index: number, navigation?: ArchiveNavigation) {
  selected = (index + records.length) % records.length;
  columnMemory[fileLocation(selected).lane] = selected;
  if (mode === "detail") setMode("archive");
  scene?.select(selected, navigation);
  updateSelection(navigation);
  const columnMove = navigation && "axis" in navigation && navigation.axis === "lane";
  audio.play(columnMove ? "column" : "tick", columnMove ? navigation.direction * .45 : 0);
}
function stepFile(direction: number) {
  const files = columnFiles(fileLocation(selected).lane);
  if (files.length < 2) return;
  select(
    files[(files.indexOf(selected) + direction + files.length) % files.length],
    { axis: "row", direction },
  );
}
function stepColumn(direction: number) {
  const lane = fileLocation(selected).lane;
  const next = wrap(lane + direction, archiveColumns.length);
  select(columnMemory[next] ?? 0, { axis: "lane", direction });
}
function updateSelection(navigation?: ArchiveNavigation) {
  const r = records[selected];
  const { lane } = fileLocation(selected);
  const files = columnFiles(lane);
  syncCover();
  selectionTitle.update({ text: r.title, animated: !prefs.reduced && mode === "archive" });
  clearanceTitle.update({ text: r.clearance, animated: !prefs.reduced && mode === "archive" });
  categoryTitle.update({ text: r.category, animated: !prefs.reduced && mode === "archive" });
  const direction =
    navigation && "axis" in navigation
      ? navigation.direction > 0
        ? "up"
        : "down"
      : "auto";
  selectedCode.update({
    value: Number(r.id.slice(2)),
    animated: !prefs.reduced && mode === "archive",
    direction,
  });
  fileCounter.update({
    value: files.indexOf(selected) + 1,
    animated: !prefs.reduced && mode === "archive",
    direction:
      navigation && "axis" in navigation && navigation.axis === "row"
        ? direction
        : "auto",
  });
  $(".count-total").textContent = String(files.length).padStart(2, "0");
  columnCounter.update({
    value: lane + 1,
    animated: !prefs.reduced && mode === "archive",
    direction:
      navigation && "axis" in navigation && navigation.axis === "lane"
        ? direction
        : "auto",
  });
  columnTitle.update({ text: archiveColumns[lane], animated: !prefs.reduced && mode === "archive" });
  $<HTMLButtonElement>('[data-action="column-prev"]').disabled = false;
  $<HTMLButtonElement>('[data-action="column-next"]').disabled = false;
  fileTicks.forEach((button, slot) => {
    const index = files[slot], record = records[index];
    button.dataset.select = String(index);
    button.setAttribute("aria-label", `选择档案 ${record.id} ${record.title}`);
    button.title = `${record.id} · ${record.title}`;
    button.classList.toggle("selected", index === selected);
    button.setAttribute("aria-pressed", String(index === selected));
  });
  // 收藏计数 = 播放器里的收藏曲目数（不再是档案收藏集合）
  $("#saved-count").textContent = String(getSongs().filter((s) => s.fav).length).padStart(2, "0");
}
function replayBoot(forcePreview = false) {
  if (!ready) return;
  closeModal(() => replayBootAfterModal(forcePreview));
}
function replayBootAfterModal(forcePreview: boolean) {
  bootOrigin = performance.now() / 1000;
  bootApp0 = BOOT_START_APP;
  bootSpeed = BOOT_SPEED;
  frozenTime = null;
  lastStep = "";
  setMode(prefs.reduced && !forcePreview ? "archive" : "boot");
  audio.restartBoot();
  /* 重播开屏同样停在**当前这一首**的档案上：开屏结束时镜头推进的是这一档，
     拉回第 0 档的话又会和播放条上的曲目对不上（与启动时同一处坑）。 */
  select(currentIndex() >= 0 ? currentIndex() : 0);
  if (!forcePreview) audio.play("ui-tick");
}
function openFile() {
  if (!ready) return;
  /* 回车 / 点击只"读取档案"（进详情），**不自动播放** —— 起播交给用户：
     按播放键、点播放列表里的一行，或者按空格。 */
  closeModal(() => {
    /* ★ 打开档案时把播放器切到这一首（**不自动播放**）：
       否则右侧详情写的是这一档案的歌曲信息，播放条与频谱还在另一首上 ——
       用户反馈的"档案打开，右侧出现该档案的歌曲信息但和正在播放的不符"。 */
    focusTrack(selected);
    setMode("detail");
    audio.play("open");
  });
}
function renderDetail() {
  tabTransition.cancel();
  $("#object-id").textContent = "NO." + String(selected + 1).padStart(3, "0");
  // 右侧这一栏就是曲目面板：封面 / 曲目信息 / 大尺寸实时频谱 / 当前歌词字幕。
  // 页签（曲目·歌词·播放记录）已按用户要求删掉，那一块竖向空间全部让给可视化。
  // 空库时用同一套版式的占位态，界面上不出现"科室 / 编目范围 / 相关人物"这类档案词条。
  const content = $("#detail-content");
  content.classList.add("song-mode");
  if (editing) {
    /* 编辑态：不重放解密动画（否则每敲一次都盖一层），只换内容挂事件 */
    content.classList.add("edit-mode");
    content.innerHTML = songEditMarkup(selected);
    content.setAttribute("tabindex", "-1");
    mountSongEdit(content);
    return;
  }
  content.classList.remove("edit-mode");
  content.innerHTML = songDetailMarkup(selected);
  content.setAttribute("tabindex", "-1");
  documentDecryption.reset(content, prefs.reduced || scene.decryptionFrame.phase === "clear");
  mountSongDetail(content);
}
/* ---------- 歌曲信息编辑：进入 / 保存 / 放弃 ----------
   编辑态只是一个开关，真正的表单由 player.ts 出（它才拿得到曲库里的那一条）。
   保存后要顺手把"档案阵列 + 三维封面板 + 播放条"一起刷新，否则改了标题只有详情区变。 */
let editing = false;
function startEditing() {
  if (editing || !hasSongs()) return;
  editing = true;
  renderDetail();
  audio.play("page-open");
  requestAnimationFrame(() => {
    document.querySelector<HTMLInputElement>("#p-edit-title")?.focus({ preventScroll: true });
  });
}
function stopEditing(save: boolean) {
  if (!editing) return;
  editing = false;
  if (save) {
    const r = applySongEdit();
    notify(r.message);
    audio.play(r.ok ? "confirm" : "back");
  } else {
    audio.play("back");
  }
  refreshArchive();
  syncCover();
  renderDetail();
}
/** 封面变了：三维模型正面那块标签板与详情区都换掉 */
window.addEventListener("rhine-cover", () => {
  refreshArchive();
  syncCover();
  if (mode === "detail" && !editing) renderDetail();
});
/** 把当前选中曲目的封面与信息交给三维场景，印到左边那块文档模型的正面标签板上。 */
function syncCover() {
  if (!sceneReady) return;
  const song = getSongs()[selected];
  scene.setCover(song?.cover ?? null, {
    no: String(selected + 1).padStart(3, "0"),
    title: song?.title ?? "尚无曲目",
    artist: song?.artist ?? "音乐库为空",
    album: song?.album ?? "把音乐文件拖进窗口，或按播放条上的 ＋ 导入",
  });
}
function notify(message: string) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").classList.add("visible");
  toastTimer = setTimeout(() => $("#toast").classList.remove("visible"), 2600);
}

function openModal(kind: NonNullable<typeof modal>) {
  if (!ready) return;
  if (!modal) {
    previousFocus = document.activeElement as HTMLElement;
    modalSiblings = [...$("#stage").children]
      .filter((node): node is HTMLElement => node instanceof HTMLElement && node.id !== "modal-root")
      .map((node) => ({ node, inert: node.inert }));
    modalSiblings.forEach(({ node }) => (node.inert = true));
  }
  modalClosing = false;
  modal = kind;
  searchQuery = "";
  filter = categories[0];
  audio.play("page-open");
  renderModal();
}
function closeModal(afterClose?: () => void) {
  if (afterClose) {
    const previous = pendingModalClose;
    pendingModalClose = previous ? () => (previous(), afterClose()) : afterClose;
  }
  if (!modal) {
    const run = pendingModalClose;
    pendingModalClose = undefined;
    run?.();
    return;
  }
  if (!modalClosing) {
    modalClosing = true;
    audio.play("page-close");
    modalTransition!.hide(prefs.reduced, finishModalClose);
  }
  /* ★ 兜底：退场动画没跑完（被下一次 renderModal 的 dispose() 顶掉、
     动画时间轴停住、或干脆没起来）也要收尾。少了这一步，modalClosing 会永远
     停在 true —— 之后 keydown 里那句 `if (modalClosing) return;` 会把所有按键
     整轮吞掉，弹窗节点也一直留着把整机 inert 住，用户看到的就是
     "回车失灵、档案 / 播放条全点不动"，只能重开程序。 */
  window.clearTimeout(modalCloseTimer);
  modalCloseTimer = window.setTimeout(finishModalClose, 620);
}
/** 收尾（幂等）：恢复被弹窗按住的节点、清掉节点、执行关完之后的动作。 */
function finishModalClose() {
  window.clearTimeout(modalCloseTimer);
  modalCloseTimer = undefined;
  if (!modalClosing) return;
  modalClosing = false;
  modal = null;
  $("#modal-root").replaceChildren();
  modalTransition = undefined;
  modalSiblings.forEach(({ node, inert }) => (node.inert = inert));
  modalSiblings = [];
  $("#archive-ui").inert = mode !== "archive";
  $("#detail-ui").inert = mode !== "detail";
  previousFocus?.focus({ preventScroll: true });
  const run = pendingModalClose;
  pendingModalClose = undefined;
  run?.();
}
function renderModal() {
  if (!modal) return;
  modalTransition?.dispose();
  $("#modal-root").innerHTML =
    `<div class="modal-backdrop"><section class="terminal-modal ${modal === "settings" ? "settings-modal" : ""}" role="dialog" aria-modal="true" aria-label="${modal === "settings" ? "系统设置" : modal === "saved" ? "收藏曲目" : "曲目检索"}"><div class="modal-top"><span>RHINE LAB / ${modal === "settings" ? "SYSTEM PREFERENCES" : "TRACK DIRECTORY"}</span><button data-action="close-modal" aria-label="关闭窗口">CLOSE <span>×</span></button></div>${modal === "settings" ? settingsMarkup() : `<h2>${modal === "saved" ? "SAVED TRACKS" : "TRACK INDEX"}<small>${modal === "saved" ? "收藏曲目" : "音乐库检索"}</small></h2><div class="search-field"><span>⌕</span><input id="archive-search" type="search" autocomplete="off" placeholder="输入曲名、艺术家或专辑" aria-label="检索曲目"/><span class="key">ESC</span></div><div class="category-filters">${categories.map((c, i) => `<button data-filter="${escapeHtml(c)}" class="${c === filter ? "active" : ""}">${escapeHtml(c)}</button>`).join("")}</div><div class="result-header"><span>TRACK / 曲目</span><span>ARTIST / 艺术家</span><span>LENGTH / 时长</span></div><div id="search-results" class="search-results"></div><div class="modal-bottom"><span id="result-count"></span><span>INTERNAL DATABASE <i>●</i> CONNECTED</span></div>`}</section></div>`;
  const backdrop = $(".modal-backdrop");
  backdrop.hidden = true;
  modalTransition = new SurfaceTransition(backdrop, $(".terminal-modal"));
  modalTransition.show(prefs.reduced);
  if (modal === "settings") updateQualitySummary();
  if (modal !== "settings") {
    renderResults();
    requestAnimationFrame(() => {
      if (backdrop.isConnected && !modalClosing) $("#archive-search").focus();
    });
  } else
    requestAnimationFrame(() => {
      if (backdrop.isConnected && !modalClosing) $('[data-action="close-modal"]').focus();
    });
  $("#modal-root")
    .querySelector(".modal-backdrop")
    ?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) closeModal();
    });
}
function renderResults() {
  // 收藏弹窗列的是播放器里收藏过的曲目（不再是独立的档案收藏集合）
  const favIndexes = new Set<number>();
  getSongs().forEach((song, i) => {
    if (song.fav) favIndexes.add(i);
  });
  const results = records
    .map((r, i) => ({ r, i }))
    .filter(
      ({ r, i }) =>
        (modal !== "saved" || favIndexes.has(i)) &&
        (filter === categories[0] || r.category === filter) &&
        `${r.id} ${r.title} ${r.en} ${r.department} ${r.lead}`
          .toLowerCase()
          .includes(searchQuery.toLowerCase()),
    );
  $("#search-results").innerHTML = results.length
    ? results
        .map(
          ({ r, i }) =>
            `<button class="result-row" data-result="${i}"><span class="result-name"><b>${r.id}</b><span>${escapeHtml(r.title)}<small>${escapeHtml(r.en)}</small></span>${favIndexes.has(i) ? "<i>＋</i>" : ""}</span><span>${escapeHtml(r.department)}</span><span>${escapeHtml(r.date)} <i>↗</i></span></button>`,
        )
        .join("")
    : `<div class="empty-results"><span>∅</span><strong>${modal === "saved" && !searchQuery ? "尚无收藏曲目" : "没有匹配的曲目"}</strong><p>${modal === "saved" && !searchQuery ? "在曲目面板上点「＋ SAVE TRACK」，或在播放条上点 ♡ 收藏曲目，会出现在这里。" : "换个曲名、艺术家或专辑再试，也可以切换分组筛选。"}</p><button data-action="reset-search">${modal === "saved" ? "查看全部曲目 →" : "重置检索 →"}</button></div>`;
  $("#result-count").textContent = `${String(results.length).padStart(2, "0")} TRACKS FOUND`;
}
function updateQualitySummary() {
  const summary = document.querySelector("#quality-summary");
  if (!summary || !scene) return;
  const canvas = scene.renderer.domElement;
  const metrics = JSON.parse(canvas.parentElement?.dataset.renderQuality ?? "{}");
  summary.textContent = `实际渲染 ${canvas.width} × ${canvas.height} · ${prefs.rendering.antialias === "smaa" ? "SMAA" : "原始抗锯齿"} · 纹理 ${metrics.anisotropy ?? 1}×${metrics.limited ? " · 已达到缓冲上限" : ""}`;
}
function settingsMarkup() {
  return `<h2>SYSTEM SETTINGS<small>终端偏好设置</small></h2><p class="settings-intro"><span class="operator-name">${getOperator()}</span> <span>·</span> SESSION AUTHORIZED</p><div class="settings-list"><label class="operator-field" for="operator-input"><div><strong>OPERATOR ID</strong><span>开屏「ID CONFIRMED」与页脚显示的身份标识</span></div><input type="text" id="operator-input" maxlength="40" value="${escapeHtml(getOperator())}" autocomplete="off" spellcheck="false"/></label>${audioSettingsMarkup(prefs)}<label><div><strong>REDUCED MOTION</strong><span>减少镜头移动和过渡动效</span></div><input type="checkbox" data-pref="reduced" ${prefs.reduced ? "checked" : ""}/><i class="toggle"></i></label>${playbackSettingsMarkup()}</div>${qualityMarkup(prefs.rendering)}<div class="settings-shortcuts"><span>KEYBOARD CONTROLS</span><p><kbd>←</kbd><kbd>→</kbd> 切列 <kbd>↑</kbd><kbd>↓</kbd> 选档 <kbd>ENTER</kbd> 读取 <kbd>/</kbd> 检索 <kbd>ESC</kbd> 返回</p></div><div class="settings-bottom"><button data-action="fullscreen">FULLSCREEN <span>↗</span></button><button data-action="restart">REINITIALIZE SYSTEM <span>↻</span></button></div><div class="modal-bottom"><span>ANALYSIS OS / 1.0 · 使用 MiSans 字体（小米） <a href="/fonts/MiSans-license.pdf" target="_blank" rel="noopener">字体许可</a></span><span>POWERED BY RHINE LAB</span></div>`;
}

document.addEventListener("input", (e) => {
  const slider = e.target as HTMLInputElement;
  if (slider.dataset.quality) {
    const output = document.querySelector<HTMLOutputElement>(`[data-quality-output="${slider.dataset.quality}"]`);
    if (output) output.value = `${slider.value}%`;
  }
  const volume = e.target as HTMLInputElement;
  if (volume.dataset.volume === "musicVolume" || volume.dataset.volume === "soundVolume") {
    prefs[volume.dataset.volume] = Number(volume.value) / 100;
    volume.closest("label")?.querySelector("output")?.replaceChildren(`${volume.value}%`);
    saveAudioPrefs();
  }
  if ((e.target as HTMLElement).id === "archive-search") {
    searchQuery = (e.target as HTMLInputElement).value;
    renderResults();
  }
  if ((e.target as HTMLElement).id === "operator-input") {
    const name = setOperator((e.target as HTMLInputElement).value);
    document
      .querySelectorAll<HTMLElement>(".operator-name")
      .forEach((el) => (el.textContent = name));
  }
});
document.addEventListener("change", (e) => {
  const el = e.target as HTMLInputElement;
  /* 播放行为三项（记住进度 / 启动恢复 / 起播开档案）由播放器自己收口：
     关掉"记住进度"时它还要把已经存下来的进度清一遍，不是简单写个偏好就完事。 */
  if (el.dataset.playpref) {
    setPlaybackPref(el.dataset.playpref as keyof PlaybackPrefs, el.checked);
    audio.play("confirm");
    return;
  }
  if (el.id === "quality-preset" && Object.hasOwn(qualityPresets, el.value)) {
    prefs.rendering = { ...qualityPresets[el.value as QualityPreset] };
    savePrefs();
  } else if (el.dataset.quality) {
    const key = el.dataset.quality as keyof RenderQuality;
    prefs.rendering = normalizeQuality({ ...prefs.rendering, [key]: key === "antialias" ? el.value : Number(el.value) });
    savePrefs();
  }
  if (el.dataset.pref) {
    const key = el.dataset.pref;
    if (key === "sound" || key === "music" || key === "reduced" || key === "quality") prefs[key] = el.checked;
    if (key === "sound" || key === "music") saveAudioPrefs(); else savePrefs();
    audio.play("confirm");
  }
});
document.addEventListener("click", (e) => {
  if (modalClosing) return;
  const el = (e.target as Element).closest<HTMLElement>("button");
  if (!el) return;
  if (el.dataset.select) {
    select(Number(el.dataset.select));
    return;
  }
  if (el.dataset.result) {
    const index = Number(el.dataset.result);
    closeModal(() => {
      select(index);
      openFile();
    });
    return;
  }
  if (el.dataset.filter) {
    filter = el.dataset.filter;
    document
      .querySelectorAll("[data-filter]")
      .forEach((b) =>
        b.classList.toggle(
          "active",
          (b as HTMLElement).dataset.filter === filter,
        ),
      );
    renderResults();
    return;
  }
  const action = el.dataset.action;
  if (action === "sound-preview") audio.play("confirm");
  if (action === "skip") {
    setMode("archive");
    audio.play("confirm");
  }
  if (action === "prev") stepFile(-1);
  if (action === "next") stepFile(1);
  if (action === "column-prev") stepColumn(-1);
  if (action === "column-next") stepColumn(1);
  if (action === "open") openFile();
  if (action === "model-viewer" && mode === "detail") {
    viewer ??= new ModelViewer($("#stage"), () => { audio.setScene(mode); audio.play("page-close"); }, (sound) => audio.play(sound === "tick" ? "ui-tick" : sound));
    audio.setScene("viewer");
    viewer.setQuality(prefs.rendering);
    scene.finishDecryption();
    viewer.open(
      records[selected].id,
      records[selected].title,
      () => scene.createAssemblyModel(),
      prefs.reduced,
    );
    audio.play("page-open");
  }
  if (action === "back") {
    setMode("archive");
    audio.play("back");
  }
  if (action === "search" || action === "saved" || action === "settings")
    openModal(action);
  if (action === "close-modal") closeModal();
  if (action === "fav-track") {
    toggleFavAt(selected);
    const song = songAt(selected);
    const button = document.querySelector<HTMLButtonElement>('[data-action="fav-track"]');
    if (song && button) {
      button.firstChild!.textContent = song.fav ? "− REMOVE FROM SAVED" : "＋ SAVE TRACK";
      button.querySelector("span")!.textContent = song.fav ? "♥ 已收藏" : "♡ 收藏曲目";
      button.setAttribute("aria-pressed", String(song.fav));
      if (!prefs.reduced)
        bookmarkFeedback = button.animate(
          [{ backgroundColor: "#67634c" }, { backgroundColor: "#252820" }],
          { duration: 220, easing: "ease-out" },
        );
      audio.play("confirm");
    }
  }
  if (action === "import-music") importFiles();
  if (action === "play-now") togglePlay();
  if (action === "edit-track") startEditing();
  if (action === "edit-save") stopEditing(true);
  if (action === "edit-cancel") stopEditing(false);
  if (action === "reset-search") {
    modal = "search";
    searchQuery = "";
    filter = categories[0];
    renderModal();
  }
  if (action === "replay" || action === "restart") {
    replayBoot();
  }
  if (action === "fullscreen") {
    if (document.fullscreenElement) void document.exitFullscreen();
    else
      void document.documentElement
        .requestFullscreen()
        .catch(() => notify("请使用浏览器的全屏快捷键 F11"));
  }
});
/* 「正在打字」的判定：只有真的会吃掉字符的控件才算 —— 输入框（不含 range / checkbox
   这类没有文本的 input）、文本域、下拉框、可编辑区。
   ★ 旧写法是 `e.target instanceof HTMLInputElement`，于是进度条与音量条
     （都是 input[type=range]）也被当成"正在打字"：拖过一次进度条之后焦点就停在它上面，
     之后快捷键（回车、方向键、/）整轮失效 —— 用户反馈的"回车键有时候会失灵"就是这么来的。 */
const TEXTUAL_INPUT = new Set([
  "", "text", "search", "url", "tel", "email", "password", "number",
  "date", "datetime-local", "month", "week", "time",
]);
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target instanceof Element ? target : null;
  const field = el?.closest(
    "input, textarea, select, [contenteditable=''], [contenteditable='true']",
  ) as HTMLElement | null;
  if (!field) return false;
  if (field instanceof HTMLInputElement) return TEXTUAL_INPUT.has(field.type);
  return true;
}
document.addEventListener("keydown", (e) => {
  if (viewer?.isOpen) return;
  if (modalClosing) {
    e.preventDefault();
    return;
  }
  const typing = isTypingTarget(e.target);
  if (e.key === "Escape") {
    if (modal) closeModal();
    /* 编辑态优先：ESC 收起编辑面板回到曲目详情，而不是退出详情 */
    else if (editing && mode === "detail") stopEditing(false);
    else if (mode === "detail" || (mode === "boot" && ready)) { const sound = mode === "detail" ? "back" : "ui-tick"; setMode("archive"); audio.play(sound); }
    return;
  }
  if (modal && e.key === "Tab") {
    const focusables = [
      ...$("#modal-root").querySelectorAll<HTMLElement>(
        'button,input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]',
      ),
    ];
    const visible = focusables.filter(el => el.getClientRects().length > 0);
    const first = visible[0],
      last = visible.at(-1);
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last?.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first?.focus();
    }
    return;
  }
  if (typing || modal || !ready) return;
  if (e.key === "/") {
    e.preventDefault();
    if (mode === "boot") setMode("archive");
    openModal("search");
  }
  if (e.key === "ArrowLeft" && mode !== "boot") {
    e.preventDefault();
    stepColumn(-1);
  }
  if (e.key === "ArrowRight" && mode !== "boot") {
    e.preventDefault();
    stepColumn(1);
  }
  if (["ArrowUp", "ArrowDown"].includes(e.key) && mode !== "boot") {
    e.preventDefault();
    stepFile(e.key === "ArrowUp" ? -1 : 1);
  }
  /* ★ 回车 = 当前这一层的主操作，不再依赖一份"焦点必须在哪儿"的白名单。
     旧写法只认 body / 详情面板 / 上一首下一首 / 档案刻度四种焦点，
     焦点一在别处（最典型的就是刚拖过进度条，activeElement 停在 input[type=range] 上）
     回车就整轮没有反应 —— "回车键有时候会失灵"指的就是它。
     现在：
       · 焦点在别的按钮 / 链接上 → 回车就是"按下这个按钮"，交给浏览器原生 click
         （播放条上的 ☰ / ▶、档案上的 PLAY TRACK、返回键都保持各自的原意）；
       · 其余一律按上下文执行：开屏 → 进入系统；档案阵列 → 读取档案进详情；
         详情 → 播放 / 暂停这一首（档案栏下面那行提示写的就是「ENTER 播放」，
         详情区的主按钮也是 PLAY；而"回车只读档案、不自动播放"说的是阵列那一层，没变）。 */
  if (e.key === "Enter" && !editing) {
    const active = document.activeElement as HTMLElement | null;
    const navAction = ["prev", "next", "column-prev", "column-next"].includes(
      active?.dataset.action ?? "",
    );
    const onArchiveNav = Boolean(active?.dataset.select) || navAction;
    const onOtherControl =
      !onArchiveNav &&
      e.target instanceof Element &&
      Boolean(e.target.closest("button, a[href], [role='button']"));
    if (onOtherControl) return;
    e.preventDefault();
    if (mode === "boot") setMode("archive");
    else if (mode === "archive") openFile();
    else if (mode === "detail") togglePlay();
  }
});

const ease = (t: number) => {
  t = Math.max(0, Math.min(1, t));
  return t * t * (3 - 2 * t);
};
function bootFrame(t: number) {
  audio.updateBoot(t, frozenTime !== null);
  const motion = bootSequence.update(t);
  let step: string = motion.step;
  let caption =
    motion.step === "auth"
      ? t < 9.52
        ? `身份信息确认：${getOperator()}`
        : t < 11.84
          ? "请求已接收"
          : "开始处理"
      : motion.step === "scan"
        ? "权限验证通过"
        : motion.step === "welcome"
          ? "欢迎访问莱茵生命内部资料档案"
          : "";
  if (t >= 22) {
    step = "array";
    caption = "选择档案";
  }
  if (t >= 25.68) {
    step = "select";
    caption = "编号：X-001";
  }
  if (t >= 28.3) {
    step = "inspect";
    caption = t >= 29.3 ? "保密级别：商业区" : "编号：X-001";
  }
  if (step !== lastStep) {
    $("#stage").dataset.boot = step;
    lastStep = step;
  }
  $("#cinema-caption").textContent = caption;
  $(".file-title").firstChild!.textContent =
    step === "array"
      ? "SELECTING FILES...".slice(0, Math.max(0, Math.floor((t - 21.94) * 18)))
      : "TRACK NUMBER: ";
  $("#stage").style.setProperty(
    "--entry-opacity",
    String(ease((t - 21.9) / 0.13)),
  );
  $(".callout-rule").style.transform = `scaleX(${ease((t - 22.08) / 0.9)})`;
  const reveal = ease((t - 22) / 0.4),
    lift = ease((t - 26) / 1.8),
    zoom = 0.55 * ease((t - 27.3) / 1.65) + 0.45 * ease((t - 29.0) / 5.0);
  if (t >= 35) {
    setMode("detail");
    return undefined;
  }
  return { reveal, lift, zoom, time: t };
}

const inspectionOverlay = new InspectionOverlay();
const documentDecryption = new DocumentDecryption();

let lastTime = 0,
  frameCount = 0,
  frameStart = performance.now(),
  fps = 0;
/* ============================ 开屏时间轴 ============================
   原片 25fps，bootMotion() 里的 t 就是视频秒数（app 时间 0 对应视频 5 秒）。
   参考片里白场扫过、`.boot-background` 归零发生在视频 26.16–26.88 秒
   （= appTime 21.16–21.88）。

   用户的两条要求是分开的：
     · 开屏动画**按原速**（压成 3 倍速之后整段动作变快闪，太快了）；
     · "挡住界面的那块"要在 7 秒以内被擦掉。
   片子自己的节奏不能动，所以不压倍速，改成**从片子后半段进**：
   从 appTime 15.2 起播 → 原速下 21.88 − 15.2 = 6.68 秒扫完 ✓（≤7 秒）
   于是开头那段（ACCESS 文字、Logo 描画、ID 确认打字）不再播，从"START PROCESSING"
   的鉴权打字进 → 扫描环 → WELCOME 黑底扫过 → 白场 → 档案阵列，全都是原速。
   `?time=` / `rhine.seek()` 的逐帧复核仍是全片 1×（bootSpeed 单独存）。 */
const BOOT_SPEED = 1;
/** 正常启动从片子的哪一秒进（appTime，= 视频秒数 − 5） */
const BOOT_START_APP = 15.2;
/** 当前生效的倍速：正常启动用 BOOT_SPEED，逐帧复核（?time=）保持原速 1× */
let bootSpeed = BOOT_SPEED;
/** 当前该喂给 bootFrame 的 appTime（秒，原片时间轴） */
function bootAppTime(now: number) {
  return bootApp0 + (now - bootOrigin) * bootSpeed;
}
function frame(ms: number) {
  const time = ms / 1000;
  const cinema =
    mode === "boot" && ready
      ? bootFrame(frozenTime ?? bootAppTime(time))
      : undefined;
  if (!viewer?.isOpen) scene?.update(time, cinema);
  viewer?.update(time);
  if (scene && mode === "detail") {
    documentDecryption.update(time, scene.decryptionFrame, prefs.reduced);
    $("#detail-content").style.opacity = String(scene.detailVisibility);
    $("#detail-content").style.transform =
      `translateY(${(1 - scene.detailVisibility) * 18}px)`;
    $("#detail-content").inert = scene.detailVisibility < 0.1;
    if (pendingDetailFocus && scene.detailVisibility >= 0.1 && !modal && !viewer?.isOpen) {
      $("#detail-content").focus({ preventScroll: true });
      pendingDetailFocus = false;
    }
  }
  $("#stage").style.setProperty("--detail-shade", String(mode === "boot" ? 0 : scene?.detailVisibility ?? 0));
  if (scene) inspectionOverlay.render(scene.decryptionFrame,
    (x, y) => scene.projectCard(x, y), Boolean(cinema));
  if (Math.floor(time) !== lastTime) {
    lastTime = Math.floor(time);
    $("#clock").textContent = new Date().toLocaleTimeString("en-GB");
  }
  frameCount++;
  if (ms - frameStart > 1000) {
    fps = (frameCount * 1000) / (ms - frameStart);
    frameStart = ms;
    frameCount = 0;
    $("#three-scene").dataset.fps = String(Math.round(fps));
    $("#three-scene").dataset.renderStats = JSON.stringify(scene?.getStats());
  }
  requestAnimationFrame(frame);
}
async function start() {
  try {
    // 先加载音乐库（IndexedDB），让三维档案阵列一进来就显示歌曲
    await initPlayer();
    scene = new ArchiveScene($("#three-scene"));
    await Promise.all([
      scene.load(),
      document.fonts.load("400 20px MiSans"),
      document.fonts.load("700 20px MiSans"),
    ]);
    sceneReady = true;
    scene.select(selected);
    syncCover();
    scene.onSelect = (i, cell) => {
      if (mode === "boot") return;
      select(i, cell ? { cell } : undefined);
    };
    /* ★ 双击档案 = 选中 → 打开档案 → 起播（用户要求"双击档案时打开档案并播放"）。
       单击仍然只是选中；回车/PLAY TRACK 仍然只打开不播（那两条语义都没动）。 */
    scene.onActivate = (i, cell) => {
      if (mode === "boot") return;
      select(i, cell ? { cell } : undefined);
      playAt(i);
      /* playAt 会按"起播即打开档案"（openOnPlay）打开详情；用户把这个开关关掉时
         双击仍然要打开，所以这里再兜一次。已经在详情里就只换内容，不重放解密动画。 */
      if (mode !== "detail") openFile();
      else renderDetail();
    };
    scene.onHover = (i) => {
      const label = $("#hover-label");
      if (i === null) {
        label.hidden = true;
        hoverCode.finish();
        hoverTitle.finish();
        return;
      }
      const animated = !prefs.reduced && mode === "archive";
      hoverCode.update({
        value: Number(records[i].id.slice(2)),
        animated: !label.hidden && animated,
      });
      hoverTitle.update({ text: records[i].title, animated: !label.hidden && animated });
      label.hidden = false;
      // Prepare the first visible value so the next hover can animate immediately.
      hoverCode.update({ animated });
      hoverTitle.update({ animated });
    };
    savePrefs();
    ready = true;
    const params = new URLSearchParams(location.search);
    bootOrigin = performance.now() / 1000;
    /* 起始 appTime：正常启动从片子后半段进（BOOT_START_APP，见上面的说明）；
       带 ?time= 的逐帧复核按参数指定值起。 */
    bootApp0 = params.has("time") ? Number(params.get("time")) : BOOT_START_APP;
    bootSpeed = params.has("time") ? 1 : BOOT_SPEED;
    setMode("boot");
    /* ★ 开屏的"第一档"必须落在**当前这一首**上。启动时"恢复上次在听的那一首"只把播放条
       填了出来（player 侧的 currentId），档案阵列却在这里被硬拉回第 0 档 ——
       于是右侧档案信息写着 X-001、播放条上是另一首，用户反馈的
       "刚打开时显示的档案信息与歌曲栏歌曲不匹配"就是这里。
       曲库为空时才退回第 0 档。 */
    select(currentIndex() >= 0 ? currentIndex() : 0);
    $("#loading").classList.add("loaded");
    setTimeout(() => $("#loading").remove(), 600);
    if (params.get("scene") === "archive") setMode("archive");
    if (params.get("scene") === "detail") setMode("detail");
    if (prefs.reduced && !params.has("time")) setMode("archive");
    requestAnimationFrame(frame);
  } catch (error) {
    console.error(error);
    $("#loading").innerHTML =
      '<div class="error-state"><strong>CONNECTION INTERRUPTED</strong><p>三维档案资源未能载入。请确认浏览器已启用硬件加速，然后重新连接。</p><button onclick="location.reload()">RECONNECT →</button></div>';
  }
}
updateSelection();
void start();
// Deterministic review controls: the running application, never a video surrogate.
Object.assign(window, {
  rhine: {
    // The review button supplies a real user activation. Preferences stay local to this preview.
    playBootPreview: async (music = false) => {
      if (!ready || !navigator.userActivation.isActive) return false;
      const request = ++audioPreviewRequest;
      audioPreview = true;
      audio.configure({ ...prefs, sound: true, music });
      const unlocked = await audio.unlock();
      if (request !== audioPreviewRequest) return false;
      if (!unlocked) {
        audioPreview = false;
        audio.configure(prefs);
        return false;
      }
      replayBoot(true);
      return true;
    },
    seek: (t: number) => {
      setMode("boot");
      bootOrigin = performance.now() / 1000;
      bootApp0 = t;
      bootSpeed = 1; // 复核用：从这一帧起按原速走，方便对着原片看
      lastStep = "";
    },
    archive: () => setMode("archive"),
    detail: () => openFile(),
    select: (i: number) => select(i),
    /* 排列顺序：与播放列表下拉框走同一条路（复核 / 脚本化核对用） */
    sort: (mode: string) => setSortMode(mode),
    stats: () => ({
      ...scene?.getStats(),
      fps: Math.round(fps),
      mode,
      ready,
      bootTime: mode === "boot" ? (frozenTime ?? bootAppTime(performance.now() / 1000)) + 5 : null,
      selected: records[selected].id,
      // 收藏统一以播放器曲目的 fav 字段为准（原来的档案收藏集合已废弃）
      saved: getSongs().filter((s) => s.fav).map((s) => s.title),
      audio: audio.stats(),
    }),
  },
});
if (import.meta.hot) import.meta.hot.dispose(() => audio.dispose());
