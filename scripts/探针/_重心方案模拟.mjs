/**
 * _重心方案模拟.mjs — 把「视觉重心 6:4」的可能变换方案先算一遍数值，筛出有效的。
 *
 * 目标量：左右半重量比 L:R（左半 = bar0..47，右半 = bar48..95），当前 1.896 ≈ 6.5:3.5。
 * 方案：
 *   A. shift(k)        内容整体右移 k 格（最左 k 格归零）
 *   B. gamma(g)        柱高全局幂变换 h^g（g<1 提低值柱）
 *   C. hgain(a,start)  从 bar=start 到 95 线性增益 1→a（右半渐进增强）
 *   D. shift + 组合
 *
 * 用法：node scripts/探针/_重心方案模拟.mjs
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const data = JSON.parse(readFileSync(resolve(ROOT, "dist/_sm2出图.json"), "utf8"));
const row = data.rows.find((r) => r.name.includes("实测档"));
const frames = row.frames; // 79 × 96
const N = 96, HALF = 48;

function shift(src, k) {
  const out = new Array(N).fill(0);
  for (let i = k; i < N; i++) out[i] = src[i - k];
  return out;
}

/* 各变换：输入 bars → 输出 bars */
const T = {
  '现状 k=0': (b) => b,
  '平移 k=2': (b) => shift(b, 2),
  '平移 k=4': (b) => shift(b, 4),
  '平移 k=6': (b) => shift(b, 6),
  '平移 k=8': (b) => shift(b, 8),
  'γ=0.85': (b) => b.map((h) => Math.pow(h, 0.85)),
  'γ=0.80': (b) => b.map((h) => Math.pow(h, 0.80)),
  'γ=0.75': (b) => b.map((h) => Math.pow(h, 0.75)),
  '右增益 1.5(起24)': (b) => b.map((h, i) => i < 24 ? h : h * (1 + 0.5 * (i - 24) / (N - 1 - 24))),
  '右增益 2.0(起24)': (b) => b.map((h, i) => i < 24 ? h : h * (1 + 1.0 * (i - 24) / (N - 1 - 24))),
  '右增益 1.5(起48)': (b) => b.map((h, i) => i < 48 ? h : h * (1 + 0.5 * (i - 48) / (N - 1 - 48))),
  '右增益 2.0(起48)': (b) => b.map((h, i) => i < 48 ? h : h * (1 + 1.0 * (i - 48) / (N - 1 - 48))),
  '平移4+γ0.85': (b) => shift(b, 4).map((h) => Math.pow(h, 0.85)),
  '平移4+右增益1.6': (b) => shift(b, 4).map((h, i) => i < 24 ? h : h * (1 + 0.6 * (i - 24) / (N - 1 - 24))),
};

console.log("方案                  合计比L:R   折合比例    逐帧比中位   质心%");
console.log("--------------------------------------------------------------------------");
for (const [name, fn] of Object.entries(T)) {
  let L = 0, R = 0, WS = 0, SUM = 0;
  const perFrame = [], cents = [];
  for (const b of frames) {
    const t = fn(b);
    let l = 0, r = 0, ws = 0, s = 0;
    for (let i = 0; i < N; i++) {
      const h = t[i] ?? 0;
      if (i < HALF) l += h; else r += h;
      s += h; ws += i * h;
    }
    L += l; R += r; WS += ws; SUM += s;
    perFrame.push(r > 1e-9 ? l / r : Infinity);
    cents.push(s > 1e-9 ? ws / s : 47.5);
  }
  const ratio = L / R;
  const med = median(perFrame);
  const lp = ratio / (1 + ratio) * 10;
  console.log(
    `${name.padEnd(20)}  ${ratio.toFixed(3)}      ${lp.toFixed(1)}:${(10 - lp).toFixed(1)}      ${med.toFixed(3)}       ${(WS / SUM / (N - 1) * 100).toFixed(1)}%`
  );
}

function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* 附：单帧样本（看方案在不同帧上的分布） */
console.log("\n单帧样本（f000 / 中位帧 / 最左重帧）: 左:右比");
const ratiosPer = frames.map((b) => {
  let l = 0, r = 0;
  for (let i = 0; i < N; i++) { if (i < HALF) l += b[i]; else r += b[i]; }
  return r > 1e-9 ? l / r : Infinity;
});
const medR = median(ratiosPer);
let midIdx = 0, maxIdx = 0;
ratiosPer.forEach((v, i) => {
  if (Math.abs(v - medR) < Math.abs(ratiosPer[midIdx] - medR)) midIdx = i;
  if (v > ratiosPer[maxIdx]) maxIdx = i;
});
console.log(`  f000 r=${ratiosPer[0].toFixed(2)}   中位帧 f${String(midIdx).padStart(3, '0')} r=${ratiosPer[midIdx].toFixed(2)}   最左重帧 f${String(maxIdx).padStart(3, '0')} r=${ratiosPer[maxIdx].toFixed(2)}`);
