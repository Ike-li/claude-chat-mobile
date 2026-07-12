// history.js —— 读取 CLI 会话历史用于前端展示（方案 2）
// CLI 历史文件：~/.claude/projects/<project>/<session_id>.jsonl
import { open, stat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { MAX_SESSION_LIMIT } from './workdirs.js';

// CLI transcript 根目录，与 CLI /resume 同源。硬编码 ~/.claude/projects：这是 CLI 的固定约定，且
// L2 删除走 SDK 官方 deleteSession（它同样只认此真实根、无自定义根的口子），故这里不设环境变量覆盖——
// 设了也只能隔离本模块的"读"、隔离不了 SDK 的"删"，反而制造读写目录分叉。单测走各函数的 baseDir
// 参数注入实现隔离；需要真跑 L2 删除的集成测试直接用真实目录下的一次性随机子目录 + 严格清理。
const CLAUDE_DIR = join(homedir(), '.claude', 'projects');
// 历史回显防爆上限：极端超大会话只回最近 N 条 user/assistant，避免一次性把手机 DOM 撑爆。
// 正常会话（几百条内）全量返回——与 CLI /resume 的完整历史一致（终端等价性）。不再按字节截断头部。
export const HISTORY_MAX_MESSAGES = 2000;
const HEAD_READ_BYTES = 64 * 1024;  // 列表元数据（标题/模型/来源）只需文件头部少量字节
// CLI 把 ai-title 流式追加到「标题生成完成时」的字节位置——首轮工具/思考很重的长会话里常 > 64KB 头窗。
// 头窗没抓到 ai-title 时补读文件尾部这一段取最新 ai-title（实测最坏「最后一个 ai-title 距文件尾」330KB，512KB 有余量）。
const TAIL_READ_BYTES = 512 * 1024;
// 会话列表上限（按 mtime 取最近 N，避免大目录全量读 head）。与 workdirs.js MAX_SESSION_LIMIT 共享同一
// 常量而非各自硬编码 50——此前两处独立维护、仅靠注释宣称"一致"，任一方单独改动会静默漂移。
const LIST_LIMIT = MAX_SESSION_LIMIT;

// B2：listSessions 结果按 dir 缓存，4s TTL。重复打开列表不重扫盘。
const _listCache = new Map(); // dir → { ts, result }
const LIST_CACHE_TTL = 4000;

// B6：getSessionHistory 结果按文件路径缓存，按 mtimeMs 失效。切回同一会话无需重新读盘。
const _histCache = new Map(); // filePath → { mtimeMs, messages }
const HIST_CACHE_MAX = 10;

// 根据 cwd 推断项目目录名。CLI 命名规则：路径中所有非字母数字字符（/、.、_ 等）都替换为 -（不折叠连续 -）。
// cwd 须先经 realpath 规范化（server.js 启动期做），才与 CLI 的 ~/.claude/projects 命名一致（如 /tmp→/private/tmp）。
// 导出供 listSessions 与单测用。
export function getProjectDir(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

// 读取会话历史消息（仅 user/assistant，过滤工具调用等内部事件）。
// 流式读【完整】文件——与 CLI /resume 同源、不按字节截断头部，做到 Web 端看到的历史 = CLI 的全量历史。
//
// 【已评估：不迁 SDK 官方 getSessionMessages（2026-07-12 实证）】SDK 0.3.201 有官方 getSessionMessages，但
// 实测（真实 1526 行会话）它返回 1115 条**原始消息**（message 为未解析的 {role,content}，含全部 tool_use/
// tool_result/thinking/子agent/系统行），**零噪音过滤、不提取文本**；本函数过滤后仅剩 46 条真实对话。迁移后
// 这 7 层过滤（isMeta/isSidechain/parent_tool_use_id/CLI 系统行/task-notification/uuid 去重——都是踩坑补齐的
// 非显而易见 CLI 行为）一条都省不掉、全得保留，且 SDK 一次性全量载入比现在流式读+提前过滤更耗内存。净负收益，
// 故保留自实现。别再因"有官方 API"重启这个迁移。
export async function getSessionHistory(sessionId, cwd, limit = HISTORY_MAX_MESSAGES, { baseDir = CLAUDE_DIR } = {}) {
  const projectDir = getProjectDir(cwd);
  const historyFile = join(baseDir, projectDir, `${sessionId}.jsonl`);

  let mtimeMs;
  try {
    ({ mtimeMs } = await stat(historyFile));
  } catch {
    return []; // 文件不存在：新会话或已删
  }

  // B6：mtime 未变 = 内容未变，直接返回缓存。缓存的是封顶到 HISTORY_MAX_MESSAGES 的尾部消息，按 limit 取尾再返回
  // （stat ~1ms，远快于重新流式读盘 + 解析）。
  const cached = _histCache.get(historyFile);
  if (cached && cached.mtimeMs === mtimeMs) return cached.messages.slice(-limit);

  const messages = [];
  // 同 uuid 去重：真实 transcript 存在「interrupt+queue 竞态导致同一消息重复落盘」（同 uuid 写两次）→
  // 回显成重复气泡（实证 234 会话中 1 个含 8 条）。uuid 是每条唯一标识，同 uuid = 同一逻辑消息（非合法重复），
  // 按 uuid 去重安全——合法重复内容（两次「继续」）是不同 uuid、不误删。Set 为本次读取的瞬时结构（返回即释放）。
  const seenUuids = new Set();
  try {
    // 逐行读、不一次性 buffer 整个文件——会话可增长到数十 MB，流式读才稳、不阻塞事件循环
    // （取代原「尾部 1MB」截断方案）。累积数组下方封顶到 HISTORY_MAX_MESSAGES，内存不随会话无限增长。
    const rl = createInterface({
      input: createReadStream(historyFile, { encoding: 'utf-8' }),
      crlfDelay: Infinity
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; } // 末行可能是写入中途的半行 → 跳过

      // 跳过 meta 条目（local-command 输出等）
      if (entry.isMeta) continue;

      // 子 agent（sidechain）记录不回显——与运行期 agent.js 的 parent_tool_use_id 守卫等效。
      // 磁盘 JSONL 用 isSidechain 标记子 agent（parent_tool_use_id 是 SDK 运行时流字段、不落盘）；
      // 一并挡 parent_tool_use_id 作防御。带正文的子 agent assistant 靠下方空正文启发式漏不掉，故须显式滤。
      if (entry.isSidechain || entry.parent_tool_use_id) continue;

      // 只取 user 和 assistant 消息；并过滤无正文的条目——纯工具调用的 assistant、
      // 以 tool_result 形式存在的 user 都会被 extractContent 还原成空串。若不滤掉，
      // 它们会渲染成空气泡，还会占满窗口把真实对话挤出去。
      if (entry.type === 'user' || entry.type === 'assistant') {
        const content = extractContent(entry.message?.content);
        if (!content.trim()) continue;
        // 后台任务完成后 CLI 注入的 <task-notification> 是给模型看的系统信号，非用户对话——
        // 回显时跳过，否则重载后会显示成一条原始 XML 用户气泡（后续的 assistant 汇报本身自解释）。
        // 要求成对闭合，避免误伤用户随口以裸 <task-notification> 开头（少含闭合标签）的真实消息。
        if (content.trimStart().startsWith('<task-notification>') && content.includes('</task-notification>')) continue;
        // CLI 写盘的系统行（isMeta=false，漏过上面的 isMeta 闸）：slash 命令注入的 <command-*>/<local-command-*>
        // 标签块、[Request interrupted by user] 打断标记、resume 空 turn 的 'No response requested.'。非对话内容，
        // 回显时跳过——否则会当成 user/assistant 气泡混进历史（见 test「CLI 系统行被过滤」）。
        if (isCliSystemLine(content)) continue;
        // 同 uuid 重复落盘去重（仅 uuid 存在时；缺 uuid 的旧条目不因 undefined 相撞而互删）。
        if (entry.uuid) { if (seenUuids.has(entry.uuid)) continue; seenUuids.add(entry.uuid); }
        messages.push({
          role: entry.message?.role || entry.type,
          content,
          timestamp: entry.timestamp
        });
        // 防爆：流式累积只保留尾部 HISTORY_MAX_MESSAGES 条——返回上限同时是内存上限。否则超大会话会把
        // 【全量】user/assistant 文本常驻进 always-on 进程（再被 _histCache LRU=10 放大），落空本服务
        // 「always-on 要稳」的目标。超 2× 才批量 splice → 均摊 O(1)、不每条 shift。
        if (messages.length > HISTORY_MAX_MESSAGES * 2) {
          messages.splice(0, messages.length - HISTORY_MAX_MESSAGES);
        }
      }
    }
    // 循环后精裁到上限（批量裁剪可能残留至多 2×）：缓存的数组严格 ≤ HISTORY_MAX_MESSAGES。
    if (messages.length > HISTORY_MAX_MESSAGES) {
      messages.splice(0, messages.length - HISTORY_MAX_MESSAGES);
    }
  } catch {
    return []; // 读取失败
  }

  // B6：缓存消息（LRU，超上限淘汰最旧）；已在流式阶段封顶到 HISTORY_MAX_MESSAGES，返回时再按 limit 取尾。
  // 正常会话（≤上限）即全量历史；仅极端超大会话被削顶——既防一次性撑爆前端，也防全量常驻 server 内存。
  if (_histCache.size >= HIST_CACHE_MAX) {
    _histCache.delete(_histCache.keys().next().value);
  }
  _histCache.set(historyFile, { mtimeMs, messages });

  return messages.slice(-limit);
}

// 只读「追平」状态机（纯函数，便于单测）——server 每 tick 用它决定该把哪些【新落定】消息推给 web 端。
// 用于「web 端续接一个正在终端 CLI 里跑的会话」：web 是另起的独立 resume 进程、无法 attach 终端活进程，
// 只能靠轮询磁盘 transcript 追平终端【已落定】的消息（看不到实时 thinking/在跑子 agent——它们不落盘）。
//
// state = { baseline, wasBusy }：baseline=已下发到的消息条数；wasBusy=上次本地实例是否在跑 turn。
// 规则：
//   · 本地实例在跑 turn（localBusy）→ 抑制：此刻 SDK 流才是渲染真相，只记 wasBusy=true、不推、不动 baseline；
//   · 刚 busy→idle（state.wasBusy 且现在 idle）→ 增量归因于「自己刚写盘」，只重置 baseline、不推（吸收己方 turn）；
//   · 持续 idle 期间的增长 → 判为【外部（终端）写入】→ 推 messages 超出 baseline 的尾巴。
// messages = 当前 getSessionHistory 结果（仅 user/assistant 文本、≤HISTORY_MAX_MESSAGES 条）。
// 边界：极端会话 > 2000 条被削头时 len 可能 < baseline → 不推（保守），属已知限制。
// ⚠️ 已知边界（code-review 发现 2，有意不修）：外部（终端）写入若【撞进本地 turn 的 busy→idle 吸收窗口】——
//    即 web 自己 turn 运行期间终端也写了同一会话——会被 wasBusy 分支的整段吸收一并吞掉、停留期间不回显，
//    须切走该会话经前端 diskLen 重载（logic.js shouldReloadOnEnter）才追平。触发面窄（须停留不切 + 恰好并发
//    本地 turn），稳健区分己方/外部写入需 server 传 ownDelta 或内容比对、代价不划算，故接受为已知边界。
//    契约护栏：busy→idle 必须【整段吸收】（emit []），绝不改成把 [baseline,len) 全当外部 emit——否则己方
//    turn 的每条会被 live 流 + history_append 重复渲染成气泡。见 test/mirror-sync.test.mjs 的 skip 说明。
// 【已评估：不做 SP-10 完整闭合（2026-07-12 机主确认，Phase 8 技术债）】LLD §5.1.2/SP-10 的"两路一致性重设计"
//    （去掉 busy→idle 吸收、改增量读 + 幂等去重、busy→idle 立即触发）要真正闭合上述边界，前提是前端 history_append
//    能按 uuid 幂等去重——但实测前端 onHistoryAppend（app.js）无 uuid 去重、live 流气泡也不记 uuid，故"立即触发"
//    简单版无效（仍受契约护栏约束只能吸收），完整版需前端去重 + live 流记 uuid 的联动大改。上述边界触发面窄，
//    n=1 单用户下该大改不值，保留现状。别再因"SP-10 设计验证通过"重启这个接入。
export function catchUpStep(state, { messages, localBusy = false }) {
  const len = messages.length;
  if (localBusy) return { emit: [], state: { baseline: state.baseline, wasBusy: true } };
  if (state.wasBusy) return { emit: [], state: { baseline: len, wasBusy: false } }; // 吸收己方 turn 的写盘
  if (len > state.baseline) return { emit: messages.slice(state.baseline), state: { baseline: len, wasBusy: false } };
  return { emit: [], state: { baseline: state.baseline, wasBusy: false } };
}

// 只读镜像锁的【释放】状态机（纯函数，便于单测）——修 code-review 发现 1：原实现 setMirror(true) 在观测到
// 外部写入时上锁，但没有任何自动释放路径（setMirror(false) 仅在「无查看会话」「切了会话」触发），导致终端
// 写一次就把移动端输入锁死到用户手动切会话/接管为止，即便终端 turn 早已结束。catchUpTick 每 tick 调一次本函数。
// state = { readonly, quietTicks }：
//   · externalWrite（本 tick catchUpStep emit 非空 = 观测到外部落定新【文本】消息）→ 上锁、quietTicks 清零；
//   · localBusy（web 自己在跑 turn）→ 终端是否静默无从判断 → 保持当前锁态、quietTicks 清零（不借己方忙碌攒静默）；
//   · keepAlive（transcript 文件仍在增长=终端在写盘，但落的是 tool_use/tool_result 等不进 text-only catchUpStep len 的条目）
//     → 【已锁时】维持锁、quietTicks 清零，免得终端密集跑工具/思考期间被误判静默而熄横幅；【不上锁】——上锁只靠
//     externalWrite（未锁分支在下方先 return），文件增长不凭空造锁，不把 web 自己 resume 的写盘误判成终端锁；
//   · idle 且无外部写入、文件也不再增长（真静默）→ quietTicks++；累计到 MIRROR_RELEASE_QUIET_TICKS → 自动解锁。
// 保守取舍：keepAlive 用文件增长做「终端还活着」的弱判据【仅延缓解锁】——是本项目刻意规避的「mtime 判活」近亲，
//   但风险低一档（不上锁→绝不误锁死进不去，最坏是终端真停后晚 ~N tick 才解锁）；前端「仍要发送」手动接管仍是兜底。
//   ⚠️ 前提：web 纯查看 idle 期间其自身 resume 进程不 append transcript（否则 keepAlive 恒真→退回锁死，靠接管兜）——须 live 验证。
export const MIRROR_RELEASE_QUIET_TICKS = 5; // ×CATCH_UP_INTERVAL_MS(2.5s) ≈ 12.5s 终端静默 → 自动解锁
export function mirrorReleaseStep(state, { externalWrite = false, keepAlive = false, localBusy = false } = {}) {
  const prevReadonly = Boolean(state?.readonly);
  const prevQuiet = Number(state?.quietTicks) || 0;
  if (externalWrite) return { readonly: true, state: { readonly: true, quietTicks: 0 } };
  if (localBusy) return { readonly: prevReadonly, state: { readonly: prevReadonly, quietTicks: 0 } };
  if (!prevReadonly) return { readonly: false, state: { readonly: false, quietTicks: 0 } };
  if (keepAlive) return { readonly: true, state: { readonly: true, quietTicks: 0 } }; // 终端仍在写盘（跑工具/思考）→ 维持锁、静默清零；不上锁靠上一行未锁 return
  const quietTicks = prevQuiet + 1;
  const readonly = quietTicks < MIRROR_RELEASE_QUIET_TICKS;
  return { readonly, state: { readonly, quietTicks: readonly ? quietTicks : 0 } };
}

// 提取纯文本内容（content 可能是 string 或 array）
function extractContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(block => block?.type === 'text')
      .map(block => block.text)
      .join('\n');
  }
  return '';
}

