// saved-environments.js —— 新会话页的「环境」：chip、选择 sheet、保存与编辑表单。
// 判据在 logic/saved-environments.js；把环境落到新会话页的动作由 app.js 注入（applyToCompose），它要碰的状态都在那边。
import { t } from '../i18n.js';
import {
  environmentErrorText,
  environmentFromCurrent,
  findMatchingEnvironment,
  formatEnvironmentSummary,
  suggestEnvironmentName,
} from '../logic.js';

const ACK_TIMEOUT_MS = 8000;
const COMPUTER_ICON = 'M9 17.25v1.007a3 3 0 0 1-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0 1 15 18.257V17.25m6-12V15a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 15V5.25m18 0A2.25 2.25 0 0 0 18.75 3H5.25A2.25 2.25 0 0 0 3 5.25';
const BOOKMARK_ICON = 'M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z';
const icon = (path, cls) => `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="${cls}" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="${path}"/></svg>`;

export function createSavedEnvironments({ $, el, socket, openSheet, closeSheet, appConfirm, haptic = () => {}, messagesEl, getCurrent, canSave, applyToCompose }) {
  const modal = $('environmentPickerModal');
  const body = $('environmentPickerBody');
  const title = $('environmentPickerTitle');
  const back = $('environmentPickerBack');
  const status = $('environmentPickerStatus');
  let environments = [];
  let listShown = false; // 列表开着时 refresh 回来才重画，不打断正在填的表单

  const emit = (event, payload) => new Promise(resolve => {
    // 断线时 socket.io 会把事件缓冲到重连后再发：界面已经报了失败，写操作却悄悄生效，再点一次就撞重名
    if (!socket.connected) { resolve({ ok: false, error: 'disconnected' }); return; }
    let settled = false;
    const done = res => { if (!settled) { settled = true; resolve(res); } };
    socket.emit(event, payload, res => done(res || { ok: false }));
    setTimeout(() => done({ ok: false }), ACK_TIMEOUT_MS);
  });

  function setStatus(text) {
    status.textContent = text || '';
    status.classList.toggle('hidden', !text);
  }

  async function refresh() {
    const res = await emit('environments:list');
    if (res.ok) environments = res.environments;
    renderChips();
    if (listShown) showList();
  }

  function renderChips() {
    const host = messagesEl?.querySelector('[data-environment-chips]');
    if (!host) return;
    const current = getCurrent();
    const match = findMatchingEnvironment(environments, current);
    host.innerHTML = '';
    const chip = el(`<button type="button" class="inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-line-soft bg-surface text-ink-soft text-[11px] font-semibold active:scale-[0.98] transition-all" data-testid="compose-environment-chip">
      ${icon(match ? BOOKMARK_ICON : COMPUTER_ICON, 'w-3.5 h-3.5 text-ink-faint shrink-0')}<span class="max-w-[12rem] truncate"></span><span class="text-ink-faint">⌄</span>
    </button>`);
    chip.querySelector('span').textContent = match ? match.name : t('本电脑');
    chip.onclick = e => {
      e.stopPropagation();
      haptic('tap');
      showList();
      openSheet(modal);
      void refresh();
    };
    host.appendChild(chip);
    if (match || !canSave(current.cwd)) return;
    const save = el('<button type="button" class="text-[11px] font-medium text-accent active:opacity-70" data-testid="compose-environment-save"></button>');
    save.textContent = t('保存');
    save.onclick = e => {
      e.stopPropagation();
      haptic('tap');
      showForm(null, { fromList: false });
      openSheet(modal);
    };
    host.appendChild(save);
  }

  function row({ iconPath, name, sub, checked = false, disabled = false, selectTestid = 'environment-select', onSelect, onEdit }) {
    const wrap = el('<div class="flex items-stretch border-b border-line-soft/60" data-testid="environment-row"></div>');
    const main = el(`<button type="button" class="flex-1 min-w-0 text-left px-4 py-2.5 flex items-center gap-3 text-ink hover:bg-sunk/40 active:bg-sunk disabled:opacity-40" data-testid="${selectTestid}">
      ${icon(iconPath, 'w-5 h-5 text-ink-soft shrink-0')}
      <span class="flex-1 min-w-0"><span class="block text-xs font-semibold truncate"></span><span class="block text-[11px] text-ink-faint break-words"></span></span>
      ${checked ? '<span class="text-accent text-sm shrink-0" aria-hidden="true">✓</span>' : ''}
    </button>`);
    const [nameEl, subEl] = main.querySelectorAll('span span');
    nameEl.textContent = name;
    subEl.textContent = sub;
    main.disabled = disabled;
    main.setAttribute('aria-pressed', String(checked));
    main.onclick = onSelect;
    wrap.appendChild(main);
    if (onEdit) {
      const edit = el('<button type="button" class="shrink-0 w-11 flex items-center justify-center text-ink-faint hover:text-ink hover:bg-sunk/40" data-testid="environment-edit">✎</button>');
      edit.setAttribute('aria-label', `${t('编辑环境')} ${name}`);
      edit.onclick = () => { haptic('tap'); showForm(environments.find(e => e.name === name), { fromList: true }); };
      wrap.appendChild(edit);
    }
    return wrap;
  }

  async function select(env) {
    haptic('tap');
    closeSheet(modal);
    await applyToCompose(env);
    renderChips();
  }

  function showList() {
    listShown = true;
    title.textContent = t('选择环境');
    back.classList.add('hidden');
    setStatus('');
    const current = environmentFromCurrent(getCurrent());
    const match = findMatchingEnvironment(environments, current);
    body.replaceChildren(row({
      iconPath: COMPUTER_ICON,
      name: t('本电脑'),
      sub: t('当前文件夹和默认设置'),
      checked: !match,
      selectTestid: 'environment-this-computer',
      onSelect: () => select({ cwd: current.cwd, model: null, effort: null, worktree: false }),
    }));
    for (const env of environments) {
      body.appendChild(row({
        iconPath: BOOKMARK_ICON,
        name: env.name,
        sub: formatEnvironmentSummary(env),
        checked: env.id === match?.id,
        disabled: !env.available,
        onSelect: () => select(env),
        onEdit: true,
      }));
    }
    if (match || !canSave(current.cwd)) return;
    const wrap = el('<div class="p-3"></div>');
    const add = el('<button type="button" class="w-full px-3 py-2 rounded-lg text-xs font-semibold border border-line text-ink hover:bg-sunk active:scale-95" data-testid="environment-new"></button>');
    add.textContent = t('＋ 把当前设置存成环境');
    add.onclick = () => { haptic('tap'); showForm(null, { fromList: true }); };
    wrap.appendChild(add);
    body.appendChild(wrap);
  }

  // env 为 null 是把当前设置存成新环境。名字之外的设置这里不单独改：要改就回新会话页调好，再点「用当前设置更新」
  function showForm(env, { fromList }) {
    listShown = false;
    const current = environmentFromCurrent(getCurrent());
    title.textContent = env ? t('编辑环境') : t('存为环境');
    back.classList.toggle('hidden', !fromList);
    setStatus('');
    const form = el(`<form class="p-4 space-y-3">
      <input type="text" maxlength="60" class="w-full px-2 py-1.5 rounded-lg border border-line bg-surface text-sm text-ink" data-testid="environment-name" autocomplete="off" spellcheck="false">
      <div class="text-[11px] text-ink-faint break-words" data-testid="environment-form-summary"></div>
      <button type="submit" class="w-full px-3 py-2 rounded-lg text-xs font-semibold bg-cta text-white active:brightness-95" data-testid="environment-form-save"></button>
    </form>`);
    const input = form.querySelector('input');
    input.value = env ? env.name : suggestEnvironmentName(current.cwd, environments);
    input.setAttribute('aria-label', t('环境名字'));
    form.querySelector('[data-testid="environment-form-summary"]').textContent = formatEnvironmentSummary(env ?? current);
    form.querySelector('button').textContent = t('保存');

    const done = async () => {
      haptic('success');
      await refresh();
      if (fromList) showList();
      else closeSheet(modal);
    };
    const save = async settings => {
      const { cwd, model, effort, worktree } = settings;
      const res = await emit('environments:save', { ...(env ? { id: env.id } : {}), name: input.value, cwd, model, effort, worktree });
      if (res.ok) await done();
      else setStatus(environmentErrorText(res.error));
    };
    form.onsubmit = ev => {
      ev.preventDefault();
      void save(env ?? environmentFromCurrent(getCurrent())); // 提交时现读：表单开着期间可能重连，当前设置已经变了
    };

    if (env) {
      if (canSave(current.cwd)) {
        const update = el('<button type="button" class="w-full px-3 py-2 rounded-lg text-xs font-semibold border border-line text-ink hover:bg-sunk active:scale-95" data-testid="environment-update"></button>');
        update.textContent = t('用当前设置更新');
        update.onclick = () => { haptic('tap'); void save(environmentFromCurrent(getCurrent())); };
        form.appendChild(update);
      }
      const remove = el('<button type="button" class="w-full px-3 py-2 rounded-lg text-xs font-semibold text-danger hover:bg-sunk active:scale-95" data-testid="environment-delete"></button>');
      remove.textContent = t('删除环境');
      remove.onclick = async () => {
        haptic('tap');
        const ok = await appConfirm({
          title: t('删除环境？'),
          body: t('环境「%s」会从列表里移除，已经开着的会话不受影响。').replace('%s', () => env.name),
          okText: t('删除环境'),
          tone: 'danger',
        });
        if (!ok) return;
        const res = await emit('environments:delete', { id: env.id });
        if (res.ok) await done();
        else setStatus(environmentErrorText(res.error));
      };
      form.appendChild(remove);
    }
    body.replaceChildren(form);
  }

  back.onclick = () => { haptic('tap'); showList(); };
  $('environmentPickerClose').onclick = () => closeSheet(modal);
  modal.onclick = ev => { if (ev.target === modal) closeSheet(modal); };

  return { refresh, renderChips };
}
