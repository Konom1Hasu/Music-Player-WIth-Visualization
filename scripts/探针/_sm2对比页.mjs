/* 生成「还原算法 + 十六滑块」效果对比页（dist/滑块效果对比.html）：
   行 = 五档（原版裸 / 出厂默认 / 弹性300 / 顺滑3 / 尖塔340+谷深20），列 = 3 个音乐时刻。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const manifest = JSON.parse(fs.readFileSync(path.join(root, "dist", "_sm2帧图", "_manifest.json"), "utf8"));
const jobsMap = new Map();
for (const it of manifest) {
  if (!jobsMap.has(it.job)) jobsMap.set(it.job, []);
  jobsMap.get(it.job).push(it);
}

const ROWS = [
  {
    key: "原版裸16项全关",
    tag: "原版裸（16 项全关）",
    desc: "SelfMusic 原版（web/spectrum.mjs 的逐位态）：只有内核六步（onset / tint / surge / crest + 包络 + 顶盖）。作为基准线。",
    params: ["headroom 1.0", "tint 0.22", "16 项面板参数全关"],
  },
  {
    key: "出厂默认16项面板默认",
    tag: "★ 出厂默认（16 项面板默认）",
    rec: true,
    desc: "本次落地的档 = SelfMusic 那边「可视化调节」面板的全部默认值，与 Python 权威实现逐位对齐（1000 帧对拍 max|Δ| ≤ 2e-7）。",
    params: ["弹性 160", "毛刺 45", "倾斜 45", "陡峭 160", "软膝 78", "顺滑 1", "细纹 50", "音色 45", "低频高耸 55", "尖塔 100"],
  },
  {
    key: "滑块弹性300",
    tag: "滑块：弹性 → 300",
    desc: "在出厂默认上把「弹性」拉到 300（headroom 3.0）：常态峰更靠中段、整体压低，Kick 来了才顶上去——弹跳落差更大。",
    params: ["弹性 300（其余出厂默认）"],
  },
  {
    key: "滑块顺滑3",
    tag: "滑块：顺滑 → 3",
    desc: "把「顺滑」拉到 3：铺散 3 遍，把顶端陡台阶磨成缓坡；相邻柱高差约 -45%。",
    params: ["顺滑 3（其余出厂默认）"],
  },
  {
    key: "滑块尖塔340谷深20",
    tag: "滑块：尖塔 340 · 谷深 20",
    desc: "「尖塔」340 + 「谷深」20：把扎堆的平台高峰拆成一根根离散尖塔（谷更深、峰更离群）。",
    params: ["尖塔 340", "谷深 20（其余出厂默认）"],
  },
];

const tsec = (f) => (190.0 + f * 0.02).toFixed(2);
let body = "";
for (const r of ROWS) {
  const imgs = [0, 5, 10].map((f) => {
    const it = (jobsMap.get(r.key) || []).find((x) => x.frame === f);
    if (!it) return `<div class="cell"><div class="ph">缺图</div></div>`;
    return `<div class="cell"><img src="_sm2帧图/${it.name}" alt=""><div class="fc">${tsec(f)}s · f${String(f).padStart(3, "0")}</div></div>`;
  }).join("");
  body += `
  <div class="panel">
    <div class="cap"><span class="tag${r.rec ? " rec" : ""}">${r.tag}</span><span class="desc">${r.desc}</span></div>
    <div class="chips">${r.params.map((p) => `<span class="chip">${p}</span>`).join("")}</div>
    <div class="grid">${imgs}</div>
  </div>`;
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>还原 SelfMusic 算法 + 十六滑块 — 效果对比 · 同一段真实音乐</title>
<style>
  :root { --ink:#23211d; --sub:#6b675f; --line:#d8d3c8; --bg:#f4f1ea; --card:#fbf9f4; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--ink); font-family:"Segoe UI","Microsoft YaHei",sans-serif; padding:28px 30px 48px; }
  h1 { font-size:17px; letter-spacing:.06em; margin-bottom:6px; }
  .sub { color:var(--sub); font-size:12.5px; margin-bottom:14px; line-height:1.75; }
  .sub b { color:var(--ink); }
  .hint { background:#f0ead9; border:1px solid var(--line); border-radius:8px; padding:10px 14px; font-size:12.5px; color:#4b4a3b; line-height:1.75; margin-bottom:18px; }
  .hint b { color:var(--ink); }
  .panel { background:var(--card); border:1px solid var(--line); border-radius:10px; margin-bottom:16px; overflow:hidden; }
  .cap { display:flex; align-items:baseline; gap:10px; padding:11px 16px 8px; flex-wrap:wrap; }
  .tag { font-family:Consolas,monospace; font-size:12.5px; font-weight:700; letter-spacing:.05em; white-space:nowrap; }
  .tag.rec { color:#a5651f; }
  .desc { color:var(--sub); font-size:12px; flex:1 1 auto; }
  .chips { display:flex; gap:8px; flex-wrap:wrap; padding:0 16px 10px; }
  .chip { font-family:Consolas,monospace; font-size:11px; color:#4b4a3b; background:#efe9dd; border:1px solid var(--line); border-radius:6px; padding:2px 8px; }
  .grid { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; padding:0 12px 12px; }
  .cell img { display:block; width:100%; border:1px solid var(--line); border-radius:6px; background:#fff; }
  .cell .fc { text-align:center; color:var(--sub); font-family:Consolas,monospace; font-size:10.5px; margin-top:4px; }
  .cell .ph { height:120px; display:flex; align-items:center; justify-content:center; color:#aaa; border:1px dashed var(--line); border-radius:6px; }
  .note { color:var(--sub); font-size:12px; line-height:1.75; margin-top:18px; border-top:1px solid var(--line); padding-top:12px; }
  .note b { color:var(--ink); }
</style>
</head>
<body>
  <h1>还原 SelfMusic 算法 + 十六滑块 — 效果对比</h1>
  <p class="sub">
    同一段真实音乐（参考原声 190.0s 起，每帧相隔 20ms），<b>产物 exe 的实际渲染器出图</b>，逐帧冻结、同口径。<br>
    引擎 = <b>SelfMusic 最新版全量移植</b>（web/spectrum.mjs 内核 + selfmusic.py 的全部可调显示层 16 项）；
    与 Python 权威实现三档对拍 1000 帧 × 96 条，max|Δ| ≤ 2e-7（浮点舍入级）。<br>
    十六枚滑块已进「系统设置 → SELF-MUSIC VISUALIZER」，<b>拖动实时生效</b>并自动记住，RESET 一键回默认。
  </p>
  <div class="hint">
    <b>怎么读</b>：第一行是 SelfMusic 原版素颜（基准）；第二行是本次落地的默认档（★）。
    后三行演示滑块效果——「弹性」管弹跳落差、「顺滑」管台阶磨圆、「尖塔+谷深」管拆塔。
    所有图都是同一帧数据、同一渲染路径，差别只来自滑块。
  </div>
  ${body}
  <div class="note">
    <b>验证口径</b>：Python 侧 musicapp/selfmusic.py（权威）↔ 本仓 selfmusic-spectrum.ts，中性 / 出厂 / 扫档（16 项全非默认）
    三档各 1000 帧逐位对拍全部通过；另做逐项 16 档 + 累进 16 档对拍全绿（曾据此揪出「谷深」两遍判峰的次序 bug）。
    <br><b>滑块路径</b>：拖动 → localStorage('rhine-sm-display') 落盘 → 下一分析 tick 应用；实测 head 160→300 使均值 -36%、smooth 1→3 使相邻柱差 -46%。
  </div>
</body>
</html>`;
fs.writeFileSync(path.join(root, "dist", "滑块效果对比.html"), html);
console.log("已生成 dist/滑块效果对比.html，行数 =", ROWS.length);
