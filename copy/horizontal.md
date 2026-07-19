# 横屏长视频文案（B 站 / YouTube · 约 3 分钟）

> 形态：1920×1080 横屏 · 旁白驱动 + 画面演示 · 手机 UI 居右、要点字卡居左
> 每幕给出【画面】【旁白】【屏幕字卡】；旁白按 ~4.5 字/秒估时。
> 事实源：主仓 dev @ 8084005（2026-07-19）。主张只写代码实证存在的能力。

---

## 第 1 幕 · 冷开场（0:00–0:20）

【画面】电脑终端里 claude 正在跑一个长任务（例如模块迁移）；人起身离开工位，屏幕留在原地
【旁白】
> 你让 claude 把一个模块迁到 TypeScript，然后去开会。二十分钟后它卡在一个问题上：要不要改 tsconfig？它在等你，而你不在电脑前。
【屏幕字卡】任务在跑，人不在

【画面】手机锁屏亮起，审批类推送弹出；手指点开，审批卡出现完整命令与目录，点「允许」；任务在本机继续
【旁白】
> 现在，这个问题可以推到你手机上。看一眼命令和目录，点一下，它继续干活。不用让电脑屏幕一直亮着，也不用远程戳进终端。
【屏幕字卡】看一眼 · 点一下 · 继续

## 第 2 幕 · 它是什么（0:20–0:50）

【画面】极简架构示意：手机浏览器 ⇄ 你电脑上的 claude-chat-mobile 实例 ⇄ 本机 claude CLI；强调实例跑在你自己的机器上
【旁白】
> 这是 claude-chat-mobile：开源、自托管的手机入口。它不打包 Claude，也不是 Claude 的重新实现——它通过官方 Agent SDK，驱动你电脑上已经登录的 claude CLI。
【屏幕字卡】不是另一个 Claude · 是你本机 CLI 的手机入口

【旁白】
> 手机上看到的，是同一个 agent：同一份 CLAUDE.md、同样的 MCP 服务器、技能、hooks，和同一份会话记录。在手机上打字，和坐在终端前打字，目标就是等价。
【屏幕字卡】同一个 agent · 同一份配置 · 同一份会话

【旁白】
> 它也不是手机远程桌面。远程桌面只是把屏幕镜像过来；这里是给本机 claude 会话做随身入口——审批、续聊、看进度，按手机交互来做。
【屏幕字卡】不是远程桌面 · 是会话入口

## 第 3 幕 · 核心循环（0:50–1:30）

【画面】手机发出一条任务；回复流式滚动，Markdown 与代码高亮渲染
【旁白】
> 发一个任务，回复实时流回来，Markdown 和代码高亮都在。
【屏幕字卡】流式输出

【画面】工具调用折叠成卡片；点开 Edit 卡片看 diff，点开 Read 卡片看文件片段（限白名单工作目录）
【旁白】
> claude 的每一步操作都渲染成卡片——改了哪个文件、diff 长什么样，点开就看。预览只读，出不了你放行的工作目录。
【屏幕字卡】过程可见 · 每步一张卡

【画面】审批卡特写：完整命令、工作目录、允许/拒绝
【旁白】
> 碰到白名单外的危险操作，完整命令和所在目录推到手机。你批准的就是它执行的那一步。
【屏幕字卡】所批即所见

【画面】claude 抛出选择题，手机上出现原生选项卡，点选一项
【旁白】
> 它拿不准的时候会出选择题，点一下就是答案。
【屏幕字卡】AskUserQuestion → 原生选择器

## 第 4 幕 · 细节能力（1:30–2:15）

【画面】快节奏能力串烧，每项约 4–6 秒
【旁白】
> 细节也按手机的习惯做了：
> 它忙的时候，你继续发——消息排队，标记看得见，发错了还能撤回重编辑。
> 权限五个档位运行时可切，模型可以按条消息切换，思考强度也能调。
> 从相册或文件选截图发给它，历史里的附件点开就能预览原图；项目文件也能只读浏览，路径闸卡在白名单目录内。
> 状态栏能看 token、花费和上下文余量；回合结束有 CLI 式的收尾行。
> 子 agent 和任务进度在 Web 驾驶时可见。
> 几个仓库并行跑，标签页各管各的；git worktree 里开过的会话，列表里按分支分组，点进去就能续。
> 手机上聊到一半，回电脑终端 `/resume`，接着同一份会话记录。若终端正在驾驶，Web 会进入只读追看，需要时再接管——两端不会抢同一轮活写。
> 地铁信号差时页面会重连并补发输出；弱网时发出去的消息会在恢复后补送——这不是离线可用，是断线重连。
> 装成 PWA，就是一个 app。
【屏幕字卡】（逐条弹出）排队可撤回 · 权限五档 · 逐条切模型 · 相册附件与预览 · 只读文件浏览 · 状态栏 · 子 agent 可见 · 多仓库并行 · worktree 会话 · 终端续接 · 弱网重连 · PWA

## 第 5 幕 · 安全模型（2:15–2:45）

【画面】四条防线逐条点亮（可选第五条 CF Access）
【旁白】
> 这是一条能远程碰到你电脑 shell 的通道，所以安全模型是这么设计的：
> 每个实例只属于你一个人，没有多用户、账号或登录系统。
> 不设 token，服务只绑定本机回环地址，出不了你的电脑。
> 权限不额外注入放行清单，只继承你 claude CLI 已有的配置——终端里怎么批，手机上就怎么批。
> 陌生设备要先在电脑上一次性授权，光有 token 进不来。
> 公网部署还可以再加一层 Cloudflare Access 双因素。
【屏幕字卡】单用户实例 · 无 token 不出本机 · 权限只继承 CLI · 设备信赖 TOFU · 可选 Access 2FA

