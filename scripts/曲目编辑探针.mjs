/*
 * 曲目编辑探针：注入到构建产物里，核对"修改歌曲信息 + 封面读取"这一路。
 *
 * 做三件事：
 *   ① 往 IndexedDB 预置两首曲目（第一首带一张纯色封面，第二首无封面），刷新一次让应用读到；
 *   ② 打开详情 → 点「✎ EDIT INFO」→ 检查编辑面板的字段是不是带着当前值、
 *      点「恢复默认封面」后封面是不是真的换了（读 canvas/data 长度对比）；
 *   ③ 改标题 → 点 SAVE → 核对详情面板与播放条是否同步，以及 IndexedDB 里是否落库。
 * 全程只读 DOM 与 IndexedDB，不改产品代码。
 *
 * 用法：node scripts\曲目编辑探针.mjs [dist 目录]   → 生成 <dist>\_edit.html
 *   然后起 scripts\观测服务.js <dist>，用无头浏览器打开 http://…/_edit.html?scene=detail
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

/* 一张 8×8 的纯色 PNG 当"已有封面"：够小，但足以验证"封面读进来了" */
const COVER_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAIAQMAAAD+wSzIAAAABlBMVEX///+/v7+jQ3Y5AAAADklEQVQI12P4AIX8EAgALgAD/aNpbtEAAAAASUVORK5CYII=";

