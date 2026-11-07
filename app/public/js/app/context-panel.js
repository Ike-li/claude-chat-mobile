// 上下文面板：状态栏 ctx 段点进去的独立 sheet。不塞回状态栏展开区：那里对齐 CLI statusline，这里对应 CLI 的 /context。
//
// 打开时先画状态栏现成的数，再要 summary（本地估算，零请求），最后要 full（校准）。两档可能差得不小，
// 所以 summary 的数字必须标「估算」。CLI 驾驶的会话不问实例：web 这边没有在驾驶的进程，只显示 bridge 给的总量。
import { t } from '../i18n.js';
import { compactBlockReason, compactLineText, contextPanelView, usageFromStatusCtx } from '../logic/context-panel.js';

const ACK_MS = { summary: 10_000, full: 25_000 }; // 比服务端的 RPC 超时长：先让服务端说明白
const WHOLE_BAR_TONES = { accent: 'bg-accent', warning: 'bg-warning', danger: 'bg-danger' };
const toneClass = tone => WHOLE_BAR_TONES[tone] ?? `ctx-tone-${tone}`;

export function createContextPanel(context, {
  $: byId,
  el,
  haptic = () => {},
  openSheet,
  closeSheet,
  appConfirm,
  getInstanceId,
  getStatusPayload,
  getCompactState,
  compactSession,
} = {}) {
  const modal = byId('contextModal');
  const used = byId('contextUsed');
  const tokens = byId('contextTokens');
  const bar = byId('contextBar');
  const compactLine = byId('contextCompactLine');
  const compactHint = byId('contextCompactHint');
  const compactBtn = byId('contextCompact');
  const rowsEl = byId('contextRows');
  const listsEl = byId('contextLists');
  const noteEl = byId('contextNote');
  let loadGen = 0; // 关掉再开时，上一次迟到的回包不能盖掉这一次

  function setNote(text) {
    noteEl.textContent = text;
    noteEl.classList.toggle('hidden', !text);
  }

  function rowEl(row) {
    const line = el('<div class="flex items-center gap-2 text-xs" data-testid="context-row"></div>');
    const swatch = el(`<span class="context-swatch ${toneClass(row.tone)}" data-tone="${row.tone}"></span>`);
    const name = el('<span class="flex-1 min-w-0 truncate text-ink-soft"></span>');
    name.textContent = row.name;
    const amount = el('<span class="shrink-0 tabular-nums text-ink"></span>');
    amount.textContent = row.tokens;
    const percent = el('<span class="shrink-0 w-12 text-right tabular-nums text-ink-faint"></span>');
    percent.textContent = row.percent;
    line.append(swatch, name, amount, percent);
    return line;
  }

  function listEl(list, open) {
    const details = el(`<details class="context-list" data-key="${list.key}" data-testid="context-list-${list.key}"></details>`);
    details.open = open;
    const summary = el('<summary></summary>');
    const label = el('<span class="flex-1 min-w-0"></span>');
    label.textContent = list.label;
    const count = el('<span class="shrink-0 tabular-nums text-ink-faint"></span>');
    count.textContent = String(list.count);
    summary.append(label, count);
    const rows = el('<div class="mt-1 pl-3 space-y-1"></div>');
    rows.append(...list.rows.map(row => {
      const line = el('<div class="flex items-baseline gap-2 text-[11px]"></div>');
      const name = el('<span class="flex-1 min-w-0 break-all text-ink-soft"></span>');
      name.textContent = row.name;
      const amount = el('<span class="shrink-0 tabular-nums text-ink-faint"></span>');
      amount.textContent = row.tokens;
      line.append(name, amount);
      return line;
    }));
    details.append(summary, rows);
    return details;
  }

  function paint(usage) {
    const view = contextPanelView(usage);
    used.textContent = view.usedText;
    tokens.textContent = view.tokensText;
    bar.replaceChildren(...view.segments.map(segment => {
      const part = el(`<div class="h-full ${toneClass(segment.tone)}"></div>`);
      part.style.width = `${segment.percent}%`;
      return part;
    }));
    compactLine.textContent = compactLineText(usage);
    rowsEl.classList.toggle('hidden', !view.rows.length);
    rowsEl.replaceChildren(...view.rows.map(rowEl));
    // summary 换 full 时整段重画，用户展开的列表要留着
    const opened = new Set([...listsEl.querySelectorAll('details[open]')].map(node => node.dataset.key));
    listsEl.classList.toggle('hidden', !view.lists.length);
    listsEl.replaceChildren(...view.lists.map(list => listEl(list, opened.has(list.key))));
  }

  function paintCompactState(canCompact) {
    const reason = canCompact ? compactBlockReason(getCompactState()) : '';
    compactBtn.classList.toggle('hidden', !canCompact);
    compactBtn.disabled = Boolean(reason);
    compactHint.textContent = reason;
    compactHint.classList.toggle('hidden', !reason);
  }

  const ask = detail => new Promise(resolve => {
    context.socket.timeout(ACK_MS[detail]).emit('context:usage', { instanceId: getInstanceId(), detail }, (err, res) => {
      resolve(err ? null : res);
    });
  });

  async function load(gen) {
    setNote(t('加载中…'));
    const summary = await ask('summary');
    if (gen !== loadGen) return;
    if (!summary) return setNote(t('拿不到明细：后端可能还没重启'));
    if (!summary.ok) {
      return setNote(summary.code === 'unavailable'
        ? t('这个会话现在没有运行中的进程，这里只能看到总量。')
        : t('暂时拿不到明细，过一会再打开试试。'));
    }
    paint(summary);
    setNote(t('估算值，精确数据加载中…'));
    const full = await ask('full');
    if (gen !== loadGen) return;
    if (!full?.ok) return setNote(t('这是估算值，精确数据没拿到。'));
    paint(full);
    setNote('');
  }

  function open() {
    const gen = ++loadGen;
    const payload = getStatusPayload();
    const cliDriven = payload?.source?.kind === 'cli';
    listsEl.replaceChildren();
    paint(usageFromStatusCtx(payload?.ctx));
    paintCompactState(!cliDriven);
    openSheet(modal);
    if (cliDriven) setNote(t('会话正在电脑终端运行，这里只能看到总量。'));
    else void load(gen);
  }

  function close() {
    loadGen += 1;
    if (modal.classList.contains('sheet-open')) closeSheet(modal);
  }

  byId('contextClose').addEventListener('click', close);
  modal.addEventListener('click', e => { if (e.target === modal) close(); });
  modal.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  compactBtn.addEventListener('click', async () => {
    haptic('tap');
    const ok = await appConfirm({
      title: t('压缩会话？'),
      body: t('把对话总结成摘要以腾出上下文。压缩本身要消耗额度。'),
      okText: t('压缩'),
    });
    if (!ok) return;
    // 确认框弹着时状态可能变了：附件异步读完落进托盘、回合开跑、审批到了。附件这条 send() 不挡，会跟着 /compact 发走
    if (compactBlockReason(getCompactState())) {
      paintCompactState(true);
      return;
    }
    close();
    compactSession();
  });

  return { open };
}
