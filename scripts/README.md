# 项目工具

构建、启动和既有 `check-*.mjs` 保留在本目录，常用命令由 `package.json` 提供。

| 入口 | 用途 |
| --- | --- |
| `npm run start:all` | 启动网页和可选 VLC 桥接 |
| `npm run check` | 基础逻辑、类型与新工具语法检查 |
| `npm run check:tools` | 只检查 `lib/`、`e2e/`、`diagnostics/` 下的脚本语法 |
| `npm run build` | 生成网页和 PWA |
| `npm run preview:dist` | 直接预览 `dist/`，默认端口 4173 |
| `npm run test:e2e:music` | 浏览器音乐通路验证 |
| `npm run test:e2e:vlc` | VLC 与网页集成验证 |

`npm run check` 同时执行播放请求竞态与方向映射、桥接断线/重连、可见封面复用、大分组反查及自有进程清理回归。专项脚本分别为 `check-music-player.mjs`、`check-music-bridge.mjs`、`check-archive-covers.mjs`、`check-owned-process.mjs`。

2.5 增加 `check-music-library.mjs`（扫描事务、来源失效和封面租约）、`check-music-reveal.mjs`（加载黑条、结束帧起播和内核交接）、`check-pwa-cache.mjs` / `check-pwa-redirect.mjs`（核心与可选缓存、失败重试、版本隔离），均纳入 `npm run check`。`node --experimental-strip-types scripts/check-vlc-bridge.mjs` 单独验证真实 VLC 的静默准备、开始票据、停止、音量和频谱。

[e2e/](e2e/README.md) 存放持续使用的端到端验证；[diagnostics/](diagnostics/README.md) 存放针对问题的探针；`lib/` 存放共用的路径、音频样本生成和进程清理。

新验证工具从 `lib/workspace-paths.mjs` 取得项目路径；缓存和生成文件写入 `.local/`，需要长期保存的证据整理至 `verification/`。详见 [目录约定](../docs/PROJECT-STRUCTURE.md)。

基础音乐检查默认只使用合成样本，不读取任何个人文件。如需自行复核真实音频，可显式设置 `RHINE_MUSIC_SAMPLE`，再运行音乐检查：

```powershell
$env:RHINE_MUSIC_SAMPLE = 'D:\Music\sample.mp3'
node --experimental-strip-types scripts/check-music.mjs
```
