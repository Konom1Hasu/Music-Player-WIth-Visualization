/*
 * selfmusic-spectrum.ts —— SelfMusic 频谱引擎（原版内核 + 16 项可调显示层）。
 *
 * 复刻来源（两处并作一处）：
 *   · `D:\SelfMusic\web\spectrum.mjs`（"干净基准版" JS 原文）——本文件的内核，
 *     逐行对齐：96 条对数频段（round+钳+单调化）/ Hann 4096 / 自研 radix-2 FFT 抽 bin /
 *     去直流 + RMS / 峰值归一 + log10(1+100·rel)/log10(101) / onset·tint·surge 三条乘性辅助 +
 *     "滑动高耸"窄峰（crest）/ 7 抽头 spread + 地板 / 每柱独立 attack·release 包络 +
 *     3 抽头水平平滑（回写状态）/ 独立峰值顶盖（peakFall 0.930）/ 静音归零。
 *   · `D:\SelfMusic\musicapp\selfmusic.py`（Python 权威，2026-10-13 20:34 版，735 行）——
 *     内核之上的**全部可调显示层**，逐行搬来：
 *       headroom     量程余量（>1 → 本帧最响带不到 1.0，留出"弹"的空间）
 *       contrast+floor+steep  削底噪 + 幂曲线 + 帧内突出度；steep 把倾斜斜坡"提前压下去"
 *       peakExpand+valleyKeep 对比扩张（unsharp）+ 非局部峰打折（高峰拆成尖塔）
 *       tilt         左×(1+t) → 右×(1−t) 斜坡（中间经 steep 幂重排）
 *       spreadPasses 「铺散」：5 抽头端点钳制横向扩散数遍（断崖 → 起伏）
 *       knee         顶端软膝：以上走对数肩、严格单调（不产生平顶方块）
 *       detail       细纹：细谱局部起伏 → 有界乘性小圆丘毛刺（先圆化再叠加）
 *       leftPump     左塔泵动：没拍时左塔回落 (1−深度)、一拍顶回满高
 *       bandAgc      逐带慢包络：中高频"有内容就立得起来"（乘性、零还是零）
 *       rightHf      右细节：短窗高频瞬态 + 细谱纹理点亮右区（max 只补不造）
 *       timbre       音色强调：鼓/贝斯/人声/镲四路各自活跃时把自己那一段抬高一截
 *       surgeAmp/tintAmp/release/onsetAmp/crestAmp  四条核心辅助的强度（原版字面量可调）
 *
 * 逐位口径（验收以"与 selfmusic.py 对拍 ≤1e-6"为准；全中性时 Python 侧已验证与
 * web/spectrum.mjs 逐帧一致）：
 *   · f32 存储：ring/comp/smooth/heights/peaks/tintSm/contrastSm/tonal/tonalBoost/agcEnv/
 *     timbreEnv/emphasis/rightW/pumpShape/各 timbre 权重；
 *   · f64 存储：mag/bandFreqs/hann/bandIndex/各 boost 与工作缓冲；
 *   · Python float（f64）标量：rmsMa/onset/bassMa/surge/slideAmp/slidePos/hfEnv/hiMa/
 *     hiLoMa/lowRise/hfLow/beatEnv 与全部 _f_* 系数；
 *   · tint 的频率平滑用 Math.fround（JS 原文如此）；其余按 selfmusic.py 的 numpy dtype 语义。
 *
 * ★ 默认 = SelfMusic 出厂默认（16 项滑块默认值的组合；那边同素材实测：断崖 0.618→0.129、
 *   左塔顶满 86%→21%、右区存活 0.243→0.580、锯齿 0.014→0.024）。想回到与 JS 原文
 *   逐位一致的中性态：new SelfSpectrumEngine({ display: SELFMUSIC_NEUTRAL_DISPLAY })。
 */

export const LOG10_101 = Math.log10(101);

/** 卷积核（与 web/spectrum.mjs 完全一致） */
const TINT_KERN = [0.15, 0.70, 0.15];
const SPREAD_KERN = [0.05, 0.12, 0.18, 0.22, 0.18, 0.12, 0.05];
const SMOOTH_KERN = [0.12, 0.76, 0.12];
/** 「铺散」5 抽头（端点钳制，不是零填充；selfmusic.py 的 SPREAD_TAPS） */
const SPREAD_TAPS = [0.1, 0.2, 0.4, 0.2, 0.1];

/** 核心辅助层的固定系数（原文里的字面量；onsetAmp/crestAmp 另做成实例属性可调） */
const ONSET_DECAY = 7.0;
const TINT_LO = 0.85, TINT_HI = 0.8;
const SURGE_DECAY = 6.0;
const CREST_WIDTH = 3.0;
const FLOOR_BASE = 0.030, FLOOR_SPREAD = 0.30;

/** np.convolve(src, kern, 'same')：核居中、越界按 0（核长度为奇数）。照 JS 原文的求和顺序。 */
function convolveSame(src: Float64Array | Float32Array, kern: number[], dst: Float64Array | Float32Array) {
  const n = src.length, kn = kern.length, c = (kn - 1) >> 1;
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = 0; j < kn; j++) {
      const idx = i + c - j;
      if (idx >= 0 && idx < n) acc += kern[j] * src[idx];
    }
    dst[i] = acc;
  }
  return dst;
}

/** 可调参数（引擎字段级；滑块 16 键经 smSliderPatch 映射到这里）。 */
export interface SelfMusicDisplayParams {
  /* —— 核心辅助强度 —— */
  headroom: number;      // 弹性：量程余量（滑块 100~300 → /100；出厂 160；1.0 = 原版逐帧归一）
  tintAmp: number;       // 毛刺：邻带对比度加成（滑块 0~60 → /100；出厂 45；原版 22）
  surgeAmp: number;      // 低频高耸（滑块 0~120 → /100；出厂 55；原版 55）
  release: number;       // 回落：包络回落速度（滑块 50~95 → /100；出厂 82；原版 82）
  /* —— 形状类（激进层） —— */
  contrast: number;      // 陡峭主力：幂曲线指数（陡峭滑块 70~300 → /100；出厂 160；1.0 = 关）
  contrastFloor: number; // 削底噪阈值（陡峭 >100 时 0.05；0 = 关）
  steep: number;         // 斜坡提前量（陡峭滑块 → max(0,(v-100)/100)；出厂 0.6；0 = 线性）
  peakExpand: number;    // 尖塔：对比扩张（滑块 100~340 → /100；出厂 100 = 关）
  valleyKeep: number;    // 谷深：非局部峰保留比例（滑块 20~100 → /100；出厂 100 = 关）
  expandRadius: number;  // 对比扩张/判峰的邻域半径（内部；默认 2）
  tilt: number;          // 倾斜（滑块 0~60 → /100；出厂 45）
  /* —— 新八组（默认值 = 出厂） —— */
  spreadPasses: number;  // 顺滑：铺散遍数（滑块 0~3；出厂 1）
  knee: number;          // 软膝起点（滑块 0~95 → /100；出厂 78；0 = 硬钳）
  kneeWidth: number;     // 软膝肩宽（内部；默认 0.60）
  kneeMax: number;       // 映射到 1.0 的输入值（内部；默认 2.0）
  detail: number;        // 细纹强度（滑块 0~120 → /100；出厂 50）
  detailSpan: number;    // 细纹的高通窗口（条）（内部；默认 15）
  detailLo: number;      // 细纹下限倍数（内部；默认 0.70）
  detailHi: number;      // 细纹上限倍数（内部；默认 1.45）
  leftPump: number;      // 左塔泵动深度（滑块 0~60 → /100；出厂 40）
  leftPumpDecay: number; // 泵动影响范围（条）（内部；默认 10）
  bandAgc: number;       // 右丰：逐带慢包络强度（滑块 0~100 → /100；出厂 0 = 关）
  agcFrom: number;       // AGC 生效起始位置（内部；默认 0.55）
  agcSlow: number;       // AGC 包络跟随速度（内部；默认 0.006）
  agcMax: number;        // AGC 最大提升倍数（内部；默认 8.0）
  rightHf: number;       // 右细节：高频瞬态填充强度（滑块 0~100 → /100；出厂 100）
  rightFrom: number;     // 右区起始位置（内部；默认 0.68）
  rightRamp: number;     // 右区渐入宽度（条）（内部；默认 12）
  shortSize: number;     // 短窗长度（≈12ms，高频瞬态检测）（内部；默认 512）
  timbre: number;        // 音色强调强度（滑块 0~100 → /100；出厂 45）
  timbreFloor: number;   // "主导"判定起点（内部；默认 0.30）
  timbrePow: number;     // 主导度指数（内部；默认 1.5）
  /* —— 开关 —— */
  idleBreathe: boolean;  // 静音呼吸（滑块 0/1；出厂 false = 归零）
  /* —— 辅助强度（原版字面量，一般不动） —— */
  onsetAmp: number;
  crestAmp: number;
}

