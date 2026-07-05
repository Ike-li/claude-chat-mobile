# Claude Chat Mobile 综合测试计划

## Application Overview

本计划面向 claude-chat-mobile 的移动端聊天式 Web UI。核心目标是验证手机端交互与“坐在电脑前对 claude CLI 打字”的终端等价性：消息发送、流式输出、工具调用、审批、会话/工作区、设置、设备信赖、附件与状态同步都应以用户可见行为和 Socket.IO 可观测事件为准。P0 使用 http://127.0.0.1:33341 的 visual mock server，零 token、可日常回归；P1 覆盖协议/集成边界；P2 覆盖真实 Claude 与生产 smoke，必须低频且显式 opt-in。

## Test Scenarios

### 1. P0 日常零 token Mock UI 回归

**Seed:** `tests/seed.goto-mock.spec.ts`

#### 1.1. P0-01 首屏冷启动、hydration 与连接状态

**File:** `tests/p0/cold-start-hydration.spec.ts`

**Steps:**
  1. 起始状态/假设：fresh browser context；清空 localStorage/sessionStorage；打开 http://127.0.0.1:33341；不依赖真实 Claude、不消耗 token。
    - expect: 页面标题为 Claude Chat Mobile。
    - expect: 首屏出现移动端聊天壳：顶部工作区/会话入口、日志按钮、新会话按钮、消息区、底部输入框、附件、设置、发送按钮。
    - expect: 连接状态从未连接/加载态进入已连接或可交互状态。
    - expect: 模型、权限档、状态线、instances 等 hydration 信息最终可见。
    - expect: 失败条件：页面停在空白/未连接、输入区不可见、出现未处理 JS error、首屏控件遮挡或底部输入不可达。
  2. 读取首屏用户可见文本与可交互控件。
    - expect: 可见工作区名称类似 claude-chat-mobile。
    - expect: 输入框 placeholder 为“给 Claude 发消息...”或同义文案。
    - expect: 默认发送按钮在空输入时 disabled。
    - expect: 状态 pill 展示当前模型、默认审批、默认/模型默认思考。

#### 1.2. P0-02 输入框、发送按钮与空输入边界

**File:** `tests/p0/input-send-empty.spec.ts`

**Steps:**
  1. 起始状态/假设：fresh state，已连接，输入框为空。
    - expect: 发送按钮 disabled 或呈不可点击态。
    - expect: 按 Enter 或点击发送不会新增用户消息，不会触发 busy，不会出现空白 assistant 消息。
  2. 在输入框输入普通文本 hello。
    - expect: 发送按钮变为 enabled。
    - expect: 输入内容保持可编辑，移动端布局不跳动，底部工具栏不遮挡文本。
  3. 清空输入框。
    - expect: 发送按钮恢复 disabled。
    - expect: 失败条件：空输入可发送、产生空消息、按钮状态与输入内容不一致。

#### 1.3. P0-03 流式回复、Markdown、thinking 与结果栏

**File:** `tests/p0/stream-markdown-thinking-result.spec.ts`

**Steps:**
  1. 起始状态/假设：fresh state。向聊天输入框发送 test:stream。
    - expect: 立即出现用户消息 test:stream。
    - expect: active status pill 出现，文本表示 Claude 正在执行/思考，停止按钮可见。
    - expect: thinking 折叠块出现，包含思考过程但默认不破坏主回复阅读。
  2. 等待流式输出结束。
    - expect: assistant 消息逐步增长并最终完整显示。
    - expect: Markdown 渲染包含粗体、列表、inline code、代码块和复制代码按钮。
    - expect: 完成后 active status pill 隐藏。
    - expect: 结果栏显示完成状态、耗时/成本/模型等可见摘要；成本格式应稳定，例如 $0.0015。
    - expect: 失败条件：流式过程卡住、Markdown 原文泄漏、thinking 混入主回复、完成后仍 busy、结果栏缺失或显示 NaN。

#### 1.4. P0-04 长流式输出与停止/中断

**File:** `tests/p0/long-stream-interrupt.spec.ts`

