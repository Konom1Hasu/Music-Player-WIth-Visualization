/*
 * 节拍预分析验证：不启动浏览器、不需要音频设备，直接跑 src/beatmap.ts 那条离线流水线。
 *
 * 为什么要这个脚本：预分析是"后台悄悄干的事"——算没算对、提前点亮有没有真的提前，
 * 界面上看不出来（画面一直在动）。所以这里把三段都搬进 Node：
 *   ① 合成一段**已知节拍**的点击轨（120 BPM，鼓点在 t=0.25+k·0.5，20~32 秒是副歌）；
 *   ② 跑 analyzeMono，拿算出来的拍点跟真值比；
 *   ③ 再把它喂给 Spectrum，量"有乐谱 / 没乐谱"时柱高到底差多少。
 *
 * 另有 W 组专门钉一条硬约束：analyzeMono 必须**自包含**（worker 是用
 * `analyzeMono.toString()` 拼出来的，一旦引用了模块作用域就是 ReferenceError）。
 * 验法是把 toString 的结果重新求值成一个函数，跑同一个输入，要求结果逐位相同。
 *
 * 用法：node scripts\节拍预分析验证.mjs
 *      （脚本会自己带 --experimental-transform-types 重启一次：源码是 .ts）
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "..", "app-rhine", "src");

async function loadModule(file) {
  const url = pathToFileURL(path.join(SRC, file)).href; // Windows 上不能把 "D:\..." 丢给 import()
  try {
    return await import(url);
  } catch (e) {
    if (!/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|ERR_UNKNOWN_FILE_EXTENSION/.test(String(e && e.code))) throw e;
    if (!process.env.RHINE_BEAT_RETRY) {
      console.log("（首次加载被 Node 的 strip-only 模式拒绝，带 --experimental-transform-types 重跑一次）");
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
        { stdio: "inherit", env: { ...process.env, RHINE_BEAT_RETRY: "1" } },
      );
      process.exit(r.status === null ? 1 : r.status);
    }
    throw e;
  }
}

const BM = await loadModule("beatmap.ts");
const SP = await loadModule("spectrum.ts");
const { analyzeMono, sampleBeatMap, preheatAt, BEAT_VERSION, PRE_SR, BEAT_PRE_ROLL } = BM;
const { Spectrum } = SP;

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
const median = (arr) => {
  const s = arr.slice().sort((x, y) => x - y);
  return s.length ? s[s.length >> 1] : 0;
};

/* ---------- 0. 源码一致性自检 ---------- */
console.log("=== 0. 源码常量自检（改了实现这里先红） ===");
const bmSrc = fs.readFileSync(path.join(SRC, "beatmap.ts"), "utf8");
const spSrc = fs.readFileSync(path.join(SRC, "spectrum.ts"), "utf8");
const srcExpect = [
  ["beatmap.ts: PRE_SR = 8000", /export const PRE_SR = 8000;/],
  ["beatmap.ts: BEAT_VERSION = 1", /export const BEAT_VERSION = 1;/],
  ["beatmap.ts: BEAT_PRE_ROLL = 0.028", /export const BEAT_PRE_ROLL = 0\.028;/],
  ["beatmap.ts: 自包含约定写在文件头", /必须\*\*完全自包含\*\*/],
  ["spectrum.ts: BEAT_PREHEAT_EXPAND", /const BEAT_PREHEAT_EXPAND = /],
  ["spectrum.ts: BEAT_FORM_TIP（每小节换形态）", /const BEAT_FORM_TIP = \[/],
  ["spectrum.ts: 先验只抬上限不替换（取 max）", /if \(this\.bkick > this\.kickEnergy\) this\.kickEnergy = this\.bkick;/],
  ["spectrum.ts: 没有乐谱时先验全为 0", /if \(!this\.beat \|\| this\.playhead < 0\)/],
];
for (const [name, re] of srcExpect) ok(re.test(bmSrc) || re.test(spSrc), name);

/* ---------- 1. 合成一段"已知答案"的点击轨 ---------- */
const SR = PRE_SR;
const DUR = 40;
const BPM_TRUE = 120;
const CHORUS = [20, 32]; // 副歌区间（秒）
function makeClickTrack() {
  const n = Math.round(SR * DUR);
  const x = new Float32Array(n);
  const period = 60 / BPM_TRUE;
  const truth = [];
  /* 底鼓：每个拍点一次 55Hz + 41Hz 的衰减爆发（低频能量包络的来源） */
  for (let t = 0.25; t < DUR - 0.3; t += period) {
    truth.push(t);
    const i0 = Math.round(t * SR);
    const len = Math.round(0.22 * SR);
    for (let i = 0; i < len && i0 + i < n; i++) {
      const tt = i / SR;
      const env = Math.exp(-tt / 0.085);
      x[i0 + i] += env * (Math.sin(2 * Math.PI * 55 * tt) * 0.9 + Math.sin(2 * Math.PI * 41 * tt) * 0.5);
    }
  }
  /* 八分踩镲：给"宽带敲击"一点素材（比底鼓弱得多，不该抢走节拍网格） */
  for (let t = 0.125; t < DUR - 0.05; t += period / 2) {
    const i0 = Math.round(t * SR);
    const len = Math.round(0.03 * SR);
    for (let i = 0; i < len && i0 + i < n; i++) {
      x[i0 + i] += (Math.random() * 2 - 1) * 0.10 * Math.exp(-(i / SR) / 0.008);
    }
  }
  /* 底噪 + 贝斯 + 副歌整体抬增益（响度包络的来源） */
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const g = t >= CHORUS[0] && t < CHORUS[1] ? 2.0 : 1.0;
    const bass = 0.06 * Math.sin(2 * Math.PI * 110 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.25 * t));
    const pad = 0.02 * (Math.random() * 2 - 1);
    x[i] = (x[i] + bass + pad) * g;
  }
  return { x, truth };
}
const { x, truth } = makeClickTrack();

