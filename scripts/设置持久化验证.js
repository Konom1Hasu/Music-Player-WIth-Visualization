/* 界面设置持久化验证（离线跑，不需要 Electron）
   背景：可视化调音 5 个滑块 + 排序方式等偏好本该"全局通用、重启后保持"，
   但实际存在两类静默失败：
     · 写 A 读 B —— 滑块 setItem('mp_kick')，恢复却 getItem('mp_kick2')，
       mp_kick2 从来没被写过 → 每次重启鼓点强度静默回到默认值
     · 只读不写 —— 排序方式恢复时读 mp_sort，但 change 处理器只改变量没落盘
   两类都"不报错、不崩溃"，只是设置悄悄丢失，所以必须用静态交叉校验兜住。

   用法：node scripts\设置持久化验证.js app        （参数为 app 目录路径） */
'use strict';
const fs = require('fs');
const path = require('path');

const APP = path.resolve(process.argv[2] || path.join(__dirname, '..', 'app'));
const HTML = path.join(APP, 'index.html');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name); console.log('  ✗ ' + name + (extra ? '  →  ' + extra : '')); }
}
function lineOf(text, idx) { return text.slice(0, idx).split('\n').length; }

const src = fs.readFileSync(HTML, 'utf8');
if (!src) { console.log('读不到 ' + HTML); process.exit(1); }

/* ---------------------------------------------------------------- 1. 键名交叉校验 */
console.log('\n[1] localStorage 键名交叉校验（写 A 读 B / 只读不写 / 只写不读）');

const writes = new Map(), reads = new Map();
for (const m of src.matchAll(/localStorage\.setItem\(\s*'([^']+)'/g)) {
  if (!writes.has(m[1])) writes.set(m[1], []);
  writes.get(m[1]).push(lineOf(src, m.index));
}
for (const m of src.matchAll(/localStorage\.getItem\(\s*'([^']+)'/g)) {
  if (!reads.has(m[1])) reads.set(m[1], []);
  reads.get(m[1]).push(lineOf(src, m.index));
}

console.log('    写入键: ' + [...writes.keys()].sort().join(', '));
console.log('    读取键: ' + [...reads.keys()].sort().join(', '));

const readOnly = [...reads.keys()].filter(k => !writes.has(k)).sort();
const writeOnly = [...writes.keys()].filter(k => !reads.has(k)).sort();

ok('没有"只读不写"的键（会永远读不到默认值）', readOnly.length === 0,
  readOnly.join(', ') + (readOnly.length ? '  ← 恢复代码在读，但从来没有写过' : ''));
ok('没有"只写不读"的键（写了没人用 = 设置丢失）', writeOnly.length === 0,
  writeOnly.join(', ') + (writeOnly.length ? '  ← 滑块在写，但恢复代码没有读它' : ''));

/* 逐条报出可疑键的行号，便于定位 */
if (readOnly.length) {
  readOnly.forEach(k => console.log('      只读未写: ' + k + '  读于第 ' + reads.get(k).join(',') + ' 行'));
}
if (writeOnly.length) {
  writeOnly.forEach(k => console.log('      只写未读: ' + k + '  写于第 ' + writes.get(k).join(',') + ' 行'));
}

/* ---------------------------------------------------------------- 2. 每个滑块都要"存 + 恢复 + 回填 UI" */
console.log('\n[2] 调音滑块：保存 / 恢复 / 回填控件 三件事都要齐');

const sliders = [...src.matchAll(/<input[^>]*type="range"[^>]*id="([A-Za-z0-9_]+)"/g)].map(m => m[1]);
ok('找到了调音滑块', sliders.length > 0, '滑块: ' + sliders.join(', '));
console.log('    滑块: ' + sliders.join(', '));

/* 恢复区块：从 init 里第一处 getItem('mp_theme') 开始到脚本结束 */
const initIdx = src.indexOf("localStorage.getItem('mp_theme')");
const initBlock = initIdx >= 0 ? src.slice(initIdx) : '';

