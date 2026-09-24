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
/* --color：额外打印一张"色相网格"。只按亮度字母看不出配色，而看 UI 设计稿时
   配色与分区恰恰是最重要的信息 —— 用字母表示每格的主色相即可在纯文本里读出来。 */
const wantColor = process.argv.includes('--color');
/* --invert：白底深色字的设计稿必须反转，否则内容全是空格、背景全是 @，什么也读不出。
   --crop=x0,y0,x1,y1：按比例(0~1)裁剪后放大渲染，用来"凑近看"某个区域。 */
const wantInvert = process.argv.includes('--invert');
const cropArg = process.argv.find(a => a.startsWith('--crop='));
if (!file) {
    console.log('用法: node scripts\\截图转文本.js <图片> [列数] [--color] [--invert] [--auto] [--edge] [--hist] [--crop=x0,y0,x1,y1]');
    process.exit(2);
}

const _img0 = decodePng(fs.readFileSync(file));
let _cx0 = 0, _cy0 = 0, _cx1 = _img0.w, _cy1 = _img0.h;
if (cropArg) {
    const p = cropArg.slice(7).split(',').map(Number);
    if (p.length === 4 && p.every(v => Number.isFinite(v))) {
        _cx0 = Math.max(0, Math.round(p[0] * _img0.w));
        _cy0 = Math.max(0, Math.round(p[1] * _img0.h));
        _cx1 = Math.min(_img0.w, Math.round(p[2] * _img0.w));
        _cy1 = Math.min(_img0.h, Math.round(p[3] * _img0.h));
    }
}
const img = {
    w: Math.max(1, _cx1 - _cx0),
    h: Math.max(1, _cy1 - _cy0),
    colorType: _img0.colorType,
    pixel: (x, y) => _img0.pixel(x + _cx0, y + _cy0),
};
/* --edge：索贝尔梯度图。设计稿常带大面积的柔和渐变/光晕，直接看亮度只会看到一团雾；
   梯度图把"平坦区域"清掉，只留下线条、文字和硬边 —— 判断到底有没有界面结构就靠它。 */
const wantEdge = process.argv.includes('--edge') || process.argv.includes('--edges');
const lumAt = (x, y) => {
    const p = img.pixel(Math.max(0, Math.min(img.w - 1, x)), Math.max(0, Math.min(img.h - 1, y)));
    return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
};
const src = wantEdge
    ? {
        w: img.w, h: img.h, colorType: img.colorType,
        pixel: (x, y) => {
            const gx = lumAt(x + 1, y - 1) + 2 * lumAt(x + 1, y) + lumAt(x + 1, y + 1)
                - lumAt(x - 1, y - 1) - 2 * lumAt(x - 1, y) - lumAt(x - 1, y + 1);
            const gy = lumAt(x - 1, y + 1) + 2 * lumAt(x, y + 1) + lumAt(x + 1, y + 1)
                - lumAt(x - 1, y - 1) - 2 * lumAt(x, y - 1) - lumAt(x + 1, y - 1);
            const m = Math.min(255, Math.round(Math.hypot(gx, gy) * 255 * 1.6));
            return [m, m, m];
        },
    }
    : img;
const aspect = 0.5;                                  // 字符高宽比约 2:1
const rows = Math.max(1, Math.round(cols * (src.h / src.w) * aspect));
const cw = src.w / cols, ch = src.h / rows;

let sumR = 0, sumG = 0, sumB = 0, dark = 0, bright = 0, total = 0;
const wantAuto = process.argv.includes('--auto') || process.argv.includes('--invert');
/* 色相分桶：无彩（明度决定 K/V/W）与有彩（R O Y G C B P M）分开，
   这样纯灰/纯黑的界面区域不会被误判成有颜色。 */
function hueLetter(R, G, B) {
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    const lum = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    if (sat < 0.14 || mx - mn < 18) return lum < 0.18 ? 'K' : (lum > 0.82 ? 'W' : 'V');
    let h;
    if (mx === R) h = ((G - B) / (mx - mn) + 6) % 6;
    else if (mx === G) h = (B - R) / (mx - mn) + 2;
    else h = (R - G) / (mx - mn) + 4;
    h *= 60;
    if (h < 20 || h >= 330) return 'R';
    if (h < 45) return 'O';
    if (h < 70) return 'Y';
    if (h < 165) return 'G';
    if (h < 200) return 'C';
    if (h < 260) return 'B';
    if (h < 330) return 'P';
    return 'M';
}
/* 第一遍：只采样出每格的平均色，存进网格。之所以要两遍，是因为 --auto 需要先知道
   整幅图的亮度范围 —— 设计稿常常是"浅灰底+浅灰线"，直接用绝对亮度渲染会是一片空白，
   拉伸到满量程后才看得见结构。 */
