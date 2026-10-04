/*
 * 版面探针：把 app-rhine\dist\index.html 复制成 _layout.html，注入一段量版面的脚本，
 * 让它把各面板的真实几何（getBoundingClientRect 归一化到 1920×1080 基准）
 * POST 回观测服务。用来回答"哪块压住了哪块"这类问题 —— 比读截图可靠。
 *
 * 用法：node scripts\版面探针.mjs [dist 目录]
 *   然后起 scripts\观测服务.js <dist>，用无头浏览器打开
 *   http://…/_layout.html?scene=archive&time=20
 *
 * 量什么（2026-10-03 扩展，起因是用户"界面太紧凑，主要是避免各部分的遮挡"）：
 *   · 每个面板的矩形（基准坐标），以及是否可见；
 *   · **所有可见块两两之间的重叠面积** —— 只有重叠才可能遮挡，直接算出来，不靠眼睛；
 *   · 每块是否越出 1920×1080 舞台；
 *   · 播放列表抽屉强制打开（否则它是 display:none，量不到）；
 *   · 设置弹窗的内容是否溢出容器（scrollHeight vs clientHeight）。
 *
 * 参数：
 *   ?scene=archive|detail   走哪个模式（默认 archive）
 *   ?modal=settings         打开设置弹窗
 *   ?plist=1                打开播放列表抽屉（默认 1，置 0 关闭）
 */
import fs from "node:fs";
import path from "node:path";

const dist = path.resolve(process.argv[2] || path.join(process.cwd(), "app-rhine", "dist"));
const index = path.join(dist, "index.html");
if (!fs.existsSync(index)) {
  console.error("找不到 " + index + " —— 先 npm run build");
  process.exit(2);
}
const raw = fs.readFileSync(index, "utf8");

