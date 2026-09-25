/*
 * 截图行/列亮度分析：把 PNG 按行（或列）统计亮度，用来量"画面里的东西到底在哪个像素带上"。
 * 拍一张快照就能回答"播放条挡住了模型的哪一段"这类版面问题。
 *
 * 用法：node scripts\截图行亮度.mjs <png> [x0 x1] [--rows|--cols]
 *   给了 x0 x1 就只统计这一横向区间（例如只看模型所在的列范围）。
 */
import fs from "node:fs";
import zlib from "node:zlib";

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error("用法：node scripts\\截图行亮度.mjs <png> [x0 x1] [--rows|--cols]");
  process.exit(2);
}
const nums = process.argv.slice(3).filter((a) => /^\d+$/.test(a)).map(Number);
const byCol = process.argv.includes("--cols");
const x0 = nums.length >= 2 ? nums[0] : null;
const x1 = nums.length >= 2 ? nums[1] : null;

/* ---------- 极简 PNG 解码（只支持 8 位真彩/灰度，够用） ---------- */
const buf = fs.readFileSync(file);
if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("不是 PNG");
let off = 8, W = 0, H = 0, bitDepth = 0, colorType = 0, interlace = 0;
const idat = [];
while (off < buf.length) {
  const len = buf.readUInt32BE(off);
  const type = buf.toString("ascii", off + 4, off + 8);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === "IHDR") {
    W = data.readUInt32BE(0); H = data.readUInt32BE(4);
    bitDepth = data[8]; colorType = data[9]; interlace = data[12];
  } else if (type === "IDAT") idat.push(data);
  else if (type === "IEND") break;
  off += 12 + len;
}
if (bitDepth !== 8 || interlace !== 0) throw new Error("只支持 8 位非隔行 PNG（bitDepth=" + bitDepth + " interlace=" + interlace + "）");
const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
if (!channels) throw new Error("不支持的 colorType=" + colorType);

const raw = zlib.inflateSync(Buffer.concat(idat));
const stride = W * channels;
const px = Buffer.alloc(H * stride);
let rp = 0;
for (let y = 0; y < H; y++) {
  const filter = raw[rp++];
  const row = raw.subarray(rp, rp + stride); rp += stride;
  const cur = px.subarray(y * stride, (y + 1) * stride);
  const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
  for (let i = 0; i < stride; i++) {
    const a = i >= channels ? cur[i - channels] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= channels ? prev[i - channels] : 0;
    let v = row[i];
    if (filter === 1) v += a;
    else if (filter === 2) v += b;
    else if (filter === 3) v += (a + b) >> 1;
    else if (filter === 4) {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    cur[i] = v & 0xff;
  }
}
const lum = (i) => {
  if (channels >= 3) return (px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114);
  return px[i];
};

const lo = x0 === null ? 0 : Math.max(0, Math.min(W - 1, x0));
const hi = x1 === null ? W - 1 : Math.max(lo, Math.min(W - 1, x1));

console.log("图片: " + file);
console.log("尺寸: " + W + " x " + H + "，统计" + (byCol ? "列" : "行") + "区间 " +
  (byCol ? "y" : "x") + " = " + lo + "–" + hi);
console.log("");

const n = byCol ? W : H;
const rows = [];
for (let k = 0; k < n; k++) {
  let sum = 0, cnt = 0, min = 255, max = 0;
  const from = byCol ? lo : Math.max(lo, 0);
  const to = byCol ? hi : Math.min(hi, W - 1);
  for (let j = from; j <= to; j++) {
    const x = byCol ? k : j;
    const y = byCol ? j : k;
    if (x < 0 || x >= W || y < 0 || y >= H) continue;
    const v = lum((y * W + x) * channels);
    sum += v; cnt++; if (v < min) min = v; if (v > max) max = v;
  }
  rows.push({ k, mean: sum / Math.max(1, cnt), min, max });
}

/* 打印成表：每 4 像素一条，标注亮度（越暗说明这里有东西） */
const step = Math.max(1, Math.round((byCol ? W : H) / 60));
console.log((byCol ? "x" : "y").padStart(5) + "  均值  最暗  最亮  柱状（暗=有内容）");
let printed = 0;
for (let i = 0; i < rows.length; i += step) {
  const r = rows[i];
  const barLen = Math.round((255 - r.mean) / 3);
  console.log(String(r.k).padStart(5) + "  " + r.mean.toFixed(1).padStart(5) + "  " +
    String(r.min).padStart(4) + "  " + String(r.max).padStart(4) + "  " +
    "█".repeat(Math.max(0, barLen)));
  printed++;
}

/* 自动找"内容带"：均值明显低于背景（用中位数当背景估计）的行/列区间 */
const med = rows.map((r) => r.mean).slice().sort((a, b) => a - b)[Math.floor(rows.length / 2)];
const thresh = med - 6;
const bands = [];
let start = null;
for (let i = 0; i < rows.length; i++) {
  const hot = rows[i].mean < thresh;
  if (hot && start === null) start = rows[i].k;
  if (!hot && start !== null) { bands.push([start, rows[i - 1].k]); start = null; }
}
if (start !== null) bands.push([start, rows[rows.length - 1].k]);
console.log("");
console.log("背景估计（中位均值）= " + med.toFixed(1) + "，判定阈值 = " + thresh.toFixed(1));
console.log("内容带（连续低于阈值的区间，长度 ≥ 3）：");
const solid = bands.filter(([a, b]) => b - a >= 3);
if (!solid.length) console.log("  （没有明显的暗带）");
for (const [a, b] of solid) console.log("  " + (byCol ? "x" : "y") + " " + a + " – " + b + "   长度 " + (b - a + 1));
