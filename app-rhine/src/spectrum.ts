/*
 * 频谱可视化：把 1.3.0 版独立播放器那套自研频谱（Hann 加窗 + Goertzel 对数频段 +
 * 峰值归一 + 对数压缩，120 条柱、鼓点泵动、14 级量化、峰值指示线）
 * 搬到莱茵生命终端的详情区画布上，并按用户反馈做了两处工程化修订（见下）。
 *
 * 为什么不是直接用 AnalyserNode.getByteFrequencyData：
 *   1.2/1.3 那版的效果来自一串手工调出来的参数（频段增益曲线、"宽丘 + 细针"的左峰、
 *   乘法泵动而不是加法、按余量缩放的抖动、量化后的单边颤动……）。
 *   换成 getByteFrequencyData 之后这些全都没了，观感也就回不到那版。
 *   这里保留那条流水线，只把数据源换成 AnalyserNode 的时域缓冲（getFloatTimeDomainData）。
 *
 * 与 1.3.0 的两处有意差异（用户反馈"毛刺感太严重、帧率也不够"）：
 *   1. 分析 30Hz、绘制 60Hz：worker 每 33ms 交一次频段，渲染循环每帧把"上一帧值"
 *      一阶逼近"目标值"，柱高连续滑动而不是每 33ms 跳一格。帧率翻倍，
 *      而 Goertzel 的算力开销一分没涨（还是 30 次/秒）。
 *   2. 去毛刺：抖动从"行波式正弦"改成"逐柱慢速随机"（不再横向爬行）、
 *      抖动幅度下调、量化前补一道 [1,2,1] 横向平滑并多留一级量化余量。
 *      低频那只"细针"和 14 级阶梯感都保留，只是不再毛糙。
 */

export const SPECTRUM_BANDS = 120; // 对数频段数
const BAR_N = 120; // 柱数
const VIZ_LEVELS = 14; // 阶梯级数
/* 分析窗长：1.3.0 是 1024。512 在 42Hz–16kHz 的对数分带下频率分辨率完全够
   （最低带也跨多个 bin），而 Goertzel 的乘加量减半 —— 分析 30Hz 的算力只占原来一半。 */
const ANALYSIS_WINDOW = 512;
/** worker 侧的分析窗长（与这里必须一致；player.ts 用它决定喂多少采样） */
export const SPECTRUM_WINDOW = ANALYSIS_WINDOW;

/* 固定成 1.3.0 的默认值（原来由滑块调） */
const TILT_STRENGTH = 55; // 频谱平衡 0~100
const KICK_PUMP = 0.4; // 鼓点泵动深度
const JITTER_K = 1.0;
const BASS_SIGMA = 0.048; // 左峰宽丘的 σ
const BASS_GAIN_TARGET = 1.05; // 左峰"静态总增益"目标
const BASS_WIDE_CENTER = 0.12; // 左峰宽丘中心（≈45Hz）

/* 抖动（毛刺的主要来源）：幅度由 0.45 降到 0.16，并且改成逐柱慢速随机，
   不再是"相位每帧 +0.03 的正弦行波" —— 后者会在柱面上留下横向爬行的毛边。 */
const JITTER_AMP = 0.16 * JITTER_K;
const JITTER_WOBBLE = 0.022 * JITTER_K;
const JITTER_SLIDE = 0.5; // 逐柱随机值的滑动速度（越小越稳）
const JITTER_MASK = (1 << 12) - 1;
const SMOOTH_W = 0.26; // 量化前 [1,2,1] 横向平滑权重（0 = 不平滑）
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
  const w = new Float32Array(ANALYSIS_WINDOW);
  for (let i = 0; i < ANALYSIS_WINDOW; i++)
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (ANALYSIS_WINDOW - 1)));
  return w;
})();

/** 时域缓冲很长（fftSize），只取最新的一段做分析；返回可用窗长 */
export function analysisWindow(td: Float32Array): number {
  return Math.min(ANALYSIS_WINDOW, td.length);
}

