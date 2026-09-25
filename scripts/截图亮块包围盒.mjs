/*
 * 截图亮块包围盒：找出画面里"亮块"（模型卡片 / 高光面板）的像素范围，
 * 用来量"播放条挡住模型的哪一段"。
 *
 * 用法：node scripts\截图亮块包围盒.mjs <png> [--from y] [--min 亮度阈值] [--x0 a] [--x1 b]
 *   默认只统计 y >= --from（默认 0）的亮像素，返回整体包围盒与逐行亮像素计数最高的几行。
 */
import fs from "node:fs";
import zlib from "node:zlib";

const file = process.argv[2];
if (!file || !fs.existsSync(file)) {
  console.error("用法：node scripts\\截图亮块包围盒.mjs <png> [--from y] [--min l] [--x0 a] [--x1 b]");
  process.exit(2);
}
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? Number(process.argv[i + 1]) : d;
};
const from = arg("--from", 0), minLum = arg("--min", 240);
const x0 = arg("--x0", 0), x1 = arg("--x1", 1e9);

const buf = fs.readFileSync(file);
let off = 8, W = 0, H = 0, bitDepth = 0, colorType = 0, interlace = 0;
const idat = [];
while (off < buf.length) {
  const len = buf.readUInt32BE(off);
  const type = buf.toString("ascii", off + 4, off + 8);
  const data = buf.subarray(off + 8, off + 8 + len);
  if (type === "IHDR") { W = data.readUInt32BE(0); H = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; interlace = data[12]; }
  else if (type === "IDAT") idat.push(data);
  else if (type === "IEND") break;
  off += 12 + len;
}
if (bitDepth !== 8 || interlace !== 0) throw new Error("只支持 8 位非隔行 PNG");
const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
const raw = zlib.inflateSync(Buffer.concat(idat));
const stride = W * ch;
const px = Buffer.alloc(H * stride);
let rp = 0;
for (let y = 0; y < H; y++) {
  const f = raw[rp++];
  const row = raw.subarray(rp, rp + stride); rp += stride;
  const cur = px.subarray(y * stride, (y + 1) * stride);
  const prev = y > 0 ? px.subarray((y - 1) * stride, y * stride) : null;
  for (let i = 0; i < stride; i++) {
    const a = i >= ch ? cur[i - ch] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= ch ? prev[i - ch] : 0;
    let v = row[i];
    if (f === 1) v += a; else if (f === 2) v += b;
    else if (f === 3) v += (a + b) >> 1;
    else if (f === 4) {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    cur[i] = v & 0xff;
  }
}
const lum = (i) => ch >= 3 ? px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114 : px[i];

let top = 1e9, bot = -1, left = 1e9, right = -1, count = 0;
const perRow = [];
for (let y = from; y < H; y++) {
  let n = 0, rl = 1e9, rr = -1;
  for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
    if (lum((y * W + x) * ch) >= minLum) {
      n++; count++;
      if (x < rl) rl = x; if (x > rr) rr = x;
      if (x < left) left = x; if (x > right) right = x;
    }
  }
  perRow.push({ y, n, rl, rr });
  if (n > 0) { if (y < top) top = y; if (y > bot) bot = y; }
}
console.log("图片: " + file + "  " + W + " x " + H);
console.log("亮度阈值 >= " + minLum + "，统计范围 y >= " + from + "，x " + Math.max(0, x0) + "–" + Math.min(W - 1, x1));
if (bot < 0) { console.log("这个范围里没有亮像素。"); process.exit(0); }
console.log("亮像素总数 = " + count);
console.log("包围盒: x " + left + " – " + right + "（宽 " + (right - left + 1) + "），y " + top + " – " + bot + "（高 " + (bot - top + 1) + "）");
console.log("");
console.log("逐行亮像素数（只列非零，间隔取样）：");
const nz = perRow.filter((r) => r.n > 0);
const step = Math.max(1, Math.round(nz.length / 40));
for (let i = 0; i < nz.length; i += step) {
  const r = nz[i];
  console.log("  y=" + String(r.y).padStart(4) + "  亮像素 " + String(r.n).padStart(5) +
    "  x " + String(r.rl).padStart(4) + "–" + String(r.rr).padStart(4) + "  " + "#".repeat(Math.min(60, Math.round(r.n / 12))));
}
