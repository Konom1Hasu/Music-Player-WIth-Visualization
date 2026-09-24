/*
 * 频谱可视化：把 1.3.0 版独立播放器那套自研频谱（Hann 加窗 + Goertzel 对数频段 +
 * 峰值归一 + 对数压缩，120 条柱、鼓点泵动、抖动穿插、14 级量化、峰值指示线）
 * 原样搬到莱茵生命终端的详情区画布上。
 *
 * 为什么不是直接用 AnalyserNode.getByteFrequencyData：
 *   1.2/1.3 那版的效果来自一串手工调出来的参数（频段增益曲线、"宽丘 + 细针"的左峰、
 *   乘法泵动而不是加法、按余量缩放的抖动、量化后的单边颤动……）。
 *   换成 getByteFrequencyData 之后这些全都没了，观感也就回不到那版。
 *   这里保留那条流水线，只把数据源换成 AnalyserNode 的时域缓冲（getFloatTimeDomainData），
 *   分析与渲染参数与 1.3.0 完全一致。
 *
 * 与源版本的差异（有意为之）：
 *   · 不用 Web Worker：面板是 30fps 重绘（见 player.ts 的帧预算），120 段 × 1024 点
 *     的 Goertzel 同步跑约 12 万次乘加/帧 ≈ 370 万次/秒，主线程完全吃得下，
 *     少一个 worker + 看门狗回退的复杂度。
 *   · 滑块固定成 1.3.0 的默认值（倾斜 55、鼓点 0.40、抖动 1.00、峰宽 0.048、左峰目标增益 1.05）。
 *   · 配色取终端自己的令牌（暖色强调 + 墨黑），由调用方传入。
 */

const SPECTRUM_N = 1024; // 分析窗长（= analyser.fftSize）
const SPECTRUM_BANDS = 120; // 对数频段数
const BAR_N = 120; // 柱数
const VIZ_LEVELS = 14; // 阶梯级数

/* 固定成 1.3.0 的默认值（原来由滑块调） */
const TILT_STRENGTH = 55; // 频谱平衡 0~100
const KICK_PUMP = 0.4; // 鼓点泵动深度
const JITTER_K = 1.0;
const BASS_SIGMA = 0.048; // 左峰宽丘的 σ
const BASS_GAIN_TARGET = 1.05; // 左峰"静态总增益"目标
const BASS_WIDE_CENTER = 0.12; // 左峰宽丘中心（≈45Hz）

const JITTER_AMP = 0.45 * JITTER_K;
const JITTER_FREQ = 0.1 + 0.2 * (JITTER_K - 0.4);
const JITTER_STEP = 0.03 * JITTER_K;
const JITTER_WOBBLE = 0.055 * JITTER_K;
const LOG101 = Math.log10(101);
const F_MIN = 42;
const F_MAX = 16000;

export type SpectrumMode = "mix" | "timbre" | "bars" | "ring" | "wave";

export interface SpectrumPalette {
  light: string; // 顶端（亮）
  strong: string; // 中段（强调）
  base: string; // 底端（暗）
  ring: string; // 圆环样式用的线色
}

const HANN = (() => {
  const w = new Float32Array(SPECTRUM_N);
  for (let i = 0; i < SPECTRUM_N; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (SPECTRUM_N - 1)));
  return w;
})();

export class Spectrum {
  private bands = new Float32Array(SPECTRUM_BANDS);
  private freq = new Float32Array(SPECTRUM_BANDS + 1); // 最后一位放 kick
  private bandK: Float32Array;
  private bandBoost: Float32Array;
  private bars = new Float32Array(BAR_N);
  private peaks = new Float32Array(BAR_N);
  /* 按量化级分桶用的容器（每帧复用，避免每帧新建数组） */
  private buckets: number[][] = Array.from({ length: VIZ_LEVELS }, () => []);
  private jitterPhase = 0;
  private kickEnergy = 0;
  private kickRef = 0;
  private grad: CanvasGradient | null = null;
  private gradKey = "";
  private mode: SpectrumMode = "mix";
  private palette: SpectrumPalette = {
    light: "#c9a878",
    strong: "#9b7247",
    base: "#252820",
    ring: "#9b7247",
  };