## 第 6 幕 · 上手与 CTA（2:45–3:05）

【画面】三行部署方式一闪而过；结尾卡：GitHub 地址 + 站点
【旁白】
> 同一个 WiFi 直连就能用；出门用 cloudflared 起个临时隧道；长期用就固定域名加双因素。
> 开源，AGPL 协议，代码和部署文档都在 GitHub——claude-chat-mobile。
【屏幕字卡】github.com/Ike-li/claude-chat-mobile

---

## 能力核查表（主张 → 代码证据）

| 文案主张 | 证据（当前 dev 分支 @ 8084005） |
|---|---|
| 产品定位：手机上用本机 claude CLI，等价终端 | `README.md` 开篇；`package.json` description |
| 不是远程桌面，是本机 claude 会话的手机入口 | `README.md`「适用场景」对比段落 |
| 不打包/重实现 Claude；Agent SDK 驱动本机已登录 CLI | `README.md` 开篇；`src/agent/agent.js` |
| 同一 agent / CLAUDE.md / MCP / skills / hooks / 会话记录 | `README.md` 开篇 |
| 任务离开电脑后手机处理审批推送 | `README.md`「适用场景」；`src/ops/notifications.js` `permission_request` |
| Web Push / ntfy 通知 + 深链回会话 | `src/ops/notify-channels.js`；`src/ops/notifications.js` |
| 审批：完整命令 + 目录 + 允许/拒绝 | `tests/e2e/p0/permission-allow-deny.spec.ts` |
| 流式输出 + Markdown / 代码高亮 | `tests/e2e/p0/stream-markdown-thinking-result.spec.ts` |
| 工具卡片：Edit/Write diff、Read 片段，白名单只读 | `tests/e2e/p0/tool-cards.spec.ts`；`src/files/file-preview.js`；README「特性」 |
| AskUserQuestion → 原生选择器 | `tests/e2e/p0/ask-user-question.spec.ts`；`public/js/app/approval-questions.js` |
| 五档权限运行时可切（default/plan/acceptEdits/bypassPermissions/dontAsk） | `src/agent/agent.js` permissionMode；`tests/e2e/p0/settings-model-permission-effort.spec.ts`；`tests/smoke/scenarios/permission-modes.js` |
| 逐条消息切换模型；思考强度可调 | `src/agent/agent.js` setModel/activeModel；settings e2e 同上 |
| 排队可见 + 撤回重编辑 | `tests/e2e/p0/queued-messages.spec.ts`；`public/js/app.js` queued-indicator / `user:cancelQueued` |
| 相册/文件附件上传；历史附件点按预览原图 | `src/files/uploads.js`；`public/js/app/attachments.js`；`tests/e2e/p0/attachments-ui.spec.ts` |
| 文件浏览器白名单只读 | `tests/e2e/p0/file-browser.spec.ts` |
| 状态栏（token/花费/上下文等）；回合收尾行 CLI 化 | `src/ops/statusline.js`；`public/js/logic.js` TURN_DONE_VERBS / formatCliDuration；`tests/e2e/p0/statusline.spec.ts` |
| Web 驾驶时子 agent / 任务进度可见 | `public/js/app.js` subagent-card；`tests/e2e/p0/task-progress.spec.ts` |
| 多 repo / 多会话标签 | `src/sessions/workdirs.js`；`tests/e2e/p0/workspace-sessions-sidebar.spec.ts` |
| linked worktree 会话按分支分组可续 | `src/sessions/worktree-sessions.js`；`public/js/app.js` worktree:sessions；commit `8084005` |
| 手机起头，终端 `/resume` 续同一会话记录 | `README.md`「适用场景」；`src/sessions/history.js` |
| 终端驾驶时 Web 只读追看，可接管（非活画面镜像） | `public/js/logic.js` mirrorReadonly / armedTakeover；`src/ops/cli-statusline-bridge.js`；`src/sessions/history.js` 注释（独立 resume，不能 attach 活进程） |
| 弱网重连补发输出/补送消息（非离线可用） | `README.md`「适用场景」；`public/js/app.js` offlineQueue / processOfflineQueue；`public/js/sw.js`（无缓存离线） |
| PWA 可安装 | `README.md`「特性」；`public/index.html` / manifest |
| 每实例单用户，无多租户 | `README.md`「安全模型」§1 |
| 无 AUTH_TOKEN 只绑 127.0.0.1 | `src/server/app.js` host 绑定；README「安全模型」§2 |
| 权限只继承 CLI settings，项目不注入 allowedTools 清单 | `README.md`「安全模型」§3；启动日志「工具放行: 由 .claude/settings.json…」 |
| 设备信赖 TOFU | `README.md`「安全模型」§4；`src/auth/device-gate.js` |
| 可选 Cloudflare Access 2FA | `src/auth/cf-access.js`；README；`docs/deployment.md` |
| 部署三档：同 WiFi / 临时 tunnel / 固定域名+Access | `README.md`「运行方式」；`docs/deployment.md` |
| 开源 AGPL；GitHub Ike-li/claude-chat-mobile | `LICENSE`；`package.json` repository；README |

**有意不写**（代码不支持或有架构限制，禁止出现在任何成片）：

- 实时镜像正在终端里跑的活会话画面（Web 是独立 resume/磁盘追平，不能 attach 活进程；CLI 驾驶时无活思考/在途子 agent 画面）
- 离线可用 / 离线缓存聊天（`public/js/sw.js`：Web Push only, no caching, no offline）
- 语音输入（无语音识别输入；仅有浏览器朗读类能力，不写成「语音操控」）
- 拍照直传（附件来自相册/文件选择，无 camera `capture` 主路径）
- 多租户 / 账号体系 / 托管 SaaS
- Windows 主机支持（README：macOS 或 Linux）
