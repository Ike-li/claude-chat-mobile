// 续接会丢掉一段对话（SESSION-04）时，发送被拒后那块面板说什么。数据是 ack 带回的 divergence
// （server 的 sessions/resume-anchor.js resumeDivergence）；面板的开合与两个选项的动作在 app/resume-divergence.js。
//
// 两个选项各保住哪一支要照实说：终端只在旧叶子下写过 system 行时（anchorOnlyCount=0）分叉什么都不丢；
// 终端真打过一轮时两支各有对方没有的，分叉会少掉另一支，不说的话用户以为分叉零代价。
import { t, tk } from '../i18n.js';

// 表里 tk() 只做标记、取用点才 t()（模块顶层求值会把语言钉死在 zh）。
// 两张表分开：同一端在句中两个位置的说法不同（「终端那一轮」/「终端上」），英文更是两种结构。
const ANCHOR_TEXT = {
  cli: tk('终端那一轮'),
  'claude-desktop': tk('桌面端那一轮'),
  'sdk-ts': tk('手机那一轮'),
};
const NEWEST_TEXT = {
  cli: tk('终端上'),
  'claude-desktop': tk('桌面端上'),
  'sdk-ts': tk('手机上'),
};

const count = n => (Number.isInteger(n) && n > 0 ? n : 0);

/**
 * @returns {null | {title, body, okText, altText}}  null = 数据不够出面板（调用方退回报错条，话已在输入框里）
 */
export function describeResumeDivergence(divergence) {
  if (!divergence || typeof divergence !== 'object') return null;
  if (typeof divergence.newestUuid !== 'string' || !divergence.newestUuid) return null;
  const n = String(count(divergence.droppedCount));
  const m = count(divergence.anchorOnlyCount);
  const anchor = t(ANCHOR_TEXT[divergence.anchorEntrypoint] || tk('另一端那一轮'));
  const newest = t(NEWEST_TEXT[divergence.newestEntrypoint] || tk('另一端上'));
  const what = t('模型会从{anchor}接上，{newest}最近 {n} 条消息不在它的上下文里。')
    .replace('{anchor}', anchor).replace('{newest}', newest).replace('{n}', n);
  const fork = m > 0
    ? t('分叉到新会话：从最新那条复制出一个新会话，这 {n} 条都在，但另一支的 {m} 条不在；你的消息会放回它的输入框，原会话不动。')
      .replace('{n}', n).replace('{m}', String(m))
    : t('分叉到新会话：从最新那条复制出一个新会话，这 {n} 条都在；你的消息会放回它的输入框，原会话不动。').replace('{n}', n);
  const anyway = t('仍然发送：在原会话照常发，模型看不到这 {n} 条。').replace('{n}', n);
  return {
    title: t('续接会丢掉一段对话'),
    body: `${what}\n\n${fork}\n${anyway}`,
    okText: t('分叉到新会话'),
    altText: t('仍然发送'),
  };
}
