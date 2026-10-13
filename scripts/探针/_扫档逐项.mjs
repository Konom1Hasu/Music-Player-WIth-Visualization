/* 扫档逐项 / 累进对拍 · JS 侧
   逐项：每次只施加一项（其余出厂默认）→ 输出 item-<key>.f32
   累进：按 SCAN 顺序累加前 N 项 → 输出 prog-NN.f32
   400 帧足够暴露累积发散。
*/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SRC = path.join(root, "app-rhine", "src", "selfmusic-spectrum.ts");
const esbuild = await import(pathToFileURL(path.join(root, "app-rhine", "node_modules", "esbuild", "lib", "main.js")).href);
const js = esbuild.transformSync(fs.readFileSync(SRC, "utf8"), { loader: "ts", format: "esm", target: "es2022" }).code;
const TMP = path.join(root, "scripts", "探针", "_tmp_sm_item.mjs");
fs.writeFileSync(TMP, js);
const { SelfSpectrumEngine, smSliderPatch } = await import(pathToFileURL(TMP).href);

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
const { sr, data } = readWav(fs.readFileSync(path.join(root, "dist", "_ref视频帧", "ref.wav")));
const T0 = 190.0, HOP = 960, WIN = 4096, FRAMES = 400, BANDS = 96;

const SCAN = [
  ["smooth", 2], ["knee", 30], ["detail", 110], ["leftpump", 15], ["head", 220],
  ["right", 35], ["agc", 70], ["steepq", 240], ["tilt", 15], ["timbre", 80],
  ["tint", 20], ["expanda", 260], ["surge", 90], ["release", 60], ["valley", 60],
  ["idle", 1],
];

function runChain(patch) {
  const eng = new SelfSpectrumEngine({ sampleRate: sr, bands: BANDS, fftSize: WIN });
  if (patch) eng.setDisplayParams(patch);
  const rows = new Float32Array(FRAMES * BANDS);
  for (let k = 0; k < FRAMES; k++) {
    const wEnd = Math.round(T0 * sr) + (k + 1) * HOP;
    eng.push(data.subarray(wEnd - WIN, wEnd));
    rows.set(eng.compute(), k * BANDS);
  }
  return rows;
}

const outDir = path.join(root, "dist");
for (const item of SCAN) {
  const p = smSliderPatch(item[0], item[1]);
  fs.writeFileSync(path.join(outDir, `_sm2对拍-js-item-${item[0]}.f32`), Buffer.from(runChain(p).buffer));
}
const acc = {};
for (let i = 0; i < SCAN.length; i++) {
  Object.assign(acc, smSliderPatch(SCAN[i][0], SCAN[i][1]));
  fs.writeFileSync(path.join(outDir, `_sm2对拍-js-prog-${String(i + 1).padStart(2, "0")}.f32`), Buffer.from(runChain(acc).buffer));
}
console.log(`JS 侧：逐项 ${SCAN.length} 档 + 累进 ${SCAN.length} 档 已导出（${FRAMES} 帧）`);
fs.unlinkSync(TMP);