const grid = [];
for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
        let R = 0, G = 0, B = 0, n = 0;
        const x0 = Math.floor(c * cw), x1 = Math.max(x0 + 1, Math.floor((c + 1) * cw));
        const y0 = Math.floor(r * ch), y1 = Math.max(y0 + 1, Math.floor((r + 1) * ch));
        for (let y = y0; y < y1; y += 2) {
            for (let x = x0; x < x1; x += 2) {
                const p = src.pixel(x, y);
                R += p[0]; G += p[1]; B += p[2]; n++;
            }
        }
        if (!n) n = 1;
        R /= n; G /= n; B /= n;
        sumR += R; sumG += G; sumB += B; total++;
        row.push([R, G, B, (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255]);
    }
    grid.push(row);
}
/* 亮度分位裁剪：取 1% / 99% 分位做拉伸，避免个别高光/噪点把量程撑坏。 */
let lo = 0, hi = 1;
if (wantAuto) {
    const sorted = [];
    for (const row of grid) for (const cell of row) sorted.push(cell[3]);
    sorted.sort((a, b) => a - b);
    lo = sorted[Math.floor(sorted.length * 0.01)];
    hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
    if (hi - lo < 1e-6) { lo = 0; hi = 1; }
}
const lines = [], colorLines = [];
console.log('图片: ' + file);
console.log('尺寸: ' + _img0.w + ' x ' + _img0.h + '   颜色类型: ' + img.colorType +
    (cropArg ? ('   裁剪: ' + _cx0 + ',' + _cy0 + ' → ' + _cx1 + ',' + _cy1 + '  (' + img.w + ' x ' + img.h + ')') : '') +
    (wantInvert ? '   [反转：深色=密]' : '') +
    (wantEdge ? '   [梯度图：只留线条与硬边]' : '') +
    (wantAuto ? '   [自动色阶 ' + lo.toFixed(3) + '~' + hi.toFixed(3) + ']' : ''));
console.log('渲染: ' + cols + ' x ' + rows + ' 字符');
console.log('');
for (let r = 0; r < rows; r++) {
    let line = '', cline = '';
    for (let c = 0; c < cols; c++) {
        const [R, G, B, raw] = grid[r][c];
        const lum = raw;
        if (lum < 0.04) dark++; else if (lum > 0.96) bright++;
        let lv = wantAuto ? (lum - lo) / (hi - lo) : lum;
        lv = Math.max(0, Math.min(1, lv));
        if (wantInvert) lv = 1 - lv;
        line += RAMP[Math.min(RAMP.length - 1, Math.floor(lv * RAMP.length))];
        cline += hueLetter(R, G, B);
    }
    lines.push(line);
    colorLines.push(cline);
}
const bar = '─'.repeat(cols);
console.log('┌' + bar + '┐');
for (const l of lines) console.log('│' + l + '│');
console.log('└' + bar + '┘');
if (wantColor) {
    console.log('');
    console.log('色相网格（K 黑 · V 灰 · W 白 · R 红 · O 橙 · Y 黄 · G 绿 · C 青 · B 蓝 · P 紫 · M 品红）：');
    console.log('┌' + bar + '┐');
    for (const l of colorLines) console.log('│' + l + '│');
    console.log('└' + bar + '┘');
    // 各色相占比，便于快速判断主色调
    const tally = {};
    for (const row of colorLines) for (const ch of row) tally[ch] = (tally[ch] || 0) + 1;
    const tot = cols * rows;
    const parts = Object.entries(tally).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => k + ' ' + (v / tot * 100).toFixed(1) + '%');
    console.log('色相占比: ' + parts.join('   '));
}
console.log('');
console.log('平均色: rgb(' +
    Math.round(sumR / total) + ', ' + Math.round(sumG / total) + ', ' + Math.round(sumB / total) + ')');
console.log('接近全黑(<4%) 的格子: ' + (dark / total * 100).toFixed(1) + '%    接近全白(>96%): ' + (bright / total * 100).toFixed(1) + '%');

/* --hist：整幅图的主色直方图。看设计稿最需要的是"到底用了哪几个颜色"，
   平均色会被大面积底色淹没，所以这里对全图像素做 5 位/通道量化后取前 N 名。 */
