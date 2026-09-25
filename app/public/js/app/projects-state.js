// app/projects-state.js —— 抽屉项目清单的持有者（「已连接的文件夹」，2026-09-24）
//
// 抽屉的小节 = 项目：已连接的文件夹、其下有会话的子文件夹、「无文件夹」（在用时）。清单随 instances
// 广播整份替换（服务端现算，见 app/src/sessions/projects.js）；这里只存最新一份，并回答「这个 cwd 叫什么」。
import { normalizeProjects, projectLabel } from '../logic/projects.js';
import { projectDisplayName } from '../logic/panel-state.js';
import { t } from '../i18n.js';

export function createProjectsState() {
  let list = [];
  let byKey = new Map();
  let scratchRoot = null;
  return {
    set(payload) {
      list = normalizeProjects(payload);
      byKey = new Map(list.map(p => [p.key, p]));
      scratchRoot = typeof payload?.scratchRoot === 'string' && payload.scratchRoot ? payload.scratchRoot : null;
    },
    keys: () => list.map(p => p.key),
    scratchRoot: () => scratchRoot,
    // 任一 cwd 的展示名：是一节就用那一节的标题；scratch 根及其下的目录（「无文件夹」那一节可能还没下发、
    // 或给的是某个会话的 scratch 目录）叫「无文件夹」；其余取末段（与改动前相同）。
    labelFor(cwd) {
      const entry = byKey.get(cwd);
      if (entry) return projectLabel(entry);
      if (scratchRoot && typeof cwd === 'string' && (cwd === scratchRoot || cwd.startsWith(`${scratchRoot}/`))) return t('无文件夹');
      return projectDisplayName(cwd);
    },
  };
}