**Steps:**
  1. 起始状态/假设：fresh state。发送 test:stream-long，等待至少一个 Chunk 出现。
    - expect: active status pill 可见，停止按钮可点击。
    - expect: 回复持续追加 Chunk，不阻塞输入区布局。
  2. 点击停止按钮。
    - expect: 前端发出中断意图，停止按钮不应重复触发多次副作用。
    - expect: 用户可见状态从执行中回落到空闲或明确显示已中断。
    - expect: 之后可继续发送新消息。
    - expect: 失败条件：点击停止无反馈、busy 永久不消失、旧流继续无限追加、停止中断到错误会话 tab。

#### 1.5. P0-05 工具调用卡片生命周期

**File:** `tests/p0/tool-cards.spec.ts`

**Steps:**
  1. 起始状态/假设：fresh state。发送 test:tool。
    - expect: 出现 thinking 和多个工具卡片。
    - expect: 工具卡片标题可读，例如 read_file、edit_file、run_command。
    - expect: 工具运行中状态与 active status pill 一致。
  2. 等待完成并展开第一个工具卡片。
    - expect: 工具卡片可折叠/展开。
    - expect: 展开后显示 input/output 摘要，例如 utils/date.js、npm test 或成功输出。
    - expect: 所有成功工具最终显示成功状态。
    - expect: 最终 assistant 文本总结工具执行结果。
    - expect: 失败条件：工具结果找不到对应卡片、状态不从运行中切换、展开内容为空、不同工具输出串卡。

#### 1.6. P0-06 权限审批 allow/deny 与本会话总是允许

**File:** `tests/p0/permission-allow-deny.spec.ts`

**Steps:**
  1. 起始状态/假设：fresh state，权限档为默认审批。发送 test:permission。
    - expect: 出现权限请求 bottom sheet。
    - expect: sheet 显示工具名 run_command、cwd、完整命令 git push origin main。
    - expect: 包含“本会话内总是允许此类操作”复选框、拒绝、允许按钮。
    - expect: 背景消息和输入不应误触发审批按钮。
  2. 点击允许。
    - expect: 审批弹窗关闭。
    - expect: 对应工具卡片转为成功状态。
    - expect: assistant 回复展示已允许后的结果，busy 最终消失。
  3. 在新的 fresh context 重复发送 test:permission，点击拒绝。
    - expect: 审批弹窗关闭。
    - expect: 对应工具卡片转为拒绝/失败状态。
    - expect: assistant 回复明确说明命令被用户拒绝。
    - expect: 失败条件：allow/deny 结果反向、弹窗不关闭、审批结果路由到错误工具或错误实例。

#### 1.7. P0-07 ExitPlanMode 审批与权限档回落

**File:** `tests/p0/exit-plan-mode.spec.ts`

**Steps:**
  1. 起始状态/假设：fresh state。发送 test:exitplan。
    - expect: 权限档 pill 切换为计划模式。
    - expect: 出现 ExitPlanMode 工具卡/审批请求，审批内容显示计划文本。
    - expect: active status 显示正在运行 ExitPlanMode 或同义文案。
  2. 点击允许。
    - expect: 审批弹窗关闭。
    - expect: 状态从 ExitPlanMode 工具文案回落为思考中/执行中，不留下僵尸工具状态。
    - expect: 权限档 pill 最终回到默认审批。
    - expect: 失败条件：批准后仍显示计划模式、状态卡在 ExitPlanMode、工具结果丢失。

#### 1.8. P0-08 AskUserQuestion 多选弹窗

**File:** `tests/p0/ask-user-question.spec.ts`

**Steps:**
  1. 起始状态/假设：fresh state。发送 test:question。
    - expect: 出现“需要你选择”弹窗。
    - expect: 问题文本完整显示。
    - expect: 选项列表包含 main、dev、release-v1.0 三个候选或 mock 中的等价文案。
  2. 点击第二个选项 dev。
    - expect: 问题弹窗关闭。
    - expect: 工具卡片状态变为已回答。
    - expect: active status 立即回到思考中，不能停留在 AskUserQuestion 工具文案。
    - expect: assistant 回复包含所选选项。
    - expect: 失败条件：选项顺序错误、点击后弹窗不关、答案发往错误 requestId、重复显示同一问题。

