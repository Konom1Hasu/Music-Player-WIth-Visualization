; ============================================================================
;  音乐播放器 · 一键安装包（Inno Setup 6）
;
;  由 scripts\build-installer.ps1 编译，也可以手动：
;      ISCC.exe /DMyAppVersion=2.1.1 music-player.iss
;
;  设计要点：
;   · 按用户安装（PrivilegesRequired=lowest）：装进 %LOCALAPPDATA%\Programs\，
;     双击 Setup.exe 直接装完，不弹 UAC、不需要管理员。
;   · 打包的是 scripts\build-portable.ps1 产出的整个便携目录 ——
;     安装包与便携版内容完全一致，只是把"解压到某个文件夹"变成"点下一步"。
;   · 升级：AppId 固定，所以新版本会覆盖旧版本到同一个目录，不会装出两份。
;   · 卸载**不动用户数据**（曲库在 %APPDATA%\music-player，删了就找不回来了）。
;   · 本文件必须存成 **UTF-8 带 BOM**，否则 Inno 会把中文按本地代码页读成乱码。
; ============================================================================

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif

#define MyAppName        "音乐播放器"
#define MyAppPublisher   "Konom1Hasu"
#define MyAppURL         "https://github.com/Konom1Hasu/Music-Player-WIth-Visualization"
#define MyAppExeName     "音乐播放器.exe"
#define MySourceDir      "..\dist\音乐播放器-win32-x64"

[Setup]
; 固定 AppId：同一个应用的新版本会认成"升级"，装到原目录而不是并存两份。
AppId={{7C41E0B6-2A9D-4E7F-9C3A-51D8B2F0A6E4}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}/releases
VersionInfoVersion={#MyAppVersion}
VersionInfoDescription={#MyAppName} 一键安装包
VersionInfoCompany={#MyAppPublisher}

; 按用户安装：不弹 UAC、不需要管理员，和便携版一样"删掉就干净"。
DefaultDirName={localappdata}\Programs\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog

; ---- 向导刻意做短：双击 → "下一步" → 勾选项 → "安装" → "完成" ----
;   · 没有许可页：MIT 的许可文本随程序一起装进 resources\app\LICENSE.txt，
;     不必再让用户多点一次"我接受"（这是"双击就能装完"的一部分）
;   · 没有开始菜单组页面（DisableProgramGroupPage）
;   · 没有"准备安装"确认页（DisableReadyPage）：设置页上直接就是"安装"按钮
;   · 保留目录页：默认 {localappdata}\Programs\音乐播放器，想换地方可以换
;   · 桌面快捷方式在"附加任务"里，**默认勾选、可以取消**（见 [Tasks]）
DisableReadyPage=yes

; 安装包自身
OutputDir=..\dist\安装包
OutputBaseFilename=音乐播放器-Setup-{#MyAppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

; 刻意不写 ArchitecturesAllowed / ArchitecturesInstallIn64BitMode：
;   · 这两个指令的取值在 Inno 6.3 前后不一样（x64 → x64compatible），
;     写死任何一个都会让"另一版本"的 ISCC 报 Unknown architecture；
;   · 本程序是纯文件树，安装目录在 {localappdata}\Programs（不做重定向），
;     也不需要 64 位安装模式。少这两条，本地装 6.2、CI 装 6.4 都能编译。

; 升级时若程序还在运行，提示关掉它（Electron 的 exe 会被占用）
CloseApplications=yes
RestartApplications=no
SetupLogging=yes

UninstallDisplayName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}

; 安装包图标：有就带上（build-installer.ps1 按"文件在不在"传 /DHasIcon）。
; 想换安装包图标：把 app.ico 放进 installer\ 即可，无需改本文件。
#ifdef HasIcon
SetupIconFile=app.ico
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

; Inno 官方发行版不带简体中文语言文件（中文是社区翻译，不随安装包提供），
; 所以这里用英文底子 + 把用户真正会读到的向导文案换成中文。
[Messages]
WelcomeLabel1=欢迎安装 {#MyAppName}
WelcomeLabel2=即将在你的电脑上安装 [name/ver]。%n%n安装不需要管理员权限，装到当前用户的目录里；继续前建议先关掉正在运行的程序。
SelectDirLabel3=安装程序会把 [name] 装到下面的文件夹。
SelectDirBrowseLabel=点"下一步"继续；想换一个文件夹就点"浏览"。
DiskSpaceMBLabel=至少需要 [mb] MB 可用空间。
SelectTasksLabel2=请选择安装时要顺便做的事，然后点"下一步"：
AdditionalIcons=附加快捷方式：
CreateDesktopIcon=创建桌面快捷方式(&D)
ReadyLabel1=准备就绪，可以开始安装 [name] 了。
ReadyLabel2a=点"安装"开始；想改前面的设置就点"上一步"。
InstallingLabel=正在安装 [name]，请稍候…
FinishedHeadingLabel=安装完成
FinishedLabelNoIcons=[name] 已经装好了，可以从开始菜单打开。
FinishedLabel=[name] 已经装好了，可以从开始菜单或桌面快捷方式打开。
ClickFinish=点"完成"关闭安装程序。
LaunchProgram=立即运行 %1
ButtonNext=下一步(&N) >
ButtonBack=< 上一步(&B)
ButtonInstall=安装(&I)
ButtonFinish=完成(&F)
ButtonBrowse=浏览(&B)…
ButtonCancel=取消
ConfirmUninstall=确定要卸载 %1 及其全部组件吗？%n%n（你的曲库与设置不会被删除。）
UninstalledAll=%1 已卸载完成。%n%n曲库与设置仍保留在 %APPDATA%\music-player，需要一并清除的话请手动删除该文件夹。

[Tasks]
; 桌面快捷方式：Inno 里 [Tasks] 条目**默认就是勾上的**，用户不想要就取消勾选。
; 想要"默认不勾"就把 Flags 改成 unchecked（这里刻意保持默认勾选 —— 多数人要它）。
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; 整个便携目录原样装进去（含 resources\app、resources\app\ui 与 LICENSE.txt）
Source: "{#MySourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
; 开始菜单：程序 + 卸载入口
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"
Name: "{group}\卸载 {#MyAppName}"; Filename: "{uninstallexe}"
; 桌面快捷方式：只有勾了 desktopicon 那一项才创建（这就是"可选"）
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; WorkingDir: "{app}"; Flags: nowait postinstall skipifsilent

; 刻意**没有** [UninstallDelete] 去删 %APPDATA%\music-player：
; 那里面是曲库、收藏和设置，卸载不该顺手把它们清掉。
