// 配置面板的单一事实源：哪些 env 能从 UI 改、改成什么算合法、怎么展示。
//
// ## 为什么 schema 只放服务端
// scripts/check-import-boundaries.js 的 frontend-no-backend 规则禁止 public/js 引 src/，
// 所以前后端不可能真共享这份表。与其两边各写一份迟早分叉，不如只留服务端一份、经 env:get 的
// ack 下发，前端当数据渲染。加一个配置项 = 只改这一个文件。
//
// ## 为什么文案是 {zh,en} 对而不是走 i18n 词典
// scripts/i18n-check.js 扫的是 HTML 文本节点与 js 里的 t('原文') 调用点；服务端下发的字符串
// 它扫不到，塞进 EN_DICT 会立刻变成孤儿 key 让 npm run check 报红。现成范式是
// scripts/setup.js:85 的 MESSAGES 双语字典。**别好心把这些搬进 EN_DICT。**
//
// ## 三条硬边界（不是「暂未支持」，是不能做）
//   1. ANTHROPIC_* —— src/server/config.js:21,36-42 启动期无条件剥除，只认真实 shell export。
//      写进 .env 是静默失效，做成表单等于骗人。只读诊断 + 引导改 shell profile。
//   2. AUTH_TOKEN —— 只读。改完到重启之间 .env 与运行中进程不一致；重启后所有已保存 token 的
//      设备（含正在操作的这台手机）都要重新输入，极易把自己锁在门外。
//   3. CCM_DATA_DIR —— 只读。改它等于把全部控制面状态（会话/设备信任/审批/审计）孤儿化，
//      那是**迁移**不是设置，docs/deployment.md 有「停服→移动→doctor→启动」的配方。

import { isSerializableEnvValue, maskSecret, shellOverriddenKeys } from './env-file.js';

// 开关类的真值字面量**逐 key 声明**，绝不用统一的 truthy 判定。
// src/ops/log-terminal.js:32 明写过这个经典脚枪：LOG_STDERR=false 反而是「开」——
// 因为那处用的是 truthy 判定，而 'false' 是个非空字符串。
const TOGGLE_ONE = { on: '1', off: '' };    // DEV_MODE / LOG_* / ASSET_HOT_RELOAD：严格 === '1'
const TOGGLE_OFF = { on: '', off: 'off' };  // WEB_STATUSLINE / FILE_EDIT / CLI_*：严格 === 'off'
const TOGGLE_ON = { on: 'on', off: '' };    // LOG_TERMINAL：严格 === 'on'

const t = (zh, en) => ({ zh, en });

