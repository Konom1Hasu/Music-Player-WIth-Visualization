/* 把 PNG 转成 ASCII 灰度图 —— 让"读不了图"的模型也能实际看到界面布局。
   纯 Node 实现，不依赖任何图像库（只用内置 zlib），也不需要额外权限。

   用法：node dist\_img2ascii.js <图片> [列数]
   支持：8 位、彩色/灰度/RGB/RGBA、非隔行 PNG（Chromium 截图正是这种）。

   为什么需要它：本机可用的视觉通道（claude CLI 未登录、opencode 起不来、
   modlens 未安装）都不可用，而截图本身能拍出来 —— 于是把像素降到字符网格，
   用亮度分级渲染，至少能判断：有没有三维场景、卡片阵列、文字块、主色调。 */
'use strict';
const fs = require('fs');
const zlib = require('zlib');

function decodePng(buf) {
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
    let off = 8, w = 0, h = 0, depth = 0, colorType = 0, interlace = 0;
    const idat = [];
    let plte = null, trns = null;
    while (off < buf.length) {
        const len = buf.readUInt32BE(off);
        const type = buf.toString('latin1', off + 4, off + 8);
        const data = buf.subarray(off + 8, off + 8 + len);
        if (type === 'IHDR') {
            w = data.readUInt32BE(0); h = data.readUInt32BE(4);
            depth = data[8]; colorType = data[9];
            interlace = data[12];
        } else if (type === 'IDAT') idat.push(data);
        else if (type === 'PLTE') plte = data;
        else if (type === 'tRNS') trns = data;
        else if (type === 'IEND') break;
        off += 12 + len;
    }
    if (depth !== 8) throw new Error('只支持 8 位深度，实际 ' + depth);
    if (interlace !== 0) throw new Error('不支持隔行 PNG');

    const CH = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
    if (!CH) throw new Error('不支持的颜色类型 ' + colorType);

    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = w * CH;
    const out = Buffer.alloc(h * stride);
    let pos = 0;
    for (let y = 0; y < h; y++) {
        const ft = raw[pos++];
        const line = raw.subarray(pos, pos + stride); pos += stride;
        const cur = out.subarray(y * stride, (y + 1) * stride);
        const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
        for (let x = 0; x < stride; x++) {
            const a = x >= CH ? cur[x - CH] : 0;
            const b = prev ? prev[x] : 0;
            const c = (prev && x >= CH) ? prev[x - CH] : 0;
            let v = line[x];
            if (ft === 1) v = (v + a) & 255;
            else if (ft === 2) v = (v + b) & 255;
            else if (ft === 3) v = (v + ((a + b) >> 1)) & 255;
            else if (ft === 4) {
                const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                v = (v + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))) & 255;
            }
            cur[x] = v;
        }
    }

    // 统一成 RGB 取样的取值函数
    function pixel(x, y) {
        const i = y * stride + x * CH;
        if (colorType === 2 || colorType === 6) return [out[i], out[i + 1], out[i + 2]];
        if (colorType === 0 || colorType === 4) return [out[i], out[i], out[i]];
        if (colorType === 3 && plte) { const p = out[i] * 3; return [plte[p], plte[p + 1], plte[p + 2]]; }
        return [0, 0, 0];
    }
    return { w, h, pixel, colorType };
}

const RAMP = ' .:-=+*#%@';   // 由暗到亮
const file = process.argv[2];
const cols = Number(process.argv[3] || 100);
if (!file) { console.log('用法: node dist\\_img2ascii.js <图片> [列数]'); process.exit(2); }

const img = decodePng(fs.readFileSync(file));
const aspect = 0.5;                                  // 字符高宽比约 2:1
const rows = Math.max(1, Math.round(cols * (img.h / img.w) * aspect));
const cw = img.w / cols, ch = img.h / rows;

console.log('图片: ' + file);
console.log('尺寸: ' + img.w + ' x ' + img.h + '   颜色类型: ' + img.colorType);
console.log('渲染: ' + cols + ' x ' + rows + ' 字符');
console.log('');

let sumR = 0, sumG = 0, sumB = 0, dark = 0, bright = 0, total = 0;
const lines = [];
for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
        let R = 0, G = 0, B = 0, n = 0;
        const x0 = Math.floor(c * cw), x1 = Math.max(x0 + 1, Math.floor((c + 1) * cw));
        const y0 = Math.floor(r * ch), y1 = Math.max(y0 + 1, Math.floor((r + 1) * ch));
        for (let y = y0; y < y1; y += 2) {
            for (let x = x0; x < x1; x += 2) {
                const p = img.pixel(x, y);
                R += p[0]; G += p[1]; B += p[2]; n++;
            }
        }
        if (!n) n = 1;
        R /= n; G /= n; B /= n;
        sumR += R; sumG += G; sumB += B; total++;
        const lum = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
        if (lum < 0.04) dark++; else if (lum > 0.96) bright++;
        line += RAMP[Math.min(RAMP.length - 1, Math.floor(lum * RAMP.length))];
    }
    lines.push(line);
}
console.log('┌' + '─'.repeat(cols) + '┐');
for (const l of lines) console.log('│' + l + '│');
console.log('└' + '─'.repeat(cols) + '┘');
console.log('');
console.log('平均色: rgb(' +
    Math.round(sumR / total) + ', ' + Math.round(sumG / total) + ', ' + Math.round(sumB / total) + ')');
console.log('接近全黑(<4%) 的格子: ' + (dark / total * 100).toFixed(1) + '%    接近全白(>96%): ' + (bright / total * 100).toFixed(1) + '%');
