# Web↔CLI 体感对等：缺口与落地（2026-07-15）

## 目标
手机 Web 交互不比本机 CLI 差（响应 + 对话丰富度）。

## 已落地（dev 工作树，未 commit / 生产须重启常驻 server 才生效的部分见下）

| 项 | 改动要点 | 验证 |
|----|----------|------|
| 子 agent 可折叠卡 | `parentToolUseId` 嵌套、默认收起 | logic 单测 + visual TC-24 |
| task:stop 停止按钮 | 进度横幅「停止」→ `task:stop` | logic + visual TC-16 可见 |
| 工具展开全文 | `truncated` + `tool:full` + 缓存全文 | agent 单测 + visual TC-2 |
| mirror 倒计时文案 | ~12.5s 估计解锁提示 | logic `formatMirrorBannerText` |
| 冷启动/置换提示 | effort / externalDirty → system `resuming` | server emit + 前端 addBar |
| 额度窗 | 状态区「查看套餐额度」→ `usage:get` | logic `formatUsageWindowLines` |

## 架构硬边界（本轮不做）
- 无法 attach 终端 live 进程；catchUp 2.5s 只补落盘消息
- 历史冷路径不回显 sidechain / thinking（磁盘策略）
- AD-5 per-连接 mirror 锁、SP-10 busy 窗口吞写

## 生产生效
- 纯前端：刷新即可
- `agent.js` / `server.js`：须 `launchctl kickstart` 常驻服务
