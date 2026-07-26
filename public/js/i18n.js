// i18n.js —— 运行时词典（无构建步骤：zh 原文即 key，恒等设计）。
// t() 在 zh locale（默认）下原样返回中文——零开销，且不影响任何既有断言中文文案的测试（单测/E2E 除
// 一个 en spec 外全部固定跑 zh）。en locale 下查字典，未收录的 key 静默回落中文原文，不是"未翻译就报错"。
// 语言选择持久化 localStorage；切换后提示用户手动刷新生效（不做响应式重渲，保持极简）。
//
// 覆盖分两条路径，缺一不可：
//   · index.html 静态外壳 —— 启动时 applyI18nToDocument 整树扫描（文本节点 + I18N_ATTRS 属性）。
//     不逐句标 data-i18n：漏标是隐性 bug（那句永远不翻且看不出来），整树扫描则"进词典即生效"。
//   · app.js / logic.js / app/*.js 的运行时模板 —— 各自包 t()，因为它们在扫描之后才生成 DOM。
//
// 两个反复踩到的坑，加词条前先看一眼：
//   1. 模块顶层常量表里不能直接 t()：那在 import 阶段就求值，早于 app.js 的 setLang()，语言会被钉死在
//      zh。表里存中文原文、到取用点才 t()（见 logic.js STATUS_ICON_LABELS、git-changes.js SECTION_META）。
//   2. 局部变量别叫 t：会静默遮蔽成 "t is not a function"，而 ESLint 看不出问题（t 确实有定义）。
export const LANG_STORAGE_KEY = 'ccm_lang';

