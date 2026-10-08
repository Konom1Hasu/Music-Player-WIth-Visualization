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
 *   1. 观感参数**逐个照抄 1.3.0**：抖动幅度 0.45、行波空间频率
 *      0.1 + 0.2·(K−0.4)、相位步进 0.03、单边颤动 0.055、14 级量化、倾斜 55、
 *      泵动 0.40、幂次 2.1、一阶跟随系数 0.7−0.2·(i/n) / 0.58+0.22·(i/n)。
 *      ★ 例外：**分析窗已从 1024 降到 512**（2026-10-08 用户要求"延迟要低"，
 *        明确覆盖"窗长也照抄 1.3.0"这一条，见 ANALYSIS_WINDOW 的说明）。
 *        这是目前唯一一处刻意偏离 1.3.0 的参数，改动前先读那一段的取舍说明。
 *      2.0.0 曾按"毛刺感太严重"做过一轮去毛刺（慢速随机抖动、[1,2,1] 平滑、512 点窗），
 *      已按用户要求整体撤回 —— 屏幕上看到的就是 1.3.0 那条流水线的输出。
 *   2. 只动**架构、不动观感**：Goertzel 从主线程搬进 Web Worker（每 20ms 一 tick，
 *      与 1.3.0 的 `vizInterval()` 50Hz 一致），主线程只负责按 60fps 重画。
 *      ★ 绘制读的是 `display` —— 相邻两次分析之间的**线性插值**（见 render()）：
 *      20ms 的分析节拍与 60fps 的重画节拍不成整数倍，不插值就会出现
 *      "有时隔一帧才动、有时隔两帧才动"的错拍（用户："怎么还更卡"）。
 *      柱高**数值**仍完全来自 1.3.0 那条流水线（诊断与播放条读的 `levels` 就是它）。
 */

import { BEAT_VERSION, sampleBeatMap, type BeatMap } from "./beatmap.ts";

export const SPECTRUM_BANDS = 120; // 对数频段数（分析侧，不动）
/* 柱数是**显示侧**的采样密度，与 120 个分析频段解耦：bar i → 频段区间
   floor(pow(i/BAR_N,0.8)*117)，区间内取平均。150 比 120 多约 1/4 根、每根窄约 1/5，
   看着更细密；而频域里的塑形（细针中心 / 倾斜增益）算出来与 120 柱时逐位相同
   （bassPeakBar 从 9 变成 11，落到同一个频段区间 [14,15)，needleCenter 仍是 14/119），
   所以旧版导入的调音参数效果一个字没变。 */
const BAR_N = 150; // 柱数
const VIZ_LEVELS = 14; // 阶梯级数
/* 分析窗长：★ 2026-10-08 用户要求"延迟要低"，从 1.3.0 的 1024 点降到 **512 点** ——
   这是对"参数完全参照 1.3.0"（2026-09-25 的要求）的一次**明确覆盖**，延迟优先。
   · 延迟来源：窗本身引入的等效群延迟 ≈ (N/2)/sr —— 1024 点 ≈ 10.7ms、512 点 ≈ 5.3ms。
     这是**因果链的固有代价**：先听到一整个窗才能算完，调参救不了（见下面 BEAT_* 的说明）。
     再叠上 20ms 的分析节拍与 worker 往返，屏幕才亮起来；窗减半等于把这条链的最粗一段砍掉。
   · 代价：等效噪声带宽 ENBW ≈ 1.5·sr/N（Hann 窗）—— 1024 点时 ≈ 70Hz、512 点时 ≈ 141Hz
     （按 48kHz）。低频那根"细针"（≈42Hz）因此更容易被邻频带干扰，稳定度下降 ——
     用户已知情并选择接受（观感由 setVizParams 的 bassSigma 与瞬态强调继续保形）。
   · 采样率变化时这套映射自动跟随：bandK 与 HANN 全按本常量算，没有别处写死窗长。 */
const ANALYSIS_WINDOW = 512;
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
   导入不到就用 1.3.0 的默认值（下面 VIZ_DEFAULTS）。
   注：观感强化（鼓点灵敏度 / 顶端张力 / 顶端形态）是**独立常量**，见文件下方的
   KICK_* / TOP_TENSION* / TOP_SPIKE* —— 它们的默认值不等于 1.3.0，置 0 即可回退。 */
