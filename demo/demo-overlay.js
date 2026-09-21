/**
 * demo-overlay.js —— 首屏的「这是演示」说明卡。
 *
 * 【为什么只在首屏、关掉后不留常驻标识】
 * 演示的目标是让人体验「装好之后长什么样」，任何常驻角标都在破坏这件事，而顶栏与
 * 输入区已经没有不遮挡内容的空位。诚实性由「必须看过这张卡才能进入」保证，卡片里
 * 把「回复是脚本、不调用模型」写在第一句。
 *
 * 记在 sessionStorage 而非 localStorage：新开一个标签页应该重新看到说明——分享出去的
 * 链接，接收者第一眼就该知道自己在看演示。
 *
 * 样式全部复用产品的 CSS 变量，深色模式自动跟随，不引入第二套配色。
 */
(function () {
  'use strict';

  var KEY = 'ccm_demo_intro_seen';
  var GH = 'https://github.com/Ike-li/claude-chat-mobile';

  // 语言判定与产品一致：ccm_lang 显式 zh/en 直接用，auto 看 navigator，未设置保底 zh。
  function lang() {
    var p = null;
    try { p = localStorage.getItem('ccm_lang'); } catch (e) { /* 隐私模式 */ }
    if (p === 'zh' || p === 'en') return p;
    if (p === 'auto') return /^en/i.test(navigator.language || '') ? 'en' : 'zh';
    return 'zh';
  }

  var TEXT = {
    zh: {
      tag: '在线演示',
      title: '这是 claude-chat-mobile 的演示站',
      lead: '你操作的是**真实的前端**，只有后端换成了一层脚本——回复是固定的，不会真的调用模型。',
      tryTitle: '可以试试',
      tries: [
        '发一句「帮我看看项目结构」',
        '发一句「删掉 node_modules 重装」，看审批长什么样',
        '点模型那颗 pill，换模型、思考强度和权限模式'
      ],
      note: '真跑起来时，这里是你本机那个 claude CLI 的完整输出。',
      go: '开始体验',
      install: '装到自己机器 →',
      site: '回到项目主页'
    },
    en: {
      tag: 'Live demo',
      title: 'This is the claude-chat-mobile demo',
      lead: 'You are driving the **real frontend**. Only the backend is scripted — replies are canned and no model is ever called.',
      tryTitle: 'Things to try',
      tries: [
        'Send "show me the project structure"',
        'Send "reinstall node_modules" to see an approval',
        'Tap the model pill to switch model, effort and permission mode'
      ],
      note: 'On your own machine this is the full output of your local claude CLI.',
      go: 'Start exploring',
      install: 'Run it yourself →',
      site: 'Back to project site'
    }
  };

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  // 只支持 **粗体**，够用且不用引 markdown 库
  function bold(s) { return esc(s).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'); }

  function style() {
    var css = [
      '#demoIntro{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;',
      'padding:20px;background:rgba(20,16,12,.44);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);}',
      '#demoIntro[hidden]{display:none;}',
      '#demoIntroCard{background:var(--surface,#FBFAF6);color:var(--ink,#1F1E1B);border:1px solid var(--line,#E3E0D6);',
      'border-radius:var(--radius-lg,.875rem);box-shadow:var(--shadow-pop,0 8px 32px rgba(40,32,24,.16));',
      'max-width:420px;width:100%;max-height:88vh;overflow-y:auto;padding:22px 20px 18px;',
      'font-family:var(--font-ui,system-ui,sans-serif);}',
      '#demoIntroCard .tag{display:inline-block;font-size:11px;letter-spacing:.06em;text-transform:uppercase;',
      'color:var(--accent,#AE5238);border:1px solid var(--accent-wash,#F0E4DD);background:var(--accent-wash,#F0E4DD);',
      'padding:3px 8px;border-radius:999px;margin-bottom:12px;}',
      '#demoIntroCard h2{font-family:var(--font-read,Georgia,serif);font-size:20px;line-height:1.35;margin:0 0 10px;font-weight:600;}',
      '#demoIntroCard p{font-size:14px;line-height:1.6;color:var(--ink-soft,#54514A);margin:0 0 14px;}',
      '#demoIntroCard h3{font-size:12px;font-weight:600;color:var(--ink-faint,#73706A);margin:0 0 8px;letter-spacing:.02em;}',
      '#demoIntroCard ul{margin:0 0 16px;padding:0;list-style:none;}',
      '#demoIntroCard li{font-size:13.5px;line-height:1.55;color:var(--ink-soft,#54514A);padding:6px 0 6px 18px;position:relative;}',
      '#demoIntroCard li::before{content:"";position:absolute;left:4px;top:13px;width:5px;height:5px;border-radius:50%;',
      'background:var(--accent,#AE5238);opacity:.55;}',
      '#demoIntroCard .note{font-size:12.5px;color:var(--ink-faint,#73706A);border-top:1px solid var(--line-soft,#ECEAE1);',
      'padding-top:12px;margin:0 0 16px;}',
      '#demoIntroCard .acts{display:flex;gap:10px;align-items:center;}',
      '#demoIntroGo{flex:1;appearance:none;border:0;cursor:pointer;background:var(--cta,#AE5238);color:#fff;',
      'font-size:14.5px;font-weight:500;padding:11px 16px;border-radius:var(--radius-md,.625rem);font-family:inherit;}',
      '#demoIntroGo:active{filter:brightness(.95);}',
      '#demoIntroCard .acts a{font-size:13px;color:var(--accent,#AE5238);text-decoration:none;white-space:nowrap;padding:8px 2px;}',
      '#demoIntroCard .acts a:hover{text-decoration:underline;}'
    ].join('');
    var el = document.createElement('style');
    el.textContent = css;
    document.head.appendChild(el);
  }

  function mount() {
    try { if (sessionStorage.getItem(KEY) === '1') return; } catch (e) { /* 隐私模式：照常显示 */ }

    var T = TEXT[lang()];
    style();

    var wrap = document.createElement('div');
    wrap.id = 'demoIntro';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.innerHTML =
      '<div id="demoIntroCard">'
      + '<span class="tag">' + esc(T.tag) + '</span>'
      + '<h2>' + esc(T.title) + '</h2>'
      + '<p>' + bold(T.lead) + '</p>'
      + '<h3>' + esc(T.tryTitle) + '</h3>'
      + '<ul>' + T.tries.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'
      + '<p class="note">' + esc(T.note) + '</p>'
      + '<div class="acts">'
      + '<button id="demoIntroGo" type="button">' + esc(T.go) + '</button>'
      + '<a href="' + GH + '#quick-start" target="_blank" rel="noopener">' + esc(T.install) + '</a>'
      // 演示站此前唯一的出口是 GitHub 外链：进来的人想回项目主页只能按浏览器后退。
      // 按当前语言分别指向 /zh/ 与 /，不是统一丢到英文首页。
      + '<a href="' + (lang() === 'zh' ? '../zh/' : '../') + '">' + esc(T.site) + '</a>'
      + '</div></div>';

    document.body.appendChild(wrap);

    function close() {
      try { sessionStorage.setItem(KEY, '1'); } catch (e) { /* 隐私模式：下次再显示 */ }
      wrap.remove();
    }
    wrap.querySelector('#demoIntroGo').addEventListener('click', close);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc); }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
