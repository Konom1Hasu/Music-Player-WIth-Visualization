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
const { Spectrum, setVizParams, clampVizParams, clampHeadroom, KICK_PUMP_MIN, vizParams } = await loadSpectrum();

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
  // 鼓点 / 瞬态检测器：这些常量同时被 player.ts 的 worker 插值使用，改了要一起看
  ["KICK_REF_ATTACK = 0.30", /const KICK_REF_ATTACK = 0\.30;/],
  ["KICK_REF_RELEASE = 0.16", /const KICK_REF_RELEASE = 0\.16;/],
  ["KICK_RISE_FLOOR = 0.02", /const KICK_RISE_FLOOR = 0\.02;/],
  ["KICK_RISE_GAIN = 3.2", /const KICK_RISE_GAIN = 3\.2;/],
  // 2026-10-03 新增：顶端高频抖动 + 音色灵敏度（数值本身可调，这里只核对常量还在）
  ["TOP_SHIMMER 存在", /const TOP_SHIMMER = [\d.]+;/],
  ["TOP_SHIMMER_RATE 存在", /const TOP_SHIMMER_RATE = [\d.]+;/],
  ["TIMBRE_EXP_BASS = 2.1", /const TIMBRE_EXP_BASS = 2\.1;/],
  ["TIMBRE_EXP_TREBLE 存在", /const TIMBRE_EXP_TREBLE = [\d.]+;/],
  ["TIMBRE_SHARPEN 存在", /const TIMBRE_SHARPEN = [\d.]+;/],
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
/* 量化级数不导出，但顶边方块的量级直接取决于它，所以也从源码里取（改级数这里会同步）。 */
const levelMatch = /const VIZ_LEVELS = (\d+);/.exec(spSrc);
if (!levelMatch) {
  console.error("参数自检失败：src/spectrum.ts 里没有 `const VIZ_LEVELS = <整数>;`");
  process.exit(2);
}
const SRC_VIZ_LEVELS = Number(levelMatch[1]);

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

/* ---------- 0c. 两处"看起来只是优化/平滑"的改动，用确定性检查盯住 ---------- */

/* (1) 加窗预计算：Goertzel 的输入从"每个频段现乘一遍 Hann"改成"先乘一遍存起来"，
       必须**逐位相同**（参考实现：每个频段现乘；两份代码在同一份数据上跑）。 */
{
  const N = 1024;
  const hann = new Float32Array(N);
  for (let i = 0; i < N; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  const td = new Float32Array(N);
  let seed = 12345; // 自带 LCG：不依赖 Math.random，两次运行必须一模一样
  for (let i = 0; i < N; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    td[i] = (seed / 0x3fffffff - 1) * 0.9;
  }
  const goertzel = (input, k) => {
    const co = 2 * Math.cos((2 * Math.PI * k) / N);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < N; i++) { const s0 = input[i] + co * s1 - s2; s2 = s1; s1 = s0; }
    return [s1, s2];
  };
  const refInput = new Float32Array(N);
  for (let i = 0; i < N; i++) refInput[i] = td[i] * hann[i]; // 旧写法：每个频段现乘
  const tw = new Float32Array(N);
  for (let i = 0; i < N; i++) tw[i] = td[i] * hann[i]; // 新写法：先乘一遍
  const ks = [3.7, 12.5, 55.25, 190.75];
  const same = ks.every((k) => {
    const a = goertzel(refInput, k), b = goertzel(tw, k);
    return a[0] === b[0] && a[1] === b[1];
  });
  console.log("加窗预计算（120 段不再各乘一遍 Hann）：逐位相同 " + (same ? "✓" : "✗ 不一致！"));
}

/* (2) 绘制插值的检查放在下面画布桩之后（需要 canvasStub）。 */

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

/* ---------- 2b. 绘制插值：分析 20ms 一 tick、画布 60fps 重画 ----------
   两者不成整数倍时，屏幕上会出现"有时隔一帧才动、有时隔两帧才动"的错拍，看起来就是卡
   （用户："怎么还更卡"）。这里用**可控时钟**验两件事：
   ① 一个 tick 之内每一帧画出来的值都在变（所以 60fps 显示器上是连续的）；
   ② 下一个 tick 到来时收敛到当前柱高（不是滞后一个节拍）。 */
{
  const sp = new Spectrum(canvasStub, 48000);
  sp.setMode("mix");
  sp.applyParams();
  sp.setAdvanceInterval(20);
  const loud = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) {
    const t = i / 48000;
    loud[i] = 0.5 * (Math.sin(2 * Math.PI * 55 * t) + 0.4 * Math.sin(2 * Math.PI * 110 * t));
  }
  const silence = new Float32Array(1024);
  let clock = 1000;
  const realNow = performance.now;
  performance.now = () => clock;
  try {
    for (let i = 0; i < 8; i++) { sp.update(loud, 48000); clock += 20; } // 先把柱高拉起来
    sp.update(silence, 48000); // 一次阶跃：柱高该往下掉
    const frames = [];
    for (const dt of [5, 5, 5]) { clock += dt; sp.render(0.016); frames.push(sp.snapshot().show[3]); }
    clock += 5;
    sp.render(0.016);
    const atTick = sp.snapshot().show[3]; // 正好一个节拍（20ms）之后
    const target = sp.snapshot().bars[3];
    const everyFrame = frames.every((v, i) => i === 0 || v !== frames[i - 1]);
    const converged = Math.abs(atTick - target) < 1e-6;
    console.log("绘制插值（20ms 分析 / 60fps 重画）：一个节拍内每帧都在变 " + (everyFrame ? "✓" : "✗")
      + "　节拍到时收敛到当前柱高 " + (converged ? "✓" : "✗")
      + "　样例 " + frames.map((v) => v.toFixed(3)).join(" → ") + " → " + atTick.toFixed(3)
      + "（目标 " + target.toFixed(3) + "）");
    console.log("");
  } finally {
    performance.now = realNow;
  }
}

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

