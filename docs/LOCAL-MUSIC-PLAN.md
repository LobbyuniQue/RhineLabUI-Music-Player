# 本地音乐检索与播放 · 执行计划

2026-09-28 制定（依据代码勘察校准）。范围：RhineLabUI **网页版主分支**（不改 `codex/wallpaper-engine` 壁纸分支的实现路径）。

关联文档：`docs/DESKTOP-FOLDERS.md`（真实文件夹交互的早期可行性研究，结论针对壁纸宿主）、`verification/AUDIO-DESIGN.md`（既有三轨配乐与音效）。

## 一、目标与范围

**目标**：网页版新增「本地音乐」模块——选择本机音乐目录 → 建立曲库索引 → 检索 → 播放；动效沿用既有玻璃/解密/HUD/滚动文字语言，并让真实音乐驱动阵列既有的音乐律动。

**范围内**
1. 本地目录接入、递归扫描、增量索引、失效检测
2. 音频元数据解析（标题/艺术家/专辑/音轨号/时长/封面）
3. 检索界面（多字段匹配、高亮、键盘导航、结果计数）
4. 播放器（队列、上/下一首、进度、音量、单曲/列表循环、随机、断点续播、系统媒体键）
5. 与既有背景音乐（三轨）与音效偏好的协作
6. 动效适配：**频谱驱动阵列既有 `MusicBands` 律动**、正在播放条、面板开合、滚动文字、亮/暗主题与「减少动态效果」
7. 持久化（IndexedDB）、验证与文档

**范围外**
- 在线/流媒体音乐、歌词、标签编辑、文件重命名/移动/删除
- Wallpaper Engine 属性接入（壁纸分支另议）
- 拼音首字母检索（需码表，本轮做子串 + 空格分词 AND，保留后续扩展点）
- Safari/Firefox 的目录持久化（无 File System Access API，降级为单次会话选择）

## 二、关键决策（已按代码勘察校准）

| 决策点 | 选择 | 依据 |
| --- | --- | --- |
| 目录接入 | File System Access API `showDirectoryPicker()` | 网页版 Chromium 下无需额外服务；早期研究针对壁纸宿主，不适用网页版 |
| 降级 | `<input type="file" webkitdirectory>` | iPhone/Safari 是一等目标却没有该 API，必须降级并明确标注差异 |
| 句柄持久化 | 目录句柄存 **IndexedDB**（项目此前无 IndexedDB，新建最小封装） | 句柄可结构化克隆；权限用 `queryPermission`/`requestPermission` 复查 |
| 元数据 | **自研解析器，不加依赖** | 项目运行依赖仅 `three` + `@kitlangton/rolling-number`，保持原生实现风格 |
| 支持格式 | mp3（ID3v2.2/2.3/2.4 + ID3v1）、flac、m4a/mp4、ogg/opus、wav | 覆盖主流本地曲库 |
| 播放内核 | **VLC**（官方 Windows 便携发行版，`vlc.exe` + HTTP 接口 + 本地流转码），由 Node 本地桥接服务驱动 | 用户 2026-09-28 明确要求：以 VLC 为内核，不再自行处理格式与编解码。浏览器无法链接原生库，故以回环桥接方式集成 |
| 桥接服务 | `scripts/vlc-bridge.mjs`：仅监听回环、每次启动随机令牌；负责 VLC 进程生命周期、目录扫描、播放控制、状态与元数据 | 与 `docs/DESKTOP-FOLDERS.md` 的结论一致；网页侧不获得任何文件系统特权 |
| 播放数据通路 | VLC 解码 → 本地流转码（ogg/wav）→ 浏览器 `HTMLAudioElement` + `AnalyserNode` → 既有 `MusicBands` 阵列律动 | 任何 VLC 支持的格式都能获得完整频谱动画，且无需在服务端自研 DSP |
| 浏览器直读（降级） | 保留既有 File System Access + `<audio>` 通路 | 桥接/VLC 不可用（例如线上托管版本）时仍能播放浏览器原生支持的格式 |
| 频谱与动画 | 走既有 `SpectrumEnvelope` / `setPlayfield` 接缝，与壁纸宿主同构 | 不改动既有视觉规范 |
| 与 BGM 协作 | 给 `TerminalAudio` 增加**外部播放占用接口**（占用时淡出三轨，释放后按偏好恢复） | 保持单一协调者，避免双份音乐 |
| 页面隐藏行为 | 本地音乐**继续播放**（用户显式播放意图），`pagehide` 停止并保存断点；既有 BGM 维持「隐藏即停」原行为 | 音乐播放器的合理预期，同时不动既有规则 |
| 动效接入 | 用 `AnalyserNode` 喂**既有 `MusicBands`**（`archive-play-motion.ts`） | 网页版该管线当前无数据源（只有壁纸宿主喂），接入后本地音乐即可驱动阵列律动、连续频谱、层叠流波、响度、波频、宽频与高频微光七种风格 |
| 音效礼仪 | 本地曲目**不**派发 `rhine-local-sound`（使其能驱动律动）；应用自身音效维持既有派发 | 遵循 `audio.ts:595` 与 `archive-play-motion.ts:10-17` 的既定约定 |
| 检索 | 多字段子串 + 空格分词 AND；排序：前缀 > 词首 > 包含；`toLowerCase` + `NFKC` | 中英文混排可用、性能可预期 |
| 索引存储 | IndexedDB `rhine-music`：`tracks` / `handle` / `covers`（封面缩略图 ≤256px Blob） | 万首级不能放 localStorage |
| 增量 | `path + size + lastModified` 三元组比对 | 二次进入秒开 |
| 静态资源 | **不新增任何 `public/` 静态文件** | 规避发布风险：`scripts/build-pwa.mjs:6-11` 白名单决定哪些资源被预缓存**且**被 Cloudflare 发布，未列入者线上 404 |

