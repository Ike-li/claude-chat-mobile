// 保存的环境的纯判据：当前设置对应哪个环境、列表里的摘要、默认名字、错误文案。
import { t, tk } from '../i18n.js';
import { projectDisplayName } from './panel-state.js';

const ERROR_TEXT = {
  duplicate_name: tk('已有同名环境，换个名字'),
  invalid_name: tk('名字不能为空，最长 60 个字'),
  out_of_range: tk('这个文件夹不在已连接的范围内'),
  not_found: tk('这个环境已经不在了'),
  device_not_approved: tk('这台设备还没批准，不能改环境'),
  disconnected: tk('连接已断开，重连后再试'),
};

// 选择框的空串、CLI 的 default 与环境里的 null 都是「跟随默认」
const explicit = value => (value && value !== 'default' ? value : null);

export function environmentFromCurrent({ cwd, model, effort, worktree }) {
  return { cwd, model: explicit(model), effort: explicit(effort), worktree: Boolean(worktree) };
}

// chip 文案由这里派生，不存「选中了哪个」：改了任何一项，当前设置就不再是那个环境，存着的选中态反而会说谎
export function findMatchingEnvironment(environments, current) {
  const now = environmentFromCurrent(current);
  return (environments || []).find(e => e.cwd === now.cwd
    && explicit(e.model) === now.model
    && explicit(e.effort) === now.effort
    && e.worktree === now.worktree) ?? null;
}

export function formatEnvironmentSummary(env) {
  const folder = projectDisplayName(env.cwd);
  if (env.available === false) return `${folder} · ${t('文件夹已断开')}`;
  return [folder, env.model || t('默认模型'), env.effort, env.worktree ? t('新 worktree') : null].filter(Boolean).join(' · ');
}

export function suggestEnvironmentName(cwd, environments) {
  const base = projectDisplayName(cwd);
  const taken = new Set((environments || []).map(e => e.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

export function environmentErrorText(code) {
  return t(ERROR_TEXT[code] || tk('保存失败，稍后再试'));
}