/* ---------- 2. 跑预分析 ---------- */
console.log("\n=== 1. 离线分析：合成点击轨 " + DUR + "s / " + BPM_TRUE + " BPM / 副歌 " + CHORUS[0] + "~" + CHORUS[1] + "s ===");
const t0 = Date.now();
const bm = analyzeMono(x, SR);
const cost = Date.now() - t0;
console.log(
  "  用时 " + cost + "ms　→　" +
    bm.bpm.toFixed(2) + " BPM、" + bm.beats.length + " 个拍点、时长 " + bm.dur.toFixed(2) + "s、" +
    "包络 " + bm.lowE.length + " 帧@" + bm.fps.toFixed(1) + "Hz",
);
ok(bm.v === BEAT_VERSION, "结果带版本号", "v=" + bm.v);
ok(near(bm.dur, DUR, 0.2), "时长对得上", bm.dur.toFixed(2) + "s vs " + DUR + "s");
ok(near(bm.fps, SR / 128, 0.01), "包络帧率 = 采样率/跳步", bm.fps.toFixed(2) + "Hz");
ok(bm.lowE.length > 0 && bm.loud.length > 0, "低频包络与响度包络都非空");
ok(near(bm.t0, (512 - 128) / SR, 0.0001), "窗的等效时刻偏移 = (WIN−HOP)/sr",
  (bm.t0 * 1000).toFixed(1) + "ms");

