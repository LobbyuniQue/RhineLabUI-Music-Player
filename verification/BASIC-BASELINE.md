# basic 基线验证

基线日期：2026-10-20（Asia/Shanghai）。源码版本：0.1.5。

## 历史依据

2026-10-14 的本机音乐面板布局修正记录显示，基础检查与构建通过，浏览器音乐集成 68/68、VLC UI 31/31 通过；构建指纹为 `237403042a5ae293`。这是此前本机验证记录，VLC 使用 dummy 输出。

这些记录说明本次收录改动的验证来源，不替代本次提交的检查，也不代表远端 CI 或真实声卡听感通过。

## 本次验证

| 阶段 | 状态 |
| --- | --- |
| 本机 `npm run check` | 2026-10-20 通过，退出码 0 |
| 本机 `npm run build` | 2026-10-20 通过，退出码 0；构建指纹 `237403042a5ae293` |
| 本机浏览器集成 | 2026-10-20 通过，68/68；包含三种尺寸的真实布局、滚动与播放检查 |
| 本机 VLC UI 集成 | 本次未重跑，历史结果见上文；本次远端另行验证 |
| GitHub Actions | 此记录随基线首次提交；远端验收以该提交发布后的实际运行结果为准 |

本次重新构建的 `dist/pwa-build.json` 与此前已验证构建的清单逐字相同（818 个文件），为当前源码与既有界面产物提供对应依据；它不替代本次远端集成测试。

首次两轮远端运行（[39298128315](https://github.com/LobbyuniQue/RhineLabUI-Music-Player/actions/runs/39298128315)、[39298523673](https://github.com/LobbyuniQue/RhineLabUI-Music-Player/actions/runs/39298523673)）均通过基础检查、构建、VLC 获取校验与协议检查；浏览器在 1920×1080 布局断言通过后，滚动指令的 `Runtime.evaluate` 超时，VLC UI 随后跳过。为避免大尺寸软件渲染挤占布局检查，仅该测试段改用 DPR 0.25，CSS 视口和全部布局断言保留，产品源码与默认画质不变。修正效果以随后实际运行确认。

[第三轮 39300452961](https://github.com/LobbyuniQue/RhineLabUI-Music-Player/actions/runs/39300452961) 已通过三种布局、完整与简化动画播放检查，随后在关闭档案检索面板时再次命中 20 秒 CDP 期限。按已确认的慢渲染验证策略，将该关闭观察改为页面内 60 秒、CDP 90 秒，浏览器步骤总时限增至 20 分钟；仍检查对话框真实移除、导航解除锁定和焦点恢复。该轮未全部通过，不以局部通过替代最终提交验收。

本机日志保存在被忽略的 `.local/basic-baseline-20261020/`。可在 [basic 分支的 Actions 记录](https://github.com/LobbyuniQue/RhineLabUI-Music-Player/actions/workflows/ci.yml?query=branch%3Abasic)中按本标签指向的提交核对本次运行。下载成功、上传工件成功以及测试实际执行通过分别确认；完整运行结论另记于基线发布说明。
