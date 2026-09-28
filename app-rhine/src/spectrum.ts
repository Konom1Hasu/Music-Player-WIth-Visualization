/*
 * 频谱可视化：把 1.3.0 版独立播放器那套自研频谱（Hann 加窗 + Goertzel 对数频段 +
 * 峰值归一 + 对数压缩，120 个对数频段、鼓点泵动、14 级量化、峰值指示线）
 * 搬到莱茵生命终端的详情区画布上，并按用户反馈做了两处工程化修订（见下）。
 *
 * 为什么不是直接用 AnalyserNode.getByteFrequencyData：
 *   1.2/1.3 那版的效果来自一串手工调出来的参数（频段增益曲线、"宽丘 + 细针"的左峰、
 *   乘法泵动而不是加法、按余量缩放的抖动、量化后的单边颤动……）。
 *   换成 getByteFrequencyData 之后这些全都没了，观感也就回不到那版。
 *   这里保留那条流水线，只把数据源换成 AnalyserNode 的时域缓冲（getFloatTimeDomainData）。
 *
 * 与 1.3.0 的关系（用户 2026-09-25 明确要求"参数设置请完全参照 1.3.0 版本的播放器"）：
 *   1. 观感参数**逐个照抄 1.3.0**：1024 点分析窗、抖动幅度 0.45、行波空间频率
 *      0.1 + 0.2·(K−0.4)、相位步进 0.03、单边颤动 0.055、14 级量化、倾斜 55、
 *      泵动 0.40、幂次 2.1、一阶跟随系数 0.7−0.2·(i/n) / 0.58+0.22·(i/n)。
 *      2.0.0 曾按"毛刺感太严重"做过一轮去毛刺（慢速随机抖动、[1,2,1] 平滑、512 点窗），
 *      已按用户要求整体撤回 —— 屏幕上看到的就是 1.3.0 那条流水线的输出。
 *   2. 只动**架构、不动观感**：Goertzel 从主线程搬进 Web Worker（每 33ms 一帧，
 *      与 1.3.0 的 30Hz 分析节拍一致），主线程只负责按 60fps 重画同一份 bars。
 *      render() 不做二次插值，所以阶梯与抖动与 1.3.0 逐像素一致，只是重画次数更多。
 */

export const SPECTRUM_BANDS = 120; // 对数频段数（分析侧，不动）
/* 柱数是**显示侧**的采样密度，与 120 个分析频段解耦：bar i → 频段区间
   floor(pow(i/BAR_N,0.8)*117)，区间内取平均。150 比 120 多约 1/4 根、每根窄约 1/5，
   看着更细密；而频域里的塑形（细针中心 / 倾斜增益）算出来与 120 柱时逐位相同
   （bassPeakBar 从 9 变成 11，落到同一个频段区间 [14,15)，needleCenter 仍是 14/119），
   所以旧版导入的调音参数效果一个字没变。 */
const BAR_N = 150; // 柱数
const VIZ_LEVELS = 14; // 阶梯级数
/* 分析窗长：★ 维持 1.3.0 的 1024 点（用户要求"参数完全参照 1.3.0"，窗长也是参数）。
   1024 点 Hann 窗在 42Hz 处的等效噪声带宽约 5Hz，正好护住低频那根"细针"的稳定度。 */
const ANALYSIS_WINDOW = 1024;
/** worker 侧的分析窗长（与这里必须一致；player.ts 用它决定喂多少采样） */
export const SPECTRUM_WINDOW = ANALYSIS_WINDOW;

/* 这几个值现在是运行时参数（vizParams），默认值见下面的 VIZ_DEFAULTS：
   旧版播放器面板上的 平衡 / 峰宽 / 抖动 / 鼓点 / 峰高，启动时会从旧版 localStorage 导入。 */
const BASS_WIDE_CENTER = 0.12; // 左峰宽丘中心（≈45Hz）

