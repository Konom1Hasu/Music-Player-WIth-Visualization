/*
 * 频谱离线观测（v2.7.7 重写）：不启动浏览器、不需要音频设备，直接跑 src/spectrum.ts，
 * 把"画了什么"逐条落成数字，再跟 SelfMusic 原版 visualizer.py **源码里抽出来的公式**对。
 *
 * 为什么要这个脚本：spectrum.ts 现在是 `D:\SelfMusic\musicapp\widgets\visualizer.py`
 * 的 Canvas 直译。直译型代码最大的风险是"看着像、其实差一点"（槽位百分比、留白、
 * 顶盖悬空几像素、透明度公式……），肉眼比对截图根本发现不了 0.5px 的偏移。
 * 所以这里做三件事：
 *   ① 从 visualizer.py **源码**正则抽常量与公式（pad_x / usable / 0.70 / cap>0.004 /
 *      α=0.45+0.55v / 顶盖 2px 悬 3px / 渐变 0.0·0.45·1.0 / 指示条坐标）——
 *      抽不到就是"对拍对象变了"，直接失败（而不是悄悄跳过）；
 *   ② 用这些数字在 Node 侧**独立算一遍**期望几何，和 spectrum.ts 实际发出的
 *      绘制指令（伪 canvas 记录 fillRect / 渐变 / 圆角矩形 / 文字）逐条比；
 *   ③ 顺带量回落与清零（decay / resetPeaks）—— 原 频谱回落观测.mjs 的职责并入这里。
 *
 * 约定：原版的绝对尺寸都是 Qt 的 CSS px，画布像素 = CSS px × 画布比例（本仓 954/636 = 1.5）。
 * 脚本用 s=1.5 的画布桩验真实比例，再用 s=1 复核一遍（缩放必须是乘出来的，不能写死）。
 *
 * 与原版的**已知差异**（有意为之，逐条钉在这里，免得日后当成 bug 改回去）：
 *   · 不填画布底色（原版 fillRect(rect, theme.BG)）—— 画布透明，底色由页面给；
 *   · 不画右下角"▶ 播放中"（HTML 层已有等价状态）；
 *   · 底部渐变停点用本机调色板的 base（原版是硬编码的 #0a0e1c α235）；
 *   · 顶盖 / 指示条在浅色主题下用墨色（原版是暗色主题下的白）。
 *
 * 用法：node scripts\频谱离线观测.mjs
 *      （脚本会自己带 --experimental-transform-types 重启一次：spectrum.ts 用了
 *        构造器参数属性这类"需要转换、不能只擦除"的语法，Node 的默认 strip-only 会拒绝）
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "..", "app-rhine", "src");
/** SelfMusic 原版绘制层（对拍对象）。找不到就失败退出 —— 见文件头 ① */
const PY = process.env.SELFMUSIC_VISUALIZER || "D:\\SelfMusic\\musicapp\\widgets\\visualizer.py";

/* 自举：Node 的 strip-only 模式处理不了 `constructor(private canvas: ...)`。 */
async function loadSpectrum() {
  const url = pathToFileURL(path.join(SRC, "spectrum.ts")).href; // Windows 上不能把 "D:\..." 丢给 import()
  try {
    return await import(url);
  } catch (e) {
    if (!/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|ERR_UNKNOWN_FILE_EXTENSION/.test(String(e && e.code))) throw e;
    if (!process.env.RHINE_VIZ_OFFLINE_RETRY) {
      console.log("（首次加载被 Node 的 strip-only 模式拒绝，带 --experimental-transform-types 重跑一次）");
      const r = spawnSync(process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
        { stdio: "inherit", env: { ...process.env, RHINE_VIZ_OFFLINE_RETRY: "1" } });
      process.exit(r.status === null ? 1 : r.status);
    }
    throw e;
  }
}

