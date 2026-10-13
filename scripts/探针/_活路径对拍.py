# -*- coding: utf-8 -*-
"""活路径形式对拍 · Python 侧（活模拟 = mainwindow._refresh_viz 逐行移植）
   与 _活路径对拍.mjs（JS 侧跑**真实驱动类** selfmusic-live.ts）用
   同一 PCM、同一 (posMs, dtMs) 序列，逐帧比对 heights + peaks。

   目的：把"播放器里真正在跑的那条活路径"钉死在 ≤1e-6——
   平滑时钟（硬同步 >250 / 慢回正 5% / 大漂移 >60 回正）、set_tick_ms 折算、
   [vizMs, vizMs+4096) 取窗、越界补零，全部与 SelfMusic 同式。
"""
import math
import os
import sys

import numpy as np

ROOT = r"D:/harness work/音乐播放器"
sys.path.insert(0, r"D:/SelfMusic")
from musicapp.selfmusic import SpectrumAnalyzer  # noqa: E402
from musicapp.analyzer import DEFAULT_PARAMS  # noqa: E402

SR = 48000
WIN = 4096
BANDS = 96
FRAMES = 400

x = np.fromfile(os.path.join(ROOT, "dist", "_sm2对拍-pcm.f32"), dtype=np.float32)
print(f"pcm: {x.size} 点 @ {SR}Hz")

# 出厂档 = JS 侧 `new SelfSpectrumEngine({})` 的默认（用户 SelfMusic 实测档）
FACTORY = [
    ("smooth", 0), ("knee", 95), ("detail", 0), ("leftpump", 60), ("head", 300),
    ("right", 80), ("agc", 100), ("steepq", 114), ("tilt", 39), ("timbre", 93),
    ("tint", 16), ("expanda", 100), ("surge", 110), ("release", 95), ("valley", 100),
    ("idle", 1),
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


a = SpectrumAnalyzer(sample_rate=SR, bars=BANDS, fft_size=WIN)
for _k, _v in DEFAULT_PARAMS.items():
    setattr(a, _k, float(_v))
for k, v in FACTORY:
    apply_param(a, k, v)
for k in ("detail_hi", "detail_lo"):
    setattr(a, k, float(DEFAULT_PARAMS[k]))
a.rebuild_band_boost()
a.reset()   # 与 JS 侧 setPcm 里的 engine.reset() 对齐


class LiveSim:
    """mainwindow._refresh_viz 的逐行移植（与 selfmusic-live.ts 同式）。"""

    def __init__(self, analyzer, pcm, sr):
        self.a = analyzer
        self.pcm = pcm
        self.sr = sr
        self.viz_ms = 0.0
        self.synced = False

    def frame(self, pos_ms, dt_ms):
        target = pos_ms
        if (not self.synced) or abs(target - self.viz_ms) > 250.0:
            self.viz_ms = target
            self.synced = True
        else:
            self.viz_ms += max(0.0, min(dt_ms / 1000.0, 0.10)) * 1000.0
            gap = target - self.viz_ms
            if abs(gap) > 60.0:
                self.viz_ms = target
            else:
                self.viz_ms += 0.05 * gap
        self.a.set_tick_ms(max(8.0, min(60.0, dt_ms)) if dt_ms > 0 else 16.7)
        start = max(0, int(self.viz_ms * self.sr / 1000.0))
        win = np.zeros(WIN, dtype=np.float32)
        seg = self.pcm[start:start + WIN]
        win[: seg.size] = seg
        h, pk = self.a.analyze(win)
        return h, pk


def frame_seq(N):
    """与 JS 侧逐行同构的 (posMs, dtMs) 序列（+ * / floor 均为 IEEE 双精度，逐位一致）。"""
    seq = []
    t = 0.0
    off = 0.0
    for k in range(N):
        dt = 15.6 + (0.9 if k % 2 else 0.0)
        if k % 7 == 0:
            dt = 21.3
        if k == N // 5:
            dt = 900.0                      # 暂停后首帧
        t += dt
        if k == N // 2:
            off += 1500.0                   # 大跳（seek > 250ms → 硬对齐）
        if k == (3 * N) // 4:
            off += 120.0                    # 小跳（gap > 60 → 回正）
        pos = max(0.0, math.floor(t / 52.0) * 52.0 - 8.0 + off)
        seq.append((pos, dt))
    return seq


sim = LiveSim(a, x, SR)
seq = frame_seq(FRAMES)
outH = np.zeros((FRAMES, BANDS), dtype=np.float32)
outP = np.zeros((FRAMES, BANDS), dtype=np.float32)
vizs = np.zeros(FRAMES, dtype=np.float64)
for k, (pos, dt) in enumerate(seq):
    h, pk = sim.frame(pos, dt)
    outH[k] = h
    outP[k] = pk
    vizs[k] = sim.viz_ms

D = os.path.join(ROOT, "dist")
outH.tofile(os.path.join(D, "_sm2活路径-py.f32"))
outP.tofile(os.path.join(D, "_sm2活路径-py-peaks.f32"))
print(f"Python 侧：{FRAMES} 帧已导出（同一 (pos,dt) 序列）")
for k in (0, 1, FRAMES // 2, (3 * FRAMES) // 4, FRAMES - 1):
    print(f"  f{k} vizMs={vizs[k]:.3f} h0={outH[k][0]:.6f} p0={outP[k][0]:.6f}")

# ---- 比对 ----
ALL_OK = True
for group, jfile, pfile, pv in (("heights", "_sm2活路径-js.f32", "_sm2活路径-py.f32", outH),
                                ("peaks", "_sm2活路径-js-peaks.f32", "_sm2活路径-py-peaks.f32", outP)):
    js = np.fromfile(os.path.join(D, jfile), dtype=np.float32).reshape(-1, BANDS)
    py = np.fromfile(os.path.join(D, pfile), dtype=np.float32).reshape(-1, BANDS)
    m = min(js.shape[0], py.shape[0])
    d = np.abs(js[:m].astype(np.float64) - py[:m].astype(np.float64))
    bad = int((d.max(axis=1) > 1e-6).sum())
    maxd = float(d.max()) if d.size else 0.0
    ok = maxd <= 1e-6
    ALL_OK = ALL_OK and ok
    print(f"\n[活路径 · {group}] 帧数 {m} | 每帧 {BANDS} 条")
    print(f"  全部元素 max|Δ| = {maxd:.3e}   mean|Δ| = {float(d.mean()):.3e}")
    print(f"  单帧 max|Δ| > 1e-6 的帧数 = {bad} / {m}")
    if bad:
        worst = int(d.max(axis=1).argmax())
        wb = int(d[worst].argmax())
        print(f"  最差帧 idx={worst} 条 {wb}  JS={js[worst][wb]:.6f} PY={py[worst][wb]:.6f}")
    print(f"  结论：{'逐位一致（≤1e-6）' if ok else '存在差异，见上'}")

print(f"\n总评：{'活路径逐位一致 ✓' if ALL_OK else '存在超差 ✗'}")
