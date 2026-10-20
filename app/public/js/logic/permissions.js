// logic/permissions.js —— 权限档枚举与 tile 规格（与 SDK PermissionMode 对齐）
//
// 红线（拆分后由每个子模块各自承担，原文与 logic.js barrel 同源）：
// 只做数据→数据，不得触碰 DOM / window / socket / 应用可变状态（会话、实例、连接态等）。
// 目的：让浏览器 import 与 tests/unit/logic-*.test.mjs（node:test）共用同一份逻辑，零构建。
// 唯一允许的宿主外 import 是 ../i18n.js（纯查表 + 一个语言开关，node 与浏览器行为一致）；
// 同层 logic/ 子模块之间可以互相 import，但不得成环（npm run check 的 import 边界守卫会拒）。
// 想再加 import 前先自问：新依赖能在裸 node 里被 import 且不碰宿主 API 吗？不能就别加。

import { t, tk } from '../i18n.js';

// ---- 权限档：与 @anthropic-ai/claude-agent-sdk PermissionMode 枚举对齐 ----
// SDK 仅类型层有枚举、无运行时 list；本数组 = 前端显示/校验的权威源，由
// tests/unit/permission-modes-sdk-sync.test.mjs 与 sdk.d.ts + 后端 CCM_PERMISSION_MODES 锁集合。
// 展示顺序：安全档在前，bypassPermissions 置底（危险档）。
//
// 文案不走 i18n：与 CLI / 桌面端菜单同源英文（Manual / Accept edits / Plan / …），
// 协议值仍是 default|acceptEdits|…（manual 是 default 的 CLI 别名）。
export const SDK_PERMISSION_MODES = Object.freeze([
  'default',
  'plan',
  'acceptEdits',
  'dontAsk',
  'auto',
  'bypassPermissions',
]);

export function isSdkPermissionMode(mode) {
  return SDK_PERMISSION_MODES.includes(mode);
}

/**
 * CLI / 桌面端展示名 + 一句话说明。
 * title/pill/bar/selectLabel 固定英文、禁止 t()：对齐桌面菜单 Manual · Accept edits · Plan · Auto · Bypass permissions
 * （dontAsk 桌面菜单常不露出，用 SDK 语义 Don't ask），用户在终端和桌面端看到的就是这些名字。
 * desc 是给人读的说明，跟界面语言走（验收 O43①）：常量表里 tk() 标中文原文，permissionModeTileSpecs 取用时 t()；
 * 英文词典里就是原来那句 SDK 注释级英文。
 */
const PERMISSION_MODE_TILE_META = Object.freeze({
  default: {
    title: 'Manual',
    desc: tk('危险操作前先问你'),
    selectLabel: 'Manual',
    pill: 'Manual',
    bar: 'Manual',
    danger: false,
  },
  plan: {
    title: 'Plan',
    desc: tk('只做规划，不执行工具'),
    selectLabel: 'Plan',
    pill: 'Plan',
    bar: 'Plan',
    danger: false,
  },
  acceptEdits: {
    title: 'Accept edits',
    desc: tk('文件编辑自动通过'),
    selectLabel: 'Accept edits',
    pill: 'Accept edits',
    bar: 'Accept edits',
    danger: false,
  },
  dontAsk: {
    title: "Don't ask",
    desc: tk('没预先放行的一律拒绝，不弹询问'),
    selectLabel: "Don't ask",
    pill: "Don't ask",
    bar: "Don't ask",
    danger: false,
  },
  auto: {
    title: 'Auto',
    desc: tk('由模型分类器决定放行或拒绝'),
    selectLabel: 'Auto',
    pill: 'Auto',
    bar: 'Auto',
    danger: false,
  },
  bypassPermissions: {
    title: 'Bypass permissions',
    desc: tk('跳过所有权限检查'),
    selectLabel: 'Bypass permissions',
    pill: 'Bypass',
    bar: 'Bypass permissions',
    danger: true,
  },
});

