// new-session-worktree.js —— 新会话的「在新 worktree 里开」意图（勾选态 + 源分支 + 分支列表缓存）
//
// 【为什么单独成模块】这是一组只在"空首页 → 第一条消息"之间存活的状态，落 app.js 顶层就又多三个
// 全局变量，而它们的失效时机并不相同（分支缓存跟着工作区走，勾选与源分支跟着"这一个新会话"走）。
// 收在一处，失效规则写在一起才看得出是否自洽。
//
// 【懒创建】勾选**一个请求都不发**：意图跟着第一条消息进 user:message，服务端在懒开实例时才
// `git worktree add`。于是勾了又取消、改分支重勾，磁盘上都不会留下任何东西。
// 与 Claude Code Desktop 同构——它的 lazyWorktrees.prepare 同样挂在 start_session 上。
import { t } from '../i18n.js';

const BRANCH_ACK_TIMEOUT_MS = 4000;

export function createNewSessionWorktree(context, { onChange = () => {} } = {}) {
  let enabled = false;
  let sourceBranch = null;      // null = 跟随仓库当前分支
  let branches = [];
  let currentBranch = null;
  let loadedFor = null;         // 分支列表是给哪个 cwd 拉的（切工作区即失效）
  let loadError = null;

  const effectiveBranch = () => sourceBranch ?? currentBranch;

  function snapshot() {
    return {
      enabled,
      branches,
      currentBranch,
      sourceBranch: effectiveBranch(),
      loadError,
    };
  }

  function setEnabled(next) {
    const v = Boolean(next);
    if (v === enabled) return;
    enabled = v;
    onChange(snapshot());
  }

  function setSourceBranch(branch) {
    sourceBranch = typeof branch === 'string' && branch ? branch : null;
    onChange(snapshot());
  }

  // 切工作区 / 切会话 / 回首页都要作废：勾选是对「这一个新会话」的决定，不是全局偏好。
  function reset() {
    enabled = false;
    sourceBranch = null;
    onChange(snapshot());
  }

  // 分支列表按 cwd 缓存。拉失败不抛：UI 退化成"只能用当前分支"，比整个新会话页报错强。
  async function ensureBranches(cwd) {
    if (!cwd || loadedFor === cwd) return snapshot();
    const socket = context?.socket;
    if (!socket) return snapshot();
    loadedFor = cwd;
    loadError = null;
    const res = await new Promise(resolve => {
      let settled = false;
      const done = value => { if (!settled) { settled = true; resolve(value); } };
      setTimeout(() => done(null), BRANCH_ACK_TIMEOUT_MS);
      try {
        socket.emit('git:branches', { cwd }, done);
      } catch {
        done(null);
      }
    });
    if (!res) {
      loadError = t('读取分支超时');
    } else if (!res.ok) {
      // not_git 是正常状态（工作区不是 git 仓库），不是错误——文案要分开，否则每次开非 git
      // 工作区的新会话都弹一个红字，而那里本来就不该有 worktree 这个选项。
      loadError = res.code === 'not_git' ? null : (res.error || t('读取分支失败'));
      branches = [];
      currentBranch = null;
    } else {
      branches = Array.isArray(res.branches) ? res.branches : [];
      currentBranch = typeof res.current === 'string' ? res.current : null;
    }
    onChange(snapshot());
    return snapshot();
  }

  // 该工作区支持 worktree 吗：不是 git 仓库就没有这个概念，UI 上整个不显示
  const isAvailable = () => Boolean(currentBranch);

  // 随第一条 user:message 一起发出的附加参数。没勾就返回空对象——旧行为逐字不变。
  function newSessionArgs() {
    if (!enabled) return {};
    const branch = effectiveBranch();
    return branch ? { useWorktree: true, sourceBranch: branch } : { useWorktree: true };
  }

  return {
    snapshot,
    isEnabled: () => enabled,
    isAvailable,
    setEnabled,
    setSourceBranch,
    ensureBranches,
    newSessionArgs,
    reset,
  };
}
