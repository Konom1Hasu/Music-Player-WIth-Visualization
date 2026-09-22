/* 文档一致性验证（离线跑，不需要 Electron）
   目的：把「代码改了、文档忘了改」变成**会失败的检查**，而不是靠记性。

   检查项（ERROR = 让检查失败，WARN = 只提示）：
     [1] app/package.json 的版本号在 docs\更新日志.md 里有对应的 `## [x.y.z]` 段落
     [2] README 顶部「当前版本 vX.Y.Z」与 package.json 一致
     [3] 更新日志的版本号严格递减（倒序排列）
     [4] README 的「项目结构」区块提到了每一个受版本管理的顶层条目
     [5] README 的「项目结构」区块提到了 scripts\ 与 docs\ 下的每一个文件
     [6] README 的「文档」小节链接到的文件都真实存在
     [7] README 与 docs\*.md 里的相对 Markdown 链接都能解析到真实文件
     [8] package.json 的版本号已经有对应的 git 标签（WARN，发布脚本会自动打）

   用法：node scripts\文档一致性验证.js            （默认检查仓库根目录）
        node scripts\文档一致性验证.js <仓库根>   */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));

let errors = 0, warns = 0, checked = 0;
const problems = [];

function ok(name)          { checked++; console.log('  ✓ ' + name); }
function bad(name, why)    { checked++; errors++; problems.push(name + '  →  ' + why); console.log('  ✗ ' + name + '  →  ' + why); }
function warn(name, why)   { warns++; console.log('  ! ' + name + '  →  ' + why); }

function read(p) { return fs.readFileSync(p, 'utf8'); }
function exists(p) { try { fs.accessSync(p); return true; } catch (e) { return false; } }

/* 受版本管理的文件。
   这里**故意不走 git 子进程**：有些受限环境禁止 Node 以管道方式 spawn 子进程
   （表现为 spawnSync git EPERM），那样检查会静默退化。改成直接遍历文件系统，
   跳过 .git / dist / node_modules —— 结果一致，而且到哪都能跑。 */
function trackedFiles() {
    const SKIP = new Set(['.git', 'dist', 'node_modules', '.vscode', '.idea']);
    const acc = [];
    (function walk(d) {
        let list = [];
        try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const e of list) {
            if (SKIP.has(e.name)) continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else acc.push(path.relative(ROOT, p).replace(/\\/g, '/'));
        }
    })(ROOT);
    return acc;
}

/* 读 git 标签：同样不 spawn git —— 直接读 .git\refs\tags\ 与 .git\packed-refs。
   这两种都是普通文本文件，读起来没有任何依赖。 */
function readGitTags() {
    const tags = new Set();
    const gitDir = path.join(ROOT, '.git');
    if (!exists(gitDir)) return { ok: false, tags: [] };

    const refsDir = path.join(gitDir, 'refs', 'tags');
    if (exists(refsDir)) {
        (function walk(d, prefix) {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) walk(p, prefix ? prefix + '/' + e.name : e.name);
                else tags.add(prefix ? prefix + '/' + e.name : e.name);
            }
        })(refsDir, '');
    }

    const packed = path.join(gitDir, 'packed-refs');
    if (exists(packed)) {
        for (const line of read(packed).split('\n')) {
            const m = line.match(/^[0-9a-f]{40}\s+refs\/tags\/(.+)$/);
            if (m) tags.add(m[1].replace(/\^\{\}$/, ''));
        }
    }
    return { ok: true, tags: [...tags] };
}

const tracked = trackedFiles();
const pkgPath = path.join(ROOT, 'app', 'package.json');
const logPath = path.join(ROOT, 'docs', '更新日志.md');
const readmePath = path.join(ROOT, 'README.md');

const pkg = JSON.parse(read(pkgPath));
const log = read(logPath);
const readme = read(readmePath);

console.log('');
console.log('仓库: ' + ROOT);
console.log('版本: ' + pkg.version);

