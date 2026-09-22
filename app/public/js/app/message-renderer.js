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
  // class 同理且更隐蔽（2026-09-22 review）：页面跑的是 Tailwind **运行时**，它用 MutationObserver 盯
  // class 当场现编 CSS，于是 class="fixed z-[2147483647] pointer-events-none …" 能做到 style 能做的一切——
  // 在真「允许」上方画一个「拒绝」、点击穿透过去（真 Chromium 实测触发 allow）。这里反过来用白名单：
  // markdown 自己产出的 class 只有 <code class="language-xxx">（hljs 靠它选语言），其余一律剥掉。
  // 语言名字符集照 marked 原样输出的 info string 放宽（c++ / c# / objective-c），但不放 [ ]，
  // 挡住伪装成前缀的任意值写法。
  const MARKDOWN_CLASS_TOKEN = /^language-[A-Za-z0-9_+#.-]+$/;
  purifier?.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName !== 'class') return;
    const kept = String(data.attrValue || '').split(/\s+/).filter(token => MARKDOWN_CLASS_TOKEN.test(token));
    if (kept.length) data.attrValue = kept.join(' ');
    else data.keepAttr = false;
  });
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
