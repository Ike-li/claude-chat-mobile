// app/host-mcp.js —— 「宿主机上的 claude」段的 MCP 服务器卡片（#457），对应终端 /mcp。
//
// 状态现查：进「宿主机」页时拉一次 mcp:status，每次重连 / 启停之后再拉一次。不定时轮询：MCP 状态不常变。
// 拿不到现查结果（没有活实例、终端驾驶的只读镜像、超时）就退回 init 快照：标「快照」、不出按钮。
// 停用是持久写入（CLI 写项目配置，与终端 /mcp 同效），先过确认 sheet；启用不确认。
// 名字是用户 / 插件写的配置键，错误来自 CLI：一律 textContent，不经 innerHTML。

import { t } from '../i18n.js';
import { formatMcpServers } from '../logic.js';

const TONE_CLASS = { ok: 'text-success', muted: 'text-ink-faint', bad: 'text-danger' };
// 服务端重连 / 启停套的是控制请求超时（10s）；这里多留一截，免得服务端还在等、前端先报了失败
const ACTION_TIMEOUT_MS = 15_000;

function node(tag, className = '', text = '') {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text) n.textContent = text;
  return n;
}

export function createHostMcp({ emit, appConfirm, getInstanceId, getSnapshot, onChange }) {
  let live = null;              // { instanceId, servers }：现查结果，只对拉取时的那个实例有效
  const rowErrors = new Map();  // name → 上一次处置失败的原因
  const busy = new Set();       // 正在处置的名字

  function view() {
    const servers = live && live.instanceId === getInstanceId() ? live.servers : null;
    return { mcp: formatMcpServers(servers ?? getSnapshot()), live: Boolean(servers) };
  }

  async function refresh() {
    const instanceId = getInstanceId();
    const res = await emit('mcp:status', { instanceId });
    if (live?.instanceId !== instanceId) rowErrors.clear();
    live = res?.ok === true && res.live === true && Array.isArray(res.servers) ? { instanceId, servers: res.servers } : null;
    onChange();
  }

  async function act(name, event, payload) {
    busy.add(name);
    rowErrors.delete(name);
    onChange();
    const res = await emit(event, { ...payload, name, instanceId: live?.instanceId ?? getInstanceId() }, ACTION_TIMEOUT_MS);
    busy.delete(name);
    if (res?.ok !== true) rowErrors.set(name, res?.error || t('操作失败'));
    await refresh();
  }

  async function toggle(name, enable) {
    if (!enable && !(await appConfirm({
      title: t('停用这个 MCP 服务器？'),
      body: `${name}\n${t('对本项目持久生效，与终端 /mcp 相同：之后新开的会话也不再加载它。')}`,
      okText: t('停用'),
      tone: 'danger',
    }))) return;
    await act(name, 'mcp:toggle', { enabled: enable });
  }

  function button(action, text, name, onClick) {
    const b = node('button', 'shrink-0 px-2 py-0.5 rounded-lg border border-line text-ink-soft active:bg-sunk disabled:opacity-50', text);
    b.type = 'button';
    b.dataset.mcpAction = action;
    b.disabled = busy.has(name);
    b.onclick = onClick;
    return b;
  }

  // 没有任何服务器 → null（调用方据此决定整段隐不隐藏）
  function renderCard() {
    const { mcp, live: isLive } = view();
    if (!mcp) return null;
    const card = node('div', 'p-2.5 rounded-xl border border-line bg-surface text-xs');
    const head = node('div', 'font-semibold text-ink', `${t('MCP 服务器')} · ${mcp.total} ${t('个')}${isLive ? '' : ` · ${t('快照')}`}`);
    card.appendChild(head);
    if (!isLive) card.appendChild(node('div', 'text-ink-faint mt-0.5', t('会话启动时的状态；开着会话时才能现查、重连和启停')));
    const list = node('div', 'mt-1.5 space-y-1.5');
    for (const item of mcp.items) {
      const row = node('div', 'flex items-start gap-1.5');
      row.dataset.mcpName = item.name;
      const dot = node('span', TONE_CLASS[item.tone], '●');
      dot.setAttribute('aria-hidden', 'true');
      const main = node('div', 'flex-1 min-w-0');
      const line = node('div', 'break-words');
      line.appendChild(node('span', 'text-ink', item.name));
      if (item.label) line.appendChild(node('span', 'text-ink-faint', `（${item.label}）`));
      main.appendChild(line);
      const error = rowErrors.get(item.name) || item.error;
      if (error) main.appendChild(node('div', 'text-danger break-words', error));
      if (item.needsAuth) main.appendChild(node('div', 'text-ink-faint', t('需在电脑上完成授权')));
      row.append(dot, main);
      if (isLive) {
        if (item.reconnect) row.appendChild(button('reconnect', t('重连'), item.name, () => act(item.name, 'mcp:reconnect', {})));
        row.appendChild(button('toggle', item.enabled ? t('停用') : t('启用'), item.name, () => toggle(item.name, !item.enabled)));
      }
      list.appendChild(row);
    }
    card.appendChild(list);
    return card;
  }

  return { refresh, renderCard };
}
