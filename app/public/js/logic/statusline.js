// logic/statusline.js —— statusline 折叠摘要/剪贴板/ctx · unified diff
//
// 红线（拆分后由每个子模块各自承担，原文与 logic.js barrel 同源）：
// 只做数据→数据，不得触碰 DOM / window / socket / 应用可变状态（会话、实例、连接态等）。
// 目的：让浏览器 import 与 tests/unit/logic-*.test.mjs（node:test）共用同一份逻辑，零构建。
// 唯一允许的宿主外 import 是 ../i18n.js（纯查表 + 一个语言开关，node 与浏览器行为一致）；
// 同层 logic/ 子模块之间可以互相 import，但不得成环（npm run check 的 import 边界守卫会拒）。
// 想再加 import 前先自问：新依赖能在裸 node 里被 import 且不碰宿主 API 吗？不能就别加。

/** token 短格式：1.0m / 13k / 42；round 到 k 后 ≥1000 抬升 m，避免 1000k */
export function statuslineFmtTok(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}m`;
  if (n >= 1e3) {
    const k = Math.round(n / 1e3);
    if (k >= 1000) return `${(k / 1000).toFixed(1)}m`;
    return `${k}k`;
  }
  return String(n);
}

/** git 短文案：branch +暂存 !改动 ?未跟踪 ↑ahead ↓behind（对齐展开态） */
export function formatStatuslineGitBrief(git) {
  if (!git?.branch) return '';
  let b = String(git.branch);
  if (git.staged || git.modified || git.untracked) {
    if (git.staged) b += ` +${git.staged}`;
    if (git.modified) b += ` !${git.modified}`;
    if (git.untracked) b += ` ?${git.untracked}`;
  } else if (git.changed) {
    b += ` ✱${git.changed}`;
  }
  if (git.ahead) b += ` ↑${git.ahead}`;
  if (git.behind) b += ` ↓${git.behind}`;
  return b;
}

/**
 * 顶栏工作区 pill 的「未提交改动数」角标文案（空串＝隐藏）。
 * 存在的理由：工作区面板（文件/改动）此前全靠用户主动点 pill 才能发现；有改动时让入口自己招手。
 *
 * 口径取 changed（`git status --porcelain` 行数，一文件一条），**不取 staged+modified+untracked 之和**
 * ——三分不互斥，`MM`（既暂存又有新改动）会被双计，见 src/ops/statusline.js parsePorcelain。
 * 数据源是 status_line 事件里现成的 git 段，不额外发 git:status；git 段缺席（非 git 仓库 /
 * WEB_STATUSLINE=off / git 不可用）即隐藏，与 gitStatus 自身「优雅缺席」的口径一致。
 */
export function formatWorkspaceChangeBadge(git) {
  if (!git?.branch) return '';                          // 非 git 仓库 / git 段缺席
  const n = git.changed;
  if (!Number.isInteger(n) || n <= 0) return '';        // 干净、缺字段、NaN、负数、字符串一律隐藏
  return n > 99 ? '99+' : String(n);                    // pill 空间有限，超 99 截断
}

/** ctx 短文案：优先百分比，否则绝对 token */
export function formatStatuslineCtxBrief(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  if (Number.isFinite(ctx.usedPercent)) return `ctx ${Math.round(ctx.usedPercent)}%`;
  if (Number.isFinite(ctx.tokens)) return `ctx ${statuslineFmtTok(ctx.tokens)}`;
  return '';
}

/**
 * ctx left Y/Z：剩余 / 窗口。占用优先级（必须与 usedPercent 同源，禁 lastUsage 单轮假 remaining）：
 * 1) totalTokens（SDK getContextUsage 全量）
 * 2) usedPercent×window（有 % 时；即使 tokens 非 0 也不信单轮 lastUsage）
 * 3) tokens（仅无 %：CLI total_input / 静态路径）
 * 4) 明确 0 占用 → left=window
 * 无 windowSize → ''。
 */
export function formatStatuslineCtxLeft(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const win = ctx.windowSize;
  if (!Number.isFinite(win) || win <= 0) return '';
  let used;
  if (Number.isFinite(ctx.totalTokens) && ctx.totalTokens > 0) used = ctx.totalTokens;
  else if (Number.isFinite(ctx.usedPercent) && ctx.usedPercent > 0) {
    used = Math.round(win * Math.min(100, Math.max(0, ctx.usedPercent)) / 100);
  } else if (Number.isFinite(ctx.tokens) && ctx.tokens > 0) used = ctx.tokens;
  else if (
    (Number.isFinite(ctx.totalTokens) && ctx.totalTokens === 0)
    || (Number.isFinite(ctx.usedPercent) && ctx.usedPercent === 0)
    || (Number.isFinite(ctx.tokens) && ctx.tokens === 0)
  ) {
    used = 0;
  } else {
    return '';
  }
  return `left ${statuslineFmtTok(Math.max(0, win - used))}/${statuslineFmtTok(win)}`;
}

/**
 * 折叠 summary：git · ctx；皆无时回落 'statusline'（CLI 不可用态由调用方另写）。
 */
export function formatStatuslineCollapsedSummary(p) {
  const parts = [];
  const git = formatStatuslineGitBrief(p?.git);
  const ctx = formatStatuslineCtxBrief(p?.ctx);
  if (git) parts.push(git);
  if (ctx) parts.push(ctx);
  return parts.length ? parts.join(' · ') : 'statusline';
}

/**
 * 点按复制用的多行纯文本（git/ctx/model/cost/sid/source…），便于粘到 issue。
 */
export function formatStatuslineCopyText(p) {
  if (!p || typeof p !== 'object') return '';
  const lines = [];
  const summary = formatStatuslineCollapsedSummary(p);
  if (summary && summary !== 'statusline') lines.push(summary);
  if (p.model) lines.push(`model ${p.model}`);
  if (p.effort) lines.push(`effort ${p.effort}`);
  if (p.project) lines.push(`project ${p.project}`);
  if (p.git?.repo) lines.push(`repo ${p.git.repo}`);
  if (Number.isFinite(p.cost)) lines.push(`est $${Number(p.cost).toFixed(2)}`);
  if (p.session?.id) lines.push(`sid ${p.session.id}`);
  if (p.source?.kind === 'cli') lines.push('source CLI');
  if (p.source?.kind === 'sdk') lines.push('source Web SDK');
  if (p.version) lines.push(`v${p.version}`);
  return lines.join('\n');
}

// Edit/MultiEdit 工具卡「预览变更」超过这么多行就不值得算 LCS——old/new_string 本是 Claude 挑的
// 紧凑定位锚点，正常几行到几十行；真撞到这个量级多半是异常输入，调用方应退回整块红/绿块渲染。
export const MAX_DIFF_LINES_FOR_LCS = 500;

// 行级 unified diff（经典 LCS 动态规划）：把 old_string/new_string 拆成逐行 "  同" / "- 删" / "+ 增"
// 前缀字符串数组，交给 git-changes.js renderPatchLines 复用着色（它认 +/-/@@ 行首前缀）。片段小
// （见上）：O(n·m) 无压力，不做 @@ 折叠——Edit 的 old/new 本就局部，摊开比猜"哪段能折叠"更可靠。
export function unifiedDiffLines(oldStr, newStr) {
  const oldS = String(oldStr ?? ''), newS = String(newStr ?? '');
  // 纯新增/纯删除单独短路：''.split('\n') 恒产出 [''] 一个"空行"，若落进下方通用 LCS 会多算出一条
  // 无对应内容的 - / + 行（渲染层显示成一条空白红/绿条）。只在恰好一侧整体为空串时短路——两侧都空
  // （degenerate 场景）、或只是尾部多个换行符（如 'a\nb' → 'a\nb\n'，newLines 是 ['a','b','']，
  // 长度>1 非整体空串）不受影响，仍走通用路径，那些情况的空行是真实变更、该显示。
  if (oldS === '' && newS !== '') return newS.split('\n').map(l => `+ ${l}`);
  if (newS === '' && oldS !== '') return oldS.split('\n').map(l => `- ${l}`);
  const oldLines = oldS.split('\n');
  const newLines = newS.split('\n');
  const n = oldLines.length, m = newLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      out.push(`  ${oldLines[i]}`);
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push(`- ${oldLines[i]}`);
      i++;
    } else {
      out.push(`+ ${newLines[j]}`);
      j++;
    }
  }
  while (i < n) { out.push(`- ${oldLines[i]}`); i++; }
  while (j < m) { out.push(`+ ${newLines[j]}`); j++; }
  return out;
}

// ---- P3 工作区抽屉：SWR 缓存保鲜 + 按目录局部重建 ----
// 断线重连 / 后台实例变化时，旧实现要么整段清空 sessionsCache（哪怕只有一个目录真变了），要么靠单一
// 全局 structKey 触发 openSessionPanel() 全量重建整个抽屉——即使用户只是切到后台又切回、数据其实没变，
// 也会"清空→骨架屏→等网络往返"，观感等同"重新拉了一遍数据"。以下两组纯函数把决策拆成两层，故意不
// 合并成一个函数（关注点不同：一个管缓存内容要不要重渲染，一个管要不要重建 DOM 子树）：
// ① session:list 响应内容签名比较；② 按目录分键的实例签名 diff。
