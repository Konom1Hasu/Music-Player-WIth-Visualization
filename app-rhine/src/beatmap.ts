/*
 * 队列级频谱预分析 —— 把可视化从"反应"升级为"编排"。
 * ────────────────────────────────────────────────────────────────
 * 为什么需要它（对应审阅文档 §4.5）：
 *   现在的鼓点检测是**因果的、在线的** —— 只能"听到之后才亮"。而在线检测天生
 *   要等一个分析窗（1024 点 ≈ 21ms）才有第一次反应，再乘上 worker 往返与绘制节拍，
 *   屏幕上真正亮起来的时刻比耳朵晚 30~50ms。代码注释里反复出现的"延迟感严重"
 *   就是这条链的固有代价，**调参数救不了它**（参数只能改灵敏度，改不了因果性）。
 *
 *   唯一的根治办法是**提前知道鼓点在哪**：播放前把整首歌离线过一遍，
 *   算出低频能量包络与节拍网格，得到一份"乐谱级"先验。有了它就能
 *     · 提前 20~30ms 点亮（BEAT_PRE_ROLL）—— 视觉与听觉重新对齐；
 *     · 每 4 拍换一次柱体形态 —— 可视化跟着小节走，而不是跟着噪声走；
 *     · 副歌到来前提前扩动态范围（preheat）—— 高潮段更有张力。
 *
 * 为什么是"离线跑 Goertzel"而不是别的：
 *   项目里已经有一条跑通的 Goertzel 流水线（spectrum.ts），观感参数是照 1.3.0 抄的，
 *   换成 AnalyserNode.getByteFrequencyData 就全丢了。这里复用同一套算法写一份
 *   **粗粒度版**（16 段而不是 120 段），既保证"低频能量"的口径与在线那套一致，
 *   又把整首歌的分析成本压到可以后台跑的程度（一首 4 分钟的歌 ≈ 1 秒内）。
 *
 * ★★ 两条硬约束（改这个文件时别破） ★★
 *   1. `analyzeMono` 必须**完全自包含**：不引用模块作用域里的任何标识符。
 *      因为 worker 是用 `analyzeMono.toString()` 拼出来的（见 workerSource），
 *      一旦引用了外层常量，注入到 worker 里就是 ReferenceError。
 *      验证脚本 `scripts\节拍预分析验证.mjs` 的 W 组专门钉这一条。
 *   2. 分析结果属于**派生数据**，不参与任何"音源"决策。
 *      算不出来就返回 null，可视化退回纯在线模式 —— 绝不能因为预分析失败影响播放。
 */

/** 结果结构版本：算法改了就 +1，旧记录自动作废重算 */
export const BEAT_VERSION = 1;
/** 预分析用的采样率。
    8kHz 的理由：鼓点能量在 40~180Hz、响度包络是宽带的，8kHz 的奈奎斯特（4kHz）
    足够；而整首解码下来的内存只有 48kHz 的 1/6（4 分钟 ≈ 7.7MB），解码也更快。
    ★ Web Audio 的合法采样率下界是 3000，8k 在区间内。 */
export const PRE_SR = 8000;
/** 提前点亮的时间（秒）。
    取 28ms 而不是更大：提前量超过人眼的"同时"阈值（约 30~40ms）就会被读成
    "柱子先跳、声音后到"，反而变成新的错位。留一点余量是为了吃掉绘制节拍的抖动。 */
export const BEAT_PRE_ROLL = 0.028;

export interface BeatMap {
  v: number;          // = BEAT_VERSION
  dur: number;        // 时长（秒，按 PRE_SR 算出来的）
  /* ★ 分析窗的**等效时刻偏移**（秒）：第 f 帧的窗是 [f·HOP, f·HOP+WIN)，
     但谱通量比的是"新进入窗的那一段"与"刚离开的那一段"——新段从窗内偏移
     WIN−HOP 处开始、且 Hann 权重在那里最大，所以这一帧检测到的事件时刻是
     f·HOP + (WIN−HOP)，**不是** f·HOP。
     不补这一项会让整套拍点比真值早 ~48ms（合成点击轨实测 −46ms）——
     那恰好是把"延迟"换了个方向继续存在，等于白做，所以必须补。 */
  t0: number;
  fps: number;        // 包络帧率（帧/秒）
  bpm: number;        // 0 = 没测出可靠节拍网格（这时只有包络可用）
  period: number;     // 平均拍长（秒）；bpm = 0 时为 0
  beats: Float32Array; // 拍点时间（秒），升序
  amp: Uint8Array;     // 每拍强度 0~255（弱拍不弱成一刀切，见 analyzeMono）
  lowE: Uint8Array;    // 低频能量包络（fps 帧/秒）
  loud: Uint8Array;    // 宽带响度包络（loudFps 帧/秒）—— 副歌检测用它
  loudFps: number;
}