// 识别 CLI 写盘的「系统行」——非对话内容，但 isMeta=false 会漏过 getSessionHistory 的 isMeta 闸，须按 content
// 形态显式过滤，否则回显成气泡（实测切多次 model/effort + 多次 interrupt 的会话，噪音可达回显的 ~30%）。
// 只认「以标签开头且闭合」/「整条精确等于标记」，避免误伤用户以这些词开头的真实消息（与 <task-notification>
// 要求闭合标签同款谨慎）。API Error（上游/网络错误）是真实运行事件、有诊断价值，不在此列——过滤它属独立决策。
function isCliSystemLine(content) {
  const t = content.trim();
  // slash 命令注入：一次 /model、/effort 等被 CLI 拆成 <command-name>/<command-message>/<command-args>
  // 标签块（起始行 isMeta=false），及其 <local-command-stdout>/<local-command-stderr> 输出。
  if (/^<command-(name|message|args)>/.test(t) && /<\/command-(name|message|args)>/.test(t)) return true;
  if (/^<local-command-(stdout|stderr)>/.test(t) && /<\/local-command-(stdout|stderr)>/.test(t)) return true;
  // `!` bash 模式注入：终端里 ! 前缀跑 bash，CLI 以 <bash-input>/<bash-stdout>/<bash-stderr> 注入输入/输出
  // （role=user、isMeta 缺失，漏过 isMeta 闸）。实证 234 会话漏 4+4 条。
  if (/^<bash-(input|stdout|stderr)>/.test(t) && /<\/bash-(input|stdout|stderr)>/.test(t)) return true;
  // IDE 集成上下文注入：<ide_opened_file>/<ide_selection>/…——CLI 在 IDE 里把「打开的文件/选区」当上下文注入，
  // 非用户对话（实证漏 10+3 条）。用捕获+同名闭合校验，兼容未来其他 <ide_*> 子标签、且仍要求闭合防误伤。
  const ide = /^<(ide_[a-z_]+)>/.exec(t);
  if (ide && new RegExp(`</${ide[1]}>`).test(t)) return true;
  // 用户打断标记（含 [Request interrupted by user] 与 [... for tool use] 变体）。
  if (/^\[Request interrupted by user[^\]]*\]$/.test(t)) return true;
  // Continue/继续 触发的 resume 空 turn 占位（assistant）。
  if (t === 'No response requested.') return true;
  return false;
}

