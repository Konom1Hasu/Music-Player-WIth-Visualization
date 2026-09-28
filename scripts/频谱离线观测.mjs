/*
 * 频谱离线观测：不启动浏览器、不需要音频设备，直接跑 src/spectrum.ts 里那条流水线，
 * 量出柱高到底长什么样（是否有起伏、有没有顶满、相邻柱高差多大）。
 *
 * 为什么要这个脚本：无头浏览器在虚拟时间下 requestAnimationFrame 会停摆、媒体也解不出码，
 * 页内探针测不到"柱高"。这里把"合成信号 → Spectrum"两段都搬进 Node：
 *   - Spectrum 直接 import 源码（Node 24 能直接跑 .ts，构建产物里的算法与之同源）；
 *   - 合成信号（player.ts 里的 vizTestTimeData）在这里逐行复刻一份，避免为了测试去改产品代码。
 * 两者任一改了都要同步核一遍：脚本开头会读源码里的关键常量，对不上直接报错退出。
 *
 * 用法：node scripts\频谱离线观测.mjs [秒数]
 *      （脚本会自己带 --experimental-transform-types 重启一次：spectrum.ts 用了
 *        构造器参数属性这类"需要转换、不能只擦除"的语法，Node 的默认 strip-only 会拒绝）
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "..", "app-rhine", "src");

/* 自举：Node 24 的 strip-only 模式处理不了 `constructor(private canvas: ...)`。
   这里在同进程里"带 flag 再跑一遍"，测的仍然是 src/spectrum.ts 本身。 */
async function loadSpectrum() {
  const url = pathToFileURL(path.join(SRC, "spectrum.ts")).href; // Windows 上不能把 "D:\..." 丢给 import()
  try {
    return await import(url);
  } catch (e) {
    if (!/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|ERR_UNKNOWN_FILE_EXTENSION/.test(String(e && e.code))) throw e;
    if (!process.env.RHINE_VIZ_OFFLINE_RETRY) {
      console.log('（首次加载被 Node 的 strip-only 模式拒绝，带 --experimental-transform-types 重跑一次）');
      const r = spawnSync(process.execPath,
        ['--experimental-transform-types', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)],
        { stdio: 'inherit', env: { ...process.env, RHINE_VIZ_OFFLINE_RETRY: '1' } });
      process.exit(r.status === null ? 1 : r.status);
    }
    throw e;
  }
}
const { Spectrum, setVizParams, clampVizParams, clampHeadroom, KICK_PUMP_MIN } = await loadSpectrum();

