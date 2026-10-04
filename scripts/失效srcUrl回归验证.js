/* 失效 srcUrl 回归验证 —— 钉死"曲库里存的临时会话 URL 不许被当成音源"
   ------------------------------------------------------------------
   真实事故：《scualee》的曲库记录里存着
     srcUrl = file:///C:/Users/KONOMI~1/AppData/Local/Temp/mp-session-07c53b8c53d7/audio/569855752567af80.m4a
     path   = C:/Users/KonomiHasu/Videos/bilibili/1262356264/1262356264-1-30280.m4s
   localPath 为空。播放时旧逻辑拿 srcUrl 硬当路径 → 报
     "无法播放:格式不支持或文件头异常(MediaError 4) / 文件不存在:...569855752567af80.m4a"
   且因为记录从不被重写，报错**一个字节都不变**。

   这个脚本锁定三件事：
     A. isStaleSessionPath 能识别 mp-session-* 路径（含短名）
     B. playablePathOf / blobUrlOf 不再无条件信任 srcUrl
     C. healsSongPathsOnce 会清掉失效 srcUrl
*/
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'app-rhine', 'src', 'player.ts'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
console.log('=== 失效 srcUrl 回归验证 ===\n');

/* ---- A. 复刻 isStaleSessionPath 并实测 ---- */
const m = /function isStaleSessionPath\(p: string\): boolean \{\s*return (\/.*?\/i)\.test\(String\(p \|\| ""\)\);\s*\}/s.exec(src);
ok('A1 源码里能找到 isStaleSessionPath', !!m, m ? '' : '函数定义没匹配到');
if (m) {
  const re = eval(m[1]);
  const stale = [
    'C://Users//KONOMI~1//AppData//Local//Temp//mp-session-07c53b8c53d7//audio//569855752567af80.m4a',
    'file:///C:/Users/KONOMI~1/AppData/Local/Temp/mp-session-07c53b8c53d7/audio/569855752567af80.m4a',
    'C://Users//KonomiHasu//AppData//Local//Temp//mp-session-ba5499019d32//audio//x.m4a',
  ];
  const fine = [
    'C://Users//KonomiHasu//Videos//bilibili//1262356264//1262356264-1-30280.m4s',
    'C://Users//KonomiHasu//AppData//Roaming//music-player//library//audio//abc.m4a',
    '/home/u/Music/a.mp3',
  ];
  let allStale = true, allFine = true;
  for (const p of stale) if (!re.test(p)) { allStale = false; console.log('    漏判（应判失效）: ' + p); }
  for (const p of fine) if (re.test(p)) { allFine = false; console.log('    误判（应放行）: ' + p); }
  ok('A2 短名 + 已消失会话的路径被判定为失效', allStale);
  ok('A3 正常的源缓存 / 本地副本路径不被误判', allFine);
  ok('A4 当前会话的 mp-session 路径同样判失效（临时目录本来就不该持久化）',
     re.test('C://Users//KonomiHasu//AppData//Local//Temp//mp-session-ba5499019d32//a.m4a'));
}

/* ---- B. playablePathOf 不再碰 srcUrl ---- */
const ppo = /async function playablePathOf[\s\S]*?\n\}/.exec(src);
ok('B1 找到 playablePathOf', !!ppo);
if (ppo) {
  ok('B2 playablePathOf 内部不再出现 fileUrlToPath(s.srcUrl)',
     !/fileUrlToPath\(s\.srcUrl/.test(ppo[0]));
}

/* ---- C. blobUrlOf 每一环都探活 ---- */
const buo = /async function blobUrlOf[\s\S]*?\n\}/.exec(src);
ok('C1 找到 blobUrlOf', !!buo);
if (buo) {
  const body = buo[0];
  ok('C2 blobUrlOf 不再有 `|| fileUrlToPath(s.srcUrl) ||` 这种裸兜底',
     !/\|\|\s*fileUrlToPath\(s\.srcUrl/.test(body));
  ok('C3 srcUrl 反解出的路径必须过 isStaleSessionPath',
     /isStaleSessionPath\(cached\)/.test(body));
  ok('C4 srcUrl 反解出的路径必须过 audioReadableExists（探活）',
     /audioReadableExists\(cached\)/.test(body));
  ok('C5 s.path 兜底也必须探活', /audioReadableExists\(raw\)/.test(body));
  ok('C6 拿不到音源时给出明确原因（不是伪装成格式错误）',
     /源缓存已被删除，本地副本也不在/.test(body));
}

/* ---- D. healsSongPathsOnce 清洗失效 srcUrl ---- */
const heal = /async function healsSongPathsOnce[\s\S]*?\n\}/.exec(src);
ok('D1 找到 healsSongPathsOnce', !!heal);
if (heal) {
  ok('D2 会检测并清掉失效的 srcUrl',
     /isStaleSessionPath\(asPath\)/.test(heal[0]) && /s\.srcUrl = undefined/.test(heal[0]));
}

