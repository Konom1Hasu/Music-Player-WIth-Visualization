# -*- coding: utf-8 -*-
"""SelfMusic 引擎对拍 · Python 侧（v5：三档 + 峰值）
用悦音 musicapp/selfmusic.py（权威）跑同一份 pcm.f32、同一取窗（整窗 4096、20ms 步长），
与 selfmusic-spectrum.ts 的 JS 序列逐帧逐带比对（heights 与 peaks 两组，目标 max|Δ| ≤ 1e-6）。

档 A「中性」：Python 全默认构造（= web/spectrum.mjs 逐位态）
档 B「出厂」：Python = **SelfMusic 实际启动链路**：类构造 + analyzer.DEFAULT_PARAMS
              + 16 项面板"已存值"逐项 apply（persist=False）。即用户机器上真正在跑的档。
档 C「扫档」：16 项全部取非默认值（覆盖 steepq>100 的 contrastFloor/steep 分支、
              smooth=2 多遍铺散、agc/right/expanda/valley 全开等换算分岔）
"""
import os
import sys

import numpy as np

ROOT = r"D:/harness work/音乐播放器"
sys.path.insert(0, r"D:/SelfMusic")
from musicapp.selfmusic import SpectrumAnalyzer  # noqa: E402
from musicapp.analyzer import DEFAULT_PARAMS  # noqa: E402

SR = 48000
T0 = 190.0
HOP = 960
WIN = 4096
FRAMES = 1000
BANDS = 96

x = np.fromfile(os.path.join(ROOT, "dist", "_sm2对拍-pcm.f32"), dtype=np.float32)
print(f"pcm: {x.size} 点 @ {SR}Hz")

# 16 项"出厂"值 = 用户 SelfMusic ui.json 里已存的实测档（2026-10-13 21:58）
FACTORY = [
    ("smooth", 0), ("knee", 95), ("detail", 0), ("leftpump", 60), ("head", 300),
    ("right", 80), ("agc", 100), ("steepq", 114), ("tilt", 39), ("timbre", 93),
    ("tint", 16), ("expanda", 100), ("surge", 110), ("release", 95), ("valley", 100),
    ("idle", 1),
]

# SelfMusic 启动时 DEFAULT_PARAMS 还会覆盖这两个"滑块管不到"的内部项（类默认是 1.45/0.70）
FACTORY_INTERNAL = [("detail_hi", float(DEFAULT_PARAMS["detail_hi"])),
                    ("detail_lo", float(DEFAULT_PARAMS["detail_lo"]))]

# 16 项扫档值：全部偏离出厂档，且覆盖各换算分岔（steepq>100、smooth=2、idle 反转）
SCAN = [
    ("smooth", 2), ("knee", 30), ("detail", 110), ("leftpump", 15), ("head", 220),
    ("right", 35), ("agc", 70), ("steepq", 240), ("tilt", 15), ("timbre", 80),
    ("tint", 20), ("expanda", 260), ("surge", 90), ("release", 60), ("valley", 60),
    ("idle", 0),
]


def apply_param(a, key, value):
    """照 mainwindow._apply_viz_param 的换算（逐行镜像）。"""
    if key == "steepq":
        c = float(value) / 100.0
        a.contrast = c
        a.contrast_floor = 0.05 if value > 100 else 0.0
        a.steep = max(0.0, (value - 100) / 100.0)
    elif key == "smooth":
        a.spread_passes = max(0, min(3, int(value)))
    elif key == "knee":
        a.knee = float(value) / 100.0
    elif key == "detail":
        a.detail = float(value) / 100.0
    elif key == "leftpump":
        a.left_pump = float(value) / 100.0
    elif key == "right":
        a.right_hf = float(value) / 100.0
    elif key == "agc":
        a.band_agc = float(value) / 100.0
    elif key == "timbre":
        a.timbre = float(value) / 100.0
    elif key == "expanda":
        a.peak_expand = float(value) / 100.0
    elif key == "head":
        a.headroom = float(value) / 100.0
    elif key == "tilt":
        a.tilt = float(value) / 100.0
    elif key == "valley":
        a.valley_keep = float(value) / 100.0
    elif key == "surge":
        a.surge_amp = float(value) / 100.0
    elif key == "tint":
        a.tint_amp = float(value) / 100.0
    elif key == "release":
        a.release = float(value) / 100.0
    elif key == "idle":
        a.idle_breathe = bool(value)


