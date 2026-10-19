# Rhine Music Demo 学习记录

日期：2026-10-14。参考 [Rhine Music Demo V0.5.0 · a889801](https://github.com/RonaldDeng/Rhine-Music-Demo/tree/a889801f7f99993ee23b40e97efdeac6ad04a9be)，对照 [RhineLabUI 0.1.5 · 4a84804](https://github.com/LobbyuniQue/RhineLabUI-Music-Player/tree/4a848049300ed3a4c045f71a403c354073b102c5)。本轮仅学习关键源码和第一方文档，未修改应用、复制素材、运行上游或发布。

## 适用边界

它按含音频的文件夹归并专辑，专辑盒详情内再列歌曲；我们是一首歌一张档案卡，故真实专辑列不能直接替换歌曲视图。[参考曲库](https://github.com/RonaldDeng/Rhine-Music-Demo/blob/a889801f7f99993ee23b40e97efdeac6ad04a9be/docs/MUSIC-SERVICE.md#L23)、[我们的映射](https://github.com/LobbyuniQue/RhineLabUI-Music-Player/blob/4a848049300ed3a4c045f71a403c354073b102c5/src/music-grouping.ts#L78-L135)

它面向 macOS，采用浏览器或 CoreAudio，本机完整解码依赖 FFmpeg/ffprobe；我们保留 Windows/VLC，不直接移植其原生音频和无缝排程。[参考环境](https://github.com/RonaldDeng/Rhine-Music-Demo/blob/a889801f7f99993ee23b40e97efdeac6ad04a9be/README.md#L32-L41)、[音频边界](https://github.com/RonaldDeng/Rhine-Music-Demo/blob/a889801f7f99993ee23b40e97efdeac6ad04a9be/README.md#L155-L164)

保留已确认规则：每歌单最多 1000 首，预设对应文件夹，超限先询问自动分卷或自行整理；完整动画等待所选音频就绪后揭示、结束帧起播，简化动画显示文字并就绪即播。[本工程 0.1.5](https://github.com/LobbyuniQue/RhineLabUI-Music-Player/blob/4a848049300ed3a4c045f71a403c354073b102c5/README.md#L9)

## 五个优先借鉴方向

### 1. 主屏定位当前播放歌曲

参考的播放曲名可以点击，用真实歌曲 ID 定位专辑，详情打开后滚动并高亮；用户滚轮、点击或键盘输入会取消定位动画，定位本身不调用播放。[入口与定位](https://github.com/RonaldDeng/Rhine-Music-Demo/blob/a889801f7f99993ee23b40e97efdeac6ad04a9be/src/music-app.ts#L1041-L1065)、[点击入口](https://github.com/RonaldDeng/Rhine-Music-Demo/blob/a889801f7f99993ee23b40e97efdeac6ad04a9be/src/music-app.ts#L2107-L2110)、[用户打断](https://github.com/RonaldDeng/Rhine-Music-Demo/blob/a889801f7f99993ee23b40e97efdeac6ad04a9be/src/music-track-focus.ts#L21-L46)

我们已有面板播放行跟随，适合补一个主屏“定位正在播放”入口，只选择档案，不重新加载或起播；若歌曲不在当前歌单，应提示而不自行换库。验证两内核、暂停、另一首正在浏览和中途打断。[已有跟随](https://github.com/LobbyuniQue/RhineLabUI-Music-Player/blob/4a848049300ed3a4c045f71a403c354073b102c5/src/music-panel.ts#L1205-L1226)

### 2. 缺封面的文字排版

参考按 ID、专辑名和歌手生成本地 canvas 封面，缓存最多 24 条，字体等待有期限，稍后加载成功会清除旧缓存；无需联网生成图片。[封面生成](https://github.com/RonaldDeng/Rhine-Music-Demo/blob/a889801f7f99993ee23b40e97efdeac6ad04a9be/src/generated-album-cover.ts#L3-L50)

我们已有可见槽位回收和迟到图片票据，当前占位图只有通用音乐符号；建议直接在现有可见槽位绘制曲名、歌手及稳定配色，不另建千首永久图片缓存。验证长名称、字体迟到、换歌单和真实封面回填，真实图片优先。[现有图集](https://github.com/LobbyuniQue/RhineLabUI-Music-Player/blob/4a848049300ed3a4c045f71a403c354073b102c5/src/cover-atlas.ts#L43-L106)

### 3. 按距离适配程序化导航

参考的搜索与远距离回位共用运动时钟，时长为 1.4–2.4 秒，重新定位保留当前位置、速度和加速度；真实列另有独立深度、居中和首尾停止。[导航轨迹](https://github.com/RonaldDeng/Rhine-Music-Demo/blob/a889801f7f99993ee23b40e97efdeac6ad04a9be/src/music-archive-motion.ts#L12-L94)、[实际调用](https://github.com/RonaldDeng/Rhine-Music-Demo/blob/a889801f7f99993ee23b40e97efdeac6ad04a9be/src/scene.ts#L1087)、[独立列](https://github.com/RonaldDeng/Rhine-Music-Demo/blob/a889801f7f99993ee23b40e97efdeac6ad04a9be/src/music-real-columns.ts#L79-L134)

我们已有稳定歌曲 ID 列记忆，归位的转正后下降、实际活动时间和快速反向也已修；建议仅先试搜索和远距离列恢复，保留相邻浏览与自由拖动，参数按歌曲卡和可调行距调试。参考场景仍夹每帧 0.05 秒，不能照搬，更不能据此声称性能更好。[已有记忆](https://github.com/LobbyuniQue/RhineLabUI-Music-Player/blob/4a848049300ed3a4c045f71a403c354073b102c5/src/main.ts#L520-L535)、[归位记录](https://github.com/LobbyuniQue/RhineLabUI-Music-Player/blob/4a848049300ed3a4c045f71a403c354073b102c5/verification/ARCHIVE-RETURN-TIMING.md#L5-L16)、[参考时间步](https://github.com/RonaldDeng/Rhine-Music-Demo/blob/a889801f7f99993ee23b40e97efdeac6ad04a9be/src/scene.ts#L1311-L1315)

### 4. 完整二维分组入口

参考歌手网格成员来自完整目录，不随摄像机可见范围删减；只在目录变化时更新节点，保留滚动与焦点，入场只编排可见磁贴。[目录与更新](https://github.com/RonaldDeng/Rhine-Music-Demo/blob/a889801f7f99993ee23b40e97efdeac6ad04a9be/src/music-overview-artist-grid.ts#L9-L98)、[可见入场](https://github.com/RonaldDeng/Rhine-Music-Demo/blob/a889801f7f99993ee23b40e97efdeac6ad04a9be/src/music-overview-artist-grid.ts#L154-L188)

我们已有完整检索和分批结果，但列多时隐藏分类按钮；可补当前歌单的歌手/专辑网格和数量，只定位不播放。它首先改善找歌；若要作为低配模式，需另行暂停三维绘制并实测，不能把二维面板当成已降低 GPU 占用。[当前检索](https://github.com/LobbyuniQue/RhineLabUI-Music-Player/blob/4a848049300ed3a4c045f71a403c354073b102c5/src/main.ts#L1489-L1555)

### 5. 设置按音乐管理与画面声音分区

参考双页签保留内容挂载、输入和各页滚动，高级选项默认收起。[设置结构](https://github.com/RonaldDeng/Rhine-Music-Demo/blob/a889801f7f99993ee23b40e97efdeac6ad04a9be/src/music-app.ts#L1808-L1850)

我们已有统一设置和独立歌单管理；选项继续增多时可分为“音乐与歌单”“画面与动画”，沿用现有模块，把端口/令牌置于高级连接区。验证切页签不丢路径输入、键盘可达和短窗口滚动，保持已有打开设置取消待完成档案请求的行为。[当前设置](https://github.com/LobbyuniQue/RhineLabUI-Music-Player/blob/4a848049300ed3a4c045f71a403c354073b102c5/src/main.ts#L1577)

## 采用顺序和验证限制

先考虑 1、2、3，均是日常可见的小改善；4、5 随界面增长再安排。本轮没有实施建议，不触发版本更新，没有上游测试、真实音乐听感或 GPU/内存/低配跑分，来源中的既有验证也不计作本轮结果。

参考代码的 MIT 署名包括 LBEILC 与 RonaldDeng；日后复用代码需保留版权声明，模型、字体等素材另核许可。本轮只记录学习结论。[许可证](https://github.com/RonaldDeng/Rhine-Music-Demo/blob/a889801f7f99993ee23b40e97efdeac6ad04a9be/LICENSE#L1-L14)
