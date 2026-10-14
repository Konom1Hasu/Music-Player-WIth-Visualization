/**
 * _重心分析.mjs — 量化「视觉重心」：左右半重量比 + 加权质心
 *
 * 背景：用户反馈「视觉重心太靠左（左:右 ≈ 6:4）」。本脚本用数据量化该感受：
 *   - 重量比 = Σ(柱高[0..47]) / Σ(柱高[48..95])，中位数（79 帧逐帧算）
 *   - 质心   = Σ(i * h_i) / Σ(h_i)（0..95 坐标；中线 47.5；折算成百分比位置）
 *   - 同时算不同平移量 k=0..8 下的变化（out[i] = i>=k ? src[i-k] : 0）
 *
 * 数据来源：dist/_sm2出图.json（实测档 79 帧）+ dist/频谱画面-柱高.json（合成信号帧）
 * 用法：node scripts/探针/_重心分析.mjs
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");

function loadRows() {
  const j = JSON.parse(readFileSync(resolve(ROOT, "dist/_sm2出图.json"), "utf8"));
  return j.rows;
}

function loadSynthFrame() {
  const j = JSON.parse(readFileSync(resolve(ROOT, "dist/频谱画面-柱高.json"), "utf8"));
  // 结构：{frames:[{bars:[96], peaks:[96], ...}]}
  const f = j.frames?.[0] ?? j[0];
  return f.bars ? f.bars : f;
}

function shift(src, k) {
  if (k === 0) return src.slice();
  const out = new Array(src.length).fill(0);
  for (let i = k; i < src.length; i++) out[i] = src[i - k];
  return out;
}

const N = 96;
const HALF = N / 2;

function metrics(bars) {
  let L = 0, R = 0, sum = 0, wsum = 0;
  for (let i = 0; i < N; i++) {
    const h = bars[i] ?? 0;
    if (i < HALF) L += h; else R += h;
    sum += h; wsum += i * h;
  }
  const ratio = R > 1e-9 ? L / R : Infinity;
  const centroid = sum > 1e-9 ? wsum / sum : HALF - 0.5; // 0..95 坐标
  return { L, R, ratio, centroid, sum };
}

function median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function fmt(x, d = 3) { return Number.isFinite(x) ? x.toFixed(d) : "∞"; }

const rows = loadRows();
const synth = loadSynthFrame();

// ===== 1. 实测档 79 帧：当前（k=0）的左右比与质心 =====
console.log("===== ① 实测档 79 帧 · 当前形态（k=0） =====");
const row1 = rows[1];
const frames = row1.frames;
const ratios = frames.map((b) => metrics(b).ratio);
const centroids = frames.map((b) => metrics(b).centroid);
const sums = frames.map((b) => metrics(b).sum);
console.log(`重量比 L:R  中位=${fmt(median(ratios))}  均值=${fmt(ratios.reduce((a, b) => a + b, 0) / ratios.length)}  →  折算「左:右」= ${fmt(median(ratios) / (1 + median(ratios)) * 10, 1)} : ${fmt(1 / (1 + median(ratios)) * 10, 1)}`);
console.log(`质心坐标    中位=${fmt(median(centroids), 2)}（中线 47.5；百分比位置 ${fmt(median(centroids) / (N - 1) * 100, 1)}%）`);
console.log(`总柱高和    中位=${fmt(median(sums), 3)}`);

// 逐帧质心分布（看波动）
const cMin = Math.min(...centroids), cMax = Math.max(...centroids);
console.log(`质心范围    [${fmt(cMin, 1)}, ${fmt(cMax, 1)}]`);

// ===== 2. 不同平移量 k 下的比值与质心（79 帧中位） =====
console.log("\n===== ② 不同平移量 k 下的重量比与质心（79 帧中位） =====");
console.log("k    左:右比    折合比例    质心坐标   质心位置%   与中线差");
for (let k = 0; k <= 8; k++) {
  const rs = [], cs = [];
  for (const b of frames) {
    const m = metrics(shift(b, k));
    rs.push(m.ratio); cs.push(m.centroid);
  }
  const r = median(rs), c = median(cs);
  const lp = r / (1 + r) * 10, rp = 10 - lp;
  console.log(`${k}    ${fmt(r)}    ${fmt(lp, 1)}:${fmt(rp, 1)}    ${fmt(c, 2)}    ${fmt(c / (N - 1) * 100, 1)}%    ${fmt(c - (N - 1) / 2, 2)}`);
}

// ===== 3. 合成信号帧（实拍图同场景）单独看 =====
console.log("\n===== ③ 合成信号帧（实拍图场景） =====");
console.log("k    左:右比    折合比例    质心坐标");
for (let k = 0; k <= 8; k++) {
  const m = metrics(shift(synth, k));
  const lp = m.ratio / (1 + m.ratio) * 10, rp = 10 - lp;
  console.log(`${k}    ${fmt(m.ratio)}    ${fmt(lp, 1)}:${fmt(rp, 1)}    ${fmt(m.centroid, 2)}`);
}

// ===== 4. 醒目度加权（h^2，突出高柱）——看是否更接近用户感受的 6:4 =====
console.log("\n===== ④ 醒目度加权（h²）重量比（79 帧中位） =====");
console.log("k    左:右比(h²)  折合比例");
for (let k = 0; k <= 6; k++) {
  const rs = [];
  for (const b of frames) {
    const s = shift(b, k);
    let L = 0, R = 0;
    for (let i = 0; i < N; i++) { const v = (s[i] ?? 0) ** 2; if (i < HALF) L += v; else R += v; }
    rs.push(R > 1e-12 ? L / R : Infinity);
  }
  const r = median(rs);
  const lp = r / (1 + r) * 10, rp = 10 - lp;
  console.log(`${k}    ${fmt(r)}      ${fmt(lp, 1)}:${fmt(rp, 1)}`);
}