/* ---------- 0. 源码一致性自检：常量被改过就报错，免得测的是旧参数 ---------- */
const spSrc = fs.readFileSync(path.join(SRC, "spectrum.ts"), "utf8");
const expect = [
  ["ANALYSIS_WINDOW = 1024", /const ANALYSIS_WINDOW = 1024;/],
  ["VIZ_LEVELS = 14", /const VIZ_LEVELS = 14;/],
  ["SPECTRUM_BANDS = 120", /export const SPECTRUM_BANDS = 120;/],
  // 抖动 / 倾斜 / 泵动现在是运行时参数（vizParams），来源仍是 1.3.0 的原值：
  // 幅度 0.45、相位步进 0.03、单边颤动 0.055，都乘 JITTER_K。这里按**函数形态**核对。
  ["JITTER_AMP = 0.45*K", /const jitterAmp = \(\) => 0\.45 \* vizParams\.jitterK;/],
  ["JITTER_FREQ = 0.1+0.2*(K-0.4)", /const jitterFreq = \(\) => 0\.1 \+ 0\.2 \* \(vizParams\.jitterK - 0\.4\);/],
  ["JITTER_STEP = 0.03*K", /const jitterStep = \(\) => 0\.03 \* vizParams\.jitterK;/],
  ["JITTER_WOBBLE = 0.055*K", /const jitterWobble = \(\) => 0\.055 \* vizParams\.jitterK;/],
  ["VIZ_DEFAULTS.tilt = 55", /VIZ_DEFAULTS: VizParams = \{ tilt: 55,/],
  ["VIZ_DEFAULTS.kickPump = 0.4", /kickPump: 0\.4,/],
  ["BASS_WIDE_CENTER = 0.12", /const BASS_WIDE_CENTER = 0\.12;/],
];
for (const [name, re] of expect) {
  if (!re.test(spSrc)) {
    console.error("参数自检失败：src/spectrum.ts 里找不到 " + name + " —— 脚本里的说明与实现对不上了");
    process.exit(2);
  }
}
/* 柱数是**显示侧**密度（可以随"细密一点"这类要求调整），所以不写死值：
   这里只要求它是显式常量，后面所有频段切片都按实际柱数换算，改柱数不用改本脚本。 */
const barNMatch = /const BAR_N = (\d+);/.exec(spSrc);
if (!barNMatch) {
  console.error("参数自检失败：src/spectrum.ts 里没有 `const BAR_N = <整数>;`");
  process.exit(2);
}
const SRC_BAR_N = Number(barNMatch[1]);

/* ---------- 0b. 左峰"留余量"闸门的行为核对（用户："可视化左侧不要一直顶满"） ----------
   闸门是纯函数，跟音频无关，顺手在这里把几种输入过一遍：
   旧版导入的 kickPump 0 必须被夹到 KICK_PUMP_MIN，合规值必须原样放过，
   没带这个键时不能凭空冒出一个值。 */
{
  const cases = [
    [{ kickPump: 0, peakTarget: 1.45 }, "旧版导入的顶满组合"],
    [{ kickPump: 0 }, "只有鼓点 0"],
    [{ kickPump: 0.4, peakTarget: 1.45 }, "已合规：原样"],
    [{ kickPump: 0.6 }, "滑块上限：不动"],
    [{ peakTarget: 1.45 }, "没带鼓点：不凭空冒值"],
  ];
  console.log("左峰留余量闸门（KICK_PUMP_MIN = " + KICK_PUMP_MIN + "，0.40 = 1.3.0 的默认鼓点）：");
  for (const [input, why] of cases) {
    console.log("  " + JSON.stringify(input).padEnd(34) + " -> "
      + JSON.stringify(clampVizParams(clampHeadroom(input))) + "   " + why);
  }
  const once = clampHeadroom({ kickPump: 0 });
  const twice = clampHeadroom(once);
  console.log("  幂等：" + (JSON.stringify(once) === JSON.stringify(twice) ? "✓" : "✗ " + JSON.stringify(twice)));
  console.log("");
}

const plSrc = fs.readFileSync(path.join(SRC, "player.ts"), "utf8");
if (!/const VIZ_NOISE_HP = 0\.55;/.test(plSrc)) {
  console.error("参数自检失败：src/player.ts 里的 VIZ_NOISE_HP 不是 0.55");
  process.exit(2);
}

/* ---------- 1. 最小画布桩：只实现 Spectrum.draw() 用到的几个方法 ---------- */
const ctxStub = {
  clearRect() {},
  fillRect() {},
  beginPath() {},
  moveTo() {},
  lineTo() {},
  arc() {},
  stroke() {},
  createLinearGradient: () => ({ addColorStop() {} }),
  fillStyle: "", strokeStyle: "", globalAlpha: 1, lineWidth: 1,
};
const canvasStub = { width: 954, height: 716, getContext: () => ctxStub };

/* ---------- 2. 合成信号：与 player.ts 的 vizTestTimeData 同一套参数 ---------- */
const VIZ_NOISE_HP = 0.55;
const SR = 48000;
const N = 1024; // = ANALYSIS_WINDOW
let phase = 0, lp = 0, idx = 0;
function beatOf() {
  return Math.pow(Math.max(0, Math.sin((phase / 120) * Math.PI * 2)), 8);
}
function fill(out) {
  phase += 1;
  const beat = beatOf();
  const n = out.length;
  for (let i = 0; i < n; i++) {
    const t = (idx + i) / SR;
    lp += (Math.random() * 2 - 1 - lp) * VIZ_NOISE_HP;
    let s = lp * 0.9 + (Math.random() * 2 - 1) * 0.1;
    const env = 0.35 + 0.65 * beat;
    s += env * (0.26 * Math.sin(2 * Math.PI * 55 * t) + 0.12 * Math.sin(2 * Math.PI * 110 * t) + 0.05 * Math.sin(2 * Math.PI * 220 * t));
    s += env * 0.06 * Math.sin(2 * Math.PI * (700 + 400 * Math.sin(2 * Math.PI * 0.3 * t)) * t);
    out[i] = Math.max(-1, Math.min(1, s * 0.5));
  }
  idx += n;
  return beat;
}

/* ---------- 3. 跑：每帧一次分析（30Hz → 每 33ms 一帧），画 60fps 只是重画同一份 bars ---------- */
/* 参数可用 `--tilt= / --bass= / --jit= / --kick= / --peak=` 临时覆盖（对照不同调音用，
   不写进产品存储）。例：node scripts\频谱离线观测.mjs 12 --peak=1.05 看"峰高压到 1.05 后左峰还顶不顶满"。 */
const CLI = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--"))
  .map((a) => { const i = a.indexOf("="); return [a.slice(2, i < 0 ? undefined : i), i < 0 ? "1" : a.slice(i + 1)]; }));