#### 1.9. P0-09 设置面板：权限模式、模型选择、thinking effort 与 [1m] 后缀

**File:** `tests/p0/settings-model-permission-effort.spec.ts`

**Steps:**
  1. 起始状态/假设：fresh state。点击设置按钮打开配置面板。
    - expect: 底部设置面板可见，包含选择模型、权限控制等级、思考强度等级、访问与设备。
    - expect: 模型磁贴包含默认、Claude 3.5 Sonnet、Claude 3.5 Haiku、Claude 3 Opus、Claude 3 Opus (1m Context) 或 mock 等价项。
    - expect: 权限磁贴包含默认审批、计划模式、自动接受编辑、免打扰、Bypass。
    - expect: 支持 effort 的模型显示 low/medium/high 和模型默认。
  2. 选择计划模式，再选择 claude-3-opus[1m]，再选择 high effort。
    - expect: 底部 pill 与隐藏 select 状态同步更新。
    - expect: [1m] 后缀不被截断、不被当作非法模型名。
    - expect: 关闭设置后选择保留，并在下一条消息发送参数中可观测。
    - expect: 失败条件：特殊模型选择后显示空白、effort 对不支持模型仍强行显示、权限 pill 与设置面板不一致。

#### 1.10. P0-10 状态线、成本、模型与上下文信息

**File:** `tests/p0/statusline.spec.ts`

**Steps:**
  1. 起始状态/假设：fresh state。发送 test:statusline，等待完成后展开状态线详情。
    - expect: 状态线从简短摘要变为可展开详情。
    - expect: 摘要包含 token 量级、成本、耗时等信息。
    - expect: 详情包含 git 分支 feature/visual-testing、变更数、+120/-45、45,000 tokens、cache 45%、reused 1.2m、in/w/r 明细、repo、CLI 版本和 TTL 估算。
    - expect: 失败条件：状态线不可展开、详情缺字段、TTL 没有 est/估算语义、成本或耗时显示 NaN。

#### 1.11. P0-11 多工作区、多会话 tab、sidebar 与 history replay

**File:** `tests/p0/workspace-sessions-sidebar.spec.ts`

**Steps:**
  1. 起始状态/假设：fresh state。发送 test:tab。
    - expect: 出现第二个工作区/会话实例，例如 another-react-project / Another App Concurrency。
    - expect: 顶部或侧边栏可显示多个实例状态，不影响当前会话内容。
  2. 打开工作区与会话 sidebar，展开工作区列表，切换到第二个工作区/会话。
    - expect: sidebar 显示每个工作区、会话、新建会话入口和关闭会话入口。
    - expect: session:list 结果只显示当前 cwd 对应历史会话。
    - expect: 切换到第二个实例后通过 sync:since/history replay 显示该会话历史消息。
    - expect: sync:since 返回 gap 时清掉残缺回放并回退 session:history，不残留旧会话内容。
    - expect: 关闭当前待审批会话时切到剩余会话，旧会话消息和待审批状态不残留。
    - expect: 当前模型、权限档、effort 跟随实例切换。
    - expect: 失败条件：工作区历史串线、切换后仍显示旧实例 pending 弹窗、关闭一个实例误关另一个实例。

#### 1.12. P0-12 新会话首发 busy 连续性与不闪回首页

**File:** `tests/p0/new-session-first-send.spec.ts`

**Steps:**
  1. 起始状态/假设：fresh state。点击新会话按钮进入空首页/空会话，再立即发送 test:freshbusy。
    - expect: 首发后立刻显示 busy/思考状态。
    - expect: 服务端懒开实例广播期间 busy 不应被清掉。
    - expect: 在首个 delta 到达前不闪回 dashboard/首页空态。
    - expect: 最终显示新会话回复并回到空闲。
    - expect: 失败条件：busy 闪退、页面闪回首页、首条消息丢失、懒开实例后输入区不可用。

#### 1.13. P0-13 跨 tab 审批弹窗清理与错路由防护

