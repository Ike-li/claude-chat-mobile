# 横屏长视频文案（B 站 / YouTube · 约 3 分钟）

> 形态：1920×1080 横屏 · 旁白驱动 + 画面演示 · 手机 UI 居右、要点字卡居左
> 每幕给出【画面】【旁白】【屏幕字卡】；旁白按 ~4.5 字/秒估时。

---

## 第 1 幕 · 冷开场（0:00–0:20）

【画面】电脑终端里 claude 正在跑一个长任务；人起身离开工位，屏幕留在原地
【旁白】
> 你让 claude 迁移一个模块，然后去开会。二十分钟后它卡在一个问题上：要不要改 tsconfig？它在等你，而你不在电脑前。
【屏幕字卡】任务在跑，人不在

【画面】手机锁屏亮起，推送弹出；手指点开，审批卡出现，点「允许」；终端里任务继续
【旁白】
> 现在，这个问题会推送到你手机上。看一眼，点一下，它继续干活。
【屏幕字卡】看一眼 · 点一下 · 继续

## 第 2 幕 · 它是什么（0:20–0:50）

【画面】架构极简示意：手机 ⇄ 你的电脑（claude CLI）；强调没有第三方服务器
【旁白】
> 这是 claude-chat-mobile，一个开源的自托管项目。它不打包 Claude，也不是 Claude 的重新实现——它通过官方 Agent SDK，驱动你电脑上已经登录的 claude CLI。
【屏幕字卡】不是另一个 Claude · 是你本机 CLI 的手机入口

【旁白】
> 手机上看到的，是同一个 agent：同一份 CLAUDE.md、同样的 MCP 服务器、技能、hooks，和同一份会话记录。在手机上打字，和坐在终端前打字，是等价的。
【屏幕字卡】同一个 agent · 同一份配置 · 同一份会话记录

## 第 3 幕 · 核心循环（0:50–1:30）

【画面】手机发出一条任务；回复流式滚动，Markdown 与代码高亮渲染
【旁白】
> 发一个任务，回复实时流回来，Markdown 和代码高亮都在。
【屏幕字卡】流式输出

【画面】工具调用折叠成卡片；点开 Edit 卡片看 diff，点开 Read 卡片看文件片段
【旁白】
> claude 的每一步操作都渲染成卡片——改了哪个文件、diff 长什么样，点开就看。
【屏幕字卡】过程可见 · 每步一张卡

【画面】审批卡特写：完整命令、工作目录、允许/拒绝；旁边小字演示"内容不符自动作废"
【旁白】
> 碰到危险操作，完整命令和所在目录推到手机。你批准的就是它执行的——内容对不上，这次批准自动作废。
【屏幕字卡】所批即所行

【画面】claude 抛出选择题，手机上出现原生选项卡，点选一项
【旁白】
> 它拿不准的时候会出选择题，点一下就是答案。
【屏幕字卡】AskUserQuestion → 原生选择器

## 第 4 幕 · 细节能力（1:30–2:10）

【画面】快节奏能力串烧，每项 4–6 秒
【旁白】
> 细节也按手机的习惯做了：
> 它忙的时候，你继续发——消息排队，标记看得见，发错了还能撤回重编辑。
> 权限五个档位、模型逐条消息可切、思考强度可调。
> 从相册发截图，历史里的附件点开就能预览；项目文件也能只读浏览，出不了白名单目录。
> 状态栏实时显示 token、花费和上下文余量——心里有数。
> 几个仓库并行跑，标签页各管各的。手机上聊到一半，回电脑终端 /resume，接着来。
【屏幕字卡】（逐条弹出）排队可撤回 · 权限五档 · 逐条切模型 · 附件与预览 · 只读文件浏览 · 状态栏 · 多仓库并行 · 终端续接

【画面】添加到主屏幕，全屏打开像原生 app
【旁白】
> 装成 PWA，就是一个 app。
【屏幕字卡】PWA 可安装

## 第 5 幕 · 安全模型（2:10–2:40）