/**
 * ★ 出厂默认 = **用户 SelfMusic 里实际在跑的档**（2026-10-13 21:58 抄自
 * `%LOCALAPPDATA%\MusicPlayerCache\ui.json` 的 16 个 `viz_*` 已调值）。
 * SelfMusic 启动链路（mainwindow.__init__ + 面板构造）：
 *   ① SpectrumAnalyzer(sample_rate=44100) 构造；
 *   ② analyzer.DEFAULT_PARAMS 覆盖（含 detail_hi=1.12 / detail_lo=0.60 —— 注意
 *      不是 selfmusic.py 类默认的 1.45/0.70，这是"类默认 ≠ 实际运行值"的一处）；
 *   ③ 面板 16 枚滑块把"已存值或面板默认"逐项 apply 回分析器（persist=False）。
 * 所以本档 = 该用户 ui.json 的实测档：
 *   顺滑 0 / 软膝 95 / 细纹 0 / 左塔泵动 60 / 弹性 300 / 右细节 80 / 右丰 100 /
 *   陡峭 114 / 倾斜 39 / 音色 93 / 毛刺 16 / 尖塔 100 / 低频高耸 110 / 回落 95 /
 *   谷深 100 / 静音呼吸 1；detailLo/Hi 取 DEFAULT_PARAMS 实际值 0.60/1.12。
 * 用户要求（2026-10-13）："我要参数，波形完全一致" —— 本档即"参数完全一致"的落点。
 */
export const SELFMUSIC_DISPLAY_DEFAULTS: SelfMusicDisplayParams = {
  headroom: 3.0,
  tintAmp: 0.16,
  surgeAmp: 1.10,
  release: 0.95,
  contrast: 1.14,
  contrastFloor: 0.05,
  steep: 0.14,
  peakExpand: 1.0,
  valleyKeep: 1.0,
  expandRadius: 2,
  tilt: 0.39,
  spreadPasses: 0,
  knee: 0.95,
  kneeWidth: 0.60,
  kneeMax: 2.0,
  detail: 0.0,
  detailSpan: 15,
  detailLo: 0.60,
  detailHi: 1.12,
  leftPump: 0.60,
  leftPumpDecay: 10.0,
  bandAgc: 1.0,
  agcFrom: 0.55,
  agcSlow: 0.006,
  agcMax: 8.0,
  rightHf: 0.80,
  rightFrom: 0.68,
  rightRamp: 12.0,
  shortSize: 512,
  timbre: 0.93,
  timbreFloor: 0.30,
  timbrePow: 1.5,
  idleBreathe: true,
  onsetAmp: 0.6,
  crestAmp: 0.85,
};

/** 中性 = 与 web/spectrum.mjs 逐位一致的全关组合（对拍/回退用）。
    ⚠ 必须把"构造器默认 ≠ 中性"的每一项都显式写回：除激进度全关外，还包括
    surgeAmp=0.55 / release=0.82（SURGE_AMP、release 类默认）与 detailLo/Hi=0.70/1.45
    —— 出厂档改成了用户实测档之后，这四个值不能再从默认档继承。 */
export const SELFMUSIC_NEUTRAL_DISPLAY: SelfMusicDisplayParams = {
  ...SELFMUSIC_DISPLAY_DEFAULTS,
  headroom: 1.0,
  tintAmp: 0.22,
  surgeAmp: 0.55,
  release: 0.82,
  contrast: 1.0,
  contrastFloor: 0.0,
  steep: 0.0,
  peakExpand: 1.0,
  valleyKeep: 1.0,
  tilt: 0.0,
  spreadPasses: 0,
  knee: 0.0,
  detail: 0.0,
  detailLo: 0.70,
  detailHi: 1.45,
  leftPump: 0.0,
  bandAgc: 0.0,
  rightHf: 0.0,
  timbre: 0.0,
  idleBreathe: false,
};

/** 滑块键（照 SelfMusic mainwindow 的 16 项「可视化调节」面板） */
export type SmSliderKey =
  | "smooth" | "knee" | "detail" | "leftpump" | "head" | "right" | "agc" | "steepq"
  | "tilt" | "timbre" | "tint" | "expanda" | "surge" | "release" | "valley" | "idle";

/** 滑块范围（UI 与 clamp 共用） */
export const SELFMUSIC_SLIDER_RANGES: Record<SmSliderKey, readonly [number, number]> = {
  smooth: [0, 3],
  knee: [0, 95],
  detail: [0, 120],
  leftpump: [0, 60],
  head: [100, 300],
  right: [0, 100],
  agc: [0, 100],
  steepq: [70, 300],
  tilt: [0, 60],
  timbre: [0, 100],
  tint: [0, 60],
  expanda: [100, 340],
  surge: [0, 120],
  release: [50, 95],
  valley: [20, 100],
  idle: [0, 1],
};

/** 滑块默认（= 出厂默认；2026-10-13 改为**用户 SelfMusic 实测档**，见上方
    SELFMUSIC_DISPLAY_DEFAULTS 的说明。原面板出厂值：1/78/50/40/160/100/0/160/45/45/45/100/55/82/100/0） */
export const SELFMUSIC_SLIDER_DEFAULTS: Record<SmSliderKey, number> = {
  smooth: 0,
  knee: 95,
  detail: 0,
  leftpump: 60,
  head: 300,
  right: 80,
  agc: 100,
  steepq: 114,
  tilt: 39,
  timbre: 93,
  tint: 16,
  expanda: 100,
  surge: 110,
  release: 95,
  valley: 100,
  idle: 1,
};

/** 滑块键 → 引擎参数 patch（换算照 mainwindow._apply_viz_param，逐行一致）。 */
export function smSliderPatch(key: SmSliderKey, value: number): Partial<SelfMusicDisplayParams> {
  switch (key) {
    case "steepq": {              // 陡峭 70~300 → 幂指数 v/100（主力）+ 斜坡提前 + 削底噪
      const c = value / 100.0;
      return {
        contrast: c,
        contrastFloor: value > 100 ? 0.05 : 0.0,
        steep: Math.max(0.0, (value - 100) / 100.0),
      };
    }
    case "smooth":   return { spreadPasses: Math.max(0, Math.min(3, Math.round(value))) };
    case "knee":     return { knee: value / 100.0 };
    case "detail":   return { detail: value / 100.0 };
    case "leftpump": return { leftPump: value / 100.0 };
    case "right":    return { rightHf: value / 100.0 };
    case "agc":      return { bandAgc: value / 100.0 };
    case "timbre":   return { timbre: value / 100.0 };
    case "expanda":  return { peakExpand: value / 100.0 };
    case "head":     return { headroom: value / 100.0 };
    case "tilt":     return { tilt: value / 100.0 };
    case "valley":   return { valleyKeep: value / 100.0 };
    case "surge":    return { surgeAmp: value / 100.0 };
    case "tint":     return { tintAmp: value / 100.0 };
    case "release":  return { release: value / 100.0 };
    case "idle":     return { idleBreathe: value >= 0.5 };
  }
}