// kind: text | number | path | url | secret | toggle | readonly
export const ENV_SCHEMA = {
  // ── 鉴权 ────────────────────────────────────────────────────────────
  AUTH_TOKEN: {
    group: 'auth', kind: 'readonly', secret: true,
    label: t('访问令牌', 'Access token'),
    help: t('留空时 server 只绑 127.0.0.1，手机将无法访问。要更换请在电脑上跑 npm run setup。',
      'Empty means the server binds 127.0.0.1 only. Run npm run setup on the machine to rotate it.'),
  },
  CF_ACCESS_HOSTNAME: {
    group: 'auth', kind: 'text',
    label: t('Cloudflare Access 域名', 'Cloudflare Access hostname'),
    help: t('公网域名。与 TEAM、AUD 三项必须同时设置或同时留空。', 'Set all three CF_ACCESS_* or none.'),
    together: ['CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD'],
  },
  CF_ACCESS_TEAM: {
    group: 'auth', kind: 'text',
    label: t('Cloudflare Access 团队名', 'Cloudflare Access team'),
    together: ['CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD'],
  },
  CF_ACCESS_AUD: {
    group: 'auth', kind: 'secret',
    label: t('Cloudflare Access AUD', 'Cloudflare Access AUD'),
    together: ['CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD'],
  },

  // ── 运行时 ──────────────────────────────────────────────────────────
  PORT: {
    group: 'runtime', kind: 'number', min: 1, max: 65535, default: '3000',
    label: t('监听端口', 'Port'),
  },
  WORK_DIR: {
    group: 'runtime', kind: 'path', mustExist: true, writable: true,
    label: t('主工作目录', 'Primary work directory'),
    help: t('claude 的默认工作目录。', 'Default working directory for claude.'),
  },
  // ── 工作区列表：统一配置文件里的内联形态（P1b）────────────────────────
  //
  // 优先级高于 WORK_DIRS_FILE 与 WORK_DIRS —— 统一配置文件是新的事实源，显式写了就该赢。
  // 那两个保留是为了不打断现有部署（migrate 会把它们内联进这里）。
  //
  // `reload: 'hot'` 是全表唯一一个：改完即生效、无需重启。其余项缺省 'restart'。
  // 这个标记不是文档，是**行为**：ccm.config.json 变更时，server 只热应用标了 hot 的 key，
  // 其余提示需重启 —— 现状是用户根本无从知道改哪些要重启。
  WORKDIRS: {
    group: 'runtime', kind: 'list', reload: 'hot',
    label: t('工作区列表', 'Workspaces'),
    help: t('每项是绝对路径，或 {path, sessionLimit}。改完即生效，无需重启。当前列表见工作区抽屉；'
      + '编辑请用 CLI 或桌面端（手机面板没有数组编辑器，故此处只读）。',
      'Each entry is an absolute path, or {path, sessionLimit}. Hot-reloads without a restart. '
      + 'See the workspace drawer for the current list; edit via CLI or desktop (read-only here).'),
  },
  WORK_DIRS_FILE: {
    group: 'runtime', kind: 'path', mustExist: true,
    label: t('多工作区配置文件（旧）', 'Workdirs file (legacy)'),
    help: t('指向外部 workdirs.json。该文件的**内容**支持热加载，但改这个指针本身需要重启。已被上面的工作区列表取代。',
      'Points at an external workdirs.json. Superseded by the inline list above; kept for compatibility.'),
  },
  CLAUDE_BIN: {
    group: 'runtime', kind: 'path', mustExist: true, executable: true,
    label: t('claude 可执行文件', 'claude binary'),
    help: t('留空则从 PATH 查找。', 'Empty means look it up on PATH.'),
  },

  // ── 超时与配额 ──────────────────────────────────────────────────────
  IDLE_TIMEOUT_MS: {
    group: 'limits', kind: 'number', min: 1000, default: '600000', unit: 'ms',
    label: t('无输出判挂死', 'Idle timeout'),
  },
  INSTANCE_IDLE_RECLAIM_MS: {
    group: 'limits', kind: 'number', min: 0, default: '1800000', unit: 'ms',
    label: t('空闲实例回收', 'Idle instance reclaim'),
    help: t('0 = 不回收。', '0 disables reclaiming.'),
  },
  APPROVAL_TTL_MS: {
    group: 'limits', kind: 'number', min: 1000, default: '1800000', unit: 'ms',
    label: t('审批自动过期', 'Approval TTL'),
  },
  NOTIFY_THROTTLE_MS: {
    group: 'limits', kind: 'number', min: 0, default: '60000', unit: 'ms',
    label: t('同类通知最小间隔', 'Notification throttle'),
  },
  SESSION_DELETE_QUIET_MS: {
    group: 'limits', kind: 'number', min: 0, default: '300000', unit: 'ms',
    label: t('删除会话前静默期', 'Session delete quiet period'),
  },

  // ── 推送 ────────────────────────────────────────────────────────────
  VAPID_PUBLIC_KEY: {
    group: 'push', kind: 'text',
    label: t('VAPID 公钥', 'VAPID public key'),
    together: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'],
  },
  VAPID_PRIVATE_KEY: {
    group: 'push', kind: 'secret',
    label: t('VAPID 私钥', 'VAPID private key'),
    together: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'],
  },
  VAPID_SUBJECT: {
    group: 'push', kind: 'url', // 必须是 mailto: 或 https:，走 URL 校验而不是自由文本
    label: t('VAPID 联系方式', 'VAPID subject'),
    help: t('mailto: 或 https: 开头。', 'Starts with mailto: or https:.'),
    together: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'],
  },
  NTFY_URL: {
    group: 'push', kind: 'url',
    label: t('ntfy 服务地址', 'ntfy URL'),
    help: t('务必自托管或用私密 topic：标题会带工作区目录名，且明文经第三方。',
      'Self-host or use a private topic: titles carry the workspace name in clear text.'),
    together: ['NTFY_URL', 'NTFY_TOPIC'],
  },
  NTFY_TOPIC: {
    group: 'push', kind: 'text',
    label: t('ntfy topic', 'ntfy topic'),
    together: ['NTFY_URL', 'NTFY_TOPIC'],
  },
  NTFY_TOKEN: { group: 'push', kind: 'secret', label: t('ntfy 访问令牌', 'ntfy token') },
  PUBLIC_URL: {
    group: 'push', kind: 'url',
    label: t('公网地址', 'Public URL'),
    help: t('通知深链用。留空回退到 CF_ACCESS_HOSTNAME。', 'Used for notification deep links.'),
  },

  // ── 功能开关 ────────────────────────────────────────────────────────
  DEV_MODE: {
    group: 'toggles', kind: 'toggle', values: TOGGLE_ONE,
    label: t('开发者模式', 'Developer mode'),
    help: t('齿轮面板出现「重启服务」按钮。', 'Adds a restart button to the settings panel.'),
  },
  WEB_STATUSLINE: {
    group: 'toggles', kind: 'toggle', values: TOGGLE_OFF,
    label: t('Web 状态栏', 'Web status line'),
  },
  FILE_EDIT: {
    group: 'toggles', kind: 'toggle', values: TOGGLE_OFF,
    label: t('文件编辑器写入', 'File editor writes'),
  },
  ASSET_HOT_RELOAD: {
    group: 'toggles', kind: 'toggle', values: TOGGLE_ONE,
    label: t('前端资源热重载', 'Asset hot reload'),
  },
  CLI_HOOKS_BRIDGE: {
    group: 'toggles', kind: 'toggle', values: TOGGLE_OFF,
    label: t('CLI hooks 桥', 'CLI hooks bridge'),
    help: t('关掉只是停止消费事件，不卸载安装。', 'Off stops consuming events; it does not uninstall.'),
  },
  CLI_STATUSLINE_BRIDGE: {
    group: 'toggles', kind: 'toggle', values: TOGGLE_OFF,
    label: t('CLI statusline 桥', 'CLI statusline bridge'),
  },

  // ── 日志 ────────────────────────────────────────────────────────────
  LOG_INTERACTIONS: {
    group: 'logs', kind: 'toggle', values: TOGGLE_ONE,
    label: t('四跳交互日志', 'Interaction log'),
    help: t('会记录消息正文摘要（已脱敏、截断 1500 字符）。', 'Records redacted message excerpts.'),
  },
  LOG_STDERR: {
    group: 'logs', kind: 'toggle', values: TOGGLE_ONE,
    label: t('子进程 stderr', 'Child stderr'),
  },
  DEBUG_SDK_MESSAGES: {
    group: 'logs', kind: 'toggle', values: TOGGLE_ONE,
    label: t('SDK 原始消息', 'Raw SDK messages'),
    help: t('体积极大，长开曾把日志刷到 149MB。', 'Very verbose; has produced 149MB logs when left on.'),
  },
  LOG_TERMINAL: {
    group: 'logs', kind: 'toggle', values: TOGGLE_ON,
    label: t('启动时开日志窗口', 'Open log terminal on boot'),
    help: t('仅 macOS。', 'macOS only.'),
  },
  LOG_FILE: {
    group: 'logs', kind: 'path',
    label: t('日志文件路径', 'Log file path'),
    help: t('只告诉 doctor 与日志窗口去哪找；server 自身仍由进程管理器重定向落盘。',
      'Only tells doctor/log window where to look; the process manager still does the redirect.'),
  },
};