【画面】四条防线逐条点亮
【旁白】
> 这是一条能远程碰到你电脑 shell 的通道，所以安全模型是这么设计的：
> 每个实例只属于你一个人，没有多用户系统。
> 不设 token，服务只绑定本机回环地址，出不了你的电脑。
> 权限不额外注入，只继承你 claude CLI 已有的配置——终端里怎么批，手机上就怎么批。
> 陌生设备要先在电脑上一次性授权，光有 token 进不来。公网部署还可以再加一层 Cloudflare Access 双因素。
【屏幕字卡】单用户实例 · 无 token 不出本机 · 权限只继承 CLI · 设备信赖 TOFU（+ 可选 2FA）

## 第 6 幕 · 上手与 CTA（2:40–3:00）

【画面】三行部署方式一闪而过；结尾卡：GitHub 地址 + 站点
【旁白】
> 同一个 WiFi 直连就能用；出门用 cloudflared 起个隧道；长期用就固定域名加双因素。
> 开源，AGPL 协议，代码和部署文档都在 GitHub——claude-chat-mobile。
【屏幕字卡】github.com/Ike-li/claude-chat-mobile

---

## 能力核查表（主张 → 代码证据）

| 文案主张 | 证据（当前 dev 分支） |
|---|---|
| 审批推送到手机，含完整命令与工作目录 | `tests/e2e/p0/permission-allow-deny.spec.ts`；`src/agent/approval-store.js` |
| 「所批即所行」：内容不符批准作废 | `public/js/canonicalize.js`；`src/auth/fingerprint.js`；`tests/integration/approval-integrity.test.mjs` |
| 锁屏推送 + 点通知深链回会话（Web Push / ntfy） | `src/ops/notify-channels.js`；README「特性」通知条目 |
| 官方 Agent SDK 驱动本机已登录 CLI；同一配置与会话记录 | `package.json`（`@anthropic-ai/claude-agent-sdk`）；README 首段（settingSources 同源） |
| 流式输出 + Markdown + 代码高亮 | `tests/e2e/p0/stream-markdown-thinking-result.spec.ts`；`public/vendor/marked.min.js`、`highlight.min.js` |
| 工具卡片：Edit/Write 看 diff、Read 看片段 | `tests/e2e/p0/tool-cards.spec.ts`；README「特性」 |
| AskUserQuestion 原生选择器 | `tests/e2e/p0/ask-user-question.spec.ts` |
| busy 时消息排队、可见、可撤回重编辑 | `tests/e2e/p0/queued-messages.spec.ts` |
| 权限五档运行时可切 | `tests/e2e/p0/settings-model-permission-effort.spec.ts`；`tests/smoke/scenarios/permission-modes.js` |
| 逐条消息切换模型 / 思考强度可调 | 同上 spec；`tests/smoke/scenarios/model-switch.js` |
| 相册发图、历史附件点开预览 | `tests/e2e/p0/attachments-ui.spec.ts`；`src/files/uploads.js`、`file-preview.js` |
| 项目文件只读浏览、白名单目录三层路径闸 | `tests/e2e/p0/file-browser.spec.ts`；`src/files/workdir-scope-guard.js` |
| 状态栏：token / 花费 / 上下文余量 | `tests/e2e/p0/statusline.spec.ts`；`src/ops/statusline.js` |
| 多工作目录多会话标签并行 | `tests/e2e/p0/workspace-sessions-sidebar.spec.ts`；`src/sessions/workdirs.js` |
| 手机起头 → 终端 `/resume` 续接同一会话 | README「适用场景」第 2 条；`src/sessions/history.js` |
| 弱网断线重连并补发输出 | README「适用场景」第 2 条；`public/js/app/connection-sync.js`；`tests/e2e/p0/cold-start-hydration.spec.ts` |
| PWA 可安装 | `public/manifest.webmanifest`；README「特性」 |
| 单用户实例 / 无 token 只绑 127.0.0.1 / 权限只继承 CLI / 设备 TOFU | README「安全模型」1–4 条；`src/server/config.js`；`src/auth/device-gate.js` |
| 可选 Cloudflare Access 双因素 | `src/auth/cf-access.js`；`docs/deployment.md` |
| 部署三选一（局域网 / 临时隧道 / 固定生产） | README「运行方式(三选一)」；`docs/deployment.md` |
| 开源 AGPL | `LICENSE`；`package.json` license 字段 |

**有意不写**（代码不支持或有架构限制，禁止出现在任何成片）：实时镜像正在终端里跑的活会话画面（web 是独立 resume 冷读，不能 attach 活进程）、离线可用、语音输入、拍照直传。