/* ---------- 3c. --latency：柱高从 0 爬到稳态要多久（台阶响应，步长 = 分析节拍） ----------
   用户两次反馈"延迟感严重""没能好好反映高能量音色"。这个滞后有两段：
     ① 分析窗 1024 点 ≈ 21ms 的积分时间（两个版本一样，不是节拍的事）；
     ② 一阶跟随每 tick 才推一步 —— bars += (v−bars)·atk，atk = 0.70−0.20·i/n。
        所以"爬几 tick"是固定的，**换成毫秒就是 tick 数 × 分析节拍**：
        30Hz(33ms) 与 1.3.0 原版的 50Hz(20ms) 差 1.65 倍，高频那几根（atk 只有 0.5）差得最明显。
   这里直接按源码里的跟随公式做确定性模拟（不掺信号与抖动，数字可复现）：
   低频那根（i/n≈0）与高频那几根（i/n≈1）各算一遍。 */
if (CLI.latency !== undefined) {
  if (!/const atk = 0\.7 - 0\.2 \* \(i \/ n\);/.test(spSrc)) {
    console.error("参数自检失败：跟随系数 atk = 0.7 - 0.2 * (i/n) 在 src/spectrum.ts 里找不到了");
    process.exit(2);
  }
  const step = (frac) => {
    const atk = 0.7 - 0.2 * frac;
    let v = 0;
    const hits = {};
    for (let n = 1; n <= 40; n++) {
      v += (1 - v) * atk; // 台阶输入 v_target = 1
      if (hits.t50 === undefined && v >= 0.5) hits.t50 = n;
      if (hits.t90 === undefined && v >= 0.9) hits.t90 = n;
      if (hits.t90 !== undefined && n > hits.t90 + 2) break;
    }
    return hits;
  };
  const bass = step(0); // i/n ≈ 0：左侧低频那几根
  const high = step(1); // i/n ≈ 1：最右侧高频那几根
  console.log("=== 台阶响应：柱高从 0 爬到稳态要几 tick（跟随系数照 src/spectrum.ts） ===");
  console.log("  低频（i/n = 0，上升系数 0.70）：50% " + bass.t50 + " tick、90% " + bass.t90 + " tick");
  console.log("  高频（i/n = 1，上升系数 0.50）：50% " + high.t50 + " tick、90% " + high.t90 + " tick");
  console.log("");
  for (const [ms, name] of [[33, "改前：33ms（30Hz）"], [20, "改后：20ms（50Hz，1.3.0 原版的 vizInterval()）"]]) {
    console.log("  " + name);
    console.log("      低频到 90%：" + (bass.t90 * ms) + "ms　高频到 90%：" + (high.t90 * ms) + "ms");
  }
  console.log("  ⇒ 高能量 onset 跟上的时间缩短 1.65×（低频 66→40ms、高频 132→80ms），越靠右的高频越明显");
  console.log("  另外：分析窗本身 1024 点 ≈ 21ms 的积分时间 —— 两档一样，不是这次改的。");
  process.exit(0);
}

const SECONDS = Number(process.argv.slice(2).find((a) => !a.startsWith("--")) || 12);
const sp = new Spectrum(canvasStub, SR);
sp.setMode("mix");
sp.applyParams(); // 覆盖过参数就重建频段增益，没覆盖等于原样
if (Object.keys(override).length) console.log("参数覆盖：" + JSON.stringify(override));
const td = new Float32Array(N);
const STATS = { rough: [], max: [], pegged: [], mean: [], shimmer: [], topShimmer: [], low: [], mid: [], high: [], pin: [], lowMax: [], lowPin: [], topRough: [] };
/* 低 / 中 / 高频取样区间按实际柱数换算（原来写死 0-12 / 45-72 / 90-120 是 120 柱时定的）：
   低频前 10%、中频 37.5%~60%、高频后 25%，换柱数后分档含义不变。 */
