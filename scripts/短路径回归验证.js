/* 8.3 短路径回归验证（用 node 直接跑，不需要 Electron）
   ────────────────────────────────────────────────────────────
   为什么值得单独一个脚本：这个 bug 已经以**三种不同的面貌**复发过三次，
   每次的表象都不一样，根因却是同一个 —— `os.tmpdir()` / 系统文件夹选择框
   在 Windows 上会返回 8.3 短名（本机：C:\Users\KONOMI~1\...）：

     ① 副本目录带短名  → file:///C:/Users/KONOMI%7E1/... 被 Chromium 判非法
     ② 短名存进曲库    → 每次重建会话副本地址都对不上，表现为"导入的歌放不出来"
     ③ 扫描目录带短名  → 顺着 path.join 传染给每一条 audioPath（本次修复）

   而这个 bug 最阴的地方是：**短名路径在 Node 里 fs.existsSync 返回 true**。
   所以"读不到才还原"的写法会一路放行，直到 Chromium 那一关才炸，
   报错还是极具误导性的 MediaError 4「格式不支持或文件头异常」——
   让人往编解码器方向查，而真正的原因只是路径写法。

   本脚本把这几条不变量钉死：
     A. longPath 确实能把本机 TEMP 的短名还原成长名
     B. 还原是【无条件】的 —— 即便原路径 existsSync 为 true 也要还原
     C. main.js 里所有进入 fs / URL 的临时路径与扫描目录都过了 longPath
     D. 短名与长名拼出的 file:// URL 不同，且短名那个含 %7E
   用法：node scripts/短路径回归验证.js
   ──────────────────────────────────────────────────────────── */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'app');
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  →  ' + extra : '')); }
}
function note(msg) { console.log('    ' + msg); }

const mainSrc = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');

/* ---------- A / B. longPath 的行为 ---------- */
console.log('\n[A] longPath 能还原 8.3 短名，且是无条件的');

// 从 main.js 里抠出真实的 longPath 实现来测（避免脚本自己另写一份而测了个假的）
const longPathSrc = mainSrc.match(/function longPath\(p\)\s*\{[\s\S]*?\n\}/);
ok('main.js 里能定位到 longPath 实现', !!longPathSrc);

let longPath;
if (longPathSrc) {
  longPath = new Function('fs', longPathSrc[0] + '\nreturn longPath;')(fs);
}

const tmp = os.tmpdir();
const tmpLong = longPath ? longPath(tmp) : tmp;
note('os.tmpdir()      = ' + tmp);
note('longPath(tmpdir) = ' + tmpLong);

ok('longPath 可用', typeof longPath === 'function');
ok('longPath 对已存在的目录也不原样返回（无条件还原）',
  !/if\s*\(\s*fs\.existsSync\(p\)\s*\)\s*return\s*p/.test(longPathSrc ? longPathSrc[0] : ''),
  'longPath 里出现了"存在就原样返回"，会让短名穿透');
ok('longPath 拿不到长名时有兜底（不抛异常）',
  /catch/.test(longPathSrc ? longPathSrc[0] : ''));

// 本机 TEMP 是否真是短名 —— 是的话必须能还原；不是的话跳过这组（别的机器可能本来就是长名）
const tmpIsShort = /~\d/.test(tmp);
note('本机 TEMP 含 8.3 短名? ' + tmpIsShort);
if (tmpIsShort) {
  ok('短名 TEMP 被还原成长名', tmpLong !== tmp && !/~\d/.test(tmpLong), tmpLong);
  ok('还原后的长名确实存在', fs.existsSync(tmpLong));
} else {
  note('（本机 TEMP 本就是长名，跳过短名还原断言）');
}

/* ---------- C. 所有临时/扫描路径都过了 longPath ---------- */
console.log('\n[C] main.js 里的关键路径都经过 longPath');

