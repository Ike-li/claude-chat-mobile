// git-changes.js —— 工作区 git 变更只读面板（staged / unstaged / untracked）
// 与 file-browser 同骨架：bottom sheet + 懒加载详情；diff 用 textContent 防 XSS。
import { t } from '../i18n.js';

// title 存中文原文、到渲染时才 t()：模块顶层常量在 import 阶段就求值，那时 app.js 还没跑到 setLang()，
// 在这里直接 t() 会把界面语言永久钉死成 zh。
const SECTION_META = [
  { key: 'staged', title: '已暂存', side: 'staged' },
  { key: 'unstaged', title: '未暂存', side: 'unstaged' },
  { key: 'untracked', title: '未跟踪', side: null },
];

export function renderPatchLines(patch, createElement) {
  const frag = document.createDocumentFragment
    ? document.createDocumentFragment()
    : { children: [], appendChild(n) { this.children.push(n); } };
  const lines = String(patch || '').split('\n');
  for (const line of lines) {
    const pre = createElement('<pre class="overflow-x-auto whitespace-pre-wrap break-words rounded px-2 py-0.5 text-[11px] font-mono leading-snug"></pre>');
    pre.textContent = line || ' ';
    if (line.startsWith('+') && !line.startsWith('+++')) {
      pre.style.background = 'rgba(61,138,80,.12)';
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      pre.style.background = 'rgba(188,67,52,.12)';
    } else if (line.startsWith('@@')) {
      pre.classList.add('text-ink-faint');
    }
    frag.appendChild(pre);
  }
  return frag;
}

