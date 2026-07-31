# v1.4.0 发布文案（社交媒体）

> 形态：纯文字帖，无配图依赖（配图可用 `claude-chat-mobile-promo-v4-sharp-4k.png` 或界面截图）
> 事实终审：主仓 dev @ c490ffc（v1.3.0..HEAD，120 个非 merge commit）
> 铁律复核：主张全部有代码证据（见文末核查表）；禁写清单逐条比对过。

---

## A · X / Twitter（英文，≤280 字符）

```
claude-chat-mobile v1.4.0 — your local Claude Code CLI, from your phone.

· Gateway 5xx now shows the real error + retry countdown, not a silent spinner
· Full English UI
· Push fixed — and self-testable
· Terminal-session alerts now instant

Self-hosted. AGPL.
```

**实测 261 字符**（X 上限 280）。

---

## B · X / Twitter（中文，≤140 字）

```
claude-chat-mobile v1.4.0

手机开本机 Claude Code。这版主要把「出问题时看不见」补上了：

· 网关报错不再干等——状态行直接显示错误码和重试倒计时
· 英文界面全量覆盖
· 推送修好了，还能自己发一条测试
· 终端会话的通知改成即时

开源自托管
```

**实测 143 字符 / 87 个汉字**（X 对 CJK 按双倍权重计 ≈230，上限 280）。

---

## C · 微博

```
claude-chat-mobile v1.4.0 发布 🎉

把本机 claude CLI 接到手机上用——同一个 agent、同一份会话记录、同一套权限配置。不是远程桌面。

这一版做的事可以总结成一句：让出问题的时候看得见。

【看得见的错误】
以前上游网关抽风，手机上只有一个转圈的等待动画，你不知道是模型在想、还是网关挂了。现在跟终端里一样：状态行直接顶替成「API 错误 503 · 4s 后重试 · 第 2/10 次」，倒计时走秒。刷新页面后历史里的报错也会标红，不再混在普通回复里。

【看得见的通知】
推送链路修好了两条静默失败的路径，订阅状态可见，还加了「发一条测试推送」按钮——不用等真事发生才知道推送到底通没通。终端会话的「回合结束 / 需要你确认」从轮询改成了即时信号。

【英文界面】
624 条词条全量覆盖。

【行为变更】
运行中不再排队消息，改成一轮一条：正在跑的时候发送键变停止键。

⚠️ 升级注意：git worktree 不再自动探测，需要显式写进 workdirs.json 才会出现在工作区列表里。

开源 · 自托管 · AGPL-3.0
github.com/Ike-li/claude-chat-mobile
```

**实测 530 字符 / 348 个汉字**。

---

## D · 朋友圈（≤100 字）

```
claude-chat-mobile v1.4.0

手机开本机 Claude Code。这版补的是「出问题时看得见」：网关报错直接显示错误码和重试倒计时，不再干等；推送修好并可自测；英文界面全量。

开源自托管
```

**实测 106 字符 / 65 个汉字**。

---

## E · GitHub Release 开头摘要（可选）

> 自动生成的 commit 列表有 119 条，平铺不好读。发版后用 `gh release edit v1.4.0 --notes-file` 在开头补这段。

```markdown
## 这一版在做什么

让出问题的时候看得见。

- **API 错误可见性**：上游网关报错时，状态行不再是一个沉默的等待动画——按 CLI 的形态整行顶替成错误码 + 重试倒计时；此前被吞进日志的一批 SDK 提示（模型拒绝、压缩失败、额度耗尽、子 agent 报错）现在会上屏；刷新后历史里的 API 错误差异化渲染。
- **推送可自证**：修掉 Service Worker 注册位置导致订阅静默挂死的根因，补上订阅状态显示与「发一条测试推送」。
- **终端会话即时通知**：可选的 CLI hooks 桥，把「回合结束 / 需要你」从轮询变成即时信号。
- **英文界面全量覆盖**（624 词条）。
- **设置与输入区重构**：设置按作用域拆成会话 / 通用两层，底栏模型·权限·思考合并成一条摘要。
- **四轮全量代码审查**产出的修复占了本版 fix 的相当比例，含数条安全加固。

### ⚠️ 破坏性变更

git worktree 的自动探测已移除。worktree 路径须显式写入 `workdirs.json` 才作为工作区出现，`cwd` 合法性只认白名单。这是把隐式鉴权收紧为显式白名单。

### 行为变更

运行中的消息排队已移除，改为「一轮一条」：回合进行中发送键变停止键。
```

---

## 能力核查表（主张 → 代码证据）

| 文案主张 | 证据（主仓 dev @ c490ffc） |
|---|---|
| 把本机 claude CLI 接到手机，同一 agent / 会话记录 / 权限配置，非远程桌面 | `README.md` 开篇原话（"不是远程桌面，也不是共享实时 TTY"） |
| 网关报错时状态行显示错误码 + 重试倒计时 | `public/js/logic.js` `formatCliRetryLine`；`public/js/app.js` `liveLine.retry`；`tests/e2e/p0/api-retry-line.spec.ts` P0-30 |
| 倒计时走秒（非静态文案） | `public/js/app.js` 1s ticker 重算 `remainingSec`；`tests/unit/logic-live-status.test.mjs` |
| 此前被吞的 SDK 提示现在上屏（模型拒绝/压缩失败/额度耗尽/子 agent 报错） | `src/agent/agent.js` `emitNotice` + 各 subtype 分支；`tests/unit/agent-system-subtypes.test.mjs` |
| 刷新后历史里的 API 错误差异化渲染 | `src/sessions/history.js` `apiErrorField`；`tests/e2e/p0/api-retry-line.spec.ts` P0-30c |
| 推送订阅状态可见 + 可发测试推送 | `public/index.html:754` `#btnPushTest`「🔔 发一条测试推送」；`src/ops/notify-channels.js` |
| 终端会话「回合结束/需要你」即时信号（可选装） | `scripts/hooks-bridge-setup.js`；`scripts/hooks-bridge.js`；`CLAUDE.md` hooks 桥段落 |
| 英文界面 624 词条 | `public/js/i18n.js` `EN_DICT`（实测 `Object.keys().length === 624`）；`README.en.md` |
| 运行中一轮一条，发送键变停止键 | `src/agent/agent.js:450`「当前任务运行中，请等待完成」；`public/js/logic.js` `resolveComposerPrimaryMode` |
| worktree 须显式写入 workdirs.json（破坏性） | commit `feat!: 拆除 git worktree 自动探测，改为显式 workdir` 正文；`src/sessions/workdirs.js` 白名单判定 |
| 设置按作用域拆成会话/通用两层 | commit `feat(ui): 设置按作用域拆成「会话设置 / 通用设置」…` |
| 开源自托管 AGPL-3.0 | `LICENSE`；`package.json` license 字段 |
| 仓库地址 Ike-li/claude-chat-mobile | `package.json` repository |

**有意不写**（禁写清单逐条复核，本文案均未出现）：

- 实时镜像正在终端跑的活会话画面（本版的只读镜像仍是 transcript 追平，不是 attach 活进程）
- 离线可用（Service Worker 只做推送，不做离线缓存）
- 语音输入
- 拍照直传
- 多租户 / SaaS / 账号体系
- 防封号 / 藏时区 / 对抗官方 App

**有意不进社交媒体的**（留给 Release notes / README）：

- CI 与测试基建改动（force-exit 竞态、Node 24、E2E 分片）——对用户无感
- 四轮代码审查的逐条修复明细——只在 Release 摘要里概括一句
- 模型上下文窗口误判、statusline 内部口径等细节——属"本该如此"，不构成卖点