def run(a):
    out = np.zeros((FRAMES, BANDS), dtype=np.float32)
    outp = np.zeros((FRAMES, BANDS), dtype=np.float32)
    for k in range(FRAMES):
        w_end = int(round(T0 * SR)) + (k + 1) * HOP
        seg = np.ascontiguousarray(x[w_end - WIN: w_end])
        h, pk = a.analyze(seg)
        out[k] = h
        outp[k] = pk
    return out, outp


# 档 A：中性（全默认构造）
a_neutral = SpectrumAnalyzer(sample_rate=SR, bars=BANDS, fft_size=WIN)
out_neutral, pk_neutral = run(a_neutral)
out_neutral.tofile(os.path.join(ROOT, "dist", "_sm2对拍-py-neutral.f32"))
pk_neutral.tofile(os.path.join(ROOT, "dist", "_sm2对拍-py-neutral-peaks.f32"))
print("neutral f0:", " ".join(f"{v:.4f}" for v in out_neutral[0][:10]))

# 档 B：出厂（类构造 + DEFAULT_PARAMS + 16 项已存值 —— SelfMusic 实际启动链路）
a_factory = SpectrumAnalyzer(sample_rate=SR, bars=BANDS, fft_size=WIN)
for _k, _v in DEFAULT_PARAMS.items():
    setattr(a_factory, _k, float(_v))
for k, v in FACTORY:
    apply_param(a_factory, k, v)
for k, v in FACTORY_INTERNAL:
    setattr(a_factory, k, v)
a_factory.rebuild_band_boost()   # 重建 _tilt_ramp（含 tilt/steep）
out_factory, pk_factory = run(a_factory)
out_factory.tofile(os.path.join(ROOT, "dist", "_sm2对拍-py-factory.f32"))
pk_factory.tofile(os.path.join(ROOT, "dist", "_sm2对拍-py-factory-peaks.f32"))
print("factory f0:", " ".join(f"{v:.4f}" for v in out_factory[0][:10]))

# 档 C：扫档（全默认 + 16 项非默认 + DEFAULT_PARAMS 的 detail_hi/lo —— 与 JS 默认档对齐）
a_scan = SpectrumAnalyzer(sample_rate=SR, bars=BANDS, fft_size=WIN)
for k, v in SCAN:
    apply_param(a_scan, k, v)
for k, v in FACTORY_INTERNAL:
    setattr(a_scan, k, v)   # SelfMusic 的实际运行档里这两项永远 = DEFAULT_PARAMS 值
a_scan.rebuild_band_boost()
out_scan, pk_scan = run(a_scan)
out_scan.tofile(os.path.join(ROOT, "dist", "_sm2对拍-py-scan.f32"))
pk_scan.tofile(os.path.join(ROOT, "dist", "_sm2对拍-py-scan-peaks.f32"))
print("scan f0:", " ".join(f"{v:.4f}" for v in out_scan[0][:10]))

# ---- 比对（heights + peaks 两组） ----
ALL_OK = True
for name, py_out, py_pk, js_name in [("中性", out_neutral, pk_neutral, "neutral"),
                                     ("出厂", out_factory, pk_factory, "factory"),
                                     ("扫档", out_scan, pk_scan, "scan")]:
    for group, ref_file in (("heights", f"_sm2对拍-js-{js_name}.f32"),
                            ("peaks", f"_sm2对拍-js-{js_name}-peaks.f32")):
        ref = np.fromfile(os.path.join(ROOT, "dist", ref_file), dtype=np.float32).reshape(-1, BANDS)
        pyv = py_out if group == "heights" else py_pk
        m = min(ref.shape[0], pyv.shape[0])
        d = np.abs(ref[:m].astype(np.float64) - pyv[:m].astype(np.float64))
        bad = int((d.max(axis=1) > 1e-6).sum())
        maxd = float(d.max()) if d.size else 0.0
        ok = maxd <= 1e-6
        ALL_OK = ALL_OK and ok
        print(f"\n[{name}档 · {group}] 帧数 {m} | 每帧 {BANDS} 条")
        print(f"  全部元素 max|Δ| = {maxd:.3e}   mean|Δ| = {float(d.mean()):.3e}")
        print(f"  单帧 max|Δ| > 1e-6 的帧数 = {bad} / {m}")
        if bad:
            worst = int(d.max(axis=1).argmax())
            wb = int(d[worst].argmax())
            print(f"  最差帧 idx={worst}（t≈{T0 + (worst + 1) * HOP / SR:.2f}s）max|Δ|={d.max(axis=1)[worst]:.3e} 条 {wb}")
        print(f"  结论：{'逐位一致（≤1e-6）' if ok else '存在差异，见上'}")

print(f"\n总评：{'全部一致 ✓' if ALL_OK else '存在超差 ✗'}")
