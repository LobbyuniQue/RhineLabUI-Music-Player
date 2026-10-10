# 莱茵科技 · 本地音乐与三维档案

RhineLabUI 本地扩展工程，以三维档案阵列承载本地曲库，把歌曲封面、音乐信息、播放控制和音频律动接入同一套界面。

当前开发围绕 **本地音乐播放、VLC 桥接、音乐档案交互和工程维护** 展开。项目基于原 RhineLabUI 的 TypeScript、Three.js 和 Vite 实现，继续使用其档案场景、模型及交互动效。

开源仓库：[LobbyuniQue/RhineLabUI-Music-Player](https://github.com/LobbyuniQue/RhineLabUI-Music-Player)。

功能迭代记录到 **2.3（2026-10-09）**，目录维护完成于 **2026-10-10**。详细变更见 [版本记录](docs/releases/README.md)；这里的功能迭代编号与 `package.json` 中保留的 `1.0.0` 分开记录。

## 当前功能

### 本地音乐与三维曲库

| 功能 | 当前行为 |
| --- | --- |
| 本地曲库 | 扫描所选音乐目录，读取曲名、歌手、专辑、封面等元数据，提供检索与重新扫描 |
| 两种播放内核 | VLC 桥接负责本机解码与播放；浏览器内核使用浏览器自身的音频能力 |
| 音乐档案阵列 | 顶部 `ARCHIVE / MUSIC` 切换档案库与音乐库，每首歌对应一张三维档案卡 |
| 曲库分组 | 按专辑、歌手或首字母排列，每列对应一个分组；默认按专辑，中文歌手支持拼音首字母归类 |
| 封面与详情 | 封面贴在音乐卡正面，歌曲名为主标题，歌手与专辑为次信息；详情可查看和导出曲目信息 |
| 档案播放入口 | 音乐模式下点击 `ACCESS FILE`、文件号或按 Enter，进入详情并播放选中的歌曲 |
| 音频律动 | 播放频谱驱动档案阵列与音乐面板；关闭音乐面板后，主场景继续响应音乐 |
| 配乐让位 | 播放本地音乐时背景配乐让位，停止后按设置恢复 |
| 统一启动 | 一个入口管理网页服务、可选 VLC 桥接和浏览器打开，复用上次的音乐目录 |

设置 → 本地音乐中可调整：

- **MUSIC REACTION**：原版、连续频谱、层叠流波、响度律动、波频律动、宽频律动、高频微光，共七种；默认波频律动。
- **ARCHIVE GROUPING**：专辑、歌手、首字母三种分组。
- **ARCHIVE SPACING**：音乐档案行距范围 `0.62–8`，默认 `4.05`，修改后实时预览并保存。
- **PLAYBACK KERNEL**：选择浏览器内核或 VLC 桥接，查看连接状态与曲库信息。

### 保留的档案基础

内置档案仍采用五类、40 份记录，支持阵列浏览、检索、收藏、正文阅读与文本导出。三维档案可抽取、解密，并进入独立模型查看器进行旋转、缩放、拆解和重组。

明暗配色、画质设置、减少动态效果、键盘与触摸交互，以及正式网页构建的 PWA 能力继续保留。内置档案和开场阵列使用固定行距 `0.62`，音乐行距设置单独生效。

## 运行环境

| 项目 | 要求 |
| --- | --- |
| 系统 | 当前统一启动与 VLC 获取流程以 Windows 64 位环境为主 |
| Node.js | 22.12 或更高版本，需包含 npm |
| 浏览器 | 支持 WebGL 2 的现代浏览器；本机曲库使用优先选择 Edge 或 Chrome |
| VLC | 使用 VLC 内核时需要；统一启动入口会查找已有安装，缺失时调用获取脚本 |
| 网络 | 首次安装 npm 依赖及获取 VLC 时需要 |

VLC 由独立的本地桥接进程调用，网页负责界面、控制与动画。音乐格式支持取决于所用内核：VLC 使用其发行版提供的解码能力，浏览器内核使用浏览器支持的格式。

## 快速启动

克隆仓库，或下载并解压源码后进入项目目录。在 PowerShell 中克隆：

```powershell
git clone https://github.com/LobbyuniQue/RhineLabUI-Music-Player.git
cd RhineLabUI-Music-Player
```

在项目目录执行：

```powershell
.\启动莱茵科技.cmd "D:\Music"
```

将 `D:\Music` 替换为自己的音乐文件夹。也可以直接双击 [启动莱茵科技.cmd](启动莱茵科技.cmd)：有已保存目录时复用该目录，没有目录记录时按终端提示选择；直接回车则只启动网页。

使用 npm 启动的等价入口：

```powershell
npm run start:all -- --root "D:\Music"
```

统一入口会按需安装依赖、准备 VLC、寻找空闲端口并打开网页。网页端口从 `5173`、桥接端口从 `8788` 开始查找，实际地址以终端输出为准。保持启动窗口运行，按 Ctrl+C 停止服务。

音乐目录记录在 `.tools/music-root.txt`。更换目录时停止服务，再用新的 `--root` 参数启动。

### 其他启动方式

| 用途 | 命令 |
| --- | --- |
| 只启动网页 | `npm run start:all -- --no-music` |
| 启动但不自动打开浏览器 | `npm run start:all -- --root "D:\Music" --no-open` |
| 只启动 VLC 桥接 | `npm run start:all -- --bridge-only --root "D:\Music"` |
| 前端开发调试 | `npm run dev`，运行前先安装依赖 |

[启动终端.cmd](启动终端.cmd) 与 [启动音乐服务.cmd](启动音乐服务.cmd) 保留为兼容入口。单独启动桥接时，需要在网页设置中填写其输出的端口与令牌；参数和排查步骤见 [本地音乐说明](docs/LOCAL-MUSIC.md)。

## 使用音乐库

1. 用统一入口指定音乐目录后，网页会接入本次 VLC 桥接并载入曲库。也可在设置 → 本地音乐中选择浏览器内核，通过页面提供的选择入口读取音乐。
2. 点击顶部 `MUSIC` 切换到音乐档案阵列，在设置中选择按专辑、歌手或首字母分组。
3. 通过拖动、滚轮、方向按钮或键盘浏览歌曲。音乐模式下的检索可按曲名、歌手和专辑查找。
4. 点击选中档案的 `ACCESS FILE`、文件号或按 Enter，打开详情并开始播放。详情中的 `EXPORT` 导出曲目信息文本。
5. 进入 `LOCAL MUSIC` 面板进行曲库检索和播放控制；返回主界面后仍可观看档案律动。

浏览器内核的目录授权与可用格式取决于浏览器；重新打开页面时可能需要再次授权。VLC 桥接只监听 `127.0.0.1`，网页通过本次启动的令牌访问已扫描曲目。统一入口会自动交接连接信息，临时凭据保存在当前标签页会话中。

## 当前限制与后续维护

- 歌词功能尚未实现，相关规划见 [本地音乐开发计划](docs/LOCAL-MUSIC-PLAN.md)。
- 封面图集提供 255 个曲目封面槽位，超出容量时使用占位封面；曲库切换后的槽位回收仍需完善。
- 单个分组超过 20 首时，档案槽位映射存在跨列问题，大曲库的阵列索引需要继续修正。
- 音乐面板上一首/下一首按钮方向、快速切歌和加载中停止的状态同步，以及桥接断连后的状态恢复，仍有待修复项。

## 开发、构建与检查

以下命令均在项目目录执行。

### 开发与静态预览

```powershell
npm ci
npm run dev
```

开发服务默认地址为 `http://127.0.0.1:5173/`，具体以启动输出为准。开发模式不注册 Service Worker。

```powershell
npm run build
npm run preview:dist
```

正式网页和 PWA 输出到 `dist/`，静态预览默认地址为 `http://127.0.0.1:4173/`。通过 HTTP 访问构建结果；PWA 在 localhost 或 HTTPS 环境使用。

已有的其他构建入口继续保留：

| 命令 | 输出 | 说明 |
| --- | --- | --- |
| `npm run build:cloudflare` | `release/cloudflare/` | Cloudflare 静态发行包，配置见 [托管说明](docs/CLOUDFLARE-DEPLOYMENT.md) |
| `npm run build:wallpaper` | `release/wallpaper/` | Wallpaper Engine 构建；工作台和宿主能力见 [壁纸说明](docs/WALLPAPER-ENGINE.md) |

普通网页开发使用 `dev` 与 `build` 即可。重新编辑三维资产时再使用 Blender，日常运行使用现有 GLB 模型。

### 基础检查

```powershell
npm run check
npm run check:tools
```

`check` 覆盖 TypeScript、档案内容、视口、音乐、小游戏、档案可见性，以及辅助工具语法；`check:tools` 只检查辅助工具语法。

### 浏览器与 VLC 验证

先执行 `npm run build`，再按顺序运行：

```powershell
npm run test:e2e:music
npm run test:e2e:vlc
```

脚本自动查找 Windows 上的 Edge 或 Chrome；VLC 验证还需要可用的 VLC 安装。特殊浏览器路径可通过环境变量指定：

```powershell
$env:RHINE_BROWSER = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm run test:e2e:music
```

测试曲库由脚本生成，截图位于 `.local/screenshots/music/`，浏览器配置与样本放在 `.local/` 对应子目录。工具只结束自己启动的进程树。更多参数见 [端到端工具说明](scripts/e2e/README.md)。

2026-10-10 的目录维护已通过基础检查、迁移完整性检查与静态服务验证；完整浏览器和 VLC 端到端套件尚未在整理后的目录上重跑。音乐功能的历史验证及无头 VLC 起播限制见 [音乐验证记录](verification/LOCAL-MUSIC.md)，本轮维护结果见 [目录维护验证](verification/DIRECTORY-MAINTENANCE.md)。

## 项目目录

主要目录按当前工作区布局整理如下：

```text
工作区/
├── 工作区说明.md
└── RhineLabUI/
    ├── README.md                 当前工程入口说明
    ├── src/                      页面、三维场景与音乐模块
    ├── content/                  内置档案数据及内容维护说明
    ├── public/                   模型、字体、音频与静态资源
    ├── art/                      Blender 源工程和建模脚本
    ├── scripts/                  启动、构建与基础检查
    │   ├── e2e/                  浏览器与 VLC 端到端验证
    │   ├── diagnostics/          封面、导航、播放等专项探针
    │   └── lib/                  工具共用路径、样本与进程处理
    ├── docs/
    │   ├── PROJECT-STRUCTURE.md   目录、输出与备份约定
    │   ├── LOCAL-MUSIC.md         音乐使用与排查说明
    │   └── releases/             历史版本说明与路径对照
    ├── verification/             验证记录及长期证据
    ├── reference/                开发对照工具
    ├── wallpaper/                壁纸宿主配置与资源
    ├── .local/                   本机缓存、测试样本与截图
    └── .tools/                   VLC 工具位置与启动记录
```

`.local/`、`.tools/`、`node_modules/`、`dist/` 和 `release/` 已排除 Git。长期保留的验证材料归入 `verification/`；历史版本说明保留当时的信息，路径变更查阅 [版本索引](docs/releases/README.md)。

## 维护文档

| 需要处理的内容 | 入口 |
| --- | --- |
| 本地音乐使用、内核选择与故障排查 | [本地音乐说明](docs/LOCAL-MUSIC.md) |
| 目录维护、本机输出与备份 | [项目目录说明](docs/PROJECT-STRUCTURE.md) |
| 版本进度与历史改动 | [版本记录](docs/releases/README.md) |
| 启动、构建、检查与辅助脚本 | [脚本说明](scripts/README.md) |
| 专项诊断 | [诊断工具说明](scripts/diagnostics/README.md) |
| 开源范围、脱敏与构建验证 | [开源准备记录](verification/OPEN-SOURCE.md) |
| 修改内置档案 | [档案内容说明](content/README.md) |
| 三维视觉与动效约束 | [设计规范](DESIGN.md) |
| 网页安装与离线机制 | [PWA 说明](docs/PWA.md) |

内置档案数据统一维护在 `content/archives.json`。开发启动与构建前会校验数据并更新文本导出；修改后也可执行 `npm run export:archives` 单独同步。

## 原工程与资源来源

本工程基于 [LBEILC / RhineLabUI](https://github.com/LBEILC/RhineLabUI) 继续开发，保留原工程的三维档案、模型、开场、查看器和部分基础交互。原工程在线展示入口：[rhine.lubeiluchen.cc](https://rhine.lubeiluchen.cc/)。

原工程的视觉参考为《明日方舟》特别映像「莱茵生命：访问」：[BV1rr4y1b7sz](https://www.bilibili.com/video/BV1rr4y1b7sz/)。项目为非官方工程，原作名称、标志、设定及相关素材的权利归各自权利人所有。

- 仓库沿用 [MIT License](LICENSE)，保留原作者署名 `Copyright (c) 2026 LBEILC`。
- MiSans 的许可保留在 [字体许可文件](public/fonts/MiSans-license.pdf)，分包来源记录在字体目录内；Novecento 为本机独立许可资源，按既有规则排除 Git。
- Rolling Number 及其他依赖遵循各自许可，见 [Rolling Number 许可](public/licenses/rolling-number.txt)。
- 配乐、音效和原片短音的来源与处理记录见 [音频说明](public/audio/README.md)。原作素材、音频采样及独立许可的第三方资源不纳入本项目的 MIT 授权范围。
- VLC 作为独立程序使用，获取、安装位置与许可记录见 [本地音乐说明](docs/LOCAL-MUSIC.md)。
