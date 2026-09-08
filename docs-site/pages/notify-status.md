# 通知与状态栏
> Web Push / ntfy、statusline 与 CLI bridge。

- **Part**: 第四部分 · 核心实现
- **Reading Time**: ~10 min
- **Estimated Tokens**: ~1115

---

离线通知与运行态展示属于「尽力而为的体验增强」：通知通道的偶然失败绝不阻塞核心交互；状态栏根据当前的驾驶员主体动态选择权威数据源。

## 离线通知体系：双通道机制

系统内置两种独立的异步离线消息通道，完全由 `app/src/ops/notify-channels.js` 统一调度：

| 通道类型 | 底层协议与配置要求 | 优势与典型场景 |
| --- | --- | --- |
| Web Push (首选) | 标准 W3C Push 规范，需配置 VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT | 体验最佳 ：配合 PWA 实现系统级原生通知，点击直接调起应用直达该会话 |
| ntfy (高可用后备) | 基于 HTTP 的 ntfy 协议，配置 NTFY_URL 与 NTFY_TOPIC （支持自建与私有 Token） | 无 HTTPS/内网场景首选 ：局域网纯 HTTP 下仍可稳定推送，适合 iOS 免证书直达 |

## 推送抑制策略：严禁假静音与噪音打扰

> **TIP:** 推送判定铁律 — 审批（permission_request）、提问（question）与后台长任务完成属于紧急人机待办，无条件推送（用户可能正在锁屏或使用其他应用）；仅常规对话的 result 结果，在「approved 房间检测到前台可见连接」时才会被智能抑制。

- 前台可见性依据： 以客户端上报的 client:presence （基于 Page Visibility API）为准， 而不是单纯根据 Socket 是否保持连通 。
- 通知节流窗： 同一会话内的同类通知遵循 NOTIFY_THROTTLE_MS （默认 60 秒）节流防轰炸。

## Statusline 状态栏双源选择

| 当前运行场景 | 数据真相源 | 展示内容 |
| --- | --- | --- |
| Web 端驾驶中 | SDK 内部运行态 | 当前模型别名、上下文窗口占用比例（ctx%）、累计 Token 消耗 |
| CLI 终端驾驶中（只读镜像） | CLI Statusline 快照 | 通过 npm run statusline:install 安装的快照桥接器，精准镜像终端原生状态行 |

## 状态可见性：告警轴与待办轴绝不混淆

- 待办轴（「需要你」）： 顶栏角标与数字 Chip 只用于展示「用户点击即可立刻处理」的人机交互项（如待审批的命令、待回答的问题、后台跑完的任务）。
- 运维告警轴： 系统级运行故障（如通知通道失联、鉴权限速封禁、客户端网络异常）只沉淀在侧边抽屉的「服务状态面板」中，两轴严格分离，绝不混判。
- 动态动词与收尾行： 运行时支持实时展示过去式动词、秒表与输出速率，对齐终端 CLI 的动态状态展示。