/* ---- E. probeDuration 不再拿失效 URL 去试 ---- */
const pd = /function probeDuration[\s\S]*?\n\}/.exec(src);
ok('E1 找到 probeDuration', !!pd);
if (pd) {
  ok('E2 probeDuration 先判 srcUrl 是否失效再决定用不用',
     /isStaleSessionPath\(fileUrlToPath\(s\.srcUrl/.test(pd[0]));
}

/* ---- F. loadSongAudio 判据用 s.path ---- */
const lsa = /function loadSongAudio[\s\S]*?\n\}/.exec(src);
ok('F1 找到 loadSongAudio', !!lsa);
if (lsa) {
  ok('F2 异步装载的判据含 s.path（不只看 srcUrl）',
     /if \(s\.path \|\| s\.srcUrl\)/.test(lsa[0]));
}

/* ---- G. 别把"被别的验证脚本当作检查对象"的产物换掉 ----
   教训：曾把 app/index.html（170KB 自包含旧界面）换成几行的转发页，
   自以为"更干净"，结果 设置持久化验证.js 就是读这个文件的
   （它靠正则从里面抠滑块 / 白名单 / apply* 入口），当场 7 项失败。
   → app/index.html 是 **有下游依赖的产物**，不许随意替换形态。 */
const idxPath = path.join(root, 'app', 'index.html');
ok('G1 app/index.html 存在', fs.existsSync(idxPath));
if (fs.existsSync(idxPath)) {
  const idx = fs.readFileSync(idxPath, 'utf8');
  ok('G2 app/index.html 保持"自包含界面"形态（不是几行的转发页）',
     idx.length > 50000, '当前 ' + idx.length + ' 字节，疑似被替换成转发页');
  ok('G3 app/index.html 仍含 设置持久化验证.js 依赖的滑块定义',
     idx.indexOf('bassSlider') >= 0 || idx.indexOf('kickSlider') >= 0);
}
/* UI 服务的真正入口是 app/ui/——它指到的 bundle 必须真实存在 */
const uiIdx = path.join(root, 'app', 'ui', 'index.html');
if (fs.existsSync(uiIdx)) {
  const h = fs.readFileSync(uiIdx, 'utf8');
  /* ★ 字符类必须含连字符：vite 的产物哈希用 base64url 字符集（含 - 和 _），
     像 index-qM-vfg_b.js 这种名字，写成 [A-Za-z0-9_]+ 会匹配不上，
     让这条检查变成"没找到 bundle 引用"的误报。 */
  const m = /index-[\w-]+\.js/.exec(h);
  ok('G4 app/ui/index.html 引用的 bundle 真的在 assets 里', !!m && fs.existsSync(path.join(root, 'app', 'ui', 'assets', m[0])),
     m ? ('引用 ' + m[0]) : '没找到 bundle 引用');
  const jsFiles = fs.readdirSync(path.join(root, 'app', 'ui', 'assets')).filter((x) => /^index-.*\.js$/.test(x));
  ok('G5 app/ui/assets 下只留一个 index-*.js（旧产物已清，避免加载到旧的）',
     jsFiles.length === 1, '实际: ' + jsFiles.join(', '));
}

console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