console.log("\n=== 2. 拍点网格（" + truth.length + " 个真值拍点） ===");
ok(near(bm.bpm, BPM_TRUE, 3), "BPM 落在真值 ±3 以内", bm.bpm.toFixed(2) + " vs " + BPM_TRUE);
ok(Math.abs(bm.beats.length - truth.length) <= 4, "拍点数对得上", bm.beats.length + " vs " + truth.length);
ok(near(bm.period, 60 / BPM_TRUE, 0.02), "平均拍长对得上", bm.period.toFixed(4) + "s vs " + (60 / BPM_TRUE).toFixed(4) + "s");
/* 对齐误差：每个真值拍点找最近的算出来拍点 */
const errs = truth.map((t) => {
  let best = 1e9;
  for (let i = 0; i < bm.beats.length; i++) {
    const d = Math.abs(bm.beats[i] - t);
    if (d < best) best = d;
  }
  return best;
});
const medErr = median(errs);
const worst = Math.max(...errs);
const signed = median(truth.map((t) => {
  let best = 1e9, bd = 0;
  for (let i = 0; i < bm.beats.length; i++) {
    const d = bm.beats[i] - t;
    if (Math.abs(d) < best) { best = Math.abs(d); bd = d; }
  }
  return bd;
}));
console.log("  对齐误差：中位数 " + (medErr * 1000).toFixed(1) + "ms、最差 " + (worst * 1000).toFixed(1) + "ms"
  + "、带符号中位数 " + (signed * 1000).toFixed(1) + "ms");
ok(medErr <= 0.03, "拍点对齐中位数 ≤ 30ms", (medErr * 1000).toFixed(1) + "ms");
ok(worst <= 0.09, "最差拍点也在半拍内", (worst * 1000).toFixed(1) + "ms");
/* ★ 系统偏移必须接近 0：偏早 48ms（不补 t0 时的实测值）等于把"延迟"换个方向继续存在 */
ok(Math.abs(signed) <= 0.012, "没有系统性偏早/偏晚（|带符号中位数| ≤ 12ms）", (signed * 1000).toFixed(1) + "ms");
let ampMin = 255;
let ampMax = 0;
for (let i = 0; i < bm.amp.length; i++) {
  ampMin = Math.min(ampMin, bm.amp[i]);
  ampMax = Math.max(ampMax, bm.amp[i]);
}
ok(ampMin > 0, "每一拍都有强度（弱拍不归零）", "min=" + ampMin + " max=" + ampMax);
ok(bm.beats.every((v, i) => i === 0 || v > bm.beats[i - 1]), "拍点严格递增");

/* ---------- 2b. 换一个非常规速度：折叠逻辑不能把 90 读成 180 ----------
   自相关在"倍速"上天然摇摆（90 的偶数倍谐波很强），折叠区间写错就会 90→180。
   这条单独造一段 90 BPM 的轨来钉住它。 */
console.log("\n=== 2b. 非常规速度：90 BPM（不能读成 180 / 45） ===");
function makeTrackAt(bpm) {
  const nn = Math.round(SR * 30);
  const y = new Float32Array(nn);
  const p = 60 / bpm;
  for (let t = 0.25; t < 30 - 0.3; t += p) {
    const i0 = Math.round(t * SR);
    const len = Math.round(0.22 * SR);
    for (let i = 0; i < len && i0 + i < nn; i++) {
      const tt = i / SR;
      const env = Math.exp(-tt / 0.085);
      y[i0 + i] += env * (Math.sin(2 * Math.PI * 58 * tt) * 0.9 + Math.sin(2 * Math.PI * 43 * tt) * 0.5);
    }
  }
  for (let i = 0; i < nn; i++) y[i] += 0.02 * (Math.random() * 2 - 1);
  return y;
}
const bm90 = analyzeMono(makeTrackAt(90), SR);
console.log("  90 BPM 轨 → 测出 " + bm90.bpm.toFixed(2) + " BPM，" + bm90.beats.length + " 拍（真值 45）");
ok(near(bm90.bpm, 90, 4), "90 BPM 不被折叠成 180/45", bm90.bpm.toFixed(2));
ok(Math.abs(bm90.beats.length - 45) <= 3, "90 BPM 的拍点数对得上", String(bm90.beats.length));

