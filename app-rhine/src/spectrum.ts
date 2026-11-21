/* spectrum.ts —— 频谱绘制层：SelfMusic 桌面端 visualizer 的 Canvas 直译。
 *
 * 来源：D:\SelfMusic\musicapp\widgets\visualizer.py（2026-10-13 版，244 行）——
 * 本模块把它的 paintEvent 逐条搬进 Canvas2D。**只负责画**，不参与任何算法：
 *   · 柱贴底、高 = v×(h−8)、宽 = 槽位 70%、左右各留 6px（全部为 CSS px，按画布
 *     像素比换算：画布像素宽是显示宽的 1.5 倍（954 = 636×1.5），绝对尺寸要乘回来）；
 *   · 不透明度随高度：alpha = 0.45 + 0.55·v（逐柱设置，与原版一致）；
 *   · 竖直渐变：亮 → 主色（0.45 处）→ 暗底；
 *   · 峰值顶盖：cap > 0.004 就画（每根柱都有），2px、alpha 0.85、y = h − ph − 3；
 *   · 左上角四路音色指示条（鼓 / 低音 / 人声 / 镲）。
 *
 * 颜色取本机主题调色板（player.ts 的 spectrumPalette()）：原版的"白色顶盖 +
 * 多色渐变"绑死在它的暗色主题上；本仓按同一套**规则**换成本机色 ——
 * 顶盖 / 指示条用"主题对比色"（浅底用墨色、深底用白色，视认性等效于原版）。
 *
 * ★ v2.7.7（用户："将频谱，算法全部换为 SelfMusic 的"）：旧的 1.3.0 内部流水线
 * （Goertzel 频段 / 五种样式 / 绘制插值 / 节拍先验 / 顶端补抖 / 旧调音参数）已整体
 * 删除 —— 频谱只剩这一条"SelfMusic 原版"绘制路径，数据由 selfmusic-live 逐帧直供
 * （heights / peaks 直接来自引擎，柱数 = 引擎频段数，不再重采样到 150）。
 */

/* ---------- 原版的绝对尺寸（CSS px；来自 visualizer.py paintEvent） ---------- */
const PAD_X = 6.0; // 左右留白
const USABLE_PAD = 8.0; // usable = h − 8（柱高上限的余量）
const BAR_W_RATIO = 0.70; // 柱宽 = 槽位 × 0.70
const CAP_MIN = 0.004; // 峰值顶盖的显示门槛（cap > 0.004 才画）
const CAP_THICK = 2.0; // 顶盖厚度
const CAP_GAP = 3.0; // 顶盖悬在峰值之上 3px：y = h − ph − 3
const GAUGE_X = 8.0; // 四路指示条：起点 / 标签宽 / 条宽 / 条高 / 间距
const GAUGE_Y = 6.0;
const GAUGE_LABEL_W = 30.0;
const GAUGE_W = 38.0;
const GAUGE_H = 5.0;
const GAUGE_GAP = 10.0;
const GAUGE_FONT_PT = 8.0; // 原版 setPointSize(8)

/** 峰值顶盖在没有引擎 peaks 时的显示层回落系数（旧口径保留，调用方一般直传引擎 peaks） */
const FALLBACK_PEAK_DECAY = 0.9;

/** 夹到 [0,1]。

    ★ NaN 必须被吃掉，不能"放行"。原来写的是 `v < 0 ? 0 : v > 1 ? 1 : v` ——
    NaN 与任何数比较都是 false，于是 NaN 原样落进 bars / peaks，再经
    prev + (target − prev)·a 扩散到整帧：Canvas 的 fillRect 收到 NaN 高度时
    整根柱直接消失（偶发"少几根柱"，很难复现）。引擎侧出一次 NaN 就够发生。 */
function clamp01(v: number): number {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
}

export interface SpectrumPalette {
  /** 渐变顶端（最亮） */
  light: string;
  /** 渐变 0.45 处（主色） */
  strong: string;
  /** 渐变底端（最暗） */
  base: string;
  /** 峰值顶盖 + 指示条文字/轨道（主题对比色：浅底取墨色、深底取白） */
  cap: string;
}

