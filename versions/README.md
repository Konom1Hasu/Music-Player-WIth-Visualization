# 历史版本存档

这里的 12 个文件是上一次大重构之前、`musicplayer.html` 历史上各个关键节点的**逐字节快照**，
用于可视化效果出问题时快速回滚到已知可用的状态。

来源：从 DSH 会话日志（`C:\Users\KonomiHasu\.dsh\sessions\`）里把 `musicplayer.html` 的
**全部 write/edit 操作按时间反向重放**还原出来。日志里的 `edit` 是精确字符串替换，
因此反向回放能精确还原历史状态（P 系列回放 204 处成功、0 失败）。

---

## 兼容性

**这 12 个快照都是自包含的单文件 HTML**（自带 `<style>` 与 `<script>`），
并且只调用了当前 `app/preload.js` 里仍然存在的 IPC：

| 调用的 API | 当前是否可用 |
| --- | --- |
| `findLyrics` | ✅ |
| `convertNcm` | ✅ |
| `setRenderMode` | ✅ |
| `getGpuStatus` | ✅ |
| `getDisplayInfo` | ✅ |

所以它们可以**直接作为 `app/index.html` 运行**，不需要一并回滚 `main.js` / `preload.js`。

需要注意的差异：快照来自「单文件播放器」时期，**不认识**后来加入的 `bili.js`（B 站缓存）、
`cover.js`（新封面解析）、`ncmdump.exe`（NCM 官方解密）与 `mini.html`（迷你悬浮窗），
也没有多歌手识别、媒体键自检等后续功能。它们只覆盖**播放 + 可视化 + 歌词 + NCM** 这条主链路。

---

## 版本一览（按时间正序）

| 文件 | 归档时间 | 大小 | 说明 |
| --- | --- | --- | --- |
| `Q3_preRebuild.html` | 2026-08-30 11:21 | 47.3 KB | 08-30 那条编辑链的原点 |
| `Q2_preWaveA.html` | 2026-09-11 21:02 | 47.6 KB | 重建时的恢复点 |
| `Q1_preWave.html` | 2026-09-11 21:30 | 57.9 KB | 确认「滑动波 / 横移从未出现过」的版本 |
| `P3_pre0912.html` | 2026-09-12 00:47 | 71.3 KB | 09-11 重建之夜结束 |
| `P4_preMoveSrc.html` | 2026-09-12（时间未记录） | 71.3 KB | 源码从工作区根目录移入 `源码\` 之前 |
| `P2_preVizTune.html` | 2026-09-12 23:28 | 73.4 KB | 09-12 全天可视化调参之前 |
| `P1_preSlideWave.html` | 2026-09-13 00:48 | 77.1 KB | 09-13 凌晨「滑动单峰 / 左顶」实验之前 |
| `P0_current.html` | 2026-09-13 01:10 | 78.4 KB | 被替换掉的 crest 实验版（横移三连：slideBuf + wave + crest） |
| `R1_installed_final.html` | 2026-09-13 01:21 | 59.0 KB | 当时的安装版 = Q1 + 补回媒体键（耳机键）通路 |
| `A_pre0912.html` | — | 59.3 KB | 第一次回放尝试的产物，**精度不如 P/Q 系列，仅作参考** |
| `B_preVizTune.html` | — | 60.1 KB | 同上 |
| `C_preSlideWave.html` | — | 60.8 KB | 同上 |

> `P*` 与 `Q*` 系列的编号是**倒序**的（数字越小越新），这是当时的命名习惯，不是笔误。

---

## 怎么回滚

用仓库里的脚本，一步到位：

```powershell
# 列出所有可用版本
.\scripts\use-version.ps1 -List

# 回滚到某个版本（会自动备份当前版本，然后重新构建）
.\scripts\use-version.ps1 -Version Q1

# 只改源码不重新构建
.\scripts\use-version.ps1 -Version R1 -NoBuild

# 把当前版本恢复回来最方便的办法：看 dist\版本备份\ 里自动生成的备份
```

`-Version` 支持写完整文件名、文件名前缀（`Q1`）、或中间的关键字（`preWave`），
唯一匹配即可。

手工回滚也很简单：

```powershell
Copy-Item 'versions\Q1_preWave.html' 'app\index.html' -Force
.\scripts\build-portable.ps1
```

---

## 历史约束记录（2026-09-13，**已被后续需求取代**）

当时用户明确要求：

> **横移效果（高峰自右向左移动）彻底不要再做。** 具体禁止引入：
> `SLIDE_AMT` / `slideBuf` 左拖混合、`wavePhase` 正弦行波、`crestPhase` 滑动单峰包络。
> 当时安装版中这三者的命中数均为 **0**。

这个约束在后续开发中被**明确推翻** —— 之后用户反过来要求「滑动感可以理解为高耸条从右到左滑动」，
当前 `app/index.html` 因此**包含**相干行波实现（`wavePhase`）。

保留这段记录是为了说明：

- `Q1` / `R1` 为什么是「没有横移」的样子，不是漏做
- 如果要回滚到 `Q1` / `R1` 系列，可视化会**失去滑动感**，这是预期行为

---

## 与当前版本的体积差异

快照 47 ~ 79 KB，当前 `app/index.html` 约 123 KB。差异来自后来加入的功能
（B 站缓存、新封面解析、迷你悬浮窗、多歌手识别、媒体键自检、主题系统、
频谱管线重写等），**不代表当时的功能被删掉了**。