**File:** `tests/p0/cross-tab-pending-cleanup.spec.ts`

**Steps:**
  1. 起始状态/假设：fresh state。发送 test:permCrossTab。
    - expect: 当前 inst_1 出现权限弹窗，后台 inst_2 同时存在。
    - expect: mock 自动切换 viewing 到 inst_2 后，inst_1 的权限弹窗应从当前视图清除。
  2. 尝试在 inst_2 当前视图继续发送或操作。
    - expect: 不会把 inst_1 的审批 allow/deny 发给 inst_2。
    - expect: sidebar/状态角标仍可提示后台实例有 pending，但当前视图不显示错误弹窗。
    - expect: 关闭后台 AskUserQuestion pending 会话后，旧问题弹窗和 requestId 不会在当前视图复活。
    - expect: 关闭后台 pending 会话后，即使服务端迟到发来旧 instanceId 的 tool/text/permission/question/result 事件，当前视图也不显示旧文本、旧审批或旧问题。
    - expect: 失败条件：跨 tab 弹窗残留、点击当前视图按钮解决了后台实例请求、旧 requestId 被错误复用。

#### 1.14. P0-14 pending snapshot 对账重建审批卡片

**File:** `tests/p0/pending-snapshot-reconcile.spec.ts`

**Steps:**
  1. 起始状态/假设：fresh state。发送 test:pendingsnapshot。
    - expect: 即使原始 permission_request 未回放，切入目标实例时 sync:since ack.pending 快照能重建审批弹窗。
    - expect: 弹窗显示 run_command、cwd 和 rm -rf /tmp/stale 等 mock 内容。
    - expect: sync:since 返回 gap 并回退 session:history 时，ack.pending 里的审批弹窗仍在视图稳定后重建。
    - expect: sync:since 返回 gap 并回退 session:history 时，ack.pending 里的 AskUserQuestion 选择弹窗仍在视图稳定后重建。
    - expect: 失败条件：只显示 sidebar 角标但会话内没有审批卡、重复创建多张同 requestId 卡、快照审批路由到错误实例。

#### 1.15. P0-15 设备信赖 TOFU、pending device request 与访问帮助

**File:** `tests/p0/device-tofu-requests-help.spec.ts`

**Steps:**
  1. 起始状态/假设：fresh state。发送 test:tofu。
    - expect: 出现等待授权 overlay。
    - expect: 显示本设备 ID，例如 unauthorized-fingerprint-999。
    - expect: 包含“没有其它已登录的设备？用命令授权”说明和 device.js approve 命令模板。
    - expect: 失败条件：未授权设备仍可操作聊天、设备 ID 不显示、帮助命令缺失。
  2. 起始状态/假设：fresh state。发送 test:devicerequests。
    - expect: 可信设备视角出现 pending device request 卡片栈。
    - expect: 每张卡显示设备 ID、IP、User-Agent，并提供准入/拒绝按钮。
    - expect: 从设置面板打开访问帮助，帮助说明 token、PWA/HTTPS、局域网审批与重连。
    - expect: 失败条件：请求卡遮挡核心输入且无法消除、准入/拒绝按钮缺失、访问帮助打不开或关闭不了。

#### 1.16. P0-16 交互日志 Console modal

**File:** `tests/p0/console-log-modal.spec.ts`

**Steps:**
  1. 起始状态/假设：fresh state。点击顶部 >_ 日志按钮。
    - expect: 出现交互日志 bottom sheet。
    - expect: 标题显示 Current Session Trace 或等价文案。
    - expect: 包含关闭与清屏按钮。
    - expect: 关闭后返回聊天界面，不丢当前消息/输入状态。
    - expect: 失败条件：日志 modal 打不开、关闭后遮罩残留、清屏误清聊天消息。

#### 1.17. P0-17 后台 task_progress 横幅原地刷新

**File:** `tests/p0/task-progress.spec.ts`