### 2026-09-28 修订：为什么是「二进制 + 桥接」而不是「vendor 源码」

- **浏览器不能链接原生库**：网页面无法 `dlopen` libVLC，因此 VLC 只能以本机伴生进程形式参与，网页通过回环 HTTP 通信。这也是壁纸分支研究（`docs/DESKTOP-FOLDERS.md`）得出的同一结论。
- **从源码构建不划算**：Windows 上编译 videolan/vlc 需要 MSYS2 + MinGW-w64 交叉工具链（数小时、数十 GB 依赖），产出与官方发行版等价的 `vlc.exe` / `libvlc.dll`。项目采用「锁定版本 + 下载 + SHA256 校验」的 `scripts/fetch-vlc.mjs` 集成官方二进制，安装在 `.tools/vlc/`（`.gitignore` 已排除 `.tools/`）。
- **许可证**：libVLC 为 LGPLv2.1+，`vlc.exe` 发行版为 GPLv2+。本项目以独立进程调用、不链接、不修改，且仅在用户本机使用；若将来随发行包分发 VLC 二进制，需同时提供其源码获取方式，文档中已注明。
- **离线可用**：VLC 仅在本机运行，曲库不离开本机；桥接服务只监听 `127.0.0.1` 并校验每次启动的随机令牌，网页侧无法读取令牌以外的任何路径。

## 三、模块与文件清单（沿用项目「扁平 src + 功能 CSS 同目录」约定）

**新增**
| 文件 | 职责 |
| --- | --- |
| `src/music-metadata.ts` | 容器与标签解析（ID3v2/ID3v1、FLAC、MP4、Ogg、WAV）→ 统一 `TrackMeta`；GBK 标签用 `TextDecoder("gbk")` 兜底 |
| `src/music-search.ts` | 纯函数检索评分与排序（便于 Node 侧断言） |
| `src/music-store.ts` | IndexedDB 最小封装：曲目索引、目录句柄、封面缩略图、版本迁移 |
| `src/music-library.ts` | `MusicLibrary`：目录接入/降级、递归扫描、增量与失效、进度回调、分批+空闲调度 |
| `src/music-player.ts` | `MusicPlayer`：队列、循环/随机、进度、音量、断点、`MediaSession`、`AnalyserNode` → `MusicBands` |
| `src/music-panel.ts` | 音乐弹窗：曲库状态、扫描进度、检索框、结果列表、键盘导航、正在播放条 |
| `src/music-settings.ts` | 设置面板内的「本地音乐」区块（复用 `audio-settings.ts` 的标记风格） |
| `src/music-bridge.ts` | 桥接客户端：探测 `127.0.0.1:<port>`、令牌握手、状态轮询、命令下发；不可用时报告并降级 |
| `scripts/fetch-vlc.mjs` | 下载锁定版本的官方 VLC Windows 便携版到 `.tools/vlc/`，校验 SHA256，打印版本 |
| `scripts/vlc-bridge.mjs` | 本地桥接服务（Node，零依赖）：VLC 进程管理、目录扫描、播放控制、本地流转码、状态与元数据 |
| `src/music.css` | 视觉与动效（玻璃、解密线、滚动文字、主题变量、频谱） |