// 译文用语对齐 Claude Code CLI（permission mode / workspace / interrupt / resume 等），让从 CLI 切过来的
// 人零认知成本。scripts/i18n-check.js 扫 index.html 的界面文案与全仓 t('...') 调用，报词典里的孤儿 key。
//
// 注意混排句：`令牌在服务器 <code>.env</code> 的 <code>AUTH_TOKEN</code> 或启动日志里。` 会被 DOM 切成
// 好几个文本节点，词典 key 因此是「的」「或启动日志里。」这样的碎片。译文按英文语序分配到各碎片上，
// 拼起来才成句——改这类句子必须整句一起改，单看一条 key 是读不出上下文的。
export const EN_DICT = Object.freeze({
  // —— 访问令牌页 / Access 重登 ——
  '需要访问令牌才能连接到这台机器。': 'You need an access token to connect to this machine.',
  '若你刚清过浏览器数据，原先保存的令牌已被清除，重输一次即可。': 'If you just cleared your browser data, the saved token is gone — enter it once more.',
  '访问令牌': 'Access token',
  '粘贴 AUTH_TOKEN': 'Paste AUTH_TOKEN',
  '进入': 'Enter',
  '令牌仅存于本机浏览器（localStorage），不上传。也可用': 'The token is stored only in this browser (localStorage), never uploaded. You can also go straight in with',
  '#token=值': '#token=VALUE',
  '直接进入。令牌在服务器': '. Find the token in',
  '的': 'as',
  '或启动日志里。': 'on the server, or in the startup log.',
  '不知道令牌？查看帮助': "Don't know the token? Get help",
  '会话已过期': 'Session expired',
  '登录态已失效，请重新通过验证后继续。': 'Your login is no longer valid. Re-authenticate to continue.',
  '重新登录': 'Log in again',

  // —— 顶部状态条 ——
  '新聊天': 'New chat',
  '未连接': 'Disconnected',
  '查看工作区、会话列表和后台状态': 'Workspaces, session list, and background status',
  '连接状态：绿=已连接 红=断开': 'Connection: green = connected, red = disconnected',
  '手机到主机的往返延迟': 'Round-trip latency from phone to host',
  '工作区：浏览或查看改动': 'Workspace: browse files or view changes',
  '回首页（最近工作区与会话）': 'Home (recent workspaces and sessions)',
  '回首页': 'Home',
  '查看当前会话运行日志': "View this session's run log",
  '查看会话日志': 'View session log',
  '创建新会话': 'New session',
  '工作区与会话': 'Workspaces & sessions',
  '定位到未读消息': 'Jump to unread messages',
  '条未读 ↑': 'unread ↑',

  // —— 权限审批弹窗 ——
  '⚠️ 权限请求': '⚠️ Permission request',
  '权限请求': 'Permission request',
  '⚠️ 完整性预检异常：展示内容与服务端锚定的指纹不符，请谨慎确认后再操作': "⚠️ Integrity precheck failed: what's shown doesn't match the fingerprint anchored on the server. Confirm with care.",
  '本会话内总是允许此类操作': 'Always allow this kind of action in this session',
  '退出计划后权限档（对齐 CLI）': 'Permission mode after exiting plan (matches CLI)',
  '拒绝': 'Deny',
  '允许': 'Allow',
  '中止本轮': 'Interrupt turn',

  // —— AskUserQuestion 弹窗 ——
  '❓ 需要你选择': '❓ Needs your choice',
  '需要你选择': 'Needs your choice',
  '可多选，选完点下方「确认选择」': 'Multiple choices allowed — tap "Confirm selection" below when done',
  '确认选择': 'Confirm selection',
  '其他…': 'Other…',
  '输入你的答案': 'Type your answer',
  '提交其他答案': 'Submit other answer',
  '跳过并中止本轮': 'Skip and interrupt turn',
  '可点选项、多选确认、填「其他」，或跳过中止本轮': 'Tap an option, confirm a multi-select, fill in "Other", or skip to interrupt the turn',

  // —— 删除会话 / 通用确认 ——
  '🗑 删除会话': '🗑 Delete session',
  '从列表移除': 'Remove from list',
  '仅从本产品隐藏；主机上的完整记录保留，可从终端': 'Hides it from this app only; the full transcript stays on the host. Run',
  '找回。': 'in the terminal to recover it.',
  '彻底删除（含底层文件）': 'Delete permanently (including files on disk)',
  '真删主机上的会话记录文件，': 'Really deletes the transcript file on the host —',
  '不可恢复': 'cannot be undone',
  '；点击后需再次确认。': '. You will be asked to confirm again.',
  '取消': 'Cancel',
  '确定': 'Confirm',
  '确认操作': 'Confirm action',

  // —— 运行日志抽屉 ——
  '交互日志': 'Interaction log',
  '关闭': 'Close',
  '全部': 'All',
  '交互': 'Interaction',
  '诊断': 'Diagnostics',
  '最多存 500 条，落盘本机、重开恢复': 'Keeps up to 500 entries, stored on this device, restored on reopen',
  '复制': 'Copy',
  '清屏': 'Clear',

  // —— 文件浏览 / 工作区改动 ——
  '返回上一级': 'Back',
  '编辑': 'Edit',
  '保存': 'Save',
  '（空目录）': '(empty directory)',
  '加载中…': 'Loading…',
  '工作区': 'Workspace',
  '浏览项目文件': 'Browse project files',
  '只读目录树与文件内容': 'Read-only file tree and contents',
  '工作区改动': 'Workspace changes',
  '查看 git staged / unstaged / untracked': 'View git staged / unstaged / untracked',
  '刷新': 'Refresh',
  '📊 服务状态': '📊 Service status',
  '服务状态': 'Service status',
  '关闭服务状态': 'Close service status',
  '附件预览': 'Attachment preview',
  '关闭预览': 'Close preview',

  // —— 输入区（隐藏 select 的选项也一并翻，切换时会回写 pill）——
  '模型默认': 'Model default',
  '不指定（沿用当前）': 'Unspecified (keep current)',
  '默认（白名单外弹窗审批）': 'Default (prompt for anything outside the allowlist)',
  '计划模式（只规划、不执行）': 'Plan mode (plan only, never execute)',
  '自动接受编辑（命令仍审批）': 'Accept edits (commands still need approval)',
  '免打扰（白名单外直接拒、不弹窗）': 'Deny silently (reject outside the allowlist, no prompt)',
  'Auto（LLM 自动判批/拒权限）': 'Auto (LLM approves or denies permissions)',
  '⚠️ bypass（跳过所有审批）': '⚠️ bypass (skip all approvals)',
  '（模型默认）': '(model default)',
  '后台任务': 'Background task',
  '展开/收起任务列表': 'Expand/collapse task list',
  '停止该后台任务': 'Stop this background task',
  '停止': 'Stop',
  '刷新消息': 'Refresh messages',
  '续接 CLI 会话': 'Resume CLI session',
  '给 Claude 发消息...': 'Message Claude...',
  '默认': 'Default',
  '默认审批': 'Default',
  '思考默认': 'Thinking: default',
  '权限模式': 'Permission mode',
  '思考强度': 'Thinking effort',
  '添加附件': 'Add attachment',
  '接收推送通知': 'Enable push notifications',
  '打开设置面板': 'Open settings',
  '发送': 'Send',

  // —— 设备授权 / 访问帮助 ——
  '🔒 等待授权': '🔒 Waiting for approval',
  '这是一台新设备。在你': 'This is a new device. On',
  '另一台已登录的设备': "another device you're already signed in on",
  '上会弹出「新设备请求接入」，点一下「准入」即可——': ', a "New device requesting access" prompt will appear. Just tap "Approve" —',
  '无需上电脑终端': 'no computer terminal needed',
  '。': '.',
  '本设备 ID': 'This device ID',
  '没有其它已登录的设备？用命令授权 ▾': 'No other signed-in device? Approve by command ▾',
  '在主机终端按': 'In the host terminal, press',
  '回车键': 'Enter',
  '一键同意最新设备，或执行：': 'to approve the latest device, or run:',
  '设备未获授权': 'Device not authorized',
  '机主已拒绝此设备接入。若是误操作，可重新发起请求，由你已登录的可信设备或主机终端批准。': 'The owner denied this device. If that was a mistake, request access again and approve it from a trusted signed-in device or the host terminal.',
  '重新请求接入': 'Request access again',
  '查看访问帮助': 'View access help',
  '如何连接与使用': 'How to connect and use',
  '📱 在手机上连接': '📱 Connecting from your phone',
  '打开': 'Open',
  'https://你的域名/#token=令牌': 'https://your-domain/#token=TOKEN',
  '。令牌进入后存在本机浏览器，之后免带；装到主屏当 App 用更顺手。': '. Once entered, the token stays in this browser so you never carry it again. Add it to your home screen to use it like an app.',
  '🔑 访问令牌在哪': '🔑 Where the access token is',
  '在服务器': 'On the server, in',
  '，或服务启动日志里的入口 URL。': ', or in the entry URL printed at startup.',
  '清除浏览器数据会一并清掉它': 'Clearing browser data wipes it too',
  '，届时重输一次即可。': ', so just enter it again when that happens.',
  '🆕 新设备怎么获批': '🆕 How a new device gets approved',
  '走公网域名（隧道）通常': 'Over a public domain (tunnel) you usually',
  '无需审批': 'need no approval',
  '，贴上令牌即用。仅当你': ', so just paste the token. Approval is only required when you',
  '直连局域网 IP': 'connect straight to a LAN IP',
  '时才需审批：你已登录的设备会弹「新设备请求接入」，点「准入」即可——': ': a signed-in device shows "New device requesting access" — just tap "Approve",',
  '。兜底命令：': '. Fallback command:',
  '🔄 连不上怎么办': "🔄 If you can't connect",
  '多半是令牌被清——重输即可。切后台/息屏断开会在回到前台时自动重连，无需手动刷新。': 'Most often the token was cleared — just enter it again. Disconnects from backgrounding or screen-off reconnect on their own when you come back; no manual refresh needed.',

  // —— 配置面板 ——
  '⚙️ 配置面板': '⚙️ Settings',
  '下拉或点外侧关闭': 'Pull down or tap outside to close',
  '下拉关闭配置面板': 'Pull down to close settings',
  '重读 CLI 配置': 'Reload CLI config',
  '选择模型': 'Select model',
  '(切换下一条消息起效)': '(applies from your next message)',
  '🛡️ 权限控制等级': '🛡️ Permission mode',
  '敏感操作弹窗确认': 'Prompts before sensitive actions',
  '计划模式': 'Plan mode',
  '只读预览不执行修改': 'Read-only preview, changes nothing',
  '自动接受编辑': 'Accept edits',
  '文件修改直通，命令审批': 'File edits go through, commands still approved',
  '免打扰': 'Deny silently',
  '白名单外直接拒、不弹窗': 'Rejects outside the allowlist, no prompt',
  'LLM 自动判批/拒权限': 'LLM approves or denies permissions',
  '免审飞控（高危）': 'No approvals at all (dangerous)',
  '🧠 思考强度等级': '🧠 Thinking effort',
  '完成提示': 'Completion alerts',
  '(默认开，可关)': '(on by default)',
  '提示音': 'Sound',
  '模型说完 / 需要你审批或回答时短响一声': 'A short chime when the model finishes, or needs your approval or answer',
  '震动': 'Vibration',
  '完成/出错/需要你时震动（Android 有效）': "Vibrates on completion, error, or when you're needed (Android only)",
  '前台也弹系统通知': 'System notification in foreground too',
  '页面开着时轮次完成也弹一条（默认只在后台弹）': 'Also notify when a turn finishes while the page is open (default: background only)',
  '▶ 试听提示音 / 试震一下': '▶ Preview sound / test vibration',
  '推送内容': 'Push content',
  '(默认关，可开)': '(off by default)',
  '推送带内容预览': 'Include content preview in push',
  '锁屏通知带问题/工具/任务摘要（而非仅提示"有新消息"）；ntfy 通道不受此开关影响，恒最小化': 'Lock-screen notifications carry a question / tool / task summary instead of just "new message". The ntfy channel ignores this switch and always stays minimal.',
  '语言': 'Language',
  '跟随浏览器 / Auto-detect': 'Auto-detect',
  '切换后请刷新页面生效。': 'Refresh the page for the switch to take effect.',
  '访问与设备': 'Access & devices',
  '当前会话': 'Current session',
  '点按复制完整 session id': 'Tap to copy the full session id',
  '新设备怎么批 · 令牌在哪 · 连不上怎么办 →': 'Approving devices · where the token is · connection help →',
  '🔍 安全体检 · 公网暴露前自查 →': '🔍 Security check · self-audit before going public →',
  '📊 服务状态 · 运行时长 / 版本 / 告警 →': '📊 Service status · uptime / version / alerts →',
  'GitHub 仓库 · 源码 / Issue / Star →': 'GitHub repo · source / issues / star →',
  '在浏览器打开 GitHub 仓库': 'Open the GitHub repo in your browser',
  '🛠 开发者': '🛠 Developer',
  '⟳ 重启服务（改代码/.env 后生效）': '⟳ Restart server (applies code/.env changes)',

  // —— 连接 / 令牌 / 离线队列 ——
  '已连接': 'Connected',
  '连接断开，自动重连中…': 'Disconnected, reconnecting…',
  '需要访问令牌': 'Access token required',
  '令牌无效，请重新输入': 'Invalid token — enter it again',
  '需要重新登录': 'Sign-in required',
  '连接失败：': 'Connection failed: ',
  '请输入访问令牌': 'Enter the access token',
  '连接中…': 'Connecting…',
  '正在重发离线发送队列中的': 'Resending',
  '条消息...': 'queued offline messages...',
  '🕐 正在发送...': '🕐 Sending...',
  '🕐 未确认送达，等待重连重试...': '🕐 Delivery unconfirmed — will retry after reconnect...',
  '🕐 正在等待连接...': '🕐 Waiting for a connection...',
  '发送失败': 'Send failed',
  '，已停止重试': ' — stopped retrying',
  '网络未连接，请等待重新连接后再操作': 'Not connected — wait for the reconnect before acting',
  '延迟': 'latency',
  '手机到主机往返延迟': 'Round-trip latency from phone to host',

  // —— 安全体检 / 服务状态 / 开发者重启 ——
  '体检失败或无响应': 'Check failed or no response',
  '🔍 体检中…': '🔍 Checking…',
  '基础': 'Basics',
  '异常告警': 'Alerts',
  '✓ 无异常': '✓ All clear',
  '数据每 5 秒自动刷新 · 告警超 24 小时自动退场 · 原始计数见 /metrics': 'Refreshes every 5s · alerts expire after 24h · raw counters at /metrics',
  '已复制 session id：': 'Copied session id: ',
  '个会话在运行/待审批，重启会中断它们（含后台任务）。': 'session(s) running or awaiting approval will be interrupted by the restart (including background tasks).',
  '⟳ 重启常驻 server？': '⟳ Restart the resident server?',
  '服务将优雅退出并由 KeepAlive 自动拉起，页面会自动重连。': 'The service will exit gracefully, KeepAlive will bring it back, and this page reconnects on its own.',
  '重启': 'Restart',
  '⟳ 正在重启服务…页面将自动重连': '⟳ Restarting the service… this page will reconnect automatically',
  '重启被拒：': 'Restart refused: ',
  '未知': 'unknown',
  '未知原因': 'unknown reason',
  '未知错误': 'unknown error',
  '未知结果': 'unknown outcome',
  '运行时长': 'Uptime',
  '启动于': 'Started',
  '版本': 'Version',
  '连接': 'Connection',
  '开': 'on',
  '关': 'off',
  '日志开关': 'Log switches',
  'SDK 调试': 'SDK debug',
  '(无错误信息)': '(no error message)',

  // —— 设备审批 ——
  '🔔 新设备请求接入': '🔔 New device requesting access',
  '✓ 准入': '✓ Approve',
  '✕ 拒绝': '✕ Deny',

  // —— 顶栏 / 会话标题 ——
  '聊天': 'Chat',
  '新会话': 'New session',
  '新建会话': 'New session',
  '新会话（未保存）': 'New session (unsaved)',
  '无标题会话': 'Untitled session',
  '时间未知': 'time unknown',
  '进入 ➔': 'Open ➔',
  ' · 已打开': ' · open',
  ' · 使用中': ' · in use',
  '其他工作区': 'Other workspaces',
  '模型': 'Model',
  '需要你': 'Needs you',
  '服务告警': 'Service alert',
  '服务告警（推送失败等）': 'Service alert (delivery failures, etc.)',

  // —— 消息流 / 工具卡 / 思考 ——
  '工具执行已因本轮错误停止': 'Tool execution stopped by an error this turn',
  '撤回': 'Withdraw',
  '撤回失败，请重试': 'Withdraw failed — try again',
  '已随停止取消，未发送': 'Cancelled with the stop — not sent',
  '已撤回，未发送': 'Withdrawn — not sent',
  '进行中': 'In progress',
  '预览': 'Preview',
  '预览不可用': 'Preview unavailable',
  '点击预览': 'Tap to preview',
  ' …（已截断）': ' …(truncated)',
  '\n…（已截断）': '\n…(truncated)',
  '…（已截断）': '…(truncated)',
  '展开全文': 'Show full text',
  '全文不可用': 'Full text unavailable',
  '💭 思考过程': '💭 Thinking',
  '无 diff 详情（可到对应工具卡查看）': 'No diff details (see the matching tool card)',
  '…显示全部': '…Show all',
  '字符': 'chars',
  '以下为新消息': 'New messages below',
  '—— 本次会话 ——': '—— This session ——',
  '复制代码': 'Copy code',
  '复制消息': 'Copy message',
  '已复制': 'Copied',
  '复制失败': 'Copy failed',
  '失败': 'Failed',
  '改写后重发': 'Edit and resend',
  '改写重发': 'Edit & resend',
  '语音朗读': 'Read aloud',
  '朗读': 'Read aloud',
  '此设备不支持语音朗读': 'This device doesn\'t support speech',
  '展开': 'Expand',
  '收起': 'Collapse',
  '正在加载会话...': 'Loading session...',
  '历史消息加载失败': 'Could not load history',
  '加载了': 'Loaded',
  '条历史消息': 'messages from history',
  '子 agent': 'subagent',
  '📄 预览文件': '📄 Preview file',
  '📄 预览变更': '📄 Preview changes',
  '已编辑': 'Edited',
  '个文件': 'file(s)',
  '（无任务）': '(no tasks)',
  '（被': '(blocked by',
  ' 阻塞）': ')',
  '☐ 已建任务': '☐ Created task',
  '更新失败：': 'Update failed: ',
  '已更新': 'updated',

  // —— 权限审批 / 提问 ——
  '⚠️ 等待审批': '⚠️ Awaiting approval',
  '❓ 需要选择': '❓ Needs a choice',
  '⚠️ 完整性校验未通过，该操作已被服务端拒绝执行（并非您的选择生效）': '⚠️ Integrity check failed — the server refused to run this action (your choice was not what applied)',
  '工作目录：': 'Working directory: ',
  '✅ 已允许：': '✅ Allowed: ',
  '🚫 已拒绝：': '🚫 Denied: ',
  '查看预览': 'Show preview',
  '收起预览': 'Hide preview',
  '已选择：': 'Selected: ',
  '请至少选择一项': 'Select at least one option',
  '、': ', ',
  '请先输入其他答案': 'Type your other answer first',
  '已回答（其他）：': 'Answered (other): ',
  '已跳过提问（中止本轮）': 'Question skipped (turn interrupted)',
  '已请求中止本轮': 'Interrupt requested',

  // —— 发送 / 排队 / 停止 ——
  '请先完成设备授权或解除只读状态，再发送新消息': 'Finish device approval or leave read-only mode before sending',
  '请先完成设备授权或解除只读状态': 'Finish device approval or leave read-only mode first',
  '请先处理当前审批或选择，再发送新消息': 'Handle the pending approval or choice before sending',
  '请先处理当前审批或选择': 'Handle the pending approval or choice first',
  'ultracode 档需要先输入任务再发送': 'ultracode needs a task typed in before sending',
  '消息过长': 'Message too long',
  '，未发送': ' — not sent',
  '⚡ 命令：': '⚡ Command: ',
  '前面已有消息在排队，请等当前任务结束': 'A message is already queued — wait for the current task to finish',
  '⏳ 排队中 · 本轮结束后发送': '⏳ Queued · sends when this turn ends',
  '正在发送…': 'Sending…',
  '正在停止…': 'Stopping…',
  '正在停止': 'Stopping',
  '请稍候…': 'Please wait…',
  'Claude 正在执行任务...': 'Claude is working...',
  '没有可中断的任务': 'Nothing to interrupt',
  '停止请求超时，可再试一次': 'Stop request timed out — try again',
  '目标会话已关闭，请刷新后重发': 'The target session is closed — refresh and send again',
  '发送失败：': 'Send failed: ',
  '未确认送达': 'Delivery unconfirmed',

  // —— 模型 / 权限档 / 思考强度 ——
  '当前加载模型': 'Currently loaded model',
  '终端驾驶中，设置已冻结——接管后可调': 'Terminal is driving — settings are frozen until you take over',
  '模型 →': 'Model →',
  '模型已重置为默认（下一条消息生效）': 'Model reset to default (applies from your next message)',
  '手动设置': 'manual',
  '模型已设为': 'Model set to',
  '（下一条消息生效）': ' (applies from your next message)',
  '当前模型：': 'Current model: ',
  '；下一条消息起：': '; from your next message: ',
  '；可选：': '; available: ',
  '默认模型': 'Default model',
  '沿用当前模型': 'Keep current model',
  '不指定特定模型': 'No specific model',
  '（当前模型不可选）': ' (not available for the current model)',
  '权限档 →': 'Permission mode →',
  '免打扰（白名单外直接拒）': 'Deny silently (reject outside the allowlist)',
  '⚠️ 切到 bypass（跳过所有审批）': '⚠️ Switch to bypass (skip all approvals)',
  'claude 将无需确认即可改文件、跑命令；一次提示注入即可波及整台机器。': 'claude will edit files and run commands without asking — a single prompt injection can reach the whole machine.',
  '开启 bypass': 'Enable bypass',
  '思考强度 →': 'Thinking effort →',
  '默认思考': 'Thinking: default',
  '更快更省': 'Faster and cheaper',
  '均衡': 'Balanced',
  '更深入': 'Deeper',
  '很深入更慢': 'Much deeper, slower',
  '最深入更慢更贵': 'Deepest, slowest, priciest',
  'xhigh + 多 agent · 最彻底': 'xhigh + multi-agent · most thorough',
  'xhigh + 多 agent workflow · 最彻底': 'xhigh + multi-agent workflow · most thorough',
  'ultracode：xhigh + 多 agent workflow（更彻底，更慢更费额度）': 'ultracode: xhigh + multi-agent workflow (more thorough, slower, more usage)',
  '正在切换思考强度并续接会话…': 'Switching thinking effort and resuming the session…',
  '使用工作区默认配置': 'Uses the workspace defaults',
  '无项目': 'No project',

  // —— statusline / CLI 侧状态 ——
  'CLI 状态暂不可用': 'CLI status unavailable',
  '(账号级旧值，非实时)': '(account-level stale value, not live)',
  'statusline · CLI 暂不可用（额度沿用旧值）': 'statusline · CLI unavailable (usage shows stale values)',
  'statusline · CLI 暂不可用': 'statusline · CLI unavailable',
  'CLI 当前模式未知': 'Current CLI mode unknown',
  'CLI 模式未知': 'CLI mode unknown',
  'CLI 当前模型': 'Current CLI model',
  'CLI 模型未知': 'CLI model unknown',
  'CLI 当前模型未知': 'Current CLI model unknown',
  'CLI 档位未知': 'CLI level unknown',
  'CLI 当前档未知': 'Current CLI level unknown',

  // —— 后台任务 ——
  '⚠️ 后台需要审批': '⚠️ Background task needs approval',
  '⚠️ 后台任务出错': '⚠️ Background task failed',
  '✅ 后台任务完成': '✅ Background task done',
  '🔔 后台任务失败': '🔔 Background task failed',
  '🔔 后台任务完成': '🔔 Background task done',
  '🔔 后台任务完成，Claude 正在汇报结果…': '🔔 Background task done — Claude is reporting the result…',
  'Claude 即将汇报结果': 'Claude will report back shortly',
  '已请求停止后台任务': 'Stop requested for background task',
  '已请求停止后台任务…': 'Stop requested for the background task…',
  '工具': 'tool',
  '个运行中': 'running',
  '运行中': 'Running',
  '运行中：': 'Running: ',
  '待审批': 'Awaiting approval',
  '等待审批': 'awaiting approval',
  '等待输入': 'awaiting input',
  '出错': 'Error',
  '出错：': 'Error: ',
  '已完成': 'Done',
  '完成': 'Done',
  '已中止': 'Interrupted',
  '已等待 <1 分钟': 'Waiting <1 min',
  '已等待': 'Waiting',
  '用时': 'took',
  '⏹ 任务已中止': '⏹ Task interrupted',
  '⚠️ 任务出错': '⚠️ Task failed',
  '✅ 任务完成': '✅ Task done',
  '限流重试中': 'Rate-limited, retrying',
  '过载重试中': 'Overloaded, retrying',
  '重试中': 'Retrying',
  // 占位符 N 由调用方 replace 填数：整句进词典才能各自成句，避免「次」在不同语境下打架。
  '第 N 次': 'attempt N',
  '后': 'later',
  '响应较慢，可能是深度思考或网络问题': 'Slow response — could be deep thinking, or the network',
  '仍在等待响应': 'Still waiting for a response',

  // —— 时间与时长 ——
  '刚刚': 'just now',
  '分钟前': 'min ago',
  '小时前': 'h ago',
  '天前': 'd ago',
  '秒': 's',
  '分钟': 'min',
  '分': 'min',
  '小时': 'h',
  '天': 'd',
  '（累计': '(',
  '次）': 'times)',
  '，累计': ', ',
  '次': 'times',

  // —— 服务状态告警 ——
  '⛔ 登录限速锁定于': '⛔ Login rate-limit lockout at',
  '——可能有人在暴力尝试你的入口': ' — someone may be brute-forcing your entry point',
  '🔔 推送最近失败于': '🔔 Push last failed at',
  '🐞 前端错误发生于': '🐞 Front-end error at',
  '，详见日志面板': ' — see the log panel',
  '推送失败（': 'Push failed (',
  '）': ')',

  // —— 诊断时间线 ——
  // 下面几条是「查表 key」：logic.js 的顶层常量表存中文原文、由 t(变量) 取用，源码里没有对应的
  // t('...') 字面调用（见 scripts/i18n-check.js keyAppearsAsLiteral）。
  '成功': 'Succeeded',
  '已拒绝': 'Denied',
  '已回答': 'Answered',
  '停止单任务': 'Stop one task',
  '撤回排队消息': 'Withdraw queued message',
  '切换模型': 'Switch model',
  '切换权限档': 'Switch permission mode',
  'Claude Code 版本过旧，暂不支持额度查询接口': 'Claude Code is too old to support the usage-query interface',
  'SDK 额度接口调用失败或超时': 'The SDK usage call failed or timed out',
  '当前鉴权（API Key / Bedrock / Vertex 等）不提供订阅额度信息': 'The current auth (API key / Bedrock / Vertex, etc.) does not expose subscription usage',
  'SDK 返回的额度数据缺失或超出正常范围': 'The usage data returned by the SDK is missing or out of range',
  '控制请求': 'Control request',
  '成功（': 'succeeded (',
  '失败：': 'failed: ',
  '🔒 镜像锁定（': '🔒 Mirror locked (',
  '🔓 镜像解锁（': '🔓 Mirror unlocked (',
  '🔒 切入即锁定：终端疑似在跑（尾部=': '🔒 Locked on entry: the terminal looks busy (tail=',
  '👀 切入未锁：': '👀 Entered unlocked: ',
  '陈旧挂起，判定已过期': 'stale hang, verdict expired',
  '尾部=': 'tail=',
  '⏹ 停止成功（丢弃': '⏹ Stopped (dropped',
  '条排队消息，': 'queued message(s), ',
  '⏹ 停止成功（': '⏹ Stopped (',
  '⏱ 停止超时，已强制收口（': '⏱ Stop timed out, force-settled (',
  '⚠️ 停止被拒，已强制收口（': '⚠️ Stop refused, force-settled (',
  'ℹ️ 当前无可中断任务': 'ℹ️ Nothing to interrupt right now',
  '实例已释放，停止请求作废': 'Instance already released — the stop request is moot',
  '⏹ 停止：': '⏹ Stop: ',
  '轮次因中断结束': 'Turn ended by interrupt',
  '轮次结束（': 'Turn ended (',
  '续接完成（先释放后台锁，': 'Resume complete (background lock released first, ',
  '续接完成（': 'Resume complete (',
  '追平巡检一次（': 'Catch-up tick (',
  '消息已入队（含附件，': 'Message queued (with attachments, ',
  '消息已入队（': 'Message queued (',
  '📊 额度显示不可用：': '📊 Usage display unavailable: ',
  '📊 额度显示已恢复（此前：': '📊 Usage display restored (was: ',

  // —— 会话管理（删除 / 关闭 / 分叉 / 首页）——
  '已从列表移除：': 'Removed from the list: ',
  '移除失败': 'Remove failed',
  '🗑 彻底删除底层文件？': '🗑 Permanently delete the underlying file?',
  '会话「': 'The transcript for "',
  '」在主机上的记录将被真正抹除。': '" on the host will be truly erased.',
  '此操作不可恢复。': 'This cannot be undone.',
  '彻底删除': 'Delete permanently',
  '已彻底删除：': 'Permanently deleted: ',
  '彻底删除失败': 'Permanent delete failed',
  '删除会话': 'Delete session',
  '关闭会话「': 'Close session "',
  '」？': '"?',
  '会话将从 tab 列表移除，但历史保留可重新打开。': 'It leaves the tab list, but the history stays and can be reopened.',
  '关闭会话': 'Close session',
  '切换失败': 'Switch failed',
  '切换无响应，请刷新页面后重试': 'No response switching — refresh the page and try again',
  '显示全部会话…': 'Show all sessions…',
  '在此工作区新建会话': 'New session in this workspace',
  '深链目标会话已不可用': 'The linked session is no longer available',
  '这是最早一条消息，前面没有可分叉的起点': 'This is the earliest message — there\'s nothing before it to fork from',
  '从这里分叉新会话？': 'Fork a new session from here?',
  '会复制到这条消息为止的对话，创建一个独立的新会话；原会话不受影响。': 'Copies the conversation up to this message into a separate new session; the original is untouched.',
  '分叉': 'Fork',
  '会话已切换，分叉已取消，请重新发起': 'The session changed, so the fork was cancelled — start it again',
  '分叉失败': 'Fork failed',
  '放弃未保存的修改？': 'Discard unsaved changes?',
  '编辑内容尚未保存，离开后将丢失。': 'Your edits are unsaved and will be lost if you leave.',
  '放弃修改': 'Discard',
  '需要刷新页面才能生效': 'A page refresh is needed for this to take effect',
  '现在刷新吗？': 'Refresh now?',
  '回首页失败': 'Could not return home',
  '回首页无响应，请刷新后重试': 'No response returning home — refresh and try again',
  '刷新无响应，请检查网络后重试': 'No response refreshing — check your network and try again',

  // —— 空表面：新会话页 / 首页 / 会话中断页 ——
  '新会话已就绪': 'New session ready',
  '将在此工作区开新 CLI 会话': 'Starts a new CLI session in this workspace',
  '点击打开会话列表（按工作区浏览）': 'Open the session list (browse by workspace)',
  '重新读取 CLI 配置': 'Re-read CLI config',
  '总结当前仓库结构并指出入口文件': 'Summarize this repo\'s structure and point out the entry files',
  '💡 总结当前仓库结构': '💡 Summarize repo structure',
  '帮我写一个最小改动的修复计划': 'Draft a minimal-diff fix plan',
  '🛠 写一个最小修复计划': '🛠 Write a minimal fix plan',
  '运行相关测试并解读失败': 'Run the relevant tests and explain the failures',
  '🧪 运行测试并解读': '🧪 Run tests and explain',
  '⏹ 会话已中断': '⏹ Session interrupted',
  '停止操作未能正常结束，后台会话进程已意外退出，无法直接继续。可以回首页，或在此工作区新建一个会话。': 'The stop didn\'t finish cleanly and the background session process exited unexpectedly, so it can\'t continue. Go home, or start a new session in this workspace.',
  '夜深了，有什么需要我帮忙的吗？': 'Working late — what can I help with?',
  '上午好，今天我能帮您做什么？': 'Good morning. What can I help you with today?',
  '中午好，今天我能帮您做什么？': 'Good day. What can I help you with today?',
  '下午好，今天我能帮您做什么？': 'Good afternoon. What can I help you with today?',
  '晚上好，今天我能帮您做什么？': 'Good evening. What can I help you with today?',
  '从最近会话继续，或点 ＋ 新建': 'Pick up a recent session, or tap ＋ to start a new one',
  '最近活跃工作区': 'Recently active workspaces',
  '最近活跃会话': 'Recently active sessions',
  '还没有最近会话': 'No recent sessions yet',
  '打开会话列表': 'Open the session list',
  '打开工作区与会话列表': 'Open workspaces & sessions',
  '❓ 如何连接与使用': '❓ How to connect and use',

  // —— 只读镜像 / 续接 CLI 会话 ——
  '续接': 'Resume',
  '取消续接': 'Cancel resume',
  '取消排队中的续接，继续只读追平': 'Cancel the queued resume and stay read-only',
  '续接 CLI 会话：运行中会排队等本轮结束，疑似中断需确认': 'Resume the CLI session: queues until the current turn ends; needs confirming if it looks interrupted',
  '只读镜像：本会话自主循环执行中——点右侧续接可在手机继续': 'Read-only mirror: this session is in an autonomous loop — tap Resume on the right to continue on your phone',
  '只读镜像：终端会话运行中——点右侧续接可在手机继续': 'Read-only mirror: the terminal session is running — tap Resume on the right to continue on your phone',
  '只读镜像：已请求续接，等待自主循环当前操作完成…': 'Read-only mirror: resume requested — waiting for the autonomous loop to finish its current operation…',
  '只读镜像：已请求续接，等待终端当前操作完成…': 'Read-only mirror: resume requested — waiting for the terminal to finish its current operation…',
  '只读镜像：自主循环疑似中断（超 5 分钟无活动）——确认已停可续接': 'Read-only mirror: the autonomous loop looks interrupted (no activity for 5+ min) — confirm it stopped, then resume',
  '只读镜像：终端疑似中断（超 5 分钟无活动）——确认已停可续接': 'Read-only mirror: the terminal looks interrupted (no activity for 5+ min) — confirm it stopped, then resume',
  '只读镜像：本会话自主循环执行中，移动端当前只读': 'Read-only mirror: this session is in an autonomous loop; mobile is read-only for now',
  '只读镜像：终端会话运行中，移动端当前只读': 'Read-only mirror: the terminal session is running; mobile is read-only for now',
  '只读镜像：已请求续接——等自主循环当前操作完成后自动可写。可点「取消续接」撤销。': 'Read-only mirror: resume requested — becomes writable once the autonomous loop finishes its current operation. Tap "Cancel resume" to undo.',
  '只读镜像：已请求续接——等终端当前操作完成后自动可写。可点「取消续接」撤销。': 'Read-only mirror: resume requested — becomes writable once the terminal finishes its current operation. Tap "Cancel resume" to undo.',
  '只读镜像：自主循环疑似中断。确认已停后点「续接」即可在手机继续（会话历史仍在）。': 'Read-only mirror: the autonomous loop looks interrupted. Once you have confirmed it stopped, tap "Resume" to continue on your phone (the history is still there).',
  '只读镜像：终端疑似中断。确认终端已停后点「续接」即可在手机继续（会话历史仍在）。': 'Read-only mirror: the terminal looks interrupted. Once you have confirmed the terminal stopped, tap "Resume" to continue on your phone (the history is still there).',
  '只读镜像：本会话自主循环执行中，移动端当前只读 · 不能：打字/发图/改模型权限思考 · 能：看消息、等自主循环静默后自动可写 · 硬要手机继续：点右侧「续接」（等本轮结束再放行；有分叉风险）': 'Read-only mirror: this session is in an autonomous loop; mobile is read-only · Cannot: type, send images, change model/permissions/thinking · Can: read messages, and writing unlocks once the loop goes quiet · To force it on your phone: tap "Resume" on the right (waits for this turn to end; risks forking)',
  '只读镜像：终端会话运行中，移动端当前只读 · 不能：打字/发图/改模型权限思考 · 能：看消息、等终端静默后自动可写 · 硬要手机继续：点右侧「续接」（等本轮结束再放行；疑似中断可立即续接，有分叉风险）': 'Read-only mirror: the terminal session is running; mobile is read-only · Cannot: type, send images, change model/permissions/thinking · Can: read messages, and writing unlocks once the terminal goes quiet · To force it on your phone: tap "Resume" on the right (waits for this turn to end; resumes right away if it looks interrupted; risks forking)',
  '续接 CLI 会话？': 'Resume the CLI session?',
  '这是电脑终端正在跑的同一条对话。续接不会停止终端进程——两边同时发消息会造成会话分叉（对方的消息在后续会话中可能不可见）。\n\n建议先到终端 Ctrl+C 或等它跑完再续接。': 'This is the same conversation your computer\'s terminal is running. Resuming does not stop the terminal process — sending from both sides forks the session (each side\'s messages may be invisible to the other).\n\nBetter to Ctrl+C in the terminal, or let it finish, before resuming.',
  '仍要续接': 'Resume anyway',
  '会话已变化，续接已取消，请重新确认': 'The session changed, so the resume was cancelled — confirm again',
  '已续接 CLI 会话：终端本轮已完结，安全切换': 'Resumed the CLI session: the terminal had finished its turn, so this was a clean handover',
  '已续接 CLI 会话：终端疑似中断，自动完成续接——若终端仍在跑同一会话，并发发送有分叉风险': 'Resumed the CLI session: the terminal looked interrupted so the handover completed automatically — if it is still on the same session, sending from both sides risks forking it',
  '已续接 CLI 会话：若终端仍在跑同一会话，并发发送有分叉风险': 'Resumed the CLI session: if the terminal is still on the same session, sending from both sides risks forking it',
  '已请求续接 CLI 会话：终端当前操作完成后自动切换，可点「取消续接」撤销': 'CLI session resume requested: it switches over once the terminal finishes its current operation — tap "Cancel resume" to undo',
  '已请求刷新：拉取终端最新消息': 'Refresh requested: pulling the terminal\'s latest messages',

  // —— 附件 ——
  '附件': 'attachment',
  '附件数量已达上限（': 'Attachment limit reached (',
  '超过 10MB，未添加': 'is over 10MB — not added',
  '附件总量将超过 20MB，未添加': 'Total attachments would exceed 20MB — not added',
  '读取失败': 'could not be read',
  '不是可预览图片': 'is not a previewable image',
  '该附件不可预览': 'This attachment can\'t be previewed',
  '读取超时': 'Read timed out',
  '附件读取失败': 'Attachment read failed',
  '附件为空': 'Attachment is empty',
  '过大（': 'is too large (',
  'MB），不支持预览': 'MB) — preview not supported',
  '读取不完整（文件可能正被改写）': 'Incomplete read (the file may be changing)',
  '预览加载失败：': 'preview failed to load: ',

  // —— 文件浏览 / git 改动 ——
  '无法加载：': 'Could not load: ',
  '加载更多（已显示': 'Load more (showing',
  '二进制文件（': 'Binary file (',
  '），不支持预览': ') — preview not supported',
  '保存失败': 'Save failed',
  '无法读取未跟踪文件': 'Could not read the untracked file',
  '二进制文件，不支持预览': 'Binary file — preview not supported',
  '未跟踪文件（全文即新增）': 'Untracked file (the whole file is new)',
  ' · 已截断': ' · truncated',
  'diff 不可用': 'diff unavailable',
  '二进制文件，diff 略': 'Binary file — diff omitted',
  '无 diff（可能已清除）': 'No diff (it may have been cleared)',
  '内容已截断': 'Content truncated',
  '（无分支）': '(no branch)',
  '工作区干净，没有改动': 'Working tree clean — no changes',
  '列表已截断（条目过多）': 'List truncated (too many entries)',
  '无法加载 git 状态': 'Could not load git status',
  '非 git 仓库': 'Not a git repository',
  '已暂存': 'Staged',
  '未暂存': 'Unstaged',
  '未跟踪': 'Untracked',

  // —— 推送订阅 ——
  '⚠️ 推送需 HTTPS：局域网 http 下浏览器会拦截通知订阅。请用 https 隧道（cloudflared 等）访问本站。': '⚠️ Push needs HTTPS: browsers block notification subscriptions over plain http on a LAN. Reach this site through an https tunnel (cloudflared, etc.).',
  '📲 iOS 收推送需先「添加到主屏幕」：点底部分享按钮 → 添加到主屏幕，再从主屏图标打开本站开启通知。': '📲 On iOS, push needs "Add to Home Screen" first: tap the share button at the bottom → Add to Home Screen, then open this site from the home-screen icon to enable notifications.',
  '🚫 当前浏览器不支持 Web Push（iOS 需 16.4+ 且已加主屏）。': '🚫 This browser doesn\'t support Web Push (iOS needs 16.4+ with the site added to the home screen).',
  '⚠️ 订阅失败：服务端未启用/配置 Web Push 密钥，或当前未加载成功密钥。请检查 VAPID 环境变量并重启服务。': '⚠️ Subscription failed: the server has Web Push keys disabled or misconfigured, or they didn\'t load. Check the VAPID environment variables and restart the service.',
  '当前浏览器/环境不支持 Notification API': 'This browser/environment doesn\'t support the Notification API',
  '🔔 成功订阅推送通知！': '🔔 Subscribed to push notifications!',
  '⚠️ 订阅未成功，请稍后重试': '⚠️ Subscription didn\'t go through — try again later',
  '🚫 接收推送通知权限已被拒绝，可在浏览器地址栏左侧设置中重新允许': '🚫 Notification permission was denied — re-allow it from the settings to the left of the address bar',
  '❌ 订阅出错:': '❌ Subscription error:',
});