/* ---------- 3. 提前点亮（这次的核心收益） ---------- */
console.log("\n=== 3. 提前点亮：BEAT_PRE_ROLL = " + (BEAT_PRE_ROLL * 1000).toFixed(0) + "ms ===");
const k = 20;
const tb = bm.beats[k];
const at = (dt) => sampleBeatMap(bm, tb + dt);
const rows = [
  [-0.20, "拍点前 200ms"],
  [-0.10, "拍点前 100ms"],
  [-BEAT_PRE_ROLL - 0.002, "提前量之外（差 2ms）"],
  [-BEAT_PRE_ROLL * 0.5, "提前量一半"],
  [-0.002, "拍点前 2ms"],
  [0, "拍点正当时"],
  [0.05, "拍点后 50ms"],
  [0.20, "拍点后 200ms（应已落下）"],
];
for (const [dt, name] of rows) {
  const s = at(dt);
  console.log("  " + name.padEnd(24) + " kick=" + s.kick.toFixed(3));
}
ok(at(-0.1).kick === 0, "提前量之外完全不亮", "kick=" + at(-0.1).kick);
ok(at(-BEAT_PRE_ROLL * 0.5).kick > 0.3, "进入提前量就开始升", "kick=" + at(-BEAT_PRE_ROLL * 0.5).kick.toFixed(3));
/* 「接近满值」是相对**这一拍自己的强度**（amp 弱拍本来就低），不是相对 1.0 */
ok(at(-0.002).kick >= 0.9 * (bm.amp[k] / 255), "拍点前 2ms 已达这一拍强度的 90%",
  at(-0.002).kick.toFixed(3) + " / " + (bm.amp[k] / 255).toFixed(3));
ok(at(-0.002).kick >= at(-BEAT_PRE_ROLL * 0.5).kick, "越接近拍点越亮（单调）");
ok(at(0.2).kick === 0, "拍点后 200ms 已经收干净", "kick=" + at(0.2).kick);
ok(at(0.05).kick > 0 && at(0.05).kick < at(-0.002).kick, "拍后按鼓皮衰减（不是一刀切）");

/* 提前量本身要够"提前"、又不能过头（~30ms 是人眼的同时阈值） */
const rampStart = (() => {
  for (let dt = -0.06; dt <= 0; dt += 0.001) if (sampleBeatMap(bm, tb + dt).kick > 0.001) return -dt;
  return 0;
})();
console.log("  实测开始点亮时刻：拍点前 " + (rampStart * 1000).toFixed(0) + "ms");
ok(rampStart >= 0.02 && rampStart <= BEAT_PRE_ROLL + 0.003, "提前量落在 20~31ms", (rampStart * 1000).toFixed(0) + "ms");

/* ---------- 4. 小节编排（每 4 拍换一次形态） ---------- */
console.log("\n=== 4. 小节编排：每 4 拍换一次柱体形态 ===");
const forms = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => sampleBeatMap(bm, bm.beats[i] + 0.001).form);
console.log("  前 8 拍的形态编号：" + forms.join(" "));
ok(forms.join(",") === "0,0,0,0,1,1,1,1", "每 4 拍（一小节）变一次", forms.join(","));
const bars = [0, 4, 8, 12].map((i) => sampleBeatMap(bm, bm.beats[i] + 0.001).inBar);
ok(bars.join(",") === "0,0,0,0", "每小节第一拍的 inBar 都是 0", bars.join(","));
ok(sampleBeatMap(bm, bm.beats[1] + 0.001).inBar === 1, "小节第二拍 inBar = 1");

