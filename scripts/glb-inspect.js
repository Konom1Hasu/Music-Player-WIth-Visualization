/* 检查 GLB（Blender 导出）的三维资产结构，把"Blender 文件里到底有什么"读出来：
   - 场景树（节点名、父子、平移/缩放）
   - 材质（名称 + 颜色/金属度/粗糙度/自发光）
   - 每个网格的世界包围盒（用它反推部件的真实比例）
   - 相机
   这样就能"紧贴 Blender 文件"定 UI 的比例、配色与部件命名。

   用法：node scripts\glb-inspect.js <file.glb> [--colors] [--tree] [--bounds] */
'use strict';
const fs = require('fs');

const file = process.argv[2];
if (!file) { console.log('用法: node scripts\\glb-inspect.js <file.glb> [--tree] [--bounds] [--accessors]'); process.exit(2); }
const flags = process.argv.slice(3);
const wantTree = flags.includes('--tree');
const wantBounds = flags.includes('--bounds') || flags.length === 0;
const wantAcc = flags.includes('--accessors');

const buf = fs.readFileSync(file);
if (buf.toString('latin1', 0, 4) !== 'glTF') throw new Error('不是 GLB：' + file);
const jsonLen = buf.readUInt32LE(12);
const jsonType = buf.toString('latin1', 16, 20);
if (jsonType !== 'JSON') throw new Error('首块不是 JSON，类型=' + jsonType);
const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));

console.log('文件: ' + file);
console.log('版本: ' + (json.asset && json.asset.version) +
    (json.asset && json.asset.generator ? '   生成器: ' + json.asset.generator : ''));
console.log('扩展: ' + (json.extensionsUsed ? json.extensionsUsed.join(', ') : '(无)'));
console.log('节点数: ' + (json.nodes || []).length +
    '   网格数: ' + (json.meshes || []).length +
    '   材质数: ' + (json.materials || []).length +
    '   相机数: ' + (json.cameras || []).length);
console.log('');

const BIN = Buffer.alloc(0); // 二进制块后面读

// —— 场景树 ——
function buildTree() {
    const nodes = json.nodes || [];
    const children = new Map();
    nodes.forEach((n, i) => {
        if (!n.children) return;
        for (const c of n.children) children.set(c, i);
    });
    const roots = nodes.map((_, i) => i).filter(i => !children.has(i));
    const rows = [];
    const fmt = (v, d = 3) => (Array.isArray(v) ? v.map(x => (+x).toFixed(d)).join(',') : '');
    const rec = (idx, depth) => {
        const n = nodes[idx] || {};
        let line = '  '.repeat(depth) + (n.name || '(未命名)') +
            (n.mesh !== undefined ? '  [mesh#' + n.mesh + ']' : '') +
            (n.camera !== undefined ? '  [camera#' + n.camera + ']' : '');
        if (n.translation) line += '  t=(' + fmt(n.translation) + ')';
        if (n.scale) line += '  s=(' + fmt(n.scale, 2) + ')';
        rows.push(line);
        for (const c of (n.children || [])) rec(c, depth + 1);
    };
    for (const r of roots) rec(r, 0);
    return rows;
}
if (wantTree) {
    console.log('===== 场景树 =====');
    for (const l of buildTree()) console.log(l);
    console.log('');
}

// —— 材质 ——
console.log('===== 材质 =====');
const hex = (v) => Array.isArray(v)
    ? '#' + v.slice(0, 3).map(x => Math.round(x * 255).toString(16).padStart(2, '0').toUpperCase()).join('')
        + (v[3] !== undefined && v[3] < 1 ? ' α' + v[3].toFixed(2) : '')
    : String(v);
for (const m of (json.materials || [])) {
    const pbr = (m.pbrMetallicRoughness || {});
    const parts = [];
    if (pbr.baseColorFactor) parts.push('base ' + hex(pbr.baseColorFactor));
    if (m.emissiveFactor && m.emissiveFactor.slice(0, 3).some(x => x > 0)) parts.push('emissive ' + hex(m.emissiveFactor));
    if (pbr.metallicFactor !== undefined) parts.push('metal ' + (+pbr.metallicFactor).toFixed(2));
    if (pbr.roughnessFactor !== undefined) parts.push('rough ' + (+pbr.roughnessFactor).toFixed(2));
    if (m.alphaMode && m.alphaMode !== 'OPAQUE') parts.push(m.alphaMode);
    console.log('  ' + (m.name || '(未命名)') + (parts.length ? '   ' + parts.join('  ') : ''));
}
console.log('');