const LOW_TO = Math.round(SRC_BAR_N * 0.1);
const MID_FROM = Math.round(SRC_BAR_N * 0.375);
const MID_TO = Math.round(SRC_BAR_N * 0.6);
const HIGH_FROM = Math.round(SRC_BAR_N * 0.75);
const meanOf = (v, from, to) => v.slice(from, to).reduce((a, b) => a + b, 0) / Math.max(1, to - from);
let prev = null;
let pumpFrame = 0;
const FRAMES = Math.round(SECONDS * 50); // 分析节拍 = 应用里的 50Hz（1.3.0 的 vizInterval() 返回 20ms）
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
  /* ★ prev 必须是**上一步的副本**（2026-10-03 修）：原来写 `prev = v` 直接赋引用，
     而 sp.levels 是内部复用数组，v[i] 与 prev[i] 恒等 → 所有"帧间变化"指标都会算出 0。
     所以 prev 一律用 .slice() 存副本。 */
  if (prev) for (let i = 0; i < v.length; i++) shr += Math.abs(v[i] - prev[i]);
  STATS.rough.push(rough);
  STATS.max.push(max);
  STATS.mean.push(mean);
  /* ★ 顶端帧间抖动（2026-10-03 新增）：只统计**高柱**（>0.5）的相邻两帧变化。
     整条光谱的"逐帧抖动"会被大量矮柱稀释（矮柱本来就不补抖、也没什么可抖的），
     用户说的"抖动太小"看的是顶端那批柱子活不活 —— 这个才是对应指标。 */
  {
    let ts = 0;
    let tn = 0;
    if (prev) {
      for (let i = 0; i < v.length; i++) {
        if (v[i] > 0.5 && prev[i] > 0.5) { ts += Math.abs(v[i] - prev[i]); tn++; }
      }
    }
    if (tn) STATS.topShimmer.push(ts / tn);
  }
  prev = v.slice(); // ★ 副本（见上面的说明）
  STATS.pegged.push(v.filter((x) => x > 0.98).length);
  STATS.shimmer.push(shr / v.length);
  /* ★ 顶端锯齿度（用户："不想要顶端变方块"）：只看**高柱**（>0.7）之间的相邻柱高差。
     平顶方块 = 相邻高柱高度几乎一样（差值趋近 0）；锯齿 = 差值是量化步长的量级。
     量化步长 = 1/13 ≈ 0.077，所以 0.05 以上就算"看得出参差"、0 就是死平。 */
  {
    const hist = v.filter((x) => x > 0.7);
    if (hist.length > 1) {
      let d = 0;
      let n = 0;
      for (let i = 1; i < v.length; i++) {
        if (v[i] > 0.7 && v[i - 1] > 0.7) { d += Math.abs(v[i] - v[i - 1]); n++; }
      }
      if (n) STATS.topRough.push(d / n);
    }
  }
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
console.log("  逐帧抖动（相邻两帧柱高变化，全谱平均）= " + avg(STATS.shimmer).toFixed(4) + "  ← 被矮柱稀释，仅供参考");
console.log("  ★ 顶端帧间抖动（高柱 >0.5 的相邻两帧变化）= " + (STATS.topShimmer.length ? avg(STATS.topShimmer).toFixed(4) : "n/a")
  + "  ← 用户说的「抖动」看这个：越大顶端越活");
console.log("  ★ 顶端锯齿度（高柱 >0.7 的相邻柱高差）= " + (STATS.topRough.length ? f3(avg(STATS.topRough)) : "n/a")
  + "（量化步长 0.077；越接近它就是越参差、越大越不「方块」）");
console.log("  ★ 顶端落差/周期见下面「顶边形态（稳态和弦）」一节 —— 那里信号不变，量的才是纯抖动");
console.log("");