/**
 * 按 SDK 清单生成权限磁贴规格（只数据，不碰 DOM）。title/pill/bar 固定英文；desc 已按当前语言翻好，调用方勿再 t()。
 * @param {readonly string[]} [modes=SDK_PERMISSION_MODES]
 * @returns {{ id: string, title: string, desc: string, selectLabel: string, pill: string, bar: string, danger: boolean }[]}
 */
export function permissionModeTileSpecs(modes = SDK_PERMISSION_MODES) {
  const list = Array.isArray(modes) ? modes : SDK_PERMISSION_MODES;
  return list.filter(isSdkPermissionMode).map((id) => {
    const meta = PERMISSION_MODE_TILE_META[id];
    return {
      id,
      title: meta?.title || id,
      desc: meta?.desc ? t(meta.desc) : '',
      selectLabel: meta?.selectLabel || id,
      pill: meta?.pill || id,
      bar: meta?.bar || id,
      danger: Boolean(meta?.danger),
    };
  });
}

// ---- 「永久不再问」的影响面（1b，2026-09-11）----
//
// CLI 在 canUseTool 的 suggestions 里自带 destination；用户点「永久」之前必须知道这条规则
// 会落到哪一层——「只这个工作区」和「所有项目」是完全不同的授权。
//
// ★ 失败方向：**绝不能把影响面说小了**。一批规则里只要有一条是 userSettings，整句话就按
//   userSettings 说。说小了会让用户批准一个他本不会批准的授权；说大了只是啰嗦。
//   因此不认识的 destination 也归到最宽一档，而不是静默当成"不落盘"。
//
// 宽度序：userSettings（所有项目）> projectSettings（本项目，进 git）> localSettings（本工作区）。
// session / cliArg 不落盘，不参与——它们归「本会话内总是允许」那一档。
const PERSIST_SCOPES = ['localSettings', 'projectSettings', 'userSettings'];

/**
 * @param {string[]} [destinations] suggestions 里出现过的 destination
 * @returns {{label: string, hint: string}|null} null = 没有任何会落盘的规则，调用方据此不给「永久」选项
 */
export function describePersistScope(destinations) {
  const list = Array.isArray(destinations) ? destinations : [];
  const persistable = list.filter(d => d !== 'session' && d !== 'cliArg');
  if (!persistable.length) return null;
  // 取最宽的一档。不认识的值按最宽处理（宽度未知时不能猜它窄）。
  const widest = persistable.reduce((acc, d) => {
    const rank = PERSIST_SCOPES.indexOf(d);
    const known = rank >= 0 ? rank : PERSIST_SCOPES.length; // 未知 → 比已知的都宽
    return known > acc ? known : acc;
  }, -1);
  if (widest >= PERSIST_SCOPES.length || widest === PERSIST_SCOPES.indexOf('userSettings')) {
    return { label: t('所有项目'), hint: t('写入 ~/.claude/settings.json，对这台电脑上的每个项目生效') };
  }
  if (widest === PERSIST_SCOPES.indexOf('projectSettings')) {
    return { label: t('本项目'), hint: t('写入项目里的 .claude/settings.json —— 这个文件会进 git，团队其他人也会拿到') };
  }
  return { label: t('本工作区'), hint: t('写入 .claude/settings.local.json，只影响这台电脑上的这个工作区') };
}

