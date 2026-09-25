// logic/projects.js —— 抽屉的项目清单：服务端 instances 载荷 → 前端小节（纯函数）
//
// 服务端（2026-09-24 起）按官方桌面端的侧栏语义下发 projects：已连接的文件夹、其下有会话的子文件夹、
// 「无文件夹」（在用时才有）。worktree 不自成项目，跟随所属仓库。载荷里没有 projects 时（旧服务端、
// E2E mock 的旧载荷、在线演示站）回落到 dirs，每个目录一节——与改动前逐字相同。
import { t, tk } from '../i18n.js';
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

// 「选文件夹」面板里服务端回的原因码 → 给人看的一句话（能不能加、为什么建不了、为什么没加上）。
// 码的出处：sessions/folders.js（判据）、app.js addConnectedFolder（写配置）、socket-folders.js。
const FOLDER_REASON_TEXT = Object.freeze({
  home: tk('不能添加整个家目录'),
  root: tk('不能添加磁盘根目录'),
  outside_home: tk('只能添加家目录里的文件夹'),
  forbidden: tk('这是 Claude 或本应用自己的目录，不能添加'),
  worktree: tk('这是 git worktree，跟随所属仓库；请添加仓库本身'),
  already_connected: tk('已经连接'),
  not_found: tk('文件夹不存在'),
  not_directory: tk('不是文件夹'),
  no_config_file: tk('没有 ccm.config.json，手机上添加不了；请在电脑上运行 npm run setup'),
  source_readonly: tk('工作区列表来自环境变量 WORK_DIRS，手机上改不了'),
  config_unreadable: tk('配置文件读不出来，已拒绝改写'),
  write_failed: tk('写入配置文件失败'),
  not_applied: tk('已写入配置，但没有生效'),
  invalid: tk('配置校验没通过'),
  exists: tk('同名文件夹已存在'),
  hidden: tk('名字不能以 . 开头'),
  separator: tk('名字里不能有斜杠'),
  control: tk('名字里有不可见字符'),
  too_long: tk('名字太长'),
  empty: tk('请输入名字'),
  out_of_range: tk('这里不能浏览或新建文件夹'),
  mkdir_failed: tk('新建文件夹失败'),
  unreadable: tk('读不出这个文件夹'),
});
export const FOLDER_REASON_CODES = Object.freeze(Object.keys(FOLDER_REASON_TEXT));
export function folderReasonText(code) {
  return t(Object.hasOwn(FOLDER_REASON_TEXT, code) ? FOLDER_REASON_TEXT[code] : tk('操作失败'));
}

// 小节标题：「无文件夹」的文案归前端 i18n；子文件夹用服务端给的「根 › 相对路径」；其余取末段。
export function projectLabel(entry) {
  if (entry?.kind === 'scratch') return t('无文件夹');
  return entry?.label || projectDisplayName(entry?.key);
}
