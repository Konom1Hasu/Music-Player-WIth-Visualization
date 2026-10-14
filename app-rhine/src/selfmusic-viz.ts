/* selfmusic-viz.ts —— 系统设置里的「可视化调节」十六滑块（与 SelfMusic 面板 1:1）。
 *
 * 参数系统（键/范围/默认/换算）在 selfmusic-spectrum.ts 里与 SelfMusic mainwindow
 * 的「可视化调节」面板逐项对齐；本模块只负责 UI：生成 markup、拖动回显、
 * 经 player.ts 的 setSmDisplayValue 实时写引擎（下一次分析 tick 生效）+ 持久化。
 */
import {
  SELFMUSIC_SLIDER_DEFAULTS,
  SELFMUSIC_SLIDER_RANGES,
  type SmSliderKey,
} from "./selfmusic-spectrum";
import { getSmDisplayValues, resetSmDisplayValues, setSmDisplayValue } from "./player";

/** 行定义：[键, 名称, 提示]（顺序与提示语照 SelfMusic mainwindow rows） */
const ROWS: Array<[SmSliderKey, string, string]> = [
  ["smooth", "顺滑", "铺散遍数：把陡台阶摊成缓坡（0~3 遍；2 遍会把顶端磨成等高平台）"],
  ["knee", "软膝", "顶端软膝起点：0 = 硬钳 1.0；越大越早进入对数肩，强带之间永远留着可见高低差"],
  ["detail", "细纹", "毛刺感：细谱局部起伏的有界乘性调制（先圆化再叠加——小圆丘，不是尖针）"],
  ["leftpump", "左塔泵动", "没拍时左塔回落 (1−值)、一拍下去顶回满高（原版是根不动的柱子）"],
  ["head", "弹性", "量程余量：原版逐帧归一让 84% 的帧顶在天花板；越大常态峰值越靠中段、Kick 一来才顶上去"],
  ["right", "右细节", "用其他音色的细节点亮右区：高频瞬态 + 各带细谱纹理（只补不造）"],
  ["agc", "右丰", "逐带慢包络：中高频有内容就立得起来（默认关；会抬高右段但拉平坡）"],
  ["steepq", "陡峭", "整条天际线的坡度：幂曲线把弱带压低、强带顶住（陡而不断）"],
  ["tilt", "倾斜", "整条频谱向低端（左端）靠：左端 ×(1+t)、右端 ×(1−t)"],
  ["timbre", "音色", "鼓/贝斯/人声/镲四路，谁活跃就把它自己那一段抬高一截"],
  ["tint", "毛刺", "邻带对比度（乐音/噪声）对条高的加成（原版 22）"],
  ["expanda", "尖塔", "对比扩张：峰更高谷更低（制造断崖的一项，默认关）"],
  ["surge", "低频高耸", "检测到 Kick/低频突增时左端高耸的强度（原版 55）"],
  ["release", "回落", "包络回落速度：越大落得越干脆（弹），越小越黏（糊）"],
  ["valley", "谷深", "非局部峰的保留比例（100 = 关）：越小 → 谷越深、峰越离群"],
  ["idle", "静音呼吸", "无信号时是否轻轻起伏（0 = 归零，1 = 呼吸）"],
];

/** 系统设置里的面板块（放 settingsMarkup 里） */
export function selfmusicVizMarkup() {
  const cur = getSmDisplayValues();
  const rows = ROWS.map(([key, label, tip]) => {
    const [lo, hi] = SELFMUSIC_SLIDER_RANGES[key];
    const value = cur[key];
    return `<label class="quality-control quality-range" title="${tip}"><span>${label}<small>${tip}</small></span><div><input type="range" data-sm-slider="${key}" aria-label="${label}" min="${lo}" max="${hi}" step="1" value="${value}"/><output data-sm-output="${key}">${value}</output></div></label>`;
  }).join("");
  return `<div class="sm-viz"><div class="quality-heading"><h3>SELF-MUSIC VISUALIZER<span>可视化调节 · 拖动实时生效</span></h3><button type="button" class="sm-viz-reset" data-action="sm-viz-reset">RESET<span>还原默认</span></button></div><p class="quality-note">十六枚参数与 SelfMusic 的「可视化调节」面板一致（作用于 SelfMusic 频谱档）。默认 = 出厂档；调整即时生效，并自动记住。</p>${rows}</div>`;
}

/** 拖动处理（main.ts 的全局 input 委托调用）：值 → 引擎实时 + 存 + 回显 */
export function handleSelfmusicVizInput(input: HTMLInputElement) {
  const key = input.dataset.smSlider as SmSliderKey | undefined;
  if (!key || !(key in SELFMUSIC_SLIDER_RANGES)) return;
  const value = Number(input.value);
  if (!isFinite(value)) return;
  setSmDisplayValue(key, value);
  const output = document.querySelector<HTMLOutputElement>(`[data-sm-output="${key}"]`);
  if (output) output.value = String(Math.round(value));
}

/** 重置为默认档（RESET 按钮）：清存储 + 引擎回默认 + 刷新全部滑块回显 */
export function resetSelfmusicViz() {
  resetSmDisplayValues();
  const cur = getSmDisplayValues();
  for (const [key] of ROWS) {
    const input = document.querySelector<HTMLInputElement>(`[data-sm-slider="${key}"]`);
    if (input) input.value = String(cur[key]);
    const output = document.querySelector<HTMLOutputElement>(`[data-sm-output="${key}"]`);
    if (output) output.value = String(cur[key]);
  }
}

/* ---- 调参预览态（2026-10-14）：滚到本区块时，设置弹层自动为频谱让位 ----
   用户反馈「调节参数时不好看到实际的效果，因为被设置窗口和背景模糊挡住」。
   做法：IntersectionObserver 监听本区块与弹层可视区的交叉 —— 可见即给
   `.modal-backdrop` 打上 data-viz-preview（遮罩去模糊 / 去底色，弹层向左
   让位，样式见 style.css 同名段落），滚离即恢复。只在设置弹层里安装。 */
let vizPreviewIO: IntersectionObserver | null = null;

/** 设置弹层渲染后调用（main.ts renderModal）：安装「调参预览态」观察器 */
export function installVizPreviewMode(root: ParentNode) {
  disposeVizPreviewMode();
  const modal = root.querySelector<HTMLElement>(".settings-modal");
  const smViz = root.querySelector<HTMLElement>(".sm-viz");
  const backdrop = root.querySelector<HTMLElement>(".modal-backdrop");
  if (!modal || !smViz || !backdrop) return; // 非设置弹层（检索 / 收藏）不装
  vizPreviewIO = new IntersectionObserver(
    (entries) => {
      const ratio = entries[entries.length - 1]?.intersectionRatio ?? 0;
      /* 阈值 0.12：滑块区露头一点点还不打扰（用户可能只是在翻设置项），
         露出约一行滑块的高度才让位；滚离同理回落 */
      if (ratio > 0.12) backdrop.dataset.vizPreview = "1";
      else delete backdrop.dataset.vizPreview;
    },
    { root: modal, threshold: [0, 0.12, 1] },
  );
  vizPreviewIO.observe(smViz);
}

/** 弹层关闭时调用（main.ts finishModalClose）：断开观察器 */
export function disposeVizPreviewMode() {
  vizPreviewIO?.disconnect();
  vizPreviewIO = null;
}

/** 默认档参考值（供外部/测试取用） */
export const SELFMUSIC_VIZ_DEFAULTS = SELFMUSIC_SLIDER_DEFAULTS;
