# 竖屏短视频文案（抖音 30s 主版 / 朋友圈 15s 精简版）

> 形态：1080×1920 竖屏 · 静音可看（字幕承担全部信息）· 画面 = 真实手机 UI 录屏
> 每镜给出【画面】与【字幕】；字幕单句 ≤ 15 字，一屏最多两行。
> 事实源：主仓 dev @ 8084005（2026-07-19）。主张只写代码实证存在的能力。

---

## 主版 · 30 秒（抖音）

### 镜 1 · Hook（0:00–0:04）

【画面】电脑工位一闪而过（claude 在跑长任务）；切到手机锁屏，推送横幅弹出——「Claude 请求批准」类审批通知
【字幕】
> 让它改代码
> 人先出门

### 镜 2 · 审批（0:04–0:11）

【画面】点开推送进入审批卡：完整命令 + 工作目录清晰可见，底部「允许 / 拒绝」；手指点「允许」
【字幕】
> 危险操作推到手机
> 看清命令，再放行

### 镜 3 · 过程可见（0:11–0:18）

【画面】聊天流实时滚动：Markdown / 代码高亮；工具调用折叠成卡片，点开一张 Edit/Write 看 diff
【字幕】
> 改了什么，实时看
> 一步操作，一张卡片

### 镜 4 · 换端续接（0:18–0:24）

【画面】分屏示意：左边手机同一会话气泡，右边电脑终端输入 `/resume`，同一段对话接上（非活终端画面镜像）
【字幕】
> 路上手机起的头
> 回家终端接着聊

### 镜 5 · 多仓并行（0:24–0:28）

【画面】顶部工作区/标签在两个仓库间切换；侧栏会话列表可见「worktree · 分支」分组一行
【字幕】
> 几个仓库并行跑
> 标签一切，各管各的

### 镜 6 · CTA（0:28–0:32）

【画面】结尾卡：大字项目名 claude-chat-mobile + GitHub 地址 github.com/Ike-li/claude-chat-mobile
【字幕】
> 开源 · 自托管
> 连本机 claude CLI

---

## 精简版 · 15 秒（朋友圈）

> 朋友圈默认静音自动播，前 3 秒定生死；只保留「推送审批」一个记忆点。

### 镜 1 · Hook（0:00–0:03）

【画面】锁屏推送弹出：「Claude 请求批准」
【字幕】
> claude 在家写代码
> 我在外面点了允许

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

【画面】结尾卡：项目名 claude-chat-mobile + GitHub 地址
【字幕】
> 开源 · 自托管
> 连本机 claude CLI

---

## 能力核查表（主张 → 代码证据）

| 文案主张 | 证据（当前 dev 分支 @ 8084005） |
|---|---|
| 在手机上用本机 `claude` CLI，效果等价终端 | `README.md` 标题/开篇；`package.json` description |
| 任务在跑、人离开后可手机处理审批 | `README.md`「适用场景」；`src/ops/notifications.js`（`permission_request` 推送） |
| 审批卡展示完整命令与工作目录，允许/拒绝 | `tests/e2e/p0/permission-allow-deny.spec.ts`；`public/js/app.js` `permission_request` |
| 可配置 Web Push / ntfy 推送审批（非开箱必达） | `src/ops/notify-channels.js`；`src/ops/notifications.js` |
| 流式输出，Markdown / 代码高亮 | `tests/e2e/p0/stream-markdown-thinking-result.spec.ts`；README 消息流程 |
| 工具调用折叠为卡片，Edit/Write 可看 diff | `tests/e2e/p0/tool-cards.spec.ts`；`src/files/file-preview.js`；README「特性」 |
| 手机起的会话，电脑终端 `/resume` 续同一 CLI 会话记录 | `README.md`「适用场景」；`src/sessions/history.js` 会话列表/续接 |
| 多仓库 / 多会话标签切换并行看进度 | `README.md`「特性」；`src/sessions/workdirs.js`；`tests/e2e/p0/workspace-sessions-sidebar.spec.ts` |
| 会话列表可见 linked worktree 按分支分组 | `src/sessions/worktree-sessions.js`；`public/js/app.js` `worktree:sessions`；commit `8084005` |
| 开源、自托管、驱动本机已登录 CLI（非另一 Claude） | `README.md` 开篇 + 许可证；`LICENSE` AGPL-3.0-only |
| GitHub：Ike-li/claude-chat-mobile | `package.json` repository；README 友链/站点 |

**有意不写**（代码不支持或有架构限制，禁止出现在任何成片）：

- 实时镜像正在终端里跑的活会话画面（Web 是独立 resume/追平，不能 attach 活进程画面）
- 离线可用（`public/js/sw.js`：Web Push only，无缓存离线）
- 语音输入（无语音识别输入路径）
- 拍照直传（附件来自相册/文件选择，无 `capture` 拍照主路径）
