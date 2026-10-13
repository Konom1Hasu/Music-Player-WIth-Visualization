/* selfmusic-pcm.ts —— SelfMusic 频谱活路径的**数据源**：把音频字节解成单声道 PCM。
 *
 * 为什么需要整曲 PCM（而不是旧路径那样直接拿 AnalyserNode 的"最近一窗"）：
 *   SelfMusic 的频谱窗口不是"流式最新样本"，而是**按播放位置取窗**——
 *   `win = pcm.mono_window(viz_ms, 4096)`（musicapp/widgets/mainwindow.py），
 *   窗 = [当前位置, 当前位置+4096)（约 85~93ms 的**前视窗**，越界补零）。
 *   要对齐出同一根波形，必须能读到"任意位置的整段样本"——只有整曲解码才做得到。
 *
 * 解码语义照 SelfMusic 的 PcmTrack / mono_window（decoder.py）：
 *   · 单声道混音：立体声 = (L+R)/2 —— 注意是**先在 int16 域量化、再平均**
 *     （miniaudio 解出来就是 int16；平均可能得到半个 LSB，保留）；
 *   · 数值 = int16 / 32768（除以 2 的幂 → 二进制精确）；
 *   · 单声道文件 = 原样量化。
 *
 * 采样率：优先用**文件原生采样率**。SelfMusic 用 pcm.sample_rate 驱动分析器
 *   （频段边界 = 20Hz..0.45·Nyquist、bin 映射、窗口时长都随它变），所以本播放器
 *   也必须按原生率分析。WebAudio 的 decodeAudioData 只会重采样到**目标上下文的
 *   采样率**——把 OfflineAudioContext 的采样率设成原生率，解码即走无重采样路径。
 *   原生率靠头部解析（mp3/flac/wav/m4a/ogg），解析不出来退回调用方给的采样率。
 */

/* ---------- 采样率头部解析 ---------- */

function tag(b: Uint8Array, off: number, s: string): boolean {
  if (off + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[off + i] !== s.charCodeAt(i)) return false;
  return true;
}

function u32le(b: Uint8Array, off: number): number {
  return (b[off] | (b[off + 1] << 8) | (b[off + 2] << 16) | (b[off + 3] << 24)) >>> 0;
}

/** ID3v2 头总长度（含头、不含 footer 判定误差容忍）；不是 ID3 返回 0 */
function id3v2Size(b: Uint8Array): number {
  if (!(b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33)) return 0;
  if (b.length < 10) return 0;
  const size = (b[6] << 21) | (b[7] << 14) | (b[8] << 7) | b[9];
  const footer = (b[5] & 0x10) !== 0 ? 10 : 0;
  return 10 + size + footer;
}

function parseWav(b: Uint8Array): number | null {
  if (!tag(b, 0, "RIFF") || !tag(b, 8, "WAVE")) return null;
  let off = 12;
  while (off + 8 <= b.length) {
    const size = u32le(b, off + 4);
    if (tag(b, off, "fmt ")) {
      if (off + 8 + 8 > b.length) return null;
      const rate = u32le(b, off + 8 + 4);
      return rate >= 8000 && rate <= 768000 ? rate : null;
    }
    off += 8 + size + (size & 1);
  }
  return null;
}

function parseFlac(b: Uint8Array, from: number): number | null {
  if (!tag(b, from, "fLaC")) return null;
  // 之后第一个 metadata block 必须是 STREAMINFO（type 0）
  const d = from + 8; // 4B "fLaC" + 4B block header
  if (d + 13 > b.length) return null;
  const rate = (b[d + 10] << 12) | (b[d + 11] << 4) | (b[d + 12] >> 4);
  return rate >= 8000 && rate <= 768000 ? rate : null;
}

function parseMp4(b: Uint8Array): number | null {
  // 只在确有 ftyp 的容器里查 mp4a / alac 采样率（AudioSampleEntry 的 16.16 定点在 +28 处）
  if (!tag(b, 4, "ftyp")) return null;
  for (let p = 0; p + 36 < b.length; p++) {
    const isMp4a = b[p] === 0x6d && b[p + 1] === 0x70 && b[p + 2] === 0x34 && b[p + 3] === 0x61; // "mp4a"
    const isAlac = b[p] === 0x61 && b[p + 1] === 0x6c && b[p + 2] === 0x61 && b[p + 3] === 0x63; // "alac"
    if (isMp4a || isAlac) {
      const rate = (b[p + 28] << 8) | b[p + 29];
      if (rate >= 8000 && rate <= 384000) return rate;
    }
  }
  return null;
}