// ---- Claude in Chrome 的审批卡片（2026-10-11）----
//
// read_page / find / computer 只带 tabId，光看工具名和参数看不出要动哪个网站。服务端在 CLI 建议的
// session 档规则恰好是「允许这个网站」一条时下发 chromeSite（判据见 agent.js#askPermission），这里把它
// 写成一句话。句式与动作表照抄 CLI 审批框：「Claude in Chrome wants to <动作> on <网站>」，
// 勾选项「Allow all actions on <网站> for this session」。
//
// 表里存 tk() 标记、取用时再 t()：表在 import 阶段求值，早于 setLang()（见 i18n.js 头部）。
const CHROME_TOOL_PREFIX = 'mcp__claude-in-chrome__';
const CHROME_TOOL_ACTIONS = Object.freeze({
  navigate: tk('打开页面'),
  read_page: tk('读取页面'),
  get_page_text: tk('提取页面文字'),
  find: tk('查找页面元素'),
  form_input: tk('填写表单字段'),
  javascript_tool: tk('运行 JavaScript'),
  read_console_messages: tk('读取控制台消息'),
  read_network_requests: tk('读取网络请求'),
  upload_image: tk('上传图片'),
  file_upload: tk('上传文件'),
  select_browser: tk('选择浏览器'),
  gif_creator: tk('录制页面 GIF'),
  shortcuts_execute: tk('运行已保存的浏览器快捷操作'),
  tabs_create_mcp: tk('打开新标签页'),
});
const CHROME_COMPUTER_ACTIONS = Object.freeze({
  screenshot: tk('截图'),
  left_click: tk('点击'),
  right_click: tk('右键点击'),
  middle_click: tk('中键点击'),
  double_click: tk('双击'),
  triple_click: tk('三击'),
  type: tk('输入文字'),
  key: tk('按键'),
  hold_key: tk('按住按键'),
  scroll: tk('滚动页面'),
  scroll_to: tk('滚动到元素'),
  left_click_drag: tk('拖拽'),
  zoom: tk('放大查看'),
  hover: tk('悬停'),
  mouse_move: tk('移动鼠标'),
  left_mouse_down: tk('按下鼠标键'),
  left_mouse_up: tk('松开鼠标键'),
  cursor_position: tk('读取光标位置'),
  wait: tk('等待'),
});
const own = (table, key) => (Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null);

function chromeAction(tool, input) {
  if (tool === 'computer') return own(CHROME_COMPUTER_ACTIONS, input?.action) || tk('使用浏览器');
  if (tool === 'tabs_context_mcp') return input?.createIfEmpty ? tk('新建浏览器窗口并读取你的标签页') : tk('读取你的浏览器标签页');
  // browser_batch 也落到这里：CLI 会把批里各步的动作拼起来，但它先滤掉一批免审的步骤，那份名单不公开，
  // 照拼会和 CLI 说的不一样；批里的每一步卡片正文的参数里都看得到。
  return own(CHROME_TOOL_ACTIONS, tool) || tk('使用浏览器');
}

/**
 * @param {{name: string, input?: object, claudeInChrome?: boolean, chromeSite?: string}} perm permission_request 的 payload
 * @returns {{title: string, alwaysLabel: string|null}|null} null = 不是（核对过来源的）内置 Claude in Chrome；
 *   alwaysLabel 为 null 时调用方保留通用的「总是允许此类操作」——没有网站就说不清勾选放行的是什么
 *
 * 只认服务端的 claudeInChrome 标记，不认工具名前缀：项目 / 插件里配个同名服务器就能拿到同样的前缀，
 * 来源只有服务端看得到（agent.js#askPermission 核对 mcpServer.source）。
 */
export function describeChromePermission({ name, input, claudeInChrome, chromeSite: site } = {}) {
  if (claudeInChrome !== true || typeof name !== 'string' || !name.startsWith(CHROME_TOOL_PREFIX)) return null;
  const action = t(chromeAction(name.slice(CHROME_TOOL_PREFIX.length), input));
  if (!site) return { title: t('Claude in Chrome 想{action}').replace('{action}', () => action), alwaysLabel: null };
  return {
    title: t('Claude in Chrome 想在 {site} 上{action}').replace('{site}', () => site).replace('{action}', () => action),
    alwaysLabel: t('本会话内允许 {site} 上的所有操作').replace('{site}', () => site),
  };
}
