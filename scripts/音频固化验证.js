/* 音频固化回归验证 —— 钉死「导入的 B 站缓存要解析一份进播放器内部并保护起来」
   ---------------------------------------------------------------------------
   要解决的问题：B 站缓存在用户自己的 Videos\bilibili 下，随时会被 B 站客户端
   清理、被用户手动删。如果播放器只存一个"源文件路径"，源一没曲目就永远播不了
   —— 真实事故：《scualee》的源目录被删，曲库记录既无本地副本、又指向已销毁的
   会话目录，每次播放都报同一个错，且一个字节都不变。

   修法（对应三条不变量）：
     ① 扫描即固化：副本直接落进 <userData>\library\audio，一次解析一次写盘；
     ② 曲库里只存长效地址：srcUrl 不再写会话临时路径（那是脏数据的源头）；
     ③ 副本必须可信：固化结果要做内容头校验，坏副本不许当"可用音频"交付。

   本脚本锁定这些不变量。真实端到端用本机的 B 站缓存跑（只读源、写临时目录）。
*/
const fs = require('fs');
const path = require('path');
const os = require('os');
const root = path.resolve(__dirname, '..');

const biliSrc = fs.readFileSync(path.join(root, 'app', 'bili.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(root, 'app', 'main.js'), 'utf8');
const uiSrc = fs.readFileSync(path.join(root, 'app-rhine', 'src', 'player.ts'), 'utf8');
const mainTs = fs.readFileSync(path.join(root, 'app-rhine', 'src', 'main.ts'), 'utf8');
const bili = require(path.join(root, 'app', 'bili.js'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
console.log('=== 音频固化回归验证 ===\n');

/* ---------- A. bili.js：扫描即固化 ---------- */
console.log('A. bili.js 的固化能力');
ok('A1 scan 认得 opts.keepDir', /opts\.keepDir/.test(biliSrc) && /const keepDir\s*=\s*opts\.keepDir/.test(biliSrc));
ok('A2 副本落点 = keepDir 优先，其次会话目录',
   /const targetDir\s*=\s*keepDir\s*\|\|\s*opts\.audioDir/.test(biliSrc));
ok('A3 两处 ensureM4a 都写 targetDir（不再各写各的）',
   (biliSrc.match(/ensureM4a\([^,]+,\s*targetDir\)/g) || []).length === 2,
   '实际 ' + (biliSrc.match(/ensureM4a\([^,]+,\s*targetDir\)/g) || []).length + ' 处');
ok('A4 item 带 kept 标记（渲染端据此决定 srcUrl 写什么）',
   (biliSrc.match(/kept:\s*!!keepDir/g) || []).length === 2);
ok('A5 固化结果做了内容头校验（isSaneAudio）', /function isSaneAudio\(p\)/.test(biliSrc));
ok('A6 两条产出路径都过校验', (biliSrc.match(/isSaneAudio\(dest\)\s*\?\s*dest\s*:\s*null/g) || []).length === 2);
ok('A7 复用已有副本前也过校验（防住历史坏副本）', /if\s*\(!force\s*&&\s*isSaneAudio\(dest\)\)\s*return dest/.test(biliSrc));
ok('A8 isSaneAudio 已导出（供主进程/验证使用）', /isSaneAudio:\s*isSaneAudio/.test(biliSrc));

/* ---------- B. 主进程：落点与保护 ---------- */
console.log('\nB. 主进程的落点与保护');
ok('B1 biliOpts 把 keepDir 指到曲库目录', /keepDir:\s*LIBRARY_AUDIO_DIR/.test(mainSrc));
ok('B2 曲库目录常量在 userData 下（不落在系统临时目录）',
   /LIBRARY_AUDIO_DIR\s*=\s*path\.join\(app\.getPath\('userData'\),\s*'library',\s*'audio'\)/.test(mainSrc));
ok('B3 曲库目录会被主动创建（不依赖导入才出现）',
   /function ensureLibraryAudio\(\)[\s\S]{0,200}mkdirSync\(LIBRARY_AUDIO_DIR/.test(mainSrc));
ok('B4 bili-keep 仍保留（补固化存量曲目的入口）', /ipcMain\.handle\('bili-keep'/.test(mainSrc));
/* 保护性：曲库目录**绝不能**被任何清理逻辑波及。
   只允许 mkdir / 读取 / 写入三类操作，出现 unlink / rm / rmdir 指向它即判失败。 */
const libCleaners = mainSrc.match(/(unlinkSync|rmSync|rmdirSync)\s*\(\s*LIBRARY_AUDIO_DIR/g) || [];
ok('B5 没有任何清理逻辑指向曲库目录（副本是"最后的可播性"，删了就是自毁）',
   libCleaners.length === 0, libCleaners.join(','));
/* 会话临时目录的擦除必须限定在会话目录内，不能扫到 library */
ok('B6 退出时的擦除只针对会话目录',
   /wipeDir\(SESSION_TMP\)/.test(mainSrc) && !/wipeDir\(LIBRARY_AUDIO_DIR/.test(mainSrc));
ok('B7 数据策略里如实写明"导入音频固化在曲库目录"',
   /importedAudioKeptIn/.test(mainSrc));

/* ---------- C. 渲染端：不再产生脏 srcUrl + 播放时补固化 ---------- */
console.log('\nC. 渲染端的导入与补固化');
ok('C1 导入时优先采用 it.kept 的固化副本', /if\s*\(it\.kept\s*&&\s*it\.path\)/.test(uiSrc));
ok('C2 导入时 srcUrl = 固化副本优先，it.path 只是兜底',
   /srcUrl:\s*localPath\s*\|\|\s*it\.path/.test(uiSrc));
ok('C3 导入时对 localPath 再做一次会话路径判定（双保险）',
   /localPath\s*&&\s*isStaleSessionPath\(localPath\)/.test(uiSrc));
ok('C4 存在 solidifySong（固化动作本身）', /async function solidifySong\(/.test(uiSrc));
ok('C5 固化后把 srcUrl 换成固化副本（保证库里只留长效地址）',
   /async function solidifySong[\s\S]{0,1200}isStaleSessionPath\(cur\)\)\s*s\.srcUrl\s*=\s*s\.localPath/.test(uiSrc));
ok('C6 播放时搭便车固化（源在、副本没有 → 顺手补一份）',
   /if\s*\(!s\.localPath\)\s*void solidifySong\(s\)/.test(uiSrc));
ok('C7 已固化时不再从源重建（省一次无谓写盘）',
   /if\s*\(!force\s*&&\s*s\.localPath\)\s*\{[\s\S]{0,300}?const changed = s\.srcUrl !== s\.localPath/.test(uiSrc));
ok('C8 启动自愈里会标出"音源缺失"', /s\.missing\s*=\s*miss/.test(uiSrc));
ok('C9 列表标签显示"音源缺失"', /if\s*\(s\.missing\)\s*return "音源缺失"/.test(uiSrc));
ok('C10 设置面板有"补齐未固化的"按钮', /data-action="solidify-all"/.test(uiSrc));
ok('C11 按钮已绑定到 solidifyAllMissing', /solidify-all"\)\s*void solidifyAllMissing\(\)/.test(mainTs));
ok('C12 批量固化会如实报告"源已不在、固不了"的条数',
   /async function solidifyAllMissing[\s\S]{0,900}源缓存已不在，无法再固化/.test(uiSrc));

/* ---------- D. 真跑一遍（不依赖网络） ---------- */
console.log('\nD. 实测固化（合成样本 + 本机真实 B 站缓存）');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-solid-'));
function fakeMp4() {
  /* 最小合法 mp4：ftyp 盒 + mdat 盒。findMp4Start 要求 size 合法且盒类型已知。 */
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0); ftyp.write('ftyp', 4, 'latin1'); ftyp.write('mp42', 8, 'latin1');
  const mdat = Buffer.alloc(2000, 0x41);
  mdat.writeUInt32BE(2000, 0); mdat.write('mdat', 4, 'latin1');
  return Buffer.concat([ftyp, mdat]);
}
try {
  const keepDir = path.join(tmp, 'keep');
  const fake = fakeMp4();
  const withHead = path.join(tmp, 'with-head.m4s');
  fs.writeFileSync(withHead, Buffer.concat([Buffer.from('000000000', 'latin1'), fake]));

  const out = bili.ensureM4a(withHead, keepDir, false);
  ok('D1 带私有头的源 → 副本生成成功', !!out);
  ok('D2 副本落在指定的固化目录里', out && path.dirname(out) === keepDir,
     out ? path.dirname(out) : 'null');
  ok('D3 副本剥掉了 9 字节私有头', out && fs.statSync(out).size === fake.length,
     out ? fs.statSync(out).size + ' vs ' + fake.length : 'null');
  ok('D4 副本通过内容头校验', out && bili.isSaneAudio(out) === true);
  ok('D5 重复固化幂等（命中同一文件，不重复占盘）',
     bili.ensureM4a(withHead, keepDir, false) === out);

  const zeros = path.join(tmp, 'zeros.m4a');
  fs.writeFileSync(zeros, Buffer.alloc(3000));
  ok('D6 全 0 文件判为不可用（硬链接事故留下的坏副本就长这样）', bili.isSaneAudio(zeros) === false);

  const tiny = path.join(tmp, 'tiny.m4a');
  fs.writeFileSync(tiny, Buffer.concat([Buffer.from('ftyp'), Buffer.alloc(20)]));
  ok('D7 过小的文件判为不可用', bili.isSaneAudio(tiny) === false);

  const mp3 = path.join(tmp, 'a.mp3');
  fs.writeFileSync(mp3, Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2000)]));
  ok('D8 非 mp4 容器（ID3/MP3）不该被误杀', bili.isSaneAudio(mp3) === true);

  const badSrc = path.join(tmp, 'bad.m4s');
  fs.writeFileSync(badSrc, Buffer.alloc(3000));
  ok('D9 源本身已损坏时，拒绝交付副本（不许把坏引用塞进曲库）',
     bili.ensureM4a(badSrc, path.join(tmp, 'keep2'), false) === null);

  /* 真实 B 站缓存：只读源、写到临时目录，跑完即删 */
  const REAL = path.join('C:', 'Users', 'KonomiHasu', 'Videos', 'bilibili', '42436199274', '42436199274-1-30280.m4s');
  if (fs.existsSync(REAL)) {
    const realKeep = path.join(tmp, 'real-keep');
    const rout = bili.ensureM4a(REAL, realKeep, false);
    const srcSize = fs.statSync(REAL).size;
    ok('D10 本机真实 B 站缓存固化成功', !!rout);
    ok('D11 真实副本通过内容头校验', rout && bili.isSaneAudio(rout) === true);
    ok('D12 真实副本大小合理（剥头后 ≤ 源，且非空）',
       rout && fs.statSync(rout).size > 0 && fs.statSync(rout).size <= srcSize,
       rout ? fs.statSync(rout).size + ' / 源 ' + srcSize : 'null');
    ok('D13 真实副本重复固化幂等', rout && bili.ensureM4a(REAL, realKeep, false) === rout);
  } else {
    console.log('  · D10~D13 跳过（本机没有这个 B 站缓存，属正常）');
  }
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===');
process.exit(fail ? 1 : 0);