/* ==========================================================================
   核心算法（自包含！不要引用本文件里的任何外层标识符）
   ========================================================================== */
export const analyzeMono = (x: Float32Array, sr: number): BeatMap => {
  const N = x.length | 0;
  const WIN = 512;          // 64ms @8kHz
  const HOP = 128;          // 16ms → 62.5 帧/秒，足够定位拍点
  const B = 16;             // 滤波组段数（粗粒度，够用且快）
  const fps = sr / HOP;
  const frames = Math.max(0, Math.floor((N - WIN) / HOP) + 1);
  const LOUD_FPS = 4;       // 响度包络 4Hz（250ms 一格，副歌是秒级现象）
  const loudN = Math.max(1, Math.floor((N / sr) * LOUD_FPS) + 1);
  const loudF = new Float32Array(loudN);
  const dur = N / sr;

  /* 宽带响度：分块 RMS —— 副歌检测要的是"整体更响"，不是某一频段的突起 */
  const blk = Math.max(1, Math.round(sr / LOUD_FPS));
  for (let j = 0; j < loudN; j++) {
    const a = j * blk;
    const b = Math.min(N, a + blk);
    let acc = 0;
    for (let i = a; i < b; i++) acc += x[i] * x[i];
    loudF[j] = b > a ? Math.sqrt(acc / (b - a)) : 0;
  }

  const lowE = new Float32Array(frames);
  const nov = new Float32Array(frames);
  const empty = (
    bpm: number,
    period: number,
    beats: Float32Array,
    amp: Uint8Array,
  ): BeatMap => ({
    v: 1,
    dur,
    t0: (WIN - HOP) / sr,
    fps,
    bpm,
    period,
    beats,
    amp,
    lowE: new Uint8Array(frames),
    loud: new Uint8Array(loudN),
    loudFps: LOUD_FPS,
  });
  if (frames < 16) return empty(0, 0, new Float32Array(0), new Uint8Array(0));

  /* ① 滤波组：16 段对数等分 45Hz → 0.4×sr（8kHz 下是 45~3200Hz）。
       前 6 段（45~186Hz）算"低频能量"，正是底鼓所在的区间。 */
  const hann = new Float32Array(WIN);
  for (let i = 0; i < WIN; i++) hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (WIN - 1)));
  const fLo = 45;
  const fHi = sr * 0.4;
  const kk = new Float32Array(B);
  for (let b = 0; b < B; b++)
    kk[b] = ((fLo * Math.pow(fHi / fLo, b / (B - 1))) / sr) * WIN;
  const tw = new Float32Array(WIN);
  const prevL = new Float32Array(B);
  const fluxRaw = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const base = f * HOP;
    for (let i = 0; i < WIN; i++) tw[i] = x[base + i] * hann[i];
    let low = 0;
    let flux = 0;
    for (let b = 0; b < B; b++) {
      const k = kk[b];
      const co = 2 * Math.cos((2 * Math.PI * k) / WIN);
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < WIN; i++) {
        const s0 = tw[i] + co * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const m = Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - co * s1 * s2)) / (WIN / 4);
      if (b < 6) low += m;
      /* 谱通量用**对数幅度**的正向增量：与在线那条流水线的口径一致
         （在线侧是 log10(1+100·m)，这里压缩得更狠一点，突出敲击）。 */
      const L = Math.log(1 + 200 * m);
      const d = L - prevL[b];
      if (d > 0) flux += d;
      prevL[b] = L;
    }
    lowE[f] = low / 6;
    fluxRaw[f] = flux;
  }

  /* ②  novelty：减去局部均值（±12 帧 ≈ ±0.19s），只留"突起"。
        不减的话持续段也会有微小通量，节拍网格会被拖偏到"平均最响"而不是"最打击"。 */
  const W2 = 12;
  for (let f = 0; f < frames; f++) {
    let s = 0;
    let c = 0;
    const a = f - W2 > 0 ? f - W2 : 0;
    const b = f + W2 < frames ? f + W2 : frames - 1;
    for (let j = a; j <= b; j++) {
      s += fluxRaw[j];
      c++;
    }
    const v = fluxRaw[f] - s / Math.max(1, c);
    nov[f] = v > 0 ? v : 0;
  }
  let nmax = 0;
  for (let f = 0; f < frames; f++) if (nov[f] > nmax) nmax = nov[f];
  if (nmax > 0) for (let f = 0; f < frames; f++) nov[f] /= nmax;

  /* ③ 自相关测速：50~200 BPM，带一条以 118 BPM 为中心的对数高斯先验。
        纯自相关在"半速/倍速"上会摇摆，先验把它压回最常见的区间。 */
  const lagMin = Math.max(2, Math.round((fps * 60) / 200));
  const lagMax = Math.max(lagMin + 1, Math.min(frames - 2, Math.round((fps * 60) / 50)));
  const scores = new Float32Array(lagMax + 2);
  let bestLag = lagMin;
  let bestScore = -1;
  let sMean = 0;
  let sCnt = 0;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0;
    let n = 0;
    for (let i = 0; i + lag < frames; i++) {
      s += nov[i] * nov[i + lag];
      n++;
    }
    const sc = n ? s / n : 0;
    const bpmAt = (fps * 60) / lag;
    const prior = Math.exp(-Math.pow(Math.log(bpmAt / 118) / 0.55, 2));
    const v = sc * (0.35 + 0.65 * prior);
    scores[lag] = v;
    sMean += v;
    sCnt++;
    if (v > bestScore) {
      bestScore = v;
      bestLag = lag;
    }
  }
  sMean /= Math.max(1, sCnt);
  /* 置信度：峰值相对平均值的倍数。纯噪声 ≈ 1.1，有清晰节拍 ≥ 1.6。
     低于门槛就承认"这首歌没有可预测的网格"，只留包络（可视化退回在线模式）。 */
  const conf = sMean > 0 ? bestScore / sMean : 0;

  /* 抛物线插值细化周期：整帧精度在 120BPM 下有 ±14ms 误差，
     累积到 4 分钟末尾就是半拍的漂移 —— 必须细化。 */
  let periodF = bestLag;
  if (bestLag > lagMin && bestLag < lagMax) {
    const y0 = scores[bestLag - 1];
    const y1 = scores[bestLag];
    const y2 = scores[bestLag + 1];
    const den = y0 - 2 * y1 + y2;
    if (Math.abs(den) > 1e-12) {
      const d = (y0 - y2) / (2 * den);
      if (isFinite(d) && Math.abs(d) < 1) periodF = bestLag + d;
    }
  }
  let bpm = (fps * 60) / periodF;
  while (bpm > 170) bpm /= 2;
  while (bpm < 76) bpm *= 2;
  if (!(conf >= 1.25) || !isFinite(bpm)) {
    /* 没有可靠网格：包络照旧给（副歌预热还能用），只是不做拍点编排。 */
    return finishEnvelope();
  }
  const P = (fps * 60) / bpm; // 每拍多少帧（折叠后的最终值）

  /* ④ 相位搜索：在 [0, P) 里找"让所有拍点落在突起上"的那个偏移。
        步长取 1/4 帧（4ms），比拍点吸附的精度还细，不会有可见的相位台阶。 */
  const steps = Math.max(1, Math.round(P * 4));
  let bestPh = 0;
  let bestPhScore = -1;
  for (let q = 0; q < steps; q++) {
    const ph = (q / steps) * P;
    let s = 0;
    for (let t = ph; t < frames; t += P) s += nov[Math.min(frames - 1, Math.round(t))];
    if (s > bestPhScore) {
      bestPhScore = s;
      bestPh = ph;
    }
  }
  /* ⑤ 拍点吸附：网格是"等间隔"的理想化结果，真实演奏每一拍都会偏一点。
        在每个网格位置 ±win 帧内找 novelty 的极大值，把拍点挪过去。
        win 取 P 的 18%（120BPM 下 ±3 帧 ≈ ±48ms），既能纠偏又不会跳到下一拍。 */
  const win = Math.max(1, Math.min(5, Math.round(P * 0.18)));
  const idx: number[] = [];
  for (let t = bestPh; t < frames - 1; t += P) {
    const c0 = Math.round(t);
    let bi = c0;
    let bv = -1;
    const a = c0 - win > 0 ? c0 - win : 0;
    const b = c0 + win < frames ? c0 + win : frames - 1;
    for (let j = a; j <= b; j++) {
      if (nov[j] > bv) {
        bv = nov[j];
        bi = j;
      }
    }
    idx.push(bi);
  }
  if (idx.length < 4) return finishEnvelope();

  /* 拍强度：最弱的一拍也保留三成五，免得"弱拍 = 不亮"看起来像漏拍。
     真正的轻重差体现在那 0.35~1.0 之间。 */
  let amax = 0;
  for (let i = 0; i < idx.length; i++) if (nov[idx[i]] > amax) amax = nov[idx[i]];
  const beats = new Float32Array(idx.length);
  const amp = new Uint8Array(idx.length);
  for (let i = 0; i < idx.length; i++) {
    /* ★ 加上 WIN−HOP（见 BeatMap.t0 的说明）：不补就是整体早 48ms。 */
    beats[i] = (idx[i] * HOP + (WIN - HOP)) / sr;
    const rel = amax > 0 ? nov[idx[i]] / amax : 0;
    amp[i] = Math.max(0, Math.min(255, Math.round(255 * (0.35 + 0.65 * rel))));
  }
  const period =
    idx.length > 1 ? (beats[idx.length - 1] - beats[0]) / (idx.length - 1) : 60 / bpm;
  return finishEnvelope(beats, amp, bpm, period);

  /* ---- 收尾：把浮点包络压成字节（放在最后，因为要给两条返回路径共用） ---- */
  function finishEnvelope(
    b?: Float32Array,
    a?: Uint8Array,
    bpmOut = 0,
    periodOut = 0,
  ): BeatMap {
    /* 低频能量：按 p95 归一（不是按最大值）—— 一次孤立的敲击峰值会把
       整条包络压扁，p95 能让"常态有多厚"保持可读。 */
    const samp: number[] = [];
    for (let i = 0; i < frames; i += 8) samp.push(lowE[i]);
    samp.sort((p, q) => p - q);
    const p95 = samp.length ? samp[Math.min(samp.length - 1, Math.floor(samp.length * 0.95))] : 0;
    const eMax = p95 > 1e-9 ? p95 : 1e-9;
    const eBytes = new Uint8Array(frames);
    for (let i = 0; i < frames; i++) {
      const v = Math.round((255 * lowE[i]) / eMax);
      eBytes[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    /* 响度：以本曲最响处为 0dB，向下 40dB 映射到 0。
       相对刻度才有用 —— "比刚才响了"是要看的变化，绝对 dB 不重要。 */
    let lmax = 0;
    for (let j = 0; j < loudN; j++) if (loudF[j] > lmax) lmax = loudF[j];
    const dbTop = 20 * Math.log10(Math.max(lmax, 1e-7));
    const lBytes = new Uint8Array(loudN);
    for (let j = 0; j < loudN; j++) {
      const db = 20 * Math.log10(Math.max(loudF[j], 1e-7));
      const v = Math.round(255 * (1 + (db - dbTop) / 40));
      lBytes[j] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    return {
      v: 1,
      dur,
      t0: (WIN - HOP) / sr,
      fps,
      bpm: bpmOut,
      period: periodOut,
      beats: b || new Float32Array(0),
      amp: a || new Uint8Array(0),
      lowE: eBytes,
      loud: lBytes,
      loudFps: LOUD_FPS,
    };
  }
};

/* ==========================================================================
   运行时取样：给 Spectrum 每 tick 用（O(log n)，不分配对象以外的东西）
   ========================================================================== */
export interface BeatSample {
  idx: number;      // 当前处于第几拍（-1 = 还没到第一拍）
  phase: number;    // 拍内相位 0~1
  inBar: number;    // 拍在小节里的位置 0~3
  form: number;     // 形态编号：每 4 拍（一小节）变一次，0~3
  kick: number;     // 预测鼓点强度 0~1（含提前量）
  preheat: number;  // 副歌预热 0~1
  energy: number;   // 当前低频能量 0~1
}
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function meanLoud(bm: BeatMap, from: number, to: number): number {
  const a = Math.max(0, Math.round(from * bm.loudFps));
  const b = Math.min(bm.loud.length - 1, Math.round(to * bm.loudFps));
  if (b < a) return 0;
  let s = 0;
  for (let j = a; j <= b; j++) s += bm.loud[j];
  return s / (b - a + 1) / 255;
}
/** 副歌预热：前瞻 2.5 秒的响度明显高过前 5 秒 → 认定"高潮要来了"。
    两个门一起用：只看"涨了多少"会在安静段之间的微小起伏上乱触发，
    再加一条"前瞻段本身要够响"，才不会把噪声抬升当成副歌。 */
export function preheatAt(bm: BeatMap, t: number): number {
  if (!bm || !bm.loud.length) return 0;
  const W = 2.5;
  const ahead = meanLoud(bm, t, t + W);
  const now = meanLoud(bm, Math.max(0, t - 2 * W), t);
  const rise = (ahead - now) / 0.14;
  const gate = (ahead - 0.52) / 0.18;
  return clamp01(Math.min(rise, gate));
}
/** 当前低频能量（0~1）。在线检测之外多给一路"这首歌这里本来就该有多重"。
    取样要减掉 t0（帧 f 对应的时刻是 f·HOP+(WIN−HOP)，见 BeatMap.t0）。 */
export function energyAt(bm: BeatMap, t: number): number {
  if (!bm || !bm.lowE.length) return 0;
  const i = Math.max(0, Math.min(bm.lowE.length - 1, Math.round((t - bm.t0) * bm.fps)));
  return bm.lowE[i] / 255;
}
export function sampleBeatMap(bm: BeatMap | null, t: number): BeatSample {
  const out: BeatSample = { idx: -1, phase: 0, inBar: 0, form: 0, kick: 0, preheat: 0, energy: 0 };
  if (!bm || !(t >= 0)) return out;
  out.energy = energyAt(bm, t);
  out.preheat = preheatAt(bm, t);
  const beats = bm.beats;
  const n = beats.length;
  if (n === 0) return out;
  /* 二分找"最后一个 ≤ t 的拍点" */
  let lo = 0;
  let hi = n - 1;
  let i = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (beats[m] <= t) {
      i = m;
      lo = m + 1;
    } else hi = m - 1;
  }
  const PRE = BEAT_PRE_ROLL;
  const HOLD = 0.11; // 拍后维持（秒）：过了拍点不要立刻掉，鼓有衰减
  let kick = 0;
  if (i >= 0) {
    const d = t - beats[i];
    const a = bm.amp[i] / 255;
    if (d < HOLD) {
      const x = 1 - d / HOLD;
      const v = a * x * x * (3 - 2 * x); // smoothstep：落下时先慢后快，像鼓皮
      if (v > kick) kick = v;
    }
  }
  if (i + 1 < n) {
    const dt = beats[i + 1] - t;
    const a = bm.amp[i + 1] / 255;
    /* ★ 提前量在这一行：dt 从 PRE 走到 0 的过程里 kick 由 0 升到 a，
       于是"灯"在拍点**之前**就开始亮，到拍点时正好满。 */
    if (dt <= PRE && dt > -0.02) {
      const x = 1 - Math.max(0, dt) / PRE;
      const v = a * x;
      if (v > kick) kick = v;
    }
  }
  out.kick = clamp01(kick);
  if (i >= 0) {
    out.idx = i;
    const P = bm.period > 0.05 ? bm.period : 0.5;
    out.phase = clamp01((t - beats[i]) / P);
    out.inBar = i % 4;
    out.form = Math.floor(i / 4) % 4;
  }
  return out;
}

/* ==========================================================================
   worker：整首歌的分析放后台跑，主线程一次都不卡
   ========================================================================== */
/** worker 源码：把 analyzeMono 的**函数体**直接拼进去（见文件头约束 ①）。 */
function workerSource(): string {
  return (
    '"use strict";\n' +
    `const analyzeMono = ${analyzeMono.toString()};\n` +
    "onmessage = (e) => {\n" +
    "  const x = new Float32Array(e.data.x);\n" +
    "  const bm = analyzeMono(x, e.data.sr);\n" +
    "  const move = [bm.beats.buffer, bm.amp.buffer, bm.lowE.buffer, bm.loud.buffer];\n" +
    "  postMessage({ ok: true, bm: bm }, move);\n" +
    "};\n"
  );
}
let beatWorker: Worker | null = null;
let beatWorkerBroken = false;
function ensureWorker(): Worker | null {
  if (beatWorkerBroken) return null;
  if (beatWorker) return beatWorker;
  try {
    const url = URL.createObjectURL(new Blob([workerSource()], { type: "text/javascript" }));
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    beatWorker = w;
    return w;
  } catch {
    beatWorkerBroken = true;
    return null;
  }
}
/** 跑一次分析：优先 worker，起不来就主线程直接算（这首歌之后就不再重试 worker）。 */
function runAnalyze(mono: Float32Array, sr: number): Promise<BeatMap> {
  const w = ensureWorker();
  if (!w) return Promise.resolve(analyzeMono(mono, sr));
  return new Promise((resolve) => {
    let done = false;
    const timer = window.setTimeout(() => {
      if (done) return;
      done = true;
      /* 超时：worker 这条路不可信，退回主线程（结果是同一份算法，观感一致） */
      beatWorkerBroken = true;
      try {
        w.terminate();
      } catch {
        /* ignore */
      }
      beatWorker = null;
      resolve(analyzeMono(mono, sr));
    }, 30000);
    const onMsg = (e: MessageEvent) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      w.removeEventListener("message", onMsg);
      resolve(e.data && e.data.bm ? (e.data.bm as BeatMap) : analyzeMono(mono, sr));
    };
    w.addEventListener("message", onMsg);
    const copy = mono.slice(); // 转交给 worker，主线程这份留着做兜底
    w.postMessage({ x: copy.buffer, sr }, [copy.buffer]);
  });
}

