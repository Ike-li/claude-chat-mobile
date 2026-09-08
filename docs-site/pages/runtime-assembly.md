# 启动与组装根
> server.js 薄入口与 app.js 组装根的启动时序。

- **Part**: 第四部分 · 核心实现
- **Reading Time**: ~12 min
- **Estimated Tokens**: ~1482

---

启动路径刻意设计为薄入口（`app/server.js`）与组装根（`app/src/server/app.js`）两段式：环境变量与安全时戳必须在任何状态模块求值前就绪，服务监听前必须清理孤儿挂起状态。

## server.js（薄入口）

```
// 运行时入口：app/server.js
import { loadRuntimeEnvironment } from './src/ops/config-file.js';
import { installLogTimestamps } from './src/shared/log-timestamps.js';

loadRuntimeEnvironment();   // 加载 ccm.config.json / .env
installLogTimestamps();     // 劫持 console 注入安全 ISO 时戳

const { httpServer, io, port } = await import('./src/server/app.js');
export { httpServer, io, port };
```

薄入口仅数行。不管是命令行 `npm start`、macOS LaunchAgent 常驻、Linux systemd 还是端到端集成测试，一律通过此入口拉起。

## 配置求值与优先级

- 配置同源加载。 启动时由 app/src/ops/config-file.js 统一加载根目录下的 ccm.config.json （结构化配置，优先）并回落 .env 。
- 环境变量最高优先。 终端 Shell 中直接 export 的环境变量始终压过配置文件。
- 两处目录解析陷阱。 app/src/** 模块计算仓库根目录必须上溯 三层 。另外，LaunchAgent 启动命令 exec <node> app/server.js 必须与 service-units.js 解析常驻进程后缀的代码逐字严格一致。

## app.js 组装时序（12 步）

1. 依赖导入。 完成后端各领域核心模块（agent, sessions, files, auth, ops, shared）的静态与动态装配。
2. 解析配置。 执行 parseServerConfig() ，提取端口、Token、超时阈值、 ACCESS_PROFILE 及工作区配置。
3. 初始化通知通道。 装配 Web Push（VAPID）与可选 ntfy 实例（尽力而为，通道故障不阻塞主业务）。
4. Preflight 前置自检。 检查默认工作区（ WORK_DIR ）目录真实存在、校验 claude 二进制路径可执行（ CLAUDE_BIN ）。
5. 构建工作区白名单。 加载 WORKDIRS 白名单列表并建立文件监听，支持运行期免重启热加载。
6. 配置 Express HTTP 壳。 挂载 gzip 压缩、静态资源 CSP 策略、带 ?v= 指纹的防缓存头。
7. HTTP 鉴权与运维路由。 挂载统一鉴权中间件，并提供 /health 、 /metrics 、 /push/* 受控路由（杜绝免密端点）。
8. 挂载 Socket.IO 与设备门禁。 装配握手鉴权中间件与设备指纹 TOFU 判定器（ createDeviceGate ）。
9. 实例化 InstanceManager 与通信管道。 建立会话实例池与 Socket 进出向事件信封转发总线。
10. 进程级未捕获异常兜底。 注册 uncaughtException 与 unhandledRejection ，只记日志不退进程。
11. 孤儿审批清理（Fail-closed）。 在服务监听前执行 expireOrphanedPending() ，将因进程重启而失效的挂起审批彻底归档。
12. 绑定端口监听。 依据 AUTH_TOKEN 与网络模式选择绑定地址（无 Token 强制绑 127.0.0.1 ，有 Token 绑 0.0.0.0 ）。

## 默认运行超时参数

| 配置项名 | 默认值 | 语义与作用 |
| --- | --- | --- |
| PORT | 3000 | HTTP / WebSocket 服务监听端口 |
| IDLE_TIMEOUT_MS | 600000（10 分钟） | Agent 在途轮次在无后台任务且无审批时的静默超时看门狗 |
| INSTANCE_IDLE_RECLAIM_MS | 1800000（30 分钟） | 空闲 AgentSession 内存实例自动回收时间（0 为不回收） |
| APPROVAL_TTL_MS | 1800000（30 分钟） | 工具审批卡片在手机端未作决定的自动过期超时（过期即拒绝） |
| NOTIFY_THROTTLE_MS | 60000（1 分钟） | 同一会话连续完成事件的通知推送抑制窗口 |
