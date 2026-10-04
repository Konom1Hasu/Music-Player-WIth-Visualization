/** Rendering controls are independent of lighting, materials and animation. */
export type RenderQuality = {
  scale: number;
  pixelRatio: number;
  antialias: "off" | "smaa";
  shadows: number;
  aoSamples: number;
  aoResolution: number;
  depthOfField: number;
  transmission: number;
  anisotropy: number;
};

export const qualityPresets = {
  performance: {
    /* ★ 2026-10-04 二次修正（用户："性能模式下建模还是很糊"）。
       上一次只把 antialias/transmission/anisotropy 补齐，但**没动 scale** —— 而
       "糊"的主因恰恰就是 scale：它决定整条后处理链的渲染缓冲有多大。
       scale=80 在 1380×920 窗口下算出来是 692×467 ≈ 0.32 MP，这个缓冲随后被
       拉伸铺满整个窗口（约 1170×790 的逻辑像素）—— 也就是**用一个半分辨率都不到的
       图去填满屏幕**，每个输出像素平均拿不到 0.6 个输入像素。刻线、卡片斜边、
       封面上的字在这个阶段就已经没了，SMAA 只能把已有的锯齿磨圆，变不出不存在的细节。
       实测三档渲染像素（1380×920 窗口、stage scale 0.74、devicePixelRatio 1）：
         scale 80  → 0.32 MP
         scale 100 → 0.51 MP（1.56×）
         scale 120 → 0.73 MP（2.25×）
         scale 125 → 0.79 MP（2.44×）
       取 120：渲染量相对原来涨 2.25 倍，但先把「糊」彻底解决；这也是当初
       "原始档能不能看清刻线"的那个分辨率量级（≥53% 设备分辨率），再往上加
       肉眼收益迅速递减。pixelRatio 保持 1 —— 在 scale 已经提上来的前提下再加
       pixelRatio 是纯叠加，两者相乘会把渲染量推到 4 倍以上。 */
    scale: 120,
    pixelRatio: 1,
    antialias: "smaa",
    shadows: 1024,
    aoSamples: 0,
    aoResolution: 0.5,
    depthOfField: 0,
    transmission: 0.75,
    anisotropy: 16,
  },
  original: {
    /* 用户："原始模式下可视化肉眼可见的卡顿"。
       分辨率（scale 100 / pixelRatio 1.5 → 0.91 MP）本身不是主要问题，
       真正吃帧率的是它每个像素上跑了几遍全屏 pass：
         · transmission=1  → 磨砂盖板要额外渲染一整遍**满分辨率**不透明场景（0.91 MP），
           这是本档最贵的一项，而且它只是给盖板做折射用的背景底图；
         · depthOfField>0  → Bokeh 又是一遍全屏 + 一轮 9 点采样；
         · aoSamples=32    → SSAO 两遍全屏。
       合计 6 遍全屏 pass × 0.91 MP ≈ 3.0 MP/帧 的填充，是性能档的 1.9 倍。
       调整：transmission 1 → 0.6（透射底图按 0.6 缩放，省掉约 64% 的透射填充，
       而盖板本身只有卡片那么大、糊一点看不出来 —— 它压着的图案才是关键，
       图案走的是主渲染缓冲，不受这个系数影响）；
       depthOfField 归零（本档是"日常用"档位，景深虚化吃一遍全屏却不提升可读性，
       要虚化请用「高」档）。scale/pixelRatio/抗锯齿全部不动，**锐度一点不降**。 */
    scale: 100,
    pixelRatio: 1.5,
    antialias: "off",
    shadows: 2048,
    aoSamples: 32,
    aoResolution: 1,
    depthOfField: 0,
    transmission: 0.6,
    anisotropy: 16,
  },
  high: {
    scale: 125,
    pixelRatio: 2,
    antialias: "smaa",
    shadows: 4096,
    aoSamples: 32,
    aoResolution: 1,
    depthOfField: 100,
    transmission: 1,
    anisotropy: 16,
  },
  ultra: {
    scale: 150,
    pixelRatio: 2,
    antialias: "smaa",
    shadows: 4096,
    aoSamples: 64,
    aoResolution: 1,
    depthOfField: 100,
    transmission: 1,
    anisotropy: 16,
  },
} as const satisfies Record<string, RenderQuality>;
export type QualityPreset = keyof typeof qualityPresets;
export const presetLabels: Record<QualityPreset, string> = {
  performance: "性能",
  original: "原始",
  high: "高",
  ultra: "极高",
};

const member = <T>(value: unknown, choices: readonly T[], fallback: T): T =>
  choices.includes(value as T) ? (value as T) : fallback;
const range = (
  value: unknown,
  min: number,
  max: number,
  step: number,
  fallback: number,
) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value / step) * step))
    : fallback;

