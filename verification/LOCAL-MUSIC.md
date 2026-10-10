# 本地音乐检索与播放验证

> 2026-10-10 目录维护：下文保留当时的验证记录。当前脚本为 `scripts/e2e/verify-music.mjs`、`scripts/e2e/verify-vlc-ui.mjs`，专项探针在 `scripts/diagnostics/`；原 `_shots/` 已迁至 `.local/screenshots/music/`。命令及旧名称对照见 [目录说明](../docs/PROJECT-STRUCTURE.md) 和 [版本索引](../docs/releases/README.md)。新音频样本使用项目原创配乐与生成的测试音。

2026-09-28。范围：网页版本地音乐模块（浏览器内核 + VLC 桥接内核），在真实 Vite 构建产物与真实 VLC 3.0.21 上验证。

## 覆盖

### 1. 核心逻辑（Node，无浏览器）

`node --experimental-strip-types scripts/check-music.mjs`：通过。

- 容器解析：mp3（ID3v2.3 + ID3v1 兜底、CBR 时长）、flac（STREAMINFO + Vorbis comment）、m4a（moov/udta/meta/ilst + mvhd 时长）、ogg（识别头 + 注释头 + 末页 granule 时长）、wav（fmt/data 时长）
- 异常与编码：损坏文件回退文件名不抛错；**声明为 Latin-1 实为 GBK 的 ID3 标签**正确还原为「观测室」
- 检索：多字段命中、字段过滤、`07` 命中音轨号、多词 AND、高亮分段、时长/容量格式化
- 真实文件：本机 `Business Hi Tech Music.mp3` → 标题 `Business Hi Tech Music`、艺术家 `plastic3`、时长 208s；另一 mp3 → 120s

### 2. VLC 桥接协议（Node + 真实 VLC）

`node scripts/check-vlc-bridge.mjs`：7/7 通过（脚本自建临时曲库，含中文文件名）。

- 桥接就绪并启动 VLC 3.0.21 (win64)
- 未携带令牌的请求返回 401
- 曲库扫描（含中文文件名解析）
- **通过 VLC 播放**本地文件：`state=playing`、时长正确
- **PCM 旁路频谱**：60Hz 测试音 → 低频段占优（low > high）
- 频谱 SSE 持续推送
- 定位到 4s 与暂停均生效

另有独立探测记录（一次性脚本，用于确定架构）：

- VLC 元数据来源：`in_play` 后 `status.json` 返回 `title=Business Hi Tech Music`、`artist=plastic3`、`length=208`
- 频段映射精确性：60Hz→60Hz、440Hz→440Hz、6kHz→6000Hz
- 无浏览器时通过 HTTP 命令播放立即进入 `playing`（同一桥接、同一文件）

### 3. 网页集成（真实构建产物 + 无头 Edge + CDP）

`_verify-vlc-ui.mjs`（工作区脚本）：7/7 通过。

- 桥接就绪；页面就绪
- 设置写入 VLC 内核后重新载入 → **页面自动连接桥接**（根目录、VLC 版本、5 首）
- 桥接曲库进入网页检索：`bridge` 标记 5 首、`plastic3` 命中 1、中文「正弦」命中 3
- 音乐面板渲染 5 行，状态栏显示「**VLC 内核** + 桥接根目录 + 5 首 + 1 位艺术家 + 8.2 MB + 已记忆」
- 设置面板显示播放内核选择与桥接状态（已连接 · VLC 3.0.21 · 5 首 · 根目录）
- 截图：`_shots/music-panel-vlc.png`、`_shots/music-settings-vlc.png`

浏览器内核通路（`_verify-music.mjs`，前述实现）此前已通过：目录注入 → 扫描（4 文件）→ 检索 → 播放 → 频谱低频/高频映射 → 暂停/继续/定位 → 索引持久化复用 → 暗色主题。

### 4. 构建与静态检查

`npm run build`：通过（tsc + vite + PWA 离线包 818 文件 / 33.9 MiB）。`node_modules/typescript/bin/tsc -p tsconfig.json`：0 错误。

### 5. 检索界面与档案检索统一（2026-09-28 追加）

用户要求「抄原项目档案搜索部分的代码到歌曲搜索，让界面更整洁」。做法是直接复用档案检索弹窗的结构与排版，而不是另画一套：

