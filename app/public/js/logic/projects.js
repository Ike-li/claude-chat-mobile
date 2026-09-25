// logic/projects.js —— 抽屉的项目清单：服务端 instances 载荷 → 前端小节（纯函数）
//
// 服务端（2026-09-24 起）按官方桌面端的侧栏语义下发 projects：已连接的文件夹、其下有会话的子文件夹、
// 「无文件夹」（在用时才有）。worktree 不自成项目，跟随所属仓库。载荷里没有 projects 时（旧服务端、
// E2E mock 的旧载荷、在线演示站）回落到 dirs，每个目录一节——与改动前逐字相同。
import { t } from '../i18n.js';
import { projectDisplayName } from './panel-state.js';

const KINDS = new Set(['connected', 'subfolder', 'scratch']);

export function normalizeProjects(payload) {
  const raw = Array.isArray(payload?.projects) ? payload.projects : null;
  if (!raw) {
    const dirs = Array.isArray(payload?.dirs) ? payload.dirs : [];
    return dirs.filter(d => typeof d === 'string' && d).map(d => ({ key: d, root: d, label: null, kind: 'connected' }));
  }
  const out = [];
  const seen = new Set();
  for (const p of raw) {
    if (typeof p?.key !== 'string' || !p.key || seen.has(p.key)) continue;
    seen.add(p.key);
    out.push({
      key: p.key,
      root: typeof p.root === 'string' && p.root ? p.root : p.key,
      label: typeof p.label === 'string' && p.label ? p.label : null,
      kind: KINDS.has(p.kind) ? p.kind : 'connected',
    });
  }
  return out;
}

// 小节标题：「无文件夹」的文案归前端 i18n；子文件夹用服务端给的「根 › 相对路径」；其余取末段。
export function projectLabel(entry) {
  if (entry?.kind === 'scratch') return t('无文件夹');
  return entry?.label || projectDisplayName(entry?.key);
}