/* ---------- 3d. 顶边形态：稳态和弦下会不会"糊成方块"（用户 2026-10-03："不想要顶端变方块"） ----------
   合成信号是**瞬态丰富**的，高柱天然参差，测不出"方块"。真正会糊成方块的场景是
   **稳态和弦 / 持续音**：频谱一段时间几乎不变，14 级量化后相邻高柱同落一级 → 顶边平直。
   这里喂一段"多正弦稳态"直接数高柱的相邻差，作为方块风险的度量。
   期望：既不是 0（死平方块），也不是只有量化步长的整数倍（生硬台阶）——
   量化后的顶端补抖应当让高柱相邻差落在**量化步长附近且带连续变化**。 */
{
  const sp2 = new Spectrum(canvasStub, SR);
  sp2.setMode("mix");
  sp2.applyParams();
  const steady = new Float32Array(N);
  // 稳态：一组固定频率、固定幅度的正弦（模拟持续和弦，频谱长时间不变）
  const partials = [55, 110, 165, 220, 330, 440, 660, 880, 1320, 1760];
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    let s = 0;
    for (const f of partials) s += Math.sin(2 * Math.PI * f * t);
    steady[i] = Math.max(-1, Math.min(1, s / partials.length));
  }
  for (let k = 0; k < 80; k++) sp2.update(steady, SR); // 跑到稳态
  const vv = Array.from(sp2.levels); // 原始参数下的稳态帧（下面"顶边形态"用这一帧）
  /* ★ 稳态下的时间序列（2026-10-03 新增）：信号**完全不变**，
     所以柱高在此后的任何起伏都只可能来自抖动层本身 —— 这才是"纯抖动"的量，
     不会被音乐动态或鼓点泵动污染（在瞬态信号上直接量极差会量到 0.5+ 的泵动，毫无意义）。
     抖动层有两路，周期差一个数量级：
       · 慢行波（jitterPhase，周期 ≈ 200+ 帧 ≈ 4.6 秒）—— "滑动感"那一路；
       · 顶端张力（topPhase，周期由 TOP_TENSION_RATE 决定）—— 用户现在关心的这一路。
     两路混在一起用滑动均值分不干净：张力一旦压慢到 50 帧量级，均值会把它一起跟住，
     读数反而失真。所以这里直接**把慢行波关掉**（jitterK = 0），剩下就是纯顶端张力。
     量三件事：
       · 落差（每根高柱的全程极差）→ 用户要的「高幅度、高落差」；
       · 帧间变化 → 用户不要的「高频率」；
       · 由二者反推周期：正弦近似下 变化率 ≈ 幅度 × 角频率，故 周期 ≈ π × 落差 / 帧间变化。 */
  const savedJitterK = vizParams.jitterK;
  setVizParams({ jitterK: 0 }); // 关掉慢行波与单边颤动，稳态下只剩顶端张力在动
  const STEADY_FRAMES = 240;
  const sLo = new Array(SRC_BAR_N).fill(Infinity);
  const sHi = new Array(SRC_BAR_N).fill(-Infinity);
  /* ★ 2026-10-03：把"慢摆幅"与"高频抖动"两个成分分开量。
     · sLoSlow/sHiSlow 存 **3 点滑动平均** 后的轨迹 —— 周期 3 帧的快抖会被平均掉，
       留下的就是慢摆幅（周期 28 帧，3 点平均只削它约 1%）。两者的极差对比即"叠加而非取代"。
     · 符号翻转率：同一根柱相邻帧变化量 Δ 的**正负翻转次数 / 样本数**。
       慢摆幅一个周期只翻 2 次（周期 28 帧 → 约 7%）；快抖几乎每 1~2 帧就翻（50%+）。
       这是"高频"最直接的读数，与"幅度"完全解耦。 */
  const sLoSlow = new Array(SRC_BAR_N).fill(Infinity);
  const sHiSlow = new Array(SRC_BAR_N).fill(-Infinity);
  let sJump = 0;
  let sJumpN = 0;
  let sPrev = null;
  let sPrev2 = null;
  let sDelta = new Array(SRC_BAR_N).fill(0);
  let sFlip = 0;
  let sFlipN = 0;
  for (let k = 0; k < STEADY_FRAMES; k++) {
    sp2.update(steady, SR);
    const cur = Array.from(sp2.levels);
    for (let i = 0; i < cur.length; i++) {
      if (cur[i] < sLo[i]) sLo[i] = cur[i];
      if (cur[i] > sHi[i]) sHi[i] = cur[i];
      if (sPrev && sPrev2) {
        const sm = (cur[i] + sPrev[i] + sPrev2[i]) / 3;
        if (sm < sLoSlow[i]) sLoSlow[i] = sm;
        if (sm > sHiSlow[i]) sHiSlow[i] = sm;
      }
    }
    if (sPrev) {
      for (let i = 0; i < cur.length; i++) {
        const d = cur[i] - sPrev[i];
        if (cur[i] > 0.5 && sPrev[i] > 0.5) {
          sJump += Math.abs(d);
          sJumpN++;
          if (Math.abs(d) > 1e-9 && Math.abs(sDelta[i]) > 1e-9) {
            sFlipN++;
            if ((d > 0) !== (sDelta[i] > 0)) sFlip++;
          }
        }
        sDelta[i] = d;
      }
    }
    sPrev2 = sPrev;
    sPrev = cur;
  }
  setVizParams({ jitterK: savedJitterK }); // 还原
  let sDropSum = 0;
  let sDropN = 0;
  for (let i = 0; i < SRC_BAR_N; i++) {
    if (sHi[i] > 0.7) { sDropSum += sHi[i] - sLo[i]; sDropN++; }
  }
  /* 慢成分落差：只用"高柱"的那批根（与上面同口径），但取自 3 点平均后的轨迹 */
  let sDropSlowSum = 0;
  let sDropSlowN = 0;
  for (let i = 0; i < SRC_BAR_N; i++) {
    if (sHi[i] > 0.7 && isFinite(sLoSlow[i])) { sDropSlowSum += sHiSlow[i] - sLoSlow[i]; sDropSlowN++; }
  }
  const sDrop = sDropN ? sDropSum / sDropN : 0;
  const sDropSlow = sDropSlowN ? sDropSlowSum / sDropSlowN : 0;
  const sJumpAvg = sJumpN ? sJump / sJumpN : 0;
  const sFlipRate = sFlipN ? sFlip / sFlipN : 0;
  const sPeriod = sJumpAvg > 1e-6 ? (Math.PI * sDrop) / sJumpAvg : 0; // 帧
  // 高柱相邻差（只统计相邻两根都 > 0.6 的）
  let d = 0, n = 0, same = 0;
  for (let i = 1; i < vv.length; i++) {
    if (vv[i] > 0.6 && vv[i - 1] > 0.6) {
      const gap = Math.abs(vv[i] - vv[i - 1]);
      d += gap; n++;
      if (gap < 0.02) same++; // 几乎等高 = 有"方"的苗头
    }
  }
  const step = 1 / (SRC_VIZ_LEVELS - 1);
  /* 抖动层的实际参数（从源码里读，方便对照调参） */
  const num = (re) => Number((re.exec(spSrc) || [])[1]);
  const shimmerAmp = num(/const TOP_SHIMMER = ([\d.]+);/);
  const shimmerRate = num(/const TOP_SHIMMER_RATE = ([\d.]+);/);
  console.log("=== 顶边形态（稳态和弦，" + n + " 对相邻高柱） ===");
  console.log("  高柱相邻平均差 = " + f3(n ? d / n : 0) + "（量化步长 " + step.toFixed(3) + "）");
  console.log("  近乎等高的相邻对占比 = " + (n ? ((same / n) * 100).toFixed(1) : "0") + "%（越低越不像方块）");
  console.log("  高柱高度样本（前 30 根 >0.6 的柱）= "
    + vv.filter((x) => x > 0.6).slice(0, 30).map((x) => x.toFixed(2)).join(" "));
  console.log("  ★ 纯张力落差（" + sDropN + " 根高柱，" + STEADY_FRAMES + " 帧内的极差均值）= " + f3(sDrop)
    + "  ← 用户要的「高幅度、高落差」看这个：越大摆幅越大");
  console.log("  ★ 慢成分落差（同上，但走 3 点滑动平均）= " + f3(sDropSlow)
    + "  ← 与上一行接近即证明「高频抖动是叠加在大摆幅上、没有取代它」");
  console.log("  ★ 符号翻转率 = " + (sFlipRate * 100).toFixed(1) + "%（" + sFlipN + " 个样本）"
    + "  ← 「高频抖动」的直接读数：关闭 TOP_SHIMMER 时实测 16%（慢摆幅自带一个 2.7 倍频成分），"
    + "叠加快抖后应显著抬高");
  console.log("  ★ 纯张力帧间变化 = " + sJumpAvg.toFixed(4) + "  ← 越大抖得越快（幅度 × 频率的合成）");
  console.log("  ★ 顶端周期 ≈ " + sPeriod.toFixed(1) + " 帧（" + (sPeriod / 50).toFixed(2) + " 秒）"
    + "  ← 这是按「单一正弦」反推的，叠加高频抖动后会被低估，只作参考");
  console.log("  抖动层：慢摆幅（TOP_TENSION）幅度 0.45×1.2 / 周期 ≈ " + (2 * Math.PI / 0.22).toFixed(1)
    + " 帧；高频抖动（TOP_SHIMMER）幅度 " + shimmerAmp + " / 周期 ≈ "
    + (shimmerAmp > 0 ? (2 * Math.PI / shimmerRate).toFixed(1) : "-") + " 帧");
  console.log("");
}
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
console.log("");

