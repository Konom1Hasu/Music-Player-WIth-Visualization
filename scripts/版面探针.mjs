/*
 * 版面探针：把 app-rhine\dist\index.html 复制成 _layout.html，注入一段量版面的脚本，
 * 让它把"播放条 / 模型 / 页脚"的真实几何（getBoundingClientRect 归一化到 1920×1080 基准）
 * POST 回观测服务。用来回答"播放条到底压住了什么"这类问题 —— 比读截图可靠。
 *
 * 用法：node scripts\版面探针.mjs [dist 目录]
 *   然后起 scripts\观测服务.js <dist>，用无头浏览器打开 http://…/_layout.html?scene=archive&time=20
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
const L = [];
function rect(sel) {
  const el = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const k = 1920 / 1600;                       // 基准换算：把屏幕像素换成 1920×1080 基准
  const s = Math.min(innerWidth / 1920, innerHeight / 1080);
  const stage = document.querySelector('#stage').getBoundingClientRect();
  return {
    x: Math.round((r.left - stage.left) / s), y: Math.round((r.top - stage.top) / s),
    w: Math.round(r.width / s), h: Math.round(r.height / s),
    cs: { opacity: getComputedStyle(el).opacity, display: getComputedStyle(el).display, bottom: getComputedStyle(el).bottom },
  };
}
function report(tag) {
  const st = document.querySelector('#stage');
  L.push(tag + '：stage 模式 = ' + st.dataset.mode + '，缩放 = ' + (Math.min(innerWidth / 1920, innerHeight / 1080)).toFixed(4) + '，视口 = ' + innerWidth + 'x' + innerHeight);
  const items = [
    ['播放条 #player-bar', '#player-bar'],
    ['  ↳ 播放列表 #player-playlist', '#player-playlist'],
    ['  ↳ 进度条 #p-seek', '#p-seek'],
    ['  ↳ 曲名 #p-now-title', '#p-now-title'],
    ['档案信息 .archive-callout', '.archive-callout'],
    ['读取按钮 .read-file', '.read-file'],
    ['系统页脚 .system-footer', '.system-footer'],
    ['页脚文字 .powered', '.powered'],
    ['系统导航 .system-nav', '.system-nav'],
    ['三维画布 #scene canvas', '#scene canvas'],
    ['详情面板 #detail-content', '#detail-content'],
  ];
  for (const [name, sel] of items) {
    const r = rect(sel);
    if (!r) { L.push(name + ' = 不存在'); continue; }
    L.push(name + '：x ' + r.x + '–' + (r.x + r.w) + '  y ' + r.y + '–' + (r.y + r.h) +
      '  (' + r.w + '×' + r.h + ')  opacity=' + r.cs.opacity + ' bottom=' + r.cs.bottom);
  }
  /* 播放条与其它元素的重叠：直接算出重叠面积，避免靠眼睛判断 */
  const bar = document.querySelector('#player-bar');
  if (bar) {
    const b = bar.getBoundingClientRect();
    const others = document.querySelectorAll('.archive-callout, .read-file, .file-summary, .system-footer, .powered, .system-nav, #scene canvas, .archive-counter');
    for (const o of others) {
      const r = o.getBoundingClientRect();
      const ox = Math.max(0, Math.min(b.right, r.right) - Math.max(b.left, r.left));
      const oy = Math.max(0, Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top));
      L.push('重叠检查：播放条 × ' + (o.className || o.id) + ' = ' + Math.round(ox) + '×' + Math.round(oy) + ' px²' +
        (ox > 0 && oy > 0 ? '   ← 有重叠' : ''));
    }
    /* 播放条是否越出舞台 */
    const sr = document.querySelector('#stage').getBoundingClientRect();
    L.push('播放条相对舞台：下边界距舞台底部 ' + Math.round(sr.bottom - b.bottom) + 'px，上边界距舞台顶部 ' + Math.round(b.top - sr.top) + 'px');
  }
  post(L.join(String.fromCharCode(10)));
  L.length = 0;
}
setTimeout(() => { report('第一次'); setTimeout(() => { report('第二次（1.5 秒后）'); }, 1500); }, 6000);
</script>
`;

const out = raw.replace("</head>", probe + "</head>");
if (out === raw) { console.error("注入失败：index.html 里没有 </head>"); process.exit(3); }
const target = path.join(dist, "_layout.html");
fs.writeFileSync(target, out, "utf8");
console.log("已生成 " + target);