**修改**
| 文件 | 改动点（已核实位置） |
| --- | --- |
| `src/main.ts` | CSS/模块 import（顶部 import 块 `1-57`）；`modal` 联合类型加 `"music"`（`116`）；`.system-nav` 入口按钮（`68-72`）与 `data-action` 分发（`827-830`）；`openModal` 重置（`602-603`）；`renderModal` 分支（`628-652`）；`renderResults` 同构的 `renderMusicResults`；键盘（`856-935`，Esc 已通用）；**每帧工作加入唯一 rAF 循环 `frame()`（`1000-1046`）**，不新建循环；`fit()` 复测（`341-346`）；调试面 `window.rhine`（`1294-1335`）可选扩展 |
| `src/audio.ts` | 仅新增公开方法（占用/释放外部播放），不改既有混音与音效 |
| `src/motion-preferences.ts` | 新增 `MotionKey`（`1-15`）+ `MOTION_LABELS`（`24-98`）+ 完整/减少预设（`100-132`） |
| `src/theme-ui.ts` / `src/theme.css` | 仅使用既有 `--theme-*` 变量，必要时补音乐面板专用变量（不新增硬编码色） |
| `src/style.css` | 仅当需要共享弹窗骨架样式时补少量规则 |
| `AGENTS.md` | 追加本轮授权与功能条目（项目惯例） |

**验证与文档**
| 文件 | 内容 |
| --- | --- |
| `scripts/check-music.mjs` | Node 断言（`node --experimental-strip-types --test`，同 `check-content.mjs`）：解析、检索排序、队列/循环/随机、增量比对 |
| `reference/local-music-check.html` | 浏览器检查页：索引/播放/降级/减少动态效果/律动接入；自动恢复开始前存储（沿用既有检查页惯例） |
| `verification/LOCAL-MUSIC.md` | 证据、复现步骤、局限 |
| `docs/LOCAL-MUSIC.md` | 使用说明（选目录、权限、格式、与 BGM 关系、隐私说明） |

## 四、分阶段实施

**阶段 0 · 备份与基线（已完成）**
- 工作区备份 `本机备份/莱茵科技-备份-20260928-1440`（1221 文件 / 138 MB，SHA256 清单 0 处不一致）
- 源码 git 基线 `4c370fb`（1217 文件），改动可 diff、可回滚

**阶段 1 · 解析与索引内核**：`music-metadata.ts` / `music-search.ts` / `music-store.ts` / `music-library.ts` 的纯逻辑部分
- 验收：真实样本（mp3/flac/m4a/ogg/wav）解析出标题/艺术家/专辑/时长；无标签回退文件名；坏文件不中断扫描
- 验证：`node scripts/check-music.mjs` 全绿

**阶段 2 · 目录接入与曲库**：`showDirectoryPicker` + 降级、扫描进度、IndexedDB 增量、失效检测
- 验收：二次进入免重扫；删除文件后重扫标记失效；拒绝授权有可操作提示

**阶段 3 · 检索**：检索框、字段范围、结果列表与高亮、↑↓/Enter/Esc、结果计数
- 动效：面板进出复用 `SurfaceTransition`（进入 300ms / 退出 200ms），列表用 Web Animations API（`[data-review]` 会禁用 CSS transition，不能依赖它）
- 验收：5000 首检索 < 50ms；中英混排可命中

**阶段 4 · 播放**：`music-panel.ts` 播放区 + `music-player.ts`
- 验收：连续切歌无爆音；播放中切场景/开详情/进查看器不中断；页面隐藏继续播放、离开页面保存断点；系统媒体键可用

**阶段 5 · 音频协作**：`audio.ts` 占用接口 + `music-settings.ts` + 偏好联动
- 验收：本地音乐播放时三轨淡出、结束后按偏好恢复；关闭音效不影响本地音乐；永不同时播放两份音乐

**阶段 4b · VLC 桥接（播放内核，2026-09-28 追加）**
- `scripts/fetch-vlc.mjs` 获取并校验官方 VLC 便携版到 `.tools/vlc/`
- `scripts/vlc-bridge.mjs`：回环 + 令牌；`/api/health`、`/api/scan`、`/api/library`、`/api/play|pause|seek|volume`、`/api/status`、`/api/stream/<id>`（VLC 转码为浏览器可播的本地流）
- `src/music-bridge.ts` + 面板接入：优先使用 VLC 曲库与播放；曲库来源可选「VLC 桥接」或「浏览器直读」
- 验收：VLC 支持的格式（含 flac/ape/wma 等浏览器不支持者）可检索与播放；桥接不可用时给出可操作提示并回退浏览器直读；频谱动画在 VLC 通路下同样工作

