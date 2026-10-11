// @ts-nocheck
/* ★ 参考实现来源：D:\SelfMusic\web\spectrum.mjs（1513 行，v16 自测 97 项）
   ────────────────────────────────────────────────────────────────────────────
   用户："可视化算法可以读取D盘的 SelfMusic 项目文件作为参考"。
   这一份是原样移植（除本文件头与 @ts-nocheck，内容逐字节与源头一致），
   同一套算法的 Python 版在 D:\SelfMusic\musicapp\analyzer.py，C++ 版在 cpp\ComputeSpectrumImproved.*。
   用途：给播放器提供**另一档**频谱算法做 A/B（默认不启用，见 player.ts 的 SELF_ALGO 开关），
   避免又一次"改了默认观感但没人看过"。 */
// ============================================================================
// spectrum.mjs —— 自研频谱引擎（computeCustomSpectrum 的数据源核心）
//
// 与 C++ 参考实现 FFTProcessor::computeSpectrum 逐条对齐：
//   * Hann 加窗：N=4096 点窗（analyser.fftSize 同步设为 4096），降低频谱泄漏；
//   * Goertzel 单 bin 计算：96 个对数频段（frac=i/(bands-1)），铺满
//     20Hz ~ 0.45×Nyquist，高频不再丢失；内层循环只有乘加、无三角函数
//     （系数 2cos(2πk/N) 预计算）；**分数 bin 位置线性插值取样**（不再取整/
//     单调化），相邻频段在自身窗宽内轮换取子 bin（±0.25 bin）→ 邻带只是
//     轻度去相关（偏移很小 → 邻条读到接近的谱位置 → 顶端连线近似连续）；
//   * 跳过 DC：最低频段从 k=1 起，第 0 条不被直流污染；
//   * 峰值归一 + 对数压缩 log10(1+200·rel)/log10(201)：响度无关——
//     安静的歌不整体贴底、响亮的歌不整体顶格，内部差异始终可见
//     （归一自洽：rel=1 恰好映射到 1.0）；
//   * **细节形变**（detail_span=11 / detail_power=0.85 / detail_lo=0.58 / detail_hi=1.58，
//     默认在对比度流水线**之前**施加）：低频档 1024 点窗的 bin 宽 ≈43Hz，20~550Hz 这
//     ~40 根低频条可能只落在 9 个 bin 上 → 插值出来是一片等高平台（"存在大片"）。
//     这里用**长窗细谱**（fftSize 窗 ≈10.8Hz/bin，每带取自己的整数 bin）算出"相对邻域的
//     起伏"，以**有界乘性**形变加回去（峰更峰、谷更谷）→ 平台被拆成有起伏的坡；
//     振幅有上下限、且在 11 根条的尺度上平滑，所以顶端连线依然连续、不会变回锯齿；
//   * **频谱倾斜**（tilt=0.85 / tilt_lo=0.15 / tilt_hi=1.90）：`u = i/(bands-1)`，
//     `ramp = clip(1 + tilt·(1−2u), lo, hi)` → 左端 ×1.85、右端 ×0.15，整条频谱
//     "向低端（左端）靠"。乘性施加、有上下限，位置在**增益与顶端软膝之前**
//     （基础起伏原样保留、不会削出饱和平台；零能量条依然严格为 0）；
//     音色计量走未倾斜的 `rel` → 计量测的仍是真实音频；`tilt=0` 关闭；
//   * **轻微的**局部极大值抑制（±1 带邻域，valleyKeep=0.85 / peakKeepRatio=0.92）：
//     只削掉真正的尖刺，其余频段几乎原样保留 → 顶端连线**近似连续**，
//     高低走向（梯度）完整保留 —— 全部由频谱自身形状推导，无任何随机/时间噪声；
//   * 顶端软膝（`topKnee=0.75` / `topWidth=0.60` / `topMax=12.0`，在渲染层
//     `composeHeights` 里、增益叠加**之后**执行，与 Python 同序）：
//     膝下**线性**（峰谷梯度原样保留）、膝上对数肩**严格单调** → 不出现平顶天花板；
//   * **高峰离散化**（两项，都作用在软膝之后的显示值上、与 Python 同序）：
//     ① 峰谷对比扩张（unsharp mask，`peakExpand=1.65`）：
//        `base = conv(h, {0.1,0.2,0.4,0.2,0.1}, 'same')`；
//        `h = clip(base + (h-base)·peakExpand, 0, 1)` —— 峰更高、谷更低，
//        扎堆的一簇高条被拉成一根根离散的尖塔，整段平均高度不受影响；
//     ② 细谱判峰掩模（`finePeakSpan=2` / `finePeakRatio=0.99` / 谷深 `finePeakValley=0.35`
//        （两端）、`finePeakValleyMid=0.75`（中段））：
//        只有**长窗细谱**局部最大（±2 带内最大、且 ≥0.99×该局部最大）的条保持全高，
//        其余乘**按位置渐变的谷深** `mid+(ends−mid)·|2u−1|^1.5` —— 判据全部来自真实频谱
//        （无随机、无固定图案），乘性作用（零仍是零）；
//   * 发布前对**输出高度**做一次 5 抽头横向（跨频段）平滑 `[0.10,0.20,0.40,0.20,0.10]`
//     → 相邻条顶端被磨成一条近似连续的连线（包络/骨架状态本身不平滑，不累积）；
//   * 融合模式：条形**仍然是频率谱**（每根条 = 一个真实对数频段），只是
//     kick/bass/人声/镲活跃时，用对数频率上的高斯权重把**它们各自的频段**乘性推高
//     （强调在渲染层、很轻的梳齿之前并入总增益，绝不直接改基础频谱）；
//   * 数据流：getFloatTimeDomainData → computeCustomSpectrum → 可视化管线；
//     为保性能每两帧计算一次（≈30fps），渲染仍 60fps；
//   * 音色计量：三频段（kick/bass 低 · 人声/旋律 中 · 镲片/空气 高）的索引
//     按 96 个对数频段 + 0.98 覆盖校准。
//
// 用法（浏览器）：
//   import { computeCustomSpectrum, SpectrumEngine } from './spectrum.mjs';
//   analyser.fftSize = 4096;
//   analyser.getFloatTimeDomainData(buf4096);
//   const r = computeCustomSpectrum(buf4096, { sampleRate: audioCtx.sampleRate });
//   r.heights   // Float32Array[96]，发布高度 0..1（已过顶端软膝，纯频率模式直接用）
//   r.skeleton  // Float32Array[96]，频率**骨架** 0..peakStretch(2.10)
//               //   —— 与 Python 的 comp_disp 同义（峰值拉伸后**不**夹到 1.0，
//               //   否则梯度会被提前削平）。渲染层加音色增益时必须用它：
//               //   增益 → 很轻的梳齿 → 顶端软膝（与 Python 同序）。
//   r.gauges   // { kick, bass, vocal, cymbal } 0..1，音色角色活跃度
//   r.info     // { bandFreqs, group: {low:[a,b], mid:[a,b], high:[a,b]} }
// ============================================================================

const TAU = Math.PI * 2;

/** 顶端连线平滑核（5 抽头横向平滑）；与 Python 的 `smooth_taps` 同值。 */
export const DEFAULT_SMOOTH_TAPS = [0.10, 0.20, 0.40, 0.20, 0.10];

/**
 * 顶端连线平滑（跨频段横向平滑）：`out[i] = Σ taps[k]·h[i + mid − k]`（越界按 0），
 * **与 Python 的 `np.convolve(h, smooth_taps, mode="same")` 逐元素一致**
 * （零填充边界 → 两端几条会被轻微衰减，与权威实现相同）。
 *
 * 这是"顶端连线近似连续"的最后一步：把相邻条顶端的锯齿磨成一条连续曲线。
 * 它**只作用于输出/发布高度**，绝不回灌包络或骨架状态（否则会一帧帧累积、反应变慢）。
 * Python 里它在增益与顶端软膝**之后**；本实现同样在两条发布路径的最后调用它
 * （引擎的纯频率路径 / 渲染层的增益路径），骨架本身保持未平滑。
 *
 * @param {Float32Array} h 就地改写的高度数组
 * @param {number[]} [taps] 平滑核（默认 [0.10,0.20,0.40,0.20,0.10]，自动归一）
 * @param {Float32Array} [scratch] 可复用的临时缓冲（长度需 ≥ h.length）
 * @returns {Float32Array} h
 */
export function smoothAcrossBands(h, taps = DEFAULT_SMOOTH_TAPS, scratch = null) {
  const B = h.length;
  const k = (taps && taps.length) ? taps : DEFAULT_SMOOTH_TAPS;
  let sum = 0;
  for (let i = 0; i < k.length; i++) sum += Number(k[i]) || 0;
  sum = Math.max(sum, 1e-6);
  const mid = (k.length - 1) >> 1;
  const tmp = (scratch && scratch.length >= B) ? scratch : new Float32Array(B);
  for (let i = 0; i < B; i++) {
    let acc = 0;
    for (let j = 0; j < k.length; j++) {
      const src = i + mid - j;                       // 越界按 0（零填充）
      if (src >= 0 && src < B) acc += ((Number(k[j]) || 0) / sum) * h[src];
    }
    tmp[i] = acc;
  }
  for (let i = 0; i < B; i++) h[i] = tmp[i];
  return h;
}

/**
 * 顶端软膝映射（0..1 收口）：**与 Python `SpectrumAnalyzer.analyze()` 末段逐字一致**。
 *
 * ```
 * if (x > top_knee) x = top_knee + (1 - top_knee) * clamp(
 *     log1p((x - top_knee)/top_width) / log1p((top_max - top_knee)/top_width), 0, 1)
 * then clamp(x, 0, 1)
 * ```
 * * 膝**以下线性**：弱带之间的落差、峰谷深度原样保留 → **梯度不会被压扁**；
 * * 膝**以上对数肩**：严格单调（两个都在膝上的强带依然有可见高低差），
 *   到 `top_max` 才真正贴到 1.0 → **不存在平顶天花板**。
 *
 * 取代了旧的 tanh 软饱和（`knee + (1-knee)·tanh(...)`）。
 * 这是"顶端连线近似连续 + 高度仍有梯度"里负责"收口而不削平"的那一步：
 * 只能作用在**增益叠加之后**（与 Python 同序），所以渲染层 `composeHeights`
 * 也调用同一个函数（本文件是唯一实现，避免两份公式走偏）。
 *
 * @param {number} x 输入高度（可 >1）
 * @param {{topKnee?:number, topWidth?:number, topMax?:number}} [opts]
 * @returns {number} 0..1
 */
export function applyTopKnee(x, opts = null) {
  const t = opts && Number.isFinite(opts.topKnee) ? opts.topKnee : 0.75;
  const w = Math.max(1e-6, opts && Number.isFinite(opts.topWidth) ? opts.topWidth : 0.60);
  const tmax = opts && Number.isFinite(opts.topMax) ? opts.topMax : 12.0;
  let v = x;
  if (v > t) {
    const den = Math.max(Math.log1p((tmax - t) / w), 1e-6);
    const num = Math.log1p(Math.max(v - t, 0) / w);
    v = t + (1 - t) * Math.min(1, Math.max(0, num / den));
  }
  return v > 1 ? 1 : (v < 0 ? 0 : v);
}

