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
  /* 当前帧数据（长度 = 引擎频段数；来源：applyExternalBars） */
  private bars = new Float32Array(0);
  private peaks = new Float32Array(0);
  /** 四路音色活跃度（引擎输出快照；诊断与探针会读，故公开只读引用） */
  readonly gauges = { kick: 0, bass: 0, vocal: 0, cymbal: 0 };
  /* 渐变缓存（按高度 + 调色板做键；与原版每帧新建 QLinearGradient 不同，结果一致） */
  private grad: CanvasGradient | null = null;
  private gradKey = "";
  private rgb = new Map<string, [number, number, number]>();

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
    if (this.bars.length !== src.length) {
      this.bars = new Float32Array(src.length);
      this.peaks = new Float32Array(src.length);
    }
    const n = src.length;
    for (let i = 0; i < n; i++) {
      const v = src[i];
      this.bars[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
    if (peaksSrc && peaksSrc.length === n) {
      for (let i = 0; i < n; i++) {
        const v = peaksSrc[i];
        this.peaks[i] = v < 0 ? 0 : v > 1 ? 1 : v;
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
      const cl = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
      g.kick = cl(gauges.kick); g.bass = cl(gauges.bass);
      g.vocal = cl(gauges.vocal); g.cymbal = cl(gauges.cymbal);
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
    this.gauges.kick = 0; this.gauges.bass = 0; this.gauges.vocal = 0; this.gauges.cymbal = 0;
  }

  /** 播放条的 52 格刻度直接取柱高（1.3.0 起就是直接读数组） */
  get levels() {
    return this.bars;
  }

  /** 当前峰值顶盖数组（探针用；与引擎同帧同源） */
  get peakLevels() {
    return this.peaks;
  }

  /** 渲染节拍：原版每帧直接画，不做插值（与 SelfMusic 的 QWidget 逐帧重画同口径）。 */
  render(_dt: number) {
    this.draw();
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
    this.drawBars(ctx, w, h, n);
  }

  /** 柱 + 峰值顶盖 + 左上角四路指示条（照 visualizer.py paintEvent）。 */
  private drawBars(ctx: CanvasRenderingContext2D, w: number, h: number, n: number) {
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

    /* 左上角：四路音色活跃度（鼓 / 低音 / 人声 / 镲）—— 哪几路正被推高一目了然 */
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
