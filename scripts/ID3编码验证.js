#!/usr/bin/env node
/*
 * ID3 文本解码的离线验证
 *
 * 用法： node scripts\ID3编码验证.js
 * 退出码：0 = 全部通过；1 = 有用例失败（发布流程会因此中断）
 *
 * 为什么要有这个脚本：
 *   用户反馈"歌曲标题存在编码不匹配的乱码问题"。根因是 player.ts 里的 ID3 文本解码
 *   曾经写死 UTF-8 —— 而中文 MP3 最常见的是"编码字节 1（带 BOM 的 UTF-16）"
 *   以及"编码字节 0 但实际写的是 GBK"。这两种都会被 UTF-8 解成乱码。
 *
 *   本脚本**从 player.ts 源码里取出 decodeTagText / looksBroken 两个函数本身**执行
 *   （而不是抄一份逻辑），所以它验证的就是真正发布出去的那段代码。
 */

const fs = require("fs");
const path = require("path");

/* 从源码里按函数名抠出一段完整的函数定义（数花括号配对）。 */
function extractFunction(source, name) {
  const start = source.indexOf("function " + name + "(");
  if (start < 0) throw new Error("在源码里找不到函数 " + name);
  let depth = 0;
  let i = source.indexOf("{", start);
  const from = i;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error("函数 " + name + " 的花括号没有配对：" + from);
}

/* 从源码里取出单行常量定义（两个判据正则）。 */
function extractConst(source, name) {
  const match = source.match(new RegExp("const " + name + " = [^;]+;"));
  if (!match) throw new Error("在源码里找不到常量 " + name);
  return match[0];
}

/* player.ts 是 TypeScript，取出来的是带类型标注的函数体；这里只抹掉标注本身
   （不改逻辑）。若哪天函数签名变了，下面的一致性检查会直接报错，而不是悄悄测错东西。 */
function toRunnable(code) {
  const stripped = code
    .replace("function decodeTagText(bytes: Uint8Array): string {", "function decodeTagText(bytes) {")
    .replace(
      "const run = (label: string, input: Uint8Array = body, fatal = false) => {",
      "const run = (label, input = body, fatal = false) => {",
    )
    .replace("function looksBroken(text: string | undefined): boolean {", "function looksBroken(text) {");
  if (/:\s*(Uint8Array|string|boolean|number)\b/.test(stripped)) {
    throw new Error(
      "player.ts 的函数签名变了，脚本里的类型抹除规则需要同步更新（见 toRunnable）",
    );
  }
  return stripped;
}

const playerPath = path.join(__dirname, "..", "app-rhine", "src", "player.ts");
const source = fs.readFileSync(playerPath, "utf8");
const bundle = toRunnable(
  [
    extractConst(source, "MOJIBAKE_LATIN"),
    extractConst(source, "HAS_CJK"),
    extractFunction(source, "decodeTagText"),
    extractFunction(source, "looksBroken"),
    "return { decodeTagText, looksBroken };",
  ].join("\n"),
);
const { decodeTagText, looksBroken } = new Function(bundle)();

const utf16le = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
const utf16be = (s) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(Buffer.from(s, "utf16le").swap16())]);

const cases = [
  ["UTF-16LE 带 BOM（中文 MP3 最常见）", [1, ...utf16le("星环坠落的夜晚")], "星环坠落的夜晚"],
  ["UTF-16BE 带 BOM", [1, ...utf16be("夜航")], "夜航"],
  ["UTF-16BE 无 BOM（编码字节 2）", [2, ...Buffer.from(Buffer.from("静默协议", "utf16le").swap16())], "静默协议"],
  ["UTF-8 标注正确", [3, ...Buffer.from("靜默協議", "utf8")], "靜默協議"],
  ["UTF-8 但编码字节标成 0", [0, ...Buffer.from("光学扩散层", "utf8")], "光学扩散层"],
  // Node 的 Buffer 不能按 gb18030 编码，这里直接用该编码的字节值（歌 B8E8 / 曲 C7FA / 经 BEAD / 典 B5E4）
  ["GBK/GB18030 却标成 0（老工具的行为）", [0, 0xb8, 0xe8, 0xc7, 0xfa, 0xbe, 0xad, 0xb5, 0xe4], "歌曲经典"],
  ["纯 ASCII", [0, ...Buffer.from("Moonlight Decade", "ascii")], "Moonlight Decade"],
  ["拉丁文本（不能被误判成 GBK）", [0, ...Buffer.from("Café Björk", "latin1")], "Café Björk"],
  ["多歌手以 NUL 分隔", [0, ...Buffer.from("KALTSIT\0Joyce", "ascii")], "KALTSIT / Joyce"],
  ["空标签", [3], ""],
];

let passed = 0;
let failed = 0;
console.log("ID3 文本解码验证（直接取 player.ts 里的函数执行）\n");
for (const [name, bytes, want] of cases) {
  const got = decodeTagText(new Uint8Array(bytes));
  const ok = got === want;
  ok ? passed++ : failed++;
  console.log("  " + (ok ? "✓" : "✗") + " " + name + "  →  " + JSON.stringify(got) + (ok ? "" : "   期望 " + JSON.stringify(want)));
}

/* 旧曲库的自动修复依赖 looksBroken 的判据：乱码必须被认出来，正常歌名不能被误改。 */
const legacyWrong = new TextDecoder("utf-8").decode(utf16le("星环坠落的夜晚"));
const judge = [
  ["旧版写死 UTF-8 解 UTF-16LE 的结果要被判为乱码", looksBroken(legacyWrong), true],
  ["正常中文歌名不能被判为乱码", looksBroken("星环坠落的夜晚"), false],
  ["带重音的拉丁歌名不能被判为乱码", looksBroken("Café Björk"), false],
  ["含替换字符的一定判为乱码", looksBroken("abc\uFFFDdef"), true],
  ["空字符串不算乱码", looksBroken(""), false],
];
console.log("\n修复判据 looksBroken()\n");
for (const [name, got, want] of judge) {
  const ok = got === want;
  ok ? passed++ : failed++;
  console.log("  " + (ok ? "✓" : "✗") + " " + name + "  →  " + got + (ok ? "" : "   期望 " + want));
}
console.log("\n旧版解出的乱码样本: " + JSON.stringify(legacyWrong));
console.log("\n结果: " + passed + " 通过, " + failed + " 失败");
process.exit(failed ? 1 : 0);