/** 数值字段清单（setDisplayParams 逐键应用与约束）。 */
const NUMERIC_KEYS = [
  "headroom", "tintAmp", "surgeAmp", "release",
  "contrast", "contrastFloor", "steep", "peakExpand", "valleyKeep", "expandRadius", "tilt",
  "spreadPasses", "knee", "kneeWidth", "kneeMax", "detail", "detailSpan", "detailLo", "detailHi",
  "leftPump", "leftPumpDecay", "bandAgc", "agcFrom", "agcSlow", "agcMax",
  "rightHf", "rightFrom", "rightRamp", "shortSize", "timbre", "timbreFloor", "timbrePow",
  "onsetAmp", "crestAmp",
] as const;

export interface SelfSpectrumOpts {
  sampleRate?: number;
  bands?: number;
  fftSize?: number;
  fMin?: number;
  fMaxRatio?: number;
  attack?: number;
  peakFall?: number;
  kNorm?: number;
  /** 显示层参数覆盖（默认 = 出厂默认；对拍中性态传 SELFMUSIC_NEUTRAL_DISPLAY） */
  display?: Partial<SelfMusicDisplayParams>;
}

export class SelfSpectrumEngine {
  sampleRate: number;
  bands: number;
  N: number;
  fMin: number;
  fMaxRatio: number;
  fMax: number;
  attack: number;
  release: number;
  peakFall: number;
  kNorm: number;

  /* —— 显示层参数（setDisplayParams / smSliderPatch 改） —— */
  headroom: number;
  tintAmp: number;
  surgeAmp: number;
  contrast: number;
  contrastFloor: number;
  steep: number;
  peakExpand: number;
  valleyKeep: number;
  expandRadius: number;
  tilt: number;
  spreadPasses: number;
  knee: number;
  kneeWidth: number;
  kneeMax: number;
  detail: number;
  detailSpan: number;
  detailLo: number;
  detailHi: number;
  leftPump: number;
  leftPumpDecay: number;
  bandAgc: number;
  agcFrom: number;
  agcSlow: number;
  agcMax: number;
  rightHf: number;
  rightFrom: number;
  rightRamp: number;
  shortSize: number;
  timbre: number;
  timbreFloor: number;
  timbrePow: number;
  idleBreathe: boolean;
  onsetAmp: number;
  crestAmp: number;
  /* 音色四波段（中心 Hz, 八度数） */
  kickBand: [number, number];
  bassBand: [number, number];
  vocalBand: [number, number];
  cymbalBand: [number, number];

  /* —— 频段表 —— */
  bandFreqs: Float64Array;
  bandBins: Int32Array;
  bandIndex: Float64Array;
  hann: Float64Array;

  /** 发布高度（96 段，0..1，内部复用） */
  readonly heights: Float32Array;
  /** 峰值顶盖（×peakFall 衰减；供渲染层取用，可选） */
  readonly lastPeaks: Float32Array;
  /** 四路音色活跃度（照 selfmusic.py 的 last_timbre；渲染层左上角指示条用）。 */
  readonly lastTimbre = { kick: 0, bass: 0, vocal: 0, cymbal: 0 };

  /** 环形时域缓冲 */
  private ring: Float32Array;
  private ringPos = 0;
  /** 去直流后的整帧副本（f32；hf_detail 用） */
  private xDc: Float32Array;

  /* 逐帧状态（照 selfmusic.py 的 _reset_state；dtype 按 Python 对齐） */
  private smooth: Float32Array;
  private peaks: Float32Array;
  private tintSm: Float32Array;
  private contrastSm: Float32Array;
  private agcEnv: Float32Array;
  private timbreEnv: Float32Array;     // f32（4 路）
  private emphasis: Float32Array;      // f32
  private rmsMa = 0;                   // Python float（f64）
  private onset = 0;
  private bassMa = 0;
  private surge = 0;
  private slideAmp = 0;
  private slidePos = 0;
  private slideStart = 0;
  private slideSpeed = 0;
  private hfEnv = 0;
  private hiMa = 0;
  private hiLoMa = 0;
  private lowRise = 0;
  private hfLow = 0;
  private beatEnv = 0;
  private timbreMa: Float64Array;      // f64（4 路，np.full(4, 1e-6, float64)）

  /* 派生查表（_syncDisplay） */
  private _onsetShape: Float64Array;
  private _surgeShape: Float64Array;
  private _tiltRamp: Float64Array;
  private _rightW: Float32Array;
  private _pumpShape: Float32Array;
  private _agcRegion: Uint8Array;
  private _peakMask: Uint8Array;
  private _contrastBlock = false;
  private _peakBlock = false;
  private _logDen = Math.log10(101);

  /* timbre 权重（按真实 bin 频率的对数高斯） */
  private _binFreqs: Float64Array;
  private _wKick: Float32Array;
  private _wBass: Float32Array;
  private _wVocal: Float32Array;
  private _wCymbal: Float32Array;

  /* 预分配缓冲 */
  private mag: Float64Array;
  private comp: Float32Array;
  private tonal: Float32Array;
  private onsetBoost: Float64Array;
  private tonalBoost: Float32Array;
  private surgeBoost: Float64Array;
  private crest: Float64Array;
  private magSm: Float64Array;
  private neigh: Float64Array;
  private shapedBuf: Float64Array;
  private spreadBuf: Float64Array;
  private heightsF64: Float64Array;
  private localBuf: Float64Array;
  private _re: Float64Array;
  private _im: Float64Array;
  private maKernel: Float64Array;
  private maBuf: Float64Array;
  /* f32 小缓冲（铺散 ping-pong 与细纹） */
  private spreadPing: Float32Array;
  private spreadPong: Float32Array;
  private detailRaw: Float32Array;
  private detailSm: Float32Array;

  /* tick 折算（照 selfmusic.py set_tick_ms；20ms 时全部为原版系数） */
  private _rate = 1.0;
  private _fSurge = 0.88;
  private _fSlide = 0.965;
  private _fOnset = 0.80;
  private _fTint = 0.25;
  private _fContrast = 0.20;
  private _fRms = 0.10;
  private _fBass = 0.10;
  private _fPeak = 0.930;
  private _fAgc = 0.006;
  private _fHfMa = 0.06;
  private _fHfDecay = 0.75;
  private _fBeatDecay = 0.88;
  private _fTimbre = 0.82;
  private _fTimbreMa = 0.03;
  private _fIdleSurge = 0.90;
  private _fIdleSlide = 0.85;
  private _idleTick = 0;

