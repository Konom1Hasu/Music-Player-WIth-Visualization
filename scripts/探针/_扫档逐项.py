# -*- coding: utf-8 -*-
"""扫档逐项 / 累进对拍 · Python 侧（配合 _扫档逐项.mjs）
逐项：每次只 apply 一项（其余默认构造，等价出厂基线）→ py-item-<key>.f32
累进：按 SCAN 顺序累加前 N 项 → py-prog-NN.f32
最后与 JS 同名文件比对并打印第一发散点。
"""
import os
import sys

import numpy as np

ROOT = r"D:/harness work/音乐播放器"
sys.path.insert(0, r"D:/SelfMusic")
from musicapp.selfmusic import SpectrumAnalyzer  # noqa: E402

SR = 48000
T0 = 190.0
HOP = 960
WIN = 4096
FRAMES = 400
BANDS = 96

x = np.fromfile(os.path.join(ROOT, "dist", "_sm2对拍-pcm.f32"), dtype=np.float32)

SCAN = [
    ("smooth", 2), ("knee", 30), ("detail", 110), ("leftpump", 15), ("head", 220),
    ("right", 35), ("agc", 70), ("steepq", 240), ("tilt", 15), ("timbre", 80),
    ("tint", 20), ("expanda", 260), ("surge", 90), ("release", 60), ("valley", 60),
    ("idle", 1),
]

# ⚠ 基线必须与 JS 侧一致：JS 的 new SelfSpectrumEngine({}) 默认 = 出厂（16 项面板默认）。
#   故 Python 侧先 apply FACTORY 16 项默认，再叠加变化项。
FACTORY = [
    ("smooth", 1), ("knee", 78), ("detail", 50), ("leftpump", 40), ("head", 160),
    ("right", 100), ("agc", 0), ("steepq", 160), ("tilt", 45), ("timbre", 45),
    ("tint", 45), ("expanda", 100), ("surge", 55), ("release", 82), ("valley", 100),
    ("idle", 0),
]


def apply_param(a, key, value):
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
    for k in range(FRAMES):
        w_end = int(round(T0 * SR)) + (k + 1) * HOP
        seg = np.ascontiguousarray(x[w_end - WIN: w_end])
        h, _pk = a.analyze(seg)
        out[k] = h
    return out


def make(items):
    a = SpectrumAnalyzer(sample_rate=SR, bars=BANDS, fft_size=WIN)
    for k, v in FACTORY:          # ← 基线：出厂 16 项默认（对齐 JS 构造默认）
        apply_param(a, k, v)
    for k, v in items:            # ← 叠加变化项
        apply_param(a, k, v)
    a.rebuild_band_boost()
    return a


def compare(tag, jpath, ppath):
    js = np.fromfile(jpath, dtype=np.float32).reshape(-1, BANDS)
    py = np.fromfile(ppath, dtype=np.float32).reshape(-1, BANDS)
    m = min(js.shape[0], py.shape[0])
    d = np.abs(js[:m].astype(np.float64) - py[:m].astype(np.float64))
    worst = int(d.max(axis=1).argmax())
    bad = int((d.max(axis=1) > 1e-6).sum())
    ok = "✓" if d.max() <= 1e-6 else "✗"
    print(f"  {ok} {tag:10s} max|Δ|={d.max():.3e}  超标帧 {bad}/{m}  最差帧 {worst}")
    return d.max() <= 1e-6


D = os.path.join(ROOT, "dist")

print("逐项（每次只改一项）：")
item_bad = []
for key, val in SCAN:
    out = run(make([(key, val)]))
    p = os.path.join(D, f"_sm2对拍-py-item-{key}.f32")
    out.tofile(p)
    if not compare(f"{key}={val}", os.path.join(D, f"_sm2对拍-js-item-{key}.f32"), p):
        item_bad.append(key)

print("\n累进（前 N 项）：")
acc = []
first_bad = None
for i, (key, val) in enumerate(SCAN):
    acc.append((key, val))
    out = run(make(acc))
    p = os.path.join(D, f"_sm2对拍-py-prog-{i + 1:02d}.f32")
    out.tofile(p)
    ok = compare(f"+{key} ({i + 1:2d})", os.path.join(D, f"_sm2对拍-js-prog-{i + 1:02d}.f32"), p)
    if not ok and first_bad is None:
        first_bad = key

print(f"\n逐项发散项：{item_bad if item_bad else '无'}")
print(f"累进第一发散点：{first_bad if first_bad else '无'}")
