# 0.1.5 歌单验证

日期：2026-10-14（Asia/Shanghai）。环境：Windows、Node.js 24.18.0，本机 Edge 与 VLC；GitHub runner 另行记录。

## 验收范围

- 每歌单最多 1000 首；1001 首先询问自动拆分或自行整理。
- 自动拆分按路径保留首卷 1000 首和末卷 1 首；选择自行整理保留原曲库。
- 切换与重扫不混用文件来源、索引、封面或旧播放票据。
- 目录预设与分卷恢复；删除预设不删除歌曲文件。
- 档案选择/按钮/检索分页、ID3 扩展头、查看器时间与静止复用。

## 执行结果

本轮按顺序执行，全部退出码为 0：

| 阶段 | 本机结果 |
| --- | --- |
| `npm run check` | 通过；播放器/面板 42、桥接 51、曲库 24、歌单面板 6、原生歌单 9、VLC 获取模拟 5、档案 UI 6、查看器 7、CDP 8 项，另含既有专项检查 |
| `npm run build` | 通过；离线构建指纹 `0b6a192bc2bea4ea` |
| `node --experimental-strip-types scripts/check-vlc-bridge.mjs` | 真实 VLC 12 项通过；两条物理音量断言因 dummy 输出明确跳过 |
| `npm run test:e2e:music` | 46/46 通过，包含 1001 首超限两分支、首卷 1000 首与第二卷 1 首的真实按钮/下拉操作 |
| `npm run test:e2e:vlc` | 26/26 通过，包含真实桥接的文件夹预设、停止旧输出及删除预设保留曲库 |

生成日志位于被忽略的 `.local/release-0.1.5/`，截图位于 `.local/screenshots/music/`，其中 `music-playlists.png` 为第二卷界面。使用生成样本，没有读取个人曲库。

本机复用已有 VLC，没有把获取脚本的模拟检查当成重新下载成功。提交本记录时尚未运行本轮远端 CI；官方 VLC 获取校验、协议、浏览器及 VLC UI 的最终运行链接和结果公布在 [v0.1.5 发行页](https://github.com/LobbyuniQue/RhineLabUI-Music-Player/releases/tag/v0.1.5)。CI 工件上传成功不能代替测试通过。

## 验证边界

核心检查使用生成夹具和可控制的事务/异步端口；IndexedDB 事务检查中的 adapter 不能代替实机持久化验收。无头 VLC 测试使用 dummy 音频输出，验证协议和真实 VLC 状态；不代表声卡听感。查看器模拟证明计时和绘制调用，不是 GPU 性能测量。