**Steps:**
  1. 起始状态/假设：fresh state。发送 test:taskprogress。
    - expect: 出现后台任务进度横幅。
    - expect: 横幅显示步骤 1/3、2/3、3/3 等进度文本。
  2. 等待进度心跳和完成通知。
    - expect: 同一横幅原地刷新，不堆叠多条。
    - expect: 旧步骤文本被覆盖，不拼接。
    - expect: task_notification completed 后横幅撤下。
    - expect: 失败条件：横幅多条堆叠、完成后不消失、当前会话 busy 与后台任务状态互相污染。

#### 1.18. P0-18 文件/图片上传、附件 chip 与前端边界

**File:** `tests/p0/attachments-ui.spec.ts`

**Steps:**
  1. 起始状态/假设：fresh state。点击附件按钮，上传一个小文本文件和一张小图片。
    - expect: 附件托盘出现两个 chip。
    - expect: 文本文件显示文件名/大小/通用附件样式。
    - expect: 图片显示缩略图或图片 chip，不破坏输入区布局。
    - expect: 发送后 user_message 可见附件元数据，附件托盘清空。
  2. 分别尝试 11 个附件、单文件超过 10MB、总量超过 20MB、重复选择同一文件、无扩展名文件。
    - expect: 超过数量/大小/总量时给出用户可见错误，不发送超限附件。
    - expect: 重复选择同一文件仍可触发 onchange。
    - expect: 未知类型按 application/octet-stream 或通用附件处理。
    - expect: 失败条件：超限仍加入托盘、错误只在 console、图片缩略图导致页面卡死、附件发送后残留。

#### 1.19. P0-19 空状态、恢复与移动端响应式/PWA 外壳

**File:** `tests/p0/empty-restore-responsive.spec.ts`

**Steps:**
  1. 起始状态/假设：fresh state。发送 test:empty。
    - expect: 页面进入空首页/空会话状态。
    - expect: 工作区与新会话入口仍可用。
    - expect: 输入框仍可发送恢复命令或普通首条消息。
  2. 在 iPhone 宽度、较窄宽度和横屏宽度下检查首屏、sidebar、settings、permission sheet、输入区。
    - expect: 无水平滚动、底部 safe-area 不遮挡、modal/sheet 不被裁切。
    - expect: PWA manifest、图标和本地 vendor 资源可加载。
    - expect: 失败条件：移动端输入区被键盘/安全区遮住、sidebar 超出视口、sheet 内容无法滚动到关闭按钮。

#### 1.20. P0-20 安全与鉴权可观测 UI 行为

**File:** `tests/p0/security-observable-ui.spec.ts`

**Steps:**
  1. 起始状态/假设：fresh context。以 URL hash #token=mock-token 打开页面。
    - expect: token 被存入 localStorage 后地址栏 hash 被清理。
    - expect: 之后连接使用 token，但页面不明文泄露完整 token。
    - expect: 鉴权失败时显示令牌输入页和访问帮助入口。
  2. 通过 mock 或拦截 Socket.IO connect_error 模拟 invalid token / unauthorized。
    - expect: 显示需要重新登录或令牌无效状态。
    - expect: 不展示 sessionId、history、busy 等敏感运行状态。
    - expect: 失败条件：完整 token 出现在 DOM/日志、未授权仍可读历史或发送消息。

### 2. P1 协议/集成回归

**Seed:** `tests/seed.integration-server.spec.ts`

#### 2.1. P1-01 Socket.IO agent:event / user:* 契约

**File:** `tests/p1/socket-contract-events.spec.ts`

**Steps:**
  1. 起始状态/假设：fresh server，使用 socket.io-client 连接测试端口，记录 agent:event envelope。
    - expect: 连接后收到 init、models、permission_mode、effort_mode、instances、status_line 等合成事件。
    - expect: 合成事件遵守 epoch=server、seq=0、sessionId=null 或约定值。
    - expect: 实例归属事件带 instanceId，前端可据此做错路由过滤。
    - expect: 失败条件：事件缺 type/payload、seq/epoch 不可用于去重、无 instanceId 的实例事件污染当前视图。
  2. 发送 user:message、user:interrupt、user:setPermissionMode、user:setEffort、user:setViewing。
    - expect: 服务端 ack 或广播与请求实例一致。
    - expect: 无效 mode/level/instanceId 被拒绝或无副作用。
    - expect: 客户端可从公共事件判断状态变化，不需要导入业务模块。