/* ---------- 4. 高速鼓点灵敏度（用户 2026-10-03："频谱对高速鼓点不够灵敏"） ----------
   合成一段**密集 kick** 的低频信号直接喂给 kick 检测器，量"每个 kick 能不能被单独触发"。
   检测器在 Spectrum.analyze() 里，但那段是私有的；这里按源码里的**同一组常量**复刻，
   并在开头做常量自检 —— 只要 spectrum.ts 里的 KICK_* 被改动，这里就报错提醒同步。
   信号：一串"指数衰减低频脉冲"（模拟鼓点），问隔可调，用 CLI --bpm= 控制速度。 */
{
  const need = [
    ["KICK_REF_ATTACK = 0.30", /const KICK_REF_ATTACK = 0\.30;/],
    ["KICK_REF_RELEASE = 0.16", /const KICK_REF_RELEASE = 0\.16;/],
    ["KICK_RISE_FLOOR = 0.02", /const KICK_RISE_FLOOR = 0\.02;/],
    ["KICK_RISE_GAIN = 3.2", /const KICK_RISE_GAIN = 3\.2;/],
  ];
  for (const [name, re] of need) {
    if (!re.test(spSrc)) {
      console.error("参数自检失败：src/spectrum.ts 里找不到 " + name + " —— 与本脚本的复刻对不上了");
      process.exit(2);
    }
  }
  const KICK_REF_ATTACK = 0.30, KICK_REF_RELEASE = 0.16, KICK_RISE_FLOOR = 0.02, KICK_RISE_GAIN = 3.2;
  const tickMs = 20; // 分析节拍（应用 50Hz）
  /* 检波器复刻：low 是"低频段平均原始幅度"，用衰减脉冲当输入。
     这里不跑 Goertzel（那是频谱），只关心 onset 检测的**时间响应**。 */
  const detect = (lows) => {
    let ref = 0;
    const outs = [];
    for (const low of lows) {
      if (ref <= 0) ref = low;
      const rise = (low - ref) / Math.max(ref, 1e-6);
      const kick = Math.max(0, Math.min(1, (rise - KICK_RISE_FLOOR) * KICK_RISE_GAIN));
      const k = low > ref ? KICK_REF_ATTACK : KICK_REF_RELEASE;
      ref += (low - ref) * k;
      outs.push(kick);
    }
    return outs;
  };
  const bpm = Number(CLI.bpm || 160);
  const beats = Math.round((SECONDS * 1000) / (60000 / bpm));
  const lows = [];
  for (let t = 0; t < SECONDS * 1000; t += tickMs) {
    let v = 0.15; // 底噪
    const beatPos = ((t % (60000 / bpm)) / (60000 / bpm)) * tickMs; // 本 tick 内距鼓点的位置
    const since = t % (60000 / bpm);
    v = 0.15 + 0.85 * Math.exp(-since / 45); // 45ms 衰减
    lows.push(v);
  }
  const kicks = detect(lows);
  /* 统计"有效触发"：kick > 0.5 的 tick 里，按最小间隔 40ms 合并成一次触发 */
  let fired = 0, lastHit = -1e9;
  for (let i = 0; i < kicks.length; i++) {
    if (kicks[i] > 0.5) {
      const at = i * tickMs;
      if (at - lastHit >= 40) { fired++; lastHit = at; }
    }
  }
  const peakAvg = avg(kicks);
  const maxKick = Math.max(...kicks);
  console.log("=== 高速鼓点灵敏度（BPM = " + bpm + "，" + SECONDS + " 秒内应有 " + beats + " 次鼓点） ===");
  console.log("  有效触发（kick > 0.5）= " + fired + " 次  → 命中率 " + ((fired / beats) * 100).toFixed(1) + "%");
  console.log("  平均 kick 强度 = " + f3(peakAvg) + "，峰值 = " + f3(maxKick) + "（越接近 1 越「每个鼓点都顶得起来」）");
  const sensVerdict = fired >= beats * 0.9 && maxKick > 0.85
    ? "✓ 密集鼓点基本不漏、且每次都能顶到近满"
    : "✗ 高速鼓点有漏触发或强度不足";
  console.log("  结论：" + sensVerdict);
  console.log("");
}