// ---- 会话列表：与 CLI /resume 同源，直接扫 ~/.claude/projects/<编码cwd>/ ----
// 列出该 cwd 下所有会话（含终端 entrypoint:cli 建的），不依赖 sessions.json 注册表。
// baseDir 仅供单测注入临时夹具；生产用默认 CLAUDE_DIR。
// 【已评估：不迁 SDK 官方 listSessions（2026-07-12 实证）】SDK 0.3.201 有官方 listSessions（返回 summary/
// customTitle/firstPrompt/gitBranch 等丰富字段，能省掉本函数的 readdir+N×stat+readHeadMeta），但它**不返回
// entrypoint**（本函数用它区分 cli/sdk 来源、前端据此显来源），且其 summary 的标题语义 ≠ 本函数的"ai-title >
// 首条 user > 命令名"优先级（整体替换会改前端标题/来源图标显示）；hasMore（SDK 不给总数）/hiddenIds（Phase 6
// L1）/mtime 缓存仍要全保留。收益（省扫盘）不抵风险（可见行为变 + 定制照旧），故保留自实现。
// 返回 { sessions, hasMore }：hasMore=该目录会话总数 > limit（诚实计算，非 length===limit 猜测），
// 供前端决定是否显示「显示全部」。缓存键含 limit——否则 limit=6 结果会在 TTL 内污染 all(limit=50) 请求。
// hiddenIds（FR-20 两级删除 L1，承接 LLD §4）：本函数是 session:list 的真实数据源（直接扫盘，不依赖
// sessions.json 注册表），故"删除产品可见引用"必须在这里过滤，而不是只删 sessions.js 的指针——否则
// L1 删除后会话仍会在下次 session:list 时原样列出。传空 Set/不传 = 不过滤（向后兼容旧调用点）。
// 过滤发生在扫盘结果（含缓存）之后、按 limit 截断的窗口之内——已被隐藏的会话若恰好排在最近 N 条内，
// 会占掉一个显示配额（下拉即少显示一条，而非自动补下一条）。Could 优先级下接受这个小瑕疵：换成
// "过滤后再截断"须让缓存也按 hiddenIds 分裂存储（Set 又不宜做缓存键），复杂度不成比例。
export async function listSessionsPage(cwd, { baseDir = CLAUDE_DIR, limit = LIST_LIMIT, hiddenIds } = {}) {
  const dir = join(baseDir, getProjectDir(cwd));
  const cacheKey = `${dir}:${limit}`;

  // B2：TTL 缓存命中，直接返回（避免重复 readdir + N×stat + N×readHeadMeta）——隐藏名单不进缓存键：
  // 缓存的是"该 cwd 全部会话"的扫盘结果，隐藏过滤在缓存之后应用，删除后 invalidateListCache 仍照常生效。
  const cached = _listCache.get(cacheKey);
  const fromScan = cached && Date.now() - cached.ts < LIST_CACHE_TTL
    ? cached.result
    : await scanSessionsPage(dir, limit, cacheKey);
  if (!hiddenIds || hiddenIds.size === 0) return fromScan;
  return { ...fromScan, sessions: fromScan.sessions.filter(s => !hiddenIds.has(s.id)) };
}

