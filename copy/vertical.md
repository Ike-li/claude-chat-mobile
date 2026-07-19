# 竖屏短视频文案（抖音 30s 主版 / 朋友圈 15s 精简版）

> 形态：1080×1920 竖屏 · 静音可看（字幕承担全部信息）· 画面 = 真实手机 UI 录屏
> 每镜给出【画面】与【字幕】；字幕单句 ≤ 15 字，一屏最多两行。

---

## 主版 · 30 秒（抖音）

### 镜 1 · Hook（0:00–0:04）

【画面】手机锁屏亮起，推送横幅弹出："Claude 请求批准：git push"
【字幕】
> 让 claude 改代码
> 然后，出门

### 镜 2 · 审批（0:04–0:11）

【画面】点开推送进入审批卡：完整命令 + 所在目录清晰可见，下方「允许 / 拒绝」两键；手指点「允许」
【字幕】
> 危险操作？推到手机上
> 完整命令、哪个目录，看清楚再放行

### 镜 3 · 过程可见（0:11–0:18）

【画面】聊天流实时滚动：Markdown 渲染、代码高亮，工具调用折叠成卡片，点开一张看 diff
【字幕】
> 它改了什么，实时看
> 每一步工具调用，都是一张卡片

### 镜 4 · 换设备续接（0:18–0:24）

【画面】分屏：左边手机在聊，右边电脑终端输入 `/resume`，同一段对话接上
【字幕】
> 路上手机起的头
> 回家终端 /resume 接着聊

### 镜 5 · 多仓库并行（0:24–0:28）

【画面】顶部标签页在两个项目间切换，各自的会话都在跑
【字幕】
> 几个仓库并行跑
> 标签页一切，各管各的

### 镜 6 · CTA（0:28–0:32）

【画面】结尾卡：项目名 + GitHub 地址
【字幕】
> 开源 · 自托管
> 驱动的是你本机登录好的 claude CLI
> GitHub 搜 claude-chat-mobile

---

## 精简版 · 15 秒（朋友圈）

> 朋友圈默认静音自动播，前 3 秒定生死；只保留「推送审批」一个记忆点。

### 镜 1 · Hook（0:00–0:03）

【画面】锁屏推送弹出："Claude 请求批准：git push"
【字幕】
> claude 在家写代码
> 我在外面点了个「允许」

### 镜 2 · 审批（0:03–0:08）

【画面】审批卡全貌：完整命令 + 目录 + 允许/拒绝
【字幕】
> 完整命令推到手机
> 看清楚，再放行

### 镜 3 · 过程（0:08–0:12）

【画面】流式输出 + 工具卡片快速滚动
【字幕】
> 改了什么，随时看

### 镜 4 · CTA（0:12–0:16）

【画面】结尾卡
【字幕】
> 开源自托管 · 连你自己的 claude CLI
> GitHub: claude-chat-mobile

---

## 能力核查表（主张 → 代码证据）

| 文案主张 | 证据（当前 dev 分支） |
|---|---|
| 危险操作推送到手机审批，含完整命令与目录 | `tests/e2e/p0/permission-allow-deny.spec.ts`；`src/agent/approval-store.js`；README「安全模型」第 3 条 |
| 锁屏推送、点通知深链回会话 | `src/ops/notify-channels.js`（Web Push / ntfy）；README「特性」通知条目 |
| 流式输出 + Markdown + 代码高亮 | `tests/e2e/p0/stream-markdown-thinking-result.spec.ts`；`public/vendor/marked.min.js`、`highlight.min.js` |
| 工具调用渲染为折叠卡片、可看 diff | `tests/e2e/p0/tool-cards.spec.ts`；README「特性」工具卡片条目 |
| 手机起头、终端 `/resume` 续接同一会话 | README「适用场景」第 2 条；`src/sessions/history.js`（读写 CLI 同源会话记录） |
| 多工作目录、多会话标签并行 | `tests/e2e/p0/workspace-sessions-sidebar.spec.ts`；`src/sessions/workdirs.js` |
| 自托管、驱动本机已登录 claude CLI | README 首段；`@anthropic-ai/claude-agent-sdk` 依赖（package.json） |
| 开源 | `LICENSE`（AGPL-3.0-only） |

**有意不写**（代码不支持或有架构限制，禁止出现在任何成片）：实时镜像正在终端里跑的活会话画面、离线可用、语音输入、拍照直传。