/* 三段式色标插值（照 visualizer.py 的 _lerp_stop：按位置表线性插值，t 先钳到 [0,1]） */
function parseHex(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0];
}
function lerpStops(stops: Array<[number, [number, number, number]]>, t: number): string {
  const tt = t < 0 ? 0 : t > 1 ? 1 : t;
  if (tt <= stops[0][0]) return `rgb(${stops[0][1].join(",")})`;
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, c0] = stops[i];
    const [p1, c1] = stops[i + 1];
    if (tt <= p1) {
      if (p1 === p0) return `rgb(${c1.join(",")})`;
      const k = (tt - p0) / (p1 - p0);
      return `rgb(${Math.round(c0[0] + (c1[0] - c0[0]) * k)},${Math.round(c0[1] + (c1[1] - c0[1]) * k)},${Math.round(c0[2] + (c1[2] - c0[2]) * k)})`;
    }
  }
  return `rgb(${stops[stops.length - 1][1].join(",")})`;
}

/** 圆角矩形路径（等价 Qt 的 drawRoundedRect，半径 = h/2 时即胶囊形） */
function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export class Spectrum {
  private palette: SpectrumPalette = {
    light: "#c9a878",
    strong: "#9b7247",
    base: "#252820",
    cap: "#252820",
  };
  /* 当前帧数据（长度 = 引擎频段数；来源：applyExternalBars）—— 这是**目标值**，
     引擎每 16ms 才更新一次；屏幕上的值见 curBars / curPeaks。 */
  private bars = new Float32Array(0);
  private peaks = new Float32Array(0);
  /* ---------- 显示层帧间过渡（v1.2，2026-11-14「抖动有点抽搐」）----------
     引擎（SelfMusic）62Hz 出一组柱高，rAF 在 165Hz 屏上 6.06ms 一帧：
     同一组数据被 2~3 帧重复，下一组再整体跳一次 —— 时间被量化，肉眼就是
     "抖 + 一抽一抽"。这里把引擎输出当目标，渲染时按【两次喂数之间的实测间隔】
     线性过渡：不加延迟、不改峰值高度、不动 16 项参数。
     ★ decor = 0 的对拍路径仍画原始值（bars / peaks），这一层只服务加饰档。 */
  private curBars = new Float32Array(0);
  private curPeaks = new Float32Array(0);
  private prevBars = new Float32Array(0);
  private prevPeaks = new Float32Array(0);
  private feedAt = 0; // 上一次喂数的时间戳（performance.now）
  private feedSpan = 1 / 62; // 两次喂数的实测间隔（秒），初值按 62Hz
  private lerpT = 0; // 自上一次次喂数后累积的秒数
  /** 四路音色活跃度（引擎输出快照；诊断与探针会读，故公开只读引用） */
  readonly gauges = { kick: 0, bass: 0, vocal: 0, cymbal: 0 };
  /* 渐变缓存（按高度 + 调色板做键；与原版每帧新建 QLinearGradient 不同，结果一致） */
  private grad: CanvasGradient | null = null;
  private gradKey = "";
  private rgb = new Map<string, [number, number, number]>();
  /* ---------- 加饰层（v1.1，2026-11-14「可视化还有点薄」）----------
     ★ 铁律：decor = 0 走的仍是 visualizer.py 的逐条直译（drawBarsPlain），
       柱高 / 停点 / alpha 公式一个数都不动 —— 像素对拍照样能跑。
       加饰只在 decor ≥ 1 时叠在上面：底衬、基线刻度、两级辉光、柱顶高光、接地光。
       全部只用 fillRect + 缓存渐变 + lighter，每帧不新建对象（核显 Intel UHD 跑过）。 */
  private decor = 1;
  private floorGrad: CanvasGradient | null = null;
  private floorKey = "";
  private veilGrad: CanvasGradient | null = null;
  private veilKey = "";
  /* ---------- 每帧临时数组（P2 优化）----------
     天际线原先每帧 `const pts: Array<[number, number]> = []` 再 push n 个二元组：
     62Hz 喂数 × 满载帧率，等于每秒造出上万个小数组交给 GC 去扫（96 根柱时更明显）。
     改成两个预分配的 Float32Array，尺寸随柱数变，绘制时只写不建。 */
  private ptsX = new Float32Array(0);
  private ptsY = new Float32Array(0);

  /** 0 = 纯复刻（原版形状，逐位对拍用）1 = 加饰（默认）2 = 加饰 + 顶部光幕 */
  setDecor(level: number) {
    const v = Math.max(0, Math.min(2, Math.round(level) || 0));
    if (v === this.decor) return;
    this.decor = v;
    this.floorKey = "";
    this.veilKey = "";
  }
  get decorLevel() {
    return this.decor;
  }

  constructor(private canvas: HTMLCanvasElement) {}

  setPalette(palette: Partial<SpectrumPalette>) {
    this.palette = { ...this.palette, ...palette };
    this.gradKey = "";
  }

  /** 外部（SelfMusic 引擎）算好的一帧直接交给渲染层：
      heights / peaks 与引擎同帧同源；gauges 为四路音色活跃度（可省略）。
      ★ v2.7.7 起柱数不再重采样 —— n = src.length（= 引擎频段数 96），
      画的就是引擎每一条频段。 */
  applyExternalBars(src: ArrayLike<number>, peaksSrc?: ArrayLike<number> | null, gauges?: { kick: number; bass: number; vocal: number; cymbal: number } | null) {
    const n = src.length;
    if (this.bars.length !== n) {
      this.bars = new Float32Array(n);
      this.peaks = new Float32Array(n);
      this.curBars = new Float32Array(n);
      this.curPeaks = new Float32Array(n);
      this.prevBars = new Float32Array(n);
      this.prevPeaks = new Float32Array(n);
      this.ptsX = new Float32Array(n);
      this.ptsY = new Float32Array(n);
      this.lerpT = 0;
    }
    /* 喂数间隔 → 这一组数据要摊到多长的渲染时间里。夹在 8~60ms：
       定时器偶尔抖一下（Windows 定时器粒度）也不会把过渡拉成一坨。 */
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (this.feedAt > 0) {
      const span = (now - this.feedAt) / 1000;
      if (span > 0.008 && span < 0.06) this.feedSpan = span;
    }
    this.feedAt = now;
    this.lerpT = 0;
    /* 过渡起点 = 此刻屏幕上的位置（不是上一组的目标值）：接着走，不回头。 */
    this.prevBars.set(this.curBars);
    this.prevPeaks.set(this.curPeaks);
    for (let i = 0; i < n; i++) {
      this.bars[i] = clamp01(src[i]);
    }
    if (peaksSrc && peaksSrc.length === n) {
      for (let i = 0; i < n; i++) {
        this.peaks[i] = clamp01(peaksSrc[i]);
      }
    } else {
      /* 老口径兜底：显示层 max-hold（调用方一般直传引擎 peaks，这条只保证不崩） */
      for (let i = 0; i < n; i++) {
        const v = this.bars[i];
        this.peaks[i] = Math.max(this.peaks[i] * FALLBACK_PEAK_DECAY, v);
      }
    }
    if (gauges) {
      const g = this.gauges;
      g.kick = clamp01(gauges.kick); g.bass = clamp01(gauges.bass);
      g.vocal = clamp01(gauges.vocal); g.cymbal = clamp01(gauges.cymbal);
    }
  }

  /** 没有音频时把画面收到静默（停播后柱高/顶盖/指示条一起消退）。 */
  decay() {
    let live = false;
    const n = this.bars.length;
    for (let i = 0; i < n; i++) {
      this.bars[i] *= 0.9;
      this.peaks[i] *= 0.9;
      if (this.bars[i] > 0.01) live = true;
    }
    const g = this.gauges;
    g.kick *= 0.9; g.bass *= 0.9; g.vocal *= 0.9; g.cymbal *= 0.9;
    return live;
  }

  /** 换曲时清干净：屏幕上的旧形状不该"滑"到新曲子 */
  resetPeaks() {
    this.bars.fill(0);
    this.peaks.fill(0);
    /* 显示层一并归零：否则换曲瞬间会从旧形状平滑滑过去一格（16ms 的一跳） */
    this.curBars.fill(0);
    this.curPeaks.fill(0);
    this.prevBars.fill(0);
    this.prevPeaks.fill(0);
    this.lerpT = 0;
    this.gauges.kick = 0; this.gauges.bass = 0; this.gauges.vocal = 0; this.gauges.cymbal = 0;
  }

  /** 播放条的 52 格刻度直接取柱高（1.3.0 起就是直接读数组）。
      加饰档取过渡后的显示值 —— 那排小条和主画布同一帧同一份数，
      否则主画布顺了、小条还在按 62Hz 一顿一顿地跳。 */
  get levels() {
    return this.decor === 0 || this.curBars.length === 0 ? this.bars : this.curBars;
  }

  /** 当前峰值顶盖数组（探针用；与引擎同帧同源） */
  get peakLevels() {
    return this.peaks;
  }

  /** 渲染节拍：先把显示值按 dt 往前推，再画。
      decor = 0 仍画原始值（像素对拍口径不变），decor ≥ 1 画过渡后的显示值。 */
  render(dt: number) {
    /* ★ 画布已经脱离文档（详情页切走 / 面板正在重绘）就别算也别画。
       脱离文档的 canvas 依然能 getContext + 绘制，而那全是白干的活；
       更要紧的是别让一个没人看的实例继续挂在 rAF 里烧 CPU。
       注意：只挡绘制，不动数据 —— 回到详情页时新画布会拿到新的实例。 */
    if (!this.canvas.isConnected) return;
    this.advance(dt);
    this.draw();
  }

  /** 显示值推进：在【上一次喂数 → 这一次喂数】的实测间隔里线性走到目标。
      走满间隔后 a 锁 1 —— 数据停了就停在目标上，不外推，不会自己飘。 */
  private advance(dt: number) {
    const n = this.curBars.length;
    if (n === 0) return;
    this.lerpT += dt > 0 ? Math.min(0.1, dt) : 0;
    const a = this.feedSpan > 0 ? Math.min(1, this.lerpT / this.feedSpan) : 1;
    for (let i = 0; i < n; i++) {
      this.curBars[i] = this.prevBars[i] + (this.bars[i] - this.prevBars[i]) * a;
      this.curPeaks[i] = this.prevPeaks[i] + (this.peaks[i] - this.prevPeaks[i]) * a;
    }
  }

  /* ---------- 绘制 ---------- */
  /** 画布像素 / 显示宽的比值（954 像素宽显示在 636 时 = 1.5）。
      原版的绝对尺寸都是 CSS px，绘制前统一乘它。 */
  private scale(): number {
    const cw = this.canvas.clientWidth;
    if (!cw) return 1;
    const s = this.canvas.width / cw;
    return s >= 0.5 && s <= 3 ? s : 1;
  }
  private makeGrad(ctx: CanvasRenderingContext2D, h: number) {
    const key = `g${h}|${this.palette.light}|${this.palette.strong}|${this.palette.base}`;
    if (this.gradKey !== key || !this.grad) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, this.palette.light);
      g.addColorStop(0.45, this.palette.strong); // 原版 0.45 处 = 色标中位
      g.addColorStop(1, this.palette.base);
      this.grad = g;
      this.gradKey = key;
    }
    return this.grad;
  }
  private color(hex: string): [number, number, number] {
    let c = this.rgb.get(hex);
    if (!c) {
      c = parseHex(hex);
      this.rgb.set(hex, c);
    }
    return c;
  }

  private draw() {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);
    const n = this.bars.length;
    if (n < 2) return;
    if (this.decor === 0) this.drawBarsPlain(ctx, w, h, n);
    else this.drawBarsRich(ctx, w, h, n);
    this.drawGauges(ctx, w, h);
  }

  /** 柱 + 峰值顶盖（照 visualizer.py paintEvent 的柱体段，decor = 0 的路径）。 */
  private drawBarsPlain(ctx: CanvasRenderingContext2D, w: number, h: number, n: number) {
    const s = this.scale();
    const padX = PAD_X * s;
    const usable = h - USABLE_PAD * s;
    const slot = (w - padX * 2) / n;
    const barW = Math.min(slot, Math.max(s * 1.0, slot * BAR_W_RATIO));
    const grad = this.makeGrad(ctx, h);
    const capColor = `rgba(${this.color(this.palette.cap).join(",")},0.85)`;

    ctx.fillStyle = grad;
    for (let i = 0; i < n; i++) {
      const level = this.bars[i];
      const cap = this.peaks[i];
      const x = padX + i * slot + (slot - barW) / 2;
      const bh = Math.max(2 * s, level * usable);
      /* 高度越大越不透明（原版 globalAlpha = 0.45 + 0.55·v） */
      ctx.globalAlpha = 0.45 + 0.55 * level;
      ctx.fillRect(x, h - bh, barW, bh);
      /* 峰值顶盖：cap > 0.004 就画（2px 对比色短线，悬在峰值上方 3px） */
      if (cap > CAP_MIN) {
        const ph = Math.max(2 * s, cap * usable);
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = capColor;
        ctx.fillRect(x, h - ph - CAP_GAP * s, barW, CAP_THICK * s);
        ctx.fillStyle = grad;
      }
    }

    /* ★ 收尾：把逐柱设下的透明度归位（原版 p.setOpacity(1.0)）。
       少这一行的后果很隐蔽：指示条会跟着**最后一根柱**的透明度一起变淡 ——
       柱高偏低时整组指示条直接看不见（像素对拍里就是这么抓出来的）。 */
    ctx.globalAlpha = 1;
  }

  /* ---------- 加饰版（decor ≥ 1）----------
     同一批柱、同一套数值，只往上叠层次。每层的粒度都留在 s = 画布/显示 比值上，
     所以 1.5 倍画布和 1 倍画布下粗细一致。 */
  private drawBarsRich(ctx: CanvasRenderingContext2D, w: number, h: number, n: number) {
    const s = this.scale();
    const padX = PAD_X * s;
    const usable = h - USABLE_PAD * s;
    const slot = (w - padX * 2) / n;
    const barW = Math.min(slot, Math.max(s * 1.0, slot * BAR_W_RATIO));
    const grad = this.makeGrad(ctx, h);
    const capColor = `rgba(${this.color(this.palette.cap).join(",")},0.85)`;
    const [lr, lg, lb] = this.color(this.palette.light);
    /* 亮色实体 + globalAlpha 组合：等价于原来每条柱现拼一个 `rgba(r,g,b,a)` 字符串，
       但不产生每帧上百个短命字符串（同一帧里两处高频填充都要用它）。 */
    const lightSolid = `rgb(${lr},${lg},${lb})`;

    /* ① 槽位刻度：柱贴底却没有着落点，看着发飘；这排短脚给每根柱标出"站哪儿"。
       ★ 不做整块底衬 —— 试过（h*0.55 以下铺一层 base 色），浅底上不明显、
       深底上直接把下半屏刷成一片灰雾，把柱子的明暗关系全糊掉。地面感交给 ⑦ 接地光。 */
    const baseY = h;
    const [cr0, cg0, cb0] = this.color(this.palette.cap);
    ctx.fillStyle = `rgba(${cr0},${cg0},${cb0},0.11)`;
    ctx.fillRect(padX, baseY - Math.max(1, s * 0.9), w - padX * 2, Math.max(1, s * 0.9));
    ctx.fillStyle = `rgba(${cr0},${cg0},${cb0},0.10)`;
    for (let i = 0; i < n; i++) {
      ctx.fillRect(padX + i * slot, baseY - 3.4 * s, slot, Math.max(1, s * 1.1));
    }

    /* ② 接地带：底边一条渐变带，色取对比色（浅底=墨色地影、深底=白色地光），
       透明度跟整体平均能量走。
       ★★ 必须画在柱【之前】：上一版画在柱之后，α 最高 0.55，直接把底部 14% 的
       矮柱整根压掉 —— 高频区那一排（镲 / 齿音 / 泛音）糊成一条暗带，
       就是"突出音色丢失"的来源。现在柱体永远压在它上面，只在柱间隙露出地面感。 */
    let sum = 0;
    for (let i = 0; i < n; i++) sum += this.curBars[i];
    const energy = sum / n;
    const fh = Math.max(8 * s, usable * 0.14);
    ctx.globalAlpha = Math.min(1, 0.08 + 0.35 * energy);
    ctx.fillStyle = this.makeFloor(ctx, h, fh);
    ctx.fillRect(padX, baseY - fh, w - padX * 2, fh);

    /* ③ 辉光：加宽矩形 + lighter 叠加，两级近似软边。
       不用 shadowBlur —— 那是逐次高斯，96 根柱每帧会直接把核显拖死。
       ★ 只留一层：实测第二层（宽 2.6×、α 0.04）肉眼看不出，却要多付 96 次填充。 */
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = lightSolid;
    for (let i = 0; i < n; i++) {
      const level = this.curBars[i];
      if (level < 0.06) continue;
      const bh = Math.max(2 * s, level * usable);
      const x = padX + i * slot + (slot - barW) / 2;
      const w2 = barW * 1.9;
      ctx.globalAlpha = 0.11 * level;
      ctx.fillRect(x - (w2 - barW) / 2, baseY - bh, w2, bh);
    }
    ctx.globalCompositeOperation = "source-over";

    /* ④ 柱体（与原版逐条一致）+ 柱顶高光 */
    for (let i = 0; i < n; i++) {
      const level = this.curBars[i];
      const cap = this.curPeaks[i];
      const x = padX + i * slot + (slot - barW) / 2;
      const bh = Math.max(2 * s, level * usable);
      ctx.fillStyle = grad;
      ctx.globalAlpha = 0.45 + 0.55 * level;
      ctx.fillRect(x, baseY - bh, barW, bh);
      /* 顶端打亮：柱越高越亮，给尖端一层"实体"，不然高峰顶端是暗色的 */
      if (level > 0.05) {
        ctx.globalAlpha = 0.15 + 0.5 * level;
        ctx.fillStyle = lightSolid;
        ctx.fillRect(x, baseY - bh, barW, Math.max(1.2 * s, s * 2.2));
        ctx.fillStyle = grad;
      }
      if (cap > CAP_MIN) {
        const ph = Math.max(2 * s, cap * usable);
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = capColor;
        ctx.fillRect(x, baseY - ph - CAP_GAP * s, barW, CAP_THICK * s);
        ctx.fillStyle = grad;
      }
    }

    /* ⑤ 天际线：柱顶连成的包络。
       ★ 用直连折线，不用中点二次曲线 —— 中点在孤立峰上取的是 (prev+cur)/2，
       会把单根或两根柱的尖峰"切角"，突出的独奏音色看着就被抹平了。
       折线忠实跟着每根柱的峰顶走，视觉上就是"数据的轮廓"而不是"美化过的曲线"。 */
    /* 每帧只写预分配的两个 Float32Array，不再造 [x,y] 二元组数组 */
    if (this.ptsX.length !== n) {
      this.ptsX = new Float32Array(n);
      this.ptsY = new Float32Array(n);
    }
    const ptsX = this.ptsX;
    const ptsY = this.ptsY;
    for (let i = 0; i < n; i++) {
      ptsX[i] = padX + i * slot + slot / 2;
      ptsY[i] = baseY - Math.max(2 * s, this.curBars[i] * usable);
    }
    const [cr, cg, cb] = this.color(this.palette.cap);
    ctx.beginPath();
    ctx.moveTo(ptsX[0], ptsY[0]);
    for (let i = 1; i < n; i++) ctx.lineTo(ptsX[i], ptsY[i]);
    ctx.strokeStyle = `rgba(${cr},${cg},${cb},1)`;
    ctx.globalAlpha = 0.10;
    ctx.lineWidth = Math.max(2 * s, 2 * s);
    ctx.stroke();
    ctx.globalAlpha = 0.34;
    ctx.lineWidth = Math.max(1, 1.1 * s);
    ctx.stroke();

    /* ⑥ decor = 2：顶部光幕（自上而下淡出的一层薄光，按能量呼吸；只画一次） */
    if (this.decor >= 2) {
      const vh = Math.max(8 * s, usable * 0.12);
      ctx.globalCompositeOperation = "lighter";
      ctx.globalAlpha = Math.min(1, 0.16 + 0.9 * energy);
      ctx.fillStyle = this.makeVeil(ctx, h, vh);
      ctx.fillRect(padX, 0, w - padX * 2, vh);
      ctx.globalCompositeOperation = "source-over";
    }

    ctx.globalAlpha = 1;
  }

  /** 接地光渐变：底边最亮，向上 14% 内散掉（色取对比色：浅底墨、深底白） */
  private makeFloor(ctx: CanvasRenderingContext2D, h: number, fh: number) {
    const key = `f${h}|${fh}|${this.palette.cap}`;
    if (this.floorKey !== key || !this.floorGrad) {
      const [r, g0, b] = this.color(this.palette.cap);
      const g = ctx.createLinearGradient(0, h - fh, 0, h);
      g.addColorStop(0, `rgba(${r},${g0},${b},0)`);
      g.addColorStop(0.6, `rgba(${r},${g0},${b},0.08)`);
      g.addColorStop(1, `rgba(${r},${g0},${b},0.20)`);
      this.floorGrad = g;
      this.floorKey = key;
    }
    return this.floorGrad;
  }

  /** 顶部光幕渐变：顶端最亮，向下 vh 内散掉（decor = 2 用） */
  private makeVeil(ctx: CanvasRenderingContext2D, h: number, vh: number) {
    const key = `v${h}|${vh}|${this.palette.light}`;
    if (this.veilKey !== key || !this.veilGrad) {
      const [lr, lg, lb] = this.color(this.palette.light);
      const g = ctx.createLinearGradient(0, 0, 0, vh);
      g.addColorStop(0, `rgba(${lr},${lg},${lb},0.16)`);
      g.addColorStop(0.45, `rgba(${lr},${lg},${lb},0.05)`);
      g.addColorStop(1, `rgba(${lr},${lg},${lb},0)`);
      this.veilGrad = g;
      this.veilKey = key;
    }
    return this.veilGrad;
  }

  /** 左上角四路音色活跃度（鼓 / 低音 / 人声 / 镲）—— 哪几路正被推高一目了然。
      两条绘制路径共用；写在最后，所以永远压在最上层。 */
  private drawGauges(ctx: CanvasRenderingContext2D, _w: number, h: number) {
    const s = this.scale();
    const g = this.gauges;
    const ink = this.color(this.palette.cap);
    const gx = GAUGE_X * s;
    const gy = GAUGE_Y * s;
    const labelW = GAUGE_LABEL_W * s;
    const mw = GAUGE_W * s;
    const mh = GAUGE_H * s;
    const gap = GAUGE_GAP * s;
    const items: Array<[string, number]> = [
      ["鼓", g.kick], ["低音", g.bass], ["人声", g.vocal], ["镲", g.cymbal],
    ];
    const stops: Array<[number, [number, number, number]]> = [
      [0, this.color(this.palette.base)],
      [0.45, this.color(this.palette.strong)], // 与原版一样：中位停点在 0.45
      [1, this.color(this.palette.light)],
    ];
    ctx.font = `${((GAUGE_FONT_PT * 4) / 3 * s).toFixed(2)}px "Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    let x = gx;
    for (let k = 0; k < items.length; k++) {
      const [label, v] = items[k];
      ctx.fillStyle = `rgba(${ink.join(",")},0.784)`; // 原版 TEXT_DIM α200
      ctx.fillText(label, x, gy + 4 * s);
      x += labelW;
      ctx.fillStyle = `rgba(${ink.join(",")},0.102)`; // 轨道：原版 白 α26 → 本机对比色同透明度
      roundRectPath(ctx, x, gy, mw, mh, mh / 2);
      ctx.fill();
      if (v > 0.01) {
        /* 活跃度填充：越活跃越亮（原版 = 色标 t=0.55+0.45·v 处的颜色） */
        ctx.fillStyle = lerpStops(stops, Math.min(1, 0.55 + 0.45 * v));
        roundRectPath(ctx, x, gy, Math.max(2 * s, mw * v), mh, mh / 2);
        ctx.fill();
      }
      x += mw + gap;
    }
    ctx.globalAlpha = 1;
  }
}
