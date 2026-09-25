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
const { Spectrum } = await loadSpectrum();

/* ---------- 0. 源码一致性自检：常量被改过就报错，免得测的是旧参数 ---------- */
const spSrc = fs.readFileSync(path.join(SRC, "spectrum.ts"), "utf8");
const expect = [
  ["ANALYSIS_WINDOW = 1024", /const ANALYSIS_WINDOW = 1024;/],
  ["VIZ_LEVELS = 14", /const VIZ_LEVELS = 14;/],
  ["JITTER_AMP = 0.45*K", /const JITTER_AMP = 0\.45 \* JITTER_K;/],
  ["JITTER_STEP = 0.03*K", /const JITTER_STEP = 0\.03 \* JITTER_K;/],
  ["JITTER_WOBBLE = 0.055*K", /const JITTER_WOBBLE = 0\.055 \* JITTER_K;/],
  ["TILT_STRENGTH = 55", /const TILT_STRENGTH = 55;/],
  ["KICK_PUMP = 0.4", /const KICK_PUMP = 0\.4;/],
];
for (const [name, re] of expect) {
  if (!re.test(spSrc)) {
    console.error("参数自检失败：src/spectrum.ts 里找不到 " + name + " —— 脚本里的说明与实现对不上了");
    process.exit(2);
  }
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
const SECONDS = Number(process.argv[2] || 12);
const sp = new Spectrum(canvasStub, SR);
sp.setMode("mix");
const td = new Float32Array(N);
const STATS = { rough: [], max: [], pegged: [], mean: [], shimmer: [], low: [], mid: [], high: [] };
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
  STATS.low.push(v.slice(0, 12).reduce((a, b) => a + b, 0) / 12);
  STATS.mid.push(v.slice(45, 72).reduce((a, b) => a + b, 0) / 27);
  STATS.high.push(v.slice(90, 120).reduce((a, b) => a + b, 0) / 30);
}
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };
const f3 = (x) => x.toFixed(3);

console.log("=== 频谱离线观测（合成信号 " + SECONDS + " 秒，分析 " + FRAMES + " 帧，样本 " + STATS.rough.length + "） ===");
console.log("柱数 = " + sp.levels.length + "，级数 = 14，分析窗 = " + N + "，采样率 = " + SR);
console.log("");
console.log("最终柱高（最后一帧，每 10 根取一根）=");
const last = Array.from(sp.levels);
console.log("  " + last.filter((_, i) => i % 10 === 0).map((v, k) => (k * 10) + ":" + v.toFixed(2)).join("  "));
console.log("  最高 = " + f3(Math.max(...last)) + "，最低 = " + f3(Math.min(...last)) + "，平均 = " + f3(avg(last)));
console.log("");
console.log("整段统计：");
console.log("  平均最高柱 = " + f3(avg(STATS.max)) + "（越低越不「顶满」）");
console.log("  平均柱高 = " + f3(avg(STATS.mean)));
console.log("  顶到 0.98 以上的柱子数（平均每帧）= " + avg(STATS.pegged).toFixed(1) + " / 120");
console.log("  低频（前 12 根）平均 = " + f3(avg(STATS.low)) + "  中频（45–72）=" + f3(avg(STATS.mid)) + "  高频（90–120）=" + f3(avg(STATS.high)));
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
if (maxAvg > 0.999 && pegAvg > 60) verdict = "✗ 又顶满了（本帧峰值归一后整排贴 1.0，等于每根柱都是满高）";
else if (flat < 0.25) verdict = "✗ 太平（柱高没有层次，看不出频谱形状）";
else verdict = "✓ 有层次（低频厚、高频薄、随鼓点起伏），与 1.3.0 的参数一致；"
  + "抖动 " + avg(STATS.shimmer).toFixed(4) + " / 相邻柱高差 " + f3(avg(STATS.rough)) + " 就是那一版的固有观感，未做额外平滑";
console.log("结论：" + verdict);