/** 把 f 映射到对数频带下标（20Hz..fMax，80 带），用于把音色频率阈值换算成带下标。 */
export class SpectrumEngine {
  /**
   * @param {object} [opts]
   * @param {number} [opts.sampleRate=44100]    音频采样率（用 audioCtx.sampleRate）
   * @param {number} [opts.bands=96]            对数频段数（更细更多）
   * @param {number} [opts.fftSize=4096]        分析窗长（与 analyser.fftSize 一致）
   * @param {number} [opts.fMin=20]             最低频（Hz），天然跳过 DC(k≥1)
   * @param {number} [opts.fMaxRatio=0.45]      最高频 = fMaxRatio × Nyquist
   * @param {number} [opts.coverage=0.98]       音色分组频段覆盖比例（相对总跨度）
   * @param {number} [opts.lowCompDb=0]         低频补偿 dB（0..14，滑块动态调）
   * @param {number} [opts.lowCompHz=150]       低频补偿中心频率
   * @param {number} [opts.kickHz=210]          音色“低”区上界（kick/bass 侦测带）
   * @param {number} [opts.vocalHz=4200]        音色“中”区上界（人声/旋律）
   * @param {number} [opts.kNorm=200]           log10(1+K·rel)/log10(1+K) 的 K（越大动态范围越压缩、整体越亮）
   * @param {number} [opts.contrast=2.60]       显示级对比度（越大越极端：弱带压低、强带保持）
   * @param {number} [opts.contrastFloor=0.05]  削底噪阈值
   * @param {number} [opts.peakStretch=2.10]    峰值拉伸：把强弱带的落差拉开（配合顶端软膝）
   * @param {number} [opts.topKnee=0.75]        顶端软膝起点（以下线性、以上对数肩）；供渲染层参考
   * @param {number} [opts.topWidth=0.60]       对数肩宽度（越大越平缓）
   * @param {number} [opts.topMax=12.0]         映射到 1.0 的输入值（>它才贴顶）
   * @param {number} [opts.binOffset=0.25]      邻带去相关取样偏移（±bin）：越小 → 邻条越接近
   * @param {number} [opts.tilt=0.85]           频谱倾斜：左端 ×(1+tilt) → 右端 ×(1−tilt)，0=关闭
   * @param {number} [opts.tiltLo=0.15]         倾斜下限（右端最多压到 ×0.15）
   * @param {number} [opts.tiltHi=1.90]         倾斜上限（左端最多抬到 ×1.90）
   * @param {number} [opts.detailSpan=11]       细节形变的邻域窗口（条数）
   * @param {number} [opts.detailPower=0.85]    细节形变强度（0=关闭）
   * @param {number} [opts.detailLo=0.58]       细节形变下限（谷最多压到 58%）
   * @param {number} [opts.detailHi=1.58]       细节形变上限（峰最多抬到 158%）
   * @param {boolean} [opts.detailAfter=false]  形变放在对比度之后（true）还是之前（false）
   * @param {number[]} [opts.smoothTaps]        顶端连线平滑核（默认 [0.10,0.20,0.40,0.20,0.10]）
   * @param {number} [opts.valleyKeep=0.85]     非局部峰值的保留比例（越大 → 顶端越连续）
   * @param {number} [opts.peakRadius=1]        局部极大值的邻域半径（±几个频段比高低）
   * @param {number} [opts.peakKeepRatio=0.92]  高于局部最大值的这个比例才算"峰"
   * @param {boolean} [opts.fusion=true]        融合模式：频率谱 + 音色强调（false 可 A/B 对照）
   * @param {number} [opts.fusionGain=3.80]     音色强调强度（活跃音色把自音频段推高多少）
   * @param {number} [opts.shortSize=1024]      短窗瞬态检测长度（96 点移动平均 ≈460Hz 低通）
   */
  constructor(opts = {}) {
    this.sampleRate = opts.sampleRate || 44100;
    this.bands = opts.bands || 96;                  // 更细更多：96 条对数频段
    this.N = opts.fftSize || 4096;                  // 与参考一致：更大窗（低频分辨率更好）
    this.fMin = opts.fMin || 20;
    this.nyquist = this.sampleRate / 2;
    this.fMaxRatio = opts.fMaxRatio == null ? 0.45 : opts.fMaxRatio;
    this.fMax = this.fMaxRatio * this.nyquist;          // 0.45×Nyquist
    this.coverage = opts.coverage == null ? 0.98 : opts.coverage;
    this.lowCompHz = opts.lowCompHz || 150;
    this._lowCompDb = 0;
    this.kickHz = opts.kickHz || 210;
    this.vocalHz = opts.vocalHz || 4200;
    this.contrast = opts.contrast == null ? 2.60 : opts.contrast;   // 区分度（越大越极端）
    this.contrastFloor = opts.contrastFloor == null ? 0.05 : opts.contrastFloor;
    this.peakStretch = opts.peakStretch == null ? 2.10 : opts.peakStretch;  // 峰值拉伸
    this.kNorm = opts.kNorm == null ? 200 : opts.kNorm;             // log10(1+K·rel)/log10(1+K) 的 K
    // 包络系数（参考播放器）：attack 0.70 / release 0.82 / 峰值顶盖回落 0.97
    this.attack = opts.attack == null ? 0.80 : Number(opts.attack);
    this.release = opts.release == null ? 0.82 : Number(opts.release);
    this.peakFall = opts.peakFall == null ? 0.930 : Number(opts.peakFall);
    /* ===== 参考播放器（D:\harness work）可视化方法的参数 =====
     * 权威现在**整段替换**了旧的显示级：算完 comp 之后直接 `_run_reference(comp)`，
     * 旧的 AGC/对比度/离散化/融合强调/梳齿/软膝/谷深/冲击块/输出归一全部不再执行。 */
    this.refTiltStrength = opts.tiltStrength == null ? 61.0 : Number(opts.tiltStrength);
    this.refTiltBase = opts.tiltBase == null ? 5.0 : Number(opts.tiltBase);
    this.bbBassPos = opts.bbBassPos == null ? 0.12 : Number(opts.bbBassPos);
    this.bbBassSigma = opts.bbBassSigma == null ? 0.030 : Number(opts.bbBassSigma);
    this.bbBassGain = opts.bbBassGain == null ? 1.8 : Number(opts.bbBassGain);
    this.bbValleyPos = opts.bbValleyPos == null ? 0.33 : Number(opts.bbValleyPos);
    this.bbValleySigma = opts.bbValleySigma == null ? 0.09 : Number(opts.bbValleySigma);
    this.bbValleyDepth = opts.bbValleyDepth == null ? 0.45 : Number(opts.bbValleyDepth);
    this.bbLo = opts.bbLo == null ? 0.58 : Number(opts.bbLo);
    this.bbHi = opts.bbHi == null ? 2.9 : Number(opts.bbHi);
    this.samplePow = opts.samplePow == null ? 0.8 : Number(opts.samplePow);
    this.sampleUsable = Math.min(1, Math.max(0.1,
      opts.sampleUsable == null ? 0.98 : Number(opts.sampleUsable)));
    this.curvePow = opts.curvePow == null ? 2.1 : Number(opts.curvePow);
    this.kickGain = opts.kickGain == null ? 2.4 : Number(opts.kickGain);
    this.kickSpan = Math.max(0.01, opts.kickSpan == null ? 0.05 : Number(opts.kickSpan));
    this.kickLowFrom = opts.kickLowFrom == null ? 2 : Math.floor(Number(opts.kickLowFrom));
    this.kickLowTo = opts.kickLowTo == null ? 8 : Math.floor(Number(opts.kickLowTo));
    this.kickLowPrevRate = opts.kickLowPrevRate == null ? 0.25 : Number(opts.kickLowPrevRate);
    this.kickTenvRate = opts.kickTenvRate == null ? 0.08 : Number(opts.kickTenvRate);
    this.jitterAmp = opts.jitterAmp == null ? 0.45 : Number(opts.jitterAmp);
    this.jitterGr = opts.jitterGr == null ? 0.618033988749895 : Number(opts.jitterGr);
    this.jitterStep = opts.jitterStep == null ? 0.03 : Number(opts.jitterStep);
    this.quantLevels = Math.max(2, Math.floor(opts.quantLevels == null ? 14 : Number(opts.quantLevels)));
    this.barFloor = opts.barFloor == null ? 0.02 : Number(opts.barFloor);
    this._refLowPrev = 0;            // 参考播放器：上一帧低频平均能量
    this._refTenv = 0;               // 参考播放器：低频慢包络
    this._refPhase = 0;              // 参考播放器：确定性抖动相位（每帧 +step，mod 2π）
    this._bandBoost = null;          // 参考播放器：bandBoost（低频尖峰 + 中频谷）
    this._sampleA = null;            // 参考播放器：条 i 的采样区间 [a, b)
    this._sampleB = null;
    this._barU = null;               // 参考播放器：i/bars
    this._smoothState = null;        // 参考播放器：包络状态
    this._peakState = null;          // 参考播放器：峰值顶盖状态
    // 邻带去相关取样偏移（±bin）：越小 → 邻条读到越接近的谱位置 → 顶端连线越连续
    this.binOffset = opts.binOffset == null ? 0.25 : Number(opts.binOffset);
    // 频谱倾斜（显示用）：左端 ×(1+tilt) → 右端 ×(1−tilt) 的线性斜坡，让整条频谱
    // "向低端（左端）靠"；tilt=0 关闭。乘性、有上下限，且加在增益与顶端软膝**之前**：
    // 每根条的起伏原样保留、不会削出饱和平台；音色计量走未倾斜的 rel（测的仍是真实音频）。
    this.tilt = opts.tilt == null ? 0.35 : Number(opts.tilt);
    this.tiltLo = opts.tiltLo == null ? 0.15 : Number(opts.tiltLo);
    this.tiltHi = opts.tiltHi == null ? 1.90 : Number(opts.tiltHi);
    // "向两边靠"的 U 形权重（乘性、有上下限）：|2u−1|^endsP 在两端为 1、中间为 0 →
    // 两端 ×endsGain、中间 ×midCut。与倾斜一起加在增益与顶端软膝**之前**：
    // 低频与高频两头抬起来、中间让开，整条频谱"向两边靠"。
    this.endsGain = opts.endsGain == null ? 1.80 : Number(opts.endsGain);
    this.midCut = opts.midCut == null ? 0.25 : Number(opts.midCut);
    this.endsP = opts.endsP == null ? 1.50 : Number(opts.endsP);
    // 逐带慢包络（per-band AGC）：让两端"有内容就能立起来"。
    // 全曲峰值归一保证响度无关，但音乐能量天然偏低频 → 高频段常年只有全曲峰值的
    // 百分之几，频谱两端（尤其右端）永远立不起来。这里给每带记一条**自己的慢包络**，
    // 显示时用 min(全曲参考, max(该带包络·rel, 全曲参考·floor)) 归一，再按 bandAgc 混合，
    // 且只在 bandAgcFrom 以上的频段生效（低频/中频保留全曲归一 → 鼓点动态不被抹平）。
    this.bandAgc = opts.bandAgc == null ? 1.00 : Number(opts.bandAgc);
    this.bandAgcRel = opts.bandAgcRel == null ? 1.15 : Number(opts.bandAgcRel);
    this.bandAgcFloor = opts.bandAgcFloor == null ? 0.05 : Number(opts.bandAgcFloor);
    this.bandAgcFrom = opts.bandAgcFrom == null ? 0.55 : Number(opts.bandAgcFrom);
    // 细节形变（拆"大片"）：用长窗细谱的相对起伏做有界乘性形变（见 _detailShape）
    this.detailSpan = opts.detailSpan == null ? 11 : Number(opts.detailSpan);
    this.detailPower = opts.detailPower == null ? 0.85 : Number(opts.detailPower);
    this.detailLo = opts.detailLo == null ? 0.58 : Number(opts.detailLo);
    this.detailHi = opts.detailHi == null ? 1.58 : Number(opts.detailHi);
    this.detailAfter = opts.detailAfter === true;
    // 高峰离散化：只让"真实细谱的局部峰"保持全高，其余乘"谷深档"。
    // 倾斜/对比度把一整段抬起来之后，段内"高峰"容易连成一大簇（显示值上分不出高低，
    // 但长窗细谱上仍有真实凹凸）→ 用细谱判峰，把高峰拆成一根根离散的尖塔。
    this.finePeakSpan = opts.finePeakSpan == null ? 4 : Number(opts.finePeakSpan);
    this.finePeakRatio = opts.finePeakRatio == null ? 0.99 : Number(opts.finePeakRatio);
    // 非峰条的保留比例**按位置渐变**：两端最深（finePeakValley），中段放松
    // （finePeakValleyMid）—— 两端仍能立出尖塔，中段不会被压得太矮太平均。
    this.finePeakValley = opts.finePeakValley == null ? 0.45 : Number(opts.finePeakValley);
    this.finePeakValleyMid = opts.finePeakValleyMid == null
      ? 0.60 : Number(opts.finePeakValleyMid);
    // 峰条额外抬升：判为峰的条在**顶端软膝之前**先乘一次 peakBoost（>1 → 更高更尖；
    // 膝是可压缩的，放在膝前抬才不会被饱和吃掉 —— 放在膝后抬实测帧峰只能到 0.6）。
    // 非峰条则在**软膝与对比扩张之后**乘 finePeakValley → 塔又高又尖又陡、彼此孤立。
    this.peakBoost = opts.peakBoost == null ? 1.40 : Number(opts.peakBoost);
    // 显式保顶：细谱判峰看的是**细谱形状**，显示值最高的条未必入选。这里用"**第 k 大的值**"
    // 当阈值把显示值最大的若干根强制算作峰 —— **并列时全部保顶**，规则与实现无关、
    // 跨端可逐位对齐（np.argpartition/argsort 在并列时的取舍是实现相关的）。
    this.peakKeepTop = opts.peakKeepTop == null ? 1 : Number(opts.peakKeepTop);
    // （输出峰值归一 displayPeak/displayPeakMax 已被权威撤掉：它会造成帧间泵动、
    //   破坏"峰值顶盖 ≥ 柱高"，还会削出 3 根贴顶 —— 发布值就是包络 + 5 抽头平滑后 clip。）
    // 峰谷对比扩张（unsharp mask，作用在**顶端软膝之后**的显示值上）：
    //   base = conv(shaped, {0.1,0.2,0.4,0.2,0.1}, 'same')
    //   shaped = clip(base + (shaped-base)·peakExpand, 0, 1)
    // 峰更高、谷更低 → 扎堆的一簇高条被拉成一根根离散的尖塔；1 = 关闭。
    this.peakExpand = opts.peakExpand == null ? 1.50 : Number(opts.peakExpand);
    // 顶端软膝（与 Python 的 top_knee/top_width/top_max 同值）。
    // 引擎把它用在**纯频率发布路径**（engine.heights）上；渲染层 composeHeights
    // 在音色增益叠加之后再用同一个函数做一次收口 —— 两条路径都与 Python 的
    // `shaped → 顶端软膝` 同序（增益在前、软膝在后）。
    this.topKnee = opts.topKnee == null ? 0.75 : Number(opts.topKnee);
    this.topWidth = opts.topWidth == null ? 0.60 : Number(opts.topWidth);
    this.topMax = opts.topMax == null ? 12.0 : Number(opts.topMax);
    // 输出峰值归一（权威重新加回、并再次调整）：把发布高度的最高条稳定顶到约
    // displayPeak（**0.92** —— 低频冲击块要能顶到"极其高耸"）。缩放系数用 **0.06/帧的慢包络**
    // 逼近目标 —— 帧峰一掉就瞬间放大会造成帧间泵动，慢包络把缩放锁在"最近的响亮水平"上；
    // displayPeakMax 是放大上限（防止把静音/极弱帧放大）。displayPeak = 0 → 关闭。
    this.displayPeak = opts.displayPeak == null ? 0.92 : Number(opts.displayPeak);
    this.displayPeakMax = opts.displayPeakMax == null ? 2.00 : Number(opts.displayPeakMax);
    this._scaleSm = null;                   // 慢速缩放系数（首帧直接到位，reset() 清空）
    // 低频冲击块（kick/bass 活跃时触发）：最左 lowSurgeBars 根条整块 ×(1+gain·act) 顶到极高，
    // 其余频段 ×(1−dim·act) 压暗（聚焦低频）。act = max(kick,bass)^pow，且只在 >0.02 时生效
    // → 静音不作用、零能量频段仍是零。乘性、由音频驱动、无随机。
    this.lowSurgeBars = opts.lowSurgeBars == null ? 10 : Math.max(2, Math.floor(Number(opts.lowSurgeBars)));
    this.lowSurgeGain = opts.lowSurgeGain == null ? 12.0 : Number(opts.lowSurgeGain);
    this.lowSurgeDim = Math.min(0.9, Math.max(0,
      opts.lowSurgeDim == null ? 0.62 : Number(opts.lowSurgeDim)));
    this.lowSurgePow = opts.lowSurgePow == null ? 1.1 : Number(opts.lowSurgePow);
    this.lowSurgeEdge = opts.lowSurgeEdge == null ? 2 : Math.max(0, Math.floor(Number(opts.lowSurgeEdge)));
    // 顶端连线平滑核（5 抽头横向平滑，只作用于**输出高度**，不回灌状态）
    const taps = Array.isArray(opts.smoothTaps) ? opts.smoothTaps.slice()
      : DEFAULT_SMOOTH_TAPS.slice();
    this.smoothTaps = taps;
    this._smoothScratch = new Float32Array(this.bands);
    // 轻微局部极大值抑制：只削掉真正的尖刺，其余频段几乎原样保留 → 顶端连续
    this.valleyKeep = opts.valleyKeep == null ? 0.85 : opts.valleyKeep;
    this.peakRadius = opts.peakRadius == null ? 1 : opts.peakRadius;
    this.peakKeepRatio = opts.peakKeepRatio == null ? 0.92 : opts.peakKeepRatio;
    // 融合模式：条形仍是频率谱，只是 kick/bass/人声/镲活跃时各自频段被乘性推高
    this.fusion = opts.fusion !== false;                            // 默认开；false 可做 A/B 对照
    // 音色强调强度：四条音色带收窄之后（上一版 σ = 0.60/0.80/1.15/0.80）同样的增益
    // 只能抬起更小的一块区域，所以从 2.40 提到 3.80 补回来（实测群组抬升 ×1.20~1.31）。
    this.fusionGain = opts.fusionGain == null ? 3.80 : Number(opts.fusionGain);
    // 短窗瞬态检测长度（Python 的 short_size 默认 1024，配 96 点移动平均 ≈460Hz 低通）
    this.shortSize = Math.max(128, Math.min(this.N, opts.shortSize || 1024));

    // ---- 对数频段：与参考一致 frac = i/(bands-1)，freq = fMin·(fMax/fMin)^frac ----
    // bandBins（取整 bin）只作信息/调试用途；真正的取样位置是**分数 bin**（见下），
    // 不再做单调化钳制 —— 那会让低频多带叠在同一 bin，显示成"一堵平墙"。
    const n = this.N;
    this.bandFreqs = new Float64Array(this.bands);
    this.bandBins = new Int32Array(this.bands);     // 整数 bin k（信息/调试用）
    this._tier = new Int32Array(this.bands);        // 每个频段使用的窗长
    this._tierBin = new Int32Array(this.bands);     // 分数位置的整数部分 i0（调试/交叉验证）
    this._tierFrac = new Float64Array(this.bands);  // 分数部分 frac = pos - i0（线性插值）
    this._coefA = new Float32Array(this.bands);     // 2cos(2π·i0/N)，内层无三角函数
    this._coefB = new Float32Array(this.bands);     // 2cos(2π·(i0+1)/N)
    // 长窗**细谱**取样系数（峰值归一 + 细节形变用）：每带在自己的整数 bin
    // k = bandBins[i] 上、用 fftSize 长窗跑一次 Goertzel → 等价于 Python 的
    // mag = |rfft(x·win_fft_size)|[bins]。系数在下面的频段循环里填（bandBins 要先算好）。
    // 1024 短窗的 bin 宽 ≈43Hz，低频 ~40 根条可能只落在 9 个 bin 上（这就是"一片等高
    // 平台"的来源）；长窗的 bin 宽 ≈10.8Hz，能把平台拆成有起伏的坡。
    this._coefFine = new Float32Array(this.bands);
    // 频谱倾斜斜坡（显示用）：u = i/(bands-1)，ramp = clip(1 + tilt·(1−2u), lo, hi)
    // tilt=0.35 → 左端 ×1.35、右端 ×0.65（整条频谱偏向低端）。
    this._tilt = new Float32Array(this.bands);
    // "向左端靠 + 非均匀分布"的增益斜坡：lean = clip(1−u,0,1)^endsP（左端 1 → 右端 0），
    // 再乘确定性非均匀包络 tex = 0.60 + 0.22·sin(k·0.63) + 0.12·sin(k·1.51+1.3)
    // + 0.06·sin(k·0.37+0.7)（clip 到 [0.40,1.60]）：
    //   _ends = clip(midCut + (endsGain − midCut)·lean·tex, 0, endsGain·1.1)
    // → 左端最高、最后一条恰好等于 midCut；高耸条聚向左端且间距不匀。
    this._ends = new Float32Array(this.bands);
    // 非峰条的"谷深"按位置渐变：两端最深（finePeakValley），中段放松
    // （finePeakValleyMid）—— 与 Python 的 `_valley_profile` 同一个公式：
    //   shape = |2u−1|^1.5（两端 1、中间 0）
    //   _valleyProfile = mid + (ends − mid)·shape  → 两端 ×0.45、中间 ×0.60
    this._valleyProfile = new Float32Array(this.bands);
    // 低频冲击块权重：最左 nb = min(lowSurgeBars, bands) 根 = 1.0，随后 lowSurgeEdge 根
    // 边缘平滑衰减（下标 j = nb+e−1、值 = max(0, 1 − e/(edge+1))），其余 0。
    // 与 Python 的 `_low_block` 逐条相同（96 带：0..9 = 1.0、10 = 2/3、11 = 1/3、其余 0）。
    this._lowBlock = new Float32Array(this.bands);
    {
      const nb = Math.min(this.lowSurgeBars, this.bands);
      for (let i = 0; i < nb; i++) this._lowBlock[i] = 1.0;
      if (this.lowSurgeEdge > 0 && nb < this.bands) {
        for (let e = 1; e <= this.lowSurgeEdge; e++) {
          const j = nb + e - 1;
          if (j < this.bands) this._lowBlock[j] = Math.max(0, 1 - e / (this.lowSurgeEdge + 1));
        }
      }
    }
    // 逐带 AGC 的生效权重：bandAgcFrom 以下为 0（保留全曲归一 → 时间动态完整），
    // 以上平滑升到 1
    this._agcW = new Float32Array(this.bands);
    const hasEnds = Math.abs(this.endsGain - 1) > 1e-9 || Math.abs(this.midCut - 1) > 1e-9;
    const agcF = Math.min(Math.max(this.bandAgcFrom, 0), 0.98);
    const agcDen = Math.max(1e-6, 1 - agcF);
    const vMid = this.finePeakValleyMid, vEnd = this.finePeakValley;
    for (let i = 0; i < this.bands; i++) {
      const u = this.bands > 1 ? i / (this.bands - 1) : 0;
      this._tilt[i] = Math.abs(this.tilt) > 1e-9
        ? Math.max(this.tiltLo, Math.min(this.tiltHi, 1 + this.tilt * (1 - 2 * u)))
        : 1;
      // "向左端靠 + 非均匀分布"：lean = clip(1−u,0,1)^endsP（左端 1 → 右端 0），
      // 再乘确定性非均匀包络 tex（多正弦叠加，只用低频 → 簇尺度 ≈4~17 根条，
      // 不在相邻条之间造锯齿）→ 高耸条聚向左端、高低错落、间距不匀。
      // 最后一条（u=1）恰好等于 midCut；上界 endsGain·1.1。与 Python 同为 float64 计算。
      const lean = Math.pow(Math.min(Math.max(1 - u, 0), 1), this.endsP);
      const tex = Math.min(Math.max(0.60
        + 0.22 * Math.sin(i * 0.63)
        + 0.12 * Math.sin(i * 1.51 + 1.3)
        + 0.06 * Math.sin(i * 0.37 + 0.7), 0.40), 1.60);
      this._ends[i] = hasEnds
        ? Math.min(Math.max(this.midCut + (this.endsGain - this.midCut) * lean * tex, 0),
                   this.endsGain * 1.1)
        : 1;
      this._valleyProfile[i] = vMid
        + (vEnd - vMid) * Math.pow(Math.abs(2 * u - 1), 1.5);
      this._agcW[i] = Math.min(1, Math.max(0, (u - agcF) / agcDen));
    }
    /* ---- 参考播放器：bandBoost + 频段→条采样映射 ----
     * f = i/(bands−1)
     * bass   = exp(−((f−bbBassPos)/bbBassSigma)^2)·bbBassGain
     * valley = −exp(−((f−bbValleyPos)/bbValleySigma)^2)·bbValleyDepth
     * bandBoost = clip(1 + bass + valley, bbLo, bbHi)
     * usable = max(1, int(bands·sampleUsable))
     * a[i] = clip(floor(pow(i/bands, samplePow)·usable), 0, usable−1)
     * b[i] = clip(floor(pow((i+1)/bands, samplePow)·usable), a[i]+1, usable) */
    this._bandBoost = new Float32Array(this.bands);
    this._sampleA = new Int32Array(this.bands);
    this._sampleB = new Int32Array(this.bands);
    this._barU = new Float64Array(this.bands);
    {
      const denom = Math.max(1, this.bands - 1);
      for (let i = 0; i < this.bands; i++) {
        const f = i / denom;
        const db = (f - this.bbBassPos) / this.bbBassSigma;
        const dv = (f - this.bbValleyPos) / this.bbValleySigma;
        const bass = Math.exp(-(db * db)) * this.bbBassGain;
        const valley = -Math.exp(-(dv * dv)) * this.bbValleyDepth;
        this._bandBoost[i] = Math.min(this.bbHi,
          Math.max(this.bbLo, 1 + bass + valley));
      }
      const usable = Math.max(1, Math.floor(this.bands * this.sampleUsable));
      const nb = this.bands;
      for (let i = 0; i < this.bands; i++) {
        let a = Math.floor(Math.pow(i / nb, this.samplePow) * usable);
        let b = Math.floor(Math.pow((i + 1) / nb, this.samplePow) * usable);
        a = Math.min(Math.max(a, 0), usable - 1);
        b = Math.max(a + 1, Math.min(b, usable));
        this._sampleA[i] = a;
        this._sampleB[i] = b;
        this._barU[i] = i / nb;
      }
    }
    const Lratio = Math.log(this.fMax / this.fMin);
    let prevK = 1;
    for (let i = 0; i < this.bands; i++) {
      const frac = i / (this.bands - 1);
      const freq = this.fMin * Math.exp(Lratio * frac);
      let k = Math.round(freq * n / this.sampleRate);
      if (k < 1) k = 1;                              // 跳过 DC
      if (k > n / 2 - 1) k = n / 2 - 1;
      if (k <= prevK) k = prevK + 1;                 // 单调化：不重复不空洞
      if (k > n / 2 - 1) k = n / 2 - 1;
      prevK = k;
      this.bandFreqs[i] = freq;
      this.bandBins[i] = k;
      // 分层窗长：≤5.5kHz 用 1024（≈23ms，时间分辨率高，鼓点分明）；
      // ≤11kHz 用 2048；更高用 fftSize（频率细节更好）。
      // 注意：每层要按**自己的窗长**重新换算 bin 位置，否则测到的不是同一个频率。
      // 低端很多频段的间隔比 bin 宽度还窄，若直接取整会有多带落在同一 bin →
      // 显示成"一堵平墙"。所以改用**分数 bin 位置线性插值**：每带的取样位置都不同，
      // 值也就逐带不同（平顶消失），频率映射仍忠于原音频（不做任何拉伸）。
      const tier = freq <= 5500 ? 1024 : (freq <= 11000 ? 2048 : n);
      // 去相关：相邻频段在自身宽度内轮换取子 bin（±binOffset = ±0.25 bin）。
      // 偏移很小 → 邻条读到接近（但不完全相同）的谱位置 → 顶端连线近似连续，
      // 又不会因为"所有带都取同一个 bin"而出现一刀平的平墙。
      let pos = freq * tier / this.sampleRate + (((i * 5) % 3) - 1) * this.binOffset;
      pos = Math.max(1.0, Math.min(pos, tier / 2 - 2));
      let i0 = Math.floor(pos);
      i0 = Math.max(1, Math.min(i0, (tier >> 1) - 2));
      const fr = Math.max(0, Math.min(1, pos - i0));
      this._tier[i] = tier;
      this._tierBin[i] = i0;
      this._tierFrac[i] = fr;
      this._coefA[i] = 2 * Math.cos(TAU * i0 / tier);
      this._coefB[i] = 2 * Math.cos(TAU * (i0 + 1) / tier);
      // 长窗细谱系数：本带在 fftSize 谱上的整数 bin k = bandBins[i]
      const kf = Math.max(1, Math.min(k, (n >> 1) - 1));
      this._coefFine[i] = 2 * Math.cos(TAU * kf / n);
    }

    // ---- 音色分组权重：对数频率上的高斯（平滑无台阶，与 Python _gw 一致） ----
    // 融合模式里 kick/bass/人声/镲活跃时，用这些权重把**它们各自的频段**推高。
    const gw = (center, sigma) => {
      const w = new Float32Array(this.bands);
      for (let i = 0; i < this.bands; i++) {
        const oct = Math.log2(Math.max(this.bandFreqs[i], 1e-6) / center);
        w[i] = Math.exp(-0.5 * (oct / sigma) ** 2);
      }
      return w;
    };
    this.fusionWeights = {
      kick: gw(50.0, 0.45),      // 鼓：低频冲击 ~50Hz（带很窄：活跃时只有它这一段窜起来）
      bass: gw(80.0, 0.60),      // 贝斯：低频铺底
      vocal: gw(1400.0, 0.75),   // 人声/旋律：中频（≈780Hz~2.5kHz 为核心）
      cymbal: gw(8000.0, 0.55),  // 镲片/空气：高频
    };

    // ---- Hann 窗（分层） ----
    this._win = new Float32Array(this.N);
    for (let i2 = 0; i2 < this.N; i2++) {
      this._win[i2] = 0.5 * (1 - Math.cos(TAU * i2 / (this.N - 1)));
    }
    // ---- 帧缓冲 ----
    // `_raw`   ：未加窗的原始帧（push 写入；下游按需加窗，绝不预先加窗）
    // `_xbuf`  ：去直流后的帧（= _raw − mean），每帧算一次，两路取样共用
    this._raw = new Float32Array(this.N);
    this._xbuf = new Float32Array(this.N);
    this._tierWins = {};
    for (const sz of [1024, 2048, this.N]) {
      const w = new Float32Array(sz);
      for (let i2 = 0; i2 < sz; i2++) w[i2] = 0.5 * (1 - Math.cos(TAU * i2 / (sz - 1)));
      this._tierWins[sz] = w;
    }

    // ---- 音色三频段下标（频率阈值 + 0.98 覆盖校准） ----
    const iLowEnd = this._lastIndexAtOrBelow(this.kickHz);
    const iMidEnd = this._lastIndexAtOrBelow(this.vocalHz);
    const covEnd = Math.floor((this.bands - 1) * this.coverage);
    this.group = {
      low: [0, Math.max(0, iLowEnd)],
      mid: [Math.min(iLowEnd + 1, this.bands - 1), Math.max(iLowEnd + 1, Math.min(iMidEnd, covEnd))],
      high: [Math.max(iMidEnd + 1, 1), Math.max(Math.min(covEnd, this.bands - 1), this.bands - 1)],
    };

    // ---- 状态：峰值跟踪 / 音色包络 / 抖动种子 ----
    this._peak = 0;
    this.heights = new Float32Array(this.bands);
    // 频率**骨架**（= Python 的 comp_disp：峰值拉伸后**不**夹到 1.0，0..peakStretch）。
    // 渲染层的音色增益必须乘在骨架**之后**、顶端软膝**之前**（与 Python 同序），
    // 所以骨架要单独留一份给 composeHeights；`heights` 本身是过了软膝的发布高度（0..1）。
    this.skeleton = new Float32Array(this.bands);
    this.rawMag = new Float64Array(this.bands);      // 归一前幅度（低频补偿后）
    this._relAll = new Float32Array(this.bands);     // 每带 rel = min(mag/peakEnv,1)（融合判据用）
    // 融合模式的四路音色包络（0..1）与强调增益数组（1.0 = 不强调）
    this.emphasis = new Float32Array(this.bands).fill(1);
    this.gauges = { kick: 0, bass: 0, vocal: 0, cymbal: 0, emphasis: this.emphasis,
                    fusion: this.fusion, lowBlock: this._lowBlock };
    this._kick = 0;
    this._bass = 0;
    this._vocal = 0;
    this._cymbal = 0;
    this._highEnv = 0;      // 高区慢包络（镲片闪烁检测的基线）
    this._lowMa = 0;        // 短窗低频能量基线（kick 突增判据）
    this._lowJump = 0;      // 短窗低频能量相对基线的突增比
    this.lastTimbre = { framePk: 0, lowPk: 0, midPk: 0, highPk: 0,
                        lowDom: 0, midDom: 0, highDom: 0, kickHit: 0 };
    this._frame = 0;
    this._lastDataLen = 0;

    // 低频补偿权重曲线（随滑块变化，见 setLowComp）
    this._lowBoost = new Float32Array(this.bands);
    this.setLowComp(opts.lowCompDb || 0);
    this._recomputeLowBoost();
  }

