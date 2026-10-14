/* 「还原算法 + 可视化滑块」出图数据（v2：16 项版）
   同一段真实音乐（190.0s 起，V5 形态：20ms 驱动、每 5 tick 记录 → 79 帧），五档 ——
     ① 原版裸：16 项面板参数全关的中性态（= SelfMusic web/spectrum.mjs 原版）
     ② 出厂默认：16 项面板默认（当前落地的档）
     ③ 弹性 300：head 拉满（整体压低、弹跳更足）
     ④ 顺滑 3：铺散 3 遍（陡台阶磨成缓坡）
     ⑤ 尖塔 340 · 谷深 20：峰值拆塔 + 非局部峰打折（离散尖塔）
   档 ③④⑤ 走 smSliderPatch（= 滑块真实路径）。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SRC = path.join(root, "app-rhine", "src", "selfmusic-spectrum.ts");
const esbuild = await import(pathToFileURL(path.join(root, "app-rhine", "node_modules", "esbuild", "lib", "main.js")).href);
const js = esbuild.transformSync(fs.readFileSync(SRC, "utf8"), { loader: "ts", format: "esm", target: "es2022" }).code;
const TMP = path.join(root, "scripts", "探针", "_tmp_sm2shot.mjs");
fs.writeFileSync(TMP, js);
const { SelfSpectrumEngine, SELFMUSIC_NEUTRAL_DISPLAY, smSliderPatch } = await import(pathToFileURL(TMP).href);

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
const WIN = 4096;

/* ★ v2.7.7：出图数据就是**引擎输出的 96 条**，不再重采样到 150 —— 绘制层已经改成直画
   引擎频段数（96→150 的线性重采样随旧流水线一起删了）。这里再重采样的话，冻结点进画布的
   就只剩前 64% 的频段（低频被拉满整个画面），出图全错。 */
const BAR_N = 96;

/* V5 形态：T0=190.0s、20ms 驱动（窗首 [190.0+j*960, +4096)）、每 5 tick 记录一帧 */
function runChain(display) {
  const eng = new SelfSpectrumEngine({ sampleRate: sr, display });
  const rows = [];
  const t0 = Math.round(190.0 * sr);
  for (let j = 0; j < 79 * 5; j++) {
    const wStart = t0 + j * 960;
    eng.push(data.subarray(wStart, wStart + WIN));
    const h = eng.compute();
    if (j % 5 === 0) {
      if (h.length !== BAR_N) throw new Error("引擎频段数变了：" + h.length + " ≠ " + BAR_N);
      rows.push(Array.from(h, (v) => Math.round(v * 1e8) / 1e8));
    }
  }
  return rows;
}
const p = (k, v) => smSliderPatch(k, v);

const out = { rows: [] };
out.rows.push({ name: "原版裸16项全关", frames: runChain(SELFMUSIC_NEUTRAL_DISPLAY) });
out.rows.push({ name: "出厂默认用户实测档", frames: runChain(undefined) });
out.rows.push({ name: "滑块弹性120", frames: runChain(p("head", 120)) });
out.rows.push({ name: "滑块顺滑3", frames: runChain(p("smooth", 3)) });
out.rows.push({ name: "滑块尖塔340谷深20", frames: runChain(Object.assign(p("expanda", 340), p("valley", 20))) });

fs.writeFileSync(path.join(root, "dist", "_sm2出图.json"), JSON.stringify(out));
console.log("五档数据落盘 dist/_sm2出图.json（每帧 " + BAR_N + " 条 = 引擎频段数）");
for (const r of out.rows) {
  const f0 = r.frames[0];
  const mean = (r.frames[10].reduce((a, x) => a + x, 0) / BAR_N).toFixed(3);
  console.log(`${r.name}: f0 前8 = ` + f0.slice(0, 8).map((v) => v.toFixed(3)).join(" ") + `  f10均值=${mean}`);
}
fs.unlinkSync(TMP);
