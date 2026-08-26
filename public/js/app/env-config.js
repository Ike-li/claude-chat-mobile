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

import { t } from '../i18n.js';

const CHANGED_MARK = 'data-ccm-dirty';

export function createEnvConfigPanel({
  $, socket, openSheet, closeSheet, appConfirm, pickText, onSaved,
  // 「本进程停了有没有人拉起来」——由服务端经 instances 广播下发（DEV_MODE 或有进程管理器
  // 托管）。false 时不显示重启入口：停掉一个没人会拉起的进程等于让用户自断退路，
  // 而 headless 的 npm start 正是这种形态。
  canRestart = () => false,
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
    hint.textContent = dirty ? t('保存后需重启服务才生效') : '';
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
      masked.set ? t('已设置（N 字符）').replace('N', String(masked.length)) : t('未设置')));

    // 本函数统一自己往 row 上挂，不靠返回值 —— 早前两个分支都是 return 出去而调用方丢掉了，
    // 结果只读敏感项整块不渲染（AUTH_TOKEN 的「已设置（N 字符）」根本不出现）。E2E 抓到的。
    if (item.readonly) {
      state.append(el('span', 'text-[10px] text-ink-faint', t('只读')));
      field.el = state;
      field.read = () => undefined; // 只读项永不进 changes
      row.append(state);
      return state;
    }

    const btn = el('button', 'hit-44 px-2 py-1 rounded-lg border border-line text-[11px] text-ink-soft active:bg-sunk', t('更换'));
    btn.type = 'button';
    const input = document.createElement('input');
    input.type = 'password';
    input.className = 'hidden w-full mt-1 px-2 py-1.5 rounded-lg border border-line bg-sunk text-xs text-ink';
    input.dataset.key = item.key;
    input.setAttribute(CHANGED_MARK, '0');
    input.placeholder = t('输入新值（留空 = 清除该项）');

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
    if (item.default !== undefined) input.placeholder = t('默认 V').replace('V', String(item.default));
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

    // 这一行的值来自配置文件，而 shell 环境变量恒压过配置文件 —— 不标出来的话，被压住的行
    // 与正常行长得一模一样：用户改完、保存成功、运行时仍是旧值，屏幕上零症状（VC-D4-02）。
    // 服务端只下发布尔（键名级），**绝不下发 env 的值**：被压住的可能正是 AUTH_TOKEN / VAPID 私钥。
    // 只标注不禁用输入：unset 掉那个环境变量之后，这里写的值仍然是要生效的。
    if (item.overriddenByEnv) {
      row.append(el('div', 'text-[10px] text-warning leading-relaxed',
        t('⚠ 已被环境变量覆盖 —— 运行时用的是 shell 里的值，在这里改不会生效')));
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
      sec.append(el('div', 'text-xs font-semibold text-ink-soft', t('此处不可改')));
      for (const d of view.readonlyDiagnostics) {
        const row = el('div', 'space-y-0.5');
        row.append(el('div', 'text-xs text-ink', `${text(d.label)}（${d.key}）`));
        row.append(el('div', 'text-[10px] text-ink-faint leading-relaxed', text(d.help)));
        sec.append(row);
      }
      body.append(sec);
    }

    // 清掉上一次保存留下的「立即重启」——它插在 footer 里，而 render() 只重建 body。
    // 不清的话：保存一次 → 关面板 → 重开，会看到一个 disabled 的「重启中…」，
    // 而用户这次根本没保存过任何东西（Playwright 实证过）。
    footer.querySelector('#envConfigRestart')?.remove();
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

  // fallback 是必须的：服务端有两条路径只给 error 不给 results —— socket.js 的 catch-all
  // 与「设备未批准」。只渲染 results 的话，那两种情况下用户看到的是一个**只有标题、正文全空**
  // 的失败框，零解释。
  function showResults(results, title, fallback) {
    const box = el('div', 'p-2.5 rounded-xl border border-line bg-sunk space-y-1');
    box.append(el('div', 'text-xs font-semibold text-ink', title));
    const list = Array.isArray(results) ? results : [];
    for (const r of list) {
      const line = el('div', `text-[11px] ${r.level === 'error' ? 'text-danger' : 'text-warning'}`);
      line.textContent = r.key ? `${r.key}：${r.message}` : r.message;
      box.append(line);
    }
    if (list.length === 0) {
      box.append(el('div', 'text-[11px] text-danger', fallback || t('服务端没有给出原因')));
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
      // appConfirm 收的是**对象**（public/js/app/sheets.js:102 解构 { title, body, okText, tone }）。
      // 这里曾经传字符串 + 第二个参数：解构字符串原始值不报错，只是每个字段都是 undefined，
      // 而 textContent = undefined 会落成空串（DOMString? 先把 undefined 转成 null），
      // 于是弹出来的是一个**标题空、正文被 hidden 隐藏**的框——只有两个按钮，警告原文全丢。
      // 用户就这样把公网 2FA 关掉了。tone 也必须是 CONFIRM_TONES 里有的值，'warn' 不是。
      const okToGo = await appConfirm({
        title: t('保存前请确认'),
        body: `${lines}\n\n${t('仍然保存？')}`,
        okText: t('仍然保存'),
        tone: 'warning',
      });
      if (!okToGo) {
        saveBtn.disabled = false;
        return;
      }
      res = await send(true);
    }

    if (!res?.ok) {
      showResults(res?.results, t('保存失败，一项都没写入'), res?.error);
      saveBtn.disabled = false;
      return;
    }

    // 全或无：走到这里说明整批都写进去了。
    const n = res.written?.length ?? 0;
    saveBtn.disabled = true;
    onSaved?.(res);

    // 配置只写进了文件，进程里还是旧值 —— 不给重启入口的话这条路就断在最后一步。
    if (!canRestart()) {
      hint.textContent = t('已写入 N 项。需要重启服务才生效（本进程不是常驻托管，请到电脑上重启）').replace('N', String(n));
      return;
    }
    hint.textContent = t('已写入 N 项，重启后生效').replace('N', String(n));
    const btn = el('button', 'hit-44 px-3 py-2 rounded-xl border border-line text-xs text-ink active:bg-sunk', t('立即重启'));
    btn.type = 'button';
    btn.id = 'envConfigRestart';
    btn.onclick = async () => {
      // 同上：必须传对象。这一条更要紧——它确认的是「中断所有在跑的会话与后台任务」，
      // 而空白确认框只会让人直接点确定。破坏性动作用 danger 而非 warning。
      const okToRestart = await appConfirm({
        title: t('立即重启服务'),
        body: t('重启会中断所有正在跑的会话。继续？'),
        okText: t('重启'),
        tone: 'danger',
      });
      if (!okToRestart) return;
      btn.disabled = true;
      btn.textContent = t('重启中…');
      socket.emit('dev:restart', {}, (r) => {
        // 成功的话 socket 很快会断、自动重连；失败要如实说，别让按钮一直转
        if (r && r.ok === false) {
          btn.disabled = false;
          btn.textContent = t('立即重启');
          hint.textContent = r.error || t('重启被拒绝');
        }
      });
    };
    footer.querySelector('#envConfigRestart')?.remove();
    footer.insertBefore(btn, saveBtn);
  }

  function open() {
    if (!modal || loading) return;
    beforeOpen?.();
    loading = true;
    body.replaceChildren(el('div', 'text-xs text-ink-soft', t('读取中…')));
    footer.classList.add('hidden');
    openSheet(modal);
    socket.emit('env:get', {}, (res) => {
      loading = false;
      if (!res?.ok) {
        body.replaceChildren(el('div', 'text-xs text-danger', `${t('读取配置失败：')}${res?.error || t('服务端没有给出原因')}`));
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
