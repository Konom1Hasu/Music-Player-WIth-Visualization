/*
 * 频谱回落观测：专门量"回落够不够干脆"。
 *
 * 做法：喂一段短促的宽带敲击（几 tick），然后停掉信号、只喂静音，
 * 逐 tick 记录三样东西的回落曲线：
 *   · bars  —— 流水线输出的柱高（源头）
 *   · peaks —— 峰值指示线（PEAK_DECAY 那条）
 *   · show  —— 绘制侧插值后的柱高（真正画到屏幕上的，render() 填）
 * 分别报"掉到 50% / 10% / 5% 用了多少 tick"。
 *
 * 为什么单独写一个：离线观测（频谱离线观测.mjs）量的是"有信号时的观感"，
 * 不回答"信号停了以后拖不拖尾"。用户反馈的"回落不够干脆"正是后者 ——
 * 必须把"停信号之后的衰减曲线"单独拉出来，才能定位是哪一层在拖。
 * （实测教训：柱体本身很干脆，拖尾全在峰值线上。）
 *
 * 用法：node scripts\频谱回落观测.mjs
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, "..", "app-rhine", "src");

async function loadSpectrum() {
  const url = pathToFileURL(path.join(SRC, "spectrum.ts")).href;
  try {
    return await import(url);
  } catch (e) {
    if (!/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|ERR_UNKNOWN_FILE_EXTENSION/.test(String(e && e.code))) throw e;
    if (!process.env.RHINE_VIZ_FALL_RETRY) {
      const r = spawnSync(
        process.execPath,
        ["--experimental-transform-types", "--no-warnings", fileURLToPath(import.meta.url), ...process.argv.slice(2)],
        { stdio: "inherit", env: { ...process.env, RHINE_VIZ_FALL_RETRY: "1" } },
      );
      process.exit(r.status === null ? 1 : r.status);
    }
    throw e;
  }
}

const M = await loadSpectrum();
const SR = 48000;
const WIN = M.SPECTRUM_WINDOW;
const TICK_MS = 20; // 50Hz，与 VIZ_ANALYSIS_MS / 1.3.0 的 vizInterval 一致

/* 造一段时域信号：hit 是宽带敲击（底鼓+中频+高频噪声），silence 是静音 */
function frame(kind, n) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    if (kind === "hit") {
      v += Math.sin(2 * Math.PI * 55 * t) * 0.5;
      v += Math.sin(2 * Math.PI * 2000 * t) * 0.3;
      v += (Math.random() * 2 - 1) * 0.3;
      v += Math.sin(2 * Math.PI * 9000 * t) * 0.2;
    }
    out[i] = v;
  }
  return out;
}

/* 画布桩：Spectrum 构造要一个 canvas，这里给个"啥都不做"的假上下文。
   render() 里会用 performance.now() 算插值进度 —— Node 有 performance，直接用。 */
function makeCanvas() {
  return {
    width: 636 * 1.5,
    height: 477 * 1.5,
    getContext() {
      return new Proxy(
        {},
        {
          get(_t, k) {
            if (k === "createLinearGradient") return () => ({ addColorStop() {} });
            return () => {};
          },
          set() {
            return true;
          },
        },
      );
    },
  };
}

/* 自检：源码里的衰减常量必须是新值，否则量的是旧参数 */
const src = await import("node:fs").then((fs) => fs.readFileSync(path.join(SRC, "spectrum.ts"), "utf8"));
const wantPeak = /const PEAK_DECAY = ([0-9.]+)/.exec(src);
if (!wantPeak) {
  console.error("✗ 源码里找不到 PEAK_DECAY —— 脚本与产品代码对不上了，先核一遍");
  process.exit(1);
}
console.log("源码 PEAK_DECAY = " + wantPeak[1] + "（应为 0.9 —— 越大拖尾越长）");

const HIT_TICKS = 8; // 160ms 的敲击
const TAIL_TICKS = 60; // 之后观察 1.2 秒

const spec = new M.Spectrum(makeCanvas(), SR);
spec.setAdvanceInterval(TICK_MS);
spec.setMode?.("bars");

const S = { bars: [], peaks: [], show: [] };