/* ---------- 5. 瞬态保真度（用户 2026-10-03："频谱最好能精细反映歌曲里的鼓点、音色"） ----------
   只靠低频 onset 时，只有底鼓会推起左峰 —— 军鼓 / 踩镲这类**宽带或高频**敲击
   在显示上几乎看不出来。这里给三种典型敲击各喂一 tick，量"哪一半柱子在抬"：
     · 底鼓型（55Hz）   → 应当抬 LOW 半区；
     · 军鼓型（2kHz+噪声）→ 应当抬 HIGH 半区；
     · 踩镲型（9kHz）   → 应当抬 HIGH 半区，且 LOW 半区几乎不动。
   判据是**相对关系**（升高的重心在正确的一侧），不依赖具体幅度，因此对音量不敏感。
   另外测"持续大音量不该被当成敲击"：底床连喂 60 tick 后 onset 门应当回落。 */
{
  const SRC_SPEC = fs.readFileSync(path.join(SRC, "spectrum.ts"), "utf8");
  const trBoost = Number((/const TRANSIENT_BOOST = ([\d.]+);/.exec(SRC_SPEC) || [])[1]);
  /* 确定性伪随机：保证多次运行读数一致 */
  let seed = 20261003;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x7fffffff) * 2 - 1; };
  const tone = (partials, noise, offset) => {
    const td = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const t = (offset + i) / SR;
      let s = 0;
      for (const [f, a] of partials) s += a * Math.sin(2 * Math.PI * f * t);
      if (noise) s += noise * rnd();
      td[i] = Math.max(-1, Math.min(1, s));
    }
    return td;
  };
  /* 底床：中低频铺底 + 少量宽带噪声，让整排柱子先站到中等高度。
     噪声量可用 --trbednoise= 覆盖：白噪声会在每个频段都产生微小通量，
     测试"频谱特异性"时应当把它关掉（那一层不是产品行为的问题）。 */
  const BED_NOISE = CLI.trbednoise !== undefined ? Number(CLI.trbednoise) : 0.06;
  const BED = [[160, 0.22], [320, 0.12]];
  const bed = (k) => tone(BED, BED_NOISE, k * N);
  const BURSTS = [
    ["底鼓型 55Hz", [[55, 0.95], [110, 0.3]], 0.02, "LOW"],
    ["军鼓型 2kHz+噪声", [[2000, 0.5]], 0.45, "HIGH"],
    ["踩镲型 9kHz", [[9000, 0.7], [12000, 0.3]], 0.05, "HIGH"],
  ];
  console.log("=== 瞬态保真度（敲击的频谱形状能不能看出来；抬升量 = 敲击这一 tick 的柱高增量） ===");
  console.log("  低半区 = 第 0–74 根（低频）；高半区 = 第 75–149 根（中高频）");
  let allPass = true;
  for (const [name, partials, noise, expectSide] of BURSTS) {
    const sp = new Spectrum(canvasStub, SR);
    sp.setMode("mix");
    sp.applyParams();
    sp.setAdvanceInterval(20);
    sp.resetPeaks();
    let off = 0;
    for (let k = 0; k < 60; k++) { sp.update(bed(k), SR); off += N; }
    const pre = Array.from(sp.levels);
    const bedOnset = sp.snapshot().transient;
    const fpreSnap = sp.snapshot().freq;
    sp.update(tone(partials, noise, off), SR);
    const post = Array.from(sp.levels);
    const hitOnset = sp.snapshot().transient;
    let lo = 0, hi = 0, bestAt = 0, best = -9;
    for (let i = 0; i < 75; i++) lo += post[i] - pre[i];
    for (let i = 75; SRC_BAR_N > i; i++) hi += post[i] - pre[i];
    for (let i = 0; i < post.length; i++) { const d = post[i] - pre[i]; if (d > best) { best = d; bestAt = i; } }
    lo /= 75; hi /= (SRC_BAR_N - 75);
    const preLo = pre.slice(0, 75).reduce((a, b) => a + b, 0) / 75;
    const preHi = pre.slice(75).reduce((a, b) => a + b, 0) / (SRC_BAR_N - 75);
    const side = lo > hi ? "LOW" : "HIGH";
    /* 三条判据：抬升重心在正确一侧、敲击时 onset 门确实打开、持续底床不误触发 */
    const ok = side === expectSide && hitOnset > 0.3 && best > 0.02 && bedOnset < 0.3;
    if (!ok) allPass = false;
    console.log("  " + name.padEnd(16) + " 低半区 +" + f3(lo) + "  高半区 +" + f3(hi)
      + "  （敲击前 低 " + f3(preLo) + " / 高 " + f3(preHi) + "）"
      + "  峰值柱 #" + bestAt + " (+" + f3(best) + ")"
      + "  onset 底床 " + f3(bedOnset) + " → 敲击 " + f3(hitOnset)
      + "  → 抬升重心 " + side + (ok ? " ✓" : " ✗（期望 " + expectSide + "）"));
    /* 粗粒度剖面（10 段）：确认抬升是不是"只落在它该在的频区"，而不是整排一起亮 */
    const BUCK = 10, w = SRC_BAR_N / BUCK;
    const prof = [];
    for (let b = 0; b < BUCK; b++) {
      let s = 0, c = 0;
      for (let i = Math.floor(b * w); i < Math.floor((b + 1) * w); i++) { s += post[i] - pre[i]; c++; }
      prof.push((s / Math.max(1, c)).toFixed(2));
    }
    console.log("      柱高增量剖面（低频→高频 10 段）：" + prof.join("  "));
    const fpre = fpreSnap, fpost = sp.snapshot().freq;
    const fp = [];
    for (let b = 0; b < 12; b++) {
      let s = 0, c = 0;
      for (let i = Math.floor(b * 120 / 12); i < Math.floor((b + 1) * 120 / 12); i++) { s += fpost[i] - fpre[i]; c++; }
      fp.push((s / Math.max(1, c)).toFixed(2));
    }
    console.log("      频段增量剖面（20Hz→10.8kHz 12 段）：" + fp.join(" "));
  }
  console.log("  瞬态强调系数 TRANSIENT_BOOST = " + trBoost + "（置 0 即关闭这一层）");
  console.log("  结论：" + (allPass
    ? "✓ 三种敲击各自抬起正确的半区，敲击的频谱形状被如实带出来"
    : "✗ 有敲击没有抬起正确的一侧（或 onset 门未打开）"));
  console.log("");
}

