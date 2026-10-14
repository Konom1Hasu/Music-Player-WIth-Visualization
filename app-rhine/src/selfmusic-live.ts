/* selfmusic-live.ts —— SelfMusic 频谱活路径驱动：把"整曲 PCM + 播放位置"变成逐帧柱高。
 *
 * 逐行照 musicapp/widgets/mainwindow.py 的 `_refresh_viz`（2026-10-13 版）：
 *   ① 平滑时钟：QMediaPlayer.position() 实测每 ~52ms 才跳一次，直接拿它取窗会
 *      "几帧重复同一段、再跨掉一段"→ 画面顿。所以内部位置按**真实流逝时间**连续
 *      推进（每帧最多 +0.10s），播放器位置只做慢速回正（>60ms 硬回正，否则每帧
 *      补 5% 的差）；起播 / 拖动 / 切歌（差 > 250ms）时硬对齐。
 *   ② 每帧把**真实帧间隔**告诉分析器（`set_tick_ms`，钳在 8~60ms；dt≤0 时用 16.7）。
 *      它内部那些"每帧衰减一次"的系数按 20ms 节奏标定，按真实间隔折算后，
 *      手感与原版一致（切歌、卡顿时也自动跟上）。
 *   ③ 取窗 = `pcm.mono_window(viz_ms, fft_size)` = **[viz_ms, viz_ms+4096)**，
 *      越界补零（前视窗：窗口从"当前播放位置"开始）。
 *   ④ `analyze(win)` 出 heights + peaks。
 *
 * 本类不碰 DOM / 音频元素：调用方每帧喂 (posMs, dtMs)，读 lastHeights / lastPeaks。
 * 这样同一份驱动既能接进播放器，也能被离线探针原样搬去和 Python 活模拟对拍
 * （见 scripts/探针/_活路径对拍.*）——"验证的就是真实在跑的那段代码"。
 */
import { SelfSpectrumEngine } from "./selfmusic-spectrum";

export class SelfMusicLiveDriver {
  readonly engine: SelfSpectrumEngine;
  /** 最近一帧的引擎输出（引用；下一次 frame() 前有效）。96 段，0..1。 */
  lastHeights: Float32Array | null = null;
  lastPeaks: Float32Array | null = null;
  /** 四路音色活跃度（鼓 / 低音 / 人声 / 镲，照 selfmusic.py 的 last_timbre）；无帧时全 0 */
  lastGauges: { kick: number; bass: number; vocal: number; cymbal: number } = {
    kick: 0, bass: 0, vocal: 0, cymbal: 0,
  };

  private pcm: Float32Array = new Float32Array(0);
  private rate = 48000;
  private vizMs = 0;
  private synced = false;
  private win: Float32Array;

  constructor(engine: SelfSpectrumEngine, fftSize = 4096) {
    this.engine = engine;
    this.win = new Float32Array(Math.max(64, Math.floor(fftSize)));
  }

  /** 换曲：装 PCM + 采样率（分析器按原生率重建频段表），状态归零、下帧硬同步。 */
  setPcm(pcm: Float32Array, rate: number) {
    this.pcm = pcm;
    this.rate = rate > 0 ? rate : 48000;
    this.engine.setSampleRate(this.rate);
    this.engine.reset();
    this.vizMs = 0;
    this.synced = false;
    this.lastHeights = null;
    this.lastPeaks = null;
    this.lastGauges.kick = 0;
    this.lastGauges.bass = 0;
    this.lastGauges.vocal = 0;
    this.lastGauges.cymbal = 0;
  }

  /** 当前平滑时钟位置（ms）——诊断/探针用 */
  get positionMs(): number {
    return this.vizMs;
  }

  /**
   * 一帧（照 mainwindow._refresh_viz）：
   * @param posMs 播放器位置（audio.currentTime×1000）
   * @param dtMs  距上一帧的**真实**毫秒数（QElapsedTimer 等价物：performance.now 差）
   */
  frame(posMs: number, dtMs: number): void {
    /* ① 平滑时钟：内部位置按真实时间连续推进 + 慢速回正 + 大跳硬对齐 */
    const target = posMs;
    if (!this.synced || Math.abs(target - this.vizMs) > 250.0) {
      this.vizMs = target; // 起播 / 拖动进度 / 切歌：硬对齐
      this.synced = true;
    } else {
      this.vizMs += Math.max(0.0, Math.min(dtMs / 1000.0, 0.1)) * 1000.0;
      const gap = target - this.vizMs;
      if (Math.abs(gap) > 60.0) this.vizMs = target; // 漂移过大（丢帧/缓冲）：回正
      else this.vizMs += 0.05 * gap;                 // 慢速回正，保持连续
    }
    /* ② 真实帧间隔 → 分析器（8~60ms 钳制；照 mainwindow 的调用方式） */
    this.engine.setTickMs(dtMs > 0 ? Math.max(8.0, Math.min(60.0, dtMs)) : 16.7);
    /* ③ 取窗：[vizMs, vizMs+fft)，越界补零（mono_window 语义） */
    const win = this.win;
    const N = win.length;
    const src = this.pcm;
    const total = src.length;
    const start = Math.max(0, Math.floor((this.vizMs * this.rate) / 1000.0));
    const end = Math.min(total, start + N);
    let i = 0;
    for (; start + i < end; i++) win[i] = src[start + i];
    for (; i < N; i++) win[i] = 0;
    /* ④ 分析 */
    const eng = this.engine;
    eng.push(win);
    this.lastHeights = eng.compute();
    this.lastPeaks = eng.lastPeaks;
    /* ⑤ 四路音色活跃度快照（照 mainwindow 把 last_timbre 交给 set_levels） */
    const lt = eng.lastTimbre;
    const g = this.lastGauges;
    g.kick = lt.kick;
    g.bass = lt.bass;
    g.vocal = lt.vocal;
    g.cymbal = lt.cymbal;
  }
}