const override = {};
/* ★ 判空要用 undefined 而不是真假值：`--kick=0` 是合法覆盖（泵动关掉），用 if (CLI.kick) 会漏掉。 */
if (CLI.tilt !== undefined) override.tilt = Number(CLI.tilt);
if (CLI.bass !== undefined) override.bassSigma = Number(CLI.bass);
if (CLI.jit !== undefined) override.jitterK = Number(CLI.jit);
if (CLI.kick !== undefined) override.kickPump = Number(CLI.kick);
if (CLI.peak !== undefined) override.peakTarget = Number(CLI.peak);
if (Object.keys(override).length) setVizParams(override);

const SECONDS = Number(process.argv.slice(2).find((a) => !a.startsWith("--")) || 12);
const sp = new Spectrum(canvasStub, SR);
sp.setMode("mix");
sp.applyParams(); // 覆盖过参数就重建频段增益，没覆盖等于原样
if (Object.keys(override).length) console.log("参数覆盖：" + JSON.stringify(override));
const td = new Float32Array(N);
const STATS = { rough: [], max: [], pegged: [], mean: [], shimmer: [], low: [], mid: [], high: [], pin: [], lowMax: [], lowPin: [] };
/* 低 / 中 / 高频取样区间按实际柱数换算（原来写死 0-12 / 45-72 / 90-120 是 120 柱时定的）：
   低频前 10%、中频 37.5%~60%、高频后 25%，换柱数后分档含义不变。 */