async function scanSessionsPage(dir, limit, cacheKey) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return { sessions: [], hasMore: false }; // 目录不存在 = 该 cwd 尚无任何会话
  }

  // B2：stat 并发（Promise.allSettled 容错：单文件失败不影响其他）
  const jsonlNames = names.filter(n => n.endsWith('.jsonl'));
  const statResults = await Promise.allSettled(
    jsonlNames.map(async name => {
      const file = join(dir, name);
      const st = await stat(file);
      return { id: name.slice(0, -6), file, mtimeMs: st.mtimeMs, size: st.size };
    })
  );
  const stated = statResults
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
  stated.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // B2：readHeadMeta 并发（对前 limit 个）
  const top = stated.slice(0, limit);
  const metas = await Promise.all(top.map(s => readHeadMeta(s.file, s.size)));
  const sessions = top.map((s, i) => ({
    id: s.id,
    title: metas[i].title || '(无标题)',
    model: metas[i].model || null,
    entrypoint: metas[i].entrypoint || null,
    lastUsedAt: Math.round(s.mtimeMs)
  }));
  const result = { sessions, hasMore: stated.length > limit };

  // B2：存缓存（键含 limit）
  _listCache.set(cacheKey, { ts: Date.now(), result });
  return result;
}

// 向后兼容包装：仅返回会话数组（多处 script/测试直接用数组）。新代码若需 hasMore 用 listSessionsPage。
export async function listSessions(cwd, opts = {}) {
  return (await listSessionsPage(cwd, opts)).sessions;
}