const probe = `
<script>
function post(m) { fetch('/metrics', { method: 'POST', body: '### 版面\\n' + m }).catch(() => {}); }
const Q = new URLSearchParams(location.search);
const L = [];
function scale() {
  return Number(getComputedStyle(document.querySelector('#viewport')).getPropertyValue('--scale')) ||
    Math.min(innerWidth / 1920, innerHeight / 1080);
}
/* 屏幕像素 → 1920×1080 基准坐标。stage 本身带 transform: scale()，
   所以要用它自己的 rect 做原点、再用 --scale 除回来。 */
function norm(el) {
  const s = scale();
  const stage = document.querySelector('#stage').getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return {
    x: Math.round((r.left - stage.left) / s), y: Math.round((r.top - stage.top) / s),
    w: Math.round(r.width / s), h: Math.round(r.height / s),
    right: Math.round((r.right - stage.left) / s), bottom: Math.round((r.bottom - stage.top) / s),
  };
}
function visible(el) {
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  /* ★ 必须看**整条祖先链**：档案阵列 / 详情面板是靠父容器的 opacity:0 收起来的，
     只看元素自己的 computed opacity 会把"已经淡出的面板"当成可见，
     于是报出一堆假重叠（实测踩过）。checkVisibility 会把祖先的 opacity / visibility
     一起算进去。 */
  if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  if (Number(cs.opacity) <= 0.01) return false;
  const r = el.getBoundingClientRect();
  return r.width > 1 && r.height > 1;
}
const BLOCKS = [
  ['标题区', '.brand'],
  ['系统导航', '.system-nav'],
  ['档案信息', '.archive-callout'],
  ['  ↳ 读取按钮', '.read-file'],
  ['详情面板', '#detail-content'],
  ['  ↳ 频谱画布', '#detail-content .song-viz canvas'],
  ['  ↳ 歌词行', '#detail-content .song-lyric-line'],
  ['  ↳ 详情按钮行', '#detail-content .detail-actions'],
  ['  ↳ 详情尾部', '#detail-content .detail-footnote'],
  ['播放条', '#player-bar'],
  ['  ↳ 正在播放', '#player-bar .p-now'],
  ['播放列表', '#player-playlist'],
  ['  ↳ 列表首行', '#player-playlist .p-row'],
  ['系统页脚', '.system-footer'],
  ['右下角 POWERED', '.powered'],
  ['设置弹窗', '.settings-modal'],
];
function report(tag) {
  L.length = 0;
  L.push(tag + '：模式 = ' + document.querySelector('#stage').dataset.mode +
    '，缩放 = ' + scale().toFixed(4) + '，视口 = ' + innerWidth + 'x' + innerHeight);
  const found = [];
  for (const [name, sel] of BLOCKS) {
    const el = document.querySelector(sel);
    if (!el) { L.push('  ' + name + ' = 不存在'); continue; }
    const vis = visible(el);
    const r = norm(el);
    r.name = name;
    r.vis = vis;
    found.push(r);
    const out = (r.x < 0 || r.y < 0 || r.right > 1920 || r.bottom > 1080) ? '   ← 越出舞台' : '';
    L.push('  ' + name.padEnd(14) + ' x ' + r.x + '–' + r.right + '  y ' + r.y + '–' + r.bottom +
      '  (' + r.w + '×' + r.h + ')' + (vis ? '' : '  [不可见，不参与重叠统计]') + out);
  }
  /* 两两重叠：只有矩形相交才谈得上遮挡，这里直接把面积算出来 */
  let any = false;
  for (let i = 0; i < found.length; i++) {
    for (let j = i + 1; j < found.length; j++) {
      const a = found[i], b = found[j];
      if (!a.vis || !b.vis) continue;
      /* 父子关系不算遮挡（子元素本来就在父元素里） */
      const nested = (a.x <= b.x && a.y <= b.y && a.right >= b.right && a.bottom >= b.bottom) ||
        (b.x <= a.x && b.y <= a.y && b.right >= a.right && b.bottom >= a.bottom);
      if (nested) continue;
      const ox = Math.max(0, Math.min(a.right, b.right) - Math.max(a.x, b.x));
      const oy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
      if (ox > 0 && oy > 0) {
        if (!any) { L.push('  ── 重叠 ──'); any = true; }
        L.push('    ' + a.name + ' × ' + b.name + ' = ' + ox + '×' + oy + ' px²   ← 有重叠');
      }
    }
  }
  if (!any) L.push('  ── 重叠 ──  无（所有可见块互不相交）');
  /* 设置弹窗：内容会不会溢出面框 */
  const modal = document.querySelector('.terminal-modal');
  if (modal && visible(modal)) {
    const m = norm(modal);
    const cs = getComputedStyle(modal);
    /* ★ scrollHeight / clientHeight / getComputedStyle 返回的都是 **CSS 像素**，
       与 stage 的 transform: scale() 无关 —— 这里**不要**再除一次 scale（踩过一次，
       算出来的"内容高"会比真实值大 1/scale 倍，看着像溢出得很夸张）。 */
    const padT = parseFloat(cs.paddingTop);
    const padB = parseFloat(cs.paddingBottom);
    const boxH = modal.clientHeight - padT - padB;
    const contentH = modal.scrollHeight - padT - padB;
    L.push('  ── 弹窗内容 ── CSS height = ' + cs.height + '，可用高 ' + Math.round(boxH) +
      'px，内容高 ' + Math.round(contentH) + 'px' +
      (contentH > boxH + 1 ? '   ← 溢出 ' + Math.round(contentH - boxH) + 'px' : '   （放得下）'));
    L.push('    弹窗矩形 x ' + m.x + '–' + m.right + '  y ' + m.y + '–' + m.bottom);
  }
  post(L.join(String.fromCharCode(10)));
}
function setup() {
  const q = Q.get('scene') || 'archive';
  /* ★ 把面板钉到**稳态**再量。这些面板的 opacity 平时由 JS 逐帧驱动
     （淡入淡出 / 三维场景联动），无头浏览器 + 虚拟时间下不一定停在终值上，
     量出来就是"不可见"或半透明。这里直接按模式把该显示的那块钉成终值，
     量的才是"用户最终看到的版面"。 */
  const force = (sel, val) => { const el = document.querySelector(sel); if (el) el.style.opacity = String(val); };
  if (q === 'detail') {
    const du = document.querySelector('#detail-ui');
    if (du) du.hidden = false;
    force('#detail-content', 1);
    /* 详情面板的入场动画会给它挂 translateY(18px)，无头虚拟时间下不一定归零 ——
       不清掉的话量到的 y 会整体偏下 18px。 */
    const dc = document.querySelector('#detail-content');
    if (dc) dc.style.transform = 'none';
    force('#archive-ui', 0); // 档案阵列这时已经淡出，不该参与重叠统计
    force('.brand', 0);
    force('.system-nav', 0);
  } else {
    const du = document.querySelector('#detail-ui');
    if (du) du.hidden = true;
    force('#archive-ui', 1);
    force('.brand', 1);
    force('.system-nav', 1);
  }
  force('.system-footer', 1);
  if (Q.get('plist') !== '0') {
    const pl = document.querySelector('#player-playlist');
    if (pl) {
      pl.classList.add('open');
      /* 空库时列表里没有行，注入两行**同结构**的样例只为量行高（不写回产品） */
      if (!pl.querySelector('.p-row')) {
        const box = pl.querySelector('.p-rows') || pl;
        for (let i = 0; i < 2; i++) {
          const row = document.createElement('div');
          row.className = 'p-row' + (i === 0 ? ' active' : '');
          row.innerHTML = '<span class="p-idx">0' + (i + 1) + '</span>' +
            '<span class="p-meta"><b>样例曲目 / SAMPLE TRACK</b><small>艺术家 · 专辑 · 03:24</small></span>' +
            '<button class="p-fav">♡</button><button class="p-del">✕</button>';
          box.appendChild(row);
        }
        L.push('（列表里没有真实行，已注入 2 行同样式的样例用来量行高）');
      }
    }
  }
  if (Q.get('modal') === 'settings') {
    const btn = document.querySelector('[data-action="settings"]');
    if (btn) btn.click();
  }
  setTimeout(() => { report('第一次'); setTimeout(() => report('第二次（1.5 秒后）'), 1500); }, 6000);
}
setTimeout(setup, 5200);
</script>
`;

const out = raw.replace("</head>", probe + "</head>");
if (out === raw) { console.error("注入失败：index.html 里没有 </head>"); process.exit(3); }
const target = path.join(dist, "_layout.html");
fs.writeFileSync(target, out, "utf8");
console.log("已生成 " + target);
