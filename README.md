# 音乐播放器 · Music Player

**当前版本：v2.7.9**

面向 Windows 的本地桌面音乐播放器，基于 **Electron** 与 **Three.js / Vite** 构建。主界面以 [RhineLabUI](https://github.com/LBEILC/RhineLabUI)（MIT，原作者 B 站 [@路北路陈](https://space.bilibili.com/3546646728820438)）的莱茵生命风格 3D 档案终端为底座，把本地曲库管理、逐行歌词、96 段对数频谱可视化、B 站缓存音频导入与 `.ncm` 解密整合进同一套终端界面里。

> 本程序只播放本机音频，不接入在线流媒体点播接口，也不下载任何网络音频。B 站缓存导入与 `.ncm` 解密仅处理你本机已存在的文件，且不提供导出或分享入口，详见 [数据管控](#数据管控)。

---

## 目录

- [特性](#特性)
- [快速开始](#快速开始)
- [快捷键](#快捷键)
- [启动参数](#启动参数)
- [项目结构](#项目结构)
- [数据管控](#数据管控)
- [常见问题](#常见问题)
- [致谢与许可](#致谢与许可)

---

## 特性

### 播放与曲库

- **多来源导入**：支持选择音频文件、扫描文件夹、拖拽导入，以及从本机 B 站客户端缓存目录按音频内容识别提取 `.m4s` 音轨（自动读取标题、UP 主与封面）。
- **`.ncm` 本地解密**：内置 `ncmdump.exe`，导入网易云 `.ncm` 文件时校验 `CTENFDAM` 容器魔数并在会话临时目录中解密还原为标准音频与标签，解密结果经内存回传渲染进程，不写入用户音乐目录。
- **元数据与封面**：优先解析音频内嵌标签（ID3 / FLAC / MP4 / OGG / WAV / APE 等）与内嵌封面，缺失时回退到文件名规则与同目录封面图；支持对已导入曲目重新识别封面与元数据。
- **歌词显示**：支持外部 `.lrc`（自动识别 UTF-8 / GBK）与内嵌歌词，逐行居中高亮滚动，支持双语翻译行；缺失时会在音频所在目录及上级目录自动匹配同名或相近歌词文件。
- **播放控制**：列表循环 / 顺序播放 / 单曲循环 / 随机播放、播放队列调整、倍速播放（带保音调开关）、切歌预取与退出进度记忆。

### 界面与 3D 终端

- **莱茵生命 3D 档案终端**：主界面由 `app-rhine/` 构建并托管在本机内嵌 HTTP 服务（默认端口 `41739`，可通过 `RHINE_UI_PORT` 覆盖），包含三维档案阵列、磁带模型展示与交互拆解、曲目详情页及全局搜索弹层。
- **主题与封面联动**：内置浅色与深色（夜间）两套终端外观，并支持根据专辑封面提取强调色。
- **内嵌字体**：随包内嵌 MiSans 四个字重的 `.woff2` 字体（附完整许可与来源声明），不依赖系统预装字体。

### 频谱可视化与音频链路

- **96 段对数频谱**：基于 4096 点分析窗与 96 段对数频带，复刻 SelfMusic 的时域峰值检波与 Canvas 绘制规则（底部贴齐、三段渐变柱体、顶部瞬态峰帽与左上角四路频段指示条），在设置面板内提供 16 项可调参数并支持一键重置。
- **设备采样率直连**：音频分析 `AudioContext` 无参构造，自动匹配当前系统输出设备的硬件采样率；超长音频或解码异常时自动降级到流式管线。
- **媒体键与耳机线控**：同时接入 Electron `globalShortcut` 与 Chromium Media Session（Windows SMTC），支持键盘与耳机硬件媒体键控制，设置面板内可查看实时热键注册状态。

---

## 快速开始

### 1. 下载安装包（推荐）

前往 [Releases](https://github.com/Konom1Hasu/Music-Player-WIth-Visualization/releases) 下载 `音乐播放器-Setup-x.y.z.exe`，双击按向导安装即可：

- 按当前用户安装到 `%LOCALAPPDATA%\Programs\音乐播放器`，不需要管理员权限，不弹 UAC。
- 可选创建桌面快捷方式，自动创建开始菜单项。
- 覆盖安装新版本或卸载程序时，用户曲库与设置数据保存在独立目录中不会被删除。

### 2. 从源码构建与安装

前置环境：Windows 10/11 x64、PowerShell 5.1+、Node.js（用于构建 `app-rhine/` 前端）。

```powershell
git clone https://github.com/Konom1Hasu/Music-Player-WIth-Visualization.git
cd Music-Player-WIth-Visualization

# 1. 安装前端依赖（首次构建需要）
cd app-rhine
npm install
cd ..

# 2. 构建前端并准备 Electron 运行时（首次会下载约 222 MB 的 Electron 31.7.7 win32-x64，之后离线复用）
.\scripts\build-portable.ps1

# 3. 直接运行便携版
.\dist\音乐播放器-win32-x64\音乐播放器.exe
```

也可以直接双击根目录的 `安装.bat`（等价于 `.\scripts\install.ps1 -Launch`），自动完成构建、安装到 `%LOCALAPPDATA%\Programs\音乐播放器`、创建快捷方式并启动程序。

常用安装参数：

```powershell
.\scripts\install.ps1                                          # 仅安装，不启动
.\scripts\install.ps1 -Launch                                  # 安装并启动
.\scripts\install.ps1 -InstallDir 'D:\Apps\音乐播放器' -Launch  # 安装到自定义目录
```

打包单文件安装程序（需安装 [Inno Setup 6](https://jrsoftware.org/isinfo.php)）：

```powershell
.\scripts\build-installer.ps1
# 输出：dist\安装包\音乐播放器-Setup-<版本>.exe
```

自定义 Electron 版本或镜像源：

```powershell
.\scripts\build-portable.ps1 -ElectronVersion 31.7.7 -Mirror https://npmmirror.com/mirrors/electron
```

---

## 快捷键

### 系统级媒体键（后台生效）

| 按键 | 功能 |
| --- | --- |
| `MediaPlayPause` / 耳机播放键 | 播放 / 暂停 |
| `MediaNextTrack` / 耳机下一曲 | 下一首 |
| `MediaPreviousTrack` / 耳机上一曲 | 上一首 |
| `MediaStop` | 暂停 |

### 全局备用组合键（媒体键被其他程序占用时）

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl` + `Alt` + `Space` / `P` | 播放 / 暂停 |
| `Ctrl` + `Alt` + `→` / `N` | 下一首 |
| `Ctrl` + `Alt` + `←` / `B` | 上一首 |
| `Ctrl` + `Alt` + `↑` / `↓` | 音量 +5% / -5% |
| `Ctrl` + `Alt` + `A` / `H` | 接听 / 挂断（语音快捷键） |

### 应用内快捷键（窗口聚焦且未在输入框内）

| 快捷键 | 功能 |
| --- | --- |
| `/` | 打开全局搜索弹层 |
| `←` / `→` | 档案阵列切换分栏 |
| `↑` / `↓` | 档案阵列切换上下曲目 |
| `Enter` | 开屏进入系统 / 打开曲目详情 / 详情页播放或暂停 |
| `Esc` | 关闭弹层 / 退出编辑 / 从详情返回阵列 |

---

## 启动参数

| 参数 | 说明 |
| --- | --- |
| `--low-power-gpu` | 多显卡环境下强制使用核显（默认优先请求独显） |
| `--software-render` | 强制使用软件渲染（用于排查显卡驱动或 WebGL 兼容问题） |
| `--recover-library` | 从旧版存储源导出曲库并写入当前 profile（同时生成跨 profile 交接区） |
| `--recover-ingest` | 从跨 profile 交接区导入曲库到当前 profile（与 `--recover-library` 配合使用） |

---

## 项目结构

```text
音乐播放器/
├── app/                        # Electron 主进程与运行时入口（打包进 resources/app）
│   ├── main.js                 # 主进程：窗口管理、内嵌 UI 服务、IPC、热键、NCM/B 站音频处理
│   ├── preload.js              # contextBridge 白名单桥接，向渲染进程暴露 window.desktop
│   ├── bili.js                 # B 站客户端本地缓存扫描与音频提取
│   ├── cover.js                # 多格式音频内嵌封面与同目录封面解析
│   ├── recover.html            # 曲库恢复工具页（--recover-library 使用）
│   ├── ncmdump.exe             # NCM 解密工具（MIT）
│   ├── package.json            # Electron 应用元数据
│   └── ui/                     # app-rhine 构建产物同步目录（不入库，由构建脚本生成）
├── app-rhine/                  # 前端主界面源码（TypeScript + Vite + Three.js，基于 RhineLabUI）
│   ├── src/                    # 3D 终端场景、磁带模型视图、播放器、歌词、频谱引擎
│   ├── public/                 # 3D GLB 模型、循环背景音与按键短音、MiSans 字体与许可
│   ├── index.html              # Vite 入口
│   ├── package.json
│   ├── tsconfig.json
│   └── LICENSE                 # 上游 RhineLabUI MIT 许可
├── installer/
│   └── music-player.iss        # Inno Setup 6 安装包脚本
├── scripts/
│   ├── build-portable.ps1      # 前端构建、Electron 运行时准备与便携版同步
│   ├── build-installer.ps1     # 校验便携版并调用 Inno Setup 生成单文件安装包
│   └── install.ps1             # 本机安装、创建快捷方式与生成卸载脚本
├── 安装.bat                    # 一键构建、安装并启动（调用 scripts/install.ps1）
├── .gitattributes
├── .gitignore
├── LICENSE
└── README.md
```

开发时请只修改 `app/` 与 `app-rhine/src/`，不要直接改 `app/ui/` 或 `dist/`，它们会在下次构建时被完整覆盖。

---

## 数据管控

本程序会处理两类来自受限来源的本地派生音频：`.ncm` 解密结果与 B 站缓存剥离私有头后的音频。为此主进程实现了三层约束：

1. **会话级临时目录与最小落盘**：`.ncm` 解密与临时播放副本放在 `%TEMP%\mp-session-<会话ID>\`，读入内存后覆盖擦写并在退出时整体清理；崩溃残留会在下次启动时自动清扫。程序从不向用户音乐目录写入解密文件。
2. **明确边界的本地固化**：用户主动导入的 B 站缓存音频会在 `<userData>\library\audio\` 保留一份已剥离私有头的可播放副本，避免 B 站客户端自动清理缓存导致曲库出现无法播放的失效条目。该目录仅存于本机应用数据目录，不提供导出或上传。
3. **白名单 IPC 与本地审计**：渲染进程关闭 `nodeIntegration` 并启用 `contextIsolation`，`preload.js` 对 `send`/`on` 通道做白名单拦截，主进程对所有读盘与解码 IPC 校验 `senderFrame.url` 调用源；每次解密与提取写入本机 `userData` 下的审计日志（上限 500 条，不外发）。

> 请仅将本程序用于个人在本地播放已合法获取的音频内容，勿将派生音频用于传播、分发或商业用途。

---

## 常见问题

**Q：为什么仓库里没有 `音乐播放器.exe`？**  
Electron 运行时解压后约 222 MB（单文件超出 GitHub 100 MB 限制），仓库只保留源码与脚本。首次运行 `.\scripts\build-portable.ps1` 会自动准备运行时，之后离线复用。

**Q：耳机媒体键或键盘媒体键没有反应？**  
Windows 的全局媒体键是独占资源，可能被游戏或其它音乐软件抢占。可在设置面板查看媒体键注册状态，冲突时改用 `Ctrl + Alt + Space/P/←/→/N/B` 备用组合键。

**Q：多显卡笔记本下 3D 档案画面发糊或掉帧？**  
主进程默认优先请求独显以保证 3D 终端清晰度；如果某些双显卡环境下反而出现跨卡拷贝卡顿，可加 `--low-power-gpu` 启动回退核显，或使用 `--software-render` 排查驱动问题。

**Q：切换曲目后封面未更新或缺失？**  
可在曲目编辑/设置入口触发重新识别封面，或检查同目录下是否存在 `cover.*` 图片文件。

---

## 致谢与许可

### 本项目代码

本仓库自有代码采用 **MIT** 许可发布，详见根目录 [LICENSE](LICENSE)。

### 上游界面与 3D 美术资产

- **[RhineLabUI](https://github.com/LBEILC/RhineLabUI)**（MIT）— 作者 **LBEILC**（B 站 [@路北路陈](https://space.bilibili.com/3546646728820438)）。`app-rhine/` 内的终端界面骨架、动效时间轴、3D 档案阵列与磁带模型（`app-rhine/public/**/*.glb`）及循环背景音效均源自该项目，本项目在遵循 MIT 条款的前提下将本地音乐播放器反向整合其中。
- `app-rhine/public/audio/typing-preview.wav` 及其对应短音采样源自《明日方舟》特别映像 [莱茵生命：访问]，权利归原作者所有，不包含在上述 MIT 授权范围内（详见 [app-rhine/public/audio/README.md](app-rhine/public/audio/README.md)）。

### 字体与第三方依赖

- **MiSans 字体**：版权归小米科技有限责任公司所有，原样内嵌于 `app-rhine/public/fonts/`，许可原文见 [MiSans-license.pdf](app-rhine/public/fonts/MiSans-license.pdf)，声明见 [NOTICE.txt](app-rhine/public/fonts/NOTICE.txt)。
- **[Electron](https://github.com/electron/electron)**（MIT）
- **[ncmdump](https://github.com/taurusxin/ncmdump)**（MIT）
- **[Three.js](https://threejs.org/)**（MIT）与 **[@kitlangton/rolling-number](https://www.npmjs.com/package/@kitlangton/rolling-number)**（MIT，许可见 `app-rhine/public/licenses/rolling-number.txt`）

> Rhine Lab、RhineLabUI 等名称与相关标识归其各自权利人所有，本项目为非官方二次开发。如署名有任何遗漏或误差，请提 Issue 告知，会及时更正。