#### 2.2. P1-02 session:list / session:switch / session:history / session:close

**File:** `tests/p1/session-list-switch-history-close.spec.ts`

**Steps:**
  1. 起始状态/假设：用临时 workdir 和 mock JSONL 历史夹具启动真实 server；不运行真实 Claude turn。
    - expect: session:list 按 cwd 返回历史会话，不跨 cwd 泄漏。
    - expect: 非法 sessionId、路径穿越 sessionId、不存在 sessionId 返回错误。
    - expect: session:history 只通过鉴权 socket 返回，不暴露无鉴权 HTTP 历史端点。
  2. 切换到有效历史会话，再关闭 live instance。
    - expect: session:switch 返回 ok 和 instanceId。
    - expect: instances 广播更新当前 viewingInstanceId。
    - expect: session:close 只 dispose 目标实例，不删除历史记录，不影响其它实例。
    - expect: 失败条件：同一 session 被开两个 live resume 实例、关闭一个实例误杀其它 cwd、history 未鉴权可读。

#### 2.3. P1-03 多工作区隔离与 session:list 历史边界

**File:** `tests/p1/multi-workdir-isolation.spec.ts`

**Steps:**
  1. 起始状态/假设：配置两个白名单 workdir，各自放置不同 marker 会话历史。
    - expect: instances.dirs 包含两个白名单目录。
    - expect: 切换 cwd 后 session:list 只返回该 cwd marker。
    - expect: 非白名单 cwd 请求被拒绝并拨回当前合法 cwd。
  2. 并发打开 dirA 与 dirB live instance，并分别发送消息/关闭。
    - expect: 两个 instanceId 并存，状态按 cwd 聚合。
    - expect: A 的事件不渲染到 B，B 的 pending 不弹到 A。
    - expect: 失败条件：cwd 串线、session:list 把 CLI/live 状态当作历史、一个目录的默认模型污染另一个目录。

#### 2.4. P1-04 附件落盘、路径注入与安全校验

**File:** `tests/p1/upload-server-security.spec.ts`

**Steps:**
  1. 起始状态/假设：临时 workdir，调用用户可见上传流程或 Socket.IO user:message attachments。
    - expect: 合法附件落到 WORK_DIR/.ccm-uploads/。
    - expect: 文件权限 owner-only，文件名去路径分隔、控制字符、前导点。
    - expect: prompt 末尾追加 [附件] 路径块，user_message 事件只回显 name/mimeType/size/thumb，不泄 absPath。
  2. 提交路径穿越文件名、symlink 上传目录、缺 data/name/mimeType、超限附件。
    - expect: 服务端拒绝非法输入并返回用户可见错误。
    - expect: 绝不写出 .ccm-uploads 之外。
    - expect: 失败条件：base64 超限导致 server 崩溃、路径穿越成功、附件 absPath 泄漏到前端历史缓冲。

#### 2.5. P1-05 AUTH_TOKEN、Cloudflare Access 与设备信赖协议

**File:** `tests/p1/auth-device-access.spec.ts`

**Steps:**
  1. 起始状态/假设：分别以 AUTH_TOKEN 启用/禁用启动 server，使用 HTTP /health 与 Socket.IO 握手测试。
    - expect: 启用 AUTH_TOKEN 时，无 token/错 token 的 HTTP 与 Socket.IO 被拒绝。
    - expect: 正确 token 可访问 /health 和 socket。
    - expect: token 可通过 query 或 x-auth-token 用于 HTTP，本地/公网策略符合配置。
  2. 模拟 deviceToken 未信任、pending、approved、denied 以及 trusted device 审批其它设备。
    - expect: 未信任设备收到 device_status pending 且不能操作敏感聊天。
    - expect: 可信设备收到 pending_devices，可 approve/deny 真实 pending token。
    - expect: denied 设备显示被拒页并可重新请求。
    - expect: 失败条件：任意 token 可被预置信任、未授权设备可读历史、Cloudflare Access 公网 fail-open。

