// git-changes.js —— 工作区 git 变更只读面板（staged / unstaged / untracked）+ 承载两者的面板外壳。
// 与 file-browser 同骨架：懒加载详情；diff 用 textContent 防 XSS。
// 两个导出分工：createGitChangesPanel = 「改动」tab 的数据与渲染；createWorkspacePanel = 外壳
// （#workspaceModal 的开合 + 文件/改动 tab 切换），后者同时驱动 file-browser.js 那半边。
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
  createElement,
  haptic = () => {},
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

  // 进入改动 tab 并拉一次 git:status。**不负责开合 sheet**——见 file-browser.js open 同款说明。
  function open(nextCwd) {
    cwd = nextCwd;
    load();
  }

  if (dom.gitChangesRefresh) {
    dom.gitChangesRefresh.onclick = () => {
      haptic('tap');
      load();
    };
  }

  return { open, load };
}

/**
 * 工作区面板外壳：持有 #workspaceModal 的开合与「文件 / 改动」两 tab 的切换。
 *
 * 取代了原先的 workspaceChooser（一层只负责二选一的菜单 sheet）。合并的理由见 index.html
 * #workspaceModal 处注释：chooser 那层零信息量，且互切要关面板重走一遍。
 *
 * 两个子控制器只提供 open(cwd)（＝载入自己那半边的数据），不碰 sheet；
 * 编辑态守卫 confirmLeaveIfEditing 由 file-browser 提供，关闭与切 tab 都必须先过。
 */
export function createWorkspacePanel(context, {
  closeSheet = () => {},
  openSheet = () => {},
  haptic = () => {},
  fileBrowser,
  gitChanges,
} = {}) {
  const dom = context.dom;
  let activeTab = null;   // 'files' | 'changes'
  let cwd = null;

  function paintTab(tab) {
    activeTab = tab;
    const files = tab === 'files';
    dom.workspaceTabFiles?.setAttribute('aria-selected', String(files));
    dom.workspaceTabChanges?.setAttribute('aria-selected', String(!files));
    dom.fileBrowseTools?.classList.toggle('hidden', !files);
    dom.fileBrowseBody?.classList.toggle('hidden', !files);
    dom.gitChangesTools?.classList.toggle('hidden', files);
    dom.gitChangesBody?.classList.toggle('hidden', files);
    // 保存错误条属于文件 tab：切到改动 tab 时一并收起，否则它会浮在 git 列表上方
    if (!files) dom.fileBrowseSaveError?.classList.add('hidden');
  }

  // 切 tab 前必须放行编辑态确认——切个 tab 就丢掉未保存的编辑是本次合并最容易踩的坑。
  async function selectTab(tab) {
    if (tab === activeTab) return;
    if (activeTab === 'files' && !(await fileBrowser?.confirmLeaveIfEditing?.())) return;
    paintTab(tab);
    if (tab === 'files') fileBrowser?.open?.(cwd);
    else gitChanges?.open?.(cwd);
  }

  function open(nextCwd, tab = 'files') {
    cwd = nextCwd;
    activeTab = null;               // 强制重载：同一 tab 再次点开也要拉最新数据
    openSheet(dom.workspaceModal);
    paintTab(tab);
    if (tab === 'files') fileBrowser?.open?.(cwd);
    else gitChanges?.open?.(cwd);
  }

  async function close() {
    if (activeTab === 'files' && !(await fileBrowser?.confirmLeaveIfEditing?.())) return;
    closeSheet(dom.workspaceModal);
  }

  if (dom.workspaceTabFiles) {
    dom.workspaceTabFiles.onclick = () => { haptic('tap'); selectTab('files'); };
  }
  if (dom.workspaceTabChanges) {
    dom.workspaceTabChanges.onclick = () => { haptic('tap'); selectTab('changes'); };
  }
  if (dom.workspaceClose) dom.workspaceClose.onclick = () => close();
  if (dom.workspaceModal) {
    dom.workspaceModal.onclick = event => {
      if (event.target === dom.workspaceModal) close();
    };
  }

  return { open, close, selectTab };
}
