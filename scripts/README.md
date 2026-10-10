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

[e2e/](e2e/README.md) 存放持续使用的端到端验证；[diagnostics/](diagnostics/README.md) 存放针对问题的探针；`lib/` 存放共用的路径、音频样本生成和进程清理。

新验证工具从 `lib/workspace-paths.mjs` 取得项目路径；缓存和生成文件写入 `.local/`，需要长期保存的证据整理至 `verification/`。详见 [目录约定](../docs/PROJECT-STRUCTURE.md)。

基础音乐检查默认只使用合成样本，不读取任何个人文件。如需自行复核真实音频，可显式设置 `RHINE_MUSIC_SAMPLE`，再运行音乐检查：

```powershell
$env:RHINE_MUSIC_SAMPLE = 'D:\Music\sample.mp3'
node --experimental-strip-types scripts/check-music.mjs
```
