// E16：composer 上方的 web 状态栏——status_line 事件的原生 DOM 渲染（摘要 + 展开明细）、复制按钮、切视图时收起。
// #359 Step 2 从 app.js 原样迁出；app.js 里跨模块的可变态经 getter 注入，声明在实例化点之后的依赖经惰性包装注入。

import { formatAgoShort, formatCachePercent, formatStatuslineCollapsedSummary, formatStatuslineCopyText, formatStatuslineCtxLeft, shouldRenderStatusline } from '../logic.js';
import { t } from '../i18n.js';

export function createStatuslineView({
  $, addBar, messagesEl, renderLiveLine, updateWorkspaceChangeBadge, getCurrentCwd, getLiveLine,
  getViewingInstanceId,
} = {}) {
  const cliStatusEl = $('cliStatus');   // E16：web 状态栏容器（status_line 事件填充，原生 DOM 结构化渲染非 ANSI）
  const cliStatusBarEl = $('cliStatusBar'); // E16：状态栏外层（含 details + 复制按钮；揭示=去 hidden）
  const cliStatusWrapEl = $('cliStatusWrap'); // E16：状态栏 <details>（open=展开明细）
  const cliSummaryEl = $('cliSummary'); // E16：折叠条摘要 git · ctx（formatStatuslineCollapsedSummary）
  const cliStatusCopyBtn = $('cliStatusCopy'); // 点按复制（summary 外独立按钮，#403）
  let lastStatusLinePayload = null; // 最近一次 status_line，供复制
  if (cliStatusCopyBtn) {
    cliStatusCopyBtn.addEventListener('click', async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const text = formatStatuslineCopyText(lastStatusLinePayload)
        || (cliSummaryEl?.textContent || '').trim();
      if (!text || text === 'statusline') {
        addBar(t('暂无状态可复制'), 'text-ink-faint');
        return;
      }
      try {
        if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
        else {
          const ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        }
        addBar(t('已复制状态摘要'), 'text-success');
      } catch {
        addBar(t('复制失败'), 'text-danger');
      }
    });
  }
  // E16：status_line 渲染（原 dispatcher handler 方法体，#359 提成函数以便迁出）
  function renderStatusLine(p) {
    if (!p || typeof p !== 'object') return;
    // 守护：如果 payload 里的 instanceId 与前端当前的 viewingInstanceId 不一致，则丢弃渲染（防止旧 tab 覆盖）
    if (p.instanceId && getViewingInstanceId() && p.instanceId !== getViewingInstanceId()) return;
    // 兼容陈旧重放：老 payload 可能没有 instanceId，但仍带 cwd；用 cwd 兜底防止别的工作区状态线覆盖当前视图。
    if (!p.instanceId && p.cwd && getCurrentCwd() && p.cwd !== getCurrentCwd()) return;
    // 顶栏 pill 改动角标：复用上面两道同源守护（防跨工作区串号），但**必须在下面两处早退之前**更新
    // ——`!cliStatusEl`（statusline 容器缺失）与 `empty-start`（空启动页）都与角标无关，角标挂在顶栏
    // 而非状态栏里，不该被状态栏的存在与否绑架。
    updateWorkspaceChangeBadge(p.git);
    if (!cliStatusEl) return;
    // per-turn 权威秒表/token（agent.turnStartedAt/turnOutputTokens）：刷新/切实例回来后 live 行恢复真值
    if (p.turn && getLiveLine()) {
      getLiveLine().serverTurnStartedAt = Number(p.turn.startedAt) || null;
      getLiveLine().outTokens = Number(p.turn.outTokens) || null;
      renderLiveLine();
    }
    // 空首页采用极简底部：模型/权限/思考 chips 即可。compose 页例外——工作区已定，git 段照渲
    // （判据与两侧理由见 logic/statusline.js shouldRenderStatusline）。
    //
    // 第二个参数问 DOM 而不是读 _composeReady：那个标志在「会话已中断」表面上会是陈旧的 true
    // （bindView 的 destroyed 分支先于 leaveComposeReady 提前 return），拿它当判据会把上一个实例的
    // ctx/模型渲染到中断表面上。当前渲染着什么表面，只有 DOM 说了算。
    if (!shouldRenderStatusline({
      emptyStart: messagesEl.classList.contains('empty-start'),
      composeSurface: Boolean(messagesEl.querySelector('[data-testid="compose-surface"]')),
    })) return;
    // 与 statuslineFmtTok 同边界：round 到 k 后 ≥1000 抬 m，避免 1000k
    const fmtTok = n => {
      if (n >= 1e6) return (n / 1e6).toFixed(1) + 'm';
      if (n >= 1e3) { const k = Math.round(n / 1e3); return k >= 1000 ? (k / 1000).toFixed(1) + 'm' : k + 'k'; }
      return String(n);
    };
    const fmtMs = ms => { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h}h${String(m).padStart(2, '0')}m` : m ? `${m}m${String(x).padStart(2, '0')}s` : `${x}s`; };
    // F2：带 1 位小数；≥1000.0k 抬 m，避免 1000.0k
    const fmtTokF = n => {
      if (n >= 1e6) return (n / 1e6).toFixed(1) + 'm';
      if (n >= 1e3) {
        const k = n / 1e3;
        if (k >= 1000) return (k / 1000).toFixed(1) + 'm';
        return k.toFixed(1) + 'k';
      }
      return String(n);
    };
    // 额度重置倒计时：ISO resets_at → 相对时长（对齐 CLI statusline `reset 2h05m`）
    const fmtReset = iso => {
      if (!iso) return '';
      const parsed = Date.parse(iso);
      if (!Number.isFinite(parsed)) return '';
      const rem = Math.max(0, parsed - Date.now());
      if (rem <= 0) return 'now';
      const totalMins = Math.ceil(rem / 60_000);
      const days = Math.floor(totalMins / 1440), hours = Math.floor((totalMins % 1440) / 60), mins = totalMins % 60;
      if (days > 0) return `${days}d${hours}h${String(mins).padStart(2, '0')}m`;
      if (hours > 0) return `${hours}h${String(mins).padStart(2, '0')}m`;
      return `${mins}m`;
    };
    // 折叠摘要：git · ctx（模型/effort 已在底栏 pill）；展开仍有 CLI 全量
    lastStatusLinePayload = p;
    if (cliSummaryEl) cliSummaryEl.textContent = formatStatuslineCollapsedSummary(p);
    // 展开详情：CLI 密集风、分段着色、纯 DOM 构建。seg = {text,cls} 或 {node}。配色用项目语义色 token
    // （随明/暗主题），不硬塞 CLI 的 Catppuccin。每个非首段把分隔符 │ 与内容打包成一个不可拆的 cell，
    // 这样窄屏 flex-wrap 折行时 │ 永远跟着它后面的值走、不会被孤零零甩到行尾。
    const span = (text, cls) => { const s = document.createElement('span'); if (cls) s.className = cls; s.textContent = text; return s; };
    const row = segs => {
      const segsF = segs.filter(Boolean);
      if (!segsF.length) return null;
      const line = document.createElement('div');
      line.className = 'flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5';
      segsF.forEach((seg, i) => {
        const content = seg.node || span(seg.text, seg.cls);
        if (!i) { line.appendChild(content); return; }
        const cell = document.createElement('span');
        cell.className = 'inline-flex items-baseline gap-x-1.5'; // │ + 内容打包，防分隔符落行尾
        cell.appendChild(span('│', 'text-ink-faint opacity-40'));
        cell.appendChild(content);
        line.appendChild(cell);
      });
      return line;
    };
    // 额度段公共构建（对齐 CLI）：5h X% [reset …] │ 7d Y% [reset …]。抽成函数供两处复用——
    // 正常态尾段（行B，下方）与 cli-unavailable 分支（账号级回落值展示）共享同一份文案/配色
    // 规则，避免后续只改一处、漏改另一处。
    const buildRateSegs = rate => {
      const segs = [];
      if (rate?.fiveHour && Number.isFinite(rate.fiveHour.usedPercent)) {
        const pc = rate.fiveHour.usedPercent;
        let label = `5h ${Math.round(pc)}%`;
        const r = fmtReset(rate.fiveHour.resetsAt);
        if (r) label += ` reset ${r}`;
        segs.push({ text: label, cls: pc >= 90 ? 'text-danger' : pc >= 70 ? 'text-warning' : 'text-info' });
      }
      if (rate?.sevenDay && Number.isFinite(rate.sevenDay.usedPercent)) {
        const pc = rate.sevenDay.usedPercent;
        let label = `7d ${Math.round(pc)}%`;
        const r = fmtReset(rate.sevenDay.resetsAt);
        if (r) label += ` reset ${r}`;
        segs.push({ text: label, cls: pc >= 90 ? 'text-danger' : pc >= 70 ? 'text-warning' : 'text-info' });
      }
      return segs;
    };
    // 额度新鲜度标注：三条来源（本轮实时 / 节流窗内复用的缓存 / 账号级快照回落）在 payload 里
    // 形状完全相同，这一段是用户唯一的分辨依据。阈值判定留在后端（statusline.js
    // applyRateFreshness / RATE_STALE_AFTER_MS）——跨前后端各存一份常量必然漂移。
    const rateFreshnessSeg = () => {
      if (!p.rateFromSnapshot && !p.rateStale) return null;
      const label = p.rateFromSnapshot ? t('(账号级旧值，非实时)') : t('(非实时)');
      const age = Number.isFinite(p.rateAgeMs) ? ` · ${formatAgoShort(p.rateAgeMs)}` : '';
      return { text: `${label}${age}`, cls: 'text-ink-faint' };
    };
    const linesArr = [];

    if (p.source?.kind === 'cli-unavailable') {
      cliStatusEl.textContent = '';
      const unavailable = document.createElement('div');
      unavailable.className = 'flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5';
      unavailable.appendChild(span(t('CLI 状态暂不可用'), 'text-warning font-medium'));
      if (p.source.reason) unavailable.appendChild(span(`(${p.source.reason})`, 'text-ink-faint'));
      cliStatusEl.appendChild(unavailable);
      // 额度是唯一例外：仅当 rateFromSnapshot 显式标记为账号级快照回落值时才展示，且必须清楚
      // 标注"非实时"——不能让用户误以为 CLI 状态本身是好的。其余字段（model/git/ctx/token/cache
      // 等）仍严格遵守下面 return 处的注释、绝不混入陈旧字段，此处不因为顺手展示额度而放宽。
      const staleRateSegs = (p.rate && p.rateFromSnapshot) ? buildRateSegs(p.rate) : [];
      if (staleRateSegs.length) {
        const fresh = rateFreshnessSeg();
        if (fresh) staleRateSegs.push(fresh);
        const staleRateRow = row(staleRateSegs);
        if (staleRateRow) cliStatusEl.appendChild(staleRateRow);
      }
      lastStatusLinePayload = p;
      if (cliSummaryEl) cliSummaryEl.textContent = staleRateSegs.length ? t('statusline · CLI 暂不可用（额度沿用旧值）') : t('statusline · CLI 暂不可用');
      cliStatusBarEl?.classList.remove('hidden');
      return; // CLI owner 缺/陈旧时明确空缺，绝不把上一份 SDK/CLI 字段混进来（额度回落值是唯一例外，见上）
    }

    // git 段（分支 +暂存 !改动 ?未跟踪 ↑ahead ↓behind）。三分对齐 CLI；陈旧 payload 无三分时回退 ✱changed。
    // 不含 git 工作区 +ins/−del（web 独有口径已删；会话工具改行走 lines +/−）。
    let gitNode = null;
    if (p.git?.branch) {
      let b = p.git.branch;
      if (p.git.staged || p.git.modified || p.git.untracked) {
        if (p.git.staged) b += ` +${p.git.staged}`;
        if (p.git.modified) b += ` !${p.git.modified}`;
        if (p.git.untracked) b += ` ?${p.git.untracked}`;
      } else if (p.git.changed) {
        b += ` ✱${p.git.changed}`;
      }
      if (p.git.ahead) b += ` ↑${p.git.ahead}`;
      if (p.git.behind) b += ` ↓${p.git.behind}`;
      gitNode = span(b, 'text-accent font-medium');
    }
    // ctx 段：有 usedPercent → 'ctx X% · left Y/Z'（Y=剩余 Z=窗口总量，对齐本机 CLI statusline.sh 里
    // elif 分支已用的 '/' 记法，这里扩展到有百分比的分支）；否则退回绝对 token 数（认不出 model 的窗口）。
    // left 走 formatStatuslineCtxLeft：优先 totalTokens（与 usedPercent 同源），避免 lastUsage=0 假 1.0m/1.0m。
    let ctxSeg = null;
    if (p.ctx && Number.isFinite(p.ctx.usedPercent)) {
      let txt = `ctx ${p.ctx.usedPercent}%`;
      const left = formatStatuslineCtxLeft(p.ctx);
      if (left) txt += ` · ${left}`;
      const pc = p.ctx.usedPercent; // 蓝(健康)→橙(≥70)→红(≥90) 三段警示
      ctxSeg = { text: txt, cls: pc >= 90 ? 'text-danger' : pc >= 70 ? 'text-warning' : 'text-ink-soft' }; // UI-011 数据色非链接蓝
    } else if (p.ctx && Number.isFinite(p.ctx.tokens)) {
      ctxSeg = { text: `ctx ${fmtTok(p.ctx.tokens)}`, cls: 'text-ink-soft' };
    }
    // 行A（headline，对齐 CLI 首行）：model │ effort │ location │ git │ ctx │ 版本
    // location = project（cwd 末段）或 git.repo 短名；model 作标题、与 CLI 首段一致；底部 pill 仍是选择器。
    const modelText = p.model ? (p.model.length > 26 ? p.model.slice(0, 25) + '…' : p.model) : '';
    const location = p.project || (p.git?.repo ? p.git.repo.split('/').pop() : '');
    linesArr.push(row([
      modelText && { text: modelText, cls: 'text-ink font-medium' },
      p.effort && { text: `effort ${p.effort}`, cls: 'text-warning' },
      typeof p.thinking?.enabled === 'boolean' && { text: `think ${p.thinking.enabled ? 'on' : 'off'}`, cls: 'text-ink-soft' },
      location && { text: location, cls: 'text-info' },
      gitNode && { node: gitNode },
      ctxSeg,
      p.version && { text: `v${p.version}`, cls: 'text-ink-faint' }
    ]));

    // token 明细段（对齐 CLI）：uncached <未缓存输入> response <输出>
    let tokenNode = null;
    if (p.ctx && Number.isFinite(p.ctx.in)) {
      tokenNode = span(`uncached ${fmtTokF(p.ctx.in)} response ${fmtTokF(p.ctx.out || 0)}`, 'text-ink-soft');
    }
    // cache 明细段（对齐 CLI）：cache <命中率>.XX% write <cache写> read <cache读>；命中率按 r/tokens 重算 2 位小数
    let cacheNode = null;
    if (p.ctx && Number.isFinite(p.ctx.w) && Number.isFinite(p.ctx.r)) {
      const rate = formatCachePercent(p.ctx.tokens > 0 ? (p.ctx.r / p.ctx.tokens) : 0);
      cacheNode = document.createElement('span');
      cacheNode.appendChild(span(`cache ${rate}`, 'text-ink-soft'));
      cacheNode.appendChild(document.createTextNode(' '));
      cacheNode.appendChild(span(`write ${fmtTokF(p.ctx.w)} read ${fmtTokF(p.ctx.r)}`, 'text-ink-faint'));
    }
    // 额度段（对齐 CLI）：5h X% [reset …] │ 7d Y% [reset …]。构建逻辑见上方 buildRateSegs
    // （与 cli-unavailable 分支共用，避免重复实现两遍）。
    // rateFromSnapshot：正常路径也必须标注"非实时"——否则 SDK/CLI 回落值会看起来像活数据
    // （code review：此前只在 cli-unavailable 分支加了 disclaimer，正常行漏标）。
    const rateSegs = buildRateSegs(p.rate);
    if (rateSegs.length) {
      const fresh = rateFreshnessSeg();
      if (fresh) rateSegs.push(fresh);
    }
    // 行B（遥测，对齐 CLI 次行）：5h/7d │ uncached/response │ cache%+write/read
    linesArr.push(row([
      ...rateSegs,
      tokenNode && { node: tokenNode },
      cacheNode && { node: cacheNode }
    ]));

    // 行C（成本/耗时/改行，对齐 CLI）：est $成本 │ total 墙钟 │ api 耗时 │ lines +A/-R
    linesArr.push(row([
      Number.isFinite(p.cost) && { text: `est $${p.cost.toFixed(2)}`, cls: 'text-success' },
      p.duration && p.duration.wallMs && { text: `total ${fmtMs(p.duration.wallMs)}`, cls: 'text-ink-faint' },
      p.duration && p.duration.apiMs && { text: `api ${fmtMs(p.duration.apiMs)}`, cls: 'text-ink-faint' },
      p.lines && (p.lines.added || p.lines.removed) && { text: `lines +${p.lines.added || 0}/-${p.lines.removed || 0}`, cls: 'text-success' }
    ]));
    // 行D（会话身份/元数据，弱化为 faint）：repo │ sid
    // 不含时钟（web 独有已删）；不含 pid/transcript/PR/wt（CLI 独有、SDK 路径不产出或不接）。
    linesArr.push(row([
      p.git?.repo && { text: p.git.repo, cls: 'text-ink-faint' },
      p.session?.id && { text: `sid ${p.session.id.slice(0, 8)}`, cls: 'text-ink-faint' },
      // 来源标签跟界面语言走（验收 O43②）；「复制」出去贴 issue 的那份（formatStatuslineCopyText）保持英文
      p.source?.kind === 'cli' && { text: t('来源：终端（CLI）'), cls: 'text-info' },
      p.source?.kind === 'sdk' && { text: t('来源：网页（SDK）'), cls: 'text-ink-faint' }
    ]));

    // 一次性替换：清空旧节点 + append 非空行（row 对空行返回 null）
    cliStatusEl.textContent = '';
    linesArr.filter(Boolean).forEach(l => cliStatusEl.appendChild(l));
    cliStatusBarEl?.classList.remove('hidden'); // 揭示折叠包裹（默认折叠为 summary 摘要）
  }


  // 收起状态栏并清掉陈旧内容。两个调用者都是「视图换了人，旧数据立刻失真」：clearView（切会话）与
  // showComposeSurface（点 ＋ 开新会话）。两边都随后由新的 status_line 填回。
  //
  // home 表面刻意【不】调：那里 syncComposerVisibility 会把整个 #composerFooter 隐藏，状态栏在它
  // 里面，跟着一起不可见——再调一次是纯冗余（注入验证过：删掉不会让任何用例变红）。
  // destroyed 表面【要调】，别照着 home 类推：从 compose 首发跳过去时 _composeReady 仍是 true，
  // shouldShowComposer 于是判显示，footer 没隐藏，状态栏会原地留在中断表面上。
  function hideStatuslineWrap() {
    if (cliStatusEl) cliStatusEl.innerHTML = '';
    if (cliSummaryEl) cliSummaryEl.textContent = 'statusline';
    if (cliStatusWrapEl) {
      cliStatusWrapEl.removeAttribute('open'); // 折叠 <details>
    }
    if (cliStatusBarEl) {
      cliStatusBarEl.classList.add('hidden');
    }
  }

  return { cliStatusBarEl, hideStatuslineWrap, renderStatusLine };
}