// B3：写入新会话后失效该 cwd 的列表缓存，确保 session:list 立即可见（不等待 TTL 过期）。
// 键现含 limit → 删该 dir 的所有 limit 变体。
export function invalidateListCache(cwd) {
  const prefix = join(CLAUDE_DIR, getProjectDir(cwd)) + ':';
  for (const key of _listCache.keys()) {
    if (key.startsWith(prefix)) _listCache.delete(key);
  }
}

// 读文件头部 HEAD_READ_BYTES，提取 title（ai-title > 首条 user 文本 > 首条命令名）/ model / entrypoint。
// model/entrypoint/firstUser 都在会话开头，只读头部即可；ai-title 是 CLI 事后追加、位置不定，头部漏读时
// 再补读尾窗（见 TAIL_READ_BYTES）。末行可能被截断 → JSON.parse 失败即跳过。
// size 由 listSessionsPage 的 stat 透传复用（省一次 syscall）；未传时回退 fstat，保持可独立调用。
async function readHeadMeta(file, size) {
  const meta = { title: '', model: null, entrypoint: null };
  // 标题优先级：CLI 生成的 ai-title（与 /resume 选择器同款）> 首条真实 user 文本 > 首条斜杠命令名。
  // 命令包裹（<command-name>/clear</command-name>…）是 CLI 注入的 meta、非用户原话，不直接当标题。
  let aiTitle = '', firstUser = '', firstCmd = '';
  try {
    const fh = await open(file, 'r');
    try {
      if (size == null) ({ size } = await fh.stat());
      const headLen = Math.min(HEAD_READ_BYTES, size);
      // 两个 buffer 都被 fh.read 全量写入、只 toString 到 bytesRead——allocUnsafe 免去无谓零填充（尤其尾窗 512KB）。
      const buf = Buffer.allocUnsafe(headLen);
      const { bytesRead } = await fh.read(buf, 0, headLen, 0);
      for (const line of buf.toString('utf-8', 0, bytesRead).split('\n')) {
        if (!line.trim()) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; } // 截断尾行/非 JSON：跳过
        if (!meta.entrypoint && entry.entrypoint) meta.entrypoint = entry.entrypoint;
        if (!meta.model && entry.type === 'assistant' && entry.message?.model) meta.model = entry.message.model;
        if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) {
          aiTitle = entry.aiTitle.trim(); // 取头窗内最后一次（CLI 会更新，后写更准）
        } else if (entry.type === 'user' && !entry.isMeta) {
          const c = extractContent(entry.message?.content).trim();
          if (c.startsWith('<command-name>')) {
            if (!firstCmd) { const m = /<command-name>([^<]+)<\/command-name>/.exec(c); if (m) firstCmd = m[1].trim(); }
          } else if (c.startsWith('<command-') || c.startsWith('<local-command-')) {
            /* 其他命令片段 / 本地命令 stdout/stderr 包裹：纯噪声，跳过 */
          } else if (c && !firstUser) {
            firstUser = c;
          }
        }
      }
      // 头窗没抓到 ai-title 且文件比头窗大 → 补读尾窗取最新 ai-title。单独 try 兜底：这第二次读失败绝不能
      // 连累头窗已提取的 title/model/entrypoint（否则一条好会话反被降级成「(无标题)」）。半行 parse 失败被跳过，
      // 完整的 ai-title 行仍可读到。⚠️ 头窗与尾窗之间 [64KB, size-512KB) 存在死区：ai-title 若只落在这中间
      // （早期生成后 CLI 再没更新、且其后堆了 >512KB 内容）会两窗皆漏、回退 firstUser——实测现有会话未触发。
      if (!aiTitle && size > HEAD_READ_BYTES) {
        try {
          // 尾窗起点跳过头窗已扫区省重复读，但回退 4KB 重叠——保证跨 64KB 边界的 ai-title 行（短，远小于 4KB）
          // 被尾窗完整包含、不被两窗各切一半而漏读。>512KB 文件仍只读末尾 512KB。
          const start = size > TAIL_READ_BYTES ? size - TAIL_READ_BYTES : Math.max(0, HEAD_READ_BYTES - 4096);
          const tbuf = Buffer.allocUnsafe(size - start);
          const { bytesRead: tRead } = await fh.read(tbuf, 0, size - start, start);
          for (const line of tbuf.toString('utf-8', 0, tRead).split('\n')) {
            if (!line.trim()) continue;
            let entry;
            try { entry = JSON.parse(line); } catch { continue; }
            if (entry.type === 'ai-title' && typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) {
              aiTitle = entry.aiTitle.trim(); // 尾窗内最后一次 = 最新
            }
          }
        } catch { /* 尾窗补读失败：保留头窗结果、回退 firstUser，不清空 meta */ }
      }
    } finally {
      await fh.close().catch(() => {}); // close 失败同样不该连累已提取的 meta
    }
  } catch {
    return {};
  }
  meta.title = (aiTitle || firstUser || firstCmd).slice(0, 60);
  return meta;
}

