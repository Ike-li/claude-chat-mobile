# 横屏长视频文案（B 站 / YouTube · 约 3 分钟）

> 形态：1920×1080 横屏 · 旁白驱动 + 画面演示 · 手机 UI 居右、要点字卡居左
> 每幕给出【画面】【旁白】【屏幕字卡】；旁白按 ~4.5 字/秒估时。
> 叙事骨架：docs-site 认知顺序（场景 → 是/不是 → 终端等价 → 单驾驶员诚实边界 → 安全 → 上手）。
> 事实终审：主仓 dev @ 8084005。主张只写代码实证存在的能力。

---

## 第 1 幕 · 冷开场（0:00–0:20）

【画面】电脑终端里 claude 跑长任务（如模块迁移）；人起身离开工位
【旁白】
> 你让 claude 改代码，然后去开会。二十分钟后它卡在一步危险操作上——要不要动配置？它在等你，而你不在电脑前。
【屏幕字卡】任务在跑，人不在

【画面】手机锁屏亮起，审批推送；点开：完整命令 + 目录，点「允许」；本机任务继续
【旁白】
> 现在，这一步可以推到你手机上。看一眼命令和目录，点一下，它继续干活。不用屏幕一直亮着，也不用远程戳进终端。
【屏幕字卡】看一眼 · 点一下 · 继续

## 第 2 幕 · 是什么 / 不是什么（0:20–0:50）

【画面】极简示意：手机浏览器 ⇄ 你电脑上的实例 ⇄ 本机 claude CLI；强调实例跑在你自己的机器
【旁白】
> 这是 claude-chat-mobile：开源、自托管的手机入口。它不打包 Claude，也不是 Claude 的重新实现——它通过官方 Agent SDK，驱动你电脑上已经登录的 claude CLI。
【屏幕字卡】不是另一个 Claude · 是本机 CLI 的手机入口

【旁白】
> 手机上是同一个 agent：同一份 CLAUDE.md、同样的 MCP、技能、hooks，和同一份会话 transcript。在手机上打字，目标就是和坐在终端前等价。
【屏幕字卡】同一 agent · 同一配置 · 同一会话

【旁白】
> 它也不是手机远程桌面。远程桌面只是把屏幕镜像过来；这里是给本机 claude 会话做随身入口——审批、续聊、看进度，按手机交互来做。
【屏幕字卡】不是远程桌面 · 是会话入口

## 第 3 幕 · 核心循环（0:50–1:30）

【画面】手机发任务；回复流式滚动，Markdown 与代码高亮
【旁白】
> 发一个任务，回复实时流回来，Markdown 和代码高亮都在。
【屏幕字卡】流式输出

【画面】工具卡：Edit/Write 看 diff，Read 看片段；限白名单目录
【旁白】
> 每一步操作折成卡片——改了哪个文件、diff 什么样，点开就看。预览只读，出不了你放行的工作目录。
【屏幕字卡】过程可见 · 一步一张卡

【画面】审批卡：命令、目录、允许/拒绝
【旁白】
> 白名单外的操作推到手机。你批准的就是它执行的那一步。
【屏幕字卡】所批即所见

【画面】AskUserQuestion 原生选项卡，点选
【旁白】
> 它拿不准时会出选择题，点一下就是答案。
【屏幕字卡】AskUserQuestion → 原生选择器

## 第 4 幕 · 细节与诚实边界（1:30–2:15）

【画面】快节奏串烧，每项约 4–6 秒
【旁白】
> 细节也按手机习惯做了：
> 忙的时候继续发——排队看得见，发错了能撤回重编辑。
> 权限六档运行时可切，模型可以按条消息换，思考强度也能调。
> 从相册或文件选截图；历史附件点开预览原图；项目文件只读浏览，路径闸卡在白名单里。
> 状态栏能看用量与上下文；Web 驾驶时子 agent 和任务进度可见。
> 几个仓库并行，标签页各管各的。
> 手机聊到一半，回电脑终端 `/resume`，接着同一份会话记录。
> 若终端正在驾驶，Web 只会只读追平磁盘上的 transcript，需要时再接管——不能把正在跑的终端画面实时镜像过来，两端也不会抢着写同一轮。
> 信号差时会重连并补发——这是断线重连，不是离线可用。
> 装成 PWA，就是一个 app。
【屏幕字卡】（逐条）排队可撤回 · 权限六档 · 切模型 · 相册附图 · 状态栏 · 多仓并行 · 终端续接 · 只读追平 · 弱网重连 · PWA

## 第 5 幕 · 安全模型（2:15–2:45）

【画面】四条铁律逐条点亮，可选第五条 Access
【旁白】
> 这是一条能远程碰到你电脑 shell 的通道，所以安全是这样设计的：
> 每个实例只属于你一个人，没有多用户、没有账号体系。
> 不设 token，服务只绑本机回环地址，出不了你的电脑。
> 权限不另起一套白名单，只继承你 claude CLI 已有的 settings——终端怎么批，手机就怎么批。
> 陌生设备要在电脑上一次性授权，光有 token 不够。
> 公网还可以再加一层 Cloudflare Access 双因素。
【屏幕字卡】单用户 · 无 token 不出本机 · 权限只继承 CLI · 设备 TOFU · 可选 Access

