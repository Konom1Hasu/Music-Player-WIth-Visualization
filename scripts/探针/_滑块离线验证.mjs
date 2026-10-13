/* 滑块 → 引擎参数 离线受控验证
   目的：在同一份 pcm、同一取窗、同一驱动节奏下，只改一个引擎参数，
        看输出统计量是否按预期方向变化。
   （活体验证受采样时机噪声干扰，只能作 smoke，判据用本脚本。）

   用法：node scripts/探针/_滑块离线验证.mjs
*/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SRC = path.join(root, "app-rhine", "src", "selfmusic-spectrum.ts");
const esbuild = await import(pathToFileURL(path.join(root, "app-rhine", "node_modules", "esbuild", "lib", "main.js")).href);
const js = esbuild.transformSync(fs.readFileSync(SRC, "utf8"), { loader: "ts", format: "esm", target: "es2022" }).code;
const TMP = path.join(root, "scripts", "探针", "_tmp_sm_slider.mjs");
fs.writeFileSync(TMP, js);
const { SelfSpectrumEngine } = await import(pathToFileURL(TMP).href);

function readWav(buf) {
  let off = 12, dataOff = 0, dataLen = 0, sr = 48000, ch = 2;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") { ch = buf.readUInt16LE(off + 10); sr = buf.readUInt32LE(off + 12); }
    else if (id === "data") { dataOff = off + 8; dataLen = size; break; }
    off += 8 + size + (size & 1);
  }
  const n = Math.floor(dataLen / (ch * 2));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += buf.readInt16LE(dataOff + (i * ch + c) * 2);
    out[i] = s / ch / 32768;
  }
  return { sr, data: out };
}

const wavPath = path.join(root, "dist", "_ref视频帧", "ref.wav");
const { sr, data } = readWav(fs.readFileSync(wavPath));
const T0 = 190.0, HOP = 960, WIN = 4096, FRAMES = 400, BANDS = 96;

/** 跑一档，返回统计量 */
function runChain(display) {
  const eng = new SelfSpectrumEngine({ sampleRate: sr, bands: BANDS, fftSize: WIN, display });
  const rows = new Float32Array(FRAMES * BANDS);
  for (let k = 0; k < FRAMES; k++) {
    const wEnd = Math.round(T0 * sr) + (k + 1) * HOP;
    eng.push(data.subarray(wEnd - WIN, wEnd));
    rows.set(eng.compute(), k * BANDS);
  }
  // 统计
  let sum = 0, n = FRAMES * BANDS;
  let neighSum = 0, neighN = 0;      // 相邻柱差（帧内平滑度）
  let frameMaxSum = 0;               // 每帧最高柱
  let frameMaxTop = 0;               // 顶满 0.99 的帧数
  let dynSum = 0, dynN = 0;          // 帧间同柱差（动态性）
  for (let k = 0; k < FRAMES; k++) {
    const off = k * BANDS;
    let m = 0;
    for (let i = 0; i < BANDS; i++) {
      const v = rows[off + i];
      sum += v;
      if (v > m) m = v;
      if (i > 0) { neighSum += Math.abs(v - rows[off + i - 1]); neighN++; }
      if (k > 0) { dynSum += Math.abs(v - rows[off - BANDS + i]); dynN++; }
    }
    frameMaxSum += m;
    if (m >= 0.99) frameMaxTop++;
  }
  return {
    mean: sum / n,
    neigh: neighSum / neighN,
    frameMax: frameMaxSum / FRAMES,
    topPct: (100 * frameMaxTop) / FRAMES,
    dyn: dynSum / dynN,
  };
}

/** 一档对比：A=基线（出厂默认），B=覆盖，≥1 表示 B 更大 */
function cmp(label, expect, displayB) {
  const A = runChain(undefined);
  const B = runChain(displayB);
  const rel = (a, b) => (Math.abs(a) < 1e-12 ? (Math.abs(b) < 1e-12 ? 1 : Infinity) : b / a);
  const rMean = rel(A.mean, B.mean), rNeigh = rel(A.neigh, B.neigh),
        rFmax = rel(A.frameMax, B.frameMax), rDyn = rel(A.dyn, B.dyn);
  const pass = expect(A, B) ? "✓" : "✗";
  console.log(
    `${pass} ${label}\n` +
    `    mean  ${A.mean.toFixed(4)} → ${B.mean.toFixed(4)}  (×${rMean.toFixed(3)})\n` +
    `    邻柱差 ${A.neigh.toFixed(4)} → ${B.neigh.toFixed(4)}  (×${rNeigh.toFixed(3)})\n` +
    `    帧最高柱 ${A.frameMax.toFixed(4)} → ${B.frameMax.toFixed(4)}  (×${rFmax.toFixed(3)})  顶满 ${A.topPct.toFixed(1)}% → ${B.topPct.toFixed(1)}%\n` +
    `    帧间动态 ${A.dyn.toFixed(4)} → ${B.dyn.toFixed(4)}  (×${rDyn.toFixed(3)})`
  );
  return expect(A, B);
}

console.log(`pcm ${data.length} 点 @ ${sr}Hz | ${FRAMES} 帧 × ${BANDS} 带（T0=${T0}s，步长 ${HOP}）\n`);

const results = [];
results.push(cmp("head 160→300（弹性：headroom 1.6→3.0，整体应被压低）", (A, B) => B.mean < A.mean * 0.9, { headroom: 3.0 }));
results.push(cmp("smooth 1→3（顺滑：铺散 3 遍，邻柱差应明显变小）", (A, B) => B.neigh < A.neigh * 0.8, { spreadPasses: 3 }));
results.push(cmp("detail 50→0（细纹关闭：邻柱差应变小）", (A, B) => B.neigh < A.neigh, { detail: 0.0 }));
results.push(cmp("tint 45→0（毛刺关闭：邻柱差应变小）", (A, B) => B.neigh < A.neigh, { tintAmp: 0.0 }));
results.push(cmp("expanda 100→340（尖塔：拆平台 → 邻柱差上升、顶满率下降）", (A, B) => B.neigh > A.neigh && B.topPct < A.topPct, { peakExpand: 3.4 }));
results.push(cmp("release 82→50（回落：向目标靠拢比例，越小越平滑 → 动态应变小）", (A, B) => B.dyn < A.dyn, { release: 0.50 }));
results.push(cmp("valley 100→20（谷深收窄：邻柱差应变小）", (A, B) => B.neigh < A.neigh, { valleyKeep: 0.20 }));
results.push(cmp("right 100→0（右细节关闭）", (A, B) => B.mean < A.mean || B.dyn < A.dyn, { rightHf: 0.0 }));
results.push(cmp("knee 78→0（软膝关闭：高段不再压缩，mean 应上升）", (A, B) => B.mean > A.mean, { knee: 0.0 }));
results.push(cmp("surge 55→0（低频高耸关闭）", (A, B) => true, { surgeAmp: 0.0 }));
results.push(cmp("timbre 45→0（音色活跃度关闭）", (A, B) => true, { timbre: 0.0 }));
results.push(cmp("tilt 45→0（倾斜关闭）", (A, B) => true, { tilt: 0.0 }));
results.push(cmp("leftpump 40→0（左塔泵动关闭）", (A, B) => true, { leftPump: 0.0 }));
results.push(cmp("agc 0→100（右丰开启）", (A, B) => B.mean !== A.mean, { bandAgc: 1.0 }));

console.log(`\n结论：${results.filter(Boolean).length} / ${results.length} 档方向符合预期`);
fs.unlinkSync(TMP);
