// app/projects-state.js —— 抽屉项目清单的持有者（「已连接的文件夹」，2026-09-24）
//
// 抽屉的小节 = 项目：已连接的文件夹、其下有会话的子文件夹、「无文件夹」（在用时）。清单随 instances
// 广播整份替换（服务端现算，见 app/src/sessions/projects.js）；这里只存最新一份，并回答「这个 cwd 叫什么」。
import { normalizeProjects, projectLabel, isPathWithin } from '../logic/projects.js';
import { projectDisplayName } from '../logic/panel-state.js';
import { t } from '../i18n.js';

export function createProjectsState() {
  let list = [];
  let byKey = new Map();
  let scratchRoot = null;
  let connected = null; // 已连接的文件夹个数（广播里的 dirs）；null = 还没收到、或载荷没带——不知道就不当成零
  let readonly = null; // 手机上改不了清单时的原因码（广播里的 foldersReadonly）；null = 能改，或载荷没带
  return {
    set(payload) {
      list = normalizeProjects(payload);
      byKey = new Map(list.map(p => [p.key, p]));
      scratchRoot = typeof payload?.scratchRoot === 'string' && payload.scratchRoot ? payload.scratchRoot : null;
      connected = Array.isArray(payload?.dirs) ? payload.dirs.length : null;
      readonly = typeof payload?.foldersReadonly === 'string' && payload.foldersReadonly ? payload.foldersReadonly : null;
    },
    keys: () => list.map(p => p.key),
    connectedCount: () => connected,
    foldersReadonly: () => readonly,
    // 这一节是什么：connected（连接根）/ subfolder / scratch；不在清单里 → null。抽屉据此决定给不给「断开」。
    kindOf: key => byKey.get(key)?.kind ?? null,
    entries: () => list.slice(),
    scratchRoot: () => scratchRoot,
    // 这个 cwd 是不是「无文件夹」（scratch 根本身或它下面的某个 scratch 目录）
    isNoFolder: cwd => Boolean(scratchRoot) && isPathWithin(cwd, scratchRoot),
    // 任一 cwd 的展示名：是一节就用那一节的标题；scratch 根及其下的目录（「无文件夹」那一节可能还没下发、
    // 或给的是某个会话的 scratch 目录）叫「无文件夹」；其余取末段（与改动前相同）。
    labelFor(cwd) {
      const entry = byKey.get(cwd);
      if (entry) return projectLabel(entry);
      if (scratchRoot && isPathWithin(cwd, scratchRoot)) return t('无文件夹');
      return projectDisplayName(cwd);
    },
  };
}
