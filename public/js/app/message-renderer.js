export function createMessageRenderer(context, { scrollBottom = () => {} } = {}) {
  const marked = context.dependencies.marked;
  const purifier = context.dependencies.DOMPurify;
  const documentRef = context.dependencies.document || globalThis.document;

  marked?.setOptions({ breaks: true, gfm: true });
  purifier?.addHook('afterSanitizeAttributes', node => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });

  function renderMarkdown(raw) {
    return purifier.sanitize(marked.parse(raw));
  }

  function createElement(html) {
    const template = documentRef.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstChild;
  }

  function setStatus(text) {
    if (context.dom.status) context.dom.status.textContent = text;
  }

  function leaveStartScreen() {
    const messages = context.dom.messages;
    if (!messages?.classList.contains('empty-start')) return;
    messages.classList.remove('empty-start');
    messages.innerHTML = '';
  }

  function appendMessage(node) {
    leaveStartScreen();
    return context.dom.messages?.appendChild(node);
  }

  function addBar(text, className) {
    const bar = appendMessage(createElement(`<div class="msg-frame text-center text-xs ${className}"></div>`));
    if (bar) bar.textContent = text;
    scrollBottom();
    return bar;
  }

  return { addBar, appendMessage, createElement, leaveStartScreen, renderMarkdown, setStatus };
}
