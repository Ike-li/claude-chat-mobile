// logic/projects.js —— 抽屉的项目清单：服务端 instances 载荷 → 前端小节（纯函数）
//
// 服务端（2026-09-24 起）按官方桌面端的侧栏语义下发 projects：已连接的文件夹、其下有会话的子文件夹、
// 「无文件夹」（在用时才有）。worktree 不自成项目，跟随所属仓库。载荷里没有 projects 时（旧服务端、
// E2E mock 的旧载荷、在线演示站）回落到 dirs，每个目录一节——与改动前逐字相同。
import { t, tk } from '../i18n.js';
import { projectDisplayName, liveRowsForSection } from './panel-state.js';

const KINDS = new Set(['connected', 'subfolder', 'scratch']);

// p 是不是 root 本身或在它下面。两种分隔符都认：headless server 可能跑在原生 Windows（实验路径），
// 家目录、项目键、scratch 目录里是 \。必须带分隔符边界：/Users/you2 不在 /Users/you 下。
export function isPathWithin(p, root) {
  if (typeof p !== 'string' || typeof root !== 'string' || !p || !root) return false;
  if (p === root) return true;
  const base = root.replace(/[/\\]+$/, '');
  return p.length > base.length && p.startsWith(base) && /[/\\]/.test(p[base.length]);
}

// p 相对 root 的路径，统一用 / 分隔（协议里的位置都是 / 分隔的，服务端 resolve 两种都认）；不在其下返回 null。
export function relPathUnder(p, root) {
  if (!isPathWithin(p, root)) return null;
  return p.slice(root.replace(/[/\\]+$/, '').length).split(/[/\\]+/).filter(Boolean).join('/');
}

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
// 码的出处：sessions/folders.js（判据）、app.js addConnectedFolder / removeConnectedFolder（写配置）、socket-folders.js。
const FOLDER_REASON_TEXT = Object.freeze({
  home: tk('不能添加整个家目录'),
  root: tk('不能添加磁盘根目录'),
  outside_home: tk('只能添加家目录里的文件夹'),
  forbidden: tk('这是 Claude 或本应用自己的目录，不能添加'),
  worktree: tk('这是 Claude Code 建的 worktree，跟随所属仓库；请添加仓库本身'),
  already_connected: tk('已经连接'),
  not_found: tk('文件夹不存在'),
  not_directory: tk('不是文件夹'),
  no_config_file: tk('没有 ccm.config.json，手机上添加不了；请在电脑上运行 npm run setup'),
  source_readonly: tk('工作区列表来自环境变量 WORK_DIRS，手机上改不了'),
  config_unreadable: tk('配置文件读不出来，已拒绝改写'),
  write_failed: tk('写入配置文件失败'),
  not_applied: tk('已写入配置，但没有生效'),
  invalid: tk('配置校验没通过'),
  not_connected: tk('这个文件夹已经不在已连接的清单里了'),
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

// 抽屉「⋯ → 断开这个文件夹」的确认框（2026-10-15）。断开只是不再显示、不能在里面新开：文件和会话记录都不动，
// 开着的会话照常跑。有会话开着时说出几个——不说，用户会以为点下去就全关了。
// 名字用函数替换：字符串参数会把名字里的 $& 之类当成替换模式。
export function disconnectFolderConfirm({ name, openSessions = 0 } = {}) {
  let body = t('断开后抽屉里不再显示它，也不能在里面新开会话；文件夹里的文件和会话记录都不动，随时可以再选回来。');
  if (Number.isFinite(openSessions) && openSessions > 0) {
    body += t('这里有 {n} 个会话开着，会照常继续。').replace('{n}', String(openSessions));
  }
  return { title: t('断开「{name}」？').replace('{name}', () => String(name ?? '')), body, okText: t('断开') };
}

// 断开连接根时一起消失的小节里开着几个会话：根本身，加上它下面自成一节的子文件夹。会话按最具体的那一节归属
// （liveRowsForSection），只数根那一节会漏掉子文件夹里在跑的——它们断开后同样照常继续（2026-10-15 Codex review #205）。
export function openSessionsUnderRoot({ projects = [], instances = [], root, sectionKeys = [] } = {}) {
  let n = 0;
  for (const p of projects) {
    if (p?.root !== root) continue;
    const { liveMap, freshTabs } = liveRowsForSection(instances, p.key, sectionKeys);
    n += liveMap.size + freshTabs.length;
  }
  return n;
}

// 首页「最近活跃会话」去哪些目录拉：服务端给的项目清单。回落到查看目录只给载荷里没带清单的旧服务端——
// 服务端明说一个文件夹都没连时，查看目录可能还停在刚断开、但里面有会话开着的文件夹上（服务端只在没有实例时
// 才把它归位），显式拿它去拉列表会被当成越界尝试、记一条审计（2026-10-15）。
export function dashboardDirs({ keys = [], connectedCount = null, currentCwd = null } = {}) {
  if (keys.length) return keys.slice();
  return currentCwd && connectedCount == null ? [currentCwd] : [];
}

// 小节标题：「无文件夹」的文案归前端 i18n；子文件夹用服务端给的「根 › 相对路径」；其余取末段。
export function projectLabel(entry) {
  if (entry?.kind === 'scratch') return t('无文件夹');
  return entry?.label || projectDisplayName(entry?.key);
}