/* ★ 参数一律照 1.3.0 的原值，不做任何"调优"（用户 2026-09-25 明确要求："参数设置请完全参照
   1.3.0 版本的播放器"）。抖动就是原来那套：相位每帧 +0.03 的正弦行波、幅度 0.45、
   空间频率 0.1 + 0.2·(K−0.4)、单边颤动 0.055 —— 全部乘 JITTER_K。
   ★★ 但这五个是**旧版播放器面板上的滑块**（平衡 / 峰宽 / 抖动 / 鼓点 / 峰高），
   旧版把它们存在 localStorage 的 `mp_tilt` `mp_bassw2` `mp_jit2` `mp_kick` `mp_peakh` 里。
   用户调过它们（例如 平衡 63、峰高 1.45），所以这里做成**可运行时改的参数对象**，
   启动时由 `player.ts` 的 importLegacyVizSettings() 从旧版存储导入一次；
   导入不到就用 1.3.0 的默认值（下面 VIZ_DEFAULTS）。 */
export interface VizParams {
  tilt: number; // 频谱平衡 0~100（越大左侧整体越高）
  bassSigma: number; // 左峰宽丘的 σ（0.020~0.080，越小越窄）
  jitterK: number; // 抖动倍率（0.40~2.00）
  kickPump: number; // 鼓点泵动深度（0~0.60，0 = 左峰一直顶满）
  peakTarget: number; // 左峰静态高度目标（0.55~1.45）
}
export const VIZ_DEFAULTS: VizParams = { tilt: 55, bassSigma: 0.048, jitterK: 1.0, kickPump: 0.4, peakTarget: 1.05 };
export const vizParams: VizParams = { ...VIZ_DEFAULTS };
/** 改参数（导入旧版设置时用）。改完调用方要 `spectrum.applyParams()` 重建频段增益。 */
export function setVizParams(p: Partial<VizParams>) {
  for (const k of Object.keys(VIZ_DEFAULTS) as (keyof VizParams)[]) {
    const v = p[k];
    if (typeof v === "number" && isFinite(v)) vizParams[k] = v;
  }
}
/** 归一化到合法区间（旧版滑块的取值范围与之对应） */
export function clampVizParams(p: Partial<VizParams>): Partial<VizParams> {
  const out: Partial<VizParams> = {};
  if (typeof p.tilt === "number") out.tilt = Math.max(0, Math.min(100, p.tilt));
  if (typeof p.bassSigma === "number") out.bassSigma = Math.max(0.02, Math.min(0.08, p.bassSigma));
  if (typeof p.jitterK === "number") out.jitterK = Math.max(0.4, Math.min(2, p.jitterK));
  if (typeof p.kickPump === "number") out.kickPump = Math.max(0, Math.min(0.6, p.kickPump));
  if (typeof p.peakTarget === "number") out.peakTarget = Math.max(0.55, Math.min(1.45, p.peakTarget));
  return out;
}
/** 抖动三件套都随 jitterK 缩放（1.3.0 的做法） */
const jitterAmp = () => 0.45 * vizParams.jitterK;
const jitterFreq = () => 0.1 + 0.2 * (vizParams.jitterK - 0.4);
const jitterStep = () => 0.03 * vizParams.jitterK;
const jitterWobble = () => 0.055 * vizParams.jitterK;
const LOG101 = Math.log10(101);
/* ★ 频段映射必须照 1.3.0 的原式（见 app\index.html 的 buildBandCache）：
     fMin = 20Hz、fMax = 0.45 × Nyquist（**随采样率变**），对数等分 120 段。
   这里曾经写死成 42Hz ~ 16000Hz —— 48kHz 下低频峰（归一化位置 0.12）落到 ≈86Hz，
   而原版是 ≈43Hz：低频那根"细针"与鼓点响应整体错位一倍，
   用户反馈的"原先的频谱算法好像并没有完全实现""频谱和音频存在延迟"就有这一条。 */