- 复用共享类：`.search-field`、`.category-filters`、`.result-header`、`.result-row`、`.result-name`、`.empty-results`、`.modal-bottom`——与档案检索弹窗完全同构，暗色主题由 `theme.css` 既有 `[data-dark-surface]` 规则自动覆盖。
- 列结构改为「TRACK / 曲目（序号 + 标题 + 艺术家·专辑小字）· FORMAT / 格式 · TIME / 时长」，替代原先自定义的五列行。
- 检索范围改为纯文字按钮（全部 / 标题 / 艺术家 / 专辑），去掉拉丁文字提示；「选择目录」「重新扫描」归入同一行右端，弹窗只剩一条控件线。
- 曲库信息压成一行弱化文字（目录 · 曲目数 · 艺术家数 · 容量 · 记忆状态），扫描时该行切换为进度；播放内核与结果计数移到 `.modal-bottom`（`NN TRACKS FOUND` … `VLC 内核 ● CONNECTED`）。
- 空状态改用 `.empty-results`（∅ / ♪ + 说明 + 「重置检索 →」或「选择音乐目录 →」按钮）。
- 键盘光标初值改为 -1（列表默认保持中性，方向键后才出现高亮），与档案检索的默认观感一致。
- 修掉两处观感缺陷：`.music-modal` 改为纵向 flex，面板按剩余高度布局，播放条不再溢出卡片；列表默认不再预先高亮首行。

验证：`_verify-vlc-ui.mjs` 7/7 通过（含「音乐面板沿用档案检索结构」一项，检查行数、内核标签与结果计数）；截图 `_shots/music-panel-vlc.png` 显示标题 / 搜索行 / 筛选行 / 结果表头 / 结果行 / 播放条 / 页脚均落在卡片内且与档案检索同宽同排；`tsc` 0 错误、`npm run build` 通过。

### 6. 档案随音乐响度律动（2026-09-28 追加，1.2）

用户要求「档案能随音乐响度律动」。此前三种律动都由低/中/高频段分别驱动（波的位置随频段分布），没有一档跟随**整体响度**的律动；本次新增第四种律动风格：

- `MusicBands` 增加 `loudness`：`SpectrumEnvelope` 把 128 样本频谱折算为整体响度（`spectrumLoudness`，低频 bin 权重 1、中频 0.8、高频 0.45，软膝曲线 `1−e^(−4.2·rms)` 保留瞬态同时让弱音可读）；包络快攻（约 45ms）慢放（约 0.4s），节拍清晰、余韵不闪。浏览器内核（AnalyserNode 折叠）与 VLC 桥接（PCM 折叠）共用同一折算。
- 新增律动风格 `pulse`（响度律动）：整阵随响度同步抬升，屏幕中央的档案位移略大（`loudness × (0.8 + 0.35·centre)`），与原版／连续频谱／层叠流波并列于设置 → 本地音乐 → MUSIC REACTION，并作为 1.2 新装默认值（已保存的选择不变）。风格切换沿用既有无门限交叉淡入。
- 壁纸宿主通路同步放行 `pulse` 并让 `musicGain` 同时缩放 `loudness`，行为与网页一致。

验证：`check-music.mjs` 新增响度一节（静音为零、响度随电平、等能量下低频权重更高、快攻慢放包络、静默位移为零、中央 > 边缘、强度缩放、旧三式不响应 loudness）——通过；`_verify-vlc-ui.mjs` **9/9**（新增「律动方式含响度律动并为新装默认」「律动方式可切换并持久化」）；`check-vlc-bridge.mjs` 7/7 回归通过；`tsc` 0 错误、`npm run build` 通过（PWA 离线包 818 文件 / 33.9 MiB）。

### 7. 主界面律动修复与波频律动（2026-09-28 追加，1.3）

用户反馈：**音乐面板里能看到律动，回到主界面就不动了**；并要求下一版让档案随音乐波频律动。

**Bug 根因（两处，同一条症状链）**：浏览器内核的频段与响度来自 `musicPlayer.tick()`。其一，`tick` 此前由 `MusicPanel.tick()` 转发，而面板 tick 第一行是 `if (!this.mounted) return`——面板一关，tick 停走，包络冻结在最后取值；响度／波频这类纯包络驱动的律动在三维场景里即表现为「静止不动」。其二（探针复跑时暴露）：`pause()` 会把 `this.active` 置 false，而 tick 的自守条件里含 `!this.active`——暂停瞬间 tick 同样停走，包络冻结于暂停值（此前能「降温」只因 Web Audio 内部 0.68 平滑常数在替包络衰减）。VLC 内核均不受影响（桥接包络由帧循环直接驱动）。修复：`player.tick` 改由 `main.ts` 帧循环直接调用，与面板挂载状态解耦；自守条件去掉 `!this.active`（包络自身负责衰减，`isPlaying()` 已作为 enabled 传入），`dispose()` 显式归零。面板 tick 只管自己的进度条渲染。