const LOW_TO = Math.round(SRC_BAR_N * 0.1);
const MID_FROM = Math.round(SRC_BAR_N * 0.375);
const MID_TO = Math.round(SRC_BAR_N * 0.6);
const HIGH_FROM = Math.round(SRC_BAR_N * 0.75);
const meanOf = (v, from, to) => v.slice(from, to).reduce((a, b) => a + b, 0) / Math.max(1, to - from);
let prev = null;
let pumpFrame = 0;
const FRAMES = Math.round(SECONDS * 30); // 分析节拍 30Hz
const warm = Math.round(FRAMES * 0.35); // 前 35% 只当预热（一阶跟随要几帧才追上）
for (let f = 0; f < FRAMES; f++) {
  fill(td);
  sp.update(td, SR);
  sp.render(0.033);
  pumpFrame++;
  if (f < warm) { prev = Array.from(sp.levels); continue; }
  const v = Array.from(sp.levels);
  const max = Math.max(...v);
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  let rough = 0;
  for (let i = 1; i < v.length; i++) rough += Math.abs(v[i] - v[i - 1]);
  rough /= v.length - 1;
  let shr = 0;
  if (prev) for (let i = 0; i < v.length; i++) shr += Math.abs(v[i] - prev[i]);
  prev = v;
  STATS.rough.push(rough);
  STATS.max.push(max);
  STATS.mean.push(mean);
  STATS.pegged.push(v.filter((x) => x > 0.98).length);
  STATS.shimmer.push(shr / v.length);
  STATS.low.push(meanOf(v, 0, LOW_TO));
  /* "一直顶满"要看的是**整条谱的最高柱有多少帧贴着天花板**：
     某几根柱在一帧里很高不算问题，每帧都顶满才是用户说的"左侧一直顶满"。 */
  STATS.pin.push(max >= 0.98 ? 1 : 0);
  /* 用户说的"可视化左侧一直顶满"：只看低频那一段（前 10%）里最高的那根。
     lowPin = 这一帧左峰已经贴到天花板的比例；lowMax 是它的高度轨迹。 */
  const lowMax = Math.max(...v.slice(0, LOW_TO));
  STATS.lowMax.push(lowMax);
  STATS.lowPin.push(lowMax >= 0.98 ? 1 : 0);
  STATS.mid.push(meanOf(v, MID_FROM, MID_TO));
  STATS.high.push(meanOf(v, HIGH_FROM, SRC_BAR_N));
}
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
/* 标准差：低频均值在整段里的波动幅度 —— 越大说明左峰越"活"，不是死顶在天花板上 */
const stdOf = (a) => { const m = avg(a); return Math.sqrt(avg(a.map((x) => (x - m) * (x - m)))); };
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const f3 = (x) => x.toFixed(3);

/* ---------- 3b. 绘制侧：按详情区那块画布的真实宽度再画一帧，数柱与柱宽 ----------
   柱数变了以后"看着细密"落在这里：柱宽 = 画布宽 / 柱数 × 0.7（填充率）。
   画布桩原来只吞掉调用，这里临时换成会计数的版本，画完再还原。 */
const DRAW_W = 636; // 详情区频谱画布的 CSS 宽度（与 DESIGN 里那块一致）
const draw = { rects: 0, barWidths: new Map() };
const origFillRect = ctxStub.fillRect;
ctxStub.fillRect = (x, y, w, h) => {
  draw.rects++;
  if (h > 2) draw.barWidths.set(w, (draw.barWidths.get(w) || 0) + 1); // h = 2 是峰值线
};
canvasStub.width = DRAW_W;
canvasStub.height = 174;
sp.render(0.033);
ctxStub.fillRect = origFillRect;
const barW = Math.round((DRAW_W / SRC_BAR_N) * 0.7 * 100) / 100;

console.log("=== 频谱离线观测（合成信号 " + SECONDS + " 秒，分析 " + FRAMES + " 帧，样本 " + STATS.rough.length + "） ===");
console.log("柱数 = " + sp.levels.length + "（源码 BAR_N = " + SRC_BAR_N + "），级数 = 14，分析窗 = " + N + "，采样率 = " + SR);
{ // 频域塑形摘要：柱数变了这里**不应该**变（细针区间 / 低频峰频率 / 鼓点段位）
  const b = sp.bandInfo();
  console.log("频域：首段 " + b.firstHz + "Hz，末段 " + b.lastHz + "Hz，低频峰 " + b.bassPeakHz
    + "Hz，细针频段 " + b.needleBands + "，鼓点 " + b.kickBands + " 段");
}
if (sp.levels.length !== SRC_BAR_N) {
  console.error("柱数与源码 BAR_N 不一致：" + sp.levels.length + " != " + SRC_BAR_N);
  process.exit(3);
}
console.log("");
console.log("绘制（画布 " + DRAW_W + "×174，最后一帧）：");
console.log("  一帧 fillRect 共 " + draw.rects + " 次；柱宽 = " + DRAW_W + " / " + SRC_BAR_N + " × 0.7 = "
  + barW + "px（120 柱时是 " + (Math.round((DRAW_W / 120) * 0.7 * 100) / 100) + "px）");
