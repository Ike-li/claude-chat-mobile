// 上下文面板怎么显示。来源有两种：context:usage 的回包，或打开面板那一刻状态栏现成的 ctx（usageFromStatusCtx）。
import { t } from '../i18n.js';
import { statuslineFmtTok } from './statusline.js';

// 同桌面端：离阈值不到 3 万时报具体数字没意义，下一轮就压了
const COMPACT_SOON_TOKENS = 30_000;

// 优先级同 formatStatuslineCtxLeft：totalTokens → %×窗口 → 单轮 tokens（有 % 时不用单轮，那不是全量）
export function usageFromStatusCtx(ctx) {
  if (!ctx) return {};
  const { usedPercent, windowSize, totalTokens, tokens } = ctx;
  const known = Number.isFinite(usedPercent) && Number.isFinite(windowSize);
  return {
    percentage: usedPercent,
    totalTokens: totalTokens ?? (known ? Math.round(usedPercent * windowSize / 100) : tokens),
    maxTokens: windowSize,
  };
}

// 距离只能拿阈值减已用。free 行不是答案：真 CLI 上 buffer 不一定单独成行，free 会把预留的 3.3 万也算进去。
export function compactLineText({ totalTokens, autoCompactThreshold, isAutoCompactEnabled }) {
  if (isAutoCompactEnabled === false) return t('自动压缩已关闭');
  if (!Number.isFinite(totalTokens) || !Number.isFinite(autoCompactThreshold)) return '';
  const left = autoCompactThreshold - totalTokens;
  if (left < COMPACT_SOON_TOKENS) return t('即将自动压缩');
  return `${t('距自动压缩还剩')} ${statuslineFmtTok(left)}`;
}

export function contextPanelView({ percentage, totalTokens, maxTokens, categories = [] }) {
  const hasPercent = Number.isFinite(percentage);
  const tone = !hasPercent || percentage < 70 ? 'accent' : percentage < 90 ? 'warning' : 'danger';
  return {
    usedText: hasPercent ? `${t('已用')} ${percentage}%` : '',
    tokensText: [totalTokens, maxTokens].filter(Number.isFinite).map(statuslineFmtTok).join(' / '),
    barPercent: hasPercent ? Math.min(100, Math.max(0, percentage)) : 0,
    barTone: tone,
    rows: categories.map(({ name, tokens }) => ({
      name,
      tokens: statuslineFmtTok(tokens),
      percent: maxTokens > 0 ? `${(tokens / maxTokens * 100).toFixed(1)}%` : '',
    })),
  };
}

// 压缩走 send() 的整套闸，但闸的提示写在消息流里，被面板盖着看不见，所以在这里先说。
export function compactBlockReason({ mirrorReadonly, turnRunning, pendingPrompt, hasAttachments }) {
  if (mirrorReadonly) return t('终端正在驾驶这个会话，接管后才能压缩');
  if (turnRunning) return t('回合进行中，结束后可压缩');
  if (pendingPrompt) return t('先处理审批或选择，再压缩');
  if (hasAttachments) return t('有待发附件，发出或移除后再压缩');
  return '';
}