for (const id of sliders) {
  /* 2a. input 处理器里必须 setItem */
  const hIdx = src.indexOf("$('#" + id + "').addEventListener('input'");
  let saved = false, savedKey = '';
  if (hIdx >= 0) {
    const body = src.slice(hIdx, hIdx + 700);
    const sm = body.match(/localStorage\.setItem\(\s*'([^']+)'/);
    if (sm) { saved = true; savedKey = sm[1]; }
  }
  ok('  ' + id + ' 在 input 处理器里落盘', saved, saved ? '' : '没有找到 setItem');

  /* 2b. 恢复区块里必须读到同一个键，并且回填控件 */
  if (saved) {
    const key = savedKey;
    const inInit = initBlock.includes("getItem('" + key + "')");
    const fills = initBlock.includes("$('#" + id + "').value");
    ok('  ' + id + ' 恢复时读取同一个键 ' + key, inInit,
      inInit ? '' : '恢复区块里没有 getItem(' + key + ') —— 写的和读的对不上');
    ok('  ' + id + ' 恢复后回填控件显示值', fills,
      fills ? '' : '恢复了变量却没写回 $(\'#' + id + '\').value，界面会显示默认值');
  }
}

/* ---------------------------------------------------------------- 3. 下拉框也要回填 */
console.log('\n[3] 下拉框：恢复时要把值写回控件');

if (initBlock.includes("getItem('mp_sort')")) {
  const fillsSelect = initBlock.includes("$('#sortSel').value");
  ok('排序方式恢复后回填 #sortSel', fillsSelect,
    fillsSelect ? '' : '只设了 sortMode 变量，下拉框仍显示"添加顺序"，看起来像没保存');
} else {
  ok('排序方式在恢复区块里被读取', false, '找不到 mp_sort 的恢复代码');
}

/* 校验枚举型设置是否做了白名单，避免 localStorage 里的脏值把控件打空 */
ok('排序方式恢复时有白名单校验', /SORT_MODES\.indexOf\(sm\)/.test(initBlock) || /SORT_MODES\.some/.test(initBlock),
  '直接信任 localStorage 字符串会让下拉框落到空白项');
ok('可视化模式恢复时有白名单校验', /VIZ_MODES\.some\(/.test(initBlock));

/* ---------------------------------------------------------------- 4. 调音参数不得与单曲绑定 */
console.log('\n[4] 调音参数必须是全局的，且不被切歌流程重置');

const TUNE_VARS = ['tiltStrength', 'jitterK', 'kickPump', 'bassGainTarget', 'bassSigma'];

/* 用花括号配对取出若干"切歌/播放"函数的函数体 */
function bodyOf(fnName) {
  const i = src.indexOf('function ' + fnName + '(');
  if (i < 0) return '';
  const open = src.indexOf('{', i);
  if (open < 0) return '';
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(open, j + 1); }
  }
  return '';
}
const switchFns = ['selectSong', 'playAt', 'playRandom', 'nextSong', 'prevSong'];
let leaked = [];
for (const fn of switchFns) {
  const body = bodyOf(fn);
  if (!body) continue;
  for (const v of TUNE_VARS) {
    /* 只找"赋值"，不找比较（==） */
    const re = new RegExp('\\b' + v + '\\s*=(?!=)');
    if (re.test(body)) leaked.push(fn + '() 里改了 ' + v);
  }
}
ok('切歌/播放函数没有改动调音参数', leaked.length === 0, leaked.join('；'));

/* 调音参数的赋值必须都发生在滑块处理器或 apply* 函数里 */
const applies = ['applyBassSigma', 'applyJitterK', 'applyKickGain', 'applyPeakTarget', 'rebuildBandBoost'];
ok('调音参数有统一的 apply* 入口（便于恢复时复用同一条路径）',
  applies.every(fn => src.includes('function ' + fn + '(')),
  applies.filter(fn => !src.includes('function ' + fn + '(')).join(', '));