let pass = 0;
let fail = 0;
function ok(cond, name, detail = "") {
  if (cond) {
    pass++;
    console.log("  ✓ " + name + (detail ? "  " + detail : ""));
  } else {
    fail++;
    console.log("  ✗ " + name + (detail ? "  " + detail : ""));
  }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ---------- 0. 对拍对象：从 visualizer.py 源码抽常量与公式 ---------- */
console.log("=== 0. 对拍对象：visualizer.py 源码常量 ===");
let pySrc = "";
try {
  pySrc = fs.readFileSync(PY, "utf8");
} catch (e) {
  console.log("  ✗ 读不到 " + PY + "：" + String(e && e.message));
  console.log("    （这是对拍的**权威源**，缺了就没法验证；可用环境变量 SELFMUSIC_VISUALIZER 指定路径）");
  process.exit(1);
}
/** 从源码里抓一个数：捕不到就计一次失败（宁可红，也不要静默跳过） */
function pickNum(re, group, name) {
  const m = re.exec(pySrc);
  if (!m) {
    console.log("  ✗ 抽不到：" + name + "  →  " + re);
    fail++;
    return NaN;
  }
  pass++;
  console.log("  ✓ " + name + " = " + m[group]);
  return Number(m[group]);
}
const PY_CONST = {
  pad_x: pickNum(/pad_x = ([0-9.]+)/, 1, "pad_x（左右留白）"),
  usable_pad: pickNum(/usable = h - ([0-9.]+)/, 1, "usable = h − 留白"),
  bar_ratio: pickNum(/bar_w = max\(1\.0, slot \* ([0-9.]+)\)/, 1, "bar_w = slot × 比例"),
  bar_min_w: pickNum(/bar_w = max\(([0-9.]+), slot \*/, 1, "bar_w 下限"),
  bh_min: pickNum(/bh = max\(([0-9.]+), level \* usable\)/, 1, "柱高下限"),
  alpha_k: pickNum(/setOpacity\(0\.45 \+ ([0-9.]+) \* max/, 1, "α = 0.45 + k·v 的 k"),
  cap_min: pickNum(/if cap > ([0-9.]+):/, 1, "顶盖门槛 cap >"),
  cap_alpha: pickNum(/setOpacity\(([0-9.]+)\)\s*\n\s*p\.fillRect\(QRectF\(x, baseline_y - ph/, 1, "顶盖透明度"),
  cap_gap: pickNum(/baseline_y - ph - ([0-9.]+), bar_w, [0-9.]+\)/, 1, "顶盖悬空"),
  cap_thick: pickNum(/baseline_y - ph - ([0-9.]+), bar_w, ([0-9.]+)\)/, 2, "顶盖厚度"),
  cap_ph_min: pickNum(/ph = max\(([0-9.]+), cap \* usable\)/, 1, "顶盖高度下限"),
  grad_mid: pickNum(/setColorAt\(([0-9.]+), QColor\(_st\[len\(_st\) \/\/ 2\]\[1\]\)\)/, 1, "渐变中位停点"),
  gauge_x: pickNum(/^ *x, y = ([0-9.]+), [0-9.]+/m, 1, "指示条起点 x"),
  gauge_y: pickNum(/^ *x, y = ([0-9.]+), ([0-9.]+)/m, 2, "指示条起点 y"),
  gauge_label_w: pickNum(/label_w, mw, mh, gap = ([0-9.]+), ([0-9.]+), ([0-9.]+), ([0-9.]+)/, 1, "指示条标签宽"),
  gauge_w: pickNum(/label_w, mw, mh, gap = ([0-9.]+), ([0-9.]+),/, 2, "指示条长度"),
  gauge_h: pickNum(/label_w, mw, mh, gap = ([0-9.]+), ([0-9.]+), ([0-9.]+),/, 3, "指示条厚度"),
  gauge_gap: pickNum(/label_w, mw, mh, gap = ([0-9.]+), ([0-9.]+), ([0-9.]+), ([0-9.]+)/, 4, "指示条间距"),
  gauge_fill_min: pickNum(/max\(([0-9.]+), mw \* v\), mh\)/, 1, "活跃度填充下限"),
};
ok(/baseline_y = float\(h\)/.test(pySrc), "柱体贴底（baseline_y = h）");
ok(/if self\._gauges:/.test(pySrc) && /def _draw_gauges/.test(pySrc), "四路指示条仍在 paintEvent 里被调用");
ok((pySrc.match(/_bar_color/g) || []).length <= 2,
  "NOISE_RAMP 融合色仍是死代码（只在定义处出现）→ 不移植");

/* ---------- 0b. 本仓 spectrum.ts 常量 ↔ 原版公式 ---------- */
console.log("\n=== 0b. 本仓 spectrum.ts 常量 ↔ 原版公式 ===");
const spSrc = fs.readFileSync(path.join(SRC, "spectrum.ts"), "utf8");
function pickJs(re, name, expectValue) {
  const m = re.exec(spSrc);
  if (!m) {
    console.log("  ✗ spectrum.ts 里抽不到：" + name);
    fail++;
    return;
  }
  const got = Number(m[1]);
  ok(near(got, expectValue, 1e-12), name, got + " / 原版 " + expectValue);
}
pickJs(/const PAD_X = ([0-9.]+);/, "PAD_X ↔ pad_x", PY_CONST.pad_x);
pickJs(/const USABLE_PAD = ([0-9.]+);/, "USABLE_PAD ↔ 原版 usable 留白", PY_CONST.usable_pad);
pickJs(/const BAR_W_RATIO = ([0-9.]+);/, "BAR_W_RATIO ↔ bar_w 比例", PY_CONST.bar_ratio);
pickJs(/const CAP_MIN = ([0-9.]+);/, "CAP_MIN ↔ 顶盖门槛", PY_CONST.cap_min);
pickJs(/const CAP_THICK = ([0-9.]+);/, "CAP_THICK ↔ 顶盖厚度", PY_CONST.cap_thick);
pickJs(/const CAP_GAP = ([0-9.]+);/, "CAP_GAP ↔ 顶盖悬空", PY_CONST.cap_gap);
pickJs(/const GAUGE_X = ([0-9.]+);/, "GAUGE_X ↔ 指示条 x", PY_CONST.gauge_x);
pickJs(/const GAUGE_Y = ([0-9.]+);/, "GAUGE_Y ↔ 指示条 y", PY_CONST.gauge_y);
pickJs(/const GAUGE_LABEL_W = ([0-9.]+);/, "GAUGE_LABEL_W ↔ 标签宽", PY_CONST.gauge_label_w);
pickJs(/const GAUGE_W = ([0-9.]+);/, "GAUGE_W ↔ 条长", PY_CONST.gauge_w);
pickJs(/const GAUGE_H = ([0-9.]+);/, "GAUGE_H ↔ 条厚", PY_CONST.gauge_h);
pickJs(/const GAUGE_GAP = ([0-9.]+);/, "GAUGE_GAP ↔ 间距", PY_CONST.gauge_gap);
ok(/0\.45 \+ 0\.55 \* level/.test(spSrc), "逐柱 α = 0.45 + 0.55·level（与原版同式）");
ok(/addColorStop\(0\.45, this\.palette\.strong\)/.test(spSrc), "渐变中位停点 = 0.45（与原版同点）");

/* ---------- 1. 伪 canvas：把 spectrum.ts 发出的绘制指令全部记下来 ---------- */
console.log("\n=== 1. 伪 canvas 记录：几何 / 透明度 / 颜色 ===");
function makeRecorder(canvasW, canvasH, clientW) {
  const events = [];
  let alpha = 1;
  let fill = "";
  let font = "";
  let textBaseline = "";
  let textAlign = "";
  let pts = [];
  let gradStops = null;
  const ctx = {
    clearRect(x, y, w, h) { events.push({ op: "clear", x, y, w, h }); },
    fillRect(x, y, w, h) {
      events.push({ op: "rect", x, y, w, h, alpha, style: typeof fill === "string" ? fill : "grad" });
    },
    createLinearGradient(_x0, _y0, _x1, _y1) {
      const stops = [];
      gradStops = stops;
      return { __grad: true, stops, addColorStop(p, c) { stops.push([p, c]); } };
    },
    beginPath() { pts = []; },
    moveTo(x, y) { pts.push([x, y]); },
    arcTo(x1, y1, x2, y2) { pts.push([x1, y1], [x2, y2]); },
    closePath() { /* 记 bbox 用不到 */ },
    fill() {
      if (!pts.length) return;
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      events.push({
        op: "round",
        x: Math.min(...xs), y: Math.min(...ys),
        w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
        alpha, style: fill,
      });
    },
    fillText(text, x, y) { events.push({ op: "text", text, x, y, alpha, style: fill, font }); },
  };
  Object.defineProperty(ctx, "fillStyle", { get() { return fill; }, set(v) { fill = v; } });
  Object.defineProperty(ctx, "globalAlpha", { get() { return alpha; }, set(v) { alpha = v; } });
  Object.defineProperty(ctx, "font", { get() { return font; }, set(v) { font = v; } });
  Object.defineProperty(ctx, "textBaseline", { get() { return textBaseline; }, set(v) { textBaseline = v; } });
  Object.defineProperty(ctx, "textAlign", { get() { return textAlign; }, set(v) { textAlign = v; } });
  const canvas = { width: canvasW, height: canvasH, clientWidth: clientW, getContext: () => ctx };
  return { canvas, events, gradOf: () => gradStops };
}

const { Spectrum } = await loadSpectrum();

/** 造一帧已知数据：柱高 0→1 线性爬坡，顶盖 = 柱高 + 0.25（每根柱都带顶盖） */
const N = 96;
const F = (() => {
  const h = new Float32Array(N);
  const p = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    h[i] = i / (N - 1);
    p[i] = Math.min(1, h[i] + 0.25);
  }
  return { h, p };
})();
const GAUGES = { kick: 1.0, bass: 0.5, vocal: 0.0, cymbal: 0.25 };

function record(canvasW, canvasH, clientW) {
  const rec = makeRecorder(canvasW, canvasH, clientW);
  const sp = new Spectrum(rec.canvas);
  sp.setPalette({ light: "#112233", strong: "#445566", base: "#778899", cap: "#ffffff" });
  sp.applyExternalBars(F.h, F.p, GAUGES);
  sp.render(0.016);
  return { sp, events: rec.events, gradStops: rec.gradOf() };
}

/* ---------- 1a. s = 954/636 = 1.5（本仓真实画布比例） ---------- */
const CAN_W = 954, CAN_H = 716, CLIENT_W = 636;
const s = CAN_W / CLIENT_W;
const R = record(CAN_W, CAN_H, CLIENT_W);
const rects = R.events.filter((e) => e.op === "rect");
const rounds = R.events.filter((e) => e.op === "round");
const texts = R.events.filter((e) => e.op === "text");

/* 期望几何：全部用"原版公式 + 抽出来的常量"算，**不看** spectrum.ts 的实现 */
const padX = PY_CONST.pad_x * s;
const usable = CAN_H - PY_CONST.usable_pad * s;
const slot = (CAN_W - padX * 2) / N;
const barW = Math.min(slot, Math.max(PY_CONST.bar_min_w * s, slot * PY_CONST.bar_ratio));

ok(R.events.filter((e) => e.op === "clear").length === 1, "每帧先整块清屏（clearRect × 1）");
ok(rects.length === N + N, "矩形数 = 柱 " + N + " + 顶盖 " + N, "实得 " + rects.length);
/* 绘制顺序是"每根柱：先柱、后顶盖" → 柱在偶数位、顶盖在奇数位 */
const barsOf = (list) => Array.from({ length: N }, (_, i) => list[2 * i]);
const capsOf = (list) => Array.from({ length: N }, (_, i) => list[2 * i + 1]);
const BAR_RECTS = barsOf(rects);
const CAP_RECTS = capsOf(rects);
let maxDx = 0, maxDy = 0, maxDw = 0, maxDh = 0, maxDa = 0;
for (let i = 0; i < N; i++) {
  const bar = BAR_RECTS[i];
  const level = F.h[i];
  const xExp = padX + i * slot + (slot - barW) / 2;
  const bhExp = Math.max(PY_CONST.bh_min * s, level * usable);
  const aExp = 0.45 + PY_CONST.alpha_k * level;
  maxDx = Math.max(maxDx, Math.abs(bar.x - xExp));
  maxDw = Math.max(maxDw, Math.abs(bar.w - barW));
  maxDh = Math.max(maxDh, Math.abs(bar.h - bhExp));
  maxDy = Math.max(maxDy, Math.abs(bar.y - (CAN_H - bhExp)));
  maxDa = Math.max(maxDa, Math.abs(bar.alpha - aExp));
}
ok(maxDx <= 1e-9, "柱左边缘 x = pad + i·slot + (slot−bar_w)/2（逐柱）", "maxΔ=" + maxDx);
ok(maxDw <= 1e-9, "柱宽 = 槽位 × " + PY_CONST.bar_ratio + "（逐柱）", "maxΔ=" + maxDw + "（" + barW.toFixed(4) + "px）");
ok(maxDh <= 1e-9, "柱高 = v×(h−" + PY_CONST.usable_pad + ")、下限 " + PY_CONST.bh_min + "px", "maxΔ=" + maxDh);
ok(maxDy <= 1e-9, "柱**贴底**（y = h − bh）", "maxΔ=" + maxDy);
ok(maxDa <= 1e-9, "逐柱 α = 0.45 + " + PY_CONST.alpha_k + "·v（不是分桶）", "maxΔ=" + maxDa);

/* 顶盖 */
let capDx = 0, capDy = 0, capDh = 0, capDa = 0, capWhite = 0;
for (let i = 0; i < N; i++) {
  const cap = CAP_RECTS[i];
  const phExp = Math.max(PY_CONST.cap_ph_min * s, F.p[i] * usable);
  capDx = Math.max(capDx, Math.abs(cap.x - (padX + i * slot + (slot - barW) / 2)));
  capDy = Math.max(capDy, Math.abs(cap.y - (CAN_H - phExp - PY_CONST.cap_gap * s)));
  capDh = Math.max(capDh, Math.abs(cap.h - PY_CONST.cap_thick * s));
  capDa = Math.max(capDa, Math.abs(cap.alpha - PY_CONST.cap_alpha));
  if (String(cap.style).startsWith("rgba(255,255,255")) capWhite++;
}
ok(capDx <= 1e-9 && capDy <= 1e-9, "顶盖 y = h − ph − " + PY_CONST.cap_gap + "（悬在峰值之上）",
  "maxΔ=" + Math.max(capDx, capDy));
ok(capDh <= 1e-9, "顶盖厚 = " + PY_CONST.cap_thick + "px", "maxΔ=" + capDh);
ok(capDa <= 1e-9, "顶盖 α = " + PY_CONST.cap_alpha, "maxΔ=" + capDa);
ok(capWhite === N, "顶盖用主题对比色（深底白）画满每根柱", capWhite + "/" + N);

/* 渐变停点 */
ok(Array.isArray(R.gradStops) && R.gradStops.length === 3, "竖向渐变有 3 个停点", JSON.stringify(R.gradStops));
if (Array.isArray(R.gradStops) && R.gradStops.length === 3) {
  ok(near(R.gradStops[0][0], 0.0, 1e-12) && R.gradStops[0][1] === "#112233", "停点 0.0 = 最亮色（调色板 light）");
  ok(near(R.gradStops[1][0], PY_CONST.grad_mid, 1e-12) && R.gradStops[1][1] === "#445566",
    "停点 " + PY_CONST.grad_mid + " = 主色（调色板 strong）");
  ok(near(R.gradStops[2][0], 1.0, 1e-12) && R.gradStops[2][1] === "#778899", "停点 1.0 = 底色（调色板 base）");
}

/* 指示条：4 个标签 + 4 条轨道 + 活跃度 > 0.01 的填充 */
const gxExp = PY_CONST.gauge_x * s;
const gyExp = PY_CONST.gauge_y * s;
const labelW = PY_CONST.gauge_label_w * s;
const mwExp = PY_CONST.gauge_w * s;
const mhExp = PY_CONST.gauge_h * s;
const stepExp = labelW + mwExp + PY_CONST.gauge_gap * s;
ok(texts.length === 4, "左上角四个标签（鼓 / 低音 / 人声 / 镲）", texts.map((t) => t.text).join(" "));
ok(texts.map((t) => t.text).join(",") === "鼓,低音,人声,镲", "标签文字与顺序和原版 items 一致");
let txMax = 0;
for (let k = 0; k < 4; k++) txMax = Math.max(txMax, Math.abs(texts[k].x - (gxExp + k * stepExp)));
ok(txMax <= 1e-9, "标签横向步进 = 标签宽 + 条长 + 间距", "maxΔ=" + txMax);
ok(rounds.length === 4 + 3, "圆角矩形 = 4 条轨道 + 3 个活跃度填充（vocal = 0 不画）", "实得 " + rounds.length);
/* 指示条也是"逐路：先轨道、后填充" → 按原版 items 顺序推进游标逐条比 */
let maxRoundD = 0;
{
  let cur = 0;
  for (let k = 0; k < 4; k++) {
    const v = [GAUGES.kick, GAUGES.bass, GAUGES.vocal, GAUGES.cymbal][k];
    const xExp = gxExp + k * stepExp + labelW;
    const track = rounds[cur++];
    maxRoundD = Math.max(maxRoundD, Math.abs(track.x - xExp), Math.abs(track.y - gyExp));
    maxRoundD = Math.max(maxRoundD, Math.abs(track.w - mwExp), Math.abs(track.h - mhExp));
    if (v > 0.01) {
      const fill = rounds[cur++];
      maxRoundD = Math.max(maxRoundD, Math.abs(fill.x - xExp), Math.abs(fill.y - gyExp));
      maxRoundD = Math.max(maxRoundD, Math.abs(fill.w - Math.max(PY_CONST.gauge_fill_min * s, mwExp * v)));
      maxRoundD = Math.max(maxRoundD, Math.abs(fill.h - mhExp));
    }
  }
  ok(cur === rounds.length, "圆角矩形序列与 items 顺序一致（4 轨道 + 3 填充）", "消费 " + cur + " 条");
}
ok(maxRoundD <= 1e-9, "轨道 (x, y, " + PY_CONST.gauge_w + ", " + PY_CONST.gauge_h + ") 与活跃度填充宽 max(" +
  PY_CONST.gauge_fill_min + ", 条长 × v) 全部吻合", "maxΔ=" + maxRoundD);
ok(rounds.every((r) => near(r.h, mhExp, 1e-9)), "轨道与填充同高（胶囊形）");
/* 原版在柱循环之后 p.setOpacity(1.0)：指示条不跟着最后一根柱的透明度变淡。
   少这一条会在"柱高偏低"时整组指示条几乎看不见（像素对拍抓过一次）。 */
ok([...texts, ...rounds].every((e) => near(e.alpha, 1, 1e-9)),
  "绘制指示条前透明度已归位（1.0）", "max α=" + Math.max(...[...texts, ...rounds].map((e) => e.alpha)));
/* 已知差异：不填画布底色（原版 fillRect(rect, theme.BG)） */
ok(!R.events.some((e) => e.op === "rect" && e.w === CAN_W && e.h === CAN_H),
  "不填整块画布底色（有意差异：底色交给页面）");

/* ---------- 1b. s = 1 复核：缩放必须是乘出来的，不能写死 ---------- */
const R1 = record(954, 716, 954);
const r1 = barsOf(R1.events.filter((e) => e.op === "rect"));
const slot1 = (954 - PY_CONST.pad_x * 2) / N;
const barW1 = Math.min(slot1, Math.max(PY_CONST.bar_min_w, slot1 * PY_CONST.bar_ratio));
let d1 = 0;
for (let i = 0; i < N; i++) {
  const xExp = PY_CONST.pad_x + i * slot1 + (slot1 - barW1) / 2;
  const bhExp = Math.max(PY_CONST.bh_min, F.h[i] * (716 - PY_CONST.usable_pad));
  d1 = Math.max(d1, Math.abs(r1[i].x - xExp), Math.abs(r1[i].w - barW1), Math.abs(r1[i].h - bhExp));
}
ok(d1 <= 1e-9, "画布比例 1.0 时同样吻合（尺寸是乘出来的）", "maxΔ=" + d1);

/* ---------- 2. 边界：顶盖门槛 / 柱高下限 ---------- */
console.log("\n=== 2. 边界 ===");
function capCountOf(peakValue) {
  const rec = makeRecorder(954, 716, 636);
  const sp = new Spectrum(rec.canvas);
  sp.applyExternalBars(new Float32Array(N), new Float32Array(N).fill(peakValue), null);
  sp.render(0.016);
  return rec.events.filter((e) => e.op === "rect").length - N;
}
ok(capCountOf(PY_CONST.cap_min - 1e-4) === 0, "cap 低于门槛（" + (PY_CONST.cap_min - 1e-4) + "）不画顶盖");
ok(capCountOf(PY_CONST.cap_min + 1e-4) === N, "cap 高过门槛（" + (PY_CONST.cap_min + 1e-4) + "）全画");
/* 门槛值是 f64 的 0.004，而柱数据存在 Float32Array 里：f32(0.004) = 0.00400000019 > 0.004
   → 正好 0.004 这一档会画。这是浮点事实，不是判断写错（原版 numpy float32 同理）。 */
ok(capCountOf(PY_CONST.cap_min) === N,
  "cap 正好 0.004：f32 存下来是 0.00400000019，比门槛大一丝 → 画（与原版 float32 同）");
{
  const rec = makeRecorder(954, 716, 636);
  const sp = new Spectrum(rec.canvas);
  sp.applyExternalBars(new Float32Array(N), new Float32Array(N).fill(0.5), null);
  sp.render(0.016);
  const zeroBars = barsOf(rec.events.filter((e) => e.op === "rect"));
  ok(zeroBars.every((r) => near(r.h, PY_CONST.bh_min * s, 1e-9)),
    "v = 0 时柱高 = 下限 " + PY_CONST.bh_min + "px（不是 0）");
  ok(zeroBars.every((r) => near(r.alpha, 0.45, 1e-9)), "v = 0 时 α = 0.45（原版同式）");
}

/* ---------- 3. 回落 / 清零 / 读数口 ---------- */
console.log("\n=== 3. 回落与清零 ===");
const spD = new Spectrum(makeRecorder(954, 716, 636).canvas);
spD.applyExternalBars(F.h, F.p, GAUGES);
ok(spD.levels.length === N && spD.levels[10] === F.h[10],
  "levels 直通引擎柱高（不重采样、不插值）", spD.levels.length + " 段");
const before = spD.levels[90];
const live = spD.decay();
ok(near(spD.levels[90], before * 0.9, 1e-6) && live === true, "decay()：柱高 × 0.9，并报告仍在动",
  spD.levels[90].toFixed(4));
ok(near(spD.gauges.kick, GAUGES.kick * 0.9, 1e-6), "decay() 连指示条一起收");
spD.resetPeaks();
ok(spD.levels.every((v) => v === 0) && spD.peakLevels.every((v) => v === 0) &&
  spD.gauges.kick === 0 && spD.gauges.cymbal === 0, "resetPeaks()：柱高 / 顶盖 / 指示条全清零");
{
  const spQuiet = new Spectrum(makeRecorder(954, 716, 636).canvas);
  spQuiet.applyExternalBars(new Float32Array(N), new Float32Array(N), null);
  ok(spQuiet.decay() === false, "全零之后 decay() 报告已经停稳（调用方据此降帧）");
}
let emptyOk = true;
try {
  const spE = new Spectrum(makeRecorder(954, 716, 636).canvas);
  spE.render(0.016);
  spE.decay();
  spE.resetPeaks();
} catch (e) {
  emptyOk = false;
}
ok(emptyOk, "还没喂数据就渲染 / 回落 / 清零：不抛异常");

/* ---------- 汇总 ---------- */
console.log("\n" + "=".repeat(64));
console.log(fail === 0
  ? "★ 频谱离线观测（绘制层 ↔ visualizer.py 对拍）：" + pass + " 项全绿"
  : "✗ 频谱离线观测：" + pass + " 通过 / " + fail + " 失败");
console.log("=".repeat(64));
process.exit(fail === 0 ? 0 : 1);