const F_MIN = 20;
const F_MAX_RATIO = 0.45;
export { F_MIN as SPECTRUM_F_MIN, F_MAX_RATIO as SPECTRUM_F_MAX_RATIO };
/** 鼓点 onset 用的低频段：1.3.0 是**第 2–16 带共 15 段**（旧实现只用了 2–8 共 7 段） */
const KICK_BAND_FROM = 2;
const KICK_BAND_TO = 16;
const KICK_BAND_N = KICK_BAND_TO - KICK_BAND_FROM + 1;

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
  /* bars = 每根柱的当前值（1.3.0 只有这一个数组，绘制直接读它） */
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
  /** 参数（vizParams）改过之后调用：按新的 平衡/峰宽/峰高 重建频段增益 */
  applyParams() {
    this.bandBoost = this.buildBandBoost();
  }
  /** 频段中心 → Goertzel 的 k（采样率变了要重建）。fMax 随采样率走，见 F_MIN/F_MAX_RATIO 的注释 */
  setSampleRate(sampleRate: number) {
    this.sampleRate = sampleRate || 48000;
    const fMax = F_MAX_RATIO * (this.sampleRate / 2);
    for (let b = 0; b < SPECTRUM_BANDS; b++) {
      const f = F_MIN * Math.pow(fMax / F_MIN, b / (SPECTRUM_BANDS - 1));
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
  /** 供播放条刻度取样（1.3.0 里也是直接读柱高数组） */
  get levels() {
    return this.bars;
  }
  /** 诊断用：归一化后的频段 + 柱高快照 */
  snapshot() {
    return { freq: Array.from(this.freq), bars: Array.from(this.bars), show: Array.from(this.bars) };
  }
  /** 频段映射摘要（Hz）：首段 / 末段 / 低频峰中心。核对"映射是不是 20Hz ~ 0.45×Nyquist"用，
      几个数、不分配数组，可以每帧塞进诊断对象。 */
  bandInfo() {
    const fMax = F_MAX_RATIO * (this.sampleRate / 2);
    const at = (b: number) => F_MIN * Math.pow(fMax / F_MIN, b / (SPECTRUM_BANDS - 1));
    const [na, nb] = this.needleBands(this.bassPeakBar());
    return {
      sampleRate: this.sampleRate,
      firstHz: Math.round(at(0) * 10) / 10,
      lastHz: Math.round(at(SPECTRUM_BANDS - 1)),
      bassPeakHz: Math.round(at(Math.round(BASS_WIDE_CENTER * (SPECTRUM_BANDS - 1))) * 10) / 10,
      kickBands: `${KICK_BAND_FROM}–${KICK_BAND_TO}`,
      bars: BAR_N,
      needleBands: `${na}–${nb - 1}`,
    };
  }
  /** 换曲时把峰值线清掉，免得上一首的峰值留在屏幕上 */
  resetPeaks() {
    this.peaks.fill(0);
    this.bars.fill(0);
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
    // 1.3.0 的归一化就是 N/4（N = 分析窗长 = 1024）
    return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - co * s1 * s2)) / (n / 4);
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
    /* ★ 段位照 1.3.0：第 2–16 带共 15 段（这里曾误用 2–8 共 7 段）——
       段数变了 onset 的灵敏度和频率范围都会变，鼓点泵动就跟不上拍子。 */
    let low = 0;
    for (let b = KICK_BAND_FROM; b <= KICK_BAND_TO; b++) low += this.bands[b];
    low /= KICK_BAND_N;
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
  /** 低频"细针"压在哪些分析频段上：柱 → 频段用同一套 bandOf 映射，
      返回 [a0, b0)，也就是第 a0 … b0−1 段（`bassPeakBar` 落在这一区间里）。
      ★ 这里量的是**频域**，与显示侧柱数无关：柱数 120 → 150 时 peakBar 由 9 变 11，
      区间仍是 [14,15)，细针中心仍是 14/119 —— 所以"细密一点"没动旧版导入的音色塑形。 */
  private needleBands(peakBar: number): [number, number] {
    const usable = Math.floor(SPECTRUM_BANDS * 0.98);
    const bandOf = (i: number) => Math.floor(Math.pow(i / BAR_N, 0.8) * usable);
    const a0 = bandOf(peakBar);
    return [a0, Math.max(a0 + 1, bandOf(peakBar + 1))];
  }
  private bassGainForTilt() {
    const bassPeakBar = this.bassPeakBar();
    const tilt = (50 - vizParams.tilt) / 50;
    const tp = Math.pow(5, tilt * (1 - bassPeakBar / BAR_N));
    return Math.max(-0.35, Math.min(3.0, vizParams.peakTarget / Math.max(0.15, tp) - 1));
  }
  private buildBandBoost() {
    const bassPeakBar = this.bassPeakBar();
    const [a0, b0] = this.needleBands(bassPeakBar);
    // 细针中心对准"低频峰所在柱"的正中心：不对准的话峰高会被摊到相邻两根上，再窄也尖不起来
    const needleCenter = (a0 + b0 - 1) / 2 / (SPECTRUM_BANDS - 1);
    const needleSigma = vizParams.bassSigma * 0.1875;
    const bassGain = this.bassGainForTilt();
    const g = new Float32Array(SPECTRUM_BANDS);
    for (let b = 0; b < SPECTRUM_BANDS; b++) {
      const f = b / (SPECTRUM_BANDS - 1);
      const uw = (f - BASS_WIDE_CENTER) / vizParams.bassSigma;
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

  /* ---------- 柱高流水线（★ 逐行照 1.3.0，不做任何平滑/降噪/调优） ---------- */
  private advance() {
    const n = BAR_N;
    const tilt = (50 - vizParams.tilt) / 50;
    const bars = this.bars;
    for (let i = 0; i < n; i++) {
      let v = this.sampleBand(i, n);
      v *= Math.pow(5, tilt * (1 - i / n)); // 倾斜补偿（低频端最高 5×）
      v = Math.pow(Math.min(1, v), 2.1); // 幂次曲线：拉大高低差
      // 鼓点用【乘法泵动】：加法会把十几根一起顶过 1.0 钳住，量化后顶端变成平直方块
      const pumpW = Math.exp(-Math.pow((i / n - 0.07) / 0.1, 2));
      v *= 1 - pumpW * vizParams.kickPump * (1 - this.kickEnergy);
      v += this.kickEnergy * 0.06 * pumpW;
      // 抖动：正弦行波（空间频率 JITTER_FREQ、相位每拍 +JITTER_STEP），
      // 向上幅度按剩余余量缩放，避免峰心两侧被一起钳住而失去针形
      const ph = i * jitterFreq() * Math.PI * 2 + this.jitterPhase;
      const headroom = Math.max(0, Math.min(1, (1 - v) / 0.45));
      v *= 1 + Math.sin(ph) * jitterAmp() * headroom;
      v = Math.max(0.02, Math.min(1, v));
      v = Math.round(v * (VIZ_LEVELS - 1)) / (VIZ_LEVELS - 1); // 14 级量化（阶梯感）
      // 量化后补一层"单边向下"的颤动：满高条的顶端不会看着是死的
      v *= 1 - jitterWobble() * (0.5 - 0.5 * Math.sin(ph));
      // 一阶跟随（系数随频率放缓）——老式的乘法自衰减会让尾巴拖得很长
      const atk = 0.7 - 0.2 * (i / n);
      const rel = 0.58 + 0.22 * (i / n);
      bars[i] = v > bars[i] ? bars[i] + (v - bars[i]) * atk : bars[i] + (v - bars[i]) * rel;
      // 峰值线按分析节拍衰减：放渲染循环里会随帧率变化
      this.peaks[i] = Math.max(this.peaks[i] * 0.97, bars[i]);
    }
    this.jitterPhase += jitterStep();
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
    const values = this.bars;
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
    const values = this.bars;
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
    const values = this.bars;
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
    const values = this.bars;
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

  /** 渲染节拍：重画当前柱高。
      1.3.0 是 30fps 边算边画，这里是 worker 30Hz 算、画布按 60fps 重画同一份 bars ——
      **画的就是那一个数组，不做二次插值**，所以 14 级阶梯与正弦抖动的观感与 1.3.0 完全一致，
      只是屏幕上的合成次数更多（滚动、缩放一类的合成更顺）。 */
  render(_dt: number) {
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
  /** 没有音频时把柱高收到静默状态 */
  decay() {
    let live = false;
    for (let i = 0; i < BAR_N; i++) {
      this.bars[i] *= 0.9;
      this.peaks[i] *= 0.94;
      if (this.bars[i] > 0.01) live = true;
    }
    this.kickEnergy = 0;
    return live;
  }
}
