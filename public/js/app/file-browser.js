/* global CodeMirror */
import { t } from '../i18n.js';

const ICONS = { dir: '📁', file: '📄', symlink: '🔗' };

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// 扩展名 → CM5 MIME（直接用 mode 文件自己 defineMIME 注册的字符串，不拉 meta.js 的全量 200+ 语言表）。
// 只覆盖已 vendor 的 9 个 mode（javascript/xml/htmlmixed/css/markdown/python/shell/yaml/jsx，见
// public/vendor/codemirror/）；未命中回退 null → renderContent 退回纯文本 <pre>，不是错误态。
const CM_MIME_BY_EXT = {
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
  jsx: 'text/jsx', ts: 'application/typescript', tsx: 'text/typescript-jsx',
  json: 'application/json', jsonc: 'application/json', map: 'application/json',
  html: 'text/html', htm: 'text/html',
  xml: 'application/xml', svg: 'application/xml',
  css: 'text/css', less: 'text/x-less', scss: 'text/x-scss',
  md: 'text/markdown', markdown: 'text/markdown', mdx: 'text/markdown',
  py: 'text/x-python', pyw: 'text/x-python',
  sh: 'text/x-sh', bash: 'text/x-sh', zsh: 'text/x-sh',
  yml: 'text/x-yaml', yaml: 'text/x-yaml',
};