  constructor(private canvas: HTMLCanvasElement, private sampleRate = 48000) {
    this.bandK = new Float32Array(SPECTRUM_BANDS);
    this.setSampleRate(sampleRate);
    this.bandBoost = this.buildBandBoost();
  }
  /** 频段中心 → Goertzel 的 k（采样率变了要重建） */
  setSampleRate(sampleRate: number) {
    this.sampleRate = sampleRate || 48000;
    for (let b = 0; b < SPECTRUM_BANDS; b++) {
      const f = F_MIN * Math.pow(F_MAX / F_MIN, b / (SPECTRUM_BANDS - 1));
      this.bandK[b] = (f / this.sampleRate) * SPECTRUM_N;
    }
  }
  setPalette(palette: Partial<SpectrumPalette>) {
    this.palette = { ...this.palette, ...palette };
    this.gradKey = "";
  }
  setMode(mode: SpectrumMode) {
    this.mode = mode;
  }
  /** 供播放条刻度取样 */
  get levels() {
    return this.bars;
  }
  /** 换曲时把峰值线清掉，免得上一首的峰值留在屏幕上 */
  resetPeaks() {
    this.peaks.fill(0);
    this.bars.fill(0);
    this.kickRef = 0;
    this.kickEnergy = 0;
  }

  /* ---------- 分析：Hann 加窗 + Goertzel ---------- */
  private goertzelBin(td: Float32Array, k: number) {
    const co = 2 * Math.cos((2 * Math.PI * k) / SPECTRUM_N);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < SPECTRUM_N; i++) {
      const s0 = td[i] * HANN[i] + co * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - co * s1 * s2)) / (SPECTRUM_N / 4);
  }
  private analyze(td: Float32Array) {
    let mx = 1e-9;
    for (let b = 0; b < SPECTRUM_BANDS; b++) {
      let mag = this.goertzelBin(td, this.bandK[b]);
      if (!isFinite(mag)) mag = 0;
      this.bands[b] = mag;
      if (mag > mx) mx = mag;
    }
    // 对数压缩 + 本帧峰值归一（1.3.0 同款）
    for (let b = 0; b < SPECTRUM_BANDS; b++) {
      this.freq[b] = Math.log10(1 + 100 * Math.min(1, this.bands[b] / mx)) / LOG101;
    }
    // 鼓点：用【未归一化】的低频原始幅度做 onset（归一化后的低频恒等于 1，取差分永远为 0）
    let low = 0;
    for (let b = 2; b <= 8; b++) low += this.bands[b];
    low /= 7;
    if (this.kickRef <= 0) this.kickRef = low;
    const rise = (low - this.kickRef) / Math.max(this.kickRef, 1e-6);
    const kick = Math.max(0, Math.min(1, (rise - 0.08) * 2.2));
    this.kickRef += (low - this.kickRef) * 0.05;
    this.kickEnergy = kick;
    this.freq[SPECTRUM_BANDS] = kick;
  }

  /* ---------- 频段增益：宽丘 + 细针的左峰、中高频尖峰、中频谷 ---------- */
  private bassPeakBar() {
    const usable = Math.floor(SPECTRUM_BANDS * 0.98);
    const target = BASS_WIDE_CENTER * (SPECTRUM_BANDS - 1);
    const bandOf = (i: number) => Math.floor(Math.pow(i / BAR_N, 0.8) * usable);
    for (let i = 0; i < BAR_N; i++) {
      const a = bandOf(i);
      const b = Math.max(a + 1, bandOf(i + 1));
      if (target >= a && target < b) return i;
    }
    return 0;
  }
  private bassGainForTilt() {
    const bassPeakBar = this.bassPeakBar();
    const tilt = (50 - TILT_STRENGTH) / 50;
    const tp = Math.pow(5, tilt * (1 - bassPeakBar / BAR_N));
    return Math.max(-0.35, Math.min(3.0, BASS_GAIN_TARGET / Math.max(0.15, tp) - 1));
  }
  private buildBandBoost() {
    const bassPeakBar = this.bassPeakBar();
    const usable = Math.floor(SPECTRUM_BANDS * 0.98);
    const bandOf = (i: number) => Math.floor(Math.pow(i / BAR_N, 0.8) * usable);
    const a0 = bandOf(bassPeakBar);
    const b0 = Math.max(a0 + 1, bandOf(bassPeakBar + 1));
    // 细针中心对准"低频峰所在柱"的正中心：不对准的话峰高会被摊到相邻两根上，再窄也尖不起来
    const needleCenter = (a0 + b0 - 1) / 2 / (SPECTRUM_BANDS - 1);
    const needleSigma = BASS_SIGMA * 0.1875;
    const bassGain = this.bassGainForTilt();
    const g = new Float32Array(SPECTRUM_BANDS);
    for (let b = 0; b < SPECTRUM_BANDS; b++) {
      const f = b / (SPECTRUM_BANDS - 1);
      const uw = (f - BASS_WIDE_CENTER) / BASS_SIGMA;
      const un = (f - needleCenter) / needleSigma;
      const bass = (0.5 * Math.exp(-uw * uw) + 0.95 * Math.exp(-un * un)) * bassGain;
      const pres = Math.exp(-Math.pow((f - 0.58) / 0.075, 2)) * 0.75; // 中高频（人声）尖峰
      const valley = -Math.exp(-Math.pow((f - 0.33) / 0.09, 2)) * 0.45; // 中频谷
      g[b] = Math.max(0.58, Math.min(2.9, 1.0 + bass + pres + valley));
    }
    return g;
  }
  private sampleBand(i: number, n: number) {
    const usable = Math.floor(SPECTRUM_BANDS * 0.98);
    const a = Math.floor(Math.pow(i / n, 0.8) * usable);
    const b = Math.max(a + 1, Math.floor(Math.pow((i + 1) / n, 0.8) * usable));
    let s = 0;
    for (let f = a; f < b; f++) s += this.freq[f] * this.bandBoost[f];
    return s / Math.max(1, b - a);
  }

  /* ---------- 柱高流水线 ---------- */
  private computeBars() {
    const n = BAR_N;
    const tilt = (50 - TILT_STRENGTH) / 50;
    for (let i = 0; i < n; i++) {
      let v = this.sampleBand(i, n);
      v *= Math.pow(5, tilt * (1 - i / n)); // 倾斜补偿（低频端最高 5×）
      v = Math.pow(Math.min(1, v), 2.1); // 幂次曲线：拉大高低差
      // 鼓点用【乘法泵动】：加法会把十几根一起顶过 1.0 钳住，量化后顶端变成平直方块
      const pumpW = Math.exp(-Math.pow((i / n - 0.07) / 0.1, 2));
      v *= 1 - pumpW * KICK_PUMP * (1 - this.kickEnergy);
      v += this.kickEnergy * 0.06 * pumpW;
      // 抖动：向上幅度按剩余余量缩放，避免峰心两侧被一起钳住而失去针形
      const ph = i * JITTER_FREQ * Math.PI * 2 + this.jitterPhase;
      const headroom = Math.max(0, Math.min(1, (1 - v) / 0.45));
      v *= 1 + Math.sin(ph) * JITTER_AMP * headroom;
      v = Math.max(0.02, Math.min(1, v));
      v = Math.round(v * (VIZ_LEVELS - 1)) / (VIZ_LEVELS - 1); // 14 级量化（阶梯感）
      // 量化后补一层"单边向下"的颤动：满高条的顶端不会看着是死的
      v *= 1 - JITTER_WOBBLE * (0.5 - 0.5 * Math.sin(ph));
      // 一阶跟随（系数随频率放缓）——老式的乘法自衰减会让尾巴拖得很长
      const atk = 0.7 - 0.2 * (i / n);
      const rel = 0.58 + 0.22 * (i / n);
      this.bars[i] = v > this.bars[i] ? this.bars[i] + (v - this.bars[i]) * atk : this.bars[i] + (v - this.bars[i]) * rel;
      this.peaks[i] = Math.max(this.peaks[i] * 0.97, this.bars[i]);
    }
    this.jitterPhase += JITTER_STEP;
  }

  /* ---------- 绘制 ---------- */
  private makeGrad(ctx: CanvasRenderingContext2D, h: number) {
    const key = `g${h}|${this.palette.light}|${this.palette.strong}|${this.palette.base}`;
    if (this.gradKey !== key || !this.grad) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, this.palette.light);
      g.addColorStop(0.5, this.palette.strong);
      g.addColorStop(1, this.palette.base);
      this.grad = g;
      this.gradKey = key;
    }
    return this.grad;
  }
  private drawBars(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const gap = w / BAR_N;
    const bw = Math.max(1, gap * 0.7);
    const grad = this.makeGrad(ctx, h);
    /* 柱高本来就是 14 级量化过的，所以按"级"分桶画：globalAlpha 每帧只改 14 次
       （原实现是每根柱改一次，120 次状态切换），帧率能实打实抬上去。 */
    const buckets: number[][] = this.buckets;
    for (let k = 0; k < VIZ_LEVELS; k++) buckets[k].length = 0;
    for (let i = 0; i < BAR_N; i++) {
      const level = Math.max(0, Math.min(VIZ_LEVELS - 1, Math.round(this.bars[i] * (VIZ_LEVELS - 1))));
      buckets[level].push(i);
    }
    ctx.fillStyle = grad;
    for (let level = 0; level < VIZ_LEVELS; level++) {
      const list = buckets[level];
      if (!list.length) continue;
      const v = level / (VIZ_LEVELS - 1);
      const bh = Math.max(2, v * (h - 8));
      ctx.globalAlpha = 0.45 + 0.55 * v;
      for (let n = 0; n < list.length; n++) {
        const x = list[n] * gap + (gap - bw) / 2;
        ctx.fillRect(x, h - bh, bw, bh);
      }
    }
    // 峰值线：一条 fillStyle 画完（都在同一高度带里，按行合并）
    ctx.globalAlpha = 0.85;
    for (let i = 0; i < BAR_N; i++) {
      const ph = Math.max(2, this.peaks[i] * (h - 8));
      ctx.fillRect(i * gap + (gap - bw) / 2, h - ph - 3, bw, 2);
    }
    ctx.globalAlpha = 1;
  }
  private drawTimbre(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const gap = w / BAR_N;
    const bw = Math.max(1, gap * 0.7);
    const gLow = ctx.createLinearGradient(0, 0, 0, h);
    gLow.addColorStop(0, this.palette.strong);
    gLow.addColorStop(1, this.palette.base);
    const gMid = ctx.createLinearGradient(0, 0, 0, h);
    gMid.addColorStop(0, this.palette.light);
    gMid.addColorStop(1, this.palette.strong);
    for (let i = 0; i < BAR_N; i++) {
      const v = this.bars[i];
      const bh = Math.max(2, v * (h - 8));
      const x = i * gap + (gap - bw) / 2;
      const t = i / BAR_N;
      ctx.fillStyle = t < 0.14 ? gLow : t < 0.6 ? gMid : this.makeGrad(ctx, h);
      ctx.globalAlpha = 0.45 + 0.55 * v;
      ctx.fillRect(x, h - bh, bw, bh);
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x, h - Math.max(2, this.peaks[i] * (h - 8)) - 3, bw, 2);
    }
    ctx.globalAlpha = 1;
  }
  private drawRing(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const cx = w / 2;
    const cy = h / 2;
    const base = Math.min(w, h) * 0.28;
    ctx.strokeStyle = this.palette.ring;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.28;
    ctx.beginPath();
    ctx.arc(cx, cy, base, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = this.palette.light;
    for (let i = 0; i < BAR_N; i++) {
      const a = (i / BAR_N) * Math.PI * 2 - Math.PI / 2;
      const len = 2 + this.bars[i] * Math.min(w, h) * 0.34;
      ctx.globalAlpha = 0.4 + 0.6 * this.bars[i];
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * base, cy + Math.sin(a) * base);
      ctx.lineTo(cx + Math.cos(a) * (base + len), cy + Math.sin(a) * (base + len));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  private drawWave(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const n = Math.min(BAR_N, 96);
    ctx.strokeStyle = this.palette.light;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const idx = Math.round(t * (BAR_N - 1));
      const y = h / 2 - (this.bars[idx] - 0.5) * h * 0.8;
      if (i === 0) ctx.moveTo(t * w, y);
      else ctx.lineTo(t * w, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  private draw() {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    if (this.mode === "ring") this.drawRing(ctx, w, h);
    else if (this.mode === "wave") this.drawWave(ctx, w, h);
    else if (this.mode === "timbre") this.drawTimbre(ctx, w, h);
    else this.drawBars(ctx, w, h); // mix / bars 同款（鼓点已在柱高里）
  }

  /** 每帧调用：喂一段时域数据，算完直接画。 */
  update(timeDomain: Float32Array, sampleRate?: number) {
    if (sampleRate && sampleRate !== this.sampleRate) this.setSampleRate(sampleRate);
    this.analyze(timeDomain);
    this.computeBars();
    this.draw();
  }
  /** 频谱在 Web Worker 里算好时走这条：直接把 120 段 + kick 喂进来出图（主线程零计算） */
  applyBands(freq: Float32Array) {
    const n = Math.min(SPECTRUM_BANDS, freq.length);
    for (let b = 0; b < n; b++) this.freq[b] = freq[b];
    this.kickEnergy = freq.length > SPECTRUM_BANDS && isFinite(freq[SPECTRUM_BANDS]) ? freq[SPECTRUM_BANDS] : 0;
    this.computeBars();
    this.draw();
  }
  /** 没有音频时把画面收到静默状态 */
  decay() {
    let live = false;
    for (let i = 0; i < BAR_N; i++) {
      this.bars[i] *= 0.9;
      this.peaks[i] *= 0.94;
      if (this.bars[i] > 0.01) live = true;
    }
    this.kickEnergy = 0;
    this.draw();
    return live;
  }
}