export interface VizParams {
  tilt: number; // 频谱平衡 0~100（越大左侧整体越高）
  bassSigma: number; // 左峰宽丘的 σ（0.020~0.080，越小越窄）
  jitterK: number; // 抖动倍率（0.40~2.00）
  kickPump: number; // 鼓点泵动深度（KICK_PUMP_MIN~0.60，0 = 左峰一直顶满 —— 见下面的闸门）
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
/* ★ 左峰"留余量"闸门（用户 2026-09-28："可视化左侧不要一直顶满"）。
   根因就是这里的 kickPump：它的定义是"鼓点之间把左峰压多低"，
   取 0 等于关掉泵动 —— 左峰被频段增益顶到天花板之后就再也不下来，
   量化后看着就是一排死顶满的柱子（离线观测：左峰 100% 的帧贴着 0.98、起伏 σ 0.001）。
   旧版播放器面板上"鼓点"能拉到 0，用户的旧设置正是 0，导入后就成了这样。
   1.3.0 的默认值是 0.40（"鼓点顶满、拍间回落"），所以把它当成硬下限：
   左峰照样能顶到最高（峰值高度没动），但拍与拍之间会掉下来，不再一直顶满。 */
export const KICK_PUMP_MIN = 0.4;
/** 把"会一直顶满"的参数夹回有起伏的区间（旧版导入的值可能落在顶满区，见 KICK_PUMP_MIN） */
export function clampHeadroom(p: Partial<VizParams>): Partial<VizParams> {
  const out: Partial<VizParams> = { ...p };
  if (typeof out.kickPump === "number" && out.kickPump < KICK_PUMP_MIN) out.kickPump = KICK_PUMP_MIN;
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

/* ============ 观感强化参数（全部独立常量，可单独调节或置 0 回退） ============
     · KICK_*      —— 鼓点 onset 灵敏度（跟得住高速鼓点）
     · TOP_TENSION —— 顶端补抖：让高柱有张力 / 抖动（不再被量化抹平）
     · TOP_SPIKE_* —— 顶端形态：锯齿尖峰（既不是方块、也不是连续曲线）
   把 TOP_TENSION / TOP_SPIKE 置 0 即回到 1.3.0 的原始观感。 */

/* ★ 鼓点灵敏度：参考电平用**不对称跟随**（上升快、回落也快），
   阈值之上的部分线性放大 —— 密集的 8 分 / 16 分鼓点也能各自触发到接近满值。 */
const KICK_REF_ATTACK = 0.30; // ref 上升时的跟随系数
const KICK_REF_RELEASE = 0.16; // ref 回落时的跟随系数（越大越跟得上快节奏）
const KICK_RISE_FLOOR = 0.02; // 触发阈值（越低越敏感）
const KICK_RISE_GAIN = 4.2; // 阈值之上的放大倍数

/* 这两组常量要让 worker 里的分析实现也用到（同一套数值，避免两条路径跑出不同观感）。 */
export {
  KICK_BAND_FROM as SPECTRUM_KICK_FROM,
  KICK_BAND_TO as SPECTRUM_KICK_TO,
  KICK_REF_ATTACK as SPECTRUM_KICK_REF_ATTACK,
  KICK_REF_RELEASE as SPECTRUM_KICK_REF_RELEASE,
  KICK_RISE_FLOOR as SPECTRUM_KICK_FLOOR,
  KICK_RISE_GAIN as SPECTRUM_KICK_GAIN,
};

/* ★ 瞬态强调（"精细反映歌曲里的鼓点、音色"）：
   只靠低频 onset 时，只有底鼓会推起左峰；军鼓 / 踩镲这类**宽带**敲击
   在显示上几乎看不出来。这里再算一路**谱通量**（spectral flux）：
     · 对每个分析频段取 m_b − m_b(上一 tick) 的正向增量 → 得到"这一 tick 谁在涨"；
     · 增量之和做归一化，得到每个频段在本次敲击里占的**份额**；
     · 再乘一个全局 onset 门（只有真的出现敲击时才抬，持续段不提亮）。
   于是底鼓抬低频、军鼓抬中频、踩镲抬高频 —— 敲击的**频谱形状**被如实带出来，
   而不是整排一起亮。门控用与 kick 相同的"不对称跟随 + 低阈值"。 */
const TRANSIENT_REF_ATTACK = 0.26; // 通量参考电平上升时的跟随系数
const TRANSIENT_REF_RELEASE = 0.14; // 通量参考电平回落时的跟随系数
const TRANSIENT_FLOOR = 0.18; // 触发阈值
/* ★ 动态对比拉大（2026-10-08 用户："频谱的区分度可以极端一点"，选定方向为**动态对比**）：
   不动稳态的频谱形状（那是"频域锐化"的事，用户没选），只把**敲击瞬间的落差**做狠 ——
   稳态段柱子基本不动，一敲下去受影响的频段窜起来、敲完立刻落回，
   "动"与"静"的对比因此更极端，鼓点的存在感更强。
   · TRANSIENT_BOOST 抬升量（份额换算成柱高的系数）0.62 → 0.90；
   · TRANSIENT_GAIN   门曲线斜率（越大，onset 从 0 冲到 1 越快）2.6 → 3.4；
   · KICK_RISE_GAIN   鼓点阈值之上的放大倍数 3.2 → 4.2。
   置 TRANSIENT_BOOST = 0 即关闭瞬态层（回到 1.3.0 观感）。 */
const TRANSIENT_GAIN = 3.4; // 阈值之上的放大倍数
const TRANSIENT_BOOST = 0.9; // 份额换算成"抬多少柱高"的系数（0 = 关闭瞬态强调）
const TRANSIENT_BANDS_REF = 12; // 份额归一参考段数：通量集中在这个段数上时，每段加满 TRANSIENT_BOOST
const TRANSIENT_FROM = 1; // 从第几个分析频段开始算（跳过直流附近）
export {
  TRANSIENT_REF_ATTACK as SPECTRUM_TR_REF_ATTACK,
  TRANSIENT_REF_RELEASE as SPECTRUM_TR_REF_RELEASE,
  TRANSIENT_FLOOR as SPECTRUM_TR_FLOOR,
  TRANSIENT_GAIN as SPECTRUM_TR_GAIN,
  TRANSIENT_BOOST as SPECTRUM_TR_BOOST,
  TRANSIENT_BANDS_REF as SPECTRUM_TR_BANDS_REF,
  TRANSIENT_FROM as SPECTRUM_TR_FROM,
};

/* ★ 峰值线衰减（用户 2026-10-04："频谱的回落还是不够干脆"）。
   诊断结论：柱体**本体的回落非常干脆**（离线观测：敲击峰值 1.0 → 一个 tick 掉到 0.40，
   半程 0ms、掉到 10% 只用 40ms）—— 拖尾**不在柱体上，在这条峰值线上**。
   峰值线的语义是"最近一次峰值的指示线"，所以它**必须比柱体慢**（否则和柱顶重合、看不出是两条），
   原来取 0.97/tick（50Hz）—— 换算成时间常数是**半程 455ms、掉到 10% 要 1.5 秒、5% 要 2 秒**：
   敲击过去之后，一条水平亮线在空中挂将近两秒，读起来就是"回落不干脆"。
   改成 0.90/tick：半程 132ms、10% 437ms —— 仍明显慢于柱体（看得清是指示线），
   但不再是一道 2 秒的残影。置 1 即不回落的旧行为（不推荐）。 */
const PEAK_DECAY = 0.9;

/* ★ 回落时的插值跨度比例（配合 PEAK_DECAY 一起解决"回落不干脆"）。
   render() 把"上一个分析 tick → 这个 tick"的柱高差按时间线性铺开 ——
   上升时这是对的（起势要顺），下降时它会把"一步砸下来"摊成一条 20ms 的斜坡。
   取 0.6：下落量在跨度的前 60%（12ms）就到位，之后停在终点 —— 触底更干脆，
   又不会完全取消插值（完全取消会让 20ms/60fps 的错拍重新显形，见 render() 的说明）。 */
const FALL_INTERP_SPAN = 0.6;

/* ==================== 节拍先验（离线预分析，详见 beatmap.ts） ====================
   在线的鼓点检测（上面的 KICK_*）是**因果的**：必须先听到、才可能亮。
   一个分析窗 512 点 ≈ 10.7ms（原 1024 点 ≈ 21ms），再乘上 worker 往返与绘制的节拍，
   屏幕真正亮起来的时刻比耳朵晚 —— 注释里反复出现的"延迟感严重"
   就是这条链的固有代价，**调参救不了**（参数只改灵敏度，改不了因果性）。

   先验路径不一样：拍点在播放前就算出来了，所以可以在拍点**之前**就升起来。
   三件事，各自独立、都能单独置 0 回退：
     · BEAT_PRE_ROLL    提前量（秒）—— 根治感知延迟（常量在 beatmap.ts）；
     · BEAT_FORM_*      每 4 拍（一小节）换一次柱体形态 —— 从"被动响应"到"编排"；
     · BEAT_PREHEAT_*   副歌到来前提前扩动态范围 —— 高潮段更有张力。
   ★ 先验只做"上限抬升"（与在线值取 max），不做替换：
     预分析失败 / 还没算完 / 用户关掉时这几项全为 0，观感与改动前逐位相同。 */
const BEAT_PREHEAT_EXPAND = 0.24; // 预热时以 0.5 为中心扩张多少（0 = 关闭）
const BEAT_PREHEAT_GAIN = 0.05; // 预热时的整体增益（0 = 关闭）
const BEAT_DOWNBEAT = 0.05; // 小节重音：每小节第一拍给低频段加多少（0 = 关闭）
/* 每小节换一次的形态表（4 种循环）：
   ① 柱顶尖峰幅度 ② 尖峰空间频率 ③ 行波空间频率。
   三者都控制在 ±30% 以内 —— 目的是"这一小节和上一小节不一样"，不是"画面在变形"。 */
const BEAT_FORM_TIP = [1.0, 1.3, 0.82, 1.12];
const BEAT_FORM_FREQ = [1.0, 1.22, 0.86, 1.08];
const BEAT_FORM_JIT = [1.0, 0.88, 1.15, 1.02];

/* ★ 顶端张力：14 级量化会把"小于一级（1/13≈0.077）"的抖动舍掉，于是越高的柱越"死" ——
   最高的几根常同落在一个级上，顶边成了平顶方块，看着"高耸但呆板、没张力"。
   做法：在量化**之后**给柱再补一层抖动（幅度随柱高自 TOP_MIX_FROM 起线性增强，
   矮柱不补、底噪区不会变毛刺），顶端因此重新带上参差的张力。置 0 即回到旧行为。
   · 幅度由 TOP_TENSION × TOP_TENSION_GAIN 决定，向下能落多深还受 advance() 里的 CEIL_DIP 限制；
   · 抖动**快慢**由 TOP_TENSION_RATE 决定（独立的快相位，与行波相位解耦）——
     目标是"低频率、大摆幅"：周期要够长（≥ 0.3 秒）才读得出"柱子砸下来又起来"，
     太快会退化成哆嗦，太慢则退化成缓慢漂移。 */
const TOP_TENSION = 0.45; // 顶端补抖强度（0 = 不补）
const TOP_TENSION_GAIN = 1.2; // 补抖幅度系数（越大顶端摆幅越大）
const TOP_MIX_FROM = 0.35; // 从这一柱高开始补抖（越低参与补抖的柱越多）
const TOP_TENSION_RATE = 0.22; // 补抖相位步进（弧度/tick）：越小周期越长、越像"大摆幅"而不是"哆嗦"
/* 量化前那层行波的余量下限：原式 headroom=(1-v)/0.45 在高柱上趋近 0，
   给一个下限让中高柱也抖起来（配合上面的量化后补抖）。 */
const JITTER_HEADROOM_MIN = 0.28;

/* ★ 顶端形态：用户要"不要方块，也不要连续曲线" —— 即顶端要**参差的尖峰**。
   方块来自 fillRect 的平顶；连续曲线来自把相邻柱连成一条线。
   这里改成：每根柱顶再叠加一段**小幅高频起伏的尖**（按柱序做确定性伪随机），
   顶边因此呈锯齿状；同时**不连接**相邻柱（各画各的竖条），避免变成曲线。 */
const TOP_SPIKE = 0.16; // 顶端尖峰幅度（相对柱高的比例）
const TOP_SPIKE_FREQ = 2.7; // 尖峰的空间频率（每根柱之间的相位步进，越大越密）

/* ★ 顶端高频抖动（2026-10-03，用户："可以加入高频抖动"）：
   TOP_TENSION 那一路是**低频率、大摆幅**（周期约 0.57 秒）——读起来是"柱子砸下来又起来"。
   用户要在这个"大落差"之上再叠一层**快的**，于是另起一路独立相位：
   周期 ≈ 2π / TOP_SHIMMER_RATE ≈ 3.1 tick ≈ 61ms（约 16Hz），在高柱顶端快速颤动。
   · 幅度必须够跨过量化级才看得见：显示侧是 14 级分桶绘制的，级距 1/13 ≈ 0.077，
     取 0.12 —— 顶端能跨 1~2 级，肉眼是"高频细颤"，又不会盖过慢摆幅的落差。
   · 两个正弦成分（1 : 1.6）叠加，避免单一正弦那种规律感；相邻 tick 的变化量也更大。
   · 只作用于高柱（与 TOP_TENSION 共用 topMix 权重），矮柱与底噪区不受影响。
   置 0 即关闭这一层。 */
const TOP_SHIMMER = 0.12; // 高频抖动幅度（0 = 关闭）
const TOP_SHIMMER_RATE = 2.05; // 相位步进（弧度/tick）
const TOP_SHIMMER_SPFREQ = 1.7; // 空间频率（相邻柱之间的相位步进，越大越"沸腾"）

/* ★ 音色灵敏度（2026-10-03，用户："对歌曲的音色要更加敏感"）：
   频谱的"形状"才是音色，而 1.3.0 的**全局 2.1 次幂**把中高频细电压得几乎看不见
   （v=0.4 → 0.4^2.1 ≈ 0.15），于是画面上只剩"低频厚、高频薄"一个轮廓，
   人声的泛音、镲的空气感、弦乐的共振峰全都糊掉了。两个手段，都只动**形状**、
   不动低频峰的高度（"高耸"仍然由低端的 2.1 次幂保证）：
     · 频率相关幂次：低端保持 2.1，高端降到 TIMBRE_EXP_TREBLE；
     · 谱锐化：拿掉一部分邻域均值，让共振峰与谷更分明（作用在对数压缩后的 120 段上）。
   回退：TIMBRE_EXP_TREBLE = 2.1 且 TIMBRE_SHARPEN = 0 即回到 1.3.0 的观感。 */
const TIMBRE_EXP_BASS = 2.1; // 低频端幂次（= 1.3.0 原值，别动）
const TIMBRE_EXP_TREBLE = 1.45; // 高频端幂次（越小，中高频细节越显）
const TIMBRE_EXP_FROM = 0.22; // 从这一归一化频率起向高频端过渡
const TIMBRE_SHARPEN = 0.55; // 谱锐化强度（0 = 关闭）

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
  /* 显示用：上一次分析时的柱高（prevBars）与"两次分析之间插值出来的"绘制值（display）。
     意义见 render()：分析 20ms 一 tick，而画布 60fps 重画，两者不做插值就会错拍发卡。 */
  private prevBars = new Float32Array(BAR_N);
  private display = new Float32Array(BAR_N);
  private lastAdvanceAt = 0;
  private advanceIntervalMs = 20;
  /* 按量化级分桶用的容器（每帧复用，避免每帧新建数组） */
  private buckets: number[][] = Array.from({ length: VIZ_LEVELS }, () => []);
  private jitterPhase = 0;
  /* 顶端张力的独立快相位：与 jitterPhase 分开，保证补抖在相邻帧之间真的变化
     （用慢的行波相位补抖会退化成"缓慢漂移"而不是抖动）。 */
  private topPhase = 0;
  /* 顶端高频抖动的相位（见 TOP_SHIMMER）：比 topPhase 快约 9 倍，专门做"细颤"那一层 */
  private shimmerPhase = 0;
  /* 谱锐化用的中间缓冲（每 tick 复用，不产生垃圾） */
  private tmpFreq = new Float32Array(SPECTRUM_BANDS);
  private kickEnergy = 0;
  private kickRef = 0;
  /* 瞬态（谱通量）检测的状态：上一 tick 的原始幅度、本 tick 的正向增量、通量参考电平 */
  private prevBands = new Float32Array(SPECTRUM_BANDS);
  private fluxDelta = new Float32Array(SPECTRUM_BANDS);
  private transientRef = 0;
  /* ★ 上一帧的原始峰值（用于通量归一化，见 analyze 里 flux 的说明）。
     降窗到 512 后低频泄漏减少、低频 mags 相对下降，本帧峰值 mx 更容易被**宽频敲击**
     独占抬高 —— 用 mx 做分母会把"这一敲带来的通量"按敲击自己的峰值缩掉，门因此关死。
     改用**上一帧**的峰值（敲击前的稳定参考）做分母，通量就能如实反映"这一敲有多突然"。 */
  private prevMx = 0;
  private transientOn = 0; // 本次敲击的强度（0~1）
  private grad: CanvasGradient | null = null;
  private gradKey = "";
  private mode: SpectrumMode = "mix";
  /* ---- 节拍先验的状态（见 BEAT_FORM_* 的注释） ---- */
  private beat: BeatMap | null = null;
  private playhead = -1; // 当前播放位置（秒）；< 0 = 未知（没播 / 探针模式）
  private bLive = 0; // 这一 tick 先验是否可用（1/0，避免每帧读 null）
  private bkick = 0; // 预测鼓点（含提前量）
  private bform = 0; // 形态编号 0~3（每小节变一次）
  private bInBar = 0; // 拍在小节里的位置 0~3
  private bPhase = 0; // 拍内相位 0~1
  private bPreheat = 0; // 副歌预热 0~1
  private bEnergy = 0; // 先验低频能量 0~1
  /* 形态 → 绘制参数的两个派生值（每 tick 算一次，绘制里只读） */
  private formTip = 1;
  private spikeFreq = TOP_SPIKE_FREQ;
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
  /** 装一份离线预分析出来的"乐谱"（换曲时调）。传 null 表示没有（退回在线模式）。 */
  setBeatmap(bm: BeatMap | null) {
    this.beat = bm && bm.v === BEAT_VERSION ? bm : null;
    this.bLive = 0;
    this.bkick = 0;
    this.bPreheat = 0;
    this.bform = 0;
    this.formTip = 1;
    this.spikeFreq = TOP_SPIKE_FREQ;
  }
  /** 当前播放位置（秒）。每个分析 tick 喂一次（player.ts 两侧都喂：定时器与 worker 回包）。 */
  setPlayhead(t: number) {
    this.playhead = Number.isFinite(t) && t >= 0 ? t : -1;
  }
  /** 每个分析 tick 调一次：把先验算成这一 tick 的几个量（见 advance）。 */
  private applyBeatPrior() {
    if (!this.beat || this.playhead < 0) {
      this.bLive = 0;
      this.bkick = 0;
      this.bPreheat = 0;
      this.bEnergy = 0;
      this.bInBar = 0;
      this.bPhase = 0;
      this.formTip = 1;
      this.spikeFreq = TOP_SPIKE_FREQ;
      return;
    }
    const s = sampleBeatMap(this.beat, this.playhead);
    this.bLive = 1;
    this.bkick = s.kick;
    this.bform = s.form;
    this.bInBar = s.inBar;
    this.bPhase = s.phase;
    this.bPreheat = s.preheat;
    this.bEnergy = s.energy;
    this.formTip = BEAT_FORM_TIP[s.form] ?? 1;
    this.spikeFreq = TOP_SPIKE_FREQ * (BEAT_FORM_FREQ[s.form] ?? 1);
    /* ★ 提前点亮就这一行：在线那一路是因果的（最快也要等一个分析窗），
       先验这路在拍点**之前** BEAT_PRE_ROLL 就开始升。取 max 而不是替换 ——
       先验错了（歌没算准 / 播放头对不上）时在线那一路仍然兜得住。 */
    if (this.bkick > this.kickEnergy) this.kickEnergy = this.bkick;
  }
  /** 供播放条刻度取样（1.3.0 里也是直接读柱高数组） */
  get levels() {
    return this.bars;
  }
  /** 分析节拍（毫秒）：告诉绘制侧"相邻两次分析之间插多久"，让插值跨度与实际节拍一致。
      由 player.ts 用 `VIZ_ANALYSIS_MS` 调一次即可。 */
  setAdvanceInterval(ms: number) {
    if (isFinite(ms) && ms > 0) this.advanceIntervalMs = ms;
  }
  /** 诊断用：归一化后的频段 + 柱高快照 + 本次敲击强度 */
  snapshot() {
    return {
      freq: Array.from(this.freq),
      bars: Array.from(this.bars),
      /* 峰值线（指示线）：回落观测要单独量它 ——
         "回落干脆不干脆"的拖尾主要出在这条线上，见 PEAK_DECAY 的说明。 */
      peaks: Array.from(this.peaks),
      show: Array.from(this.display),
      transient: this.transientOn,
      /* 节拍先验的即时量（诊断 / 回归用）：
         live=0 表示"这一 tick 没有乐谱"，此时下面几个必须全为 0 ——
         回归脚本靠这条断言"关掉预分析时观感与改动前逐位相同"。 */
      beat: {
        live: this.bLive,
        bpm: this.beat ? Math.round(this.beat.bpm * 10) / 10 : 0,
        kick: Math.round(this.bkick * 1000) / 1000,
        form: this.bform,
        preheat: Math.round(this.bPreheat * 1000) / 1000,
        energy: Math.round(this.bEnergy * 1000) / 1000,
      },
    };
  }
  /* 诊断摘要用的固定对象：诊断每帧都要读，不能每帧新建（60fps 下的垃圾量不小） */
  private beatDiag = { live: 0, bpm: 0, beats: 0, kick: 0, form: 0, preheat: 0, energy: 0 };
  /** 节拍先验的诊断摘要（几个数而已，供探针每帧核对） */
  beatInfo() {
    const d = this.beatDiag;
    d.live = this.bLive;
    d.bpm = this.beat ? Math.round(this.beat.bpm * 10) / 10 : 0;
    d.beats = this.beat ? this.beat.beats.length : 0;
    d.kick = Math.round(this.bkick * 1000) / 1000;
    d.form = this.bform;
    d.preheat = Math.round(this.bPreheat * 1000) / 1000;
    d.energy = Math.round(this.bEnergy * 1000) / 1000;
    return d;
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
    /* 插值的两端一起清掉：否则屏幕上的旧柱高会"滑"到 0（那是另一首曲子的形状） */
    this.prevBars.fill(0);
    this.display.fill(0);
    this.kickRef = 0;
    this.kickEnergy = 0;
    this.prevBands.fill(0);
    this.fluxDelta.fill(0);
    this.transientRef = 0;
    this.prevMx = 0;
    this.transientOn = 0;
    this.shimmerPhase = 0;
    /* 先验的量一并清掉：换曲时"上一首的拍点"不该再推着这一首的低频走。
       注意这里**不清** this.beat —— 乐谱由 player 在装好音源后重设，
       清了反而会在"同一首重播"时白丢一份已经算好的先验。 */
    this.bLive = 0;
    this.bkick = 0;
    this.bPreheat = 0;
    this.bInBar = 0;
    this.bPhase = 0;
    this.formTip = 1;
    this.spikeFreq = TOP_SPIKE_FREQ;
  }

  /* ---------- 分析：Hann 加窗 + Goertzel ---------- */
  /** 加窗后的时域缓冲（每 tick 只算一次）。
      ★ 原来 `td[i]*HANN[i]` 写在每个频段的内层循环里 —— 120 个频段 × 窗长
      等于同一件事被算了 12 万次，还多读 12 万次 HANN 数组。乘积顺序不变，
      所以结果逐位相同（只是不再重复算）。 */
  private windowed = new Float32Array(ANALYSIS_WINDOW);
  private goertzelBin(k: number, n: number) {
    const co = 2 * Math.cos((2 * Math.PI * k) / n);
    const tw = this.windowed;
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const s0 = tw[i] + co * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    // 1.3.0 的归一化就是 N/4（N = 分析窗长，现为 512）
    return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - co * s1 * s2)) / (n / 4);
  }
  private analyze(td: Float32Array) {
    const n = analysisWindow(td);
    const from = td.length - n;
    if (this.windowed.length < n) this.windowed = new Float32Array(n);
    for (let i = 0; i < n; i++) this.windowed[i] = td[from + i] * HANN[i];
    let mx = 1e-9;
    for (let b = 0; b < SPECTRUM_BANDS; b++) {
      let mag = this.goertzelBin(this.bandK[b], n);
      if (!isFinite(mag)) mag = 0;
      this.bands[b] = mag;
      if (mag > mx) mx = mag;
    }
    // 对数压缩 + 本帧峰值归一（1.3.0 同款）
    for (let b = 0; b < SPECTRUM_BANDS; b++) {
      this.freq[b] = Math.log10(1 + 100 * Math.min(1, this.bands[b] / mx)) / LOG101;
    }
    /* ★ 瞬态强调：算谱通量（各频段相对上一 tick 的正向增量），
       把这次敲击的能量按**频段份额**加回柱高 —— 底鼓抬低频、军鼓抬中频、踩镲抬高频，
       敲击的频谱形状因此能看出来（只抬受影响的那些频段，不是整排一起亮）。
       门控是必要的：持续段也有微小通量，不门控会让整幅频谱一直发亮。 */
    let fluxSum = 0;
    for (let b = TRANSIENT_FROM; b < SPECTRUM_BANDS; b++) {
      const dBand = this.bands[b] - this.prevBands[b];
      const pos = dBand > 0 ? dBand : 0;
      this.fluxDelta[b] = pos;
      this.prevBands[b] = this.bands[b];
      fluxSum += pos;
    }
    /* 分母取"敲击前的稳定峰值"：首帧 prevMx 还是 0（resetPeaks 清过），
       此时退回本帧峰值 mx，否则除出天文数字、把 transientRef 顶到天上再也下不来。 */
    const refMx = this.prevMx > 0 ? this.prevMx : mx;
    const flux = fluxSum / Math.max(refMx, 1e-9); // 与音量无关，且不被这一敲自己的峰值缩掉
    this.prevMx = mx;
    if (this.transientRef <= 0) this.transientRef = flux;
    const trise = (flux - this.transientRef) / Math.max(this.transientRef, 1e-6);
    const onset = Math.max(0, Math.min(1, (trise - TRANSIENT_FLOOR) * TRANSIENT_GAIN));
    this.transientOn = onset;
    const trRef = flux > this.transientRef ? TRANSIENT_REF_ATTACK : TRANSIENT_REF_RELEASE;
    this.transientRef += (flux - this.transientRef) * trRef;
    if (onset > 0 && fluxSum > 0) {
      /* 份额归一：通量集中在 TRANS_BANDS_REF 根上时，那几根加满 TRANSIENT_BOOST；
         铺得越开（宽带噪声型敲击）每根加得越少 —— 这正是"冲击的宽窄"。 */
      const k = (TRANSIENT_BOOST * onset * TRANSIENT_BANDS_REF) / fluxSum;
      for (let b = TRANSIENT_FROM; b < SPECTRUM_BANDS; b++) {
        const pos = this.fluxDelta[b];
        if (pos <= 0) continue;
        this.freq[b] = Math.min(1, this.freq[b] + pos * k);
      }
    }
    // 鼓点：用【未归一化】的低频原始幅度做 onset（归一化后的低频恒等于 1，取差分永远为 0）
    /* 段位照 1.3.0：第 2–16 带共 15 段；参考电平用不对称跟随 + 低阈值，
       密集的 8 分 / 16 分鼓点也能各自触发到接近满值。 */
    let low = 0;
    for (let b = KICK_BAND_FROM; b <= KICK_BAND_TO; b++) low += this.bands[b];
    low /= KICK_BAND_N;
    if (this.kickRef <= 0) this.kickRef = low;
    const rise = (low - this.kickRef) / Math.max(this.kickRef, 1e-6);
    const kick = Math.max(0, Math.min(1, (rise - KICK_RISE_FLOOR) * KICK_RISE_GAIN));
    const kRef = low > this.kickRef ? KICK_REF_ATTACK : KICK_REF_RELEASE;
    this.kickRef += (low - this.kickRef) * kRef;
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

  /* ---------- 音色灵敏度：谱锐化（见 TIMBRE_SHARPEN 的说明） ----------
     对数压缩后的 120 段里，"音色"就藏在相邻段的相对高低里：共振峰是局部凸起、
     谐波间隙是局部凹陷。这里把每段相对"三点平滑值"的偏离放大一点：
       f' = f + K·(f − (f₋₁ + 2f + f₊₁)/4)
     凸起更凸、凹陷更凹 → 峰谷更分明，音色差异因此更容易分辨。
     ★ 只作用于 120 个分析频段（不含 freq[SPECTRUM_BANDS] 那个 kick 值），
     并且每 tick 都从"本 tick 新算出来的值"重算，不会跨帧累积。
     ★ 放在 advance() 开头调用，于是**同步路径与 worker 路径共用这一层** ——
     不用再去 player.ts 的 worker 源码模板里复刻一遍（少一处漂移风险）。 */
  private enhanceTimbre() {
    if (TIMBRE_SHARPEN <= 0) return;
    const f = this.freq;
    const s = this.tmpFreq;
    const B = SPECTRUM_BANDS;
    for (let b = 0; b < B; b++) s[b] = f[b];
    for (let b = 0; b < B; b++) {
      const a = s[b > 0 ? b - 1 : 0];
      const c = s[b < B - 1 ? b + 1 : B - 1];
      const sm = (a + 2 * s[b] + c) * 0.25;
      const v = s[b] + (s[b] - sm) * TIMBRE_SHARPEN;
      f[b] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }

  /* ---------- 柱高流水线（★ 逐行照 1.3.0，不做任何平滑/降噪/调优） ---------- */
  private advance() {
    const n = BAR_N;
    /* ★ 音色灵敏度：先对 120 个分析频段做谱锐化（见 enhanceTimbre）——
       放在这里，同步路径与 worker 路径就都走到了，不用改 player.ts 里的 worker 模板。 */
    this.enhanceTimbre();
    /* ★ 节拍先验：必须在读 kickEnergy 之前算（它会把 kickEnergy 抬到提前量上）。 */
    this.applyBeatPrior();
    const preheat = this.bPreheat;
    /* ★ 小节重音：只在"先验可用"时才算 —— 否则 bInBar/bPhase 恒为 0，
       会把"没有乐谱"误读成"每时每刻都是小节头"，低频被无脑加 5%。 */
    const downbeat =
      this.bLive && this.bInBar === 0 && this.bPhase < 0.35
        ? 1 - this.bPhase / 0.35
        : 0;
    const formJit = this.bLive ? BEAT_FORM_JIT[this.bform] ?? 1 : 1;
    const tilt = (50 - vizParams.tilt) / 50;
    const bars = this.bars;
    /* 插值的起点：这一 tick 之前屏幕上是多少（见 render() 的说明） */
    this.prevBars.set(bars);
    for (let i = 0; i < n; i++) {
      let v = this.sampleBand(i, n);
      v *= Math.pow(5, tilt * (1 - i / n)); // 倾斜补偿（低频端最高 5×）
      /* ★ 幂次改成**频率相关**（见 TIMBRE_EXP_* 的说明）：低端 2.1（高耸感来自它），
         高端降到 TIMBRE_EXP_TREBLE，让泛音 / 齿音 / 空气感显形。
         两个值相等时与 1.3.0 的全局 2.1 次幂逐位相同。 */
      const tw = Math.max(0, Math.min(1, (i / n - TIMBRE_EXP_FROM) / (1 - TIMBRE_EXP_FROM)));
      const pexp = TIMBRE_EXP_BASS - (TIMBRE_EXP_BASS - TIMBRE_EXP_TREBLE) * tw;
      v = Math.pow(Math.min(1, v), pexp); // 幂次曲线：拉大高低差
      /* ★ 副歌预热（先验）："接下来 2.5 秒明显更响"时提前把动态范围撑开 ——
         以 0.5 为中心做扩张（高的更高、低的更低）＋ 一点整体增益。
         画面张力比声音早到位，高潮进来时就不会显得"突然一下"。 */
      if (preheat > 0) {
        v = 0.5 + (v - 0.5) * (1 + BEAT_PREHEAT_EXPAND * preheat);
        v *= 1 + BEAT_PREHEAT_GAIN * preheat;
        if (v < 0) v = 0;
        else if (v > 1) v = 1;
      }
      // 鼓点用【乘法泵动】：加法会把十几根一起顶过 1.0 钳住，量化后顶端变成平直方块
      const pumpW = Math.exp(-Math.pow((i / n - 0.07) / 0.1, 2));
      v *= 1 - pumpW * vizParams.kickPump * (1 - this.kickEnergy);
      v += this.kickEnergy * 0.06 * pumpW;
      /* ★ 小节重音：每小节第一拍的前 35% 给低频段一点额外推力。
         这是"编排"最直观的一处 —— 画面在小节头上有个明确的重音，
         而不是全程匀速起伏（没有乐谱时它恒为 0，观感不变）。 */
      if (downbeat > 0 && i / n < 0.25) v *= 1 + BEAT_DOWNBEAT * downbeat;
      // 抖动：正弦行波（空间频率 JITTER_FREQ、相位每拍 +JITTER_STEP），
      // 向上幅度按剩余余量缩放（★但给了下限 JITTER_HEADROOM_MIN，见常量说明）。
      // ★ 空间频率乘 formJit：每小节换一次抖动纹理（BEAT_FORM_JIT）。
      const ph = i * jitterFreq() * formJit * Math.PI * 2 + this.jitterPhase;
      const headroom = Math.max(
        JITTER_HEADROOM_MIN,
        Math.max(0, Math.min(1, (1 - v) / 0.45))
      );
      v *= 1 + Math.sin(ph) * jitterAmp() * headroom;
      v = Math.max(0.02, Math.min(1, v));
      /* ★ 量化（14 级）会把"小于一级"的抖动四舍五入掉 —— 一级 = 1/13 ≈ 0.077，
         所以 v 越接近 1、抖动越看不见，几根相邻柱同落在一个级上就成了平顶方块。
         这里在量化**之后**再补一层"越顶端越明显"的抖动（见 TOP_TENSION 常量）。 */
      v = Math.round(v * (VIZ_LEVELS - 1)) / (VIZ_LEVELS - 1); // 14 级量化（阶梯感）
      // 量化后补一层"单边向下"的颤动：满高条的顶端不会看着是死的
      v *= 1 - jitterWobble() * (0.5 - 0.5 * Math.sin(ph));
      // 一阶跟随（系数随频率放缓）——老式的乘法自衰减会让尾巴拖得很长
      const atk = 0.7 - 0.2 * (i / n);
      const rel = 0.58 + 0.22 * (i / n);
      bars[i] = v > bars[i] ? bars[i] + (v - bars[i]) * atk : bars[i] + (v - bars[i]) * rel;
      /* ★ 顶端张力叠在**一阶跟随之后**：直接作用在屏幕柱高上，不会被跟随器平滑掉。
         相位用独立的快相位 topPhase（TOP_TENSION_RATE 弧度/tick），保证相邻帧真的在变。 */
      const topMix = Math.max(0, (bars[i] - TOP_MIX_FROM) / (1 - TOP_MIX_FROM));
      if (topMix > 0) {
        const qp = i * TOP_SPIKE_FREQ * Math.PI * 2 + this.topPhase;
        /* 目标不是把柱子推满，而是让它在上沿**大幅上落**。两个钳位配合：
             · CEIL_TOP：抖动后允许到达的最高值。压在 0.97（而非 1.00），
               高柱就不会"一直顶满"；真正要顶满的鼓点由 kick 泵动那一路去顶。
             · CEIL_DIP：向下最多落多深。这是"落差"的物理上限 ——
               设小了（如 0.12）顶端只会微颤，设大了才砸得下来。
             两侧都按实际余量收缩，所以矮柱不会被误伤。 */
        const CEIL_TOP = 0.97; // 抖动后允许到达的最高值
        const CEIL_DIP = 0.45; // 向下最多落这么深（决定"落差"上限）
        const qBipolar = Math.sin(qp) * 0.55 + Math.sin(qp * 2.7 + 1.1) * 0.45;
        const amp = TOP_TENSION * TOP_TENSION_GAIN * topMix;
        const upRoom = Math.max(0, CEIL_TOP - bars[i]);
        const downRoom = Math.max(0, Math.min(CEIL_DIP, bars[i] - 0.02));
        const d = qBipolar >= 0
          ? Math.min(qBipolar * amp, upRoom)
          : Math.max(qBipolar * amp, -downRoom);
        bars[i] = Math.max(0.02, Math.min(1, bars[i] + d));
        /* ★ 高频抖动（用户："可以加入高频抖动"）：叠在慢摆幅之上的另一路快相位。
           慢的那路负责"砸下来又起来"的大落差，这一路负责顶端持续细颤 ——
           两者周期差约 9 倍，合起来就是"大幅度 + 高频"的抖动。
           信号是两个正弦的混合（1 : 1.6），两个周期不成整数倍，颤动不会显出规律。 */
        if (TOP_SHIMMER > 0) {
          const sp = i * TOP_SHIMMER_SPFREQ * Math.PI * 2 + this.shimmerPhase;
          const sh = Math.sin(sp) * 0.62 + Math.sin(sp * 1.6 + 0.7) * 0.38;
          bars[i] = Math.max(0.02, Math.min(1, bars[i] + sh * TOP_SHIMMER * topMix));
        }
      }
      // 峰值线按分析节拍衰减：放渲染循环里会随帧率变化（系数见 PEAK_DECAY 的说明）
      this.peaks[i] = Math.max(this.peaks[i] * PEAK_DECAY, bars[i]);
    }
    this.jitterPhase += jitterStep();
    this.topPhase += TOP_TENSION_RATE;
    this.shimmerPhase += TOP_SHIMMER_RATE;
    this.lastAdvanceAt = performance.now();
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
  /* ★ 顶端尖峰：给每根柱顶叠一段**确定性的**小幅起伏，让顶边呈锯齿状。
     为什么不靠"随机"：随机会让同一帧重画两次都不一样（60fps 下看着像噪点在跳），
     这里用柱序的相位做伪随机，**同一根柱的尖峰形状是稳定的**，只有柱高在动。
     为什么不做成曲线：这里只画"每根柱自己的一小段竖条"（各画各的、不连线），
     所以既不会有 fillRect 的平顶方块，也不会连成一条平滑曲线。 */
  private topSpike(i: number) {
    /* ★ 用 spikeFreq 而不是写死的 TOP_SPIKE_FREQ：有乐谱时它每小节换一次
       （BEAT_FORM_FREQ），锯齿的疏密随小节变化；没有乐谱时恒等于原值。 */
    const f = this.spikeFreq;
    return Math.sin(i * f) * 0.6 + Math.sin(i * f * 1.7 + 1.3) * 0.4;
  }
  private drawBars(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const gap = w / BAR_N;
    const bw = Math.max(1, gap * 0.7);
    const grad = this.makeGrad(ctx, h);
    const values = this.display;
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
        const i = list[n];
        const x = i * gap + (gap - bw) / 2;
        ctx.fillRect(x, h - bh, bw, bh);
      }
    }
    /* ★ 顶端尖峰层：在每根柱顶再补一小段竖条，高度 = 柱高 × 尖峰幅度 × 确定性伪随机。
       只对"有实际高度"的柱画（矮柱不画，免得底噪区变成一排毛刺）。
       这一层用同一 fillStyle，只改 globalAlpha —— 与上面按级分桶同样的省状态切换做法。 */
    if (TOP_SPIKE > 0) {
      ctx.globalAlpha = 0.78;
      const maxBody = h - 8;
      for (let i = 0; i < BAR_N; i++) {
        const v = values[i];
        if (v < 0.12) continue; // 太矮的柱不加尖，避免底部尽是碎刺
        const bodyH = v * maxBody;
        // ★ formTip：尖峰幅度每小节换一次（BEAT_FORM_TIP）
        const tip = Math.max(1, bodyH * TOP_SPIKE * this.formTip * (0.5 + 0.5 * this.topSpike(i)));
        const x = i * gap + (gap - bw) / 2;
        ctx.fillRect(x, h - bodyH - tip, bw, tip);
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
    const values = this.display;
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
      // 顶端尖峰层：与 drawBars 同一套（见那边的说明）
      if (TOP_SPIKE > 0 && v >= 0.12) {
        const tip = Math.max(1, bh * TOP_SPIKE * this.formTip * (0.5 + 0.5 * this.topSpike(i)));
        ctx.globalAlpha = 0.78;
        ctx.fillRect(x, h - bh - tip, bw, tip);
      }
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x, h - Math.max(2, this.peaks[i] * (h - 8)) - 3, bw, 2);
    }
    ctx.globalAlpha = 1;
  }
  private drawRing(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const cx = w / 2;
    const cy = h / 2;
    const base = Math.min(w, h) * 0.28;
    const values = this.display;
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
    const values = this.display;
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

  /** 渲染节拍：把柱高画出来。
      ★ 绘制用的是**相邻两次分析之间的插值**（`display`），不是刚算出来的 `bars`：
      分析是 20ms 一 tick（1.3.0 的 50Hz），而画布是 60fps 重画 ——
      两个节拍不成整数倍时，屏幕上会出现"有时隔一帧才动、有时隔两帧才动"的错拍，
      看起来就是**卡**（用户："怎么还更卡"）。插值后每一帧都在变，60fps 显示器上就是平滑的，
      而柱高数值本身仍是 1.3.0 流水线的输出（诊断与播放条读的还是 `levels` / `bars`）。 */
  render(_dt: number) {
    const span = this.advanceIntervalMs;
    const elapsed = span > 0 ? Math.min(1, (performance.now() - this.lastAdvanceAt) / span) : 1;
    /* ★ 上升 / 下降用不同的插值进度（用户 2026-10-04："频谱的回落还是不够干脆"）。
       柱体本体的回落已经很脆（一个 tick 掉 60%），但这段"上一个 tick → 这个 tick"的
       线性插值会把这一整段落**摊满 20ms** —— 屏幕上看到的就是一条平滑的斜坡，
       把"一步砸下来"读成了"慢慢滑下来"。
       所以让**下降**用更短的有效跨度（FALL_INTERP_SPAN 的比例）：同样 20ms 内，
       下落量在更早的时刻就到位，触底更利落；**上升**仍走满跨度，保持起势的顺滑。
       两条路径的柱高数值都没变，只改"什么时候把它画出来"。 */
    const up = elapsed;
    const down = Math.min(1, elapsed / FALL_INTERP_SPAN);
    const prev = this.prevBars;
    const disp = this.display;
    const cur = this.bars;
    for (let i = 0; i < BAR_N; i++) {
      const from = prev[i];
      const to = cur[i];
      disp[i] = from + (to - from) * (to >= from ? up : down);
    }
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
      /* 与 PEAK_DECAY 同一套口径：峰值线在停播时也照着 0.90 收，
         别再用另一个 0.94 —— 两处不一致会让"停播后残留多久"变得没法预期。 */
      this.peaks[i] *= PEAK_DECAY;
      if (this.bars[i] > 0.01) live = true;
    }
    this.kickEnergy = 0;
    return live;
  }
}
