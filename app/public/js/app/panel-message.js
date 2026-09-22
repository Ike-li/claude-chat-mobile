// panel-message.js —— 面板正文区的单条状态提示（加载中/空态/错误），file-browser.js 与
// git-changes.js 各自的 showMessage 曾是逐字重复的实现（同一 workspaceModal 外壳下的两个 tab）。
export function showPanelMessage(bodyEl, text, className, documentRef = globalThis.document) {
  if (!bodyEl) return;
  bodyEl.innerHTML = '';
  const message = documentRef.createElement('div');
  message.className = `p-4 text-xs ${className || 'text-ink-faint'}`;
  message.textContent = text;
  bodyEl.appendChild(message);
}