// 续接 CLI 原生会话时恢复权限档：CLI 把切档（Shift+Tab）写进 transcript 的 `type:permission-mode` 记录，
// 但 web 的 sessions.json 不记（那是 web 端才写的增强）。故续接一个纯 CLI 会话时，从 transcript 末条
// permission-mode 记录恢复，避免一律回落「默认审批」。dontAsk 是 web 专属档、CLI transcript 不会出现，
// 不列入白名单。⚠️ thinking/effort 档 CLI 完全不落盘（transcript 里只有 thinking 内容块、无档位字段），
// 无从恢复——「默认思考」是诚实回退，属已知边界。
const VALID_CLI_PERM_MODES = new Set(['default', 'plan', 'acceptEdits', 'bypassPermissions']);

// 纯函数：给一串已解析 transcript 条目，返回末条【合法】permission-mode 的档值，无则 null。
// 「末条为准」——权限档可多次切换，最后一次才是当前态；非法/脏值不外泄给 SDK（覆盖为 null，回落上层默认）。
export function lastPermissionMode(entries) {
  let mode = null;
  for (const e of entries) {
    if (e && e.type === 'permission-mode' && typeof e.permissionMode === 'string') {
      mode = VALID_CLI_PERM_MODES.has(e.permissionMode) ? e.permissionMode : null;
    }
  }
  return mode;
}