function parseOgg(b: Uint8Array): number | null {
  const lim = Math.min(b.length - 16, 1 << 16);
  for (let i = 0; i + 16 < lim; i++) {
    if (b[i] === 0x01 && tag(b, i + 1, "vorbis")) {
      const rate = u32le(b, i + 12);
      return rate >= 8000 && rate <= 768000 ? rate : null;
    }
    if (tag(b, i, "OpusHead")) return 48000; // Opus 输出恒为 48k
  }
  return null;
}

function parseMp3(b: Uint8Array, from: number): number | null {
  const lim = Math.min(b.length - 4, from + 65536);
  for (let i = Math.max(0, from); i < lim; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const ver = (b[i + 1] >> 3) & 3;      // 3=MPEG1 2=MPEG2 0=MPEG2.5 1=保留
    const layer = (b[i + 1] >> 1) & 3;    // 0=保留
    const srIdx = (b[i + 2] >> 2) & 3;    // 3=保留
    const brIdx = (b[i + 2] >> 4) & 15;   // 0=free 15=保留
    if (ver === 1 || layer === 0 || srIdx === 3 || brIdx === 0 || brIdx === 15) continue;
    const table = ver === 3 ? [44100, 48000, 32000] : ver === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
    return table[srIdx];
  }
  return null;
}

/** 从音频字节解析原生采样率；解析不出返回 null。 */
export function parseSampleRate(bytes: Uint8Array): number | null {
  if (bytes.length < 16) return null;
  const id3 = id3v2Size(bytes);
  return (
    parseFlac(bytes, id3) ??
    parseWav(bytes) ??
    parseMp4(bytes) ??
    parseOgg(bytes) ??
    parseMp3(bytes, id3) ??
    parseMp3(bytes, 0)
  );
}

/* ---------- 解码 ---------- */

function clamp16(v: number): number {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v;
}

/**
 * 解码为"单声道 16bit 语义"的 Float32 样本（值 = int16/32768）。
 * 采样率 = 头部解析的原生率；解析失败用 fallbackRate。
 * 失败（无 OfflineAudioContext / 解码错误）返回 null → 调用方走流式回退。
 */
export async function decodeMonoPcm(
  bytes: ArrayBuffer,
  fallbackRate: number,
): Promise<{ pcm: Float32Array; rate: number } | null> {
  const view = new Uint8Array(bytes);
  const parsed = parseSampleRate(view);
  let rate = parsed ?? (Math.floor(fallbackRate) || 48000);
  if (!(rate >= 3000 && rate <= 384000)) rate = 48000;
  try {
    const Ctor: typeof OfflineAudioContext | undefined =
      (window as any).OfflineAudioContext || (window as any).webkitOfflineAudioContext;
    if (!Ctor) return null;
    /* 目标上下文采样率 = 原生率 → decodeAudioData 的重采样器成为恒等（无重采样） */
    const oac = new Ctor(1, 1, rate);
    const buf = await oac.decodeAudioData(bytes);
    rate = buf.sampleRate || rate;
    const ch = buf.numberOfChannels;
    const n = buf.length;
    const out = new Float32Array(n);
    if (ch === 1) {
      const c0 = buf.getChannelData(0);
      for (let i = 0; i < n; i++) out[i] = clamp16(Math.round(c0[i] * 32768)) / 32768;
    } else if (ch === 2) {
      const c0 = buf.getChannelData(0);
      const c1 = buf.getChannelData(1);
      for (let i = 0; i < n; i++) {
        /* 照 decoder.py：先在 int16 域分别量化，再平均（平均可能是半个 LSB，保留） */
        const a = clamp16(Math.round(c0[i] * 32768));
        const b = clamp16(Math.round(c1[i] * 32768));
        out[i] = (a + b) / 2 / 32768;
      }
    } else {
      const chans: Float32Array[] = [];
      for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let c = 0; c < ch; c++) acc += clamp16(Math.round(chans[c][i] * 32768));
        out[i] = acc / ch / 32768;
      }
    }
    return { pcm: out, rate };
  } catch {
    return null;
  }
}