/* ---------- 5. 副歌预热 ---------- */
console.log("\n=== 5. 副歌预热：副歌在 " + CHORUS[0] + "s 进入 ===");
const phRows = [[5, "副歌前很早"], [15, "副歌前 5 秒"], [18.4, "副歌前 1.6 秒"], [19.5, "副歌前 0.5 秒"], [25, "副歌正中"], [35, "副歌结束之后"]];
for (const [t, name] of phRows) {
  console.log("  " + name.padEnd(18) + " t=" + String(t).padStart(5) + "s  preheat=" + preheatAt(bm, t).toFixed(3));
}
ok(preheatAt(bm, 5) < 0.05, "离副歌远时不预热", preheatAt(bm, 5).toFixed(3));
/* 2.5 秒的前瞻窗里只有 1.6 秒是副歌，所以这里是"三分之一热"——
   阈值按这个几何关系给（0.35），到副歌前 0.5 秒会满（下面那条查的就是它） */
ok(preheatAt(bm, 18.4) > 0.35, "副歌前 1.6 秒已开始预热", preheatAt(bm, 18.4).toFixed(3));
ok(preheatAt(bm, 19.5) >= preheatAt(bm, 18.4) - 0.02, "越接近副歌越热（不回落）");
ok(preheatAt(bm, 25) < 0.2, "已经在副歌里就收掉（不再叠加热）", preheatAt(bm, 25).toFixed(3));

/* ---------- 6. 没有乐谱时必须完全无副作用 ---------- */
console.log("\n=== 6. 没有乐谱时：先验必须**完全退场** ===");
const none = sampleBeatMap(null, 12.34);
ok(none.kick === 0 && none.preheat === 0 && none.form === 0 && none.energy === 0 && none.idx === -1,
  "sampleBeatMap(null) 全零", JSON.stringify(none));
const zeroBeats = sampleBeatMap({ ...bm, beats: new Float32Array(0), amp: new Uint8Array(0), bpm: 0, period: 0 }, 12);
ok(zeroBeats.kick === 0 && zeroBeats.form === 0, "测不出 BPM 的歌：只有包络、不编排", "kick=" + zeroBeats.kick);
ok(preheatAt({ ...bm, loud: new Uint8Array(0) }, 12) === 0, "没有响度包络时预热为 0");

/* ---------- 7. 装进 Spectrum：观感到底变没变 ---------- */
console.log("\n=== 7. 装进 Spectrum（同一段信号，有/无乐谱逐位对比） ===");
const ctxStub = {
  clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, stroke() {},
  createLinearGradient: () => ({ addColorStop() {} }),
  fillStyle: "", strokeStyle: "", globalAlpha: 1, lineWidth: 1,
};
const canvasStub = { width: 954, height: 716, getContext: () => ctxStub };
/* 用一段**没有鼓点**的稳态信号：这样柱高的差异只能来自先验，不会来自信号本身 */
const quiet = new Float32Array(1024);
for (let i = 0; i < quiet.length; i++) quiet[i] = 0.12 * Math.sin((2 * Math.PI * 220 * i) / SR);
function runOnce(withMap, playhead) {
  const sp = new Spectrum(canvasStub, SR);
  sp.setMode("mix");
  sp.applyParams();
  sp.setAdvanceInterval(20);
  sp.setPlayhead(playhead);
  if (withMap) sp.setBeatmap(bm);
  for (let n = 0; n < 6; n++) sp.update(quiet, SR);
  return Array.from(sp.levels);
}
const noMap = runOnce(false, 0);
const mapOff = runOnce(true, -1); // 装了乐谱但播放头未知（没播）
const mapOn = runOnce(true, bm.beats[k] - 0.002); // 正好在拍点前 2ms
let sameCount = 0;
for (let i = 0; i < noMap.length; i++) if (noMap[i] === mapOff[i]) sameCount++;
ok(sameCount === noMap.length, "播放头未知时与" + "「从没装过乐谱」逐位相同（无副作用）",
  sameCount + "/" + noMap.length);
const lowMean = (a) => {
  let s = 0;
  for (let i = 0; i < 22; i++) s += a[i];
  return s / 22;
};
console.log("  低频 22 根柱的均值：无乐谱 " + lowMean(noMap).toFixed(4) + "　拍点前 2ms " + lowMean(mapOn).toFixed(4));
ok(lowMean(mapOn) > lowMean(noMap) + 0.02, "拍点前低频柱确实被抬起来了（提前点亮可见）",
  "+" + (lowMean(mapOn) - lowMean(noMap)).toFixed(4));