// 从 transcript 尾部读回末条 permission-mode（tail-oriented：档记录随会话推进落盘，最后一条在文件尾）。
// 只读末尾 TAIL_READ_BYTES：与 readHeadMeta 尾窗同款权衡——极端超大会话里若末条档记录距尾 >512KB
// 则读不到、返回 null 优雅回落（不误、不崩）。size 可注入省一次 stat；baseDir 供单测指向 tmpdir。
export async function readLastPermissionMode(sessionId, cwd, { baseDir = CLAUDE_DIR, size = null } = {}) {
  const file = join(baseDir, getProjectDir(cwd), `${sessionId}.jsonl`);
  try {
    const fh = await open(file, 'r');
    try {
      if (size == null) ({ size } = await fh.stat());
      if (size === 0) return null;
      const start = size > TAIL_READ_BYTES ? size - TAIL_READ_BYTES : 0;
      const buf = Buffer.allocUnsafe(size - start);
      const { bytesRead } = await fh.read(buf, 0, size - start, start);
      const entries = [];
      for (const line of buf.toString('utf-8', 0, bytesRead).split('\n')) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch { /* 尾窗起点切中的半行/截断尾行：跳过 */ }
      }
      return lastPermissionMode(entries);
    } finally {
      await fh.close().catch(() => {});
    }
  } catch {
    return null; // 文件不存在/读失败：回落上层默认
  }
}