**阶段 6 · 动效适配**：`AnalyserNode` → `MusicBands`（阵列律动 / 连续频谱 / 层叠流波三种既有风格复用）；正在播放条玻璃进出；标题滚动；亮暗主题；减少动态效果降级
- 验收：频谱不引入新 rAF；桌面帧率与既有场景同量级；暗色下颜色正确

**阶段 7 · 构建与验证**：`npm run build`、`check:content`、`check:viewport` 回归、截图（亮/暗）、扫描与检索耗时记录

**阶段 8 · 文档与提交**：`docs/LOCAL-MUSIC.md`、`verification/LOCAL-MUSIC.md`、`AGENTS.md` 追加条目、聚焦本任务的 git 提交

## 五、验收清单

- [ ] Chromium 可选本机目录、建库、重启免重扫，句柄权限过期可重新授权
- [ ] 无 FS Access API 的浏览器有可用降级与明确提示
- [ ] 检索覆盖标题/艺术家/专辑/文件名/路径，键盘全程可操作
- [ ] 播放：队列、循环、随机、进度、音量、断点续播、系统媒体键
- [ ] 与既有 BGM/音效无冲突，偏好联动正确
- [ ] 本地音乐驱动阵列律动（七种风格，含平滑宽频与高频微光），亮/暗主题与「减少动态效果」正确
- [ ] 既有功能回归通过（开场、阵列、详情、360° 查看器、设置、PWA）
- [ ] `npm run build` 与 `check:content`、`check:viewport` 通过，无新增类型错误
- [ ] 未新增 `public/` 静态资源（或已同步更新 `build-pwa.mjs` 白名单）
- [ ] 文档与验证文件齐备

## 六、风险与对策

| 风险 | 对策 |
| --- | --- |
| 发布白名单漏项导致线上 404 | 本轮不新增静态资源；若将来新增，必须同步 `scripts/build-pwa.mjs:6-11` |
| 弹窗登记脆弱（`inert`/`modalSiblings`/`previousFocus`/`modalClosing` 需一起维护） | 复用既有 `openModal`/`closeModal` 通路，不另写弹窗机制 |
| 每帧开销 | 只用唯一 `frame()`；频谱降采样、仅可见时绘制 |
| 大曲库扫描卡顿 | 分批 + `requestIdleCallback` + 进度可视化；封面懒加载限尺寸 |
| 标签缺失/GBK 乱码 | `TextDecoder("gbk")` 兜底 → 文件名回退，绝不中断扫描 |
| 与 BGM 冲突 / 上下文打断 | 播放前占用、结束后释放；隐藏页面规则明确 |
| 移动端 Safari 无 API | 降级单次选择，文档明确不承诺持久化 |
| 主题硬编码色 | 一律走 `--theme-*`（`paintTheme` 每帧写入） |
| 误改 `content/archives.json` | 音乐数据独立存 IndexedDB；`check:content` 约束 40 条档案不动 |

## 七、执行记录（随实施更新）

| 阶段 | 状态 | 备注 |
| --- | --- | --- |
| 0 备份与基线 | ✅ 完成 | 备份校验 0 差异；git 基线 `4c370fb` |
| 1 解析与索引内核 | ✅ 完成 | `scripts/check-music.mjs` 全绿（含真实 mp3 与 GBK 标签） |
| 2 目录接入与曲库 | ✅ 完成 | File System Access + 降级；IndexedDB 增量（二次扫描全复用） |
| 3 检索 | ✅ 完成 | 多字段/字段过滤/音轨号/高亮/键盘操作 |
| 4 播放 | ✅ 完成 | 队列、循环/随机、进度、音量、断点、MediaSession |
| 5 音频协作 | ✅ 完成 | 本地音乐占用时三轨让位，停止后恢复（浏览器与 VLC 两条通路一致） |
| 4b VLC 桥接（播放内核） | ✅ 完成 | 官方 VLC 3.0.21（SHA256 校验）+ 桥接服务 + 网页内核切换；协议自检 7/7 |
| 6 动效适配 | ✅ 完成 | PCM → 128 样本频谱 → 既有 `MusicBands`；动画偏好与减少动态效果跟随 |
| 7 构建与验证 | ✅ 完成 | `npm run build` 通过；`verification/LOCAL-MUSIC.md` 记录证据 |
| 8 文档与提交 | ✅ 完成 | `docs/LOCAL-MUSIC.md`、`verification/LOCAL-MUSIC.md`、`启动音乐服务.cmd`、提交 |

遗留与已知限制见 `verification/LOCAL-MUSIC.md`（无头环境 VLC 起播缓慢属环境因素；非常见格式未逐个实测）。