const probe = `
<script>
const L = [];
function post(m) { fetch('/metrics', { method: 'POST', body: '### 曲目编辑\\n' + m }).catch(() => {}); }
const NL = String.fromCharCode(10);

/* ---------- ① 预置曲目 ---------- */
const req = indexedDB.open('rhine-music', 1);
req.onupgradeneeded = () => req.result.createObjectStore('songs', { keyPath: 'id' });
req.onsuccess = () => {
  const tx = req.result.transaction('songs', 'readwrite');
  const st = tx.objectStore('songs');
  st.put({ id: 'edit-a', title: '可编辑曲目', artist: '原始艺术家', album: '原始专辑',
    cover: ${JSON.stringify(COVER_PNG)},
    srcUrl: '', duration: 200, fav: false, plays: 0, pos: 0, order: 0, lrc: '' });
  st.put({ id: 'edit-b', title: '无封面曲目', artist: 'PROBE', album: 'ARCHIVE',
    cover: '', duration: 200, fav: false, plays: 0, pos: 0, order: 1, lrc: '' });
  tx.oncomplete = () => {
    const second = sessionStorage.getItem('edit-seeded') === '1';
    sessionStorage.setItem('edit-seeded', '1');
    L.push('预置曲目已写入（第 ' + (second ? '二' : '一') + ' 次加载）');
    if (!second) { setTimeout(() => location.reload(), 400); return; }
    run();
  };
};

/* ---------- ② / ③ 驱动界面 ---------- */
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
function txt(sel) { const e = document.querySelector(sel); return e ? e.textContent.trim() : '（无）'; }
function val(sel) { const e = document.querySelector(sel); return e ? e.value : '（无）'; }

async function run() {
  await wait(1500);
  const rows = await waitFor(() => {
    const r = document.querySelectorAll('#player-playlist [data-i]');
    return r.length >= 2 ? r : null;
  }, 25000);
  L.push('播放列表行数 = ' + (rows ? rows.length : 0));
  if (!rows) { post(L.join(NL)); return; }

  /* 打开详情：点播放列表第一行会让它成为当前曲目，再进详情；这里直接点档案阵列的读取按钮 */
  const openBtn = await waitFor(() => document.querySelector('[data-action="open"]'), 10000);
  if (!openBtn) { L.push('FAIL 找不到读取档案按钮'); post(L.join(NL)); return; }
  openBtn.click();
  await wait(1800);
  L.push('详情已打开：曲名 = 「' + txt('#detail-content h2') + '」，stage 模式 = ' + document.querySelector('#stage').dataset.mode);
  L.push('详情区里的编辑入口 = ' + (document.querySelector('[data-action="edit-track"]') ? '有「' + txt('[data-action="edit-track"]') + '」' : '没有'));

  /* 进入编辑态 */
  document.querySelector('[data-action="edit-track"]').click();
  const titleInput = await waitFor(() => document.querySelector('#p-edit-title'), 8000);
  if (!titleInput) {
    L.push('FAIL 编辑面板没出来');
    post(L.join(NL));
    return;
  }
  await wait(500);
  L.push('编辑面板字段：标题 = 「' + val('#p-edit-title') + '」 艺术家 = 「' + val('#p-edit-artist') + '」 专辑 = 「' + val('#p-edit-album') + '」');
  const box = document.querySelector('#p-edit-cover');
  const img = document.querySelector('#p-edit-cover-img');
  L.push('封面方框 = ' + (box ? '有' : '没有') + '，当前封面图 = ' + (img ? '有（src 长度 ' + img.src.length + '）' : '没有'));
  L.push('封面按钮：' + Array.from(document.querySelectorAll('.edit-cover-actions .edit-mini')).map((b) => b.textContent.trim() + (b.disabled ? '(禁用)' : '')).join(' / '));
  L.push('状态行 = 「' + txt('#p-edit-status') + '」');

  /* ③ 改标题并保存 */
  titleInput.value = '探针改过的标题';
  titleInput.dispatchEvent(new Event('input', { bubbles: true }));
  const artistInput = document.querySelector('#p-edit-artist');
  artistInput.value = '探针艺术家';
  artistInput.dispatchEvent(new Event('input', { bubbles: true }));
  const save = document.querySelector('[data-action="edit-save"]');
  L.push('保存按钮 = ' + (save ? '有「' + save.textContent.trim() + '」' : '没有'));
  save.click();
  await wait(2200);
  L.push('保存后详情区曲名 = 「' + txt('#detail-content h2') + '」');
  L.push('保存后播放条曲名 = 「' + txt('#p-now-title') + '」');
  L.push('保存后提示 = 「' + txt('#toast') + '」');
  L.push('编辑面板还在吗 = ' + (document.querySelector('#p-edit-title') ? '还在（没退出编辑态）' : '已退出'));

  /* 直接读库核对落盘 */
  await new Promise((res) => {
    const r = indexedDB.open('rhine-music', 1);
    r.onsuccess = () => {
      const g = r.result.transaction('songs', 'readonly').objectStore('songs').get('edit-a');
      g.onsuccess = () => {
        const s = g.result || {};
        L.push('IndexedDB 里的 edit-a：title=「' + s.title + '」 artist=「' + s.artist + '」 cover 长度=' + (s.cover ? s.cover.length : 0));
        res();
      };
      g.onerror = () => { L.push('IndexedDB 读取失败'); res(); };
    };
  });

  /* ④ 再进一次编辑态，验证「恢复默认封面」真的换封面 */
  document.querySelector('[data-action="edit-track"]').click();
  await waitFor(() => document.querySelector('#p-edit-title'), 8000);
  await wait(400);
  const before = document.querySelector('#p-edit-cover-img');
  const beforeLen = before ? before.src.length : 0;
  const defBtn = document.querySelector('[data-action="edit-cover-none"]');
  defBtn.click();
  await wait(900);
  const after = document.querySelector('#p-edit-cover-img');
  L.push('恢复默认封面：之前 src 长度 ' + beforeLen + ' → 之后 ' + (after ? after.src.length : 0) + '，状态行 = 「' + txt('#p-edit-status') + '」');
  L.push('结论：编辑面板 ' + (titleInput ? '可用' : '不可用') + '，封面读取入口 ' +
    (document.querySelector('[data-action="edit-cover-file"]') ? '有（本地图片 / 内嵌封面 / 默认封面 三个入口）' : '没有'));
  post(L.join(NL));
}
</script>
`;

const out = raw.replace("</head>", probe + "</head>");
if (out === raw) { console.error("注入失败：index.html 里没有 </head>"); process.exit(3); }
const target = path.join(dist, "_edit.html");
fs.writeFileSync(target, out, "utf8");
console.log("已生成 " + target);