console.log("  实际画出的柱（高度 > 2px）宽度取值：" + [...draw.barWidths.entries()]
  .map(([w, n]) => w + "px×" + n).join("、"));
console.log("");
console.log("最终柱高（最后一帧，每 10 根取一根）=");
const last = Array.from(sp.levels);
console.log("  " + last.filter((_, i) => i % 10 === 0).map((v, k) => (k * 10) + ":" + v.toFixed(2)).join("  "));
console.log("  最高 = " + f3(Math.max(...last)) + "，最低 = " + f3(Math.min(...last)) + "，平均 = " + f3(avg(last)));
console.log("");
console.log("整段统计：");
console.log("  平均最高柱 = " + f3(avg(STATS.max)) + "（越低越不「顶满」）");
console.log("  最高柱贴着 0.98 的帧占比 = " + (avg(STATS.pin) * 100).toFixed(1) + "%（「不要一直顶满」看这个：越低越不「一直」）");
console.log("  低频均值起伏（标准差）= " + f3(stdOf(STATS.low)) + "（越大左峰越活）");
console.log("  ★ 左峰（前 " + LOW_TO + " 根里的最高柱）：平均 " + f3(avg(STATS.lowMax))
  + "，顶到 0.98 的帧占比 " + (avg(STATS.lowPin) * 100).toFixed(1) + "%"
  + "，起伏 σ " + f3(stdOf(STATS.lowMax)) + "（越低 / 占比越小 = 越不「一直顶满」）");
console.log("  平均柱高 = " + f3(avg(STATS.mean)));
console.log("  顶到 0.98 以上的柱子数（平均每帧）= " + avg(STATS.pegged).toFixed(1) + " / " + SRC_BAR_N);
console.log("  低频（前 " + LOW_TO + " 根）平均 = " + f3(avg(STATS.low))
  + "  中频（" + MID_FROM + "–" + MID_TO + "）=" + f3(avg(STATS.mid))
  + "  高频（" + HIGH_FROM + "–" + SRC_BAR_N + "）=" + f3(avg(STATS.high)));
console.log("  相邻柱高差（越小越平整）= " + f3(avg(STATS.rough)) + "（中位 " + f3(q(STATS.rough, 0.5)) + "，p90 " + f3(q(STATS.rough, 0.9)) + "）");
console.log("  逐帧抖动（相邻两帧柱高变化）= " + avg(STATS.shimmer).toFixed(4) + "  ← 1.3.0 参数下的固有值（行波抖动 + 14 级量化）");
console.log("");
/* 结论判定。注意：**不拿"平不平/抖不抖"当好坏的唯一标准** ——
   用户 2026-09-25 明确要求"参数设置完全参照 1.3.0"，抖动与阶梯感是那一版的效果本身。
   这里只排除三种真正的坏情况，其余如实报数。 */
const maxAvg = avg(STATS.max);
const pegAvg = avg(STATS.pegged);
const flat = Math.max(...last) - Math.min(...last);
let verdict;
if (maxAvg > 0.999 && pegAvg > SRC_BAR_N * 0.5) verdict = "✗ 又顶满了（本帧峰值归一后整排贴 1.0，等于每根柱都是满高）";
else if (flat < 0.25) verdict = "✗ 太平（柱高没有层次，看不出频谱形状）";
else verdict = "✓ 有层次（低频厚、高频薄、随鼓点起伏），与 1.3.0 的参数一致；"
  + "抖动 " + avg(STATS.shimmer).toFixed(4) + " / 相邻柱高差 " + f3(avg(STATS.rough)) + " 就是那一版的固有观感，未做额外平滑";
console.log("结论：" + verdict);