const spDiag = (() => {
  const sp = new Spectrum(canvasStub, SR);
  sp.applyParams();
  sp.setBeatmap(bm);
  sp.setPlayhead(bm.beats[k] - 0.002);
  sp.update(quiet, SR);
  return sp.beatInfo();
})();
console.log("  诊断摘要：" + JSON.stringify(spDiag));
ok(spDiag.live === 1 && spDiag.bpm > 0 && spDiag.kick > 0.7, "beatInfo 报告了正在生效的先验", JSON.stringify(spDiag));
const spOff = (() => {
  const sp = new Spectrum(canvasStub, SR);
  sp.applyParams();
  sp.update(quiet, SR);
  return sp.beatInfo();
})();
ok(spOff.live === 0 && spOff.kick === 0 && spOff.preheat === 0, "没乐谱时 beatInfo 全为 0", JSON.stringify(spOff));

/* ---------- 8. W 组：worker 注入的等价性（文件头约束 ①） ---------- */
console.log("\n=== 8. W 组：analyzeMono 必须自包含（worker 靠 toString 注入） ===");
const fnSrc = analyzeMono.toString();
ok(!/BEAT_VERSION|PRE_SR|BEAT_PRE_ROLL|clamp01|sampleBeatMap/.test(fnSrc),
  "函数体里没有出现任何模块作用域标识符", "长度 " + fnSrc.length + " 字符");
let injected = null;
let injectErr = "";
try {
  injected = new Function("return " + fnSrc)();
} catch (e) {
  injectErr = String(e && e.message);
}
ok(typeof injected === "function", "toString 的结果能重新求值成函数", injectErr);
if (typeof injected === "function") {
  const bm2 = injected(x, SR);
  ok(bm2.bpm === bm.bpm, "注入版与直接调用：BPM 逐位相同", bm2.bpm + " vs " + bm.bpm);
  ok(bm2.beats.length === bm.beats.length, "注入版与直接调用：拍点数相同", bm2.beats.length + " vs " + bm.beats.length);
  let maxDiff = 0;
  for (let i = 0; i < Math.min(bm2.beats.length, bm.beats.length); i++)
    maxDiff = Math.max(maxDiff, Math.abs(bm2.beats[i] - bm.beats[i]));
  ok(maxDiff === 0, "注入版与直接调用：每个拍点逐位相同", "maxDiff=" + maxDiff);
  let eDiff = 0;
  for (let i = 0; i < bm.lowE.length; i++) eDiff = Math.max(eDiff, Math.abs(bm2.lowE[i] - bm.lowE[i]));
  ok(eDiff === 0, "注入版与直接调用：低频包络逐位相同", "maxDiff=" + eDiff);
}
/* 短到没法分析的输入不能抛 */
let shortOk = true;
try {
  const s = analyzeMono(new Float32Array(1000), SR);
  shortOk = s && s.beats.length === 0 && s.bpm === 0;
} catch {
  shortOk = false;
}
ok(shortOk, "输入过短时不抛异常、老实返回空乐谱");
/* 静音输入也不能抛，且不该编出一套假节拍 */
let silentOk = true;
let silentBpm = -1;
try {
  const s = analyzeMono(new Float32Array(SR * 8), SR);
  silentBpm = s.bpm;
  silentOk = true;
} catch {
  silentOk = false;
}
ok(silentOk, "全静音输入不抛异常", "bpm=" + silentBpm);

/* ---------- 汇总 ---------- */
console.log("\n" + "=".repeat(56));
console.log(fail === 0 ? `★ 节拍预分析：${pass} 项全绿` : `✗ 节拍预分析：${pass} 通过 / ${fail} 失败`);
console.log("=".repeat(56));
process.exit(fail === 0 ? 0 : 1);
