# 项目目录说明

## 目录用途

| 目录 | 内容 | 维护方式 |
| --- | --- | --- |
| `src/` | 网页、三维场景、音乐和宿主适配源码 | 跟随 Git 维护；本次目录整理未移动应用模块 |
| `public/` | 模型、字体、音频和 TXT 档案 | 保留现有资源路径；独立授权字体继续按原规则排除 Git |
| `art/` | Blender 源工程及可复现脚本 | 和运行模型一起保留 |
| `content/` | 共用档案数据与维护说明 | 修改后执行内容检查和导出 |
| `docs/` | 使用、部署和开发文档 | 版本说明放入 `docs/releases/` |
| `scripts/` | 构建、启动和基础检查入口 | 现有构建脚本保留原位置，避免破坏发布命令 |
| `scripts/e2e/` | 浏览器音乐验证、VLC 页面验证、静态预览 | 使用共享路径和本机 `.local/` 输出 |
| `scripts/diagnostics/` | 封面、导航、暂停、面板和桥接诊断 | 有针对性地运行，和常规检查分开 |
| `scripts/lib/` | 工具路径、测试音生成、进程清理 | 不依赖当前终端目录 |
| `verification/` | 验证记录与需要长期保留的证据 | 历史结果保留；新结果注明日期与环境 |
| `reference/`、`wallpaper/` | 对照工具及壁纸相关资源 | 保留原路径和既有构建关系 |
| `.local/` | 浏览器配置、截图、临时曲库和本机归档 | 排除 Git，由使用它的工具维护 |
| `.tools/` | VLC 指针、下载缓存及原有工具资源 | 保留启动脚本约定，排除 Git |
| `node_modules/`、`dist/`、`release/` | 依赖与构建输出 | 可通过安装和构建重新生成，排除 Git |

## 检查和运行入口

```powershell
npm run start:all           # 启动网页和可选音乐桥接
npm run check               # 类型、内容、视口、音乐、小游戏、可见性及工具语法
npm run check:tools         # 只检查辅助工具语法
npm run build              # 生成网页和 PWA
npm run preview:dist       # 静态预览现有 dist
npm run test:e2e:music      # 浏览器音乐通路验证
npm run test:e2e:vlc        # VLC + 网页通路验证
```

端到端验证需要先构建，并准备 Chromium 浏览器；VLC 验证另需现有 VLC 安装。`RHINE_BROWSER` 可以指定浏览器可执行文件。基础检查不会启动浏览器或 VLC。

## 本机输出

```text
.local/
├── browser-profiles/           迁移的浏览器数据及隔离的运行配置
├── cache/
│   ├── npm/                    原 .npm-cache
│   └── git-home/               原 .git-home
├── fixtures/
│   ├── music-legacy/            原 _music-root，保留旧样本
│   ├── browser/                 浏览器验证生成的五个测试音频
│   └── vlc/                     VLC 验证生成的五个测试音频
├── screenshots/music/           原 _shots 和新的音乐验证截图
├── archive/install-rhine.mjs     历史 CDN 安装脚本
└── maintenance/20261010/         迁移清单和原始辅助脚本
```

验证脚本只清理自己在 `.local/` 下创建的临时目录，并只结束自己启动的进程树。浏览器配置按运行进程分开，迁移的旧配置保留。测试音频使用项目原创配乐和生成的正弦波，不依赖个人文件路径。

如需复用旧 npm 缓存，可在项目目录执行 `npm ci --cache .local/cache/npm`。历史安装脚本保留作归档；日常启动使用项目入口，源码同步按 Git 工作流进行。

## 备份和归档

可在备份时排除 `.local/`、`node_modules/`、`dist/`、`release/` 和可重新取得的 `.tools/` 缓存。保留应用源码、Git 历史、`art/`、`public/`、档案内容、文档与长期验证证据。本机授权字体也应保留在本机备份中，并继续遵守已有 Git 排除规则。

需要长期保留的新截图，应从 `.local/screenshots/` 选取后放入相应 `verification/` 目录并记录来源。2026-10-10 之前版本说明中的路径是当时的布局；[版本索引](releases/README.md) 提供旧名称与新位置的对照。
