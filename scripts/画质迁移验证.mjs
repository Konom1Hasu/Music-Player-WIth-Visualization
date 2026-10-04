/* 校验「画质档的一次性迁移」（render-quality.ts 里的 supersededPresets）。

   why：normalizeQuality() 是**逐项**读已存设置的，旧数值会被原样保留 ——
   只改 qualityPresets 里的档位定义，对已经存过设置的用户完全不生效。
   所以那里加了一张"被修正过的旧档位定义"表：与旧定义**逐项全等**的已存设置
   会被按档位名映射到当前定义。这段判据很容易在后续改动里被悄悄改坏，
   所以单独拿一个脚本钉住契约。

   用法：node scripts\画质迁移验证.mjs
   （render-quality.ts 没有任何 import，所以用 esbuild 单文件转换后直接 import，
     不需要跑完整的构建。） */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "app-rhine", "src", "render-quality.ts");

const require = createRequire(path.join(ROOT, "app-rhine", "package.json"));
const esbuild = require("esbuild");

/* ⚠ 这些是**历史事实**，必须冻结在这里。迁移表是**累积**的：
   每次修正都追加一条旧定义快照，所以下面每一条都要一直能升级成功 ——
   否则"停在更早版本"的用户就再也拿不到修正。 */
/* v2.3.0（含）以前的「性能」档 */
const SUPERSEDED_PERFORMANCE_V1 = {
  scale: 80,
  pixelRatio: 1,
  antialias: "off",
  shadows: 1024,
  aoSamples: 0,
  aoResolution: 0.5,
  depthOfField: 0,
  transmission: 0.5,
  anisotropy: 4,
};
/* 2026-10-04 第一次修正后的「性能」档：补了抗锯齿/透射/各向异性，但 scale 仍是 80
   —— 就是用户反馈「性能模式还是很糊」的那一版。 */
const SUPERSEDED_PERFORMANCE_V2 = {
  scale: 80,
  pixelRatio: 1,
  antialias: "smaa",
  shadows: 1024,
  aoSamples: 0,
  aoResolution: 0.5,
  depthOfField: 0,
  transmission: 0.75,
  anisotropy: 16,
};
/* 2026-10-04 以前的「原始」档：景深 100 + 满分辨率透射
   —— 就是用户反馈「原始模式肉眼可见卡顿」的那一版。 */
const SUPERSEDED_ORIGINAL_V1 = {
  scale: 100,
  pixelRatio: 1.5,
  antialias: "off",
  shadows: 2048,
  aoSamples: 32,
  aoResolution: 1,
  depthOfField: 100,
  transmission: 1,
  anisotropy: 16,
};

const SUPERSEDED = [
  ["旧「性能」档 v1（最早那版）", SUPERSEDED_PERFORMANCE_V1, "performance"],
  ["旧「性能」档 v2（补了抗锯齿但 scale 仍 80）", SUPERSEDED_PERFORMANCE_V2, "performance"],
  ["旧「原始」档 v1（景深 100 + 满透射）", SUPERSEDED_ORIGINAL_V1, "original"],
];

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) pass++;
  else failures.push({ name, detail });
}

/* 用 esbuild 把 TS 转成 ESM，落到临时目录再 import */
const out = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), "rhine-quality-")),
  "render-quality.mjs",
);
fs.writeFileSync(
  out,
  esbuild.transformSync(fs.readFileSync(SRC, "utf8"), {
    loader: "ts",
    format: "esm",
  }).code,
  "utf8",
);
const { qualityPresets, normalizeQuality, matchingPreset } =
  await import(pathToFileURL(out).href);

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const names = Object.keys(qualityPresets);

/* ① 每一条历史档位都必须被升级成对应的当前档位 */
for (const [label, oldDef, target] of SUPERSEDED) {
  const got = normalizeQuality({ ...oldDef });
  check(
    `${label} → 升级为当前「${target}」档`,
    eq(got, qualityPresets[target]),
    `得到 ${JSON.stringify(got)}`,
  );
  check(
    `${label} 升级后 matchingPreset 认出是 ${target}`,
    matchingPreset(got) === target,
    `得到 ${matchingPreset(got)}`,
  );
}

/* ② 迁移表不能变成空操作：任一条旧定义若与当前定义相同，说明该条已失效、应删除 */
for (const [label, oldDef, target] of SUPERSEDED) {
  check(
    `${label} 与当前「${target}」档确实不同`,
    !eq(oldDef, qualityPresets[target]),
    "旧定义与当前定义逐项相同 —— 修正被改回去了，或迁移表没跟着更新",
  );
}