**验证环境说明**：无头 Edge（headless=new、无焦点）会在唯一音频暂停后节流页面（rAF/定时器停摆，已用「裸 3s setTimeout 超时」实测确认），会让包络看起来冻结。两个验证脚本已加 `--disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding` 以模拟真实可见页面；真实浏览器中页面可见，无此问题。另注意包络衰减按帧推进（`dt≤0.1s` 封顶），SwiftShader 软渲染下帧率极低时衰减相应变慢，属环境速率而非冻结——断言按趋势轮询而非定死时间窗。

**附带修复（播放行高亮）**：上一版起 `.result-row.playing` 只在面板自身操作（点行、桥接控制）后更新；浏览器内核的「下一首/上一首」与外部发起（MediaSession、调试面）的换曲不会刷新高亮。`syncPlayingRow` 改为幂等（`lastPlayingId` 去抖，仅在变化时滚动与刷新播放条），并由面板 tick 每帧跟随 `activeId()`——任何来源的换曲高亮都即时正确。

**波频律动**：新增第五种律动风格 `ripple`（并设为 1.3 新装默认）。振幅仍由整体响度驱动，频谱成分决定波纹形态：低频占比高 → 环形波稀而慢，高频占比高 → 密而快（`sin(radius·(7+8·treble) − t·(2.4+3.2·treble−1.1·bass))`）；波从屏幕中心向外扩散，`rhythmDisplacement` 因此增加屏幕 y 坐标（与 x 共用同一次投影，零额外开销）。其余四式保持原样，切换沿用无门限交叉淡入。

验证：`check-music.mjs` 新增 ripple 一节（静默为零、等响度不同频谱产生不同波纹、波纹随时间行进、振幅以响度为界）——通过；`_verify-music.mjs` 浏览器内核端到端通过，新增回归断言「**关闭面板后律动数据继续流动**」「**关面板暂停后律动包络归零**」（修复前：包络冻结不归零；修复后实测 0.46→0.001 指数衰减，释放率约 1.5/s 与设计一致），并顺修检查脚本本身的两处问题——重扫前先 `restore()`（否则测的是空 stored 的必然重解析，非持久化失效）、正弦 tone 强制单曲循环并放宽等待（消除 6 秒短音在列表循环下的轮换竞态）；独立探针 `_probe-pause.mjs`（一次性）复核：关面板播放包络有数据、暂停指数归零、重载后 restore + 固定 mtime 重扫 `parsed:0 reused:1`；`_verify-vlc-ui.mjs` **9/9**（按钮组更新为五式、默认 ripple）；`tsc` 0 错误、`npm run build` 通过。另修正 `_verify-music.mjs` 随环境漂移的断言（fixture 曲数 4→5 按实际断言、1.1 的键盘光标初值 "2"→"1"）。

## 2.2 音乐标题层级与平滑律动（2026-10-09）

- 音乐档案卡面与详情改为歌曲名主标题/大字号，歌手与专辑改为次信息/小字号；普通莱茵档案标签保持原有字段顺序。
- MUSIC REACTION 新增 `groove`（宽频律动）和 `shimmer`（高频微光），保留旧五种样式与 `ripple` 默认。新样式读取 RhythmMotion 的视觉平滑频谱和低频瞬态 accent，输出仍为有界的单标量卡片位移，不新增网格或渲染通道。
- VLC bridge 自动连接后，全局音乐帧每约 750ms 同步一次状态，因此关闭音乐面板后，桥接播放/暂停仍能正确驱动包络与阵列。
- 2.3 的音乐档案 `ACCESS FILE` 行为：点击当前音乐档案的入口会进入详情并按当前播放内核播放对应歌曲，使用真实曲目 id 而不是 `M-###` 显示编号。

验证：`check-music.mjs` 通过标题主次顺序、groove/shimmer 静音/范围/频谱响应、平滑攻放与交叉淡入测试；`check-playground.mjs` 通过既有 Wallpaper Engine 运动回归。

