import { t } from '../i18n.js';

// 工作区子树顶部的会话搜索框。必须活在 renderRows 的 innerHTML 销毁范围之外：
// 输入框若随结果列表一起重建，debounce 到期就会丢掉焦点 / IME 组词 / 手机键盘。

const WRAP_TESTID = 'session-search-wrap';
const ROWS_TESTID = 'session-rows';
const DEBOUNCE_MS = 200;

export function bindSessionSearchInput(container, {
  cwd,
  getQuery = () => '',
  setQuery = () => {},
  onDebouncedQuery = () => {},
  el,
  doc = document,
} = {}) {
  let wrap = container.querySelector(`:scope > [data-testid="${WRAP_TESTID}"]`);
  if (wrap) {
    const input = wrap.querySelector('[data-testid="session-search"]');
    syncSearchInputValue(input, getQuery(cwd), doc);
    return input;
  }

  wrap = el(`<div class="px-3 py-2 border-b border-line-soft/40" data-testid="${WRAP_TESTID}"></div>`);
  const input = el(`<input type="search" data-testid="session-search" class="w-full rounded-lg border border-line bg-sunk/40 px-3 py-1.5 text-xs text-ink placeholder:text-ink-faint focus:outline-none focus:border-accent" placeholder="${t('搜索会话')}" autocomplete="off" enterkeyhint="search" />`);
  let composing = false;
  let timer = null;
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => {
    composing = false;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  input.addEventListener('input', (e) => {
    if (composing || e.isComposing) return;
    setQuery(cwd, input.value);
    clearTimeout(timer);
    timer = setTimeout(() => onDebouncedQuery(cwd), DEBOUNCE_MS);
  });
  wrap.appendChild(input);
  container.insertBefore(wrap, container.firstChild);
  const mapped = getQuery(cwd) || '';
  if (mapped) input.value = mapped;
  return input;
}

export function bindSessionRowsHost(container, el) {
  let host = container.querySelector(`:scope > [data-testid="${ROWS_TESTID}"]`);
  if (!host) {
    host = el(`<div data-testid="${ROWS_TESTID}"></div>`);
    container.appendChild(host);
  }
  return host;
}

function syncSearchInputValue(input, mapped, doc) {
  if (!input) return;
  const next = mapped || '';
  // 聚焦时用户正在打字，不能用 map 里的旧值覆盖；未聚焦（SWR/外部改 query）才同步。
  if (doc.activeElement === input) return;
  if (input.value !== next) input.value = next;
}