// 会话归属校验：该 sessionId 的 jsonl 是否就在本 cwd 的 project 目录（server 用它把跨 cwd 的
// 全局指针/失效 id 当「不属于本 cwd」处理——比 sessions.json 的 cwd 字段更硬，直接以文件存在为准）。
export async function sessionFileExists(cwd, id, { baseDir = CLAUDE_DIR } = {}) {
  // id 必须是合法 session id 字符集（UUID 形态：仅 [0-9a-zA-Z_-]）——拒绝含 / \ . 的路径穿越。
  // session:switch 是纵深防御层：前端列表已按 cwd 过滤，但构造 payload（如 '../别的cwd/<id>'）不得
  // 借 join 规范化越出本 cwd 的 project 目录（/verify 2026-06-12 实测抓出）。空串也被 + 量词挡掉。
  if (typeof id !== 'string' || !/^[0-9a-zA-Z_-]+$/.test(id)) return false;
  try {
    await stat(join(baseDir, getProjectDir(cwd), `${id}.jsonl`));
    return true;
  } catch {
    return false;
  }
}

// transcript 当前字节大小（只读镜像锁的 keep-alive 判活用：文件在长=终端在写盘，含跑工具时的
// tool_use/tool_result——这些被 getSessionHistory 的 text-only 过滤挡在 len 外，故单看历史长度会误判静默）。
// id 同 sessionFileExists 做字符集校验防路径穿越；文件不存在/非法 id → -1（catchUpTick 据此本 tick 不判增长）。
export async function sessionFileSize(sessionId, cwd, { baseDir = CLAUDE_DIR } = {}) {
  if (typeof sessionId !== 'string' || !/^[0-9a-zA-Z_-]+$/.test(sessionId)) return -1;
  try {
    const { size } = await stat(join(baseDir, getProjectDir(cwd), `${sessionId}.jsonl`));
    return size;
  } catch {
    return -1;
  }
}

// L2 删除的活跃会话保护②用（FR-20，承接 LLD §4）：mtime 距今 < 静默阈值即视为"可能正被终端使用"——
// 纯终端进程正驱动的会话后端无法确证（同 AD-3 盲区），mtime 是文件系统元数据级的启发式护栏，非内容
// 解析，诚实登记非完备。id 同 sessionFileExists 做字符集校验防路径穿越；不存在/非法 id → -1。
export async function sessionFileMtime(sessionId, cwd, { baseDir = CLAUDE_DIR } = {}) {
  if (typeof sessionId !== 'string' || !/^[0-9a-zA-Z_-]+$/.test(sessionId)) return -1;
  try {
    const { mtimeMs } = await stat(join(baseDir, getProjectDir(cwd), `${sessionId}.jsonl`));
    return mtimeMs;
  } catch {
    return -1;
  }
}