// —— 相机 ——
if ((json.cameras || []).length) {
    console.log('===== 相机 =====');
    for (const c of (json.cameras || [])) {
        const p = c.perspective || c.orthographic || {};
        console.log('  ' + (c.name || '(未命名)') + '  type=' + c.type +
            '  yfov=' + (p.yfov ? (+p.yfov * 180 / Math.PI).toFixed(1) + '°' : '-') +
            '  znear=' + (p.znear ?? '-') + '  zfar=' + (p.zfar ?? '-'));
    }
    console.log('');
}

// —— 包围盒（需要 accessors + bufferViews + BIN） ——
function getBin() {
    let binLen = 0, binOff = 0, binData = null;
    let off = 20 + jsonLen;
    while (off + 8 <= buf.length) {
        const clen = buf.readUInt32LE(off);
        const ctype = buf.toString('latin1', off + 4, off + 8);
        if (ctype === 'BIN\0') {
            binLen = clen; binOff = off + 8; binData = buf;
            break;
        }
        off += 8 + clen;
    }
    return { binLen, binOff, binData };
}
function readAccessor(acc) {
    const { binLen, binOff, binData } = getBin();
    if (!binData || acc.bufferView === undefined) return null;
    const bv = json.bufferViews[acc.bufferView];
    const compType = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[acc.componentType];
    const ncomp = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[acc.type];
    if (!compType || !ncomp) return null;
    const stride = bv.byteStride || compType * ncomp;
    const start = binOff + (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const out = [];
    const read = (o) => acc.componentType === 5126 ? binData.readFloatLE(o)
        : acc.componentType === 5125 ? binData.readUInt32LE(o)
            : acc.componentType === 5123 ? binData.readUInt16LE(o)
                : acc.componentType === 5122 ? binData.readInt16LE(o)
                    : acc.componentType === 5121 ? binData.readUInt8(o)
                        : binData.readInt8(o);
    for (let i = 0; i < acc.count; i++) {
        const base = start + i * stride;
        const v = [];
        for (let k = 0; k < ncomp; k++) v.push(read(base + k * compType));
        out.push(ncomp === 1 ? v[0] : v);
    }
    return out;
}
if (wantBounds) {
    console.log('===== 网格包围盒（世界坐标，未考虑父级缩放；单位通常为米） =====');
    for (const [mi, mesh] of (json.meshes || []).entries()) {
        let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
        for (const prim of mesh.primitives) {
            const acc = json.accessors[prim.attributes.POSITION];
            if (!acc) continue;
            const aMin = acc.min, aMax = acc.max;
            if (!aMin || !aMax) continue;
            for (let k = 0; k < 3; k++) {
                if (aMin[k] < min[k]) min[k] = aMin[k];
                if (aMax[k] > max[k]) max[k] = aMax[k];
            }
        }
        if (min[0] === Infinity) continue;
        const w = (max[0] - min[0]), h = (max[1] - min[1]), d = (max[2] - min[2]);
        const f = (v) => (+v).toFixed(3);
        console.log('  #' + mi + '  ' + (mesh.name || '(未命名)') +
            '   中心 (' + f((min[0] + max[0]) / 2) + ',' + f((min[1] + max[1]) / 2) + ',' + f((min[2] + max[2]) / 2) + ')' +
            '   尺寸 ' + f(w) + ' x ' + f(h) + ' x ' + f(d));
    }
}
if (wantAcc) {
    console.log('===== 位置访问器 min/max =====');
    for (const [ai, acc] of (json.accessors || []).entries()) {
        if (acc.type === 'VEC3' && acc.min) {
            console.log('  accessor#' + ai + '  count=' + acc.count +
                '  min=(' + acc.min.map(v => (+v).toFixed(3)).join(',') + ')' +
                '  max=(' + acc.max.map(v => (+v).toFixed(3)).join(',') + ')');
        }
    }
}
