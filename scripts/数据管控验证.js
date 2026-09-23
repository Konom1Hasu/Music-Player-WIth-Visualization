/* 数据管控的离线验证脚本（用 node 直接跑，不需要 Electron）
   验证四件事：
     1. 派生音频副本确实落在"调用方指定的会话目录"，而不是 userData
     2. 擦除逻辑（覆盖写零 + 删除）真的把内容抹掉，且目录被删除
     3. 陈旧会话目录清扫有效
     4. 静态断言：没有任何 IPC 能把派生数据写到调用方指定的路径
   用法：node 源码测试.js   （在 app 目录下，或传 app 目录路径） */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const APP = path.resolve(process.argv[2] || path.join(__dirname, '..', 'app'));
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  →  ' + extra : '')); }
}

/* ---------- 1. ensureM4a 写到指定目录 ---------- */
console.log('\n[1] B 站可播放副本的落盘位置');
const bili = require(path.join(APP, 'bili.js'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dctest-'));
const fakeCache = path.join(work, 'cache');
const sessDir = path.join(work, 'mp-session-abc', 'audio');
fs.mkdirSync(fakeCache, { recursive: true });

// 造一个带"前置私有头 + mp4 头"的假 m4s：前面的垃圾字节会被剥掉
const head = Buffer.from('BILI-PRIVATE-HEADER-'.repeat(64));   // 1280 字节噪声
const moov = Buffer.alloc(4096, 7);
const src = path.join(fakeCache, 'audio.m4s');
fs.writeFileSync(src, Buffer.concat([head, moov]));

const out1 = bili.ensureM4a(src, sessDir);
ok('ensureM4a 返回了路径', !!out1, out1);
ok('副本落在传入的会话目录内', !!out1 && path.dirname(path.resolve(out1)) === path.resolve(sessDir),
  out1 && path.dirname(path.resolve(out1)));
ok('副本不在 userData 里', !out1 || out1.indexOf('bili_audio') === -1);
ok('副本文件真实存在且非空', !!out1 && fs.existsSync(out1) && fs.statSync(out1).size > 0);

/* ---------- 2. 擦除逻辑 ---------- */
console.log('\n[2] 擦除逻辑（覆盖写零 + 删除）');
/* 从真实源码里摘出擦除相关实现来跑 —— 测的是"即将发布的代码文本"，
   而不是另写一份复制品。 */
const mainSrc = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
const start = mainSrc.indexOf('const WIPE_BUDGET');
const endMark = 'function shutdownSessionTmp()';
const end = mainSrc.indexOf(endMark);
if (start < 0 || end < 0) { console.log('  ✗ 无法从 main.js 定位擦除实现'); process.exit(1); }
/* main.js 的工作区副本是 CRLF，所以不能写死 '\n}\n' —— 用正则兼容两种行尾，
   否则切片会切在函数体中间，跑出来是"半个标识符"的语法错。 */
const tail = mainSrc.slice(end);
const closeM = tail.match(/\r?\n\}\r?\n/);
if (!closeM) { console.log('  ✗ 无法定位 shutdownSessionTmp 的结尾'); process.exit(1); }
const wipeChunk = mainSrc.slice(start, end + closeM.index + closeM[0].length);

const sandbox = { fs, os, path, crypto, Buffer, console,
  WIPE_BUDGET_RUNTIME: null };
const factory = new Function('fs', 'os', 'path', 'crypto', 'Buffer',
  'const SESSION_TMP = ' + JSON.stringify(path.join(work, 'mp-session-abc')) + ';\n'
  + 'const SESSION_AUDIO_DIR = ' + JSON.stringify(sessDir) + ';\n'
  + 'let sessionTmpReady = true;\n'
  + 'function markHidden(){}\n'
  + wipeChunk + '\n'
  + 'return { wipeFile, wipeDir, sweepStaleSessions };');
const W = factory(fs, os, path, crypto, Buffer);

// 造一个"解密产物"：内容是可识别的明文，擦除后不应还能读到
const secret = 'DECRYPTED-AUDIO-CONTENT-' + crypto.randomBytes(8).toString('hex');
const dec = path.join(work, 'decrypted.mp3');
fs.writeFileSync(dec, Buffer.concat([Buffer.from(secret), Buffer.alloc(200 * 1024, 0x41)]));
const before = fs.readFileSync(dec, 'utf8').slice(0, secret.length);
ok('擦除前文件里能读到明文标记', before === secret, before);

W.wipeFile(dec);
ok('擦除后文件被删除', !fs.existsSync(dec));

// wipeDir：递归擦除 + 删除目录本身
const nested = path.join(sessDir, 'nested');
fs.mkdirSync(nested, { recursive: true });
fs.writeFileSync(path.join(sessDir, 'a.m4a'), Buffer.alloc(64 * 1024, 0x42));
fs.writeFileSync(path.join(nested, 'b.m4a'), Buffer.alloc(64 * 1024, 0x43));
W.wipeDir(sessDir);
ok('wipeDir 后目录被删除', !fs.existsSync(sessDir));

/* ---------- 3. 陈旧会话清扫 ---------- */
console.log('\n[3] 启动时的陈旧会话清扫');
const stale = path.join(os.tmpdir(), 'mp-session-stale-test');
fs.mkdirSync(path.join(stale, 'audio'), { recursive: true });
fs.writeFileSync(path.join(stale, 'audio', 'x.m4a'), Buffer.alloc(1024, 9));
W.sweepStaleSessions();
ok('上次残留的 mp-session-* 被清掉', !fs.existsSync(stale));

/* ---------- 3b. 硬链接保护（真实事故的回归测试） ----------
   事故经过：bili.js 曾用 fs.linkSync 把用户的 B 站缓存"链"成可播放副本，
   副本目录在退出时被 wipeDir 擦除；而擦除是"以 r+ 覆写 0 再 unlink"，
   覆写会透过硬链接直接落到源文件上 —— unlink 只摘掉副本那个目录项，
   用户的原始缓存却已被原地写成全 0，再播放就是 MediaError 4
   （"格式不支持或文件头异常"）。实测已毁掉两个真实缓存文件。
   这里锁死两条不变量：
     ① wipeFile 不得覆写链接数 > 1 的文件，只允许摘目录项
     ② ensureM4a 不得再产出与源共享 inode 的副本（硬链接）
   以及最终结果：擦除副本后源文件内容必须一字不变。 */
console.log('\n[3b] 硬链接保护（防止擦除副本时毁掉源文件）');
const hlRoot = path.join(work, 'hardlink-case');
const hlSession = path.join(hlRoot, 'session');
fs.mkdirSync(hlSession, { recursive: true });
const hlSrc = path.join(hlRoot, 'user-cache.m4s');
const hlPayload = Buffer.alloc(64 * 1024);
for (let i = 0; i < hlPayload.length; i++) hlPayload[i] = (i * 31 + 7) & 0xff;
fs.writeFileSync(hlSrc, hlPayload);
const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
const srcSumBefore = md5(hlSrc);

const hlLink = path.join(hlSession, 'copy.m4a');
fs.linkSync(hlSrc, hlLink);
ok('构造出硬链接副本（nlink = 2）', fs.statSync(hlSrc).nlink === 2, 'nlink=' + fs.statSync(hlSrc).nlink);

W.wipeDir(hlSession);
ok('擦除后副本目录已删除', !fs.existsSync(hlSession));
ok('源文件仍然存在', fs.existsSync(hlSrc));
ok('★ 源文件内容未被改动（MD5 一致）', srcSumBefore === md5(hlSrc),
  srcSumBefore + ' -> ' + md5(hlSrc) + '   ← 源文件被覆写成 0 了！');
ok('源文件链接数回到 1', fs.statSync(hlSrc).nlink === 1);

/* 反向验证：ensureM4a 不能再产出硬链接 */
const kmDir = path.join(work, 'link-free');
fs.mkdirSync(kmDir, { recursive: true });
const noHead = path.join(work, 'nohead.m4s');   // 无可识别 mp4 头 → 走 offset === 0 分支
fs.writeFileSync(noHead, hlPayload);
const kmOut = bili.ensureM4a(noHead, kmDir);
ok('ensureM4a 对"无可识别头"的文件也返回了副本', !!kmOut);
if (kmOut) {
  const so = fs.statSync(kmOut), sn = fs.statSync(noHead);
  ok('★ 副本不与源共享 inode（不再用 linkSync）', so.ino !== sn.ino,
    '两者 ino 都是 ' + so.ino);
  ok('副本链接数为 1（独立文件）', so.nlink === 1, 'nlink=' + so.nlink);
  W.wipeDir(kmDir);
  ok('★ 擦除该副本后源文件依然完好', md5(noHead) === srcSumBefore);
}

/* ---------- 4. 静态断言 ---------- */
console.log('\n[4] 静态断言：不存在导出派生数据的接口');
ok('convert-ncm 要求 CTENFDAM 魔数（不做通用解密）', /CTENFDAM/.test(mainSrc));
ok('convert-ncm 成功后返回的是内存字节（bytes 字段）', /return viaExe;/.test(mainSrc));
ok('不存在 write-file / save-as / export 类 IPC 通道',
  !/ipcMain\.(handle|on)\(\s*'(write|save|export|download)[^']*'/i.test(mainSrc));
ok('prepare-bili-audio 用的是会话目录常量', /ensureM4a\(originalPath,\s*SESSION_AUDIO_DIR/.test(mainSrc));
ok('退出时会销毁会话目录', /shutdownSessionTmp\(\)/.test(mainSrc));
ok('存在本地审计写入', /function audit\(/.test(mainSrc));
ok('存在升级清理（擦除 1.0.x 遗留的 userData 副本）', /purgeLegacyAudioCache/.test(mainSrc));
ok('wipeFile 里有硬链接保护（nlink > 1 只摘目录项）', /st\.nlink\s*>\s*1/.test(mainSrc));
/* 去掉注释后再做静态断言 —— 否则"注释里提到 linkSync"这种说明性文字会造成误报 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const biliSrc = fs.readFileSync(path.join(APP, 'bili.js'), 'utf8');
const biliCode = stripComments(biliSrc);
ok('bili.js 不再用 linkSync 造副本（注释里提及不算）',
  !/(?<!un)linkSync\(/.test(biliCode),
  '仍有调用：' + ((biliCode.match(/.*(?<!un)linkSync\(.*/) || [''])[0]).trim());
const preload = fs.readFileSync(path.join(APP, 'preload.js'), 'utf8');
const exposed = (preload.match(/^\s{2}[A-Za-z]+:/gm) || []).map(s => s.trim().replace(':', ''));
console.log('    preload 暴露的方法: ' + exposed.join(', '));
ok('preload 未暴露任何写文件方法',
  !exposed.some(n => /write|save|export/i.test(n)), exposed.join(','));

/* ---------- 收尾 ---------- */
try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) { }
console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