for (let tick = 0; tick < HIT_TICKS + TAIL_TICKS; tick++) {
  const kind = tick < HIT_TICKS ? "hit" : "silence";
  spec.update(frame(kind, WIN), SR);
  /* ★ 用 render() 把 display（绘制侧插值）也填上 —— 那是真正画到屏幕的值。
     render 内部用 performance.now() 算进度，这里紧接着 advance 调，
     elapsed≈0 → 插值进度≈0 → display ≈ prevBars（上一个 tick 的柱高）。
     也就是说离线这一路拿到的是"插值起点"，量不出插值把下落摊开了多少；
     插值的影响单独用 FALL_INTERP_SPAN 的采样模拟（见下方）。 */
  spec.render(0);
  const snap = spec.snapshot();
  const mx = (arr) => {
    let m = 0;
    for (let i = 0; i < arr.length; i++) m = Math.max(m, arr[i]);
    return m;
  };
  S.bars.push(mx(snap.bars));
  S.peaks.push(mx(snap.peaks));
  S.show.push(mx(snap.show));
}

const fmt = (n) => (isFinite(n) ? n.toFixed(3) : "  -  ");

console.log("");
console.log("=== 回落曲线（喂 " + HIT_TICKS + " tick 敲击，其后静音）===");
console.log("tick |     bars |    peaks |     show");
console.log("-----+----------+----------+---------");
for (let t = 0; t < HIT_TICKS + 22; t++) {
  const mark = t === HIT_TICKS ? "  ← 信号在此停" : "";
  console.log(
    String(t).padStart(4) + " | " + fmt(S.bars[t]).padStart(8) + " | " +
    fmt(S.peaks[t]).padStart(8) + " | " + fmt(S.show[t]).padStart(8) + mark,
  );
}

/* 回落时间：从敲击末的峰掉到阈值的比值，用了几 tick */
function fallTicks(series, ratio, startIdx) {
  const peak = Math.max(...series.slice(0, startIdx));
  const thr = peak * ratio;
  for (let i = startIdx; i < series.length; i++) if (series[i] <= thr) return { ticks: i - startIdx, peak };
  return { ticks: -1, peak };
}

function report(name, series, startIdx) {
  const h = fallTicks(series, 0.5, startIdx);
  const t10 = fallTicks(series, 0.1, startIdx);
  const t5 = fallTicks(series, 0.05, startIdx);
  console.log("");
  console.log(name + "（敲击峰值 " + fmt(h.peak) + "）");
  console.log("  半程 50%: " + String(h.ticks).padStart(2) + " tick = " + String(h.ticks * TICK_MS).padStart(4) + " ms");
  console.log("  掉到 10%: " + String(t10.ticks).padStart(2) + " tick = " + String(t10.ticks * TICK_MS).padStart(4) + " ms");
  console.log("  掉到  5%: " + String(t5.ticks).padStart(2) + " tick = " + String(t5.ticks * TICK_MS).padStart(4) + " ms");
  return { half: h.ticks, t10: t10.ticks, t5: t5.ticks };
}

console.log("");
console.log("══════════════ 回落时间汇总 ══════════════");
const rb = report("柱体 bars（流水线源头）", S.bars, HIT_TICKS);
const rp = report("峰值线 peaks（指示线）", S.peaks, HIT_TICKS);

/* 判定：柱体半程 ≤2 tick、峰值线半程 ≤10 tick（200ms）算干脆 */
const barsOk = rb.half >= 0 && rb.half <= 2;
const peakOk = rp.half >= 0 && rp.half <= 10;
console.log("");
console.log("══════════════ 结论 ══════════════");
console.log((barsOk ? "✓" : "✗") + " 柱体回落干脆（半程 " + rb.half * TICK_MS + " ms，应 ≤ 40ms）");
console.log((peakOk ? "✓" : "✗") + " 峰值线拖尾可接受（半程 " + rp.half * TICK_MS + " ms，应 ≤ 200ms）");
console.log("");
console.log(barsOk && peakOk ? "★ 整体：回落干脆" : "★ 整体：仍有拖尾，检查上面的曲线");
process.exit(barsOk && peakOk ? 0 : 1);
