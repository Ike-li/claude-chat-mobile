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

// 分段条连 buffer 最多 5 段，放不下的并成灰色 other（同桌面端）。
// 颜色按占用排名给，不按类别：同一类别在不同会话里颜色可以不同，桌面端也是这样，别写成类别到颜色的映射。
const MAX_SEGMENTS = 5;

function coloredCount(usedCount, bufferCount) {
  return usedCount + bufferCount > MAX_SEGMENTS ? MAX_SEGMENTS - bufferCount : usedCount;
}

const byTokensDesc = (a, b) => b.tokens - a.tokens;
const sumTokens = rows => rows.reduce((sum, row) => sum + row.tokens, 0);
const tokensOrDash = tokens => (tokens > 0 ? statuslineFmtTok(tokens) : '—');

function segmentsFor({ used, buffers, free, colored, maxTokens }) {
  const total = Math.max(maxTokens || 0, sumTokens([...used, ...buffers, ...free])) || 1;
  const percentOf = tokens => Math.round(tokens / total * 10000) / 100;
  const segments = used.slice(0, colored).map((row, index) => ({ tone: String(index), percent: percentOf(row.tokens) }));
  if (colored < used.length) segments.push({ tone: 'other', percent: percentOf(sumTokens(used.slice(colored))) });
  if (buffers.length) segments.push({ tone: 'buffer', percent: percentOf(sumTokens(buffers)) });
  return segments; // 空闲是轨道底色，deferred 不占窗口，都不成段
}

// mcp__server__tool：只去前缀，工具名里的 __ 留着
function mcpToolName({ name, serverName }) {
  const [, , ...tool] = name.split('__');
  return tool.length ? `${serverName} · ${tool.join('__')}` : name;
}

export function contextPanelView({ percentage, totalTokens, maxTokens, categories = [], mcpTools = [], memoryFiles = [] }) {
  const hasPercent = Number.isFinite(percentage);
  const ofKind = kind => categories.filter(c => c.kind === kind).sort(byTokensDesc);
  const used = ofKind('used'), buffers = ofKind('buffer'), free = ofKind('free'), deferred = ofKind('deferred');
  const colored = coloredCount(used.length, buffers.length);
  const row = (category, tone) => ({
    name: category.name,
    tokens: statuslineFmtTok(category.tokens),
    percent: maxTokens > 0 ? `${(category.tokens / maxTokens * 100).toFixed(1)}%` : '',
    tone,
  });
  // 类别到手之前只有总量，画一段单色，阈值同状态栏
  const wholeBar = hasPercent
    ? [{ tone: percentage < 70 ? 'accent' : percentage < 90 ? 'warning' : 'danger', percent: Math.min(100, Math.max(0, percentage)) }]
    : [];
  const lists = [
    { key: 'mcp', label: t('MCP 工具'), rows: mcpTools.map(tool => ({ name: mcpToolName(tool), tokens: tokensOrDash(tool.tokens) })) },
    { key: 'memory', label: t('记忆文件'), rows: memoryFiles.map(file => ({ name: file.path, tokens: tokensOrDash(file.tokens) })) },
  ];
  return {
    usedText: hasPercent ? `${t('已用')} ${percentage}%` : '',
    tokensText: [totalTokens, maxTokens].filter(Number.isFinite).map(statuslineFmtTok).join(' / '),
    segments: categories.length ? segmentsFor({ used, buffers, free, colored, maxTokens }) : wholeBar,
    rows: [
      ...used.map((category, index) => row(category, index < colored ? String(index) : 'other')),
      ...buffers.map(category => row(category, 'buffer')),
      ...free.map(category => row(category, 'free')),
      ...deferred.map(category => ({ ...row(category, 'deferred'), percent: '—' })), // 不占窗口，算百分比是误导
    ],
    lists: lists.filter(list => list.rows.length).map(list => ({ ...list, count: list.rows.length })),
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