  /** 最后一个中心频率 ≤ f 的频段下标（音色三区段边界用）。 */
  _lastIndexAtOrBelow(f) {
    let idx = 0;
    for (let i = 0; i < this.bands; i++) {
      if (this.bandFreqs[i] <= f) idx = i; else break;
    }
    return idx;
  }

  /**
   * 清空全部的**历史递推状态**（换曲/换设备时调用；参数与预计算表不动）——
   * 与 Python 的 `SpectrumAnalyzer.reset()` 一一对应：
   *   * 峰值包络 `_peakEnv2`、帧均值包络 `_meanEnv`（去掉整曲响度记忆）；
   *   * **逐带慢包络 `_bandEnv`**（per-band AGC：**每首曲子重新建立**，
   *     否则上一首的高频历史会把下一首的高频段抬起来 —— 它本来就是"懒创建"的）；
   *   * 音色包络与四路计量、滑动峰、低频瞬态基线、输出数组。
   * `_bandEnv` 置 null 之后，下一帧会按 `relAll` 重新初始化（与 Python 的
   * `if not hasattr(self, "_band_env"): self._band_env = rel_all.copy()` 同义）。
   */
  reset() {
    const B = this.bands;
    this._peakEnv2 = 0;
    this._meanEnv = undefined;
    this._peak = 0;
    this._bandEnv = null;
    this._scaleSm = undefined;
    this._peakMask = null;
    this.gauges.peakMask = null;
    this._kick = 0; this._bass = 0; this._vocal = 0; this._cymbal = 0;
    this._highEnv = 0; this._lowMa = 0; this._lowJump = 0;
    this._frame = 0;
    this._lastDataLen = 0;
    this.heights.fill(0);
    this.skeleton.fill(0);
    this.rawMag.fill(0);
    this._relAll.fill(0);
    this._comp && this._comp.fill(0);
    this.emphasis.fill(1);
    this.gauges.kick = 0; this.gauges.bass = 0; this.gauges.vocal = 0; this.gauges.cymbal = 0;
    this.gauges.peakMask = null;
    this._peakMask = null;
    this.lastTimbre = { framePk: 0, lowPk: 0, midPk: 0, highPk: 0,
                        lowDom: 0, midDom: 0, highDom: 0, kickHit: 0 };
    this._raw.fill(0);
    this._xbuf.fill(0);
    return this;
  }