export function createGitChangesPanel(context, {
  closeSheet = () => {},
  createElement,
  haptic = () => {},
  openSheet = () => {},
} = {}) {
  const dom = context.dom;
  const documentRef = context.dependencies.document || globalThis.document;
  let cwd = null;
  let loadToken = 0;

  function showMessage(text, className) {
    if (!dom.gitChangesBody) return;
    dom.gitChangesBody.innerHTML = '';
    const message = documentRef.createElement('div');
    message.className = `p-4 text-xs ${className || 'text-ink-faint'}`;
    message.textContent = text;
    dom.gitChangesBody.appendChild(message);
  }

  function setBranch(text) {
    if (dom.gitChangesBranch) dom.gitChangesBranch.textContent = text || '';
  }

  function appendSection(title, count) {
    const head = createElement('<div class="px-4 py-2 text-[11px] font-semibold text-ink-faint bg-sunk/40 border-b border-line-soft"></div>');
    head.textContent = `${title}（${count}）`;
    dom.gitChangesBody.appendChild(head);
  }

  function loadUntrackedPreview(preview, relPath) {
    preview.replaceChildren();
    const loading = createElement('<div class="text-ink-faint text-[11px] px-1 py-1"></div>');
    loading.textContent = t('加载中…');
    preview.appendChild(loading);
    context.socket.emit('browse:read', { cwd, relPath, offset: 0 }, response => {
      preview.replaceChildren();
      if (!response?.ok) {
        const m = createElement('<div class="text-danger text-[11px]"></div>');
        m.textContent = response?.error || t('无法读取未跟踪文件');
        preview.appendChild(m);
        return;
      }
      if (response.binary) {
        const m = createElement('<div class="text-ink-faint text-[11px]"></div>');
        m.textContent = t('二进制文件，不支持预览');
        preview.appendChild(m);
        return;
      }
      const note = createElement('<div class="text-ink-faint text-[10px] mb-1"></div>');
      note.textContent = t('未跟踪文件（全文即新增）') + (response.truncated ? t(' · 已截断') : '');
      preview.appendChild(note);
      const pre = createElement('<pre class="overflow-x-auto whitespace-pre-wrap break-words rounded px-2 py-1 text-[11px] font-mono" style="background:rgba(61,138,80,.12)"></pre>');
      pre.textContent = response.content || '';
      preview.appendChild(pre);
    });
  }

  function loadDiffPreview(preview, relPath, side) {
    preview.replaceChildren();
    const loading = createElement('<div class="text-ink-faint text-[11px] px-1 py-1"></div>');
    loading.textContent = t('加载中…');
    preview.appendChild(loading);
    context.socket.emit('git:diff', { cwd, path: relPath, side }, response => {
      preview.replaceChildren();
      if (!response?.ok) {
        const m = createElement(`<div class="text-[11px] ${response?.code === 'scope' || response?.code === 'bad_path' ? 'text-danger' : 'text-ink-faint'}"></div>`);
        m.textContent = response?.error || t('diff 不可用');
        preview.appendChild(m);
        return;
      }
      if (response.binary) {
        const m = createElement('<div class="text-ink-faint text-[11px]"></div>');
        m.textContent = response.patch || t('二进制文件，diff 略');
        preview.appendChild(m);
        return;
      }
      if (response.empty || !response.patch) {
        const m = createElement('<div class="text-ink-faint text-[11px]"></div>');
        m.textContent = t('无 diff（可能已清除）');
        preview.appendChild(m);
        return;
      }
      if (response.truncated) {
        const note = createElement('<div class="text-ink-faint text-[10px] mb-1"></div>');
        note.textContent = t('内容已截断');
        preview.appendChild(note);
      }
      preview.appendChild(renderPatchLines(response.patch, createElement));
    });
  }

  function appendRow(entry, side) {
    const row = createElement('<div class="border-b border-line-soft" data-testid="git-change-row"></div>');
    const btn = createElement('<button type="button" class="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-sunk/30 active:opacity-70"></button>');
    const xy = createElement('<span class="shrink-0 w-7 text-[10px] font-mono text-ink-faint tabular-nums"></span>');
    xy.textContent = side ? (entry.xy || '') : '??';
    btn.appendChild(xy);
    const name = createElement('<span class="flex-1 min-w-0 truncate text-xs text-ink"></span>');
    name.textContent = entry.path;
    name.title = entry.oldPath ? `${entry.oldPath} → ${entry.path}` : entry.path;
    btn.appendChild(name);
    const preview = createElement('<div class="hidden px-3 pb-2 space-y-0.5" data-testid="git-change-preview"></div>');
    let loaded = false;
    btn.onclick = () => {
      haptic('tap');
      preview.classList.toggle('hidden');
      if (loaded) return;
      loaded = true;
      if (!side) loadUntrackedPreview(preview, entry.path);
      else loadDiffPreview(preview, entry.path, side);
    };
    row.appendChild(btn);
    row.appendChild(preview);
    dom.gitChangesBody.appendChild(row);
  }

  function renderList(payload) {
    if (!dom.gitChangesBody) return;
    dom.gitChangesBody.innerHTML = '';
    setBranch(payload.branch ? `⎇ ${payload.branch}` : t('（无分支）'));

    const total =
      (payload.staged?.length || 0) +
      (payload.unstaged?.length || 0) +
      (payload.untracked?.length || 0);

    if (!total) {
      showMessage(t('工作区干净，没有改动'));
      return;
    }

    for (const sec of SECTION_META) {
      const items = payload[sec.key] || [];
      if (!items.length) continue;
      appendSection(t(sec.title), items.length);
      for (const entry of items) appendRow(entry, sec.side);
    }

    if (payload.truncated) {
      const note = createElement('<div class="p-3 text-center text-[11px] text-ink-faint"></div>');
      note.textContent = t('列表已截断（条目过多）');
      dom.gitChangesBody.appendChild(note);
    }
  }

  function load() {
    const token = ++loadToken;
    setBranch('');
    showMessage(t('加载中…'));
    context.socket.emit('git:status', { cwd }, response => {
      if (token !== loadToken) return;
      if (!response?.ok) {
        const cls = response?.code === 'not_git' ? 'text-ink-faint' : 'text-danger';
        showMessage(response?.error || t('无法加载 git 状态'), cls);
        setBranch(response?.code === 'not_git' ? t('非 git 仓库') : '');
        return;
      }
      renderList(response);
    });
  }

  function open(nextCwd) {
    cwd = nextCwd;
    openSheet(dom.gitChangesModal);
    load();
  }

  function close() {
    closeSheet(dom.gitChangesModal);
  }

  if (dom.gitChangesClose) dom.gitChangesClose.onclick = () => close();
  if (dom.gitChangesRefresh) {
    dom.gitChangesRefresh.onclick = () => {
      haptic('tap');
      load();
    };
  }
  if (dom.gitChangesModal) {
    dom.gitChangesModal.onclick = event => {
      if (event.target === dom.gitChangesModal) close();
    };
  }

  return { open, close, load };
}

export function createWorkspaceChooser(context, {
  closeSheet = () => {},
  openSheet = () => {},
  haptic = () => {},
  onBrowse = () => {},
  onChanges = () => {},
} = {}) {
  const dom = context.dom;

  function open() {
    openSheet(dom.workspaceChooserModal);
  }

  function close() {
    closeSheet(dom.workspaceChooserModal);
  }

  if (dom.workspaceChooserClose) dom.workspaceChooserClose.onclick = () => close();
  if (dom.workspaceChooserBrowse) {
    dom.workspaceChooserBrowse.onclick = () => {
      haptic('tap');
      close();
      // 等 sheet 收合动画后再开下一层，避免两层叠闪
      setTimeout(() => onBrowse(), 50);
    };
  }
  if (dom.workspaceChooserChanges) {
    dom.workspaceChooserChanges.onclick = () => {
      haptic('tap');
      close();
      setTimeout(() => onChanges(), 50);
    };
  }
  if (dom.workspaceChooserModal) {
    dom.workspaceChooserModal.onclick = event => {
      if (event.target === dom.workspaceChooserModal) close();
    };
  }

  return { open, close };
}
