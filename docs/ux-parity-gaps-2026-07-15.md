# Web↔CLI 体感对等：缺口与落地（2026-07-15）

## 目标
手机 Web 交互不比本机 CLI 差（响应 + 对话丰富度）。

## 已落地

| 项 | 改动要点 | 验证 |
|----|----------|------|
| 子 agent 可折叠卡（live） | `parentToolUseId` 嵌套、默认收起 | logic + visual TC-24 |
| task:stop 停止按钮 | 进度横幅「停止」→ `task:stop`；多任务列表可逐停 | logic + visual TC-16 点击 |
| 工具展开全文 | `truncated` + `tool:full` + 缓存全文；Bash cap 2000 | agent + visual TC-2 |
| mirror 倒计时 | `mirror_state.remainingMs` 权威 + 前端倒计时文案 | logic + server |
| 冷启动/置换提示 | effort / externalDirty → system `resuming` | server + 前端 addBar |
| 额度窗 | 状态区「查看套餐额度」→ `usage:get` | logic `formatUsageWindowLines` |
| **历史 thinking 折叠回显** | `expandHistoryEntry` 保留 thinking（4k cap） | history 单测 |
| **历史 sidechain 子 agent 卡** | sidechain 回显 + 挂靠最近 Agent toolUseId | history 单测 + 前端 hist 卡 |
| **mirror catchUp 提速** | 只读镜像 1s / 常态 2.5s 动态调度 | server `rescheduleCatchUp` |
| **mirror 墙钟解锁** | `releaseTicks` 按间隔缩放，目标仍 ~12.5s | history `mirrorReleaseStep` |
| **BUFFER_CAP 2000** | 长轮少 gap 闪屏 | agent 单测 |
| **流式轻量 Markdown** | ≥400ms 节流预览，result 全量 finalize | app.js |

## 架构硬边界（仍不做）
- 无法 attach 终端 live 进程；追平仍只补**已落盘**消息
- AD-5 per-连接 mirror 锁、SP-10 busy 窗口吞写（有意保留）
- 历史 sidechain 无可靠 parent 字段时，挂靠「最近主链 Agent」属启发式（并行多 Agent 时可能错挂）

## 生产生效
- 纯前端：刷新即可
- `agent.js` / `server.js` / `history.js`：须 **restart 常驻 server**