  constructor(opts: SelfSpectrumOpts = {}) {
    this.sampleRate = opts.sampleRate || 44100;
    this.bands = Math.max(8, opts.bands || 96);
    this.N = Math.max(256, 1 << Math.ceil(Math.log2(Math.max(256, opts.fftSize || 4096))));
    this.fMin = opts.fMin == null ? 20.0 : Number(opts.fMin);
    this.fMaxRatio = opts.fMaxRatio == null ? 0.45 : Number(opts.fMaxRatio);
    this.attack = opts.attack == null ? 0.80 : Number(opts.attack);
    this.peakFall = opts.peakFall == null ? 0.930 : Number(opts.peakFall);
    this.kNorm = opts.kNorm == null ? 100 : Number(opts.kNorm);
    this.fMax = this.fMaxRatio * (this.sampleRate / 2);

    /* 显示层参数：默认 = 出厂默认（可被 opts.display 覆盖） */
    const d = SELFMUSIC_DISPLAY_DEFAULTS;
    this.headroom = d.headroom;
    this.tintAmp = d.tintAmp;
    this.surgeAmp = d.surgeAmp;
    this.release = d.release;
    this.contrast = d.contrast;
    this.contrastFloor = d.contrastFloor;
    this.steep = d.steep;
    this.peakExpand = d.peakExpand;
    this.valleyKeep = d.valleyKeep;
    this.expandRadius = d.expandRadius;
    this.tilt = d.tilt;
    this.spreadPasses = d.spreadPasses;
    this.knee = d.knee;
    this.kneeWidth = d.kneeWidth;
    this.kneeMax = Math.max(d.knee + 0.05, d.kneeMax);
    this.detail = d.detail;
    this.detailSpan = d.detailSpan;
    this.detailLo = d.detailLo;
    this.detailHi = d.detailHi;
    this.leftPump = d.leftPump;
    this.leftPumpDecay = d.leftPumpDecay;
    this.bandAgc = d.bandAgc;
    this.agcFrom = d.agcFrom;
    this.agcSlow = d.agcSlow;
    this.agcMax = d.agcMax;
    this.rightHf = d.rightHf;
    this.rightFrom = d.rightFrom;
    this.rightRamp = d.rightRamp;
    this.shortSize = d.shortSize;
    this.timbre = d.timbre;
    this.timbreFloor = d.timbreFloor;
    this.timbrePow = d.timbrePow;
    this.idleBreathe = d.idleBreathe;
    this.onsetAmp = d.onsetAmp;
    this.crestAmp = d.crestAmp;
    this.kickBand = [55.0, 0.60];
    this.bassBand = [85.0, 0.80];
    this.vocalBand = [1400.0, 1.15];
    this.cymbalBand = [8000.0, 0.55];

    /* 频段表（照原文：round → 钳 [1, N/2−1] → 单调化 → 再钳） */
    const B = this.bands;
    this.bandFreqs = new Float64Array(B);
    this.bandBins = new Int32Array(B);
    this.bandIndex = new Float64Array(B);
    for (let i = 0; i < B; i++) this.bandIndex[i] = i;

    this.hann = new Float64Array(this.N);
    for (let i = 0; i < this.N; i++) {
      this.hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (this.N - 1)));   // np.hanning(N)
    }

    /* 状态与缓冲 */
    this.ring = new Float32Array(this.N);
    this.xDc = new Float32Array(this.N);
    this.heights = new Float32Array(B);
    this.lastPeaks = new Float32Array(B);
    this.smooth = new Float32Array(B);
    this.peaks = new Float32Array(B);
    this.tintSm = new Float32Array(B).fill(0.5);
    this.contrastSm = new Float32Array(B).fill(1.0);
    this.agcEnv = new Float32Array(B);
    this.timbreEnv = new Float32Array(4);
    this.emphasis = new Float32Array(B).fill(1.0);
    this.timbreMa = new Float64Array(4).fill(1e-6);
    this.mag = new Float64Array(B);
    this.comp = new Float32Array(B);
    this.tonal = new Float32Array(B);
    this.onsetBoost = new Float64Array(B);
    this.tonalBoost = new Float32Array(B);
    this.surgeBoost = new Float64Array(B);
    this.crest = new Float64Array(B);
    this.magSm = new Float64Array(B);
    this.neigh = new Float64Array(B);
    this.shapedBuf = new Float64Array(B);
    this.spreadBuf = new Float64Array(B);
    this.heightsF64 = new Float64Array(B);
    this.localBuf = new Float64Array(B);
    this._re = new Float64Array(this.N);
    this._im = new Float64Array(this.N);
    this._onsetShape = new Float64Array(B);
    this._surgeShape = new Float64Array(B);
    this._tiltRamp = new Float64Array(B);
    this._rightW = new Float32Array(B);
    this._pumpShape = new Float32Array(B);
    this._agcRegion = new Uint8Array(B);
    this._peakMask = new Uint8Array(B);
    this._binFreqs = new Float64Array(B);
    this._wKick = new Float32Array(B);
    this._wBass = new Float32Array(B);
    this._wVocal = new Float32Array(B);
    this._wCymbal = new Float32Array(B);
    this.spreadPing = new Float32Array(B);
    this.spreadPong = new Float32Array(B);
    this.detailRaw = new Float32Array(B);
    this.detailSm = new Float32Array(B);
    this.maKernel = new Float64Array(1);
    this.maBuf = new Float64Array(1);

    /* bin 表 + timbre 权重（都用到上面已分配的缓冲）→ 低通核 → 派生查表 */
    this._fillBins();
    this._makeMaKernel();
    this._syncDisplay();
    this._rebuildSlide();
    this.setTickMs(20.0);

    if (opts.display) this.setDisplayParams(opts.display);
  }

  /** 频段 bin 表（round → 钳 → 单调化 → 再钳；照原文） */
  private _fillBins() {
    const B = this.bands, N = this.N;
    for (let i = 0; i < B; i++) {
      const frac = i / (B - 1);
      const freq = this.fMin * Math.pow(this.fMax / this.fMin, frac);
      let k = Math.round(freq * N / this.sampleRate);
      k = Math.min(Math.max(k, 1), N / 2 - 1);
      this.bandFreqs[i] = freq;
      this.bandBins[i] = k;
    }
    for (let i = 1; i < B; i++) {
      if (this.bandBins[i] <= this.bandBins[i - 1]) this.bandBins[i] = this.bandBins[i - 1] + 1;
    }
    for (let i = 0; i < B; i++) {
      this.bandBins[i] = Math.min(Math.max(this.bandBins[i], 1), N / 2 - 1);
    }
    this._buildTimbreWeights();   // 照 Python：_rebuild_bands 末尾也重建权重
  }

  /** 短窗低通核（≈460Hz 以下；照 Python _make_ma_kernel） */
  private _makeMaKernel() {
    const sr = Math.max(8000, this.sampleRate);
    let n = Math.max(3, Math.round(sr / 460.0));
    n += (n + 1) % 2;                        // 取奇数，便于对齐
    this.maKernel = new Float64Array(n).fill(1 / n);
  }

  /** 四路音色权重（按**真实被抽到的 bin 频率**算；照 Python _build_timbre_weights） */
  private _buildTimbreWeights() {
    const B = this.bands;
    const sr = Math.max(8000, this.sampleRate);
    for (let i = 0; i < B; i++) {
      this._binFreqs[i] = Math.max(this.bandBins[i] * sr / this.N, 1.0);
    }
    const gw = (dst: Float32Array, center: number, octs: number) => {
      const oc = Math.max(1e-3, octs);
      for (let i = 0; i < B; i++) {
        const r = Math.log2(this._binFreqs[i] / center) / oc;
        dst[i] = Math.exp(-0.5 * r * r);
      }
    };
    gw(this._wKick, this.kickBand[0], this.kickBand[1]);
    gw(this._wBass, this.bassBand[0], this.bassBand[1]);
    gw(this._wVocal, this.vocalBand[0], this.vocalBand[1]);
    gw(this._wCymbal, this.cymbalBand[0], this.cymbalBand[1]);
  }

  /** 由标量参数派生显示层查表（照 Python _sync_display） */
  private _syncDisplay() {
    const B = this.bands;
    for (let i = 0; i < B; i++) {
      this._onsetShape[i] = Math.exp(-i / ONSET_DECAY);
      this._surgeShape[i] = Math.exp(-i / SURGE_DECAY);
    }
    /* 倾斜斜坡（左端 1+tilt → 右端 1−tilt）；steep 用幂曲线重排中间：u**sp
       （sp<1 → 前段掉得快、后段变平），"陡"体现在左侧那段陡坡上。 */
    const den = Math.max(1.0, B - 1.0);
    const sp = 1.0 / (1.0 + this.steep);
    for (let i = 0; i < B; i++) {
      const u = i / den;
      const uu = sp !== 1.0 ? Math.pow(u, sp) : u;
      this._tiltRamp[i] = (1.0 + this.tilt) * (1.0 - uu) + (1.0 - this.tilt) * uu;
    }
    /* 右区权重剖面（渐入，避免接缝） */
    for (let i = 0; i < B; i++) {
      const w = (i / Math.max(1, B - 1) - this.rightFrom) * (B / Math.max(1.0, this.rightRamp));
      this._rightW[i] = w < 0 ? 0 : (w > 1 ? 1 : w);
    }
    /* AGC 生效区域掩码 */
    for (let i = 0; i < B; i++) {
      this._agcRegion[i] = i / Math.max(1, B - 1) >= this.agcFrom ? 1 : 0;
    }
    /* 左塔泵动的影响范围剖面 exp(−idx/decay) */
    const decay = Math.max(2.0, this.leftPumpDecay);
    for (let i = 0; i < B; i++) {
      this._pumpShape[i] = Math.exp(-i / decay);
    }
    this._contrastBlock = this.contrast !== 1.0 || this.contrastFloor > 0.0;
    this._peakBlock = this.peakExpand !== 1.0 || this.valleyKeep !== 1.0;
    this._logDen = Math.log10(1.0 + Math.max(1e-6, this.kNorm));
  }

  /** 滑动高耸的起点/速度（按条数缩放；照 Python _rebuild_slide） */
  private _rebuildSlide() {
    this.slideStart = Math.max(4.0, this.bands * 0.30);
    this.slideSpeed = Math.max(0.8, this.bands * 0.018);
    this.slidePos = this.slideStart;
    this.slideAmp = 0.0;
  }

  /** 告诉引擎"两帧之间真实过了多少毫秒"，把逐帧衰减折算到与 20ms 节奏等速（照 Python）。 */
  setTickMs(ms: number) {
    ms = Math.max(4.0, Math.min(200.0, Number(ms) || 20));
    const r = 20.0 / ms;
    this._rate = r;
    this._fSurge = Math.pow(0.88, r);
    this._fSlide = Math.pow(0.965, r);
    this._fOnset = Math.pow(0.80, r);
    this._fTint = 1.0 - Math.pow(0.75, r);
    this._fContrast = 1.0 - Math.pow(0.8, r);
    this._fRms = 1.0 - Math.pow(0.90, r);
    this._fBass = 1.0 - Math.pow(0.90, r);
    this._fPeak = Math.pow(this.peakFall, r);
    this._fAgc = 1.0 - Math.pow(1.0 - Math.max(1e-6, Math.min(0.5, this.agcSlow)), r);
    this._fHfMa = 1.0 - Math.pow(0.94, r);
    this._fHfDecay = Math.pow(0.75, r);
    this._fBeatDecay = Math.pow(0.88, r);
    this._fTimbre = Math.pow(0.82, r);
    this._fTimbreMa = 1.0 - Math.pow(0.97, r);
    this._fIdleSurge = Math.pow(0.9, r);
    this._fIdleSlide = Math.pow(0.85, r);
  }

  /** 参数局部更新（滑块实时调；约束照 selfmusic.py 构造器）。改完重建派生查表。 */
  setDisplayParams(patch: Partial<SelfMusicDisplayParams>) {
    const self = this as unknown as Record<string, number | boolean>;
    for (const k of NUMERIC_KEYS) {
      const v = (patch as Record<string, unknown>)[k];
      if (typeof v !== "number" || !isFinite(v)) continue;
      switch (k) {
        case "headroom": this.headroom = Math.max(1.0, v); break;
        case "expandRadius": this.expandRadius = Math.max(1, Math.floor(v)); break;
        case "steep": this.steep = Math.max(0.0, v); break;
        case "spreadPasses": this.spreadPasses = Math.max(0, Math.min(3, Math.floor(v))); break;
        case "rightRamp": this.rightRamp = Math.max(1.0, v); break;
        case "shortSize": this.shortSize = Math.max(64, Math.floor(v)); break;
        case "leftPumpDecay": this.leftPumpDecay = Math.max(2.0, v); break;
        case "kneeWidth": this.kneeWidth = Math.max(1e-3, v); break;
        case "kneeMax": this.kneeMax = Math.max(this.knee + 0.05, v); break;
        case "detailSpan": this.detailSpan = Math.max(3, Math.floor(v)); break;
        default: self[k] = v;
      }
    }
    if (typeof patch.idleBreathe === "boolean") this.idleBreathe = patch.idleBreathe;
    this._syncDisplay();
  }

  /** 设置音色四波段（改后重建权重） */
  setTimbreBands(bands: Partial<Record<"kick" | "bass" | "vocal" | "cymbal", [number, number]>>) {
    if (bands.kick) this.kickBand = [bands.kick[0], bands.kick[1]];
    if (bands.bass) this.bassBand = [bands.bass[0], bands.bass[1]];
    if (bands.vocal) this.vocalBand = [bands.vocal[0], bands.vocal[1]];
    if (bands.cymbal) this.cymbalBand = [bands.cymbal[0], bands.cymbal[1]];
    this._buildTimbreWeights();
  }

  setSampleRate(sr: number) {
    if (sr > 0 && sr !== this.sampleRate) {
      this.sampleRate = sr;
      this.fMax = this.fMaxRatio * (this.sampleRate / 2);
      this._fillBins();
      this._makeMaKernel();
      this._syncDisplay();
    }
  }

  /** 喂一帧时域（float32）。m ≥ N 时整窗替换（= 最近 N 点）；否则按环形缓冲累积。 */
  push(frame: Float32Array) {
    const N = this.N, m = frame.length;
    if (!m) return;
    if (m >= N) { this.ring.set(frame.subarray(m - N, m)); this.ringPos = 0; return; }
    const free = N - this.ringPos;
    if (m <= free) {
      this.ring.set(frame.subarray(0, m), this.ringPos);
      this.ringPos += m;
    } else {
      const first = m - free;
      this.ring.set(frame.subarray(0, free), this.ringPos);
      this.ring.set(frame.subarray(free, m), 0);
      this.ringPos = first;
    }
    if (this.ringPos >= N) this.ringPos = 0;
  }

  /** 状态归零（切歌/重置；照 Python reset） */
  reset() {
    this.ring.fill(0);
    this.ringPos = 0;
    this.smooth.fill(0);
    this.peaks.fill(0);
    this.tintSm.fill(0.5);
    this.contrastSm.fill(1.0);
    this.agcEnv.fill(0);
    this.timbreEnv.fill(0);
    this.lastTimbre.kick = 0; this.lastTimbre.bass = 0;
    this.lastTimbre.vocal = 0; this.lastTimbre.cymbal = 0;
    this.emphasis.fill(1.0);
    this.timbreMa.fill(1e-6);
    this.rmsMa = 0; this.onset = 0; this.bassMa = 0; this.surge = 0;
    this.slideAmp = 0; this.slidePos = this.slideStart;
    this.hfEnv = 0; this.hiMa = 0; this.hiLoMa = 0; this.lowRise = 0; this.hfLow = 0;
    this.beatEnv = 0;
    this.heights.fill(0);
    this.comp.fill(0);
    this._idleTick = 0;
    return this;
  }

  /** 就地 radix-2 FFT（double）。输入实序列在 this._re，输出在 _re/_im。照 JS 原文。 */
  private _fft() {
    const n = this.N, re = this._re, im = this._im;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        const half = len >> 1;
        for (let j = 0; j < half; j++) {
          const a = i + j, b = i + j + half;
          const xr = re[b] * cr - im[b] * ci;
          const xi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr;        im[a] += xi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  /** 短窗高频瞬态（≈12ms）：镲/军鼓/气声的细节 + 低频突增（鼓）。照 Python _hf_detail。 */
  private _hfDetail(x: Float32Array) {
    const L = Math.min(this.shortSize, x.length);
    if (L < 64) {
      this.hfEnv *= this._fHfDecay;
      this.lowRise = 0.0;
      return;
    }
    const n = this.maKernel.length;
    const m = L - n + 1;                      // np.convolve(short, kernel, 'valid')
    if (this.maBuf.length < m) this.maBuf = new Float64Array(m);
    const ma = this.maBuf;
    const start = x.length - L;
    for (let i = 0; i < m; i++) {
      let acc = 0;
      for (let j = 0; j < n; j++) acc += this.maKernel[n - 1 - j] * x[start + i + j];
      ma[i] = acc;
    }
    let accL = 0;
    for (let i = 0; i < m; i++) accL += ma[i] * ma[i];
    const low = Math.sqrt(accL / m);
    /* resid = short 的最后 m 个样本（窗口中心对齐） */
    let accH = 0;
    for (let i = 0; i < m; i++) {
      const r = x[start + L - m + i] - ma[i];
      accH += r * r;
    }
    const hi = Math.sqrt(accH / m);
    this.hiMa += this._fHfMa * (hi - this.hiMa);
    const rise = Math.max(0.0, hi / (this.hiMa + 1e-7) - 1.0);
    this.hfEnv = Math.max(this.hfEnv * this._fHfDecay, Math.min(1.0, rise * 1.6));
    this.hiLoMa += this._fHfMa * (low - this.hiLoMa);
    this.lowRise = Math.max(0.0, low / (this.hiLoMa + 1e-7) - 1.0);
    this.hfLow = low;
  }

  /** 四路音色活跃度 + 强调增益（照 Python _timbre_activity）。 */
  private _timbreActivity() {
    const B = this.bands, mag = this.mag;
    let framePk = 0;
    for (let i = 0; i < B; i++) if (mag[i] > framePk) framePk = mag[i];
    framePk += 1e-12;
    const fl = Math.max(0.0, Math.min(0.95, this.timbreFloor));
    const pw = Math.max(0.2, this.timbrePow);
    const dom = (x: number) => {
      const t = (x / framePk - fl) / Math.max(1e-6, 1.0 - fl);
      const c = t < 0 ? 0 : (t > 1 ? 1 : t);
      return Math.pow(c, pw);
    };
    const ws = [this._wKick, this._wBass, this._wVocal, this._wCymbal];
    const pks = new Float64Array(4);
    for (let t = 0; t < 4; t++) {
      const w = ws[t];
      let mx = 0;
      for (let i = 0; i < B; i++) { const v = mag[i] * w[i]; if (v > mx) mx = v; }
      pks[t] = mx;
    }
    for (let t = 0; t < 4; t++) this.timbreMa[t] += this._fTimbreMa * (pks[t] - this.timbreMa[t]);
    const rel = new Float64Array(4);
    const doms = new Float64Array(4);
    for (let t = 0; t < 4; t++) {
      let r = (pks[t] / Math.max(this.timbreMa[t], 1e-9) - 1.0) / 0.8;
      r = r < 0 ? 0 : (r > 1 ? 1 : r);
      rel[t] = r;
      doms[t] = dom(pks[t]);
    }
    let kickHit = Math.max(0.0, this.lowRise) * 1.8;
    kickHit = kickHit < 0 ? 0 : (kickHit > 1 ? 1 : kickHit);
    const actLvl3 = Math.max(rel[2], doms[2]);
    const actLvl4 = Math.max(rel[3], doms[3]);
    const act = new Float32Array(4);
    act[0] = Math.max(kickHit * doms[1], kickHit * rel[1]);       // 鼓：低频突增且低频主导
    act[1] = doms[1] * (1.0 - kickHit);                           // 贝斯：低频铺底
    act[2] = actLvl3;                                             // 人声/旋律
    act[3] = actLvl4;                                             // 镲/空气
    for (let t = 0; t < 4; t++) {
      const v = Math.max(act[t], this.timbreEnv[t] * this._fTimbre);
      this.timbreEnv[t] = v;
    }
    /* 快照（照 selfmusic.py 的 last_timbre：取平滑后的 env 值，f32 存储读成 number） */
    this.lastTimbre.kick = this.timbreEnv[0];
    this.lastTimbre.bass = this.timbreEnv[1];
    this.lastTimbre.vocal = this.timbreEnv[2];
    this.lastTimbre.cymbal = this.timbreEnv[3];
    for (let i = 0; i < B; i++) {
      let emph = 0;
      for (let t = 0; t < 4; t++) {
        const a = this.timbreEnv[t];
        if (a > 1e-4) emph += a * ws[t][i];
      }
      const c = emph < 0 ? 0 : (emph > 1 ? 1 : emph);
      this.emphasis[i] = 1.0 + this.timbre * c;
    }
  }

  /** 顶端软膝：knee 以下线性、以上对数肩压向 1.0（严格单调）。照 Python _soft_knee。 */
  private _softKnee(v: Float32Array) {
    const B = this.bands;
    const k = Math.min(0.98, Math.max(0.05, this.knee));
    const w = this.kneeWidth;
    const top = Math.max(k + 1e-3, this.kneeMax);
    const den = Math.log1p((top - k) / w);
    for (let i = 0; i < B; i++) {
      const x = v[i];
      if (x > k) {
        const t = (x - k) / w;
        v[i] = k + (1.0 - k) * (Math.log1p(t) / den);
      }
    }
  }

  /** 一遍 5 抽头横向扩散（**端点钳制**：边界取最近的有效条，不是补零）。照 Python _spread_once。 */
  private _spreadOnce(src: Float32Array, dst: Float32Array) {
    const B = this.bands;
    for (let i = 0; i < B; i++) {
      let acc = 0;
      for (let j = 0; j < 5; j++) {
        let idx = i + j - 2;
        idx = idx < 0 ? 0 : (idx > B - 1 ? B - 1 : idx);
        acc += SPREAD_TAPS[j] * src[idx];
      }
      dst[i] = acc;
    }
  }

  /** 细纹用的邻域均值（mag 的 detailSpan 窗口均值；照 Python _detail_idx 的 clip 语义）。 */
  private _detailNeighborMean(i: number) {
    const B = this.bands;
    const d = Math.floor(this.detailSpan / 2);
    let acc = 0;
    for (let j = -d; j <= d; j++) {
      let idx = i + j;
      idx = idx < 0 ? 0 : (idx > B - 1 ? B - 1 : idx);
      acc += this.mag[idx];
    }
    return acc / (2 * d + 1);
  }

  /** 激进层：对比扩张（unsharp）+ 非局部峰打折（照 Python _apply_peak_layer）。 */
  private _applyPeakLayer(shaped: Float64Array) {
    const B = this.bands;
    const r = this.expandRadius;
    if (this.peakExpand !== 1.0) {
      const local = this.localBuf;
      for (let i = 0; i < B; i++) {
        const lo = Math.max(0, i - r);
        const hi = Math.min(B, i + r + 1);
        let acc = 0;
        for (let j = lo; j < hi; j++) acc += shaped[j];
        local[i] = acc / (hi - lo);
      }
      for (let i = 0; i < B; i++) {
        const v = local[i] + this.peakExpand * (shaped[i] - local[i]);
        shaped[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
      }
    }
    if (this.valleyKeep !== 1.0) {
      /* ★ 两遍：先全量判峰（用未修改的 shaped），再统一打折。
         Python 侧是 np.where 整数组乘（所有乘法同时发生）；
         若边判边改，前一根被削小的值会污染后一根的邻域 max。 */
      for (let i = 0; i < B; i++) {
        const lo = Math.max(0, i - r);
        const hi = Math.min(B, i + r + 1);
        let mx = -Infinity;
        for (let j = lo; j < hi; j++) if (shaped[j] > mx) mx = shaped[j];
        this._peakMask[i] = (shaped[i] > 0 && shaped[i] >= mx) ? 1 : 0;
      }
      for (let i = 0; i < B; i++) if (!this._peakMask[i]) shaped[i] *= this.valleyKeep;
    }
  }

  /** 无信号时的轻缓"呼吸"（照 Python _idle_pattern；默认 idleBreathe=false 不启用） */
  private _idlePattern() {
    const B = this.bands;
    this._idleTick += 1;
    const t = this._idleTick;
    for (let k = 0; k < B; k++) {
      const base = 0.015 + 0.035 * (0.6 * Math.sin(k * 0.45 + t * 0.02)
                                  + 0.4 * Math.sin(k * 1.13 - t * 0.013));
      const b = Math.min(0.12, Math.max(0, base));
      this.smooth[k] = b * 0.6 + this.smooth[k] * 0.4;
      const cap = this.peaks[k] * this._fPeak;
      this.peaks[k] = this.smooth[k] > cap ? this.smooth[k] : cap;
      this.heights[k] = this.smooth[k];
      this.lastPeaks[k] = this.peaks[k];
    }
    this.surge *= this._fIdleSurge;
    this.slideAmp *= this._fIdleSlide;
    if (this.slideAmp < 0.02) {
      this.slideAmp = 0.0;
      this.slidePos = this.slideStart;
    } else {
      this.slidePos = Math.max(0.0, this.slidePos - this.slideSpeed * this._rate);
    }
  }

  /** 每帧一次：返回发布高度（96 段，0..1，内部复用）。 */
  compute(): Float32Array {
    const N = this.N, B = this.bands;

    /* 1) 去直流 + RMS（x 按 f32 舍入存储，与 numpy 语义一致） */
    let mean = 0;
    for (let i = 0; i < N; i++) mean += this.ring[i];
    mean /= N;
    let acc = 0;
    for (let i = 0; i < N; i++) {
      const xi = Math.fround(this.ring[i] - mean);
      this.xDc[i] = xi;
      this._re[i] = xi;
      acc += Math.fround(xi * xi);
    }
    const rms = Math.fround(Math.sqrt(acc / N));
    this._im.fill(0);

    /* 静音门：smooth 清零、顶盖继续回落（照 Python：heights 也归零） */
    if (rms < 1.2e-4) {
      if (this.idleBreathe) {
        this._idlePattern();
      } else {
        this.smooth.fill(0);
        for (let i = 0; i < B; i++) this.peaks[i] *= this.peakFall;
        this.heights.fill(0);
        for (let i = 0; i < B; i++) this.lastPeaks[i] = this.peaks[i];
      }
      return this.heights;
    }

    /* 2) Hann + rfft + 抽 bin */
    for (let i = 0; i < N; i++) this._re[i] *= this.hann[i];
    this._fft();
    let peak = 0;
    for (let b = 0; b < B; b++) {
      const k = this.bandBins[b];
      const mm = Math.hypot(this._re[k], this._im[k]);
      this.mag[b] = mm;
      if (mm > peak) peak = mm;
    }
    if (peak <= 1e-12) {
      for (let i = 0; i < B; i++) {
        this.smooth[i] *= 0.8;
        this.peaks[i] *= this.peakFall;
        this.heights[i] = this.smooth[i];
        this.lastPeaks[i] = this.peaks[i];
      }
      return this.heights;
    }

    /* 3) 峰值归一 + 量程余量 + log10(1+K·rel)（comp 存 f32） */
    const kd = this.kNorm;
    const hr = Math.max(1.0, this.headroom);
    for (let b = 0; b < B; b++) {
      const rel = this.mag[b] / peak / hr;
      const v = Math.log10(1 + kd * Math.min(1.0, rel)) / this._logDen;
      this.comp[b] = v < 0 ? 0 : (v > 1 ? 1 : v);
    }

    /* 3b) 削底噪 + 幂曲线 + 帧内突出度（照 Python；出厂开） */
    if (this._contrastBlock) {
      const f0 = Math.min(0.95, Math.max(0, this.contrastFloor));
      const invF = Math.max(1e-6, 1.0 - f0);
      let meanX = 0;
      for (let b = 0; b < B; b++) {
        let xv = (this.comp[b] - f0) / invF;
        xv = xv < 0 ? 0 : (xv > 1 ? 1 : xv);
        xv = Math.pow(xv, this.contrast);
        this.onsetBoost[b] = xv;             // 暂存 xv（复用缓冲；下一步会被覆盖）
        meanX += xv;
      }
      meanX = meanX / B + 1e-6;
      for (let b = 0; b < B; b++) {
        const xv = this.onsetBoost[b];
        const prom = Math.min(1.2, Math.max(0, xv / meanX - 0.7));
        this.comp[b] = Math.min(1, Math.max(0, xv * (0.70 + 0.70 * prom)));
      }
    }

    /* 4) onset：时域 RMS 突增 → 锚定最左端；随后短窗瞬态（右区细节 + 鼓） */
    this.rmsMa += this._fRms * (rms - this.rmsMa);
    const atk = Math.max(0, (rms - this.rmsMa) / (this.rmsMa + 1e-6));
    this.onset = Math.min(1, Math.max(atk * 1.6 / this._rate, this.onset * this._fOnset));
    for (let b = 0; b < B; b++) {
      this.onsetBoost[b] = 1 + this.onsetAmp * this.onset * this._onsetShape[b];
    }
    this._hfDetail(this.xDc);
    if (this.timbre > 0.0) this._timbreActivity();

    /* 5) tint：邻带对比度 → 乐音/噪声 */
    const mag = this.mag;
    convolveSame(mag, TINT_KERN, this.magSm);
    for (let i = 0; i < B; i++) this.magSm[i] += 1e-9;
    const neigh = this.neigh;
    for (let i = 0; i < B; i++) neigh[i] = 0;
    for (let i = 1; i < B; i++) neigh[i] += this.magSm[i - 1];
    for (let i = 0; i + 1 < B; i++) neigh[i] += this.magSm[i + 1];
    for (let i = 1; i + 1 < B; i++) neigh[i] /= 2.0;
    neigh[0] = B > 1 ? neigh[1] : 1.0;
    neigh[B - 1] = B > 1 ? neigh[B - 2] : 1.0;
    const fContrast = Math.fround(this._fContrast);
    for (let i = 0; i < B; i++) {
      const contrast = this.magSm[i] / Math.max(neigh[i], 1e-9);
      const c32 = Math.fround(contrast);
      const cs = this.contrastSm[i];
      const nc = Math.fround(cs + Math.fround(fContrast * (c32 - cs)));   // f32 域更新
      this.contrastSm[i] = nc;
      let t = (nc - TINT_LO) / TINT_HI;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      this.tonal[i] = t;
      this.tonalBoost[i] = 1 + Math.fround(this.tintAmp) * t;
    }

    /* 6) surge：低频突增 → 左端短暂高耸 + 滑动窄峰（crest） */
    let bassE = 0;
    for (let i = 0; i < B; i++) if (this.bandFreqs[i] <= 170.0) bassE = Math.max(bassE, mag[i]);
    this.bassMa += this._fBass * (bassE - this.bassMa);
    const jump = bassE - 1.5 * this.bassMa;
    if (jump / (this.bassMa + 1e-5) > 0.5) {
      this.surge = 1.0;
      this.slideAmp = 1.0;
      this.slidePos = this.slideStart;
    } else {
      this.surge *= this._fSurge;
    }
    this.slideAmp *= this._fSlide;
    if (this.slideAmp < 0.02) {
      this.slideAmp = 0.0;
      this.slidePos = this.slideStart;
    } else {
      this.slidePos = Math.max(0.0, this.slidePos - this.slideSpeed * this._rate);
    }
    for (let b = 0; b < B; b++) {
      const anchor = this.surge * this._surgeShape[b];
      this.surgeBoost[b] = 1 + this.surgeAmp * anchor;
      this.crest[b] = this.slideAmp * Math.exp(-0.5 * Math.pow((b - this.slidePos) / CREST_WIDTH, 2));
    }

    /* 7) shaped = comp×onset×tonal×surge + crest×crestAmp +（tilt）＋（音色）＋（AGC）＋（右细节） */
    const shaped = this.shapedBuf;
    for (let i = 0; i < B; i++) {
      shaped[i] = this.comp[i] * this.onsetBoost[i] * this.tonalBoost[i] * this.surgeBoost[i]
                + this.crestAmp * this.crest[i];
    }
    if (this.tilt !== 0.0) {
      for (let i = 0; i < B; i++) shaped[i] *= this._tiltRamp[i];
    }
    if (this.timbre > 0.0) {
      for (let i = 0; i < B; i++) shaped[i] *= this.emphasis[i];
    }
    if (this.bandAgc > 0.0) {
      /* 逐带慢包络：归一到一个共同参考电平（乘性、零还是零，上限 agcMax） */
      const fAgc = this._fAgc;
      for (let i = 0; i < B; i++) {
        const s32 = Math.fround(shaped[i]);
        this.agcEnv[i] = Math.fround(this.agcEnv[i] + Math.fround(fAgc * (s32 - this.agcEnv[i])));
      }
      let cnt = 0;
      for (let i = 0; i < B; i++) if (this._agcRegion[i]) cnt++;
      if (cnt > 0) {
        /* 60 分位（numpy.percentile 线性插值法） */
        const vals = new Float64Array(cnt);
        let w = 0;
        for (let i = 0; i < B; i++) if (this._agcRegion[i]) vals[w++] = this.agcEnv[i];
        vals.sort();
        const pos = (cnt - 1) * 0.6;
        const lo = Math.floor(pos), fr = pos - lo;
        const ref = lo + 1 < cnt ? vals[lo] + fr * (vals[lo + 1] - vals[lo]) : vals[lo];
        for (let i = 0; i < B; i++) {
          if (!this._agcRegion[i]) continue;
          const g0 = ref / Math.max(this.agcEnv[i], 0.02);
          const g = g0 < 1 ? 1 : (g0 > this.agcMax ? this.agcMax : g0);
          shaped[i] *= 1.0 + this.bandAgc * (g - 1.0);
        }
      }
    }
    if (this.rightHf > 0.0) {
      /* 右区"其他音色的细节"填充：max(原始, 细节)，只补不造 */
      for (let i = 0; i < B; i++) {
        const detail = this.rightHf * this._rightW[i] * this.hfEnv * (0.35 + 0.65 * this.tonal[i]);
        if (detail > shaped[i]) shaped[i] = detail;
      }
    }

    /* 8) 峰层 + 7 抽头 spread + 地板 +（左塔泵动）——全 f64 链，最后一次性 cast */
    if (this._peakBlock) this._applyPeakLayer(shaped);
    const spread = convolveSame(shaped, SPREAD_KERN, this.spreadBuf);
    for (let i = 0; i < B; i++) {
      shaped[i] = Math.max(shaped[i], FLOOR_BASE + FLOOR_SPREAD * spread[i]);
    }
    if (this.leftPump > 0.0) {
      /* 没拍时左塔回落到 (1−深度)、一拍顶回满高（加在地板**之后**） */
      this.beatEnv = Math.max(this.beatEnv * this._fBeatDecay, this.surge, this.onset);
      for (let i = 0; i < B; i++) {
        shaped[i] *= 1.0 - this.leftPump * (1.0 - this.beatEnv) * this._pumpShape[i];
      }
    }
    for (let i = 0; i < B; i++) {
      const v = shaped[i];
      this.heights[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
    }

    /* 9) 包络 + 3 抽头水平平滑 → 铺散 → 软膝 → 细纹（heights 链，照 Python） */
    for (let i = 0; i < B; i++) {
      const s = this.smooth[i], t = this.heights[i];
      this.smooth[i] = t >= s ? s + this.attack * (t - s) : s + this.release * (t - s);
    }
    convolveSame(this.smooth, SMOOTH_KERN, this.heightsF64);
    for (let i = 0; i < B; i++) this.heights[i] = this.heightsF64[i];

    if (this.spreadPasses > 0) {
      /* 铺散：把"断崖"磨成"起伏"（端点钳制；0 遍 = 与 JS 原文逐位） */
      let cur: Float32Array = this.heights;
      for (let p = 0; p < this.spreadPasses; p++) {
        const next = p % 2 === 0 ? this.spreadPing : this.spreadPong;
        this._spreadOnce(cur, next);
        cur = next;
      }
      if (cur !== this.heights) this.heights.set(cur);
    }
    if (this.knee > 0.0) this._softKnee(this.heights);
    if (this.detail > 0.0 && this.detailSpan >= 3) {
      /* 细纹：细谱局部起伏 → 有界乘性小圆丘（先圆化再叠加） */
      const g = this.detailRaw;
      for (let i = 0; i < B; i++) {
        const wide = Math.max(this._detailNeighborMean(i), 1e-12);
        let gg = this.mag[i] / wide;
        gg = gg < this.detailLo ? this.detailLo : (gg > this.detailHi ? this.detailHi : gg);
        g[i] = gg;
      }
      this._spreadOnce(g, this.detailSm);
      const gb = this.detailSm;
      for (let i = 0; i < B; i++) {
        this.heights[i] = this.heights[i] * (1.0 + this.detail * (gb[i] - 1.0));
      }
    }
    for (let i = 0; i < B; i++) {
      let v = this.heights[i];
      v = v < 0 ? 0 : (v > 1 ? 1 : v);
      this.heights[i] = v;
      this.smooth[i] = v;
    }

    /* 10) 峰值顶盖 + tint 平滑 */
    const fTint = Math.fround(this._fTint);
    for (let i = 0; i < B; i++) {
      const cap = this.peaks[i] * this._fPeak;
      this.peaks[i] = this.heights[i] > cap ? this.heights[i] : cap;
      const ts = this.tintSm[i];
      this.tintSm[i] = Math.fround(ts + fTint * (this.tonal[i] - ts));
      this.lastPeaks[i] = this.peaks[i];
    }
    return this.heights;
  }
}