  /** 低频补偿（dB，0..~14），补偿 ≤ lowCompHz 附近频段，向高频平滑淡出。 */
  setLowComp(db) {
    this._lowCompDb = Math.max(0, Math.min(24, Number(db) || 0));
    this._recomputeLowBoost();
  }
  get lowCompDb() { return this._lowCompDb; }

  _recomputeLowBoost() {
    const g = Math.pow(10, this._lowCompDb / 20);     // dB → 线性
    const span = 3.2;                                  // 以 lowCompHz 为中心的对数宽度
    for (let i = 0; i < this.bands; i++) {
      const oct = Math.log2(Math.max(this.bandFreqs[i], 20) / this.lowCompHz);
      const w = Math.exp(-0.5 * (oct / span) ** 2);    // 0..1，低频最重
      this._lowBoost[i] = 1 + (g - 1) * w;
    }
  }

  /**
   * 喂入一帧时域样本（float32，-1..1，来自 getFloatTimeDomainData）。
   * 若数组 >N 只取最近 N 点；不足 N 时后面补 0。
   *
   * 这里**只存未加窗的原始帧**：加窗在下游按需做（长窗细谱用 fftSize 的 Hann，
   * 分层取样用**本层自己的** Hann）—— 与 Python 完全一致（`x = ring - mean`，
   * 然后 `x[-size:] * win_size`）。整帧均值也在下游去掉（`_xbuf`），
   * 这样 bin 1（≈10.8Hz）不会被直流污染。
   */
  push(data) {
    const d = data instanceof Float32Array ? data : new Float32Array(data);
    const n = d.length;
    if (n <= 0) return;
    const off = Math.max(0, n - this.N);
    this._lastDataLen = Math.min(n, this.N);
    const raw = this._raw;
    for (let j = 0; j < this._lastDataLen; j++) raw[j] = d[off + j];
    for (let j = this._lastDataLen; j < this.N; j++) raw[j] = 0;
  }