if (process.argv.includes('--hist')) {
    const H = new Map();
    let n = 0;
    const stepX = Math.max(1, Math.floor(src.w / 1400));
    const stepY = Math.max(1, Math.floor(src.h / 900));
    for (let y = 0; y < src.h; y += stepY) {
        for (let x = 0; x < src.w; x += stepX) {
            const p = src.pixel(x, y);
            const k = ((p[0] >> 3) << 10) | ((p[1] >> 3) << 5) | (p[2] >> 3);
            let e = H.get(k);
            if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; H.set(k, e); }
            e.n++; e.r += p[0]; e.g += p[1]; e.b += p[2];
            n++;
        }
    }
    const top = [...H.values()].sort((a, b) => b.n - a.n).slice(0, 18);
    const hex = (v) => Math.round(v).toString(16).padStart(2, '0').toUpperCase();
    console.log('');
    console.log('主色直方图（采样 ' + n + ' 像素，前 18 名）:');
    for (const e of top) {
        const r = e.r / e.n, g = e.g / e.n, b = e.b / e.n;
        const pct = e.n / n * 100;
        const barN = Math.max(1, Math.round(pct / 2));
        console.log('  #' + hex(r) + hex(g) + hex(b) +
            '  rgb(' + String(Math.round(r)).padStart(3) + ',' + String(Math.round(g)).padStart(3) + ',' + String(Math.round(b)).padStart(3) + ')' +
            '  ' + pct.toFixed(2).padStart(6) + '%  ' + '▓'.repeat(barN));
    }
}

/* --probe=x,y;x,y;...：直接读某几个像素的颜色。有了它就能把"这块是什么色"
   问清楚，而不用靠区域均值去猜。坐标按原图绝对像素给。 */
const probeArg = process.argv.find(a => a.startsWith('--probe='));
if (probeArg) {
    const hex = (v) => Math.round(v).toString(16).padStart(2, '0').toUpperCase();
    console.log('');
    console.log('像素取样:');
    for (const pair of probeArg.slice(8).split(';')) {
        const [px, py] = pair.split(',').map(Number);
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
        /* 取 3x3 平均，避免采到单像素噪点或抗锯齿边缘 */
        let R = 0, G = 0, B = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const q = _img0.pixel(Math.max(0, Math.min(_img0.w - 1, px + dx)),
                    Math.max(0, Math.min(_img0.h - 1, py + dy)));
                R += q[0]; G += q[1]; B += q[2]; n++;
            }
        }
        R /= n; G /= n; B /= n;
        console.log('  (' + String(px).padStart(4) + ',' + String(py).padStart(4) + ')  #' + hex(R) + hex(G) + hex(B) +
            '  rgb(' + String(Math.round(R)).padStart(3) + ',' + String(Math.round(G)).padStart(3) + ',' + String(Math.round(B)).padStart(3) + ')' +
            '   相对 x ' + (px / _img0.w).toFixed(3) + ' y ' + (py / _img0.h).toFixed(3));
    }
}

/* --profile：逐列/逐行的平均亮度曲线。用来判断"哪里有一条边/一条分隔线/一块面板"，
   比看 ASCII 更精确 —— 陡降的位置就是边界，可以直接换算成比例坐标。 */
if (process.argv.includes('--profile')) {
    const NX = 48, NY = 20;
    const colM = [], rowM = [];
    const samp = (x, y) => {
        const p = img.pixel(Math.max(0, Math.min(img.w - 1, Math.round(x))),
            Math.max(0, Math.min(img.h - 1, Math.round(y))));
        return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255;
    };
    for (let i = 0; i < NX; i++) {
        let s = 0, n = 0;
        for (let y = 0; y < img.h; y += 7) { s += samp((i + 0.5) * img.w / NX, y); n++; }
        colM.push(s / n);
    }
    for (let j = 0; j < NY; j++) {
        let s = 0, n = 0;
        for (let x = 0; x < img.w; x += 7) { s += samp(x, (j + 0.5) * img.h / NY); n++; }
        rowM.push(s / n);
    }
    const BAR = ' .:-=+*#%@';
    console.log('');
    console.log('逐列平均亮度（48 列，从左到右；列位置 = (序号+0.5)/48）:');
    for (const [i, v] of colM.entries()) {
        console.log('  x ' + (i / NX).toFixed(3) + '  ' + BAR[Math.min(9, Math.floor(v * 10))] + '  ' + v.toFixed(3));
    }
    console.log('逐行平均亮度（20 行，从上到下；行位置 = (序号+0.5)/20）:');
    for (const [j, v] of rowM.entries()) {
        console.log('  y ' + (j / NY).toFixed(3) + '  ' + BAR[Math.min(9, Math.floor(v * 10))] + '  ' + v.toFixed(3));
    }
}

