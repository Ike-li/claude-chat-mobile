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

  // SEC：DOMPurify 默认表放行 <label for> 与 style 属性（实测 3.4.10）。二者组合成纯 HTML/CSS 点击劫持：
  // <label for="permAllow" style="position:fixed;inset:0;z-index:2147483647;opacity:.002"> 铺满视口盖过
  // z-40 的 #permModal，用户点「拒绝」实际激活 <button id="permAllow">（button 是 labelable）→ 批准工具。
  // 审批完整性绑定挡不住——op 指纹是真的，被篡改的是用户意图；CSP 也管不到（不含脚本）。
  // 同理 <form action="外域"> 可外发 AUTH_TOKEN（另配 CSP form-action 作纵深，见 src/server/http.js）。
  // 黑名单而非白名单：markdown 的产出集合会随 marked/GFM 演进，白名单漏一个就是静默丢渲染；这里禁的
  // 是「markdown 本就不产出、却能改变页面交互」的那几个原语，零副作用。input 有意保留 —— GFM 任务列表
  // 「- [ ] todo」渲染成 <input type=checkbox disabled>，且孤立 input 既无 label 可激活、也无 form 可提交。
  const SANITIZE_CONFIG = {
    FORBID_TAGS: ['label', 'form', 'button', 'select', 'textarea', 'option', 'fieldset', 'legend'],
    FORBID_ATTR: ['style', 'for', 'tabindex', 'accesskey', 'autofocus', 'contenteditable', 'draggable'],
  };

  function renderMarkdown(raw) {
    return purifier.sanitize(marked.parse(raw), SANITIZE_CONFIG);
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
