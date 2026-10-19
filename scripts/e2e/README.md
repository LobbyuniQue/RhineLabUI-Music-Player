# 端到端验证

这些脚本验证构建后的应用，运行前先执行：

```powershell
npm run build
```

脚本自动查找 Windows 上的 Edge 或 Chrome。其他安装位置可以显式指定：

```powershell
$env:RHINE_BROWSER = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm run test:e2e:music
```

| 命令 | 检查范围 | 默认端口 |
| --- | --- | --- |
| `npm run test:e2e:music` | 曲库扫描、检索、播放、频谱、档案模式和持久化 | 网页 4188 / 调试 9333 |
| `npm run test:e2e:vlc` | 桥接连接、VLC 曲库、播放入口及音乐设置 | 网页 4190 / 调试 9336 / 桥接 8801 |
| `npm run preview:dist` | 静态预览现有构建产物 | 网页 4173 |

VLC 通路还需已有的 VLC 安装；需要获取时使用项目既有 `node scripts/fetch-vlc.mjs`。两套浏览器检查按顺序运行，截图保存在 `.local/screenshots/music/`。

音乐面板布局检查保留 1920×1080、960×600、390×844 三种真实 CSS 视口，分别验证搜索栏、表头、曲目滚动、播放器与页脚边界。此段单独使用 DPR 0.25，降低无头软件渲染的像素开销；布局截图为低像素密度证据，不用于评判三维画质。退出此段即清除覆盖，后续播放与动画检查恢复原来的设备配置。

VLC 面板的 1600×1000 布局截图采用相同的 DPR 0.25 策略，保留实际尺寸断言，截图后清除覆盖再执行播放、动画、断线重连与内核交接。

统一检索面板的关闭检查观察真实对话框移除和导航解锁，页面内等待最多 60 秒，CDP 调用最多 90 秒。CI 浏览器步骤总时限为 20 分钟，Windows 作业为 45 分钟，以容纳软件渲染下的完整回归；到期仍未满足条件会失败。

VLC UI 流程最后的浏览器音频交接夹具使用 90 秒预加载期限、120 秒总观察期限和 30 秒单次状态读取预算，以容忍 CI 软件渲染下的媒体事件延迟。该夹具结束后恢复原设置，播放器正常运行仍默认 15 秒。完整归位、正文揭示结束帧、真实起播、旧输出停止和桥接曲库恢复均保留实际状态断言；延长等待不算通过。

真实归位检查完成后，音频交接阶段为测试绘制回调留出 750 ms 空闲时间，保留原生帧时间戳；结束及异常清理时恢复原调度。切回 VLC 的“旧音频停止”与“连接及曲库就绪”分别断言，后者在 180 秒内只读观察自动重连，并比对服务端与页面的真实曲目 ID。普通网页不使用这项测试调度。

所有测试音频由 `lib/music-fixtures.mjs` 生成：一份项目原创 MP3 配乐加可解析的标签，四份正弦波 WAV。旧测试曲库保存在 `.local/fixtures/music-legacy/`；新验证使用 `.local/fixtures/browser/` 和 `.local/fixtures/vlc/`。

浏览器使用独立的运行配置，结束后只清理该次配置和所属进程树。运行限制与历史验收见 [音乐验证记录](../../verification/LOCAL-MUSIC.md)。

命令帮助可以直接查看：

```powershell
npm run test:e2e:music -- --help
npm run test:e2e:vlc -- --help
```

在项目目录预览指定构建，也可以执行：

```powershell
node scripts/e2e/serve-dist.mjs dist 4173
```

`serve-dist.mjs` 的默认构建目录按脚本位置解析；显式传入的目录按当前终端目录解析。`--fixtures` 仅用于验证时把一个样本目录挂载到 `/__fixtures/`。
