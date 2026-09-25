/*
 * 删除歌曲探针：核对"播放列表里点 ✕ 移除"这一路是不是真的生效。
 *
 * 流程：预置 3 首 → 刷新 → 打开播放列表 → 读行数 → 点第 2 行的 ✕ →
 *      再读行数 / IndexedDB / 播放条，判断"删掉了没有、删干净了没有"。
 * 同时捕获页面报错（脚本注入在 </head> 之后，能第一时间拿到 error 事件）。
 *
 * 用法：node scripts\删除歌曲探针.mjs [dist 目录]   → 生成 <dist>\_del.html
 *   起 scripts\观测服务.js <dist>，无头浏览器打开 http://…/_del.html
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
const L = [];
const NL = String.fromCharCode(10);
function post(m) { fetch('/metrics', { method: 'POST', body: '### 删除歌曲\\n' + m }).catch(() => {}); }
window.addEventListener('error', (e) => {
  L.push('页面错误：' + e.message + ' @ ' + (e.filename || '?') + ':' + (e.lineno || '?'));
});
const req = indexedDB.open('rhine-music', 1);
req.onupgradeneeded = () => req.result.createObjectStore('songs', { keyPath: 'id' });
req.onsuccess = () => {
  const tx = req.result.transaction('songs', 'readwrite');
  const st = tx.objectStore('songs');
  for (let i = 0; i < 3; i++) {
    st.put({ id: 'del-' + i, title: '待删曲目 ' + (i + 1), artist: 'PROBE', album: 'ARCHIVE',
      cover: '', duration: 100, fav: false, plays: 0, pos: 0, order: i, lrc: '' });
  }
  tx.oncomplete = () => {
    if (sessionStorage.getItem('del-seeded') !== '1') {
      sessionStorage.setItem('del-seeded', '1');
      setTimeout(() => location.reload(), 400);
      return;
    }
    run();
  };
};
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(fn, ms) {
  const t0 = performance.now();
  for (;;) {
    let v = null;
    try { v = fn(); } catch (e) { v = null; }
    if (v) return v;
    if (performance.now() - t0 > ms) return null;
    await wait(120);
  }
}
function rows() { return document.querySelectorAll('#player-playlist .p-row'); }
function dbCount() {
  return new Promise((res) => {
    const r = indexedDB.open('rhine-music', 1);
    r.onsuccess = () => {
      const g = r.result.transaction('songs', 'readonly').objectStore('songs').getAll();
      g.onsuccess = () => res((g.result || []).map((s) => s.id));
      g.onerror = () => res(null);
    };
    r.onerror = () => res(null);
  });
}
async function run() {
  await wait(1500);
  const list = await waitFor(() => document.querySelectorAll('#player-playlist').length ? 1 : null, 20000);
  L.push('播放列表容器 = ' + (list ? '有' : '没有'));
  /* 打开播放列表 */
  const openBtn = document.querySelector('#p-list');
  L.push('☰ 按钮 = ' + (openBtn ? '有' : '没有'));
  if (openBtn) openBtn.click();
  await wait(600);
  const openCls = document.querySelector('#player-playlist').classList.contains('open');
  L.push('点 ☰ 后列表 open = ' + openCls + '，行数 = ' + rows().length);
  /* 也试试点播放条上的标题区域，看列表是不是被别的东西关掉了 */
  const before = await dbCount();
  L.push('删除前 IndexedDB = [' + (before || []).join(', ') + ']');

  const btn = document.querySelector('#player-playlist .p-row:nth-child(3) .p-del');
  L.push('第 2 行的 ✕ 按钮 = ' + (btn ? '有（title=' + btn.getAttribute('title') + '，data-del=' + btn.getAttribute('data-del') + '）' : '没有'));
  if (!btn) { post(L.join(NL)); return; }
  /* 先报告点击前的几何：万一它被别的东西盖住，尺寸/坐标能看出来 */
  const r = btn.getBoundingClientRect();
  const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  L.push('✕ 的几何 = ' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) +
    '，该点最上层元素 = ' + (at ? (at.id || at.className || at.tagName) : 'null') +
    '（是 ✕ 本身吗：' + (at === btn ? '是' : '不是') + '）');
  btn.click();
  await wait(1200);
  const after = await dbCount();
  L.push('点 ✕ 之后：行数 = ' + rows().length + '，IndexedDB = [' + (after || []).join(', ') + ']');
  const remains = (after || []).includes('del-1');
  L.push('结论：' + (!remains ? '删除生效（del-1 已从库与列表里消失）' : '删除没生效（del-1 还在库里）'));

  /* 再试一次：删"当前正在播放的那一首"，走另一条分支 */
  const firstRow = rows()[0];
  if (firstRow) {
    firstRow.click();               // 点行 → 播放这首
    await wait(1200);
    const cur = (document.querySelector('#p-now-title') || {}).textContent || '';
    L.push('点第一行后播放条 = 「' + cur + '」');
    const del2 = document.querySelector('#player-playlist .p-row .p-del');
    if (del2) {
      L.push('当前曲目的 id = ' + del2.getAttribute('data-del'));
      del2.click();
      await wait(1500);
      const after2 = await dbCount();
      const cur2 = (document.querySelector('#p-now-title') || {}).textContent || '';
      L.push('删当前曲目后：行数 = ' + rows().length + '，库里 = [' + (after2 || []).join(', ') + ']，播放条 = 「' + cur2 + '」');
    }
  }
  L.push('页面错误累计 = ' + L.filter((x) => x.indexOf('页面错误') === 0).length);
  post(L.join(NL));
  setTimeout(() => post('（1.5 秒后复核）行数 = ' + rows().length), 1500);
}
</script>
`;

const out = raw.replace("</head>", probe + "</head>");
if (out === raw) { console.error("注入失败：index.html 里没有 </head>"); process.exit(3); }
const target = path.join(dist, "_del.html");
fs.writeFileSync(target, out, "utf8");
console.log("已生成 " + target);