/* ---------------------------------------------------------------- 1. 版本号 ↔ 更新日志 */
console.log('\n[1] 版本号与更新日志对应');
const versionHeadings = [...log.matchAll(/^##\s*\[([0-9]+\.[0-9]+\.[0-9]+)\]/gm)].map(m => m[1]);
ok('更新日志里有 ' + versionHeadings.length + ' 个版本段落：' + versionHeadings.join(', '));

const curInLog = versionHeadings.indexOf(pkg.version) >= 0;
if (curInLog) ok('package.json 的 ' + pkg.version + ' 在更新日志里有段落');
else bad('package.json 的 ' + pkg.version + ' 在更新日志里有段落',
        'docs\\更新日志.md 里找不到 `## [' + pkg.version + ']`，发布必须补上这一段');

/* 版本段落不能只有标题没有内容 */
for (const v of versionHeadings) {
    const re = new RegExp('^##\\s*\\[' + v.replace(/\./g, '\\.') + '\\]([\\s\\S]*?)(?=^##\\s|\\Z)', 'm');
    const m = log.match(re);
    if (m) {
        const body = m[1].trim();
        if (body.length < 40) bad('版本 ' + v + ' 的段落有实际内容', '只有 ' + body.length + ' 个字符，像是占位没写');
    }
}
if (errors === 0) ok('所有版本段落都有实质内容');

/* ---------------------------------------------------------------- 2. README 版本号 */
console.log('\n[2] README 标注的版本号');
const rm = readme.match(/\*\*当前版本\s*v([0-9]+\.[0-9]+\.[0-9]+)\*\*/);
if (!rm) bad('README 顶部标注了当前版本号', '找不到 `**当前版本 vX.Y.Z**`');
else if (rm[1] !== pkg.version) bad('README 的版本号与 package.json 一致', 'README 写的是 v' + rm[1] + '，package.json 是 ' + pkg.version);
else ok('README 顶部版本号 v' + rm[1] + ' 与 package.json 一致');

/* ---------------------------------------------------------------- 3. 版本号递减 */
console.log('\n[3] 更新日志的版本号顺序');
function cmpSemver(a, b) {
    const A = a.split('.').map(Number), B = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) { if (A[i] !== B[i]) return A[i] - B[i]; }
    return 0;
}
let desc = true, badPair = '';
for (let i = 1; i < versionHeadings.length; i++) {
    if (cmpSemver(versionHeadings[i - 1], versionHeadings[i]) <= 0) { desc = false; badPair = versionHeadings[i - 1] + ' 在 ' + versionHeadings[i] + ' 之前'; break; }
}
const dups = versionHeadings.filter((v, i) => versionHeadings.indexOf(v) !== i);
if (!desc) bad('更新日志按版本号从新到旧排列', badPair + '（最新的版本段落必须在最上面）');
else ok('更新日志按版本号从新到旧排列');
if (dups.length) bad('没有重复的版本段落', '重复：' + [...new Set(dups)].join(', '));
else ok('没有重复的版本段落');

/* ---------------------------------------------------------------- 4/5. README 项目结构覆盖度 */
console.log('\n[4] README「项目结构」是否跟上仓库变化');
const structM = readme.match(/##\s*项目结构[\s\S]*?```([\s\S]*?)```/);
if (!structM) {
    bad('README 里有「项目结构」代码块', '找不到 `## 项目结构` 后面的围栏代码块');
} else {
    const block = structM[1];

    /* 4a. 顶层条目（跳过点文件，它们算配置文件不单独列） */
    const topLevel = [...new Set(tracked.map(f => f.split('/')[0]))]
        .filter(n => !n.startsWith('.'))
        .filter(n => n !== 'dist');   // dist 是构建产物，结构图里以 dist/ 形式出现
    const missingTop = topLevel.filter(n => !block.includes(n));
    if (missingTop.length === 0) ok('顶层条目都出现在结构图里（' + topLevel.length + ' 项）');
    else bad('顶层条目都出现在结构图里', '结构图里没有：' + missingTop.join(', '));

    /* 4b. scripts/ 与 docs/ 下的每个文件 */
    for (const dir of ['scripts', 'docs']) {
        const files = tracked.filter(f => f.startsWith(dir + '/')).map(f => path.basename(f));
        const missing = files.filter(n => !block.includes(n));
        if (missing.length === 0) ok(dir + '/ 下 ' + files.length + ' 个文件都出现在结构图里');
        else bad(dir + '/ 下 ' + files.length + ' 个文件都出现在结构图里', '结构图里没有：' + missing.join(', '));
    }

    /* 4c. 结构图里提到但仓库里不存在的文件（反向检查，防止改名后留下幽灵条目）
       注意备选分支要把长扩展名排在前面，否则 package.json 会被 js 分支截成
       "package.js" 从而误报幽灵条目。 */
    const ghost = [];
    const nameRe = /([A-Za-z0-9_.\-\u4e00-\u9fff]+\.(?:json|html|ps1|bat|exe|md|js))/g;
    const known = new Set(tracked.map(f => path.basename(f)));
    for (const m of block.matchAll(nameRe)) {
        const n = m[1];
        if (!known.has(n) && n !== '音乐播放器.exe') ghost.push(n);
    }
    if (ghost.length === 0) ok('结构图里没有"仓库里不存在的文件"');
    else bad('结构图里没有"仓库里不存在的文件"', '幽灵条目：' + [...new Set(ghost)].join(', '));
}

/* ---------------------------------------------------------------- 6. README 文档链接 */
console.log('\n[6] README 引用的文档');
const docSec = readme.match(/##\s*文档[\s\S]*?(?=\n##\s|\Z)/);
if (!docSec) warn('README 有「文档」小节', '找不到，跳过');
else {
    const links = [...docSec[0].matchAll(/\]\(([^)]+)\)/g)].map(m => m[1]);
    const broken = links.filter(l => !exists(path.resolve(ROOT, l)));
    if (links.length === 0) warn('README「文档」小节列出了文档', '一个链接都没有');
    else if (broken.length === 0) ok('README「文档」小节 ' + links.length + ' 个链接都有效');
    else bad('README「文档」小节链接都有效', '失效：' + broken.join(', '));
}

/* ---------------------------------------------------------------- 7. 全部相对链接 */
console.log('\n[7] README 与 docs 里的相对链接');
const mdFiles = tracked.filter(f => f.endsWith('.md'));
let linkTotal = 0; const linkBroken = [];
for (const rel of mdFiles) {
    const abs = path.join(ROOT, rel);
    const txt = read(abs);
    for (const m of txt.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^(https?:|mailto:|#)/.test(target)) continue;
        linkTotal++;
        const clean = target.split('#')[0];
        if (!clean) continue;
        const resolved = path.resolve(path.dirname(abs), clean);
        if (!exists(resolved)) linkBroken.push(rel + ' → ' + target);
    }
}
if (linkBroken.length === 0) ok(mdFiles.length + ' 个 Markdown 文件里 ' + linkTotal + ' 个相对链接全部有效');
else bad('所有相对链接都有效', '失效 ' + linkBroken.length + ' 个：\n        ' + linkBroken.join('\n        '));

/* ---------------------------------------------------------------- 8. git 标签 */
console.log('\n[8] 版本标签');
const tagInfo = readGitTags();
if (!tagInfo.ok) warn('能读到 git 标签', '这不是 git 仓库（没有 .git），跳过');
else if (tagInfo.tags.length === 0) warn('能读到 git 标签', '.git 里还没有任何标签');
else {
    const tags = tagInfo.tags;
    const want = 'v' + pkg.version;
    if (tags.includes(want)) ok('当前版本 ' + want + ' 已有标签');
    else warn('当前版本 ' + want + ' 已有标签', '还没有打标签 —— 运行 scripts\\发布.ps1 会自动打');

    const noLog = tags.filter(t => /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(t) && !versionHeadings.includes(t.slice(1)));
    if (noLog.length) warn('每个标签都有对应的更新日志段落', '这些标签没有段落：' + noLog.join(', '));
    else ok('每个版本标签都有对应的更新日志段落');
}

/* ---------------------------------------------------------------- 结果 */
console.log('');
console.log('检查 ' + checked + ' 项：' + (checked - errors) + ' 通过, ' + errors + ' 失败' + (warns ? '（另有 ' + warns + ' 条提示）' : ''));
if (errors) {
    console.log('\n必须修掉的 ' + errors + ' 处不一致：');
    problems.forEach(p => console.log('  · ' + p));
    console.log('\n提示：改完再跑一次；发布流程（scripts\\发布.ps1）会自动跑本检查。');
}
process.exit(errors ? 1 : 0);
