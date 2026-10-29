import { t } from '../i18n.js';
import { elicitationContentFromInputs, elicitationHeading, isHostLocalOrigin } from '../logic.js';

// MCP 服务器要表单输入或 URL 授权（#460），对应终端里弹出的 elicitation 表单。
//
// 与提问同为「等你答复」：强拦截 sheet，只能提交 / 拒绝 / 取消（Esc、遮罩都不算取消）。多张排队，一次画一张。
// 字段描述由服务端从 schema 归一后下发，校验也在服务端——这里只照着画、把控件值交上去；不合法时服务端回原因，
// 写在 sheet 里、卡片不关，用户改完再交。schema 超出支持范围时不画表单、不给提交，只能拒绝 / 取消。
// URL 模式：卡片醒目显示完整 origin（防钓鱼）；「在浏览器打开」先在点击里同步 window.open（否则被拦），再回 accept，
// 之后本机这张卡停在「等待完成…」，直到 MCP 服务器确认（system/elicitation_complete 按 elicitationId 对上）或用户手动关。
// 别的设备收到 request_resolved 照常关卡。所有第三方文本（message、标题、字段说明、链接）一律 textContent。
const RESPOND_ACK_TIMEOUT_MS = 10_000;
const SETTLED_CAPACITY = 200;