export const ENV_GROUPS = [
  { id: 'auth', label: t('鉴权', 'Authentication') },
  { id: 'runtime', label: t('运行时', 'Runtime') },
  { id: 'limits', label: t('超时与配额', 'Timeouts & quotas') },
  { id: 'push', label: t('推送', 'Notifications') },
  { id: 'toggles', label: t('功能开关', 'Feature toggles') },
  { id: 'logs', label: t('日志', 'Logging') },
];

// 只读诊断：不可写，但用户需要知道它们现在是什么状态。
export const READONLY_DIAGNOSTICS = [
  {
    key: 'ANTHROPIC_*',
    label: t('模型网关配置', 'Model gateway config'),
    help: t('只能从启动 shell export —— .env 里的会在启动时被剥除。改法：写进 shell profile 后重启服务。',
      'Must come from the launching shell; values in .env are stripped at startup.'),
  },
  {
    key: 'CCM_DATA_DIR',
    label: t('控制面数据目录', 'Control-plane data directory'),
    help: t('改它是一次迁移不是一次设置（会话/设备信任/审批/审计都在里面）。见 docs/deployment.md。',
      'Changing it is a migration, not a setting. See docs/deployment.md.'),
  },
];

export const WRITABLE_KEYS = Object.freeze(
  Object.entries(ENV_SCHEMA).filter(([, d]) => d.kind !== 'readonly').map(([k]) => k)
);

