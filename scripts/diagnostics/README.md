# 诊断工具

这些工具从原工作区迁入，用于复核某一个问题。浏览器探针读取已构建的 `dist/`，运行前执行 `npm run build`。

| 脚本 | 用途 |
| --- | --- |
| `probe-cover.mjs` | 两组不同封面的阵列及详情对照 |
| `probe-nav.mjs` | 音乐库模式按钮和导航同步 |
| `probe-panel.mjs` | 音乐面板、播放高亮与状态探查 |
| `probe-pause.mjs` | 关面板后暂停衰减和索引持久化 |
| `bridge-test.mjs` | 已运行桥接服务的协议、播放与频谱检查 |
| `bridge-isolate.mjs` | 对比安静环境与网页轮询负载下的 VLC 起播 |
| `vlc-tap.mjs` | PCM 旁路的能量和主频检查 |

浏览器工具使用和端到端验证相同的 `RHINE_BROWSER` 配置，运行数据放入 `.local/`。例如：

```powershell
node scripts/diagnostics/probe-cover.mjs
node scripts/diagnostics/probe-pause.mjs
```

桥接探针需先启动本地桥接，然后传入本次端口与令牌；例如 `node scripts/diagnostics/bridge-test.mjs 8788 <本次令牌>`。`bridge-isolate.mjs` 还接受 `quiet` 或 `page` 模式，`vlc-tap.mjs` 接受 PCM 端口。

常规基础回归使用 `npm run check`，完整音乐通路使用 `npm run test:e2e:music` 或 `npm run test:e2e:vlc`。