export function createElicitationSheet(context, {
  $: byId,
  socket,
  openSheet,
  closeSheet,
} = {}) {
  const modal = byId('elicitationModal');
  const heading = byId('elicitationHeading');
  const serverEl = byId('elicitationServer');
  const messageEl = byId('elicitationMessage');
  const descriptionEl = byId('elicitationDescription');
  const form = byId('elicitationForm');
  const urlBox = byId('elicitationUrl');
  const urlOriginEl = byId('elicitationUrlOrigin');
  const urlFullEl = byId('elicitationUrlFull');
  const urlLocalHint = byId('elicitationUrlLocalHint');
  const unsupportedEl = byId('elicitationUnsupported');
  const waitingEl = byId('elicitationWaiting');
  const errorEl = byId('elicitationError');
  const acceptBtn = byId('elicitationAccept');
  const secondary = byId('elicitationSecondary');
  const declineBtn = byId('elicitationDecline');
  const cancelBtn = byId('elicitationCancel');
  const closeBtn = byId('elicitationClose');

  const queue = [];
  const settled = new Set(); // 已结算的 requestId：挡住重连快照 / 回放把它再弹出来
  let active = null;
  let sending = false;
  let suspended = false;

  const markSettled = id => {
    settled.add(id);
    if (settled.size > SETTLED_CAPACITY) settled.delete(settled.values().next().value);
  };
  const showError = text => {
    errorEl.textContent = text || '';
    errorEl.classList.toggle('hidden', !text);
  };
  const syncButtons = () => {
    for (const b of [acceptBtn, declineBtn, cancelBtn]) b.disabled = sending;
  };

  function fieldControl(f) {
    if (f.type === 'boolean') {
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = f.default === true;
      input.className = 'h-4 w-4';
      return input;
    }
    if (f.type === 'enum') {
      const select = document.createElement('select');
      select.className = 'w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink';
      if (!f.required || f.default === undefined) {
        const blank = document.createElement('option');
        blank.value = '';
        blank.textContent = t('请选择');
        select.appendChild(blank);
      }
      for (const o of f.options) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        select.appendChild(opt);
      }
      select.value = f.default ?? '';
      return select;
    }
    const input = document.createElement('input');
    input.className = 'w-full rounded-lg border border-line bg-canvas px-3 py-2 text-sm text-ink';
    input.autocomplete = 'off';
    if (f.type === 'number' || f.type === 'integer') {
      input.type = 'number';
      input.inputMode = f.type === 'integer' ? 'numeric' : 'decimal';
      input.step = f.type === 'integer' ? '1' : 'any';
      if (f.minimum !== undefined) input.min = String(f.minimum);
      if (f.maximum !== undefined) input.max = String(f.maximum);
    } else {
      input.type = { email: 'email', uri: 'url', date: 'date', 'date-time': 'datetime-local' }[f.format] || 'text';
      if (f.maxLength !== undefined) input.maxLength = f.maxLength;
    }
    if (f.default !== undefined) input.value = String(f.default);
    return input;
  }

  function paintForm(fields) {
    form.replaceChildren();
    for (const f of fields) {
      const row = document.createElement('label');
      row.className = f.type === 'boolean' ? 'flex items-start gap-2 text-sm text-ink' : 'block text-sm text-ink space-y-1';
      row.dataset.testid = `elicitation-field-${f.name}`;
      const control = fieldControl(f);
      control.dataset.field = f.name;
      const name = document.createElement('span');
      name.className = 'font-medium';
      name.textContent = (f.title || f.name) + (f.required ? ' *' : '');
      const text = document.createElement('span');
      text.className = 'block';
      text.appendChild(name);
      if (f.description) {
        const desc = document.createElement('span');
        desc.className = 'block text-xs text-ink-soft';
        desc.textContent = f.description;
        text.appendChild(desc);
      }
      if (f.type === 'boolean') row.append(control, text);
      else row.append(text, control);
      form.appendChild(row);
    }
  }

  function readInputs() {
    const raw = {};
    for (const control of form.querySelectorAll('[data-field]')) {
      raw[control.dataset.field] = control.type === 'checkbox' ? control.checked : control.value;
    }
    return raw;
  }

  function paint() {
    const card = active;
    heading.textContent = `🔐 ${elicitationHeading(card)}`;
    serverEl.textContent = t('来自 MCP 服务器：{name}').replace('{name}', card.serverName);
    messageEl.textContent = card.message || '';
    descriptionEl.textContent = card.description || '';
    descriptionEl.classList.toggle('hidden', !card.description);
    const isUrl = card.mode === 'url';
    const waiting = card.waiting === true; // classList.toggle 的第二参是 undefined 时会退化成「翻转」
    const usable = !card.unsupported;
    form.classList.toggle('hidden', isUrl || !usable || waiting);
    if (!isUrl && usable) paintForm(card.fields || []);
    urlBox.classList.toggle('hidden', !isUrl || !usable);
    if (isUrl && usable) {
      urlOriginEl.textContent = card.urlOrigin;
      urlFullEl.textContent = card.url;
      urlLocalHint.classList.toggle('hidden', !isHostLocalOrigin(card.urlOrigin));
    }
    unsupportedEl.textContent = card.unsupported
      ? t('这个请求超出支持范围（{reason}），只能拒绝或取消').replace('{reason}', card.unsupportedReason || '')
      : '';
    unsupportedEl.classList.toggle('hidden', !card.unsupported);
    waitingEl.classList.toggle('hidden', !waiting);
    acceptBtn.textContent = isUrl ? t('在浏览器打开') : t('提交');
    acceptBtn.classList.toggle('hidden', !usable || waiting);
    secondary.classList.toggle('hidden', waiting);
    closeBtn.classList.toggle('hidden', !waiting);
    showError('');
    syncButtons();
  }

  function showNext() {
    if (active || suspended) return;
    active = queue.shift() || null;
    if (!active) return;
    paint();
    openSheet(modal);
  }

  function dropActive() {
    active = null;
    sending = false;
    closeSheet(modal);
  }

  function respond(action) {
    const card = active;
    if (!card || sending || card.waiting) return;
    const payload = { instanceId: card.instanceId, requestId: card.requestId, action };
    if (action === 'accept' && card.mode === 'form') payload.content = elicitationContentFromInputs(card.fields, readInputs());
    if (action === 'accept' && card.mode === 'url') {
      window.open(card.url, '_blank', 'noopener'); // 必须在点击里同步打开，异步回执之后再开会被浏览器拦掉
      card.acceptedHere = true;
    }
    sending = true;
    syncButtons();
    showError('');
    socket.timeout(RESPOND_ACK_TIMEOUT_MS).emit('elicitation:respond', payload, (err, res) => {
      if (active !== card) return; // 回执到之前已被 request_resolved / 清场关掉
      sending = false;
      if (err || !res?.ok) {
        card.acceptedHere = false;
        showError(err ? t('没有响应，请稍后再试') : (res?.error || t('提交失败')));
        syncButtons();
        return;
      }
      markSettled(card.requestId);
      if (card.waiting) return;
      dropActive();
      showNext();
    });
  }

  acceptBtn.addEventListener('click', () => respond('accept'));
  declineBtn.addEventListener('click', () => respond('decline'));
  cancelBtn.addEventListener('click', () => respond('cancel'));
  closeBtn.addEventListener('click', () => { dropActive(); showNext(); });
  form.addEventListener('submit', e => { e.preventDefault(); respond('accept'); });

  const controller = {
    isDuplicate(requestId) {
      return settled.has(requestId) || active?.requestId === requestId || queue.some(c => c.requestId === requestId);
    },
    // instanceId：事件信封上的所属实例，作答回这个实例（同审批 #388）
    enqueue(p, instanceId) {
      queue.push({ ...p, instanceId: instanceId ?? p.instanceId ?? null });
      showNext();
    },
    // request_resolved（kind:'elicitation'）：别的设备答了、过期、中断……一律关卡。
    // 例外是本机刚点了「在浏览器打开」的那张：转入「等待完成…」，等服务器确认或用户手动关。
    resolve(requestId, outcome) {
      markSettled(requestId);
      const idx = queue.findIndex(c => c.requestId === requestId);
      if (idx !== -1) queue.splice(idx, 1);
      if (active?.requestId !== requestId) return;
      if (outcome === 'accept' && active.acceptedHere && active.elicitationId) {
        active.waiting = true;
        paint();
        return;
      }
      dropActive();
      showNext();
    },
    // system/elicitation_complete：MCP 服务器确认 URL 授权已完成
    complete(elicitationId) {
      if (!active?.waiting || !elicitationId || active.elicitationId !== elicitationId) return;
      dropActive();
      showNext();
    },
    clearAll() {
      queue.length = 0;
      if (active) dropActive();
    },
    hasPending() { return Boolean(active && !active.waiting) || queue.length > 0; },
    suspend() {
      if (suspended) return;
      suspended = true;
      if (active) closeSheet(modal);
    },
    resume() {
      if (!suspended) return;
      suspended = false;
      if (active) openSheet(modal);
      else showNext();
    },
  };
  context.state.elicitations = controller;
  return controller;
}
