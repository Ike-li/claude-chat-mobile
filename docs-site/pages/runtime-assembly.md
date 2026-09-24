# 启动与组装根
> server.js 薄入口与 app.js 组装根的启动时序。

- **Part**: 第四部分 · 核心实现
- **Reading Time**: ~12 min
- **Estimated Tokens**: ~1775

---

启动路径刻意设计为薄入口（`app/server.js`）与组装根（`app/src/server/app.js`）两段式：环境变量与安全时戳必须在任何状态模块求值前就绪，服务监听前必须清理孤儿挂起状态。

## server.js（薄入口）

```
// 运行时入口：app/server.js
import { join } from 'node:path';
import { loadRuntimeEnvironment } from './src/ops/config.js';
import { installLogTimestamps } from './src/shared/log-time.js';

// 显式传仓库根，不回落 process.cwd()：启动方式不保证 cwd 落在仓库根
const HERE = join(import.meta.dirname, '..');
loadRuntimeEnvironment(process.env, { dir: HERE });   // 读 ccm.config.json，缺失才回落 .env
installLogTimestamps();   // 须在动态 import(app.js) 之前，让模块级启动输出也带时间戳

const runtime = await import('./src/server/app.js');
export const httpServer = runtime.httpServer;
export const io = runtime.io;
export const port = runtime.port;
```

薄入口只有这几行。headless 的 `npm start`、macOS 桌面端的 LaunchAgent、集成测试都从这里拉起；自己写的保活方式（tmux、systemd、docker）也应该指向它。配置文件必须按仓库根定位：若回落到当前目录，启动时读到的会和配置面板写入的不是同一份，结果是静默的假成功。

## 配置求值与优先级

- 配置同源加载。 启动时由 app/src/ops/config.js 的 loadRuntimeEnvironment 加载仓库根下的 ccm.config.json （优先）并回落 .env ；读写与类型归一在 app/src/ops/config-file.js 。 CCM_CONFIG_FILE_PATH / CCM_ENV_FILE_PATH 可覆盖文件位置，启动侧与写入侧都认。
- 环境变量最高优先。 终端 Shell 中直接 export 的环境变量始终压过配置文件。
- 两处目录解析陷阱。 app/src/** 模块计算仓库根目录必须上溯 三层 。另外，LaunchAgent 启动命令 exec <node> app/server.js 必须与 service-units.js 解析常驻进程后缀的代码逐字严格一致。

## app.js 组装时序（12 步）

1. 依赖导入。 完成后端各领域核心模块（agent, sessions, files, auth, ops, shared）的静态与动态装配。
2. 解析配置。 执行 parseServerConfig() ，提取端口、Token、超时阈值、 ACCESS_PROFILE 及工作区配置。
3. 初始化通知通道。 装配 Web Push（VAPID）与可选 ntfy 实例（尽力而为，通道故障不阻塞主业务）。
4. Preflight 前置自检。 检查默认工作区（ WORKDIRS 首项）目录真实存在、校验 claude 二进制可执行（ CLAUDE_BIN ，留空则从 PATH 查找）。
5. 构建工作区白名单。 加载 WORKDIRS 白名单列表并建立文件监听，支持运行期免重启热加载。
6. 配置 Express HTTP 壳。 挂载 gzip 压缩、静态资源 CSP 策略、带 ?v= 指纹的防缓存头。
7. HTTP 鉴权与运维路由。 挂载统一鉴权中间件，并提供 /health 、 /metrics 、 /push/* 受控路由（杜绝免密端点）。
8. 挂载 Socket.IO 与设备门禁。 装配握手鉴权中间件与设备指纹 TOFU 判定器（ createDeviceGate ）。
9. 实例化 InstanceManager 与通信管道。 建立会话实例池与 Socket 进出向事件信封转发总线。
10. 进程级未捕获异常兜底。 注册 uncaughtException 与 unhandledRejection ，只记日志不退进程。
11. 孤儿审批清理（Fail-closed）。 在服务监听前执行 expireOrphanedPending() ，将因进程重启而失效的挂起审批彻底归档。
12. 绑定端口监听。 resolveBindPlan 先过令牌门：缺 AUTH_TOKEN 在 listen 之前就拒绝启动并退出。再按 BIND_MODE 选地址：默认 0.0.0.0 ， loopback 为 127.0.0.1 ， custom 用 BIND_HOST 。随后打印只含掩码令牌的启动横幅。

## 默认运行超时参数

| 配置项名 | 默认值 | 语义与作用 |
| --- | --- | --- |
| PORT | 3000 | HTTP / WebSocket 服务监听端口 |
| IDLE_TIMEOUT_MS | 600000（10 分钟） | Agent 在途轮次在无后台任务且无审批时的静默超时看门狗 |
| INSTANCE_IDLE_RECLAIM_MS | 1800000（30 分钟） | 空闲 AgentSession 内存实例自动回收时间（0 为不回收） |
| APPROVAL_TTL_MS | 1800000（30 分钟） | 工具审批卡片在手机端未作决定的自动过期超时（过期即拒绝） |
| NOTIFY_THROTTLE_MS | 60000（1 分钟） | 同一会话连续完成事件的通知推送抑制窗口 |