## 2.0 后续补丁（已整合至 2.1，2026-10-08）

- `eb8f631` 修复封面卡片遮挡、IndexedDB 封面 URL 解码、并发加载与失败退避。
- `a0d73f4` 增加音乐档案标题层级、ARCHIVE SPACING 滑条、固定保守可见性候选和拖动坐标互逆检查；2.2 将标题层级调整为歌曲名优先。
- 以上改动与原 2.0 音乐档案功能共同收纳至 `v2.1`；整合回归为 `_verify-music.mjs` **32/32**。

## 2.0 音乐档案库追加验证（2026-09-29）

- 音乐档案库与莱茵档案库双模式切换通过；音乐库支持按专辑、歌手、首字母动态分组，列数等于分组数，切换后保留选中曲目。
- 曲名、艺术家、专辑、年份、格式、时长、曲号/碟号、流派和文件信息映射到档案 HUD、详情页和动态 EXPORT；歌词功能按用户决定推迟到 2.1。
- 每首歌曲封面通过 2048×2048 atlas + `archiveCover` InstancedBufferAttribute 贴到阵列卡面；无封面使用品牌占位 tile。`_probe-cover.mjs` 使用两个不同封面确认双列封面与选中卡标签。
- VLC 桥新增令牌保护的 `/api/cover?id=`，并透传 `hasCover/year/genre/disc`；`check-vlc-bridge.mjs` **8/8**。

验证：`check-music.mjs` 通过（新增 album/artist/letter 分组、中文首字母与 ArchiveView 断言）；`_verify-music.mjs` **26/26**；`_verify-vlc-ui.mjs` **9/9**；`tsc` 0 错误；`npm run build` 通过。

## 8. 统一启动入口（2026-10-09）

- `node --check scripts/start-rhine.mjs` 与 `node --check scripts/vlc-bridge.mjs`：通过。
- `node_modules/.bin/tsc -p tsconfig.json --noEmit`：通过。
- `node --experimental-strip-types scripts/start-rhine.mjs --no-music --no-open --web-port 5199`：统一入口成功执行 `predev`、启动 Vite，并输出 `http://127.0.0.1:5199/`；结束探测进程后端口释放。
- `node --experimental-strip-types scripts/start-rhine.mjs --root --no-open`：缺少目录参数时明确失败，不复用旧目录。
- 真实 VLC 桥接：桥接等待 VLC HTTP 控制接口确认成功后才报告 `ready`；启动器获取 `/api/health` 中的 VLC PID 并在退出时纳入进程树清理。
- 浏览器交接：启动器通过 `rhine-bridge-port`、`rhine-bridge-token` 和 `rhine-music-engine` 一次性交接；页面用 `history.replaceState` 移除 URL 参数，当前标签页 `sessionStorage` 支持刷新后继续连接，临时令牌不写入长期偏好。
- 兼容入口：`启动终端.cmd` 仅网页，`启动音乐服务.cmd` 仅桥接；`启动莱茵科技.cmd` 为网页 + VLC 统一入口。

## 已知限制

- **无头软件渲染下 VLC 起播缓慢**：无头 Edge 以 SwiftShader 渲染三维场景时 CPU 饱和，VLC 的播放列表线程可能长时间停留在 `stopped`；同一桥接在无浏览器时立即 `playing`。桌面（GPU）会话不受影响，已验证。网页在等待期间显示「加载中」态。
- **VLC 安装路径必须为 ASCII**：含中文的安装目录会使 VLC 的 Lua 控制接口加载失败；`fetch-vlc.mjs` 会自动改装到 `%LOCALAPPDATA%\RhineLab\vlc`。媒体文件路径含中文不受影响（已实测）。
- **未验证项**：VLC 支持的非常见格式（ape/wma/dts 等）未逐个实测，其可行性来自 VLC 发行版自身的解码器列表；未在 Safari/Firefox 上验证浏览器内核降级路径（实现存在）。听感与音质由用户试听确认。

## 复现步骤

```powershell
cd RhineLabUI
npm ci
node scripts/fetch-vlc.mjs                     # 获取 VLC（首次）
node --experimental-strip-types scripts/check-music.mjs
node scripts/check-vlc-bridge.mjs              # 需要 VLC
npm run build
```

网页端：启动 `npm run dev`（或预览构建产物），设置 → 本地音乐 → 播放内核选 VLC 桥接 → 填写端口与令牌 → 连接。