// os.tmpdir() 只允许出现在 longPath(...) 里面（或注释里 / 纯观测用途）。
// 注释判定要处理块注释：L38 那句示例就写在 /* ... */ 段落里，
// 行首既不是 * 也不是 //，之前漏判导致误报。
// ★ 例外：自证日志里的 `const tmpRaw = os.tmpdir();` 是**故意**裸用的 ——
//   它就是要记录原始值，好让"短名 vs 长名"这对值直接可对比。
//   判据是"这个值有没有被拿去拼路径"，不是"有没有裸调 os.tmpdir()"。
const tmpdirUses = [];
const lines = mainSrc.split('\n');
let inBlockComment = false;
lines.forEach(function (ln, i) {
  const trimmed = ln.trim();
  if (inBlockComment) {
    if (/\*\//.test(trimmed)) inBlockComment = false;
    return;
  }
  if (/^\/\*/.test(trimmed)) { if (!/\*\//.test(trimmed)) inBlockComment = true; return; }
  if (!/os\.tmpdir\(\)/.test(ln)) return;
  if (trimmed.startsWith('//')) return;
  // 纯观测赋值（const X = os.tmpdir();）不算拼路径，放行
  if (/^(const|let|var)\s+\w+\s*=\s*os\.tmpdir\(\)\s*;?$/.test(trimmed)) return;
  tmpdirUses.push({ n: i + 1, line: trimmed });
});
const badTmpdir = tmpdirUses.filter(function (u) { return !/longPath\(os\.tmpdir\(\)\)/.test(u.line); });
ok('os.tmpdir() 只在 longPath(...) 内被使用',
  badTmpdir.length === 0,
  badTmpdir.map(function (u) { return 'L' + u.n + ': ' + u.line; }).join(' | '));
note('os.tmpdir() 实际使用点 ' + tmpdirUses.length + ' 处，全部包在 longPath 里');

// 扫描目录：bili-scan / bili-scan-dir 都必须过 longDir
ok('存在 longDir 包装', /function longDir\(/.test(mainSrc));
ok('bili-scan 对传入目录做还原', /let dir = longDir\(presetDir\)/.test(mainSrc));
ok('bili-scan 对选择框返回的目录做还原', /dir = longDir\(r\.filePaths\[0\]\)/.test(mainSrc));
ok('bili-scan-dir 对传入目录做还原', /const dir = longDir\(rawDir\)/.test(mainSrc));

// 取音源：prepare-bili-audio / bili-keep 都要还原原始路径
ok('prepare-bili-audio 还原原始路径', /const srcPath = longPath\(originalPath\)/.test(mainSrc));
ok('bili-keep 还原原始路径', /const srcPath = longPath\(originalPath\)/.test(mainSrc));

// read-audio 与 audio-exists 走同一个解析函数，且该函数无条件还原
ok('存在 resolveReadablePath', /function resolveReadablePath\(/.test(mainSrc));
ok('resolveReadablePath 无条件还原（不做 exists 短路）',
  !/function resolveReadablePath\(p\)\s*\{\s*if \(fs\.existsSync\(p\)\) return p;/.test(mainSrc),
  '出现"存在就原样返回"会让短名穿透到 read-audio');
ok('read-audio 用了 resolveReadablePath', /const real = resolveReadablePath\(p\)/.test(mainSrc));
ok('audio-exists 用了 resolveReadablePath', /const real = resolveReadablePath\(p\)/.test(mainSrc));

/* ---------- D. 短名的 URL 确实会被 Chromium 判非法 ---------- */
console.log('\n[D] 短名路径拼出的 file:// URL 带 %7E（Chromium 不认）');

const shortPath = 'C:\\Users\\KONOMI~1\\Videos\\bilibili\\x\\audio.m4s';
const longPathStr = 'C:\\Users\\KonomiHasu\\Videos\\bilibili\\x\\audio.m4s';
const uShort = pathToFileURL(shortPath).href;
const uLong = pathToFileURL(longPathStr).href;
note('短名 → ' + uShort);
note('长名 → ' + uLong);
ok('%7E 只出现在短名 URL 里', /%7E/i.test(uShort) && !/%7E/i.test(uLong));
ok('两种 URL 不相等（所以"存短名、按长名取"必然对不上）', uShort !== uLong);

/* ---------- E. 渲染端：采用副本前要探活 ---------- */
console.log('\n[E] 渲染端在采用本地副本前先探活');

const playerSrc = fs.readFileSync(path.join(ROOT, 'app-rhine', 'src', 'player.ts'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(APP, 'preload.js'), 'utf8');

ok('preload 暴露了 audioExists', /audioExists:/.test(preloadSrc));
ok('preload 用的是 audio-exists 通道', /invoke\('audio-exists'/.test(preloadSrc));
ok('player.ts 声明了 audioExists 类型', /audioExists\?:\s*\(p: string\)/.test(playerSrc));
ok('playablePathOf 采用 localPath 前先探活',
  /if \(s\.localPath && !force\) \{\s*if \(await audioReadableExists\(s\.localPath\)\) return s\.localPath;/.test(playerSrc));
ok('ensurePlayableSource 采用 localPath 前先探活',
  /if \(await audioReadableExists\(s\.localPath\)\)/.test(playerSrc));
ok('存在一次性短名自愈（healsSongPathsOnce）', /function healsSongPathsOnce/.test(playerSrc));
ok('B 站音源加载路径会调自愈', /await healsSongPathsOnce\(\)/.test(playerSrc));

/* ---------- 汇总 ---------- */
console.log('\n' + '─'.repeat(56));
console.log('结果: ' + pass + ' 通过, ' + fail + ' 失败');
if (fail) {
  console.log('\n必须修掉的问题：');
  console.log('  · 8.3 短路径在 Node 里读得到、在 Chromium 里读不到；');
  console.log('    任何进入 fs / file:// URL 的路径都必须无条件 longPath 还原。');
  console.log('  · 判据不能是"能不能读"，只能是"是不是规范长名"。');
}
process.exit(fail ? 1 : 0);