// 需要翻译的属性白名单：这四个是「屏幕上/读屏器里真会念出来」的，其余属性（data-*、aria-labelledby
// 等 id 引用、class）碰了只会坏功能。
export const I18N_ATTRS = Object.freeze(['title', 'placeholder', 'aria-label', 'alt']);

// 整树扫描时跳过的容器：script/style 是代码不是文案；textarea 的文本子节点是「初始值」而非提示语
// （真正给人看的提示在它的 placeholder，已由 I18N_ATTRS 覆盖），改了等于凭空往输入框塞内容。
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA']);

let currentLang = 'zh';

export function setLang(lang) {
  currentLang = lang === 'en' ? 'en' : 'zh';
}

export function getLang() {
  return currentLang;
}

export function t(zh) {
  if (currentLang !== 'en' || typeof zh !== 'string') return zh;
  // 用 hasOwnProperty 而非 `in`：避免 'constructor'/'toString' 等原型链同名属性被误命中
  return Object.prototype.hasOwnProperty.call(EN_DICT, zh) ? EN_DICT[zh] : zh;
}

// 翻译一个文本节点的值。HTML 里的文本节点带着源码缩进（'\n      取消\n    '），词典 key 却是净文案，
// 故按 trim 后查典、再按原空白位置回填——用 indexOf 切片而非 String.replace，后者会把译文里的
// '$&' 之类当替换模式解释。
export function translateTextNodeValue(raw) {
  if (currentLang !== 'en' || typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  const translated = t(trimmed);
  if (translated === trimmed) return raw;
  const start = raw.indexOf(trimmed);
  return raw.slice(0, start) + translated + raw.slice(start + trimmed.length);
}

// 启动时把整棵静态 DOM 过一遍词典。index.html 因此不需要逐个标 data-i18n：漏标是隐性 bug（看不出来，
// 只是那句永远不翻），整树扫描则是"进了词典就一定生效"。只在 en 下动 DOM，zh 是零操作。
// 只对 index.html 这层静态外壳跑一次，且发生在任何用户内容渲染之前——不会误伤会话消息里的中文。
export function applyI18nToDocument(root) {
  if (currentLang !== 'en' || !root || typeof root.querySelectorAll !== 'function') return 0;
  const doc = root.ownerDocument || root;
  if (typeof doc.createTreeWalker !== 'function') return 0;
  let count = 0;

  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */, {
    acceptNode(node) {
      if (node.parentNode && SKIP_TAGS.has(node.parentNode.nodeName)) return 2 /* FILTER_REJECT */;
      return node.nodeValue && node.nodeValue.trim() ? 1 /* FILTER_ACCEPT */ : 2;
    },
  });
  // 先收集再改：改 nodeValue 会让部分实现的 walker 游标失稳，边走边写不可靠。
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const node of textNodes) {
    const next = translateTextNodeValue(node.nodeValue);
    if (next !== node.nodeValue) { node.nodeValue = next; count += 1; }
  }

  for (const attr of I18N_ATTRS) {
    for (const el of root.querySelectorAll(`[${attr}]`)) {
      const raw = el.getAttribute(attr);
      const next = translateTextNodeValue(raw);
      if (next !== raw) { el.setAttribute(attr, next); count += 1; }
    }
  }

  // <html lang> 跟着切：影响读屏器发音、浏览器"翻译此页"提示与 CSS :lang() 断词。
  if (doc.documentElement) doc.documentElement.lang = 'en';
  return count;
}

// 读原始存储偏好（'zh'/'en'/'auto'），不做 navigator 解析——供设置面板回显用户真实选择，
// 区别于 getLang()（恒返回运行时已折叠的 zh/en，'auto' 会被解析掉，设置面板不能拿它反显下拉框，
// 否则用户选了「跟随浏览器」刷新后重开设置会看着像被静默改回了固定语言）。
export function readLangPref(getItem) {
  const stored = typeof getItem === 'function' ? getItem(LANG_STORAGE_KEY) : null;
  return (stored === 'zh' || stored === 'en' || stored === 'auto') ? stored : 'zh';
}

// 启动时解析语言偏好：显式 'zh'/'en' 直接用；'auto' 按 navigator.language 首段判定
// （en 开头→en，其余→zh）；未设置过 / 未知值一概保底 zh（不静默变英文，最小惊讶）。
export function resolveInitialLang(getItem, navigatorLanguage) {
  const pref = readLangPref(getItem);
  if (pref === 'auto') return /^en/i.test(String(navigatorLanguage || '')) ? 'en' : 'zh';
  return pref;
}

export function writeLangPref(setItem, lang) {
  if (typeof setItem !== 'function') return false;
  setItem(LANG_STORAGE_KEY, lang);
  return true;
}