/* --boxes：把图按小块分类（暗/中/亮）后做连通域标记，输出每个色块的像素级包围盒。
   读设计稿时 ASCII 只能看出"大概在哪"，而实现 UI 需要的是确切几何 ——
   这个模式给出 "x=57 y=58 w=590 h=164" 这种可以直接换算成 CSS 的数字。 */
if (process.argv.includes('--boxes')) {
    const bs = Math.max(2, Math.round(src.w / 620));     // 粗化块边长
    const gw = Math.ceil(src.w / bs), gh = Math.ceil(src.h / bs);
    const cls = new Int8Array(gw * gh);                  // 0 亮 1 中 2 暗
    const acc = new Float64Array(gw * gh * 3);
    for (let by = 0; by < gh; by++) {
        for (let bx = 0; bx < gw; bx++) {
            let R = 0, G = 0, B = 0, n = 0;
            for (let y = by * bs; y < Math.min(src.h, (by + 1) * bs); y += 2) {
                for (let x = bx * bs; x < Math.min(src.w, (bx + 1) * bs); x += 2) {
                    const p = src.pixel(x, y);
                    R += p[0]; G += p[1]; B += p[2]; n++;
                }
            }
            if (!n) n = 1;
            R /= n; G /= n; B /= n;
            const i = by * gw + bx;
            acc[i * 3] = R; acc[i * 3 + 1] = G; acc[i * 3 + 2] = B;
            const l = (0.2126 * R + 0.7152 * G + 0.0722 * B) / 255;
            cls[i] = l < 0.40 ? 2 : (l < 0.80 ? 1 : 0);
        }
    }
    let cnt = [0, 0, 0];
    for (const c of cls) cnt[c]++;
    /* 背景 = 占比最大的那一类，余下的都算"元素"。 */
    const bgCls = cnt.indexOf(Math.max(...cnt));
    const seen = new Uint8Array(gw * gh);
    const comps = [];
    const stack = [];
    for (let i = 0; i < gw * gh; i++) {
        if (seen[i] || cls[i] === bgCls) continue;
        const k = cls[i];
        stack.length = 0; stack.push(i); seen[i] = 1;
        let x0 = gw, y0 = gh, x1 = -1, y1 = -1, area = 0, sR = 0, sG = 0, sB = 0;
        while (stack.length) {
            const j = stack.pop();
            const bx = j % gw, by = (j - bx) / gw;
            if (bx < x0) x0 = bx; if (bx > x1) x1 = bx;
            if (by < y0) y0 = by; if (by > y1) y1 = by;
            area++; sR += acc[j * 3]; sG += acc[j * 3 + 1]; sB += acc[j * 3 + 2];
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = bx + dx, ny = by + dy;
                    if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
                    const nj = ny * gw + nx;
                    if (!seen[nj] && cls[nj] === k) { seen[nj] = 1; stack.push(nj); }
                }
            }
        }
        if (area < 8) continue;                          // 过滤噪点
        comps.push({
            area, cls: k,
            px: [x0 * bs, y0 * bs, (x1 + 1) * bs, (y1 + 1) * bs],
            rgb: [sR / area, sG / area, sB / area],
        });
    }
    comps.sort((a, b) => b.area - a.area);
    const hex = (v) => Math.round(v).toString(16).padStart(2, '0').toUpperCase();
    console.log('');
    console.log('色块几何（块边长 ' + bs + 'px，网格 ' + gw + 'x' + gh +
        '，背景类=' + ['亮', '中', '暗'][bgCls] + '，' + comps.length + ' 个连通域，列前 26）:');
    console.log('  #  类  面积          像素包围盒 x,y,w,h                占画面比例               平均色');
    for (const [i, c] of comps.slice(0, 26).entries()) {
        const [x, y, X, Y] = c.px, w = X - x, h = Y - y;
        console.log('  ' + String(i + 1).padStart(2) + '  ' + ['亮', '中', '暗'][c.cls] + '  ' +
            String(c.area).padStart(6) + '   ' +
            (x + ',' + y + ',' + w + ',' + h).padEnd(30) +
            ('x ' + (x / src.w).toFixed(3) + '~' + (X / src.w).toFixed(3) +
                '  y ' + (y / src.h).toFixed(3) + '~' + (Y / src.h).toFixed(3)).padEnd(26) +
            '  #' + hex(c.rgb[0]) + hex(c.rgb[1]) + hex(c.rgb[2]));
    }
}
