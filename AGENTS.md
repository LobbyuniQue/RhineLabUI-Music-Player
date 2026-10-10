# RhineLabUI 工程约定

## 项目范围

本工程以本地音乐、VLC 桥接和三维档案交互为主要开发方向，技术栈为 TypeScript、Three.js、Vite。当前功能和使用说明见 [README](README.md)，视觉与动效规范见 [DESIGN.md](DESIGN.md)。

发布、推送、部署与账号操作以当前用户的明确授权为准。源工程的历史讨论和账号操作记录保存在本机归档中。

## 目录与输出

- 应用代码位于 `src/`，内置档案位于 `content/`，运行资源位于 `public/`，Blender 源工程位于 `art/`。
- 启动、构建和基础检查位于 `scripts/`；端到端工具位于 `scripts/e2e/`，专项探针位于 `scripts/diagnostics/`，共享逻辑位于 `scripts/lib/`。
- 工具从 `scripts/lib/workspace-paths.mjs` 解析路径，避免依赖个人目录或终端的当前目录。
- 浏览器配置、缓存、测试曲库和即时截图写入被 Git 忽略的 `.local/`；长期验证证据归入 `verification/`。
- `.tools/` 保留 VLC 位置、获取记录和启动约定。依赖和构建输出 `node_modules/`、`dist/`、`release/` 不提交。
- 历史版本说明位于 `docs/releases/`，新增记录注明日期、环境、执行命令和未完成的验证范围。

详见 [目录说明](docs/PROJECT-STRUCTURE.md)。

## 三维场景与交互

- 沿用现有原生实现、模型、视觉规范和已确认的交互动效。修改相机、玻璃材质、灯光或运动规则时对照 `DESIGN.md` 和相关验证记录。
- 模型制作保留 Blender 源工程与可复现脚本；普通运行直接使用现有 GLB。
- 阵列与抽取卡片的材质及内部结构保持连续，快速反向或归位中的再次选档从当前显示状态接续。
- 鼠标和触摸输入保持既有自由平面拖动与惯性规则，正文滚动和三维手势隔离。
- 保留减少动态效果偏好、键盘操作和焦点恢复。画质调整通过现有用户设置处理。
- 参考视频只用于本机对照，不随仓库分发。

## 音乐模块

- 浏览器和 VLC 两条播放路径分别复用 `MusicPlayer`、`MusicBridge` 的既有接口，编解码交给所选内核。
- 音乐档案播放必须使用 `MusicArchiveView.musicTracks[selected]` 或 `activeView().backingId(selected)` 的真实曲目 ID；展示编号 `M-###` 只用于界面。
- 维持档案库与音乐库两种数据源，音乐分组支持专辑、歌手、首字母。
- 歌曲名为主标题，歌手与专辑为次信息；封面和异步回填与当前选曲对应。
- 七种律动保留，默认 `ripple`；主场景在音乐面板关闭时仍更新播放状态与律动。
- 音乐行距范围 `0.62–8`、默认 `4.05`；内置档案与开场固定 `0.62`。位置与轨道转换使用同一行距并保持互逆。
- 本地音乐播放时背景配乐让位，停止后按偏好恢复。
- VLC 桥接只监听回环，使用本次启动令牌，只允许扫描曲目 ID。临时交接凭据使用当前标签页的会话存储。
- 统一启动入口为 `启动莱茵科技.cmd` / `npm run start:all`；保留仅网页和仅桥接的兼容入口。

使用与开发范围见 [本地音乐说明](docs/LOCAL-MUSIC.md)。当前待完善项以 README 和实际验证为准。

## 内容与许可

- 内置档案统一维护 `content/archives.json`，保留五列、每列八份及稳定编号，页面和文本导出共用数据。修改步骤见 [内容说明](content/README.md)。
- 保留原作者 MIT 许可证、署名和来源链接；第三方字体、依赖、原作素材与短音采样按各自许可处理。
- 独立授权的 `public/fonts/novecento/` 排除 Git。缺少该字体时保留既有固定字形回退，不从原作者站点自动获取授权资源。
- 禁止把凭据、个人文件、私人录音及带姓名或学号的样本路径写入源码。真实音乐样本仅通过显式 `RHINE_MUSIC_SAMPLE` 输入。
- 测试样本使用项目原创配乐和生成音频，验证只清理自己创建的本机目录，只结束自己启动的进程树。

## 验证

通常按改动范围执行：

```powershell
npm run check
npm run build
```

修改浏览器或 VLC 音乐交互时，先构建，再按顺序执行：

```powershell
npm run test:e2e:music
npm run test:e2e:vlc
```

端到端验证需要可用的 Edge/Chrome；可用 `RHINE_BROWSER` 指定路径。VLC 通路另需本机 VLC。无头软件渲染下的播放延迟与真实设备听感分开记录，历史通过数量不视为本轮验证结果。

辅助工具说明见 [scripts/README.md](scripts/README.md)，历史证据见 `verification/`。