/* ②b 迁移表内不能有重复定义（重复会让后面那条永远命中不到，等于静默失效） */
for (let i = 0; i < SUPERSEDED.length; i++) {
  for (let j = i + 1; j < SUPERSEDED.length; j++) {
    check(
      `迁移表第 ${i + 1} 条与第 ${j + 1} 条不重复`,
      !eq(SUPERSEDED[i][1], SUPERSEDED[j][1]),
      `${SUPERSEDED[i][0]} 与 ${SUPERSEDED[j][0]} 定义相同`,
    );
  }
}

/* ③ 幂等：每个档位的当前定义喂回去都应原样保留 */
for (const name of names) {
  check(
    `当前「${name}」档喂回 normalizeQuality 保持不变`,
    eq(normalizeQuality({ ...qualityPresets[name] }), qualityPresets[name]),
    `得到 ${JSON.stringify(normalizeQuality({ ...qualityPresets[name] }))}`,
  );
}

/* ④ 自定义档不能被误升级（判据是九项全等） */
for (const [label, custom] of [
  ["只改了 scale", { ...SUPERSEDED_PERFORMANCE_V1, scale: 95 }],
  ["只改了 anisotropy", { ...SUPERSEDED_PERFORMANCE_V1, anisotropy: 8 }],
  ["只改了 antialias", { ...SUPERSEDED_PERFORMANCE_V1, antialias: "smaa" }],
  ["性能 v2 只改 scale（就不是 v2 了）", { ...SUPERSEDED_PERFORMANCE_V2, scale: 100 }],
  ["原始 v1 只改景深", { ...SUPERSEDED_ORIGINAL_V1, depthOfField: 50 }],
]) {
  const got = normalizeQuality(custom);
  check(
    `自定义档（${label}）不被误升级`,
    eq(got, custom),
    `得到 ${JSON.stringify(got)}`,
  );
}

/* ④b 治糊/治卡的关键数值必须真的落在当前定义里（防止后续被无意改回去） */
check(
  "性能档 scale ≥ 120（治「性能模式还是很糊」的关键）",
  qualityPresets.performance.scale >= 120,
  `得到 scale=${qualityPresets.performance.scale}`,
);
check(
  "原始档不再跑全屏景深（治「原始模式卡顿」的关键）",
  qualityPresets.original.depthOfField === 0,
  `得到 depthOfField=${qualityPresets.original.depthOfField}`,
);
check(
  "原始档透射底图不再满分辨率（治卡顿的关键）",
  qualityPresets.original.transmission < 1,
  `得到 transmission=${qualityPresets.original.transmission}`,
);
check(
  "原始档分辨率未被削减（治卡不能拿锐度换）",
  qualityPresets.original.scale === 100 && qualityPresets.original.pixelRatio === 1.5,
  `得到 scale=${qualityPresets.original.scale} pixelRatio=${qualityPresets.original.pixelRatio}`,
);

/* ⑤ 空值回落「原始」档 */
check(
  "undefined 回落「原始」档",
  eq(normalizeQuality(undefined), qualityPresets.original),
  `得到 ${JSON.stringify(normalizeQuality(undefined))}`,
);

/* ⑥ 旧字段 quality=false 的兼容路径仍给出 pixelRatio 1 */
check(
  "legacyHigh=false 路径仍给出 pixelRatio 1",
  normalizeQuality(undefined, false).pixelRatio === 1,
  `得到 ${normalizeQuality(undefined, false).pixelRatio}`,
);

fs.rmSync(path.dirname(out), { recursive: true, force: true });

console.log("画质档：");
for (const name of names) {
  const q = qualityPresets[name];
  console.log(
    `  ${name.padEnd(12)} scale ${String(q.scale).padStart(3)} · 像素密度 ${q.pixelRatio} · ` +
      `${q.antialias.padEnd(4)} · 透射 ${q.transmission} · 各向异性 ${q.anisotropy}×`,
  );
}
console.log("");
if (failures.length) {
  for (const f of failures) console.log(`✗ ${f.name}  →  ${f.detail}`);
  console.log(`\n结果: ${pass} 通过, ${failures.length} 失败`);
  process.exit(1);
}
console.log(`结果: ${pass} 通过, 0 失败`);