/* ---------- 6. 音色灵敏度（用户 2026-10-03："对歌曲的音色要更加敏感"） ----------
   音色就是频谱的**形状**。这里造两个"基频相同、响度相同、谐波结构相反"的稳态音：
     · 「暗」：110Hz 及其低次谐波（能量压在低频）；
     · 「亮」：110Hz 及高次泛音（5/8/12/16/20 次）。
   两者在"低频厚、高频薄"的大轮廓上几乎一样，差别只落在形状细节里 ——
   两个向量之间的距离越大，就说明频谱对音色的分辨力越强。
   ★ 稳态音下柱高仍带抖动，所以这里采 30 帧取平均把抖动抹掉，量的才是形状。
   ★ 对照方法：把 src/spectrum.ts 里的 TIMBRE_EXP_TREBLE 改回 2.1、TIMBRE_SHARPEN 改回 0
     再跑一次本脚本，即可看到"未做音色增强"时的距离读数（这次不自动改源码）。 */
{
  const mkTone = (partials) => {
    const td = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const t = i / SR;
      let s = 0;
      for (const [f, a] of partials) s += a * Math.sin(2 * Math.PI * f * t);
      td[i] = Math.max(-1, Math.min(1, s));
    }
    /* 归一化到相同 RMS：响度不参与比较，测的纯粹是形状 */
    let ms = 0;
    for (let i = 0; i < N; i++) ms += td[i] * td[i];
    const g = 0.5 / Math.max(1e-9, Math.sqrt(ms / N));
    for (let i = 0; i < N; i++) td[i] *= g;
    return td;
  };
  const DARK = [[110, 1], [220, 0.55], [330, 0.32], [440, 0.18]];
  const BRIGHT = [[110, 0.5], [550, 0.62], [880, 0.58], [1320, 0.5], [1760, 0.42], [2200, 0.34]];
  const steadyOf = (partials) => {
    const sp = new Spectrum(canvasStub, SR);
    sp.setMode("mix");
    sp.applyParams();
    sp.setAdvanceInterval(20);
    sp.resetPeaks();
    const td = mkTone(partials);
    for (let k = 0; k < 90; k++) sp.update(td, SR); // 跑到稳态
    const acc = new Array(SRC_BAR_N).fill(0);
    for (let k = 0; k < 30; k++) { // 采 30 帧平均：抹掉抖动，只留形状
      sp.update(td, SR);
      const v = sp.levels;
      for (let i = 0; i < v.length; i++) acc[i] += v[i] / 30;
    }
    return { bars: acc, freq: sp.snapshot().freq.slice(0, 120) };
  };
  const A = steadyOf(DARK);
  const B = steadyOf(BRIGHT);
  const l1 = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
  const avgRange = (a, from, to) => { let s = 0; for (let i = from; i < to; i++) s += a[i]; return s / (to - from); };
  const roughOf = (a) => { let s = 0; for (let i = 1; i < a.length; i++) s += Math.abs(a[i] - a[i - 1]); return s / (a.length - 1); };
  const HALF = Math.floor(SRC_BAR_N / 2);
  const peak = (a) => Math.max(...a);
  const barDist = l1(A.bars, B.bars);
  const freqDist = l1(A.freq, B.freq);
  const aHi = avgRange(A.bars, HALF, SRC_BAR_N);
  const bHi = avgRange(B.bars, HALF, SRC_BAR_N);
  const aLo = peak(A.bars.slice(0, Math.floor(SRC_BAR_N * 0.1)));
  const bLo = peak(B.bars.slice(0, Math.floor(SRC_BAR_N * 0.1)));
  const expTreble = Number((/const TIMBRE_EXP_TREBLE = ([\d.]+);/.exec(spSrc) || [])[1]);
  const sharp = Number((/const TIMBRE_SHARPEN = ([\d.]+);/.exec(spSrc) || [])[1]);
  console.log("=== 音色灵敏度（两个同基频、同响度的稳态音：低次谐波 vs 高次泛音） ===");
  console.log("  中高频半区（第 " + HALF + "–" + (SRC_BAR_N - 1) + " 根）平均柱高：暗音色 " + f3(aHi)
    + " / 亮音色 " + f3(bHi) + "（差 " + f3(bHi - aHi) + "）"
    + "  ← 差异越大 = 泛音结构越看得出来");
  console.log("  左峰高度：暗音色 " + f3(aLo) + " / 亮音色 " + f3(bLo) + "（差 " + f3(Math.abs(aLo - bLo)) + "）"
    + "  ← 越接近 = 高频细节没有把低频峰挤掉");
  console.log("  ★ 柱高形状距离（150 维 L1）= " + f3(barDist) + "  ← 用户在屏幕上能否分辨这两种音色，看这个");
  console.log("  ★ 频段形状距离（120 维 L1）= " + f3(freqDist) + "  ← 谱锐化那一层直接作用在这 120 段上");
  console.log("  相邻柱高差（细节度）：暗 " + f3(roughOf(A.bars)) + " / 亮 " + f3(roughOf(B.bars))
    + "  ← 越大 = 峰谷越分明（音色的「纹理」越清晰）");
  console.log("  音色层参数：幂次低端 2.1 → 高端 " + expTreble + "，谱锐化 " + sharp
    + "（置 2.1 / 0 即回到 1.3.0 的原始观感）");
  const ok = bHi > aHi + 0.02 && Math.abs(aLo - bLo) < 0.1 && barDist > 0.02;
  console.log("  结论：" + (ok
    ? "✓ 高次泛音型音色在中高频明显更高、低频峰高度基本不动 —— 频谱能分辨音色"
    : "✗ 两种音色的形状区分度不足（或低频峰被高频细节挤掉）"));
  console.log("");
}
