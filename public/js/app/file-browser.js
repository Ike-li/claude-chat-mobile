const ICONS = { dir: '📁', file: '📄', symlink: '🔗' };

export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function createFileBrowser(context, {
  baseName = path => String(path || '').split('/').filter(Boolean).pop() || '',
  closeSheet = () => {},
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
    showMessage('加载中…');
    fetchListPage(relativePath(), 0);
  }

  function renderList() {
    if (!dom.fileBrowseBody) return;
    dom.fileBrowseBody.innerHTML = '';
    if (!listEntries.length) {
      showMessage('（空目录）');
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
      renderContent(response.truncated, response.totalSize);
    });
  }

  function loadContent(name) {
    mode = 'content';
    fileName = name;
    contentText = '';
    contentOffset = 0;
    renderHeader();
    showMessage('加载中…');
    fetchContentPage(segments.concat(name).join('/'), 0);
  }

  function renderContent(truncated, totalSize) {
    if (!dom.fileBrowseBody) return;
    dom.fileBrowseBody.innerHTML = '';
    const pre = documentRef.createElement('pre');
    pre.className = 'p-4 text-[11px] leading-relaxed font-mono text-ink whitespace-pre-wrap break-words';
    pre.textContent = contentText;
    dom.fileBrowseBody.appendChild(pre);
    if (truncated) {
      const more = createElement('<button class="w-full p-3 text-center text-[11px] text-accent hover:bg-sunk/30 active:opacity-70 border-t border-line-soft"></button>');
      more.textContent = `加载更多（已显示 ${formatFileSize(contentOffset)}/${formatFileSize(totalSize)}）`;
      more.onclick = () => {
        haptic('tap');
        fetchContentPage(segments.concat(fileName).join('/'), contentOffset);
      };
      dom.fileBrowseBody.appendChild(more);
    }
  }

  function back() {
    haptic('tap');
    if (mode === 'content') {
      fileName = null;
      mode = 'list';
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
    openSheet(dom.fileBrowseModal);
    loadList();
  }

  if (dom.fileBrowseBack) dom.fileBrowseBack.onclick = back;
  if (dom.fileBrowseClose) dom.fileBrowseClose.onclick = () => closeSheet(dom.fileBrowseModal);
  if (dom.fileBrowseModal) {
    dom.fileBrowseModal.onclick = event => {
      if (event.target === dom.fileBrowseModal) closeSheet(dom.fileBrowseModal);
    };
  }

  return { back, open };
}
