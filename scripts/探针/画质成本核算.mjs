/* 画质档位"实际渲染分辨率 / 相对像素成本"核算。
   目的：把「性能档糊」「原始档卡」两个主观感受换成可比较的数字 ——
   每档实际渲染多少像素、每帧要跑几遍全屏 pass。

   用法： node scripts/探针/画质成本核算.mjs
*/
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");   // 本脚本在 scripts\探针\ 下，仓库根要上两级

/* render-quality.ts 是 TS，先用 esbuild 打成临时 mjs 再 import（与 画质迁移验证.mjs 同法） */
const out = path.join(root, "app-rhine", ".quality-cost.mjs");
execSync(
  `"${path.join(root, "app-rhine", "node_modules", ".bin", "esbuild.cmd")}" ` +
    `"${path.join(root, "app-rhine", "src", "render-quality.ts")}" --format=esm --outfile="${out}"`,
  { stdio: "pipe", cwd: root },
);
const { qualityPresets, renderDimensions, matchingPreset } = await import(
  "file:///" + out.replace(/\\/g, "/")
);

/* 场景容器尺寸：主窗口内 #three-scene 的区域（实测主线是整窗去掉左右面板，
   这里用两块常见容器尺寸做核算，避免只算一种就下结论）。 */
const HOSTS = [
  { label: "窗口 1380×920 时的场景区", w: 1170, h: 790 },
  { label: "窗口 1920×1080 时的场景区", w: 1660, h: 1000 },
];
const STAGE = 0.74; // fit() 在 1380×920 上的实际 scale（≈0.75）
const DEVICE = 1; // 本机 devicePixelRatio = 1（2560×1600 面板 100% 缩放）

const PRESETS = ["performance", "original", "high", "ultra"];

console.log("每档：请求比例 → 实际比例（是否被 8.3MP/纹理上限截断）→ 渲染像素 → 相对性能档像素倍数\n");

for (const host of HOSTS) {
  console.log("== " + host.label + " ==");
  let base = 0;
  for (const name of PRESETS) {
    const q = qualityPresets[name];
    const d = renderDimensions(q, host.w, host.h, STAGE, DEVICE, 16384);
    const px = d.width * d.height;
    if (name === "performance") base = px;
    const requested =
      (Math.min(DEVICE, q.pixelRatio) * STAGE * q.scale) / 100;
    console.log(
      `  ${name.padEnd(12)} scale=${String(q.scale).padStart(3)} ` +
        `pixelRatio=${q.pixelRatio} aa=${q.antialias.padEnd(4)} ` +
        `→ 请求 ${requested.toFixed(3)} 实际 ${d.ratio.toFixed(3)}` +
        `${d.limited ? "（已截断）" : ""} ` +
        `= ${d.width}×${d.height} = ${(px / 1e6).toFixed(2)} MP ` +
        `（性能档的 ${(px / base).toFixed(2)}×）`,
    );
  }
  console.log("");
}

/* 每帧全屏 pass 数：pass 数 × 像素数 就是相对 GPU 填充量 */
console.log("== 每帧全屏 pass 数与填充量 ==");
for (const name of PRESETS) {
  const q = qualityPresets[name];
  const d = renderDimensions(q, 1170, 790, STAGE, DEVICE, 16384);
  const px = d.width * d.height;
  /* 主渲染 1 遍 + 透射缓冲（Frosted_Polymer 是 transmission 材质，会额外渲染一遍不透明场景）
     + SSAO 1~2 遍 + Bokeh 1 遍 + SMAA 3 遍（边缘/权重/混合）+ Output 1 遍 */
  const passes = 1 + (q.transmission > 0 ? 1 : 0) + (q.aoSamples > 0 ? 2 : 0) +
    (q.depthOfField > 0 ? 1 : 0) + (q.antialias === "smaa" ? 3 : 0) + 1;
  console.log(
    `  ${name.padEnd(12)} 全屏 pass ≈ ${passes} 遍 × ${(px / 1e6).toFixed(2)}MP ` +
      `≈ ${((passes * px) / 1e6).toFixed(1)} MP/帧 填充` +
      `${q.transmission < 1 ? `（透射缓冲另按 ${q.transmission} 缩放）` : ""}`,
  );
}

/* 真实场景文件名一一对应，避免"改的档位其实不是用户看到的档位" */
console.log("\n== 当前 qualityPresets 与 supersededPresets 的匹配自检 ==");
for (const name of PRESETS) {
  console.log(`  ${name} → matchingPreset = ${matchingPreset(qualityPresets[name])}`);
}
const src = readFileSync(path.join(root, "app-rhine", "src", "render-quality.ts"), "utf8");
const migrated = src.match(/^\s*from:\s*\{/gm) || [];
console.log(`  supersededPresets 条数 = ${migrated.length}`);
console.log(`  性能档是否仍是旧 scale 80 = ${/performance:\s*\{[^}]*scale:\s*80/s.test(src)}`);

try { execSync(`rm -f "${out}"`); } catch {}