/* 被修正过的旧档位定义。normalizeQuality 是**逐项**读已存设置的，旧数值会被原样保留，
   所以光改上面的 qualityPresets 对老用户完全不生效（他们的设置里存的还是旧数值）。
   这里把"与某个旧定义逐项相同"的已存设置按**档位名**映射到当前定义：
   保住用户当初选的档位意图，同时让他真的拿到修正。不留旧值、也不引入版本字段。

   ★ 迁移是**累积**的：每次修正都往这个列表里追加一条旧定义快照，不要替换 ——
   换了就会漏掉"停在更早版本"的用户（比如从没更新过、设置里还是最初那版的数值）。 */
const supersededPresets: readonly { from: RenderQuality; to: RenderQuality }[] = [
  /* 第 1 版性能档：2026-10-04 之前（antialias off / transmission 0.5 / anisotropy 4） */
  {
    from: {
      scale: 80,
      pixelRatio: 1,
      antialias: "off",
      shadows: 1024,
      aoSamples: 0,
      aoResolution: 0.5,
      depthOfField: 0,
      transmission: 0.5,
      anisotropy: 4,
    },
    to: qualityPresets.performance,
  },
  /* 第 2 版性能档：2026-10-04 第一次修正（补了抗锯齿/透射/各向异性，但 scale 仍是 80）——
     就是「性能模式还是很糊」的那一版。scale 80 → 120 真正治糊。 */
  {
    from: {
      scale: 80,
      pixelRatio: 1,
      antialias: "smaa",
      shadows: 1024,
      aoSamples: 0,
      aoResolution: 0.5,
      depthOfField: 0,
      transmission: 0.75,
      anisotropy: 16,
    },
    to: qualityPresets.performance,
  },
  /* 第 1 版原始档：2026-10-04 之前（depthOfField 100 / transmission 1）——
     就是「原始模式肉眼可见卡顿」的那一版。降透射、关景深治卡，分辨率不变。 */
  {
    from: {
      scale: 100,
      pixelRatio: 1.5,
      antialias: "off",
      shadows: 2048,
      aoSamples: 32,
      aoResolution: 1,
      depthOfField: 100,
      transmission: 1,
      anisotropy: 16,
    },
    to: qualityPresets.original,
  },
];
function upgradeSuperseded(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const v = value as Record<string, unknown>;
  for (const { from, to } of supersededPresets) {
    const keys = Object.keys(from) as (keyof RenderQuality)[];
    if (keys.every((k) => v[k] === from[k])) return { ...to };
  }
  return value;
}

export function normalizeQuality(
  value: unknown,
  legacyHigh = true,
): RenderQuality {
  const base = qualityPresets.original;
  value = upgradeSuperseded(value);
  const v =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  // Older low quality retained full resolution, shadows and transmission.
  const fallback = legacyHigh
    ? base
    : { ...base, pixelRatio: 1, aoSamples: 0, depthOfField: 0 };
  return {
    scale: range(v.scale, 50, 200, 5, fallback.scale),
    pixelRatio: member(v.pixelRatio, [1, 1.5, 2, 3], fallback.pixelRatio),
    antialias: member(
      v.antialias,
      ["off", "smaa"] as const,
      fallback.antialias,
    ),
    shadows: member(v.shadows, [0, 1024, 2048, 4096], fallback.shadows),
    aoSamples: member(v.aoSamples, [0, 16, 32, 64], fallback.aoSamples),
    aoResolution: member(v.aoResolution, [0.5, 0.75, 1], fallback.aoResolution),
    depthOfField: range(v.depthOfField, 0, 150, 5, fallback.depthOfField),
    transmission: member(
      v.transmission,
      [0.25, 0.5, 0.75, 1],
      fallback.transmission,
    ),
    anisotropy: member(v.anisotropy, [1, 2, 4, 8, 16], fallback.anisotropy),
  };
}

export function matchingPreset(
  quality: RenderQuality,
): QualityPreset | "custom" {
  return (
    (Object.keys(qualityPresets) as QualityPreset[]).find((key) =>
      Object.entries(qualityPresets[key]).every(
        ([field, value]) => quality[field as keyof RenderQuality] === value,
      ),
    ) ?? "custom"
  );
}

export function renderDimensions(
  quality: RenderQuality,
  width: number,
  height: number,
  stageScale: number,
  deviceRatio: number,
  maxTextureSize: number,
) {
  const requested =
    (Math.min(deviceRatio, quality.pixelRatio) * stageScale * quality.scale) /
    100;
  // Bound all full-resolution postprocessing targets to 8.3 MP and device limits.
  const ratio = Math.min(
    requested,
    Math.sqrt(8_294_400 / Math.max(1, width * height)),
    maxTextureSize / Math.max(1, width, height),
  );
  return {
    ratio,
    width: Math.max(1, Math.floor(width * ratio)),
    height: Math.max(1, Math.floor(height * ratio)),
    limited: ratio < requested - 0.0001,
  };
}