## 第 6 幕 · 上手与 CTA（2:45–3:05）

【画面】三档部署一闪；结尾卡 GitHub + 站点
【旁白】
> 同一 WiFi 填上 token 直连；出门用 cloudflared 起临时隧道；长期用固定域名加 Access。
> 开源，AGPL，代码在 GitHub——claude-chat-mobile。
【屏幕字卡】github.com/Ike-li/claude-chat-mobile

---

## 能力核查表（主张 → 代码证据）

| 文案主张 | 证据（当前 dev @ 8084005） |
|---|---|
| 手机入口，不是远程桌面 | `README.md`「适用场景」对比段 |
| 不打包/重实现 Claude；Agent SDK 驱动本机已登录 CLI | `README.md` 开篇；`src/agent/agent.js`；`package.json` description |
| 同一 agent / CLAUDE.md / MCP / skills / hooks / transcript | `README.md` 开篇 |
| 任务离开后手机处理审批推送 | `README.md`「适用场景」；`src/ops/notifications.js` |
| Web Push / ntfy + 深链（尽力而为） | `src/ops/notify-channels.js`；`src/ops/notifications.js` |
| 审批：完整命令 + 目录 + 允许/拒绝 | `tests/e2e/p0/permission-allow-deny.spec.ts` |
| 流式输出 + Markdown / 代码高亮 | `tests/e2e/p0/stream-markdown-thinking-result.spec.ts` |
| 工具卡 diff / 片段，白名单只读 | `tests/e2e/p0/tool-cards.spec.ts`；`src/files/file-preview.js` |
| AskUserQuestion 原生选择器 | `tests/e2e/p0/ask-user-question.spec.ts`；`public/js/app/approval-questions.js` |
| 权限六档运行时可切（含 dontAsk / auto） | `src/agent/cli-settings-defaults.js` `CCM_PERMISSION_MODES`；`src/agent/agent.js` VALID 六档；`tests/e2e/p0/settings-model-permission-effort.spec.ts` |
| 逐条切模型；思考强度可调 | `src/agent/agent.js` setModel；settings e2e 同上 |
| 排队可见 + 撤回重编辑 | `tests/e2e/p0/queued-messages.spec.ts`；`public/js/app.js` |
| 相册/文件附图；历史附件预览 | `src/files/uploads.js`；`tests/e2e/p0/attachments-ui.spec.ts` |
| 文件浏览器白名单只读 | `tests/e2e/p0/file-browser.spec.ts` |
| 状态栏；Web 驾驶时子 agent / 任务进度 | `src/ops/statusline.js`；`tests/e2e/p0/statusline.spec.ts`；`tests/e2e/p0/task-progress.spec.ts` |
| 多 repo / 多会话标签 | `src/sessions/workdirs.js`；`tests/e2e/p0/workspace-sessions-sidebar.spec.ts` |
| 手机起头，终端 `/resume` 同一 transcript | `README.md`「适用场景」；`src/sessions/history.js` |
| 终端驾驶时 Web 只读追平，可接管；不能 attach 活进程画面 | `src/sessions/history.js:163`；`public/js/logic.js` mirrorReadonly；`src/ops/cli-statusline-bridge.js` |
| 弱网重连补发（非离线可用） | `README.md`「适用场景」；`public/js/app.js` offlineQueue；`public/js/sw.js` |
| PWA 可安装 | `README.md`「特性」 |
| 每实例单用户，无多租户 | `README.md`「安全模型」§1 |
| 无 AUTH_TOKEN 只绑 127.0.0.1 | `src/server/app.js:2480`；`README.md`「安全模型」§2 |
| 权限只继承 CLI settings，不注入 allowedTools | `README.md`「安全模型」§3；terminal-parity / agent 不注入 allowedTools |
| 设备 TOFU | `README.md`「安全模型」§4；`src/auth/device-gate.js`；`tests/e2e/p0/device-tofu-requests-help.spec.ts` |
| 可选 Cloudflare Access 2FA | `src/auth/cf-access.js`；`docs/deployment.md` |
| 部署三档：同 WiFi / 临时 tunnel / 固定+Access | `README.md`「运行方式」；`docs/deployment.md` |
| 开源 AGPL；GitHub Ike-li/claude-chat-mobile | `LICENSE`；`package.json` repository |

**有意不写**（禁止出现在任何成片）：

- 实时镜像正在终端跑的活会话画面（冷读 transcript，不能 attach 活 CLI）
- 离线可用 / 离线缓存聊天（`public/js/sw.js`）
- 语音输入
- 拍照直传（无 camera `capture`）
- 多租户 / SaaS / 账号体系
- 「企业级零信任全家桶」类夸大
- Windows 主机（README：macOS 或 Linux）
