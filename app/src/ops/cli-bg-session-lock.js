// CLI session lock —— 会话被别的 claude 进程独占时的用户文案。
//
// CLI 2.1.220 在 `--resume <sessionId>` 前会自查一次（内部 `_Pe`）：注册表里若存在 sessionId 相同、
// pid 非自己、kind 存在且 kind !== 'interactive' 的活条目，就直接报错退出：
//   Error: Session <id> is currently running as a background agent (<kind>).
//   Use `claude agents` to find and attach to it, or add --fork-session to branch off a copy.
// 判据本身在 session-registry.js 的 findBlockingLiveAgent（与上面逐条对齐），本模块只负责说人话。
//
// 2026-07-30 删除的东西，别照着旧 commit 加回来：本模块曾提供 listCliAgents / findBgLocksForSession /
// releaseBgLocksForSession / prepareSessionForWebResume 一整套「web resume 前 SIGTERM 掉占用者」的
// 自动释放逻辑。它让「在 web 上点开会话」变成破坏性操作——判据只看 sessionId+kind、不看那个后台任务
// 是否正在干活，实测杀中过 state=working 的真实任务，用户侧表现为 CLI 会话被中断。CLI 官方给的出路
// 是 attach 或 --fork-session 分叉副本，杀掉占用者从来不在其中。现在的契约：resume 前不碰任何 CLI 进程，
// 打不开就明说。

/**
 * User-facing reason for "this session is held by another claude process".
 *
 * kind 取值有两套口径且不一致：`claude agents --json` 对同一进程报 'background'，
 * 而 ~/.claude/sessions/<pid>.json 注册表报 'bg'。这里按「非 interactive 即后台占用」收口，
 * 与 CLI 自己的 `kind !== 'interactive'` 判据同源——只认 'background' 会让注册表口径的调用方
 * 掉进最后那条通用兜底，吐出「CLI 未完成初始化」这种驴唇不对马嘴的文案。
 */
export function formatSessionLockError({ kind, name, pid, rawMessage } = {}) {
  const who = name ? `「${name}」` : '';
  if (kind === 'interactive') {
    return `会话正被终端 CLI${who}驾驶中（pid ${pid || '?'}）。请先在该终端退出/结束会话，或等空闲回收后再从 web 打开`;
  }
  if (kind) {
    return `会话正被 CLI 后台任务${who}占用（pid ${pid || '?'}）。从 web 打开会中断它，所以没有打开——请在本机 \`claude agents\` 接管，或等它跑完再开`;
  }
  const raw = typeof rawMessage === 'string' ? rawMessage.trim() : '';
  if (/background agent/i.test(raw)) {
    return '会话被 CLI 后台 agent 占用。web 不会去动它——请在本机 `claude agents` 接管，或等它跑完再开';
  }
  return raw || '无法恢复会话（CLI 未完成初始化），请新建会话或从列表选择其他会话';
}