export class Spectrum {
  private bands = new Float32Array(SPECTRUM_BANDS);
  private freq = new Float32Array(SPECTRUM_BANDS + 1); // 最后一位放 kick
  private bandK: Float32Array;
  private bandBoost: Float32Array;
  /* bars = 分析节拍上的目标值；show = 每帧插值后的显示值（绘制与刻度都读它） */
  private bars = new Float32Array(BAR_N);
  private show = new Float32Array(BAR_N);
  private peaks = new Float32Array(BAR_N);
  private raw = new Float32Array(BAR_N);
  private noise = new Float32Array(BAR_N);
  private smoothInit = false;
  /* 按量化级分桶用的容器（每帧复用，避免每帧新建数组） */
  private buckets: number[][] = Array.from({ length: VIZ_LEVELS }, () => []);
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
      this.bandK[b] = (f / this.sampleRate) * ANALYSIS_WINDOW;
    }
  }
  setPalette(palette: Partial<SpectrumPalette>) {
    this.palette = { ...this.palette, ...palette };
    this.gradKey = "";
  }
  setMode(mode: SpectrumMode) {
    this.mode = mode;
  }
  /** 供播放条刻度取样（显示值，已插值） */
  get levels() {
    return this.show;
  }
  /** 诊断用：三段数据的快照（归一化后的频段 / 流水线目标值 / 显示值） */
  snapshot() {
    return { freq: Array.from(this.freq), bars: Array.from(this.bars), show: Array.from(this.show) };
  }
  /** 换曲时把峰值线清掉，免得上一首的峰值留在屏幕上 */
  resetPeaks() {
    this.peaks.fill(0);
    this.bars.fill(0);
    this.show.fill(0);
    this.smoothInit = false;
    this.kickRef = 0;
    this.kickEnergy = 0;
  }

  /* ---------- 分析：Hann 加窗 + Goertzel ---------- */
  private goertzelBin(td: Float32Array, k: number, from: number, n: number) {
    const co = 2 * Math.cos((2 * Math.PI * k) / n);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const s0 = td[from + i] * HANN[i] + co * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    // 归一化按窗长常数折算（1.3.0 的 N/4），分析窗长短于缓冲时读数与原来同量级
    return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - co * s1 * s2)) / ((ANALYSIS_WINDOW / 4) * (n / ANALYSIS_WINDOW));
  }
  private analyze(td: Float32Array) {
    const n = analysisWindow(td);
    const from = td.length - n;
    let mx = 1e-9;
    for (let b = 0; b < SPECTRUM_BANDS; b++) {
      let mag = this.goertzelBin(td, this.bandK[b], from, n);
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

  /** 逐柱慢速随机（比原来的正弦行波稳，且不会横向爬行） */
  private noiseAt(i: number, tick: number) {
    const n = i * JITTER_MASK;
    const a = Math.sin(n * 12.9898 + tick * 78.233) * 43758.5453;
    const b = Math.sin(n * 39.3468 + tick * 11.135) * 24634.6345;
    return (a - Math.floor(a)) * 0.6 + (b - Math.floor(b)) * 0.4 - 0.5;
  }

  /* ---------- 柱高流水线（每个"分析节拍"跑一次，30Hz） ---------- */
  private advance() {
    const n = BAR_N;
    const tilt = (50 - TILT_STRENGTH) / 50;
    const noise = this.noise;
    for (let i = 0; i < n; i++) {
      const tgt = this.noiseAt(i, 0);
      noise[i] += (tgt - noise[i]) * JITTER_SLIDE;
    }
    const bars = this.bars;
    const raw = this.raw;
    for (let i = 0; i < n; i++) {
      let v = this.sampleBand(i, n);
      v *= Math.pow(5, tilt * (1 - i / n)); // 倾斜补偿（低频端最高 5×）
      v = Math.pow(Math.min(1, v), 2.1); // 幂次曲线：拉大高低差
      // 鼓点用【乘法泵动】：加法会把十几根一起顶过 1.0 钳住，量化后顶端变成平直方块
      const pumpW = Math.exp(-Math.pow((i / n - 0.07) / 0.1, 2));
      v *= 1 - pumpW * KICK_PUMP * (1 - this.kickEnergy);
      v += this.kickEnergy * 0.06 * pumpW;
      // 抖动：向上幅度按剩余余量缩放，避免峰心两侧被一起钳住而失去针形
      const headroom = Math.max(0, Math.min(1, (1 - v) / 0.45));
      v *= 1 + noise[i] * JITTER_AMP * headroom;
      raw[i] = Math.max(0.02, Math.min(1, v));
    }
    // 横向平滑 [1,2,1]：抹掉相邻柱之间一格一格的锯齿（量化前做，阶梯才是完整的）
    for (let i = 0; i < n; i++) {
      const l = raw[i > 0 ? i - 1 : 0];
      const r = raw[i < n - 1 ? i + 1 : n - 1];
      bars[i] = Math.max(0.02, Math.min(1, SMOOTH_W * (0.25 * l + 0.5 * raw[i] + 0.25 * r) + (1 - SMOOTH_W) * raw[i]));
    }
    for (let i = 0; i < n; i++) {
      let v = Math.round(bars[i] * (VIZ_LEVELS - 1)) / (VIZ_LEVELS - 1); // 14 级量化（阶梯感）
      // 量化后补一层"单边向下"的轻微颤动：满高条的顶端不会看着是死的
      v *= 1 - JITTER_WOBBLE * (0.5 - noise[i]);
      // 一阶跟随（系数随频率放缓）——老式的乘法自衰减会让尾巴拖得很长
      const atk = 0.7 - 0.2 * (i / n);
      const rel = 0.58 + 0.22 * (i / n);
      bars[i] = v > bars[i] ? bars[i] + (v - bars[i]) * atk : bars[i] + (v - bars[i]) * rel;
      // 峰值线按分析节拍衰减：放渲染循环里会随帧率变化
      this.peaks[i] = Math.max(this.peaks[i] * 0.97, bars[i]);
    }
    if (!this.smoothInit) {
      this.show.set(bars);
      this.smoothInit = true;
    }
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
    const values = this.show;
    /* 柱高本来就是 14 级量化过的，所以按"级"分桶画：globalAlpha 每帧只改 14 次
       （原实现是每根柱改一次，120 次状态切换），帧率能实打实抬上去。 */
    const buckets: number[][] = this.buckets;
    for (let k = 0; k < VIZ_LEVELS; k++) buckets[k].length = 0;
    for (let i = 0; i < BAR_N; i++) {
      const level = Math.max(0, Math.min(VIZ_LEVELS - 1, Math.round(values[i] * (VIZ_LEVELS - 1))));
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
    const values = this.show;
    const gLow = ctx.createLinearGradient(0, 0, 0, h);
    gLow.addColorStop(0, this.palette.strong);
    gLow.addColorStop(1, this.palette.base);
    const gMid = ctx.createLinearGradient(0, 0, 0, h);
    gMid.addColorStop(0, this.palette.light);
    gMid.addColorStop(1, this.palette.strong);
    for (let i = 0; i < BAR_N; i++) {
      const v = values[i];
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
    const values = this.show;
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
      const len = 2 + values[i] * Math.min(w, h) * 0.34;
      ctx.globalAlpha = 0.4 + 0.6 * values[i];
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * base, cy + Math.sin(a) * base);
      ctx.lineTo(cx + Math.cos(a) * (base + len), cy + Math.sin(a) * (base + len));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  private drawWave(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const n = Math.min(BAR_N, 96);
    const values = this.show;
    ctx.strokeStyle = this.palette.light;
    ctx.lineWidth = 2;
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const idx = Math.round(t * (BAR_N - 1));
      const y = h / 2 - (values[idx] - 0.5) * h * 0.8;
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

  /** 每帧调用（渲染节拍）：把显示值朝分析目标值逼近再画，柱高因此是连续滑动的。 */
  render(dt: number) {
    const k = 1 - Math.exp(-dt / 0.055);
    const show = this.show;
    const bars = this.bars;
    for (let i = 0; i < BAR_N; i++) show[i] += (bars[i] - show[i]) * k;
    this.draw();
  }
  /** 分析节拍：喂一段时域数据（同步路径；worker 可用时走 applyBands） */
  update(timeDomain: Float32Array, sampleRate?: number) {
    if (sampleRate && sampleRate !== this.sampleRate) this.setSampleRate(sampleRate);
    this.analyze(timeDomain);
    this.advance();
  }
  /** 频谱在 Web Worker 里算好时走这条：把 120 段 + kick 喂进来出图（主线程零计算） */
  applyBands(freq: Float32Array) {
    const n = Math.min(SPECTRUM_BANDS, freq.length);
    for (let b = 0; b < n; b++) this.freq[b] = freq[b];
    this.kickEnergy = freq.length > SPECTRUM_BANDS && isFinite(freq[SPECTRUM_BANDS]) ? freq[SPECTRUM_BANDS] : 0;
    this.advance();
  }
  /** 没有音频时把目标值收到静默状态（渲染节拍照旧插值，收起过程也是滑动而不是跳变） */
  decay() {
    let live = false;
    for (let i = 0; i < BAR_N; i++) {
      this.bars[i] *= 0.9;
      this.peaks[i] *= 0.94;
      if (this.bars[i] > 0.01) live = true;
    }
    this.kickEnergy = 0;
    if (!this.smoothInit) this.smoothInit = true;
    return live;
  }
}
