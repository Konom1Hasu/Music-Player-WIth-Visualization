/* 活路径形式对拍 · Node 侧
   目的：验证"播放器里真正在跑的那条活路径"（selfmusic-live.ts 的驱动 + 引擎）
        与 SelfMusic 的活模拟（mainwindow._refresh_viz 逐行移植）在**同一 PCM、
        同一 (位置, 帧间隔) 序列**下逐帧一致（heights + peaks）。
   与 _selfmusic对拍 的区别：那边验证"引擎在固定窗下对不对"；这边验证
   "驱动（平滑时钟 / 取窗 / setTickMs 折算）也逐位一致"——即"波形完全一致"的活体形态。
   序列覆盖：起播硬同步 / 慢回正 / 小跳（gap>60 回正，<250） / 大跳（>250 硬对齐） /
   暂停后首帧（dt=900ms，钳制路径）。
   用法：node scripts\探针\_活路径对拍.mjs
*/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SRC_ENGINE = path.join(root, "app-rhine", "src", "selfmusic-spectrum.ts");
const SRC_LIVE = path.join(root, "app-rhine", "src", "selfmusic-live.ts");
const esbuild = await import(pathToFileURL(path.join(root, "app-rhine", "node_modules", "esbuild", "lib", "main.js")).href);
const TMP_ENGINE = path.join(root, "scripts", "探针", "_tmp_sm_engine.mjs");
const TMP_LIVE = path.join(root, "scripts", "探针", "_tmp_sm_live.mjs");
fs.writeFileSync(TMP_ENGINE, esbuild.transformSync(fs.readFileSync(SRC_ENGINE, "utf8"), { loader: "ts", format: "esm", target: "es2022" }).code);
const liveJs = esbuild
  .transformSync(fs.readFileSync(SRC_LIVE, "utf8"), { loader: "ts", format: "esm", target: "es2022" })
  .code.replace('from "./selfmusic-spectrum"', 'from "./_tmp_sm_engine.mjs"');
fs.writeFileSync(TMP_LIVE, liveJs);
const { SelfSpectrumEngine } = await import(pathToFileURL(TMP_ENGINE).href);
const { SelfMusicLiveDriver } = await import(pathToFileURL(TMP_LIVE).href);

/* PCM：与 Python 侧**同一份字节**（_selfmusic对拍.mjs 导出的 f32 单声道） */
const SR = 48000, WIN = 4096, BANDS = 96, FRAMES = 400;
const pcmBuf = fs.readFileSync(path.join(root, "dist", "_sm2对拍-pcm.f32"));
const pcm = new Float32Array(pcmBuf.buffer.slice(pcmBuf.byteOffset, pcmBuf.byteOffset + pcmBuf.byteLength));

/* 与 Python 侧逐行同构的 (posMs, dtMs) 序列（只用 +,*,/,floor → IEEE 双精度逐位一致） */
function frameSeq(N) {
  const seq = [];
  let t = 0, off = 0;
  for (let k = 0; k < N; k++) {
    let dt = 15.6 + (k % 2 ? 0.9 : 0.0);
    if (k % 7 === 0) dt = 21.3;
    if (k === Math.floor(N / 5)) dt = 900.0;       // 暂停后首帧
    t += dt;
    if (k === Math.floor(N / 2)) off += 1500.0;    // 大跳（seek > 250ms → 硬对齐）
    if (k === Math.floor((3 * N) / 4)) off += 120.0; // 小跳（gap > 60 → 回正）
    const pos = Math.max(0.0, Math.floor(t / 52.0) * 52.0 - 8.0 + off);
    seq.push([pos, dt]);
  }
  return seq;
}

const seq = frameSeq(FRAMES);
const eng = new SelfSpectrumEngine({ sampleRate: SR, bands: BANDS, fftSize: WIN });
const drv = new SelfMusicLiveDriver(eng, WIN);
drv.setPcm(pcm, SR);

const outH = new Float32Array(FRAMES * BANDS);
const outP = new Float32Array(FRAMES * BANDS);
const outV = new Float64Array(FRAMES); // 逐帧记录 vizMs（循环外读 positionMs 只会拿到最终值）
for (let k = 0; k < FRAMES; k++) {
  const [pos, dt] = seq[k];
  drv.frame(pos, dt);
  outV[k] = drv.positionMs;
  outH.set(drv.lastHeights, k * BANDS);
  outP.set(drv.lastPeaks, k * BANDS);
}
fs.writeFileSync(path.join(root, "dist", "_sm2活路径-js.f32"), Buffer.from(outH.buffer));
fs.writeFileSync(path.join(root, "dist", "_sm2活路径-js-peaks.f32"), Buffer.from(outP.buffer));

/* 关键帧自证：把 vizMs 与首带柱高打出来（Python 侧同格式，肉眼可对） */
function probe(k) {
  return `f${k} vizMs=${outV[k].toFixed(3)} h0=${outH[k * BANDS].toFixed(6)} p0=${outP[k * BANDS].toFixed(6)}`;
}
console.log(`JS 侧：${FRAMES} 帧已导出（同一 (pos,dt) 序列）`);
for (const k of [0, 1, Math.floor(FRAMES / 2), Math.floor((3 * FRAMES) / 4), FRAMES - 1]) console.log("  " + probe(k));

fs.unlinkSync(TMP_ENGINE);
fs.unlinkSync(TMP_LIVE);
console.log("接下来：D:/SelfMusic/.venv/Scripts/python.exe scripts/探针/_活路径对拍.py");