// ── 校验 ────────────────────────────────────────────────────────────────
//
// 立场是**全或无**：任何一项 error 就整体拒写。部分生效的配置比不写更糟 —— 用户以为改好了，
// server 却起不来，而且不知道是哪一半生效了。warn 不阻断，但要报出来让 UI 弹确认。

function hasControlChars(s) {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

function checkUrl(key, value, def) {
  const allowMailto = key === 'VAPID_SUBJECT';
  let u;
  try {
    u = new URL(value);
  } catch {
    return `不是合法的 URL：${def.label.zh}`;
  }
  const ok = u.protocol === 'http:' || u.protocol === 'https:' || (allowMailto && u.protocol === 'mailto:');
  return ok ? null : `${def.label.zh} 只支持 http/https${allowMailto ? '/mailto' : ''}`;
}

// list（当前只有 WORKDIRS）的结构校验。
//
// 条目形状必须与 src/sessions/workdirs.js 的 normalizeWorkdirEntries 接受的一致：
// `string` 或 `{path, sessionLimit?}`。那边对非法条目是 **warn-skip 不挡启动**，很合理 ——
// 一个坏条目不该让整台 server 起不来。但正因为它宽容，**写入这一侧必须严**：
// 放进去一个形状不对的条目，用户看到的是「保存成功」，得到的是一个静默少了一项的白名单。
function checkList(value, def) {
  if (!Array.isArray(value)) return `${def.label.zh} 必须是数组（每项为路径字符串或 {path, sessionLimit}）`;
  for (const entry of value) {
    const path = typeof entry === 'string' ? entry
      : (entry && typeof entry === 'object' && typeof entry.path === 'string' ? entry.path : null);
    if (path === null || !path.trim()) {
      return `${def.label.zh} 的条目必须是非空路径字符串或 {path, sessionLimit}，收到：${JSON.stringify(entry)}`;
    }
    // ★ 必须是绝对路径。checkOne 的 path kind 早就有这道（理由：启动后 cwd 未必是仓库根），
    // 而 list 独独漏了 —— 实测 ['..'] 能通过校验，realpath 相对 cwd 解析后把仓库父目录
    // 整棵树放进白名单。白名单是 claude 的文件作用域边界，不是展示用的列表。
    if (!path.startsWith('/')) {
      return `${def.label.zh} 的每项必须是绝对路径（启动后 cwd 未必是仓库根），收到：${JSON.stringify(path)}`;
    }
    // sessionLimit 非法时 normalizeWorkdirEntries 只 warn-skip 并静默回退默认值 ——
    // 用户看到「保存成功」，拿到的是一个和自己写的不一样的配置。写入侧要严。
    if (entry && typeof entry === 'object' && Object.hasOwn(entry, 'sessionLimit')) {
      const n = entry.sessionLimit;
      if (!Number.isInteger(n) || n < 1) {
        return `${def.label.zh} 的 sessionLimit 必须是 ≥1 的整数，收到：${JSON.stringify(n)}`;
      }
    }
  }
  return null;
}

// 单项类型校验。返回错误文案或 null。
function checkOne(key, value, def, d) {
  // 校验期与序列化期用**同一个判据**，否则会出现「校验说 ok、写盘时抛错」——
  // 用户填完点保存才收到一句看不懂的异常，而不是在输入时就被告知。
  if (!isSerializableEnvValue(value)) {
    if (hasControlChars(value)) return '值不能包含换行或控制字符';
    // 三个否定条件各给各的理由。合并成一句「格式非法」会让「路径末尾多打了个反斜杠」这种
    // 最常见的形态收到一句关于单引号的提示，用户照着改也改不对。
    if (String(value).endsWith('\\')) {
      return '值不能以反斜杠（\\）结尾：dotenv 会把它与结尾引号读成转义，从而吞掉 .env 里后面的配置项（去掉末尾的 \\ 即可）';
    }
    return "值不能包含单引号（'）：.env 会被 dotenv 与 shell 两边读，只有单引号包裹两边都安全，而它包不住自身";
  }

  if (def.kind === 'number') {
    const n = Number(value);
    if (!Number.isInteger(n)) return `${def.label.zh} 必须是整数`;
    if (def.min !== undefined && n < def.min) return `${def.label.zh} 不能小于 ${def.min}`;
    if (def.max !== undefined && n > def.max) return `${def.label.zh} 不能大于 ${def.max}`;
    // 端口占用只在**生效值真的变了**时才探测：当前 server 正绑在旧端口上，无条件探测会恒报占用
    // —— 那正是 doctor D4 的既有 bug。
    // 注意比的是**生效值**而不是「.env 里写没写」：没有 PORT 行时 server 跑在 def.default，
    // 用户把面板里的 PORT 显式填成那个默认值不是改端口，早前按空串比会判成变了 → 探到自己 → 报占用，
    // 而且全或无会把同批次其他改动一起挡掉。
    if (key === 'PORT') {
      const effective = String(d.current?.PORT ?? '') || def.default || '';
      if (effective !== value && d.probePort(n)) return `端口 ${n} 已被占用`;
    }
    return null;
  }

  if (def.kind === 'path') {
    if (!value.startsWith('/')) return `${def.label.zh} 必须是绝对路径（启动后 cwd 未必是仓库根）`;
    if (def.mustExist && !d.fileExists(value)) return `路径不存在：${value}`;
    if (def.writable && !d.isWritable(value)) return `路径不可写：${value}`;
    if (def.executable && !d.isExecutable(value)) return `文件不可执行：${value}`;
    return null;
  }

  if (def.kind === 'url') return checkUrl(key, value, def);

  if (def.kind === 'toggle') {
    // 只认声明过的字面量。'true'/'0'/'yes' 这类值写进去是**静默失效**，
    // 甚至可能反向生效（truthy 判定下 'false' 是开），必须当场拒绝。
    const { on, off } = def.values;
    if (value !== on && value !== off) {
      return `${def.label.zh} 只接受 ${JSON.stringify(on)} 或 ${JSON.stringify(off)}`;
    }
    return null;
  }

  return null;
}

// 「三项全设或全空」这类成套约束，必须看**合并后的最终状态**，不能只看本次改动：
// 用户可能已经填好两项，这次只补第三项。
function checkTogether(changes, current) {
  const problems = [];
  const seen = new Set();
  for (const def of Object.values(ENV_SCHEMA)) {
    if (!def.together || seen.has(def.together.join())) continue;
    const group = def.together;
    if (!group.some((k) => Object.hasOwn(changes, k))) continue; // 本次没碰这组
    seen.add(group.join());

    const finalOf = (k) => (Object.hasOwn(changes, k) ? changes[k] : current?.[k]);
    const filled = group.filter((k) => {
      const v = finalOf(k);
      return typeof v === 'string' && v.length > 0;
    });
    if (filled.length !== 0 && filled.length !== group.length) {
      problems.push({
        key: group.find((k) => Object.hasOwn(changes, k)),
        level: 'error',
        message: `${group.join(' / ')} 必须同时设置或同时留空（现在只填了 ${filled.length}/${group.length} 项）`,
      });
    }
  }
  return problems;
}

// 长开会明显放大代价、但不是错误的开关。
const NOISY_TOGGLES = {
  DEBUG_SDK_MESSAGES: '体积极大，长开曾把日志刷到 149MB',
  LOG_INTERACTIONS: '会把消息正文摘要写进日志（已脱敏、截断）',
};

// ## 清空 CF_ACCESS_* 必须先警告（2026-08-14 第三轮审查）
//
// 上面 §硬边界 把 AUTH_TOKEN 钉成 readonly，理由是「极易把自己锁在门外」。但 CF_ACCESS_* 是
// **另一条鉴权轴**——AUTH_TOKEN 管 LAN/本机那层，CF Access JWT 管公网那层——三项却全部可写，
// 清空还零告警。等于**持有第一因子就能静默删掉第二因子**，而且删掉之后设备 token 事后被吊销
// 也回滚不了。配合本批把 dev:restart 放宽到 `DEV_MODE || isSupervised()`（桌面端 LaunchAgent 下
// 恒 true），这成了手机上一次会话内可完成的闭环。
//
// 不做成 readonly：那会让「在手机上配 CF Access」彻底没法做。改成 warn —— 前端对 warn 会弹
// appConfirm 再重发，用户至少被明确告知自己在关掉什么。
const CF_ACCESS_KEYS = ['CF_ACCESS_HOSTNAME', 'CF_ACCESS_TEAM', 'CF_ACCESS_AUD'];

function checkCfAccessTeardown(changes, current) {
  // src/auth/cf-access.js:92 是 `enabled = !!(hostname && team && aud)` —— 任意一项被清空，
  // 整层就关了。所以判据是「有没有清掉任何一项**且它本来是设着的**」。
  const cleared = CF_ACCESS_KEYS.filter((k) => {
    const wasSet = String(current?.[k] ?? '').trim() !== '';
    const nowEmpty = !Object.hasOwn(changes, k) ? false : String(changes[k] ?? '').trim() === '';
    return wasSet && nowEmpty;
  });
  if (cleared.length === 0) return [];
  return [{
    key: cleared[0],
    level: 'warn',
    message: `会关闭公网 2FA（Cloudflare Access）：清空 ${cleared.join(' / ')} 后，公网域名退化成只靠 AUTH_TOKEN 校验。`
      + '若这台 server 暴露在公网上，这一步会实质降低防护等级。',
  }];
}

export function validateEnvChanges(changes, d) {
  const results = [];
  for (const [key, value] of Object.entries(changes || {})) {
    if (key.startsWith('ANTHROPIC_')) {
      results.push({
        key,
        level: 'error',
        message: '模型网关配置只能从启动 shell export —— 写进 .env 会在启动期被剥除，等于静默失效',
      });
      continue;
    }
    // Object.hasOwn 而不是 `ENV_SCHEMA[key]` 的真值判断：ENV_SCHEMA 是普通对象字面量，
    // 原型是 Object.prototype ⇒ ENV_SCHEMA['toString'|'constructor'|'hasOwnProperty'|…] 恒 truthy，
    // 那批 key 会畅通无阻地写进 .env（`__proto__` 经 JSON.parse 是 own property，同样漏）。
    // 下游还会污染 process.env 上的 Object.prototype 方法：toString 被字符串遮蔽后 String(env) 抛错。
    const def = Object.hasOwn(ENV_SCHEMA, key) ? ENV_SCHEMA[key] : null;
    if (!def) {
      results.push({ key, level: 'error', message: `不认识的配置项（本面板不是通用 .env 编辑器）` });
      continue;
    }
    if (def.kind === 'readonly') {
      results.push({ key, level: 'error', message: `${def.label.zh} 在此处只读，${def.help?.zh || ''}`.trim() });
      continue;
    }
    if (value === null) continue; // 删除不做类型校验

    // list 是唯一的非字符串 kind，必须在「必须是字符串」与 .env 序列化检查之前分流：
    // 那两道都是为 .env 行格式写的，对数组会先 String(value) 折成 "/a,/b" 再放行。
    if (def.kind === 'list') {
      const err = checkList(value, def);
      if (err) results.push({ key, level: 'error', message: err });
      continue;
    }

    if (typeof value !== 'string') {
      results.push({ key, level: 'error', message: '配置值必须是字符串' });
      continue;
    }
    const err = checkOne(key, value, def, d);
    if (err) {
      results.push({ key, level: 'error', message: err });
      continue;
    }
    if (value && NOISY_TOGGLES[key] && value === def.values?.on) {
      results.push({ key, level: 'warn', message: NOISY_TOGGLES[key] });
    }
  }

  results.push(...checkTogether(changes || {}, d?.current || {}));
  results.push(...checkCfAccessTeardown(changes || {}, d?.current || {}));
  return { ok: !results.some((r) => r.level === 'error'), results };
}

// ── 下发给前端的视图 ────────────────────────────────────────────────────
// 敏感项只出 { set, length }。明文永不离开服务端 —— 同 src/ops/doctor-runtime.js 的脱敏纪律。
//
// ## shellEnv：为什么它必须由调用方传进来，且必须是「投影之前」的快照
// values 是**配置文件**的投影，而 shell 环境变量恒压过配置文件 —— 被压住的那一行在面板上
// 与正常行长得一模一样：用户改完、保存成功、运行时仍是旧值，零症状（VC-D4-02，2026-08-26 实测）。
// 要标出这种行，就得知道 shell 里设过哪些 key，而这里**不能自己去读 process.env**：
//   1. src/server/config.js:72 会把文件值投影回 process.env（只填还没有的 key），
//      加载之后现读分不出来源，做出来的是永远不报的假功能；
//   2. src/ops 不读 process.env 是既定约定（同 src/shared/data-dir.js 顶层不读 env 的理由）——
//      这个模块得能被单测直接喂数据。
// 快照由 src/server/config.js 的 getShellEnvSnapshot() 提供（它在投影前第一行拍下）。
//
// **只标键，绝不回显 env 的值**：被压住的可能正是 AUTH_TOKEN / VAPID 私钥，
// 与 doctor D18 同一条纪律（src/ops/doctor-checks.js:560 上方注释）。
export function buildEnvView(values = {}, { shellEnv = null } = {}) {
  // 没给快照 = 这一维**没查过**，此时整个字段缺席，而不是下发 false。
  // false 的意思是「查过了，没被覆盖」——把「没查」说成「没问题」正是 BE-013 那个假绿的形状。
  // 具体受益方是 scripts/config.js 的 cmdSchema()：它拿 buildEnvView({}) 当**配置项文档**下发给
  // 桌面端（值是空的、也没有 shell 上下文），那条通道上给出 false 就是一句没有根据的断言。
  const checked = !!shellEnv && typeof shellEnv === 'object';
  const overridden = new Set(checked ? shellOverriddenKeys(shellEnv, Object.keys(ENV_SCHEMA)) : []);
  const groups = ENV_GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    items: Object.entries(ENV_SCHEMA)
      .filter(([, def]) => def.group === g.id)
      .map(([key, def]) => {
        const raw = typeof values[key] === 'string' ? values[key] : '';
        const item = {
          key,
          kind: def.kind,
          label: def.label,
          help: def.help,
          // list 也标只读：前端 env-config.js 只分派 number / toggle，其余渲染成 text input，
          // 而往数组项里塞一个字符串会让 app.js 的 Array.isArray 判否 → 静默回落旧路径。
          // 结构化编辑器留给 CLI 与 desktop（P1c）。
          readonly: def.kind === 'readonly' || def.kind === 'list',
          secret: !!def.secret || def.kind === 'secret',
        };
        // 查过了才下发（true/false 都下发）；没查则整个字段缺席，见上方注释。
        // 只读项也照标 —— 它同样会被 env 压过，只是用户不能在这里改而已。
        if (checked) item.overriddenByEnv = overridden.has(key);
        if (def.values) item.values = def.values;
        if (def.default !== undefined) item.default = def.default;
        if (def.unit) item.unit = def.unit;
        if (def.min !== undefined) item.min = def.min;
        if (def.max !== undefined) item.max = def.max;
        if (item.secret) item.masked = maskSecret(raw);
        else item.value = raw;
        return item;
      }),
  }));
  return { groups, readonlyDiagnostics: READONLY_DIAGNOSTICS };
}