export function cmModeForFileName(name) {
  const dot = String(name || '').lastIndexOf('.');
  if (dot < 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return CM_MIME_BY_EXT[ext] || null;
}

export function createFileBrowser(context, {
  baseName = path => String(path || '').split('/').filter(Boolean).pop() || '',
  closeSheet = () => {},
  // 编辑态下经返回/关闭/点背景退出前的二次确认（由 app.js 注入 appConfirm 包装）；默认放行，
  // 免得忘注入时既有测试/调用方静默卡住——真实拦截行为完全靠调用方是否传入靠谱实现。
  confirmDiscardEdit = async () => true,
  createElement,
  haptic = () => {},
  openSheet = () => {},
} = {}) {
  const dom = context.dom;
  const documentRef = context.dependencies.document || globalThis.document;
  let cwd = null;
  let segments = [];
  let mode = 'list';
  let fileName = null;
  let listEntries = [];
  let listOffset = 0;
  let listTruncated = false;
  let listTotal = 0;
  let contentText = '';
  let contentOffset = 0;
  let usedPagination = false; // 一旦分页续读过，本文件全程走 pre 纯文本，不中途切 CM（避免重建/滚动跳动）
  let cmInstance = null;   // 当前 content 视图里活的 CM 实例（只读预览态也是它，编辑态只是切它的 readOnly）
  let editMode = 'view';   // 'view' | 'editing'；离开 content 模式（back/loadContent 新文件）即复位
  let baseHash = null;     // files:write 的冲突基线——来自最近一次 browse:read 或 files:write 成功后的 contentHash

  function relativePath() { return segments.join('/') || '.'; }

  function renderHeader() {
    const rootList = mode === 'list' && segments.length === 0;
    dom.fileBrowseBack?.classList.toggle('hidden', rootList);
    if (!dom.fileBrowsePath) return;
    const parts = [baseName(cwd || '')].concat(segments);
    if (mode === 'content' && fileName) parts.push(fileName);
    dom.fileBrowsePath.textContent = parts.join(' / ');
  }

  function showMessage(text, className) {
    if (!dom.fileBrowseBody) return;
    dom.fileBrowseBody.innerHTML = '';
    const message = documentRef.createElement('div');
    message.className = `p-4 text-xs ${className || 'text-ink-faint'}`;
    message.textContent = text;
    dom.fileBrowseBody.appendChild(message);
  }

  function fetchListPage(requestedPath, offset) {
    context.socket.emit('browse:list', { cwd, relPath: requestedPath, offset }, response => {
      if (mode !== 'list' || relativePath() !== requestedPath) return;
      if (!response?.ok) {
        showMessage(`无法加载：${response?.error || '未知错误'}`, 'text-danger');
        return;
      }
      listEntries = listEntries.concat(response.entries);
      listOffset = offset + response.entries.length;
      listTruncated = response.truncated;
      listTotal = response.totalCount;
      renderList();
    });
  }

  function loadList() {
    mode = 'list';
    listEntries = [];
    listOffset = 0;
    listTruncated = false;
    listTotal = 0;
    renderHeader();
    showMessage(t('加载中…'));
    fetchListPage(relativePath(), 0);
  }

  function renderList() {
    if (!dom.fileBrowseBody) return;
    dom.fileBrowseBody.innerHTML = '';
    if (!listEntries.length) {
      showMessage(t('（空目录）'));
      return;
    }
    for (const entry of listEntries) {
      const row = createElement('<button class="w-full flex items-center gap-2 px-4 py-2.5 border-b border-line-soft text-left hover:bg-sunk/30 active:opacity-70" data-testid="browse-entry"></button>');
      const icon = createElement('<span class="shrink-0 w-5 text-center"></span>');
      icon.textContent = ICONS[entry.kind] || '❔';
      row.appendChild(icon);
      const name = createElement('<span class="flex-1 min-w-0 truncate text-xs text-ink"></span>');
      name.textContent = entry.name;
      row.appendChild(name);
      if (entry.kind === 'file') {
        const size = createElement('<span class="shrink-0 text-[10px] text-ink-faint"></span>');
        size.textContent = formatFileSize(entry.size);
        row.appendChild(size);
      }
      row.onclick = () => {
        haptic('tap');
        openEntry(entry);
      };
      dom.fileBrowseBody.appendChild(row);
    }
    if (listTruncated) {
      const more = createElement('<button class="w-full p-3 text-center text-[11px] text-accent hover:bg-sunk/30 active:opacity-70"></button>');
      more.textContent = `加载更多（已显示 ${listEntries.length}/${listTotal}）`;
      more.onclick = () => {
        haptic('tap');
        fetchListPage(relativePath(), listOffset);
      };
      dom.fileBrowseBody.appendChild(more);
    }
  }

  function openEntry(entry) {
    if (entry.kind === 'dir') {
      segments.push(entry.name);
      loadList();
      return;
    }
    if (entry.kind === 'file') {
      loadContent(entry.name);
      return;
    }
    const requestedPath = segments.concat(entry.name).join('/');
    context.socket.emit('browse:list', { cwd, relPath: requestedPath }, response => {
      if (mode !== 'list' || relativePath() !== segments.join('/')) return;
      if (response?.ok) {
        segments.push(entry.name);
        listEntries = response.entries;
        listOffset = response.entries.length;
        listTruncated = response.truncated;
        listTotal = response.totalCount;
        renderHeader();
        renderList();
      } else {
        loadContent(entry.name);
      }
    });
  }

  function fetchContentPage(requestedPath, offset) {
    context.socket.emit('browse:read', { cwd, relPath: requestedPath, offset }, response => {
      const currentPath = segments.concat(fileName || '').join('/');
      if (mode !== 'content' || currentPath !== requestedPath) return;
      if (!response?.ok) {
        showMessage(`无法加载：${response?.error || '未知错误'}`, 'text-danger');
        return;
      }
      if (response.binary) {
        showMessage(`二进制文件（${formatFileSize(response.totalSize)}），不支持预览`);
        return;
      }
      contentText += response.content;
      contentOffset = offset + (response.bytesRead ?? response.content.length);
      renderContent(response.truncated, response.totalSize, response.contentHash);
    });
  }

  function loadContent(name) {
    mode = 'content';
    fileName = name;
    contentText = '';
    contentOffset = 0;
    usedPagination = false;
    editMode = 'view';
    baseHash = null;
    hideSaveError();
    renderHeader();
    showMessage(t('加载中…'));
    fetchContentPage(segments.concat(name).join('/'), 0);
  }

  function hideSaveError() {
    if (dom.fileBrowseSaveError) { dom.fileBrowseSaveError.classList.add('hidden'); dom.fileBrowseSaveError.textContent = ''; }
  }

  function showSaveError(text) {
    if (!dom.fileBrowseSaveError) return;
    dom.fileBrowseSaveError.textContent = text;
    dom.fileBrowseSaveError.classList.remove('hidden');
  }

  // 三态互斥：可编辑且未在编辑 → 编辑；正在编辑 → 保存+取消。不可编辑（无 baseHash：截断/二进制/纯文本
  // 回退路径）→ 三个都不显，file-browse.js 只读铁律的既有语义在这些场景下原样保留。
  function syncEditButtons() {
    const editable = Boolean(baseHash) && Boolean(cmInstance);
    dom.fileBrowseEdit?.classList.toggle('hidden', !(editable && editMode === 'view'));
    dom.fileBrowseSave?.classList.toggle('hidden', editMode !== 'editing');
    dom.fileBrowseCancelEdit?.classList.toggle('hidden', editMode !== 'editing');
  }

  function enterEditMode() {
    if (!cmInstance || editMode !== 'view') return;
    haptic('tap');
    hideSaveError();
    editMode = 'editing';
    cmInstance.setOption('readOnly', false);
    syncEditButtons();
    cmInstance.focus();
  }

  function exitEditMode() {
    if (editMode !== 'editing') return;
    haptic('tap');
    cmInstance?.setValue(contentText); // 撤销未保存的改动，回到加载/上次保存成功时的内容
    editMode = 'view';
    hideSaveError();
    cmInstance?.setOption('readOnly', 'nocursor');
    syncEditButtons();
  }

  function saveEdit() {
    if (!cmInstance || editMode !== 'editing' || !baseHash) return;
    haptic('tap');
    hideSaveError();
    const newContent = cmInstance.getValue();
    const path = segments.concat(fileName).join('/');
    if (dom.fileBrowseSave) dom.fileBrowseSave.disabled = true;
    context.socket.emit('files:write', { cwd, relPath: path, content: newContent, baseHash }, response => {
      if (dom.fileBrowseSave) dom.fileBrowseSave.disabled = false;
      // 迟到 ack 守卫：保存在途时用户已切走这个文件/关了浏览器，别把结果套到当前视图上。
      if (mode !== 'content' || segments.concat(fileName).join('/') !== path) return;
      if (!response?.ok) {
        showSaveError(response?.error || '保存失败'); // 留在编辑态：冲突/超限等需要用户自己决定下一步，不擅自丢改动
        return;
      }
      contentText = newContent; // 基线随保存前移：取消编辑不会丢刚保存成功的内容
      baseHash = response.contentHash;
      editMode = 'view';
      cmInstance.setOption('readOnly', 'nocursor');
      syncEditButtons();
    });
  }

  function renderContent(truncated, totalSize, contentHash) {
    if (!dom.fileBrowseBody) return;
    dom.fileBrowseBody.innerHTML = '';
    cmInstance = null;
    editMode = 'view';
    baseHash = contentHash || null;
    // CM 只接管「一次性读全」的小文件：分页续读过的文件（>256KB 或用户点过加载更多）全程留在 pre，
    // 避免重建编辑器丢滚动位置；未 vendor 对应语言 / CM 脚本未加载时静默回退，不是错误态。
    // 只读预览 vs 可编辑不区分 mode 判定——两者都要挂 CM 实例，baseHash 有无才是「能不能点编辑」的唯一判据。
    const mime = !usedPagination && !truncated ? cmModeForFileName(fileName) : null;
    if (mime && typeof CodeMirror !== 'undefined') {
      const holder = documentRef.createElement('div');
      holder.className = 'cm-ccm-viewer';
      dom.fileBrowseBody.appendChild(holder);
      cmInstance = CodeMirror(holder, {
        value: contentText,
        mode: mime,
        readOnly: 'nocursor',
        lineNumbers: true,
        lineWrapping: true,
        viewportMargin: Infinity,
      });
      syncEditButtons();
      return;
    }
    syncEditButtons();
    const pre = documentRef.createElement('pre');
    pre.className = 'p-4 text-[11px] leading-relaxed font-mono text-ink whitespace-pre-wrap break-words';
    pre.textContent = contentText;
    dom.fileBrowseBody.appendChild(pre);
    if (truncated) {
      const more = createElement('<button class="w-full p-3 text-center text-[11px] text-accent hover:bg-sunk/30 active:opacity-70 border-t border-line-soft"></button>');
      more.textContent = `加载更多（已显示 ${formatFileSize(contentOffset)}/${formatFileSize(totalSize)}）`;
      more.onclick = () => {
        haptic('tap');
        usedPagination = true; // 哪怕这一页恰好读完全文（truncated 转 false），后续也不再切 CM
        fetchContentPage(segments.concat(fileName).join('/'), contentOffset);
      };
      dom.fileBrowseBody.appendChild(more);
    }
  }

  // 离开 content 视图（回列表 / 换 cwd 重开）：清掉编辑三态与 CM 实例引用，隐藏编辑按钮组——
  // 否则上一个文件的「编辑」按钮会残留可见在列表视图里，或误挂着已失效的 baseHash。
  function resetEditState() {
    cmInstance = null;
    editMode = 'view';
    baseHash = null;
    hideSaveError();
    syncEditButtons();
  }

  // 编辑态下未保存改动才拦；view 态/无改动直接放行，不多问一句。
  async function confirmLeaveIfEditing() {
    if (editMode !== 'editing') return true;
    return confirmDiscardEdit();
  }

  async function back() {
    if (mode === 'content' && !(await confirmLeaveIfEditing())) return;
    haptic('tap');
    if (mode === 'content') {
      fileName = null;
      mode = 'list';
      resetEditState();
      renderHeader();
      renderList();
    } else if (segments.length > 0) {
      segments.pop();
      loadList();
    }
  }

  function open(nextCwd) {
    cwd = nextCwd;
    segments = [];
    mode = 'list';
    fileName = null;
    resetEditState();
    openSheet(dom.fileBrowseModal);
    loadList();
  }

  if (dom.fileBrowseBack) dom.fileBrowseBack.onclick = back;
  if (dom.fileBrowseEdit) dom.fileBrowseEdit.onclick = enterEditMode;
  if (dom.fileBrowseSave) dom.fileBrowseSave.onclick = saveEdit;
  if (dom.fileBrowseCancelEdit) dom.fileBrowseCancelEdit.onclick = exitEditMode;
  if (dom.fileBrowseClose) {
    dom.fileBrowseClose.onclick = async () => {
      if (!(await confirmLeaveIfEditing())) return;
      closeSheet(dom.fileBrowseModal);
    };
  }
  if (dom.fileBrowseModal) {
    dom.fileBrowseModal.onclick = async event => {
      if (event.target !== dom.fileBrowseModal) return;
      if (!(await confirmLeaveIfEditing())) return;
      closeSheet(dom.fileBrowseModal);
    };
  }

  return { back, open };
}
