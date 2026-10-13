/* SelfMusic 引擎对拍 · Node 侧（v4：三档）
   档 A「中性」：TS display=SELFMUSIC_NEUTRAL_DISPLAY ↔ Python 全默认构造（= web/spectrum.mjs 逐位态）
   档 B「出厂」：TS 默认构造 ↔ Python 全默认 + 16 项面板默认 apply
   档 C「扫档」：TS 由 smSliderPatch 拼 16 项非默认值 ↔ Python 同上（覆盖换算分岔）
   同一份 ref.wav 190s 段的 pcm、同一取窗（整窗 4096、20ms 步长）、1000 帧 × 96 条。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SRC = path.join(root, "app-rhine", "src", "selfmusic-spectrum.ts");
const esbuild = await import(pathToFileURL(path.join(root, "app-rhine", "node_modules", "esbuild", "lib", "main.js")).href);
const js = esbuild.transformSync(fs.readFileSync(SRC, "utf8"), { loader: "ts", format: "esm", target: "es2022" }).code;
const TMP = path.join(root, "scripts", "探针", "_tmp_selfmusic2.mjs");
fs.writeFileSync(TMP, js);
const { SelfSpectrumEngine, SELFMUSIC_NEUTRAL_DISPLAY, SELFMUSIC_DISPLAY_DEFAULTS, smSliderPatch } =
  await import(pathToFileURL(TMP).href);

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
fs.writeFileSync(path.join(root, "dist", "_sm2对拍-pcm.f32"), Buffer.from(data.buffer, data.byteOffset, data.length * 4));
console.log(`pcm 导出：${data.length} 点 @ ${sr}Hz`);

const T0 = 190.0, HOP = 960, WIN = 4096, FRAMES = 1000, BANDS = 96;

function runChain(display) {
  const eng = new SelfSpectrumEngine({ sampleRate: sr, bands: BANDS, fftSize: WIN, display });
  const rows = new Float32Array(FRAMES * BANDS);
  for (let k = 0; k < FRAMES; k++) {
    const wEnd = Math.round(T0 * sr) + (k + 1) * HOP;
    eng.push(data.subarray(wEnd - WIN, wEnd));
    const h = eng.compute();
    rows.set(h, k * BANDS);
  }
  return rows;
}

console.log("出厂默认参数:", JSON.stringify(SELFMUSIC_DISPLAY_DEFAULTS));

const t0 = Date.now();
const neutral = runChain(SELFMUSIC_NEUTRAL_DISPLAY);
fs.writeFileSync(path.join(root, "dist", "_sm2对拍-js-neutral.f32"), Buffer.from(neutral.buffer));
const tA = Date.now();
const factory = runChain(undefined);
fs.writeFileSync(path.join(root, "dist", "_sm2对拍-js-factory.f32"), Buffer.from(factory.buffer));
const tB = Date.now();

/* 档 C 扫档：16 项非默认，逐项走 smSliderPatch（镜像 mainwindow._apply_viz_param） */
const SCAN = [
  ["smooth", 2], ["knee", 30], ["detail", 110], ["leftpump", 15], ["head", 220],
  ["right", 35], ["agc", 70], ["steepq", 240], ["tilt", 15], ["timbre", 80],
  ["tint", 20], ["expanda", 260], ["surge", 90], ["release", 60], ["valley", 60],
  ["idle", 1],
];
const scanPatch = {};
for (const [k, v] of SCAN) {
  const p = smSliderPatch(k, v);
  if (!p) { console.log(`  ⚠ smSliderPatch(${k}) 返回空`); continue; }
  Object.assign(scanPatch, p);
}
console.log("扫档 patch:", JSON.stringify(scanPatch));
const scan = runChain(scanPatch);
fs.writeFileSync(path.join(root, "dist", "_sm2对拍-js-scan.f32"), Buffer.from(scan.buffer));
console.log(`JS 侧：中性档 ${((tA - t0) / 1000).toFixed(2)}s / 出厂档 ${((tB - tA) / 1000).toFixed(2)}s / 扫档 ${((Date.now() - tB) / 1000).toFixed(2)}s`);

for (const [name, rows] of [["neutral", neutral], ["factory", factory], ["scan", scan]]) {
  for (let k = 0; k < 2; k++) {
    console.log(`${name} f${k}: ` + Array.from(rows.subarray(k * BANDS, k * BANDS + 10)).map((v) => v.toFixed(4)).join(" "));
  }
}

/* 静音门 smoke（出厂档） */
const eng2 = new SelfSpectrumEngine({ sampleRate: sr, bands: BANDS, fftSize: WIN });
const zero = new Float32Array(WIN);
let silentOK = true;
for (let k = 0; k < 50; k++) { eng2.push(zero); const h = eng2.compute(); for (let i = 0; i < BANDS; i++) if (h[i] !== 0) silentOK = false; }
console.log(`静音门 smoke：${silentOK ? "✓ 全 0" : "✗ 有非零值"}`);

fs.unlinkSync(TMP);
console.log("接下来：D:/SelfMusic/.venv/Scripts/python.exe scripts/探针/_selfmusic对拍.py");