/* ==========================================================================
   解码：整首 → 8kHz 单声道
   ========================================================================== */
/** 把音频字节解成 8kHz 单声道。
    ★ 用 OfflineAudioContext 而不是 AudioContext：不碰音频设备、不参与音频图，
      也就不会跟 §音频图 里那条 MediaElementSource 抢 <audio> 的归属。
    ★ decodeAudioData 会把结果重采样到**这个上下文的采样率**（这就是 8kHz 生效的地方）。 */
export async function decodeToMono(bytes: ArrayBuffer, sr = PRE_SR): Promise<Float32Array> {
  const Ctor =
    (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext;
  if (!Ctor) throw new Error("这个环境没有 OfflineAudioContext");
  const ctx = new Ctor(1, 1, sr);
  /* decodeAudioData 会 detach 传进去的 ArrayBuffer，传副本避免影响调用方 */
  const buf = await ctx.decodeAudioData(bytes.slice(0));
  const ch = buf.numberOfChannels;
  const out = new Float32Array(buf.length);
  for (let c = 0; c < ch; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += d[i];
  }
  if (ch > 1) for (let i = 0; i < out.length; i++) out[i] /= ch;
  try {
    ctx.close?.();
  } catch {
    /* ignore */
  }
  return out;
}

/* ==========================================================================
   与播放器对接：取字节 → 分析 → 缓存 → 落库
   ========================================================================== */
/** 播放器那一侧的依赖由 player.ts 注入，避免 beatmap.ts 反向 import 播放器。 */
export interface BeatSong {
  id: string;
  bm?: BeatMap | null;
  duration?: number;
  missing?: boolean;
}
interface BeatHooks {
  /** 解析"这一首现在能读到的音频文件路径"（播放器自己知道怎么兜底） */
  sourcePath?: (s: BeatSong) => Promise<string>;
  readAudio?: (p: string) => Promise<any>;
  /** 算完要落库 / 通知界面 */
  saved?: (s: BeatSong) => void;
}
let hooks: BeatHooks = {};
export function setBeatmapHooks(h: BeatHooks) {
  hooks = { ...hooks, ...h };
}
let beatOn = true;
export function beatmapEnabled(): boolean {
  return beatOn;
}
export function setBeatmapEnabled(on: boolean) {
  beatOn = on;
  if (!on) beatQueue.length = 0;
}
const triedIds = new Set<string>();   // 已经试过（成或败）的曲目，不重复浪费
const beatQueue: BeatSong[] = [];
let beatBusy = false;
/** 单首文件的大小上限：超过就不做预分析（读整份进内存不划算）。 */
const MAX_BYTES = 60 * 1024 * 1024;
/** 队列里最多排这么多首：预分析是"为了下一首"，排太远没意义（用户可能早就切走了）。 */
const QUEUE_MAX = 3;

export function hasBeatmap(s: BeatSong | null | undefined): boolean {
  return Boolean(s && s.bm && s.bm.v === BEAT_VERSION);
}
export function beatmapOf(s: BeatSong | null | undefined): BeatMap | null {
  return hasBeatmap(s) ? (s as BeatSong).bm as BeatMap : null;
}
/** 把几首排进预分析队列（当前这首在最前）。已在库里的直接跳过。 */
export function requestBeatmaps(list: (BeatSong | null | undefined)[]) {
  if (!beatOn) return;
  for (const s of list) {
    if (!s || s.missing) continue;
    if (hasBeatmap(s) || triedIds.has(s.id)) continue;
    if (beatQueue.some((q) => q.id === s.id)) continue;
    beatQueue.push(s);
  }
  if (beatQueue.length > QUEUE_MAX) beatQueue.length = QUEUE_MAX;
  void pump();
}
/** 立刻要用的那一首（正在播的）：插到队首。 */
export function requestBeatmapNow(s: BeatSong | null | undefined) {
  if (!beatOn || !s) return;
  if (hasBeatmap(s)) return;
  if (!triedIds.has(s.id)) {
    const at = beatQueue.findIndex((q) => q.id === s.id);
    if (at > 0) beatQueue.splice(at, 1);
    if (at !== 0) beatQueue.unshift(s);
  }
  void pump();
}
async function pump() {
  if (beatBusy || !beatOn) return;
  const s = beatQueue.shift();
  if (!s) return;
  beatBusy = true;
  try {
    await analyzeSong(s);
  } catch {
    /* 预分析失败不影响任何播放行为 —— 可视化退回在线模式即可 */
  } finally {
    beatBusy = false;
    /* 让出一帧再跑下一首：连续解两首会让主线程那一侧的 decode 排队变长 */
    window.setTimeout(() => void pump(), 120);
  }
}
/** 单首：取路径 → 读字节 → 解成 8k 单声道 → 分析 → 写回曲目记录 */
export async function analyzeSong(s: BeatSong): Promise<BeatMap | null> {
  if (!beatOn) return null;
  if (hasBeatmap(s)) return s.bm as BeatMap;
  triedIds.add(s.id);
  const p = hooks.sourcePath ? await hooks.sourcePath(s) : "";
  if (!p) return null;
  const res = hooks.readAudio ? await hooks.readAudio(p) : null;
  const bytes: ArrayBuffer | null = res && res.bytes ? (res.bytes as ArrayBuffer) : null;
  if (!bytes || !bytes.byteLength) return null;
  if (bytes.byteLength > MAX_BYTES) return null;
  const mono = await decodeToMono(bytes);
  if (mono.length < PRE_SR * 3) return null; // 短于 3 秒的没必要
  const bm = await runAnalyze(mono, PRE_SR);
  bm.v = BEAT_VERSION;
  s.bm = bm;
  hooks.saved?.(s);
  return bm;
}
/** 供诊断显示：预分析队列还剩几首、当前这首有没有乐谱 */
export function beatmapStatus() {
  return { queued: beatQueue.length, busy: beatBusy, on: beatOn, tried: triedIds.size };
}