/* 恢复区块必须调用 apply*，而不是只改变量（否则 bandBoost 等派生量不重建） */
ok('恢复区块通过 apply* / rebuild 生效（不是只改变量）',
  applies.some(fn => initBlock.includes(fn + '(')),
  '恢复时只改变量会让 bandBoost 等派生结构停留在默认参数上');

/* ---------------------------------------------------------------- 5. 调音数据不写入单曲记录 */
console.log('\n[5] 调音数据不得写进单曲记录（否则就成了"每首歌一套"）');

const songFields = ['viz', 'tilt', 'bassw', 'kick', 'peakh', 'jit', 'bassSigma', 'kickPump', 'tiltStrength'];
const idbIdx = src.indexOf('function idbPut');
const idbBody = bodyOf('idbPut');
let perSong = [];
for (const f of songFields) {
  /* 在 idbPut 里出现的调音字段名，说明被当成单曲属性存了 */
  if (idbBody && new RegExp('\\b' + f).test(idbBody)) perSong.push(f);
}
ok('idbPut 没有把调音参数写进单曲记录', perSong.length === 0, perSong.join(', '));
ok('找到了单曲持久化函数 idbPut', idbIdx >= 0);

/* ---------------------------------------------------------------- 6. 恢复时的范围校验必须与滑块 min/max 一致 */
console.log('\n[6] 恢复时的范围闸门要和滑块的 min/max 对得上');

/* 滑块改了 min/max 却忘了改恢复时的 if 判断 → 用户拉到头的那一档会被静默丢弃，退回默认值 */
const initLines = initBlock.split('\n');
for (const id of sliders) {
  const tagM = src.match(new RegExp('<input[^>]*type="range"[^>]*id="' + id + '"[^>]*>'));
  if (!tagM) { ok('  ' + id + ' 找到标签', false); continue; }
  const tag = tagM[0];
  const min = Number((tag.match(/\bmin="(-?[\d.]+)"/) || [])[1]);
  const max = Number((tag.match(/\bmax="(-?[\d.]+)"/) || [])[1]);

  const keyM = src.slice(src.indexOf("$('#" + id + "').addEventListener('input'")).match(/localStorage\.setItem\(\s*'([^']+)'/);
  if (!keyM) { ok('  ' + id + ' 落盘键可解析', false); continue; }
  const key = keyM[1];

  /* 恢复语句可能是一行，也可能拆成多行（const 一行、if 一行），
     所以要从 getItem 那一行往后看几行，否则会误判成"没有范围闸门"。 */
  const at = initLines.findIndex(l => l.includes("getItem('" + key + "')"));
  if (at < 0) { ok('  ' + id + ' 恢复行可解析', false); continue; }
  const window = initLines.slice(at, at + 4).join('\n');

  const loM = window.match(/>=\s*(-?[\d.]+)/);
  const hiM = window.match(/<=\s*(-?[\d.]+)/);

  if (loM && hiM) {
    const lo = Math.min(Number(loM[1]), Number(hiM[1]));
    const hi = Math.max(Number(loM[1]), Number(hiM[1]));
    ok('  ' + id + ' 恢复闸门 [' + lo + ',' + hi + '] == 滑块 [' + min + ',' + max + ']',
      lo === min && hi === max,
      '不一致：滑块允许 ' + min + '~' + max + '，但恢复只接受 ' + lo + '~' + hi + '，边界值会被丢弃');
  } else {
    ok('  ' + id + ' 恢复行含范围校验', false, '恢复时没有范围闸门，脏值会直接进算法');
  }
}

/* ---------------------------------------------------------------- 结果 */
console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
if (fail) {
  console.log('\n失败项：');
  failures.forEach(f => console.log('  · ' + f.trim()));
}
process.exit(fail ? 1 : 0);
