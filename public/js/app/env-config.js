// 服务与配置面板：在手机上改 .env。
//
// 为什么值得有：ccm 的主界面在手机上，而改 .env 只能上电脑 —— 40 个配置项里绝大多数手机用户
// 永远碰不到。与 hooks:setup 同一心智（那个开的是「写用户全局 settings.json」的口子）。
//
// ## 三条不变量
//   1. **表单结构全部来自服务端**（env:get 的 ack）。前端一个配置项的名字都不硬编码 ——
//      src/ops/env-schema.js 是单一事实源，加一项只改那一个文件。
//      （模块边界也不允许前端 import src/，见 check-import-boundaries.js 的 frontend-no-backend。）
//   2. **敏感项永远拿不到明文**：服务端只下发 { set, length }，UI 显示「已设置（N 字符）」。
//      要换值得先点「更换」换出一个空输入框 —— 空输入框提交空串是「清空」，不是「没改」。
//   3. **只提交真正改动过的项**。全量提交会把敏感项的遮罩文案当成新值写回去。
//
// 渲染全走 DOM API 不拼 innerHTML：文案里有中文标点与括号，拼字符串迟早要在转义上翻车。

const CHANGED_MARK = 'data-ccm-dirty';

export function createEnvConfigPanel({
  $, socket, openSheet, closeSheet, appConfirm, pickText, onSaved,
  // 打开前的钩子：收掉可能还开着的通用设置 sheet，否则两层 sheet 叠着、上层拦掉下层的点击
  // （E2E 实测：generalSheet 的 label 会 intercept pointer events）。
  // **必须走这个参数而不是在 app.js 侧包装 open()** —— 同 settings.js 里 onOpen 的理由：
  // 包装只覆盖到「点按钮」这一条入口，程序化调用 open() 就绕过去了。
  beforeOpen,
}) {
  const modal = $('envConfigModal');
  const body = $('envConfigBody');
  const footer = $('envConfigFooter');
  const hint = $('envConfigHint');
  const saveBtn = $('envConfigSave');

  // key → { el, kind, original, isSecret, replacing }
  let fields = new Map();
  let loading = false;

  const text = (pair) => (pair ? pickText(pair) : '');

  function el(tag, cls, txt) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (txt !== undefined) node.textContent = txt;
    return node;
  }

  function markDirty() {
    const dirty = [...fields.values()].some((f) => f.el.getAttribute(CHANGED_MARK) === '1');
    saveBtn.disabled = !dirty;
    hint.textContent = dirty ? '保存后需重启服务才生效' : '';
  }

  function watch(input, field) {
    const onInput = () => {
      const changed = field.replacing ? true : input.value !== field.original;
      input.setAttribute(CHANGED_MARK, changed ? '1' : '0');
      markDirty();
    };
    input.addEventListener('input', onInput);
    input.addEventListener('change', onInput);
  }

  function buildToggle(item, field) {
    const wrap = el('label', 'flex items-center gap-2 cursor-pointer');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'w-4 h-4 accent-[var(--accent)]';
    box.checked = item.value === item.values.on;
    box.dataset.key = item.key;
    box.setAttribute(CHANGED_MARK, '0');
    // 真值字面量逐 key 不同（'1' / 'off' / 'on'）—— 由服务端下发，前端绝不自己猜。
    // 猜错的后果见 src/ops/log-terminal.js:32 那个经典脚枪：写 'false' 反而是「开」。
    box.addEventListener('change', () => {
      const next = box.checked ? item.values.on : item.values.off;
      box.setAttribute(CHANGED_MARK, next === field.original ? '0' : '1');
      markDirty();
    });
    field.read = () => (box.checked ? item.values.on : item.values.off);
    field.el = box;
    wrap.append(box, el('span', 'text-xs text-ink', text(item.label)));
    return wrap;
  }

  function buildSecret(item, field, row) {
    const state = el('div', 'flex items-center gap-2');
    const masked = item.masked || { set: false, length: 0 };
    state.append(el('span', 'text-xs text-ink-soft',
      masked.set ? `已设置（${masked.length} 字符）` : '未设置'));

    // 本函数统一自己往 row 上挂，不靠返回值 —— 早前两个分支都是 return 出去而调用方丢掉了，
    // 结果只读敏感项整块不渲染（AUTH_TOKEN 的「已设置（N 字符）」根本不出现）。E2E 抓到的。
    if (item.readonly) {
      state.append(el('span', 'text-[10px] text-ink-faint', '只读'));
      field.el = state;
      field.read = () => undefined; // 只读项永不进 changes
      row.append(state);
      return state;
    }

    const btn = el('button', 'hit-44 px-2 py-1 rounded-lg border border-line text-[11px] text-ink-soft active:bg-sunk', '更换');
    btn.type = 'button';
    const input = document.createElement('input');
    input.type = 'password';
    input.className = 'hidden w-full mt-1 px-2 py-1.5 rounded-lg border border-line bg-sunk text-xs text-ink';
    input.dataset.key = item.key;
    input.setAttribute(CHANGED_MARK, '0');
    input.placeholder = '输入新值（留空 = 清除该项）';

    btn.addEventListener('click', () => {
      // 点了「更换」就进入替换态：此后即使留空也算一次改动（空 = 清除），
      // 否则「我想删掉这个 token」这个意图没法表达。
      field.replacing = true;
      input.classList.remove('hidden');
      input.setAttribute(CHANGED_MARK, '1');
      btn.classList.add('hidden');
      input.focus();
      markDirty();
    });

    field.el = input;
    field.read = () => (field.replacing ? (input.value === '' ? null : input.value) : undefined);
    state.append(btn);
    // 两个都要挂进 row —— 早前只 append(state) 而把 input 当返回值丢了，
    // 结果「更换」点了没反应（输入框根本不在 DOM 里）。E2E 抓到的。
    row.append(state, input);
    return input;
  }

  function buildInput(item, field) {
    const input = document.createElement('input');
    input.type = item.kind === 'number' ? 'number' : 'text';
    if (item.kind === 'number') {
      if (item.min !== undefined) input.min = String(item.min);
      if (item.max !== undefined) input.max = String(item.max);
    }
    input.value = item.value ?? '';
    input.className = 'w-full px-2 py-1.5 rounded-lg border border-line bg-sunk text-xs text-ink disabled:opacity-60';
    input.dataset.key = item.key;
    input.disabled = !!item.readonly;
    input.setAttribute(CHANGED_MARK, '0');
    if (item.default !== undefined) input.placeholder = `默认 ${item.default}`;
    field.el = input;
    // 空串 = 清除该项（服务端会整行删掉）。原本就是空的则视为没改。
    field.read = () => (input.value === '' ? null : input.value);
    watch(input, field);
    return input;
  }

  function renderItem(item) {
    const row = el('div', 'space-y-1');
    const field = { key: item.key, original: item.value ?? '', replacing: false, isSecret: !!item.secret };

    if (item.kind === 'toggle') {
      row.append(buildToggle(item, field));
    } else {
      const head = el('div', 'flex items-baseline gap-2');
      head.append(el('div', 'text-xs text-ink flex-1 min-w-0', text(item.label)));
      head.append(el('code', 'text-[10px] text-ink-faint shrink-0', item.key));
      row.append(head);
      if (item.secret) buildSecret(item, field, row);
      else row.append(buildInput(item, field));
    }

    const help = text(item.help);
    if (help) row.append(el('div', 'text-[10px] text-ink-faint leading-relaxed', help));
    fields.set(item.key, field);
    return row;
  }

  function render(view) {
    body.replaceChildren();
    fields = new Map();

    for (const group of view.groups || []) {
      const sec = el('section', 'space-y-2.5');
      sec.append(el('div', 'text-xs font-semibold text-ink-soft', text(group.label)));
      for (const item of group.items || []) sec.append(renderItem(item));
      body.append(sec);
    }

    // 只读诊断：不是表单，是「这些为什么改不了」的解释。少了它，用户会以为面板漏了 ANTHROPIC_*。
    if (view.readonlyDiagnostics?.length) {
      const sec = el('section', 'space-y-2 pt-2 border-t border-line');
      sec.append(el('div', 'text-xs font-semibold text-ink-soft', '此处不可改'));
      for (const d of view.readonlyDiagnostics) {
        const row = el('div', 'space-y-0.5');
        row.append(el('div', 'text-xs text-ink', `${text(d.label)}（${d.key}）`));
        row.append(el('div', 'text-[10px] text-ink-faint leading-relaxed', text(d.help)));
        sec.append(row);
      }
      body.append(sec);
    }

    footer.classList.remove('hidden');
    saveBtn.disabled = true;
    hint.textContent = '';
  }

  // 只收集真正改动过的项 —— 全量提交会把敏感项的遮罩文案当成新值写回去。
  function collectChanges() {
    const changes = {};
    for (const [key, field] of fields) {
      if (!field.el || field.el.getAttribute?.(CHANGED_MARK) !== '1') continue;
      const value = field.read();
      if (value === undefined) continue;
      changes[key] = value;
    }
    return changes;
  }

  function showResults(results, title) {
    const box = el('div', 'p-2.5 rounded-xl border border-line bg-sunk space-y-1');
    box.append(el('div', 'text-xs font-semibold text-ink', title));
    for (const r of results || []) {
      const line = el('div', `text-[11px] ${r.level === 'error' ? 'text-danger' : 'text-warn'}`);
      line.textContent = r.key ? `${r.key}：${r.message}` : r.message;
      box.append(line);
    }
    body.prepend(box);
    body.scrollTop = 0;
  }

  async function save() {
    const changes = collectChanges();
    if (Object.keys(changes).length === 0) return;
    saveBtn.disabled = true;

    const send = (acceptWarnings) => new Promise((resolve) => {
      socket.emit('env:set', { changes, acceptWarnings }, resolve);
    });

    let res = await send(false);
    if (res?.needsConfirm) {
      const lines = (res.results || []).filter((r) => r.level === 'warn').map((r) => r.message).join('\n');
      const okToGo = await appConfirm(`${lines}\n\n仍然保存？`, { tone: 'warn' });
      if (!okToGo) {
        saveBtn.disabled = false;
        return;
      }
      res = await send(true);
    }

    if (!res?.ok) {
      showResults(res?.results, '保存失败，一项都没写入');
      saveBtn.disabled = false;
      return;
    }

    // 全或无：走到这里说明整批都写进去了。
    hint.textContent = `已写入 ${res.written?.length ?? 0} 项，需重启服务才生效`;
    saveBtn.disabled = true;
    onSaved?.(res);
  }

  function open() {
    if (!modal || loading) return;
    beforeOpen?.();
    loading = true;
    body.replaceChildren(el('div', 'text-xs text-ink-soft', '读取中…'));
    footer.classList.add('hidden');
    openSheet(modal);
    socket.emit('env:get', {}, (res) => {
      loading = false;
      if (!res?.ok) {
        body.replaceChildren(el('div', 'text-xs text-danger', '读取配置失败'));
        return;
      }
      render(res);
    });
  }

  function close() {
    if (modal) closeSheet(modal);
  }

  function bind() {
    const trigger = $('btnEnvConfig');
    if (trigger) trigger.onclick = open;
    const closeBtn = $('envConfigClose');
    if (closeBtn) closeBtn.onclick = close;
    if (modal) modal.onclick = (e) => { if (e.target === modal) close(); };
    if (saveBtn) saveBtn.onclick = save;
  }

  return { bind, open, close };
}