#### 2.6. P1-06 sync:since、断线重连、bfcache 与 pending 对账

**File:** `tests/p1/sync-reconnect-bfcache.spec.ts`

**Steps:**
  1. 起始状态/假设：mock 或真实 server 支持 sync:since；在消息流中断开 socket，再恢复网络/前后台。
    - expect: 客户端不等待 socket.io 长心跳超时，主动 probe 或重连。
    - expect: 重连后 sync:since 按 epoch/seq 补齐断线期间事件。
    - expect: pending permissions/questions 通过 ack.pending 对账重建。
  2. 模拟半开连接、bfcache pageshow、旧 epoch、新 epoch、环形缓冲 trim。
    - expect: 不会重复渲染已见事件。
    - expect: 缓冲缺失时回落 session:history 或全量重放。
    - expect: 失败条件：重连后空屏、重复消息、pending 丢失、旧实例事件污染当前实例。

### 3. P2 真实 Claude / 生产 Smoke（低频显式 opt-in）

**Seed:** `tests/seed.real-opt-in.spec.ts`

#### 3.1. P2-01 真实 Claude 基础回合 smoke

**File:** `tests/p2/real-claude-smoke.spec.ts`

**Steps:**
  1. 起始状态/假设：仅在人工显式设置 RUN_CLAUDE_INTEGRATION=1 时运行；备份 data/sessions.json；使用临时 WORK_DIR；确认会消耗 token。
    - expect: server 使用真实 claude CLI/SDK 成功启动。
    - expect: 发送简单提示后收到真实流式回复、result、模型、成本/耗时。
    - expect: 关闭 server 后无遗留 Claude 子进程。
    - expect: 失败条件：测试默认在 CI/日常回归运行、真实 token 被误耗、子进程泄漏。

#### 3.2. P2-02 真实工具审批与权限档 smoke

**File:** `tests/p2/real-permission-tool-smoke.spec.ts`

**Steps:**
  1. 起始状态/假设：opt-in；临时 git/workdir；权限档 default/plan/acceptEdits 分别测试只读或低风险工具。
    - expect: 敏感工具触发 permission_request。
    - expect: allow/deny 能回传真实 Claude SDK，工具结果与 UI 卡片一致。
    - expect: plan 模式不执行写入，ExitPlanMode 路径可批准并回落权限档。
    - expect: 失败条件：plan 模式实际写盘、deny 后仍执行命令、权限档 UI 与后端模式不一致。

#### 3.3. P2-03 常驻服务、PWA HTTPS 与生产访问 smoke

**File:** `tests/p2/production-launchagent-smoke.spec.ts`

**Steps:**
  1. 起始状态/假设：人工维护窗口；不得手动 npm start 抢 3000；通过 LaunchAgent/systemd 重启常驻服务；使用固定域名/Cloudflare Access 2FA。
    - expect: 生产 URL 可通过 HTTPS 打开并安装/使用 PWA。
    - expect: AUTH_TOKEN 与 Cloudflare Access 策略按公网/LAN 边界生效。
    - expect: 移动端前后台切换、息屏恢复后可重连并 sync 补齐。
    - expect: 失败条件：端口冲突、生产未启鉴权、随机 trycloudflare URL 被当作稳定入口、重启后会话指针损坏。

#### 3.4. P2-04 WebUI/CLI 会话生命周期与共享工作区风险 smoke

**File:** `tests/p2/live-session-lifecycle-smoke.spec.ts`

**Steps:**
  1. 起始状态/假设：opt-in；同一 cwd 分别打开 WebUI 会话和独立 CLI 会话，只做只读提示。
    - expect: 不同 sessionId/instanceId 的对话历史不互相污染。
    - expect: 同 cwd 共享文件系统风险通过 UI 或文档明确。
    - expect: 浏览器 tab 关闭只断开前端 socket，不应被误判为自动结束后端 Claude；显式 session:close 才 dispose WebUI 实例。
    - expect: 失败条件：session:list 被当作 live CLI 状态、关闭浏览器误杀或误留不受控进程、同 cwd 历史串线。