  /** 对最近一帧执行 Goertzel + 峰值归一 + 对数压缩 + 音色计量。
   *  @returns {Float32Array} this.heights —— **发布高度**（0..1，顶端软膝之后、不含
   *    demo 层的音色增益）；同一帧的**骨架**（0..peakStretch，增益管线用）在 this.skeleton。 */
  compute() {
    const B = this.bands, N = this.N;
    const raw = this.rawMag;
    const cA = this._coefA, cB = this._coefB, fr = this._tierFrac;
    const tierVals = (this._tierVals && this._tierVals.length === B)
      ? this._tierVals : (this._tierVals = new Float64Array(B));

    // ---- 去直流：x = frame - mean(frame)（与 Python 的 `x = self._ring - self._ring.mean()` 同义）
    // 不过这一步，直流分量会漏进最左端那几根条（bin 1 ≈10.8Hz）把它常年顶起来。
    // 这一步同时把 `_xbuf` 填好，供下面两路取样共用。
    this._frameMean();
    const xb = this._xbuf;

    // ---- Goertzel：每带按分层窗长，在**分数 bin 位置**取两个相邻整数 bin ----
    // pos = freq·tier/fs + (((i·5)%3)−1)·binOffset，band = spec[floor(pos)]·(1−frac)+spec[floor(pos)+1]·frac
    // （与 Python 的 spec[b0]*(1-frac)+spec[b0+1]*frac 完全一致）。
    // 关键：入参是**未加窗**的去直流帧，只乘**本层自己的** Hann 窗（乘两次窗 = 等效窗宽变窄、
    // 泄漏变大，会让低频段读到本不该有的能量 —— 那是"凭空的低端凸起"）。
    // 两个整数 bin 各跑一次递推；内层只有乘加，无三角函数。
    for (let i = 0; i < B; i++) {
      const sz = this._tier[i] || N;
      const winT = this._tierWins[sz] || this._win;
      const off = N - sz;
      // 左整数 bin i0
      let w = cA[i];
      let s0 = 0, s1 = 0;
      for (let n = 0; n < sz; n++) {
        const s = xb[off + n] * winT[n] + w * s0 - s1;
        s1 = s0; s0 = s;
      }
      let power = s0 * s0 + s1 * s1 - w * s0 * s1;
      const a0 = Math.sqrt(Math.max(power, 0));
      // 右整数 bin i0+1
      w = cB[i];
      s0 = 0; s1 = 0;
      for (let n = 0; n < sz; n++) {
        const s = xb[off + n] * winT[n] + w * s0 - s1;
        s1 = s0; s0 = s;
      }
      power = s0 * s0 + s1 * s1 - w * s0 * s1;
      const a1 = Math.sqrt(Math.max(power, 0));
      const f = fr[i];
      // 分数 bin 线性插值（低频补偿只在 raw 上叠加；逐带 AGC 用未加补偿的 tv）
      const tv = a0 * (1 - f) + a1 * f;
      tierVals[i] = tv;
      raw[i] = tv * this._lowBoost[i];
    }

    // ---- 长窗（fftSize）细谱：峰值归一 + 细节形变共用 ----
    // **与权威实现对齐的关键一步**：Python 里
    //     X = rfft(x · hanning(fft_size));  mag = |X[bins]|;  inst_peak = mag.max()
    // 而分层取样值是**短窗**谱（低端 1024 点），再统一除以这个**长窗峰值** ref。
    // 同一正弦在 4096 窗上的幅度 ≈ 1024 窗上的 4 倍，所以低端短窗值除以长窗峰值之后
    // rel 会小很多；如果像早先那样"除以本层自己的峰值"，低端会被整体抬高 ~4 倍 →
    // 低端整段冲进顶端软膝的饱和区 → 既出现"一大片等高平台"，也会把顶端削平。
    const fine = this._fineSpectrum();

    // ---- 峰值包络归一：快攻慢放 → 尖峰满格、整体不泵动 ----
    let mx = 0;
    for (let i = 0; i < B; i++) if (fine[i] > mx) mx = fine[i];
    this._peak = mx;
    if (this._peakEnv2 === undefined || this._peakEnv2 <= 0 || mx >= this._peakEnv2) {
      this._peakEnv2 = this._peakEnv2 === undefined ? mx
        : this._peakEnv2 + 0.85 * (mx - this._peakEnv2);
    } else {
      this._peakEnv2 = Math.max(mx * 1.02, this._peakEnv2 * 0.985);
    }
    const p = Math.max(this._peakEnv2, 1e-9);

    // ---- 对数压缩 log10(1 + kNorm·rel) → comp（0..1）----
    // 顺带存下每带的 rel（= 真实能量/峰值包络，0..1）：融合模式的音色判据就用它。
    // 特别注意：rel / comp **都不带倾斜** —— 音色计量必须测真实音频（与 Python 一致）。
    const kn = this.kNorm;
    const inv = 1 / Math.log10(1 + kn);
    const h = this.heights;
    const relAll = this._relAll;
    const comp = this._comp && this._comp.length === B ? this._comp
      : (this._comp = new Float32Array(B));
    for (let i = 0; i < B; i++) {
      const rel = Math.min(raw[i] / p, 1);
      relAll[i] = rel;
      comp[i] = Math.min(1, Math.max(0, Math.log10(1 + kn * rel) * inv));
    }

    /* 注意：参考播放器（D:\harness work）那套流水线（`_runReference`）在权威侧已被**回滚**
     * （`return self._run_reference(comp)` 被移除）—— 本移植同样**不调用**它，下面继续跑
     * 自定义显示级：逐带 AGC → 细节形变 → 对比度 → 倾斜/左倾斜坡 → 细谱判峰 → 融合强调 →
     * NMS → 增益 → 梳齿 → 软膝 → 峰条抬升 → 对比扩张 → 谷深 → 低频冲击块 → 包络 →
     * 5 抽头平滑 → 输出峰值归一。`_runReference` 保留定义但不被调用。 */

    // ---- 逐带慢包络（per-band AGC）：让两端"有内容就能立起来" ----
    // 全曲峰值归一保证响度无关，但音乐能量天然偏低频 → 高频段常年只有全曲峰值的
    // 百分之几，频谱两端（尤其右端）永远立不起来。这里给每带记一条**自己的慢包络**
    // （快攻 0.65 / 慢放 0.985），用
    //     refBand = min(全曲参考, max(该带包络·bandAgcRel, 全曲参考·bandAgcFloor))
    // 归一，再按 `bandAgc · agcW` 与全曲归一的结果**混合**（agcW 在 bandAgcFrom 以下为 0
    // → 低频/中频保留全曲归一，鼓点的时间动态不会被抹平）。
    // 仍然忠于原音频：抬的是该频段真实存在的能量，安静频段归一后依然 ≈0。
    if (this.bandAgc > 1e-6) {
      let env = this._bandEnv;
      if (!env || env.length !== B) {
        env = new Float32Array(B);
        env.set(relAll);
        this._bandEnv = env;
      } else {
        for (let i = 0; i < B; i++) {
          const r = relAll[i], e = env[i];
          env[i] = r >= e ? (e + 0.65 * (r - e)) : Math.max(r * 1.02, e * 0.985);
        }
      }
      for (let i = 0; i < B; i++) {
        let rb = Math.min(p, Math.max(env[i] * this.bandAgcRel, p * this.bandAgcFloor));
        if (rb < 1e-12) rb = 1e-12;
        const relB = Math.min(1, Math.max(0, tierVals[i] / rb));
        const mix = this.bandAgc * this._agcW[i];
        const compB = Math.log10(1 + kn * relB) * inv;
        comp[i] = Math.min(1, Math.max(0, (1 - mix) * comp[i] + mix * compB));
      }
    }

    // ---------- 细节形变（拆"大片"）：长窗细谱的相对起伏 → 有界乘性形变 ----------
    // 低频档 1024 点窗的 bin 宽 ≈43Hz：20~550Hz 这 ~40 根低频条可能只落在 9 个 bin 上
    // → 插值出来就是一片等高平台（用户说的"大片"）。这里用**长窗细谱**（fftSize 窗
    // ≈10.8Hz/bin，每带取自己的整数 bin）算出"相对邻域的起伏"，以有界乘性形变加回去：
    // 峰更峰、谷更谷，平台被拆成有起伏的坡；因为振幅有上下限、且在 detailSpan 根条的
    // 尺度上平滑，顶端连线依然是连续的、不会变回锯齿。全部由频谱自身推导，无随机。
    const shape = this._detailShape();
    if (shape && !this.detailAfter) {
      for (let i = 0; i < B; i++) comp[i] = Math.min(1, comp[i] * shape[i]);
    }

    // ---- 对比度增强：削底噪 → 幂曲线拉开强弱 → 相对平滑帧均值突出者加成 → 峰值拉伸 ----
    // 关键：先 clip 到 1.0 **再**乘 peakStretch —— 拉伸后的骨架刻意**不**夹回 1.0
    // （骨架可到 peakStretch=2.10）。过早夹到 1.0 会把强带之间的落差削平，梯度就没了；
    // 顶端收口留给"顶端软膝"（增益叠加之后）统一处理。
    const f0 = this.contrastFloor;
    const den = Math.max(1e-6, 1 - f0);
    for (let i = 0; i < B; i++) {
      const x = Math.min(1, Math.max(0, (comp[i] - f0) / den));
      h[i] = Math.pow(x, this.contrast);
    }
    let mean = 0;
    for (let i = 0; i < B; i++) mean += h[i];
    mean = mean / B + 1e-6;
    this._meanEnv = this._meanEnv === undefined
      ? mean : this._meanEnv * 0.92 + mean * 0.08;
    const meanRef = Math.max(this._meanEnv, 1e-6);
    for (let i = 0; i < B; i++) {
      const prom = Math.min(1.2, Math.max(0, h[i] / meanRef - 0.7));
      // 峰值拉伸 → **频谱倾斜** → **"向两边靠"的 U 形权重**
      // （都是乘性、有上下限；必须在增益与顶端软膝**之前**，否则会把顶端压成平顶）。
      // 基础为 0 的频段乘完仍是 0。
      h[i] = Math.min(1, h[i] * (0.82 + 0.42 * prom)) * this.peakStretch
             * this._tilt[i] * this._ends[i];
    }
    // 细节形变的另一条路径：作用在对比度**之后**（此时它直接作用在显示域上，
    // 不参与幂曲线）。默认走的是"之前"那条，与 Python 的分支保持一一对应。
    if (shape && this.detailAfter) {
      for (let i = 0; i < B; i++) h[i] = h[i] * shape[i];
    }

    // ---------- 短窗瞬态（最近 shortSize 个样本 · 96 点移动平均 ≈460Hz 低通） ----------
    // 融合模式的 kick 判据：短窗低频能量相对其基线的**突增**（打击感）。
    // 4096 点窗 ≈93ms 会把连续鼓点糊成一次，所以这里用短窗（Python 的 short_size=1024）。
    // 与 Python 一致：先去掉整帧均值，再对最近 shortSize 个样本做 valid 卷积取 RMS。
    {
      const xb = this._xbuf;                          // 已去直流（frameMean 在开头算过）
      const S = this.shortSize;
      const K = 96;                                   // 与 Python 的 _ma_kernel 一致
      const off2 = this.N - S;
      const maLen = S - (K - 1);
      let lowE = 0;
      if (maLen > 0) {
        let sum = 0;
        for (let i = 0; i < K; i++) sum += xb[off2 + i];
        let acc = 0;
        for (let t = 0; t < maLen; t++) {
          const v = sum / K;
          acc += v * v;
          if (t + 1 < maLen) {
            sum += xb[off2 + t + K] - xb[off2 + t];
          }
        }
        lowE = Math.sqrt(acc / maLen);
      }
      this._lowMa = 0.88 * this._lowMa + 0.12 * lowE;
      this._lowJump = (lowE - this._lowMa) / (this._lowMa + 1e-6);
    }

    // ---------- 轻微的局部极大值抑制：只削掉真正的尖刺，保住顶端连线 ----------
    // 必须在 _updateTimbre() 之前生效（与 Python 的 comp_disp → 增益 → 顶端软膝 同序）。
    this._suppressLocalMax(h);

    this._updateTimbre();
    // ---------- 骨架 → 发布高度 ----------
    // 此刻的数组是**骨架**（= Python 的 comp_disp：峰值拉伸 + 倾斜后不夹到 1.0），
    // 原样留一份给渲染层的增益管线（Python 里 comp_disp 本身也不平滑）。
    const skel = this.skeleton;
    for (let i = 0; i < B; i++) skel[i] = h[i];
    // 细谱判峰掩模 + **软膝之前的显式保顶**（与 Python 同序）：
    //   is_pk_pre = (_peak_mask > 0.9) | (shaped ≥ 第 k 大的值)
    //   shaped    = where(is_pk_pre, shaped·peakBoost, shaped)   ← 膝前抬，才不会被膝的饱和吃掉
    //   → 顶端软膝 → clip → 峰谷对比扩张 → 非峰 ·finePeakValley → clip → 包络 → 5 抽头平滑
    const peakMask = this._finePeakMask();
    this._peakMask = peakMask;              // 供渲染层 composeHeights 用（同帧同掩模）
    this.gauges.peakMask = peakMask;
    let isPkPre = null;
    if (peakMask) {
      isPkPre = new Uint8Array(B);
      let anyPos = false;
      for (let i = 0; i < B; i++) {
        isPkPre[i] = peakMask[i] > 0.9 ? 1 : 0;
        if (skel[i] > 0) anyPos = true;
      }
      if (anyPos && this.peakKeepTop >= 1) {
        const k = Math.max(1, Math.min(Math.floor(this.peakKeepTop), B));
        // 显式保顶：用"**第 k 大的值**"当阈值（并列时全部保顶）——规则与实现无关、
        // 跨端可逐位对齐（np.argpartition/argsort 在并列时的取舍是实现相关的）。
        const sorted = Array.from(skel).sort((a, b) => b - a);
        const thr = sorted[k - 1];
        for (let i = 0; i < B; i++) if (skel[i] >= thr) isPkPre[i] = 1;
      }
      for (let i = 0; i < B; i++) {
        h[i] = isPkPre[i] ? skel[i] * this.peakBoost : skel[i];
      }
    } else {
      for (let i = 0; i < B; i++) h[i] = skel[i];
    }
    // 本引擎这条路径发布"纯频率高度"（不含 demo 层音色增益）。
    // 平滑是最后一步、只作用于输出，绝不回灌骨架/包络状态（否则会逐帧累积）。
    for (let i = 0; i < B; i++) h[i] = applyTopKnee(h[i], this);
    this._peakExpandInPlace(h);
    if (isPkPre) {
      // 再把"非峰条"压成谷（峰已经在软膝之前抬过了）→ 塔又高又尖又陡、彼此孤立。
      // 谷深按位置渐变（_valleyProfile：两端 0.35 / 中间 0.75），与 Python 同序同公式。
      const vp = this._valleyProfile;
      for (let i = 0; i < B; i++) {
        const v = isPkPre[i] ? h[i] : h[i] * vp[i];
        h[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
      }
    }
    // ---------- 低频冲击块：kick/bass 活跃时，左侧 N 根整块顶到极高、其余压暗 ----------
    // 与 Python 同序：紧跟"非峰压谷"之后、包络之前（本引擎没有包络那一步，所以紧接其后）。
    //   lowAct = max(kick, bass)
    //   if lowAct > 0.02:  act = lowAct^lowSurgePow
    //       focus = block·(1 + gain·act) + (1−block)·(1 − dim·act)
    //       h = clip(h·focus, 0, 1)
    // 乘性、由音频活动度驱动 → 静音（≤0.02）完全不作用，零能量频段仍是零。
    if (this.fusion) {
      const lowAct = Math.max(this.gauges.kick, this.gauges.bass);
      if (lowAct > 0.02) {
        const act = Math.pow(lowAct, this.lowSurgePow);
        const inGain = 1 + this.lowSurgeGain * act;
        const inDim = 1 - this.lowSurgeDim * act;
        const blk = this._lowBlock;
        for (let i = 0; i < B; i++) {
          const b = blk[i];
          const v = h[i] * (b * inGain + (1 - b) * inDim);
          h[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
        }
      }
    }
    for (let i = 0; i < B; i++) h[i] = h[i] < 0 ? 0 : (h[i] > 1 ? 1 : h[i]);
    // 顶端连线平滑（与 Python 的 `np.convolve(_smooth, smooth_taps, 'same')` 同序：
    // 在低 surge 块**之后**、输出峰值归一之前）
    smoothAcrossBands(h, this.smoothTaps, this._smoothScratch);
    // ---------- 发布前的最后一步：输出峰值归一（与 Python 的 `_store()` 同式） ----------
    //   m = h.max(); want = min(displayPeak / m, displayPeakMax)
    //   scale = want（首帧） / scale += 0.06·(want − scale)（之后每帧）
    //   h = clip(h · scale, 0, 1)
    // 慢速逼近是关键：帧峰一掉就瞬间放大会造成帧间泵动；上限 displayPeakMax 防止
    // 把静音/极弱帧放大。displayPeak = 0 可整体关闭这一步。
    if (this.displayPeak > 0) {
      let m = 0;
      for (let i = 0; i < B; i++) if (h[i] > m) m = h[i];
      if (m > 1e-9) {
        const want = Math.min(this.displayPeak / m, this.displayPeakMax);
        this._scaleSm = this._scaleSm == null ? want
                                              : this._scaleSm + 0.06 * (want - this._scaleSm);
        const sc = this._scaleSm;
        for (let i = 0; i < B; i++) h[i] = h[i] * sc;
      }
    }
    for (let i = 0; i < B; i++) h[i] = h[i] < 0 ? 0 : (h[i] > 1 ? 1 : h[i]);
    this._frame++;
    return h;
  }

  /**
   * 参考播放器（D:\harness work）的条形流水线 —— 与 Python
   * `SpectrumAnalyzer._run_reference(comp)` 逐句对齐：
   *   1) 低频能量 → kick onset（lowPrev / tenv 两个慢包络）
   *   2) bandBoost 加权 + pow(i/n, 0.8) 采样映射 → 每根条一个值
   *   3) 倾斜补偿 pow(tiltBase, tilt·(1−u))（tilt = (50−tiltStrength)/50）
   *   4) 幂次曲线 pow(v, curvePow)
   *   5) 鼓点增强（极窄左端）
   *   6) 黄金比例确定性抖动
   *   7) 下限 barFloor + quantLevels 档量化
   *   8) attack/release 包络 + 峰值顶盖（peakFall）
   * 发布值就是包络本身（**没有** 5 抽头平滑、**没有** 输出峰值归一）。
   *
   * @param {Float32Array} comp 96 个对数频段的 log 谱（0..1）
   * @returns {Float32Array} 发布高度（= 包络）
   */
  _runReference(comp) {
    const B = this.bands, h = this.heights;
    const st = this._refState || (this._refState = {
      lowPrev: 0, tenv: 0, phase: 0,
      smooth: new Float32Array(B), peaks: new Float32Array(B),
    });
    return referenceBars(comp, st, this, h);
  }

  /**
   * 整帧均值 + 去直流帧 `_xbuf = frame - mean(frame)`（与 Python 的
   * `x = self._ring - self._ring.mean()` 同义）。每帧只算一次，供
   * 分层取样 / 长窗细谱 / 短窗瞬态检测共用。
   * @returns {number} 整帧均值
   */
  _frameMean() {
    const raw = this._raw, N = this.N;
    const xb = (this._xbuf && this._xbuf.length === N)
      ? this._xbuf : (this._xbuf = new Float32Array(N));
    let m = 0;
    for (let i = 0; i < N; i++) m += raw[i];
    m /= N;
    for (let i = 0; i < N; i++) xb[i] = raw[i] - m;
    return m;
  }

  /**
   * 长窗（fftSize）**细谱**：每带在自己的整数 bin `k = bandBins[i]` 上、用 fftSize 窗
   * 跑一次 Goertzel —— 等价于 Python 的 `mag = |rfft(x·hanning(fft_size))|[_bins]`
   * （单点 DFT，只差一个与"比值"无关的常数因子）。
   *
   * 两个用途（与权威实现一致）：
   *   1. **峰值包络归一**：`inst_peak = max(mag)`。注意权威实现里分层（短窗）取样值是
   *      除以这个**长窗峰值**的，不是"除以本层自己的峰值"；
   *   2. **细节形变**：span 根条的邻域起伏（把 1024 短窗造成的"一大片等高平台"拆开）。
   *
   * @returns {Float64Array} this._fine（长度 = bands，就地复用）
   */
  _fineSpectrum() {
    const B = this.bands, N = this.N;
    const fine = (this._fine && this._fine.length === B)
      ? this._fine : (this._fine = new Float64Array(B));
    const cf = this._coefFine, win = this._win;
    // _xbuf 由 compute() 开头的 _frameMean() 填好（去直流后的帧）
    if (!this._xbuf || this._xbuf.length !== N) this._frameMean();
    const xb = this._xbuf;
    for (let i = 0; i < B; i++) {
      const w = cf[i];
      let s0 = 0, s1 = 0;
      for (let n = 0; n < N; n++) {
        const s = xb[n] * win[n] + w * s0 - s1;
        s1 = s0; s0 = s;
      }
      const power = s0 * s0 + s1 * s1 - w * s0 * s1;
      fine[i] = Math.sqrt(Math.max(power, 0));
    }
    return fine;
  }

  /**
   * 长窗细谱的**相对邻域起伏** `fine/fine_sm`（细节形变与细谱判峰共用同一份）。
   *
   * 对应 Python `analyze()`：
   * ```
   * fine    = |rfft(x·win_fft_size)|[bins] + 1e-12     ← 长窗细谱、每带自己的 bin
   * fine_sm = convolve(fine, ones(detail_span)/detail_span, 'same') + 1e-12
   * ratio   = fine / fine_sm
   * ```
   * `fine_sm` 是 detail_span 根条的**居中滑动平均**（越界按 0 —— 与
   * `np.convolve(...,'same')` 的零填充边界一致；span=11 为奇数、核对称，
   * 等价于 c=(span-1)/2 的对称窗口）。
   *
   * @returns {Float64Array} 长度 = bands 的比值数组（就地复用）
   */
  _fineRatio() {
    const B = this.bands;
    const fine = (this._fine && this._fine.length === B)
      ? this._fine : this._fineSpectrum();
    const ratio = (this._fineRatioBuf && this._fineRatioBuf.length === B)
      ? this._fineRatioBuf : (this._fineRatioBuf = new Float64Array(B));
    const span = Math.max(1, Math.floor(this.detailSpan));
    const c = (span - 1) >> 1;
    const invSpan = 1 / span;
    for (let i = 0; i < B; i++) {
      let acc = 0;
      for (let m = i - c; m <= i + c; m++) if (m >= 0 && m < B) acc += fine[m] + 1e-12;
      ratio[i] = (fine[i] + 1e-12) / (acc * invSpan + 1e-12);
    }
    return ratio;
  }

  /**
   * 细节形变：由细谱相对起伏算出一组有界乘性系数（detailLo..detailHi）。
   *
   * Python: `shape = clip(ratio**detail_power, detail_lo, detail_hi)`，
   * 再 `comp = clip(comp·shape, 0, 1)`（`detail_after=True` 时改作用在对比度之后）。
   * 关闭时（`detailPower=0` 或 `detailSpan<3`）返回 `null`。
   *
   * @returns {Float32Array|null} 长度 = bands 的乘性系数；关闭时为 null
   */
  _detailShape() {
    const span = Math.floor(this.detailSpan);
    if (!(span >= 3) || !(this.detailPower > 0)) return null;
    const B = this.bands;
    const fine = (this._fine && this._fine.length === B)
      ? this._fine : this._fineSpectrum();
    const ratio = this._fineRatio();
    const shape = (this._detailBuf && this._detailBuf.length === B)
      ? this._detailBuf : (this._detailBuf = new Float32Array(B));
    const lo = this.detailLo, hi = this.detailHi, pw = this.detailPower;
    for (let i = 0; i < B; i++) {
      const r = Math.pow(ratio[i], pw);
      shape[i] = r < lo ? lo : (r > hi ? hi : r);   // 与 np.clip 同语义（NaN 依然传播）
    }
    return shape;
  }

  /**
   * 细谱判峰掩模（高峰离散化）：只有细谱局部最大（±finePeakSpan 内最大、且
   * ≥ finePeakRatio×该局部最大）的条保持全高，其余乘**按位置渐变的谷深**
   * `_valleyProfile`（两端 0.35 / 中间 0.75，与 Python 的 `_valley_profile` 同一个公式）。
   *
   * 与 Python 完全同序：掩模在这里**只算出来**，真正相乘发生在
   * `顶端软膝 → peak_expand` **之后**（`shaped ·= _peak_mask`）。
   * 边缘用"复制端点"（与 Python 的 np.concatenate 写法一致，不环绕）。
   * `finePeakSpan < 1` → 返回 `null`（等价于关闭）。
   *
   * @returns {Float32Array|null}
   */
  _finePeakMask() {
    const span = Math.floor(this.finePeakSpan);
    if (!(span >= 1)) return null;
    const B = this.bands, r = this._fineRatio();
    const loc = (this._fineLoc && this._fineLoc.length === B)
      ? this._fineLoc : (this._fineLoc = new Float64Array(B));
    loc.set(r);
    for (let d = 1; d <= span; d++) {
      for (let i = 0; i < B; i++) {
        const ir = i + d > B - 1 ? B - 1 : i + d;      // 复制端点（不环绕）
        const il = i - d < 0 ? 0 : i - d;
        if (r[ir] > loc[i]) loc[i] = r[ir];
        if (r[il] > loc[i]) loc[i] = r[il];
      }
    }
    const mask = (this._peakMaskBuf && this._peakMaskBuf.length === B)
      ? this._peakMaskBuf : (this._peakMaskBuf = new Float32Array(B));
    const th = this.finePeakRatio, vp = this._valleyProfile;
    for (let i = 0; i < B; i++) {
      mask[i] = (r[i] >= th * loc[i] && r[i] > 0) ? 1 : vp[i];
    }
    return mask;
  }

  /**
   * 峰谷对比扩张（unsharp mask）——就地改写传入的**已过顶端软膝**的显示值：
   * ```
   * base   = convolve(h, {0.1,0.2,0.4,0.2,0.1}, 'same')   // 零填充边界（同 numpy）
   * h      = clip(base + (h - base)·peakExpand, 0, 1)
   * ```
   * 峰更高、谷更低 → 扎堆的一簇高条被拉成一根根离散的尖塔，
   * 而整段平均高度（梯度、倾斜）不受影响。`peakExpand <= 1` 时不动。
   *
   * @param {Float32Array} h 就地改写的显示值（0..1）
   * @returns {Float32Array} h
   */
  _peakExpandInPlace(h) {
    const k = this.peakExpand;
    if (!(k > 1)) return h;
    const B = h.length;
    const taps = DEFAULT_SMOOTH_TAPS;              // {0.10,0.20,0.40,0.20,0.10}（未归一化，同 Python）
    const base = (this._expandBuf && this._expandBuf.length === B)
      ? this._expandBuf : (this._expandBuf = new Float32Array(B));
    for (let i = 0; i < B; i++) {
      let acc = 0;
      for (let j = 0; j < taps.length; j++) {
        const idx = i + 2 - j;                     // 'same' 的居中偏移（越界按 0）
        if (idx >= 0 && idx < B) acc += taps[j] * h[idx];
      }
      base[i] = acc;
    }
    for (let i = 0; i < B; i++) {
      const v = base[i] + (h[i] - base[i]) * k;
      h[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
    }
    return h;
  }

  /**
   * **轻微的**局部极大值抑制（就地改写入参，元素为 0..peakStretch 的骨架高度）。
   *
   * 完全由频谱自身形状推导（没有任何随机数）：以 ±peakRadius 个频段为邻域取
   * 局部最大值，只有接近该局部最大值的频段（≥ peakKeepRatio=0.92）才保持全高，
   * 其余频段乘 valleyKeep=0.85（几乎原样保留）→ 只把**真正的尖刺**削掉一点，
   * 顶端连线因此保持近似连续（不会变成一排孤立锯齿塔），高低走向也不被压平。
   * 邻域在两端**钳制**（不环绕），与 Python 的 np.concatenate 边界处理一致；
   * 完全平顶（相邻相等，说明已被削顶）仍按奇偶交替再打散一次。
   *
   * @param {Float32Array} h 骨架高度数组，函数直接改写它
   */
  _suppressLocalMax(h) {
    const B = h.length;
    const R = this.peakRadius, keep = this.peakKeepRatio, vk = this.valleyKeep;
    const loc = this._locMax && this._locMax.length === B
      ? this._locMax : (this._locMax = new Float32Array(B));
    const nms = this._nmsBuf && this._nmsBuf.length === B
      ? this._nmsBuf : (this._nmsBuf = new Float32Array(B));
    for (let i = 0; i < B; i++) {
      let m = h[i];                                  // ±R 邻域局部最大值（边界不环绕）
      for (let d = 1; d <= R; d++) {
        const a = i - d < 0 ? 0 : i - d;
        const b2 = i + d > B - 1 ? B - 1 : i + d;
        if (h[a] > m) m = h[a];
        if (h[b2] > m) m = h[b2];
      }
      loc[i] = m;
    }
    for (let i = 0; i < B; i++) {
      const v = h[i];
      const isPk = v / Math.max(loc[i], 1e-6) >= keep;
      // 完全平顶（相邻相等，说明显示已被削顶）用奇偶交替再打散一次
      const left = i > 0 ? h[i - 1] : h[0];
      const right = i < B - 1 ? h[i + 1] : h[B - 1];
      const plateau = v === left && v === right;
      nms[i] = v * ((isPk && !(plateau && (i % 2 === 1))) ? 1 : vk);
    }
    for (let i = 0; i < B; i++) h[i] = nms[i];
    return h;
  }

  /**
   * 融合模式：音色计量（kick/bass/人声/镲，0..1）+ 各频段的音色强调增益。
   *
   * 与 Python 的融合段逐行对应（全部来自音频分析，无随机）：
   *   * 判据是「该音色的频段里有没有接近整帧最强的能量」（**相对主导度**），
   *     这样窄带乐器（贝斯/人声/镲）不会被宽频带平均稀释掉；
   *   * kick 还要求短窗低频**确实在突增**（打击感）× 低频主导度^1.5，
   *     否则镲片/人声的低频残余会被误判成鼓；
   *   * 强调是**乘性增益** `1 + fusionGain·Σ(w_g·gauge_g)`：只有本来就有能量的
   *     频段会被抬高，没能量的频段不会被凭空造出来（依然忠于原音频）。
   *     它由渲染层在**很轻的增益梳齿之前**并入总增益 → 被点名的频段整段抬高一截，
   *     同时基础频谱的梯度依旧是真实音频的形状。
   */
  _updateTimbre() {
    const B = this.bands, rel = this._relAll, W = this.fusionWeights;
    // 整帧最强带（相对峰值包络）：下面所有"主导度"都是相对它
    let framePk = 1e-6;
    for (let i = 0; i < B; i++) if (rel[i] > framePk) framePk = rel[i];
    const pkOf = (w) => {
      let m = 0;
      for (let i = 0; i < B; i++) { const v = rel[i] * w[i]; if (v > m) m = v; }
      return m;
    };
    const lowPk = pkOf(W.bass), midPk = pkOf(W.vocal), highPk = pkOf(W.cymbal);
    // 主导度：^0.6 给"不是最强但确实有份量"的音色部分 credit（流行歌里贝斯常是最强带，
    // 若直接比峰值大小，人声会被永远压成 0）
    const dom = (pk) => Math.min(1, Math.max(0, 1.15 * Math.pow(pk / framePk, 0.6) - 0.15));
    const lowDom = dom(lowPk), midDom = dom(midPk), highDom = dom(highPk);
    // kick：短窗低频突增（打击感）**且**低频确实在主导（指数 1.5 进一步压制残余）
    const kickHit = Math.min(1, Math.max(0, this._lowJump * 1.8));
    this._kick = Math.max(kickHit * Math.pow(lowDom, 1.5), this._kick * 0.86);
    // bass：低频铺底持续主导（慢包络）
    this._bass = 0.90 * this._bass + 0.10 * lowDom;
    // 人声/旋律：中频主导
    this._vocal = 0.88 * this._vocal + 0.12 * midDom;
    // 镲片/空气：高频主导 + 帧间闪烁（镲是宽频噪声，闪烁更能说明"在打镲"）
    this._highEnv = 0.90 * this._highEnv + 0.10 * highDom;
    this._cymbal = Math.min(1, Math.max(0,
      highDom + 0.5 * Math.abs(highDom - this._highEnv)));

    const g = this.gauges;
    g.kick = this._kick;
    g.bass = this._bass;
    g.vocal = this._vocal;
    g.cymbal = this._cymbal;

    // 供界面/测试观察的中间量（都是音频真实测出来的数值）
    const t = this.lastTimbre;
    t.framePk = framePk; t.lowPk = lowPk; t.midPk = midPk; t.highPk = highPk;
    t.lowDom = lowDom; t.midDom = midDom; t.highDom = highDom; t.kickHit = kickHit;

    // 强调数组（渲染层在梳齿之前并入增益）；融合关闭时恒为 1（A/B 对照）
    const e = this.emphasis;
    if (this.fusion) {
      const fg = this.fusionGain;
      for (let i = 0; i < B; i++) {
        e[i] = 1 + fg * (W.kick[i] * this._kick + W.bass[i] * this._bass
                       + W.vocal[i] * this._vocal + W.cymbal[i] * this._cymbal);
      }
    } else {
      e.fill(1);
    }
  }

  /** 完整处理一帧：push + compute 的便捷封装。 */
  process(timeData) {
    this.push(timeData);
    return this.compute();
  }
}

// ----------------------------------------------------------------------------
// 函数式入口：按 (sampleRate, bands, fftSize, 融合开关, kNorm/膝/倾斜/细节参数) 缓存
// 单例引擎，保持峰值跟踪连续。key 里带上解析参数，切换"作业原设定/升级版"时不会误用旧引擎。
// ----------------------------------------------------------------------------
const _cache = new Map();
function getEngine(opts) {
  const key = `${opts.sampleRate}|${opts.bands || 96}|${opts.fftSize || 4096}` +
              `|${opts.fusion === false ? 0 : 1}|${opts.fusionGain == null ? 3.8 : opts.fusionGain}` +
              `|${opts.kNorm == null ? 200 : opts.kNorm}|${opts.topKnee == null ? 0.75 : opts.topKnee}` +
              `|tilt=${opts.tilt == null ? 0.35 : opts.tilt}` +
              `|ends=${opts.endsGain == null ? 1.8 : opts.endsGain}` +
              `,${opts.midCut == null ? 0.25 : opts.midCut}` +
              `,${opts.endsP == null ? 1.5 : opts.endsP}` +
              `|agc=${opts.bandAgc == null ? 1 : opts.bandAgc}` +
              `,${opts.bandAgcRel == null ? 1.15 : opts.bandAgcRel}` +
              `,${opts.bandAgcFrom == null ? 0.55 : opts.bandAgcFrom}` +
              `|detail=${opts.detailSpan == null ? 11 : opts.detailSpan}` +
              `,${opts.detailPower == null ? 0.85 : opts.detailPower}` +
              `,${opts.detailAfter === true ? 1 : 0}` +
              `|fpk=${opts.finePeakSpan == null ? 4 : opts.finePeakSpan}` +
              `,${opts.finePeakRatio == null ? 0.99 : opts.finePeakRatio}` +
              `,${opts.finePeakValley == null ? 0.45 : opts.finePeakValley}` +
              `,${opts.finePeakValleyMid == null ? 0.60 : opts.finePeakValleyMid}` +
              `|boost=${opts.peakBoost == null ? 1.4 : opts.peakBoost}` +
              `,${opts.peakKeepTop == null ? 1 : opts.peakKeepTop}` +
              `|expand=${opts.peakExpand == null ? 1.5 : opts.peakExpand}` +
              `|dpeak=${opts.displayPeak == null ? 0.92 : opts.displayPeak}` +
              `,${opts.displayPeakMax == null ? 2 : opts.displayPeakMax}` +
              `|lowsurge=${opts.lowSurgeBars == null ? 10 : opts.lowSurgeBars}` +
              `,${opts.lowSurgeGain == null ? 12 : opts.lowSurgeGain}` +
              `,${opts.lowSurgeDim == null ? 0.62 : opts.lowSurgeDim}` +
              `,${opts.lowSurgePow == null ? 1.1 : opts.lowSurgePow}` +
              `,${opts.lowSurgeEdge == null ? 2 : opts.lowSurgeEdge}`;
  let e = _cache.get(key);
  if (!e) {
    e = new SpectrumEngine(opts);
    _cache.set(key, e);
  }
  return e;
}

/**
 * 作业原设定（题目里那套参数）：Hann **2048** 点窗 + **80** 个对数频段 +
 * `log10(1 + 100·rel)` 峰值归一，音色三频段按 80 带 + 0.98 覆盖校准。
 *
 * ```js
 * analyser.fftSize = SPEC_2048_80.fftSize;                 // 2048
 * const r = computeCustomSpectrum(buf, { ...SPEC_2048_80, sampleRate: ctx.sampleRate });
 * ```
 *
 * 不带这套选项时用的是**升级版**（4096 点窗 + 96 频段 + K=200 + 分层窗长 1024/2048/4096），
 * 频段更细、快速鼓点也能分辨 —— 两者是同一套算法的两种参数档，输出结构完全一致
 * （都是 0..1 的条形高度 + 音色计量 + 骨架），可视化管线不用改。
 */
export const SPEC_2048_80 = Object.freeze({
  fftSize: 2048,
  bands: 80,
  kNorm: 100,
  coverage: 0.98,
});

/**
 * 主入口：computeCustomSpectrum —— 所有条形类可视化（融合/音色/条形/圆环）
 * 共用的频率数据源。
 * @param {Float32Array} timeData  analyser.getFloatTimeDomainData 的结果（2048 点）
 * @param {object}       [opts]
 * @returns {{heights:Float32Array, skeleton:Float32Array, gauges:object, info:object, sampleRate:number}}
 *   `heights`  发布高度 0..1（骨架过一次顶端软膝：膝下线性保梯度、膝上对数肩严格单调）；
 *   `skeleton` 频率骨架 0..peakStretch（= Python 的 comp_disp）—— 渲染层做音色增益
 *              管线时必须用它（增益 → 很轻的梳齿 → 顶端软膝，与 Python 同序）。
 */
export function computeCustomSpectrum(timeData, opts = {}) {
  const engine = getEngine(opts);
  engine.push(timeData);
  const heights = engine.compute();
  return {
    heights,
    skeleton: engine.skeleton,
    comp: engine._comp,                       // 对数谱（参考流水线的输入；渲染层要用它）
    gauges: engine.gauges,
    info: {
      bands: engine.bands,
      comp: engine._comp,                     // 同上（渲染层 composeHeights 的输入）
      bandBoost: engine._bandBoost,           // 参考播放器的 bandBoost / 采样映射 / barU
      sampleA: engine._sampleA,
      sampleB: engine._sampleB,
      barU: engine._barU,
      tiltStrength: engine.refTiltStrength,
      tiltBase: engine.refTiltBase,
      curvePow: engine.curvePow,
      kickGain: engine.kickGain,
      kickSpan: engine.kickSpan,
      kickLowFrom: engine.kickLowFrom,
      kickLowTo: engine.kickLowTo,
      kickLowPrevRate: engine.kickLowPrevRate,
      kickTenvRate: engine.kickTenvRate,
      jitterAmp: engine.jitterAmp,
      jitterGr: engine.jitterGr,
      jitterStep: engine.jitterStep,
      quantLevels: engine.quantLevels,
      barFloor: engine.barFloor,
      attack: engine.attack,
      release: engine.release,
      peakFall: engine.peakFall,
      bbBassPos: engine.bbBassPos,
      bbBassSigma: engine.bbBassSigma,
      bbBassGain: engine.bbBassGain,
      bbValleyPos: engine.bbValleyPos,
      bbValleySigma: engine.bbValleySigma,
      bbValleyDepth: engine.bbValleyDepth,
      bbLo: engine.bbLo,
      bbHi: engine.bbHi,
      samplePow: engine.samplePow,
      sampleUsable: engine.sampleUsable,
      kNorm: engine.kNorm,
      fMin: engine.fMin,
      fMax: engine.fMax,
      nyquist: engine.nyquist,
      coverage: engine.coverage,
      bandFreqs: engine.bandFreqs,
      bandBins: engine.bandBins,
      group: engine.group,
      lowCompDb: engine.lowCompDb,
      fusion: engine.fusion,                  // 融合模式开关（音色强调）
      fusionGain: engine.fusionGain,
      fusionWeights: engine.fusionWeights,    // 四路音色频段权重（对数高斯）
      peakStretch: engine.peakStretch,        // 骨架上限（顶端软膝参数同 Python）
      tilt: engine.tilt,                      // 频谱倾斜（左端 ×(1+tilt) → 右端 ×(1−tilt)）
      tiltRamp: engine._tilt,
      endsGain: engine.endsGain,              // "向两边靠"的 U 形权重（两端 ×endsGain、中间 ×midCut）
      midCut: engine.midCut,
      endsP: engine.endsP,
      endsRamp: engine._ends,
      bandAgc: engine.bandAgc,                // 逐带慢包络（per-band AGC）
      bandAgcRel: engine.bandAgcRel,
      bandAgcFloor: engine.bandAgcFloor,
      bandAgcFrom: engine.bandAgcFrom,
      agcW: engine._agcW,
      detailSpan: engine.detailSpan,
      detailPower: engine.detailPower,
      detailLo: engine.detailLo,
      detailHi: engine.detailHi,
      detailAfter: engine.detailAfter,
      finePeakSpan: engine.finePeakSpan,
      finePeakRatio: engine.finePeakRatio,
      finePeakValley: engine.finePeakValley,
      finePeakValleyMid: engine.finePeakValleyMid,
      valleyProfile: engine._valleyProfile,   // 按位置渐变的谷深（两端 0.35 / 中间 0.75）
      peakBoost: engine.peakBoost,            // 峰条额外抬升（软膝**之前**施加）
      peakKeepTop: engine.peakKeepTop,        // 显式保顶（按"第 k 大的值"阈值，并列全保）
      peakExpand: engine.peakExpand,
      displayPeak: engine.displayPeak,        // 输出峰值归一目标（发布高度最高条 ≈92%）
      displayPeakMax: engine.displayPeakMax,  // 归一放大上限（防静音放大）
      displayScale: engine._scaleSm,          // 本帧实际用的慢速缩放系数
      lowSurgeBars: engine.lowSurgeBars,      // 低频冲击块：条数 / 抬升 / 压暗 / 响应 / 边缘
      lowSurgeGain: engine.lowSurgeGain,
      lowSurgeDim: engine.lowSurgeDim,
      lowSurgePow: engine.lowSurgePow,
      lowSurgeEdge: engine.lowSurgeEdge,
      lowBlock: engine._lowBlock,             // 冲击块权重（渲染层复用同一份）
      topKnee: engine.topKnee,
      topWidth: engine.topWidth,
      topMax: engine.topMax,
      engine,
    },
    sampleRate: engine.sampleRate,
  };
}

/**
 * 参考播放器（D:\harness work）的条形流水线 —— 与 Python `SpectrumAnalyzer._run_reference(comp)`
 * 逐句对齐，引擎与渲染层共用同一份实现：
 *   1) 低频能量 → kick onset（lowPrev / tenv 两个慢包络）
 *   2) bandBoost 加权 + pow(i/n, 0.8) 采样映射 → 每根条一个值
 *   3) 倾斜补偿 pow(tiltBase, tilt·(1−u))（tilt = (50−tiltStrength)/50）
 *   4) 幂次曲线 pow(v, curvePow)
 *   5) 鼓点增强（极窄左端）
 *   6) 黄金比例确定性抖动
 *   7) 下限 barFloor + quantLevels 档量化
 *   8) attack/release 包络 + 峰值顶盖（peakFall）
 * 发布值就是包络本身（**没有** 5 抽头平滑、**没有** 输出峰值归一）。
 *
 * @param {Float32Array} comp 对数频段 log 谱（0..1），长度 = bands
 * @param {object} st  逐帧状态 { lowPrev, tenv, phase, smooth, peaks }
 * @param {object} src 参数来源（引擎实例或渲染 opts，字段同名）
 * @param {Float32Array} [out] 输出数组（省略则新建）
 * @returns {Float32Array} 发布高度（= 包络）
 */
export function referenceBars(comp, st, src, out) {
  const B = comp.length;
  const h = out && out.length === B ? out : new Float32Array(B);
  const num = (a, b) => {
    const v = src ? src[a] : undefined;
    if (v == null) {
      const rv = src && src.renderOpts ? src.renderOpts[a] : undefined;
      return rv == null ? b : Number(rv);
    }
    return Number(v);
  };
  const arr = (a) => {
    const v = src ? src[a] : null;
    if (v && v.length === B) return v;
    const rv = src && src.renderOpts ? src.renderOpts[a] : null;
    return rv && rv.length === B ? rv : null;
  };
  const kickLowFrom = Math.floor(num('kickLowFrom', 2));
  const kickLowTo = Math.floor(num('kickLowTo', 8));
  const bb = arr('_bandBoost') || defaultBandBoost(B, src);
  const sA = arr('_sampleA') || defaultSampleMap(B, src).a;
  const sB = arr('_sampleB') || defaultSampleMap(B, src).b;
  const barU = arr('_barU') || defaultBarU(B);

  // 1) 低频能量 → kick onset
  const loF = kickLowFrom, hiF = Math.min(kickLowTo, B);
  let low = 0;
  if (hiF > loF) {
    let acc = 0;
    for (let i = loF; i < hiF; i++) acc += comp[i];
    low = acc / (hiF - loF);
  } else {
    low = comp[Math.min(Math.max(loF, 0), B - 1)];
  }
  const kickEnergy = Math.max(0, low - st.lowPrev);
  st.lowPrev += (low - st.lowPrev) * num('kickLowPrevRate', 0.25);
  st.tenv += (low - st.tenv) * num('kickTenvRate', 0.08);

  // 2) 频段→条：bandBoost 加权平均
  for (let i = 0; i < B; i++) {
    const a = sA[i], b = sB[i];
    let acc = 0;
    for (let j = a; j < b; j++) acc += comp[j] * bb[j];
    h[i] = acc / Math.max(1, b - a);
  }
  const tilt = (50 - num('refTiltStrength', 61.0)) / 50;
  const tiltBase = num('refTiltBase', 5.0);
  const curvePow = num('curvePow', 2.1);
  const kickGain = num('kickGain', 2.4);
  const kickSpan = Math.max(0.01, num('kickSpan', 0.05));
  const jitterAmp = num('jitterAmp', 0.45);
  const jitterGr = num('jitterGr', 0.618033988749895);
  const barFloor = num('barFloor', 0.02);
  const q = Math.max(2, Math.floor(num('quantLevels', 14))) - 1;
  for (let i = 0; i < B; i++) {
    const u = barU[i];
    let v = h[i] * Math.pow(tiltBase, tilt * (1 - u));            // 3) 倾斜补偿
    v = Math.pow(Math.min(Math.max(v, 0), 1), curvePow);          // 4) 幂次曲线
    v += kickGain * kickEnergy * Math.min(Math.max(1 - u / kickSpan, 0), 1);  // 5) 鼓点增强
    v *= 1 + jitterAmp * Math.sin(u * jitterGr * 2 * Math.PI + st.phase);    // 6) 抖动
    v = Math.min(Math.max(v, barFloor), 1);                       // 7) 下限
    h[i] = Math.round(v * q) / q;                                 //    量化
  }
  st.phase = (st.phase + num('jitterStep', 0.03)) % (2 * Math.PI);

  // 8) attack/release 包络 + 峰值顶盖（发布值就是包络）
  const attack = num('attack', 0.70), release = num('release', 0.82);
  const peakFall = num('peakFall', 0.97);
  const sm = st.smooth && st.smooth.length === B ? st.smooth : (st.smooth = new Float32Array(B));
  const pk = st.peaks && st.peaks.length === B ? st.peaks : (st.peaks = new Float32Array(B));
  for (let i = 0; i < B; i++) {
    const s = sm[i], t = h[i];
    const nxt = t >= s ? s + attack * (t - s) : s + release * (t - s);
    sm[i] = nxt;
    const cap = pk[i] * peakFall;
    pk[i] = nxt > cap ? nxt : cap;
    h[i] = nxt;
  }
  return h;
}

/** 渲染层没有引擎预计算表时，按同一公式现算（与引擎逐条相同）。 */
function defaultBandBoost(B, src) {
  const g = (a, b) => {
    const v = src ? src[a] : undefined;
    if (v == null) {
      const rv = src && src.renderOpts ? src.renderOpts[a] : undefined;
      return rv == null ? b : Number(rv);
    }
    return Number(v);
  };
  const out = new Float32Array(B);
  const denom = Math.max(1, B - 1);
  const pos = g('bbBassPos', 0.12), sig = g('bbBassSigma', 0.030), gain = g('bbBassGain', 1.8);
  const vpos = g('bbValleyPos', 0.33), vsig = g('bbValleySigma', 0.09), vdep = g('bbValleyDepth', 0.45);
  const lo = g('bbLo', 0.58), hi = g('bbHi', 2.9);
  for (let i = 0; i < B; i++) {
    const f = i / denom;
    const db = (f - pos) / sig, dv = (f - vpos) / vsig;
    const bass = Math.exp(-(db * db)) * gain;
    const valley = -Math.exp(-(dv * dv)) * vdep;
    out[i] = Math.min(hi, Math.max(lo, 1 + bass + valley));
  }
  return out;
}
function defaultSampleMap(B, src) {
  const g = (a, b) => {
    const v = src ? src[a] : undefined;
    if (v == null) {
      const rv = src && src.renderOpts ? src.renderOpts[a] : undefined;
      return rv == null ? b : Number(rv);
    }
    return Number(v);
  };
  const pow = g('samplePow', 0.8);
  const usable = Math.max(1, Math.floor(B * Math.min(1, Math.max(0.1, g('sampleUsable', 0.98)))));
  const a = new Int32Array(B), b = new Int32Array(B);
  for (let i = 0; i < B; i++) {
    let lo = Math.floor(Math.pow(i / B, pow) * usable);
    let hi = Math.floor(Math.pow((i + 1) / B, pow) * usable);
    lo = Math.min(Math.max(lo, 0), usable - 1);
    hi = Math.max(lo + 1, Math.min(hi, usable));
    a[i] = lo; b[i] = hi;
  }
  return { a, b };
}
function defaultBarU(B) {
  const u = new Float64Array(B);
  for (let i = 0; i < B; i++) u[i] = i / B;
  return u;
}

export default SpectrumEngine;





