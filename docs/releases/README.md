# 历史版本说明

这些文件于 2026-10-10 从工作区根目录迁入，保留当时的版本内容与验证记录。开源准备时已将个人绝对路径替换为相对路径或通用示例；原始文件保存在本机被 Git 忽略的 `.local/maintenance/20261010/open-source-originals/`。

| 版本 | 说明 |
| --- | --- |
| 1.2 | [版本说明-1.2.md](版本说明-1.2.md) |
| 1.3 | [版本说明-1.3.md](版本说明-1.3.md) |
| 2.0 | [版本说明-2.0.md](版本说明-2.0.md) |
| 2.1 | [版本说明-2.1.md](版本说明-2.1.md) |
| 2.2 | [版本说明-2.2.md](版本说明-2.2.md) |
| 2.3 | [版本说明-2.3.md](版本说明-2.3.md) |

## 历史路径对照

| 原工作区名称 | 当前项目位置 |
| --- | --- |
| `_verify-music.mjs` | `scripts/e2e/verify-music.mjs`（`npm run test:e2e:music`） |
| `_verify-vlc-ui.mjs` | `scripts/e2e/verify-vlc-ui.mjs`（`npm run test:e2e:vlc`） |
| `_serve-dist.mjs` | `scripts/e2e/serve-dist.mjs`（`npm run preview:dist`） |
| `_probe-*.mjs` | `scripts/diagnostics/probe-*.mjs` |
| `_bridge-test.mjs`、`_bridge-isolate.mjs`、`_vlc-tap.mjs` | `scripts/diagnostics/` 中相应的无下划线文件 |
| `_install-rhine.mjs` | `.local/archive/install-rhine.mjs`，本机历史归档 |
| `_shots/` | `.local/screenshots/music/` |
| `_music-root/` | `.local/fixtures/music-legacy/` |
| `.edge-*` | `.local/browser-profiles/` |
| `.npm-cache/`、`.git-home/` | `.local/cache/npm/`、`.local/cache/git-home/` |

版本号和当时的验收数量均为历史记录；当前命令与目录约定见 [项目目录说明](../PROJECT-STRUCTURE.md)。
