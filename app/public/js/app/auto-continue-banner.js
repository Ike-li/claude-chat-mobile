// 额度墙「到点自动继续」横幅：只做接线，文案与按钮全在 logic/auto-continue.js 的 resolveAutoContinueBanner。
//
// 数据是 instances 广播里的 autoContinue——按 sessionId 归键的全量快照，不是事件流：断线重连、切会话、
// 换一台设备看，都从同一份权威快照重画，没有需要回放或对账的增量。按钮只发意图（user:autoContinue），
// 结果以服务端下一次广播为准，本模块不自己改状态。
import { resolveAutoContinueBanner } from '../logic/auto-continue.js';
import { t } from '../i18n.js';

// 只用无透明度的 token：本仓 tw-config 映射的是裸 var()，`border-accent/40` 这类类名根本不产出 CSS。
const BANNER_BASE = 'px-3 py-2 bg-surface border rounded-xl text-xs mb-1 shrink-0 flex items-center gap-2';
const TONE_CLASSES = { info: 'border-accent', muted: 'border-line', warn: 'border-warning' };

export function createAutoContinueBannerController(context, {
  onAction = () => {},
  onToggle = () => {},
  now = () => Date.now(),
} = {}) {
  let entries = [];
  let sessionId = null;
  let current = null;
  let visible = false;

  function render() {
    const banner = context.dom.autoContinueBanner;
    if (!banner) return;
    current = resolveAutoContinueBanner(entries, sessionId, now());
    if (!current) {
      banner.className = `hidden ${BANNER_BASE}`;
    } else {
      banner.className = `${BANNER_BASE} ${TONE_CLASSES[current.tone] || TONE_CLASSES.info}`;
      if (context.dom.autoContinueText) context.dom.autoContinueText.textContent = current.text;
      const btn = context.dom.autoContinueAction;
      if (btn) {
        btn.textContent = current.actionLabel;
        btn.dataset.action = current.action;
        btn.disabled = false;
      }
    }
    const nowVisible = Boolean(current);
    if (nowVisible !== visible) {
      visible = nowVisible;
      onToggle(nowVisible); // 横幅占一行会改 #messages 高度，app.js 据此补一次非 force 的贴底
    }
  }

  // entries 缺失（undefined）= 这条广播没带该字段：E2E mock 的多数内联 instances 载荷如此，真 server 恒带
  // 数组（可能为空）。缺失时保留上一份、只按新 sessionId 重画——同 bgActive 缺字段不隐藏横幅的约定。
  function update({ entries: next, sessionId: sid }) {
    if (Array.isArray(next)) entries = next;
    sessionId = sid || null;
    render();
  }

  const btn = context.dom.autoContinueAction;
  if (btn) {
    btn.onclick = () => {
      if (!current || !sessionId) return;
      btn.disabled = true; // 等服务端下一次广播重画时解锁：连点两下不该发两次
      onAction({ sessionId, action: current.action });
    };
  }

  const controller = { update, refresh: render, isVisible: () => visible };
  context.state.autoContinueBanner = controller;
  return controller;
}

// 续跑发出的那句 user 气泡：顶部加一行小标注，否则看着像用户自己打了一句英文。
// live（user_message.origin）与历史（history.js 透传的 origin）两条渲染路径共用这一个函数。
export function tagAutoContinueBubble(bubble, doc = globalThis.document) {
  if (!bubble || !doc || bubble.querySelector('[data-testid="auto-continue-tag"]')) return;
  const tag = doc.createElement('div');
  tag.className = 'text-[10px] text-ink-faint mb-0.5 select-none';
  tag.setAttribute('data-testid', 'auto-continue-tag');
  tag.textContent = `⏵ ${t('额度重置后自动继续')}`;
  bubble.insertBefore(tag, bubble.firstChild);
}
