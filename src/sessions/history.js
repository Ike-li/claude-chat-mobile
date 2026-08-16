// history.js —— 读取 CLI 会话历史用于前端展示（方案 2）
// CLI 历史文件：~/.claude/projects/<project>/<session_id>.jsonl
import { open, stat, readdir, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { listSessions as sdkListSessions } from '@anthropic-ai/claude-agent-sdk';
import { MAX_SESSION_LIMIT } from './workdirs.js';
// 历史回显摘要与 agent.js live 工具卡片同口径，共用 src/shared 的实现（此前两侧各一份逐字复制，
// 且只有 live 侧带循环引用护栏——收敛后历史侧一并获得）。
import { toolSummary } from '../shared/tool-summary.js';
// 本地 slash 命令输出的解析口径同样与 live 侧（agent.js）共用，防两边形态漂移。
import { parseLocalCommandOutput, WEB_BARE_SLASH_RE } from '../shared/local-command.js';
import { setCapped } from '../shared/bounded-map.js';
import { encodeProjectDir } from '../shared/project-dir.js';

// 快路径注入口（仅测试用）：测试替置一个函数后，快路径走替身而非真 SDK，便于无网络/无 CLI 环境下
// 验证字段映射与 hasMore 语义。生产留默认 undefined → 走真 sdkListSessions。
let __sdkListSessionsForTest;
export function __setSdkListSessionsForTest(fn) { __sdkListSessionsForTest = fn; }

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
// 会话列表上限（按「最后主链消息时间」取最近 N；扫描阶段对全量 jsonl 只 stat + 读尾窗，不对全量 readHeadMeta）。
// 与 workdirs.js MAX_SESSION_LIMIT 共享同一常量而非各自硬编码 50——此前两处独立维护、仅靠注释宣称"一致"，
// 任一方单独改动会静默漂移。
const LIST_LIMIT = MAX_SESSION_LIMIT;
// 列表活动时间尾窗：最后一条 user/assistant 几乎总在文件末尾附近；resume/切档追加的 mode 行很短，
// 64KB 足够覆盖「末条消息 + 其后一串元数据」。比 TAIL_READ_BYTES(512KB) 更轻，因列表要对目录内每个会话读一次。
const LIST_ACTIVITY_TAIL_BYTES = 64 * 1024;

// B2：listSessions 结果按 dir 缓存，4s TTL。重复打开列表不重扫盘。
const _listCache = new Map(); // dir → { ts, result }
const LIST_CACHE_TTL = 4000;

// B6：getSessionHistory 结果按文件路径缓存，按 mtimeMs 失效。切回同一会话无需重新读盘。
const _histCache = new Map(); // filePath → { mtimeMs, size, messages }（失效判据见 getSessionHistory 的 B6）
const HIST_CACHE_MAX = 10;

// 根据 cwd 推断项目目录名。编码规则见 src/shared/project-dir.js（与 CLI/SDK 逐字节对齐的唯一实现）。
// cwd 须先经 realpath 规范化（src/server/app.js 的 preflight 启动期做），才与 CLI 的 ~/.claude/projects 命名一致（如 /tmp→/private/tmp）。
// 本名保留：调用点遍布 history/app，且「getProjectDir」已是仓内通用叫法。
// SS-004：非字母数字 → '-'，故 /tmp/foo 与 /tmp-foo 会编码成同一目录名。
// 改编码会与 CLI 裂；调用方用 workdirs.findProjectDirCollisions 在 resolveWorkdirs 时 warn。
export function getProjectDir(cwd) {
  return encodeProjectDir(cwd);
}

// SS-004 检测实现在 workdirs.js（resolve 时 warn），避免 history↔workdirs 互相 import——
// 两边现在都从 src/shared/project-dir.js 取同一份编码，不再各存一份会漂移的复制品。

// 读取会话历史消息（user/assistant 文本 + 主链 tool_use/tool_result；过滤 thinking/子 agent/CLI 噪音）。
// 流式读【完整】文件——与 CLI /resume 同源、不按字节截断头部，做到 Web 端看到的历史 = CLI 的全量历史。
//
// 【已评估：不迁 SDK 官方 getSessionMessages（2026-07-12 实证）】SDK 0.3.201 有官方 getSessionMessages，但
// SS-003：sessionId 进入路径前统一字符集校验（与 sessionFileExists 同规则）。
// 拒绝含 / \ . 等的穿越形态；非法 id 调用方返回空/settled/-1，不拼进 join。
export function isSafeSessionId(id) {
  return typeof id === 'string' && /^[0-9a-zA-Z_-]+$/.test(id);
}

// 实测返回大量原始消息（含 thinking/子agent/系统行），零噪音过滤；本函数过滤后仅剩真实对话 + 主链工具。
// isMeta/isSidechain/parent_tool_use_id/CLI 系统行/task-notification/uuid 去重等过滤须保留，故不迁官方 API。
//
// 输出条目：文本 {role,content,timestamp} | tool_use {kind,toolUseId,name,inputSummary,...} |
// tool_result {kind,toolUseId,ok,outputSummary,...}。前端 loadHistory 据此重建 toolcard。
export async function getSessionHistory(sessionId, cwd, limit = HISTORY_MAX_MESSAGES, { baseDir = CLAUDE_DIR } = {}) {
  if (!isSafeSessionId(sessionId)) return []; // SS-003：非法 id 不拼路径
  const projectDir = getProjectDir(cwd);
  const historyFile = join(baseDir, projectDir, `${sessionId}.jsonl`);

  let mtimeMs, size;
  try {
    ({ mtimeMs, size } = await stat(historyFile));
  } catch {
    return []; // 文件不存在：新会话或已删
  }

  // B6：mtime + size 双判据都未变 = 内容未变，直接返回缓存。缓存的是封顶到 HISTORY_MAX_MESSAGES 的
  // 尾部消息，按 limit 取尾再返回（stat ~1ms，远快于重新流式读盘 + 解析）。
  //
  // 【为什么不能只认 mtime】同一毫秒内的两次写入 mtime 完全相同，只看 mtime 会把变长的文件判成
  // 「没变」并吐回陈旧消息。后果不在历史回显，而在单驾驶员模型：catchUpStep 拿到旧 messages ⇒
  // 看不到终端刚写的那一轮 ⇒ externalWrite 判 false ⇒ 该上锁的会话不上锁。真机 tick 间隔 1–2.5s
  // 撞同毫秒概率低，但容器里 mirror-engine 的 R2b 用例实测偶发翻车（宿主机慢反而躲过）。
  // size 是同一次 stat 顺手拿的，零额外系统调用。
  //
  // 残留缺口（已知、不修）：等长覆写仍会命中缓存。CLI 的 transcript 是 append-only，等长原地改写
  // 不存在；真要防得改成读内容 hash，为一个不发生的场景付每次全文读的代价，不划算。
  const cached = _histCache.get(historyFile);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    // 真 LRU：命中后移到 Map 末尾，避免热会话被冷扫挤掉
    _histCache.delete(historyFile);
    _histCache.set(historyFile, cached);
    return cached.messages.slice(-limit);
  }

  const messages = [];
  // 同 uuid 去重：真实 transcript 存在「interrupt+queue 竞态导致同一消息重复落盘」（同 uuid 写两次）→
  // 回显成重复气泡（实证 234 会话中 1 个含 8 条）。uuid 是每条唯一标识，同 uuid = 同一逻辑消息（非合法重复），
  // 按 uuid 去重安全——合法重复内容（两次「继续」）是不同 uuid、不误删。Set 为本次读取的瞬时结构（返回即释放）。
  const seenUuids = new Set();
  // 主链最近 Agent/Task toolUseId：sidechain 行常无 parent_tool_use_id 落盘，靠此挂到折叠卡
  let lastMainAgentToolId = null;
  // 防爆：流式累积只保留尾部 HISTORY_MAX_MESSAGES 条——返回上限同时是内存上限。否则超大会话会把
  // 【全量】user/assistant 文本+工具常驻进 always-on 进程（再被 _histCache LRU=10 放大），落空本服务
  // 「always-on 要稳」的目标。超 2× 才批量 splice → 均摊 O(1)、不每条 shift。
  const pushCapped = (item) => {
    messages.push(item);
    if (messages.length > HISTORY_MAX_MESSAGES * 2) {
      messages.splice(0, messages.length - HISTORY_MAX_MESSAGES);
    }
  };
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

      // 只取 user 和 assistant。同一条 JSONL 可能含 text + tool_use + thinking 混排：按 content block
      // 顺序展开。sidechain（子 agent）一并回显（带 isSidechain / parentToolUseId），前端收进折叠卡；
      // 不再整段丢弃——刷新后也能看子 agent 详情（与 live parentToolUseId 卡对齐）。
      // parent_tool_use_id 若意外落盘则直接用作 parent；否则用最近主链 Agent/Task 的 toolUseId 挂靠。
      if (entry.type === 'user' || entry.type === 'assistant') {
        // 同 uuid 重复落盘去重（仅 uuid 存在时；缺 uuid 的旧条目不因 undefined 相撞而互删）。
        // 一条 uuid 对应整条 JSONL entry，展开出的多条 tool/text 共享同一 uuid——只在 entry 级去重一次。
        if (entry.uuid) { if (seenUuids.has(entry.uuid)) continue; seenUuids.add(entry.uuid); }

        const role = entry.message?.role || entry.type;
        const isSide = Boolean(entry.isSidechain || entry.parent_tool_use_id);
        const parentFromDisk = entry.parent_tool_use_id || entry.parentToolUseId || entry.agentId || null;
        const expanded = expandHistoryEntry(entry.message?.content, role, entry.timestamp, {
          isSidechain: isSide,
          parentToolUseId: isSide ? (parentFromDisk || lastMainAgentToolId || 'sidechain') : null,
          // 分叉锚点只在主链上有效：sidechain（子 agent）消息的 parentUuid 链是另一条支线，forkSession
          // 「保留到该 uuid 为止」对子 agent 消息语义不明确；前端也只在主链气泡上挂长按分叉入口。
          uuid: isSide ? null : entry.uuid,
          // API 报错条（CLI 落盘为普通 assistant + model:'<synthetic>' + 这三个顶层字段）。
          // 不带出来的话，刷新后 live 侧的红条会退化成看不出异常的普通助手气泡。
          isApiErrorMessage: entry.isApiErrorMessage === true,
          apiErrorStatus: entry.apiErrorStatus ?? null,
          apiError: entry.error ?? null,
        });
        for (const item of expanded) {
          // 主链 spawn 工具（Agent/Task/Workflow）：记住 id，供后续无 parent 字段的 sidechain 行挂靠
          if (!isSide && item.kind === 'tool_use'
              && (item.name === 'Agent' || item.name === 'Task' || item.name === 'Workflow')
              && item.toolUseId) {
            lastMainAgentToolId = item.toolUseId;
          }
          pushCapped(item);
        }
        continue;
      }

      // 本地 slash 命令的输出（web 形态）：{ type:'system', subtype:'local_command',
      // content:'<local-command-stdout>…</local-command-stdout>' }——content 是顶层字段、不在 message 里，
      // 故被上面那道 user/assistant 闸整条跳过。/code-review 的结果正落在这个形态上：真机跑满 13 分钟、
      // 结果完整落盘，刷新后历史里却什么都没有（2026-08-03）。live 侧同一段正文走 agent.js 的
      // local_command_output 分支，两边共用 parseLocalCommandOutput，形态一致（否则刷新前后两个样）。
      //
      // 【为什么 CLI 形态不一并放开】终端里同样的输出以 type:'user' + <local-command-stdout> 落盘，被
      // isCliSystemLine 当噪音丢弃（实测切 model/effort 的会话里这类回执可占回显 ~30%），那条判断保持不动：
      // CLI 形态的输出用户在终端里当场看过、web 只是只读回看；web 形态的输出则是用户从没见过的那一份。
      if (entry.type === 'system' && entry.subtype === 'local_command') {
        const out = parseLocalCommandOutput(entry.content);
        // 只收「整段就是完整包装」的形态：这个 subtype 是个大杂烩，同名 subtype 下还落命令名回显等
        // 非输出条目，裸文本无从判断是不是命令结果。live 侧不看这个标记（那条通道本身就是输出语义）。
        if (!out?.wrapped) continue;
        if (entry.uuid) { if (seenUuids.has(entry.uuid)) continue; seenUuids.add(entry.uuid); }
        // 【out.isError 有意不用】live 侧 stderr 会另发一条 notice 标失败，这里不复刻：notice 是瞬时通道，
        // 整个通道的内容（informational/mirror_error/notification/compact_error…）刷新后一律不回显，
        // 不为本地命令一家单开历史标记。正文本身两侧一字不差，失败信息在正文里。
        // 也不能借 isApiErrorMessage：那个标记在前端渲染成【居中小红条】（app.js renderOne），
        // 是给一句 "API Error: 503" 用的，几 KB 的命令输出塞进去会整段变成挤在中间的小红字。
        //
        // 剥掉包装再交给 expandHistoryEntry：带包装的原文会被 isCliSystemLine 判成噪音丢掉。
        // 【uuid 传 null】同上面主链分支对 sidechain 的处理：分叉锚点只在对话主链上有效。这是一条
        // type:'system' 的条目，带出 uuid 会让前端在这个气泡上挂长按分叉入口（renderOne 设
        // dataset.uuid → resolveForkAnchorUuid 认 role==='assistant' 即采纳），sdkForkSession 遂拿到
        // 一个非对话行的 upToMessageId。上面那道 seenUuids 去重仍用 entry.uuid，两者用途不同。
        for (const item of expandHistoryEntry(out.text, 'assistant', entry.timestamp, { uuid: null })) {
          pushCapped(item);
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

  // B6：缓存消息（LRU 淘汰：上方命中路径 delete+set 移到 Map 末尾，超上限淘汰最久未用的）；已在流式阶段封顶到
  // HISTORY_MAX_MESSAGES，返回时再按 limit 取尾。正常会话（≤上限）即全量历史；仅极端超大会话被削顶——
  // 既防一次性撑爆前端，也防全量常驻 server 内存。mtime 失效保证一致性——被淘汰条目下次 mtime 未变即重入。
  // 写入用 setCapped（FIFO 占位）：命中路径已负责刷新位置；这里只保证新键不把表撑破。
  setCapped(_histCache, historyFile, { mtimeMs, size, messages }, HIST_CACHE_MAX);

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
// messages = 当前 getSessionHistory 结果（文本 + 主链工具、≤HISTORY_MAX_MESSAGES 条）。
// 边界：极端会话 > 2000 条被削头时 len 可能 < baseline → 不推（保守），属已知限制。
// SS-001：另有「满窗滑动」——len 恒 = HISTORY_MAX_MESSAGES = baseline，但头被 splice、尾是新内容。
//    仅比长度会永远 emit [] 且不标 externalDirty。用 lastTailKey（末条 timestamp|content 指纹）检测滑动；
//    检出后 emit 仍 []（slice 会把仍可见的中间条当新尾巴重推），reload=true 让 server 全量 history_append
//    重发尾窗 + 标 externalDirty。historyCap 可注入便于单测。
// ⚠️ 已知边界（code-review 发现 2，有意不修）：外部（终端）写入若【撞进本地 turn 的 busy→idle 吸收窗口】——
//    即 web 自己 turn 运行期间终端也写了同一会话——会被 wasBusy 分支的整段吸收一并吞掉、停留期间不回显，
//    须切走该会话经前端 diskLen 重载（logic.js shouldReloadOnEnter）才追平。触发面窄（须停留不切 + 恰好并发
//    本地 turn），稳健区分己方/外部写入需 server 传 ownDelta 或内容比对、代价不划算，故接受为已知边界。
//    契约护栏：busy→idle 必须【整段吸收】（emit []），绝不改成把 [baseline,len) 全当外部 emit——否则己方
//    turn 的每条会被 live 流 + history_append 重复渲染成气泡。见 tests/unit/mirror-sync.test.mjs 的 skip 说明。
// 【已评估：不做 SP-10 完整闭合（2026-07-12 机主确认，Phase 8 技术债）】"两路一致性重设计"
//    （去掉 busy→idle 吸收、改增量读 + 幂等去重、busy→idle 立即触发）要真正闭合上述边界，前提是前端 history_append
//    能按 uuid 幂等去重——但实测前端 onHistoryAppend（app.js）无 uuid 去重、live 流气泡也不记 uuid，故"立即触发"
//    简单版无效（仍受契约护栏约束只能吸收），完整版需前端去重 + live 流记 uuid 的联动大改。上述边界触发面窄，
//    n=1 单用户下该大改不值，保留现状。索引见 docs/hard-rules.md §5；别再因"SP-10 设计验证通过"重启这个接入。
export function historyTailKey(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  if (!last || typeof last !== 'object') return null;
  // timestamp + 角色 + 主文本/tool id——足够区分滑窗后的新尾巴；勿用整对象 JSON（thinking 截断会抖）
  const body = last.content != null ? String(last.content).slice(0, 80)
    : (last.toolUseId || last.name || last.kind || '');
  return `${last.timestamp || ''}|${last.role || ''}|${body}`;
}

export function catchUpStep(state, { messages, localBusy = false, historyCap = HISTORY_MAX_MESSAGES } = {}) {
  const len = messages.length;
  const tailKey = historyTailKey(messages);
  if (localBusy) {
    return { emit: [], reload: false, state: { baseline: state.baseline, wasBusy: true, lastTailKey: state.lastTailKey ?? null } };
  }
  if (state.wasBusy) {
    // 吸收己方 turn 的写盘：重置 baseline + 同步 tail 指纹（己方写入也在窗口内）
    return { emit: [], reload: false, state: { baseline: len, wasBusy: false, lastTailKey: tailKey } };
  }
  if (len > state.baseline) {
    return {
      emit: messages.slice(state.baseline),
      reload: false,
      state: { baseline: len, wasBusy: false, lastTailKey: tailKey },
    };
  }
  // SS-001：满窗 + 长度未增 + 指纹已变 → 滑动窗口吞了新尾；不能 slice，请求全量重载
  const atCap = Number.isFinite(historyCap) && historyCap > 0 && len >= historyCap && state.baseline >= historyCap;
  const prevTail = state.lastTailKey;
  if (atCap && prevTail != null && tailKey != null && prevTail !== tailKey) {
    return {
      emit: [],
      reload: true,
      state: { baseline: len, wasBusy: false, lastTailKey: tailKey },
    };
  }
  return {
    emit: [],
    reload: false,
    state: {
      baseline: state.baseline,
      wasBusy: false,
      // 首次观察或之前未记指纹时补上，避免下一 tick 误判「从 null→有」为滑动
      lastTailKey: prevTail == null ? tailKey : prevTail,
    },
  };
}

// BE-009：客户端（重）连时 server 会强制重定 catch-up baseline（重连会 loadHistory 全量重渲，沿用滞后 baseline
// 会把已显示消息再 history_append 一遍成重复气泡——前端 renderHistoryBubbles 不按 uuid 去重，故须靠 rebaseline
// 避重复）。但该 rebaseline 有副作用：若「连接前终端写了新轮次、catchUpTick 尚未观察/推送」，这段外部增长会被
// baseline 静默吸收——既不回显、也不标 externalDirty，SDK 子进程内存上下文继续滞后于磁盘，下条手机消息会用
// 陈旧上下文、从旧位置分叉出第二条 parentUuid 链（transcript 分叉）。
//
// 本纯函数判定「这次 rebaseline 是否吸收了未观察到的外部增长」，调用方据此对该 AgentSession 标 externalDirty
// （下次发送前置换实例吸收，同 effort 切档冷读最新磁盘）。仅当【同一会话】重连(sameSession)才算——真会话切换是
// 另一段会话的全量历史、无分叉语义。curLen 非有限（读盘失败）保守返回 false，不误标。
// BE-009 + SS-NEW-002：同会话重连 rebaseline 是否吸收了未观察的外部增长。
// 长度增长 → true；HISTORY_MAX 满窗滑动时 len 不变但尾指纹变 → 也 true（对齐 catchUpStep lastTailKey）。
// 2026-07-18 修复：新增 localBusy（调用方 instanceState 已算好、同 catchUpStep/mirrorReleaseStep 同名参数同判据）
// ——己方正跑 turn/等审批时磁盘变长大概率是自己写出来的，不是终端外部写入，早退 false 不误标 externalDirty。
// 2026-08-10 修复：localBusy 只罩住「重连当下仍在跑」，罩不住「刚跑完」。catchUpStep 的 localBusy 分支
// 【冻结 baseline】只记 wasBusy=true，baseline 要等下一 tick 的吸收才推进；而 turn 一结束 state 立刻是 idle。
// 重连落进 turn 结束前后各约一个 tick 周期的窗口（常态 2500ms、只读镜像态 1000ms；flag 由【下一个】tick
// 消费，故连接发生在 turn 结束【之前】同样会命中），就拿【冻结的旧 baseline】比【含己方刚写那一轮的磁盘
// 长度】，把自己写的判成外部增长——「发消息→锁屏→解锁看结果」正是移动端最典型的模式。实证会话 39da384a：
// 主链全部 sdk-ts、零真实 cli 写入（唯一 cli 条目是自家 entrypoint-marker 假行），却反复弹「正在续接
// 会话（吸收终端写入）…」。补 wasOwnTurn 维度即可，与 catchUpStep 的 wasBusy 吸收窗口同源。
//
// 【为什么是 wasOwnTurn 而不是 localBusy 口径的 wasBusy】localBusy 把 busy 与 permission 压成一个布尔，
// 但两者语义不同：busy=己方确定在写盘；permission=己方在等审批（最长 30min），磁盘增长【可能是终端写的】
// ——externalGrowthWhilePaused 存在的理由正是这个。若按 localBusy 口径豁免，就会连审批窗里的终端写入一起
// 吞掉（permission 建基线→终端写入→轮次收尾翻 idle→重连，此时 externalGrowthWhilePaused 已没有第二个
// permission tick 可兜）⇒ 漏标 ⇒ transcript 分叉。漏标(分叉)远重于误标(多跑一次冷启动)，故只豁免己方 turn。
//
// 取舍：与 catchUpStep 的 wasBusy 整段吸收同源（见本文件 §已知边界 code-review 发现 2）——终端写入若恰好
// 撞进「己方 turn 刚结束」这一窗口会被一并吸收、不标脏。该窗口内 catchUpStep 本就已经漏（那条边界是既有的），
// 但重连路径此前是独立的第二道网，本改动把这个窄窗内的检出从「重连就能抓到」降为「抓不到」。这是有意取舍，
// 不是等价改写。窗口宽度 ≈ 一个 tick 周期，且仅在「己方 turn 正跑 + 终端并发写同一会话」时才存在。
export function rebaselineAbsorbedExternal({
  sameSession,
  curLen,
  baseline,
  localBusy = false,
  wasOwnTurn = false,
  historyCap = HISTORY_MAX_MESSAGES,
  prevTailKey = null,
  curTailKey = null,
} = {}) {
  if (sameSession !== true) return false;
  if (localBusy === true) return false;
  if (wasOwnTurn === true) return false; // 己方 turn 上一 tick 还在写盘 → 这次增长是自己写的，baseline 只是尚未吸收
  if (!Number.isFinite(curLen) || !Number.isFinite(baseline)) return false;
  if (curLen > baseline) return true;
  const atCap = Number.isFinite(historyCap) && historyCap > 0
    && curLen >= historyCap && baseline >= historyCap;
  if (atCap && prevTailKey != null && curTailKey != null && prevTailKey !== curTailKey) return true;
  return false;
}

// 只读镜像锁的【释放】状态机（纯函数，便于单测）——修 code-review 发现 1：原实现 setMirror(true) 在观测到
// 外部写入时上锁，但没有任何自动释放路径（setMirror(false) 仅在「无查看会话」「切了会话」触发），导致终端
// 写一次就把移动端输入锁死到用户手动切会话/接管为止，即便终端 turn 早已结束。catchUpTick 每 tick 调一次本函数。
// state = { readonly, quietTicks }：
//   · externalWrite（本 tick catchUpStep emit 非空 = 观测到外部落定新【文本】消息）→ 上锁、quietTicks 清零；
//   · localBusy（web 自己在跑 turn）→ 终端是否静默无从判断 → 保持当前锁态、quietTicks 清零（不借己方忙碌攒静默）；
//   · keepAlive（transcript 文件仍在增长=终端在写盘：可能是工具结果、也可能是尚未被 catchUp 读到的增量）
//     → 【已锁时】维持锁、quietTicks 清零，免得终端密集跑工具/思考期间被误判静默而熄横幅；【不上锁】——上锁只靠
//     externalWrite（未锁分支在下方先 return），文件增长不凭空造锁，不把 web 自己 resume 的写盘误判成终端锁；
//   · tailPending（classifyTranscriptTail 判尾部形态=轮次未完结：tool_use 落了结果没落 / user 落了回复没落）
//     → 与 keepAlive 同权重（已锁维持、未锁不造锁）。两判据互补：keepAlive 罩 settled 误判窗（assistant 中途
//     text 落盘紧跟 tool_use 的落盘间隙），tailPending 罩【长工具调用零写盘窗】——终端卡在一条几分钟的
//     bash/搜索上，文件完全不增长，原实现 12.5s 误判解锁、横幅熄灭（2026-07-12 真实报障「感觉没东西在跑」）；
//   · idle 且无外部写入、文件不再增长、尾部形态已收尾（真静默）→ quietTicks++；累计到 MIRROR_RELEASE_QUIET_TICKS → 自动解锁。
// 保守取舍：keepAlive 用文件增长做「终端还活着」的弱判据【仅延缓解锁】——是本项目刻意规避的「mtime 判活」近亲，
//   但风险低一档（不上锁→绝不误锁死进不去，最坏是终端真停后晚 ~N tick 才解锁）；前端「接管 CLI 会话」手动接管仍是兜底。
//   ⚠️ 前提：web 纯查看 idle 期间其自身 resume 进程不 append transcript（否则 keepAlive 恒真→退回锁死，靠接管兜）——须 live 验证。
export const MIRROR_RELEASE_QUIET_TICKS = 5; // 默认 ×2.5s ≈ 12.5s；mirror 提速轮询时由调用方传入更大 releaseTicks 保墙钟
//   · registryBusy（P1，7/26 CCD 调研吸收）：~/.claude/sessions/<PID>.json 的 status:"busy" 权威自报
//     （session-registry.js，已含 pid 验活+新鲜度）→ 比 keepAlive/tailPending 强一档：【可上锁也可维持】——
//     它不是从磁盘形态猜的，是活着的终端进程自己说"我在跑"，堵「终端开跑但首条 text 未落盘」的上锁空窗。
export function mirrorReleaseStep(state, {
  externalWrite = false, keepAlive = false, tailPending = false, localBusy = false,
  registryBusy = false,
  releaseTicks = MIRROR_RELEASE_QUIET_TICKS,
} = {}) {
  const prevReadonly = Boolean(state?.readonly);
  const prevQuiet = Number(state?.quietTicks) || 0;
  const need = Number(releaseTicks) > 0 ? Number(releaseTicks) : MIRROR_RELEASE_QUIET_TICKS;
  if (externalWrite) return { readonly: true, state: { readonly: true, quietTicks: 0 } };
  if (localBusy) return { readonly: prevReadonly, state: { readonly: prevReadonly, quietTicks: 0 } };
  if (registryBusy) return { readonly: true, state: { readonly: true, quietTicks: 0 } }; // 权威自报终端在跑：直接锁（localBusy 豁免在上一行）
  if (!prevReadonly) return { readonly: false, state: { readonly: false, quietTicks: 0 } };
  if (keepAlive || tailPending) return { readonly: true, state: { readonly: true, quietTicks: 0 } }; // 终端仍在写盘/轮次未完结 → 维持锁、静默清零；不上锁靠上一行未锁 return
  const quietTicks = prevQuiet + 1;
  const readonly = quietTicks < need;
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

// 过滤文本类噪音（task-notification / CLI 系统行）；slash 命令重建为 "/name args"。
// 返回 null = 整条丢弃；字符串 = 保留（可能已重建）。
function normalizeHistoryText(content) {
  if (!content || !String(content).trim()) return null;
  let text = String(content);
  if (text.trimStart().startsWith('<task-notification>') && text.includes('</task-notification>')) return null;
  const rebuilt = reconstructSlashCommand(text);
  if (rebuilt !== null) return rebuilt;
  if (isCliSystemLine(text)) return null;
  return text;
}

// 历史 thinking 单块上限（字符）：防 always-on 内存被超长推理撑爆；超出截断并标 truncated。
const HISTORY_THINKING_CAP = 4000;

// ── E18 附件预览：[附件] 块解析 ─────────────────────────────────────────────────
// web 上传附件的用户消息在 transcript 里 = 原文 + uploads.js buildPromptText 注入的尾部块：
//   [附件] 已上传到工作目录，可用 FileRead / Read 读取：\n<absPath>…
// 历史回显把该块剥离出 attachments meta（{name, storedName}）——与 live user_message 事件的
// displayText/attachments 语义对齐（气泡不显路径、chip 可点击预览），且对改动上线前的旧消息追溯生效。
// 解析必须保守（防误伤普通用户文本）：只认【尾部】块——从尾往前找 header 行，其后每个非空行都必须是
// /.ccm-uploads/ 直下的绝对路径；任一行不符 → 整体不解析、原文返回。header 措辞用宽松尾注（可用 .+ 读取：）
// 兼容将来注入文案微调。name 恢复：storedName 去 `<Date.now()>-<hex8>-` 前缀（saveAttachments 命名约定）。
const ATTACH_BLOCK_HEADER_RE = /^\[附件\] 已上传到工作目录，可用 .+ 读取：$/;
const ATTACH_PATH_RE = /^\/.*\/\.ccm-uploads\/([^/\\]+)$/;
export function splitAttachmentBlock(text) {
  const raw = String(text ?? '');
  if (!raw.includes('[附件]')) return { text: raw, attachments: [] }; // 快速路径：绝大多数消息零成本通过
  const lines = raw.split('\n');
  let headerIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ATTACH_BLOCK_HEADER_RE.test(lines[i].trim())) { headerIdx = i; break; }
  }
  if (headerIdx === -1) return { text: raw, attachments: [] };
  const attachments = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const m = ATTACH_PATH_RE.exec(line);
    if (!m) return { text: raw, attachments: [] }; // 块后混有非路径行 → 不是注入块，整体不解析
    const storedName = m[1];
    const name = storedName.replace(/^\d+-[0-9a-f]{8}-/, '') || storedName;
    attachments.push({ name, storedName });
  }
  if (attachments.length === 0) return { text: raw, attachments: [] }; // 光有 header 无路径行：不解析
  return { text: lines.slice(0, headerIdx).join('\n').trimEnd(), attachments };
}

// 把一条 user/assistant JSONL 的 content 展开为前端可渲染条目序列（保序）：
//   · text → { role, content, timestamp [, isSidechain, parentToolUseId] }
//   · thinking → { kind:'thinking', role:'assistant', content, timestamp, ... }
//   · tool_use → { kind:'tool_use', role:'assistant', toolUseId, name, inputSummary, timestamp, ... }
//   · tool_result → { kind:'tool_result', role:'user', toolUseId, ok, outputSummary, timestamp, ... }
// 字符串 content 走文本路径。opts 把 sidechain 归属传给每条展开项。
function expandHistoryEntry(content, role, timestamp, opts = {}) {
  const side = {};
  if (opts.isSidechain) {
    side.isSidechain = true;
    if (opts.parentToolUseId) side.parentToolUseId = String(opts.parentToolUseId);
  }
  const out = [];
  // E18：主链 user 文本先剥尾部 [附件] 块再走噪音过滤；纯附件消息（剥离后空文本）不得被
  // normalizeHistoryText 的空判丢条——否则「只发一张图」的历史消息整条消失。sidechain 不解析（只认主链）。
  // uuid 只挂文本类展开项（分叉锚点只在真实对话文本上有意义，工具卡/思考块不是可分叉的会话节点）；
  // 一条 JSONL entry 可能展开出多条文本（罕见，如多段 text block），共享同一 entry uuid——分叉按
  // entry 粒度切分，语义正确（forkSession 的 upToMessageId 是"保留到该消息为止"，不细分块）。
  const uuidField = opts.uuid ? { uuid: String(opts.uuid) } : {};
  // 错误标记同样只挂文本类展开项：报错正文在 text 块里，同 entry 的 thinking/工具卡不是错误本身。
  // apiErrorStatus 恒带（含 null——连接超时无 HTTP 响应是真实高频形态，不代表「不是错误」）。
  const apiErrorField = opts.isApiErrorMessage
    ? { isApiErrorMessage: true, apiErrorStatus: opts.apiErrorStatus ?? null, apiError: opts.apiError ?? null }
    : {};
  const pushText = (raw) => {
    let body = raw;
    let attachments = null;
    if (role === 'user' && !opts.isSidechain) {
      const split = splitAttachmentBlock(raw);
      body = split.text;
      if (split.attachments.length) attachments = split.attachments;
    }
    const text = normalizeHistoryText(body);
    if (text != null) out.push({ role, content: text, timestamp, ...side, ...uuidField, ...apiErrorField, ...(attachments ? { attachments } : {}) });
    else if (attachments) out.push({ role, content: '', timestamp, ...side, ...uuidField, attachments });
  };
  if (typeof content === 'string') {
    pushText(content);
    return out;
  }
  if (!Array.isArray(content)) return out;

  // 先收集 text 块拼成一条（与旧 extractContent 一致），同时按原数组序穿插 tool / thinking 块：
  // 实现：顺序扫描；连续 text 合并成一段；遇到 tool/thinking 先 flush text 再 push。
  let textBuf = [];
  const flushText = () => {
    if (!textBuf.length) return;
    const joined = textBuf.join('\n');
    textBuf = [];
    pushText(joined);
  };

  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') {
      if (typeof block.text === 'string' && block.text) textBuf.push(block.text);
      continue;
    }
    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      flushText();
      const raw = block.type === 'redacted_thinking'
        ? '（思考内容已脱敏）'
        : (typeof block.thinking === 'string' ? block.thinking : '');
      if (!raw) continue;
      const truncated = raw.length > HISTORY_THINKING_CAP;
      out.push({
        kind: 'thinking',
        role: 'assistant',
        content: truncated ? raw.slice(0, HISTORY_THINKING_CAP) + ' …（已截断）' : raw,
        truncated: truncated || undefined,
        timestamp,
        ...side,
      });
      continue;
    }
    if (block.type === 'tool_use') {
      flushText();
      const id = block.id || block.tool_use_id;
      if (!id || !block.name) continue;
      out.push({
        kind: 'tool_use',
        role: 'assistant',
        toolUseId: String(id),
        name: String(block.name),
        inputSummary: toolSummary(block.input ?? {}),
        timestamp,
        ...side,
      });
      continue;
    }
    if (block.type === 'tool_result') {
      flushText();
      const id = block.tool_use_id || block.toolUseId || block.id;
      if (!id) continue;
      out.push({
        kind: 'tool_result',
        role: 'user',
        toolUseId: String(id),
        ok: !block.is_error,
        outputSummary: toolSummary(block.content ?? ''),
        timestamp,
        ...side,
      });
      continue;
    }
    // 其它未知块：跳过
  }
  flushText();
  return out;
}

// slash 命令调用块重建：<command-message>/<command-name>/<command-args> 是 CLI 对 slash 命令（内置或
// 自定义项目命令）的落盘形式——这是用户在终端/输入框里实际打出的那一行的唯一磁盘记录，不是系统噪音。
// 标签顺序不固定（实测两种真实形态都存在），故不锚定起始位置，只按标签名抓取；command-name 缺失视为
// 不是这类块（交给 isCliSystemLine 走原有噪音判断，不强行重建）。空参数不留多余空格（裸 "/clear" 而非
// "/clear "）。返回 null 表示"不是 slash 命令块"，调用方据此决定是否继续按噪音过滤判断。
function reconstructSlashCommand(content) {
  const t = content.trim();
  const nameMatch = /<command-name>([^<]*)<\/command-name>/.exec(t);
  if (!nameMatch) return null;
  const argsMatch = /<command-args>([^<]*)<\/command-args>/.exec(t);
  const name = nameMatch[1].trim();
  const args = argsMatch ? argsMatch[1].trim() : '';
  return args ? `${name} ${args}` : name;
}

// 识别 CLI 写盘的「系统行」——非对话内容，但 isMeta=false 会漏过 getSessionHistory 的 isMeta 闸，须按 content
// 形态显式过滤，否则回显成气泡（实测切多次 model/effort + 多次 interrupt 的会话，噪音可达回显的 ~30%）。
// 只认「以标签开头且闭合」/「整条精确等于标记」，避免误伤用户以这些词开头的真实消息（与 <task-notification>
// 要求闭合标签同款谨慎）。API Error（上游/网络错误）是真实运行事件、有诊断价值，不在此列——过滤它属独立决策。
// 注：slash 命令的调用块（<command-*>）不在此列——那部分交给上面的 reconstructSlashCommand 重建保留，
// 不再当噪音丢弃；此处只处理命令的「输出」（<local-command-stdout>），那才是真正的系统噪音。
//
// local-command 包装探测（比 parseLocalCommandOutput 的 wrapped 更宽）：只要求「以开标签起、文中有闭标签」，
// 不要求开闭同类/整段纯包装——噪音过滤宁可多丢、不能漏（漏了会回显成气泡）。三处同判据共用此函数，
// 避免再各写一份正则后只改一处。
function isLocalCommandWrapped(text) {
  const t = String(text ?? '').trim();
  return /^<local-command-(stdout|stderr)>/.test(t) && /<\/local-command-(stdout|stderr)>/.test(t);
}

function isCliSystemLine(content) {
  const t = content.trim();
  if (isLocalCommandWrapped(t)) return true;
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

// ---- 会话列表：与 CLI /resume 同源，列出 ~/.claude/projects/<编码cwd>/ 下的会话 ----
// 列出该 cwd 下所有会话（含终端 entrypoint:cli 建的），不依赖 sessions.json 注册表。
// baseDir 仅供单测注入临时夹具；生产用默认 CLAUDE_DIR。
//
// 【取数路径：生产走 SDK listSessions 快路径，隔离夹具回落自造扫盘】判据是下方 useSdk(baseDir)。
// 2026-07-12 曾评估「不迁 SDK」，两条理由后来都不再成立，别照那段旧结论回滚：
//   · 「SDK 不返回 entrypoint，前端据此显来源」——经核实 entrypoint 在会话列表这条路上是死字段：
//     前端 sessionRow 显式传 null（public/js/app.js），来源角标读的是 session-registry 的 terminal，
//     不是 entrypoint。（entrypoint 仍被 readHeadMeta / 尾部形态判定使用，那是另一条路。）
//   · 「summary 标题语义 ≠ ai-title > 首条 user > 命令名」——迁移后标题即由 SDK summary 承担，
//     与 CLI /resume 所见同源，这正是想要的效果。
// 仍由本函数自己维护、SDK 给不了的三件：hasMore（SDK 不给总数）、hiddenIds（L1 两级删除）、TTL 缓存；
// 另加两道 SDK 侧兜不住的修正：按 jsonl 是否存在做归属过滤、readdir 补 SDK 漏报的无 summary 会话。
// 返回 { sessions, hasMore }：hasMore=该目录会话总数 > limit（诚实计算，非 length===limit 猜测），
// 供前端决定是否显示「显示全部」。缓存键含 limit——否则 limit=6 结果会在 TTL 内污染 all(limit=50) 请求。
// hiddenIds（FR-20 两级删除 L1，承接 docs/design.md）：本函数是 session:list 的真实数据源（直接扫盘，不依赖
// sessions.json 注册表），故"删除产品可见引用"必须在这里过滤，而不是只删 sessions.js 的指针——否则
// L1 删除后会话仍会在下次 session:list 时原样列出。传空 Set/不传 = 不过滤（向后兼容旧调用点）。
// 过滤发生在扫盘结果（含缓存）之后、按 limit 截断的窗口之内——已被隐藏的会话若恰好排在最近 N 条内，
// 会占掉一个显示配额（下拉即少显示一条，而非自动补下一条）。Could 优先级下接受这个小瑕疵：换成
// "过滤后再截断"须让缓存也按 hiddenIds 分裂存储（Set 又不宜做缓存键），复杂度不成比例。
export async function listSessionsPage(cwd, { baseDir = CLAUDE_DIR, limit = LIST_LIMIT, hiddenIds } = {}) {
  const dir = join(baseDir, getProjectDir(cwd));
  const cacheKey = `${dir}:${limit}`;

  // B2：TTL 缓存命中，直接返回（避免重复 readdir + N×stat + 尾窗活动时间 + N×readHeadMeta）——隐藏名单不进缓存键：
  // 缓存的是"该 cwd 全部会话"的扫盘结果，隐藏过滤在缓存之后应用，删除后 invalidateListCache 仍照常生效。
  const cached = _listCache.get(cacheKey);
  const fromScan = cached && Date.now() - cached.ts < LIST_CACHE_TTL
    ? cached.result
    : await scanSessionsPage(dir, cwd, limit, cacheKey, baseDir);
  if (!hiddenIds || hiddenIds.size === 0) return fromScan;
  return { ...fromScan, sessions: fromScan.sessions.filter(s => !hiddenIds.has(s.id)) };
}

// 快路径判定：生产 baseDir === CLAUDE_DIR 时走 SDK 官方 listSessions（summary = CLI /resume 同款标题，
// 省去本模块 readdir+N×stat+readHeadMeta 且无需维护标题语义跟随 CLI）；隔离测试实例（baseDir 指它处）
// 时 SDK 写死 ~/.claude 管不着，回落自造扫盘。SDK 只吃原始 cwd（已编码路径它当普通目录名→空数组），
// 故 cwd 单独透传、不复用上游已编码的 dir。
const useSdk = (baseDir) => baseDir === CLAUDE_DIR;

// 把 SDKSessionInfo 映射成本函数返回 shape（前端真实消费只有 id/title/lastUsedAt——model/entrypoint 是
// 死重字段、SDK 也不给，故不返回；gitBranch/tag 等备用字段暂不存为死字段、以后要用再从 SDK 拿）。
// 取数：至少取到 LIST_LIMIT+1（再按消息时间重排后截到 limit）。默认 limit=6 时若只取 7 条 mtime 候选，
// 被 resume 刷 mtime 的旧会话会占满窗口，真有近消息的会话进不了候选集——多取到硬顶再重排可消掉。
// lastUsedAt：优先读 transcript 尾窗「最后主链 user/assistant」时间；读不到才回落 SDK lastModified。
async function scanSessionsViaSdk(cwd, limit) {
  const fn = __sdkListSessionsForTest || sdkListSessions;
  // 候选窗口 ≥ 显示 limit，且至少覆盖「显示全部」硬顶，便于按活动时间重排后仍能选出真最近 N。
  const fetchLimit = Math.max(limit, LIST_LIMIT) + 1;
  const all = await fn({ dir: cwd, limit: fetchLimit });
  const arr = Array.isArray(all) ? all : [];
  const projectDir = join(CLAUDE_DIR, getProjectDir(cwd));
  const enriched = (await Promise.all(arr.map(async s => {
    const file = join(projectDir, `${s.sessionId}.jsonl`);
    // 归属过滤（2026-07-19 实测）：SDK listSessions 的 dir 匹配含祖先目录——查 worktree 路径会混入
    // 主仓（祖先 cwd）的会话。jsonl 不在本 cwd 项目目录 = 非本 cwd 会话，滤掉；与 session:switch 的
    // sessionFileExists 归属校验同一语义（列表 ≡ 可切换，不出「点了报会话不存在」的幽灵行）。
    let st;
    try { st = await stat(file); } catch { return null; }
    let activityAt = null;
    try { activityAt = await readLastMessageActivityMs(file, st.size); } catch { /* 读失败 → 回落 lastModified */ }
    return {
      id: s.sessionId,
      title: s.summary || '(无标题)',
      lastUsedAt: Math.round(activityAt ?? s.lastModified),
    };
  }))).filter(Boolean);

  // 补齐 SDK 漏报的会话（2026-08-05 真机）：SDK 的 listSessions/getSessionInfo 会跳过「无可提取
  // summary」的会话（sdk.d.ts:687 原话：…is a sidechain session, or has no extractable summary）。
  // 本地 slash 命令（/code-review 等）跑在 fork 上下文里，主链 transcript 只落 entrypoint-marker /
  // queue-operation / mode，一条 user/assistant 都没有 ⇒ 提不出 summary ⇒ 整个会话从抽屉里消失，
  // 而它在盘上活得好好的（CLI 自己的 /resume 列表把它显示成 "(session)"，同一个原因）。
  // 归属语义不变：只补【本 cwd 项目目录里实际存在】的 jsonl，SDK 报了但盘上没有的幽灵照旧滤掉。
  // 成本：一次 readdir + 只对差集 stat（差集通常为 0；正常会话全都有 summary）。
  try {
    const seen = new Set(enriched.map(s => s.id));
    const names = await readdir(projectDir);
    // isSafeSessionId 与其他读盘点同口径（SS-003）：只认后缀会把备份/手写文件（backup.2026-08-05.jsonl、
    // 带空格的名字）补成抽屉里点不开的幽灵会话——点击时才被 sessionFileExists 拒绝（review #6）。
    const missing = names.filter(n => n.endsWith('.jsonl') && isSafeSessionId(n.slice(0, -6)) && !seen.has(n.slice(0, -6)));
    // ★ 先按 mtime 排序再截断，不能按 readdir 顺序（那是文件名序）：老目录里差集可达上百个
    //   （SDK 候选窗本身有上限，落在窗外的老会话也会进差集），按文件名截断会把刚跑完的新会话
    //   挡在窗外——2026-08-05 真机就是这么漏掉 8f064e08 的。stat 便宜，全量做；只有活下来的
    //   那批才付 readLastMessageActivityMs（要开文件读尾窗）的代价。
    const stats = (await Promise.all(missing.map(async name => {
      try {
        const st = await stat(join(projectDir, name));
        return { name, size: st.size, mtimeMs: st.mtimeMs };
      } catch { return null; }
    }))).filter(Boolean);
    stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const extra = await Promise.all(stats.slice(0, fetchLimit).map(async m => {
      const file = join(projectDir, m.name);
      const activityAt = await readLastMessageActivityMs(file, m.size).catch(() => null);
      // 标题：这类会话主链无消息，readHeadMeta 也提不出，统一回落占位（与快路径空 summary 同口径）
      return { id: m.name.slice(0, -6), title: '(无标题)', lastUsedAt: Math.round(activityAt ?? m.mtimeMs) };
    }));
    enriched.push(...extra);
  } catch { /* readdir 失败（目录刚被删等）：SDK 结果照常返回，不因补齐失败而整个列表塌掉 */ }

  enriched.sort((a, b) => b.lastUsedAt - a.lastUsedAt || String(a.id).localeCompare(String(b.id)));
  // hasMore：重排后仍有未展示项，或 SDK 候选触顶（目录里可能还有更旧/未纳入的会话）
  return {
    sessions: enriched.slice(0, limit),
    hasMore: enriched.length > limit || arr.length >= fetchLimit,
  };
}

async function scanSessionsPage(dir, cwd, limit, cacheKey, baseDir) {
  if (useSdk(baseDir)) {
    try {
      const result = await scanSessionsViaSdk(cwd, limit);
      _listCache.set(cacheKey, { ts: Date.now(), result });
      return result;
    } catch {
      // SDK 异常（CLI 版本/环境/编码不一致）不 fail-closed：回落自造扫盘兜底，列表照常出。
      return scanViaReaddir(dir, limit, cacheKey);
    }
  }
  return scanViaReaddir(dir, limit, cacheKey);
}

// 自造扫盘（兜底路径 + baseDir 隔离测试实例）：readdir + N×stat + 全量尾窗活动时间 + 前 limit 条 readHeadMeta。
// 排序/lastUsedAt 用最后主链消息时间（无则回落 mtime），避免 mode/permission-mode 等元数据写盘把旧会话顶前。
// readHeadMeta 仍保留——兜底依赖它取 title/model/entrypoint，快路径不进此。
async function scanViaReaddir(dir, limit, cacheKey) {
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

  // 全量读尾窗活动时间再排序（只读 64KB 尾，不对全量 readHeadMeta）——保证 limit 截断窗口本身按真消息时间取最近 N。
  const activityResults = await Promise.allSettled(
    stated.map(async s => {
      const activityAt = await readLastMessageActivityMs(s.file, s.size);
      return { ...s, activityAt: activityAt ?? s.mtimeMs };
    })
  );
  const withActivity = activityResults
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
  // 活动时间相同（或都回落 mtime）时按 id 稳定排序，避免两次 list 顺序抖动。
  withActivity.sort((a, b) => b.activityAt - a.activityAt || String(a.id).localeCompare(String(b.id)));

  // B2：readHeadMeta 并发（仅对前 limit 个——标题/model/entrypoint）
  const top = withActivity.slice(0, limit);
  const metas = await Promise.all(top.map(s => readHeadMeta(s.file, s.size)));
  const sessions = top.map((s, i) => ({
    id: s.id,
    title: metas[i].title || '(无标题)',
    model: metas[i].model || null,
    entrypoint: metas[i].entrypoint || null,
    lastUsedAt: Math.round(s.activityAt)
  }));
  const result = { sessions, hasMore: withActivity.length > limit };

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
        if (!entry) continue; // 裸 null 等合法 JSON 但非对象：跳过，否则下面属性访问抛出连累已提取的 meta
        // entrypoint-marker 是自家写的假行（伪装 entrypoint:'cli' 骗 CLI /resume 选择器显示 web 会话，
        // 见 app.js writeSessionEntrypoint），恒在头部、早于真实消息行——排除掉，否则所有 web 会话的
        // entrypoint 全部被它抢先误判成 cli。
        if (!meta.entrypoint && entry.entrypoint && entry.type !== 'entrypoint-marker') meta.entrypoint = entry.entrypoint;
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
            if (!entry) continue; // 字面 "null" 行合法 parse 为 null，不判空会抛 TypeError 连累整个尾窗（头窗同款守卫）
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

// 纯函数：倒序找最后一条主链 user/assistant 的 timestamp（ms）。
// 用于会话列表 lastUsedAt/排序——忽略 mode/permission-mode/ai-title/last-prompt 等元数据写盘
// （web resume、CLI 切档会刷 mtime，否则旧会话会莫名顶到抽屉最前）。
// 跳过 isSidechain（子代理链）、isMeta（系统注入）、无 timestamp / 非法时间。无命中 → null（调用方回落 mtime）。
export function lastMessageActivityMs(entries) {
  if (!Array.isArray(entries)) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || (e.type !== 'user' && e.type !== 'assistant') || e.isSidechain || e.isMeta) continue;
    if (typeof e.timestamp !== 'string' || !e.timestamp) continue;
    const ms = Date.parse(e.timestamp);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

// 读 transcript 尾窗，解析最后主链消息时间。size 可注入省一次 stat；失败/空文件 → null。
async function readLastMessageActivityMs(file, size) {
  try {
    const fh = await open(file, 'r');
    try {
      if (size == null) ({ size } = await fh.stat());
      if (!size) return null;
      const start = size > LIST_ACTIVITY_TAIL_BYTES ? size - LIST_ACTIVITY_TAIL_BYTES : 0;
      const buf = Buffer.allocUnsafe(size - start);
      const { bytesRead } = await fh.read(buf, 0, size - start, start);
      const entries = [];
      for (const line of buf.toString('utf-8', 0, bytesRead).split('\n')) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch { /* 尾窗起点切中的半行：跳过 */ }
      }
      return lastMessageActivityMs(entries);
    } finally {
      await fh.close().catch(() => {});
    }
  } catch {
    return null;
  }
}

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
  if (!isSafeSessionId(sessionId)) return null; // SS-003
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

// 纯函数：给一串已解析 transcript 条目，返回末条真实 assistant 消息的 message.model，无则 null。
// 跳过 sidechain（子 agent 可能用不同模型）、isMeta 与 `<synthetic>`（错误合成条的占位模型名）。
// 用途：resume 时 chip 显示该会话实际用过的模型（展示回落，init.model 到达后被权威值覆盖；
// 绝不入 activeModel/defaultModel——不参与 setModel 差分，防 F1 式误重置）。
export function lastAssistantModel(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.type !== 'assistant' || e.isSidechain || e.isMeta) continue;
    const m = e.message?.model;
    if (typeof m === 'string' && m && m !== '<synthetic>') return m;
  }
  return null;
}

// 从 transcript 尾部读回末条 assistant 模型。尾窗/半行处理与 readLastPermissionMode 同款：
// 只读末尾 TAIL_READ_BYTES，极端超大会话读不到则返回 null 优雅回落。
export async function readLastAssistantModel(sessionId, cwd, { baseDir = CLAUDE_DIR, size = null } = {}) {
  if (!isSafeSessionId(sessionId)) return null; // SS-003
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
      return lastAssistantModel(entries);
    } finally {
      await fh.close().catch(() => {});
    }
  } catch {
    return null; // 文件不存在/读失败：回落上层默认
  }
}

// 切入预锁 / 疑似中断共用阈值：慢工具（长编译/深度搜索）常见 1-3 分钟零写入，5 分钟大概率真死了。
// 切入时：尾部 pending 但 lastChainTs 已超此阈值 → 不预锁（陈旧挂起消息，不是活终端）。
// 驾驶中：锁着 + pending + lastChainTs 超此阈值 → stale 文案「疑似中断、可接管」。
export const MIRROR_STALE_PENDING_MS = 5 * 60_000;

// 切入预锁决策（catchUpTick 切换分支用）：切入会话瞬间按尾部形态预判——PENDING=有人正驱动这个会话
// （终端 CLI 或别的设备），立即预锁，堵「切走再切回、终端还在跑但要等下一条 text 落盘才锁」的空窗。
// 旧行为「切入不预锁」是因为当时唯一判据 mtime 不可信（web 自己 resume 就刷 mtime）；尾部形态是语义
// 判据、可信。localBusy 豁免：web 自己在跑 turn 时尾部 PENDING 是己方 turn 的形态，不能当外部驱动误锁。
//
// 陈旧 pending 豁免（2026-07-14 真机）：尾部是 user 文本 / tool_use 等「形态 pending」但 lastChainTs
// 已超 MIRROR_STALE_PENDING_MS（典型：用户发完就走、终端没回、隔天打开 / server 重启后打开）——
// 此时没有活终端在跑，预锁会立刻叠加 stale 文案「疑似中断、可接管」，每次进工作区都误拦输入。
// 形态仍是 pending（真若终端还在跑长工具，keepAlive/后续 externalWrite 会再上锁），但切入时不预锁。
// registryBusy（P1）：注册表权威自报优先——无视尾部形态与陈旧豁免直接预锁（pid 验活由
// session-registry.js 保证；自 7/29 起不再校验 statusUpdatedAt 新鲜度，理由见那边的注释）；
// localBusy 豁免不变（己方 turn）。
//
// prevReadonly（2026-07-29）：本函数被两类调用方共用——真会话切换、以及「同一会话 socket 重连
// 触发的重定基线」（server 置 catchUpRebaselineRequested → catchUpKey=null → 复用切入分支）。
// 对后者，陈旧豁免会把终端正卡在超 5 分钟长工具上时【已经维持着】的锁清掉，而 mirrorReleaseStep
// 的 tailPending 只能维持锁造不出锁 → 手机息屏/断网/刷新一次就永久丢锁。豁免本意是「隔天打开一个
// 早就没人管的会话别误锁」，prevReadonly=true 表示同会话连续观察且上一刻锁着，不属于该情形 → 维持。
// 仍然只在形态仍 pending 时维持：settled 说明终端真收工了，该把写权交回手机侧。
//
// tailEntrypoint（2026-07-30 真机 5ed3eb8c）：写下这条 pending 尾部的进程【自报】的 entrypoint——CLI 写
// 'cli'，本项目 SDK 写 'sdk-ts'。是 sdk-ts 就说明这个 pending 是己方残留（回合被上游错误/中断打断，
// assistant 没落盘），终端从没参与过这个会话，锁它等于凭空拦死手机输入并谎称「终端会话运行中」。
// 白名单只认 sdk-ts：未知/新增取值一律回落既有判定（最坏维持今天的行为），绝不因认错来源而误放行
// 造成两端并发写分叉——误锁可由用户点「续接」化解，误放行造成的 transcript 分叉不可逆。
// 位置在 registryBusy 之后（活着的 CLI 自报在跑压过一切磁盘推断）、prevReadonly 之前（这类锁本就
// 不该建立，同会话重连不得把它续下去）。
const SDK_TAIL_ENTRYPOINTS = new Set(['sdk-ts']);
export function mirrorEntryLock({ tailVerdict, localBusy = false, lastChainTs = null, now = Date.now(), registryBusy = false, prevReadonly = false, tailEntrypoint = null } = {}) {
  if (localBusy) return false;
  if (registryBusy) return true;
  if (tailVerdict !== 'pending') return false;
  if (SDK_TAIL_ENTRYPOINTS.has(tailEntrypoint)) return false;
  if (prevReadonly) return true;
  if (lastChainTs != null && (now - lastChainTs > MIRROR_STALE_PENDING_MS)) return false;
  return true;
}

// 诊断时间线用：把 catchUpTickOnce 已经算出的 mirrorEntryLock 判定打包成一条可读详情，供
// diag-log 记录展示——不重复判定逻辑本身（locked 由调用方直接传入 mirrorEntryLock 的返回值），
// 只加一个 agedOutStale 派生字段，让事后回放能看出"这次没锁，是因为陈旧 pending 还是别的原因"。
// prevReadonly 也记进来：同会话重连维持锁那条路径会出现 agedOutStale=true 且 locked=true，
// 不记它的话事后读诊断时间线会觉得两字段自相矛盾、看不出锁是被谁维持的。
export function describeMirrorEntryLock({ tailVerdict, localBusy = false, lastChainTs = null, now = Date.now(), locked, autonomous = false, registryBusy = false, prevReadonly = false, tailEntrypoint = null } = {}) {
  const agedOutStale = lastChainTs != null && (now - lastChainTs > MIRROR_STALE_PENDING_MS);
  return { tailVerdict, localBusy, lastChainTs, agedOutStale, staleThresholdMs: MIRROR_STALE_PENDING_MS, locked, autonomous, registryBusy, prevReadonly, tailEntrypoint };
}

// 疑似中断判定：锁着 + 尾部 PENDING + 最后链条目距今超阈值（期间零写入）→ 终端可能被强杀/断电、轮次没
// 写完就死了。前端据此从「⏱ 终端驾驶中」转「⚠️ 疑似中断、可接管」文案（仍保持锁、不自动解锁——接管
// 始终要用户显式确认）。误判代价低——只是提前显示「可接管」引导，不改变锁态。
// 注意：仅在【已上锁】后的驾驶过程中有意义；切入时陈旧 pending 由 mirrorEntryLock 直接不锁，不会走到这里。
// registryBusy（P1）：新鲜自报=终端确定活着，压制「疑似中断」文案（中断的进程写不了 statusUpdatedAt）。
// serverStartedAt（2026-07-28 真机 b06fb05d）：web 自己的回合被 server 重启腰斩后，transcript 永远
// 停在 tool_result（形态 pending）却没有任何驾驶员活着；重启后几十秒内打开时 5 分钟陈旧豁免尚未生效，
// 横幅会说「终端会话运行中」——终端从没参与过这个会话，纯属说谎，且 mirrorReleaseStep 的 tailPending
// 分支让锁永不自动释放。判据：pending 尾部落盘于【本 server 进程启动之前】⇒ 它不可能是本进程期间的
// 活动产生的 ⇒ 立即判 stale（前端出「可续接」文案与入口），不必干等 5 分钟。
// 刻意只改文案态、不改锁态：真终端跑旧版 CLI（不写注册表 → registryBusy 恒 false）且卡在跨越重启的
// 长工具上时会被误标，代价仅是提前显示接管引导——与本函数既有的「误判代价低」取舍同档。
// cliRegistryVanished（2026-07-28 真机 b06fb05d 续集）：注册表负证据——cli 条目「曾在→消失」
// （session-registry.js cliPresenceStep）说明写下 pending 尾部的终端进程已死/已退，立即判 stale，
// 不必干等 5 分钟；registryBusy（终端关了又开新进程）是更新的活证据，仍然优先压制。
export function mirrorStaleFlag({ readonly, tailPending, lastChainTs, now, registryBusy = false, serverStartedAt = null, cliRegistryVanished = false } = {}) {
  if (registryBusy) return false;
  if (!readonly || !tailPending || lastChainTs == null) return false;
  if (cliRegistryVanished) return true;
  if (now - lastChainTs > MIRROR_STALE_PENDING_MS) return true;
  return serverStartedAt != null && lastChainTs < serverStartedAt;
}

// ── 尾部形态判定（单驾驶员模型核心判据，2026-07-12 本机实验实证）────────────────────────────
// 依据：CLI 每个动作即时落盘——assistant 发起 tool_use 先落、tool_result 回来再落、最终文本收尾落。
// 于是消息链最后一条的形态可直接读出「轮次是否完结」，不依赖磁盘静默时间窗猜测——修「终端长工具
// 调用（深度搜索/长编译）期间磁盘零写入 >12.5s 被 mirrorReleaseStep 静默窗误判成终端停了、横幅熄灭」。
// 实测双样本：正在跑的会话（尾=tool_result 等 assistant）判 pending ✓、已结束的（尾=assistant 纯文本）判 settled ✓。
// 分类表（链条目 = type∈{user,assistant}；主链跳过 isSidechain，子链只看 isSidechain）：
//   assistant 含 tool_use            → pending（正在执行工具，结果未落盘）
//   assistant 含 text（无 tool_use）  → settled（轮次收尾；'No response requested.' 自然覆盖）
//   assistant 只有 thinking          → pending（流式中间态，text/tool_use 未落）
//   user 含 tool_result              → pending（等 assistant 消费结果继续）
//   user 中断标记 [Request interrupted…] → settled（轮次被 Ctrl+C 掐掉）
//   user 其他文本                     → pending（等 assistant 回复）
//   无任何链条目/文件不存在           → settled（新会话/纯 meta：不锁）
// 注意 settled 有一个已知误判窗：assistant 中途 text 落盘、紧接着还要发 tool_use（多段输出）——落盘间隙
// 尾部短暂呈 settled。调用方（server catchUpTick）靠 keepAlive（文件增长）判据互补罩住，两者叠加使用。
//
// 子链（isSidechain）：主链 settled 后子 agent 仍可能狂写 sidechain——旧逻辑跳过 isSidechain 会
// 在 ~12.5s 后误解锁、双写分叉。合并判据：主链 pending 或子链 pending → 整体 pending。
// web 侧 slash 的裸文本形态判据 WEB_BARE_SLASH_RE 已上移到 src/shared/local-command.js
// （agent.js 的「长跑静默提示」要用同一条判据，两处各写一份必然漂移）。

// 该 user 条目之后（更高 index）是否已有本地命令的 stdout——/config /model 等本地命令
// 落盘形态：command-name → local-command-stdout，无 assistant。若只认 command-name 会永远 pending 锁死。
// 两种落盘形态都要认（2026-07-30 真机 5ed3eb8c）：
//   · CLI 形态：{ type:'user', message.content:"<local-command-stdout>…" }（历史实现只认这个）
//   · web 形态：{ type:'system', subtype:'local_command', content:"…" }——content 是顶层字段、不在
//     message 里，且 type 不是 user，故被原实现整条跳过。上游 503 打断 web 回合时错误正文正是这个
//     形态，漏认 → 主链停在光秃秃的 user 文本 → 永久 pending（见 classifyChainTail 处的说明）。
// system 行同样必须校验 <local-command-stdout|stderr> 标签，不能只看 subtype：同一个 subtype 下还落
// 【命令名回显】{ content:"<command-name>/status</command-name>…" }，那是命令【开始】的记录、不是输出。
// 真实反例（另一仓的 f0483015… 会话）idx 879：只认 subtype 会把回显当收尾，把正在进行的
// 终端回合判成 settled → 解锁 → 双写分叉（2026-07-30 子代理审查在真盘上抓到）。
function hasLocalCommandStdoutAfter(entries, fromIndex) {
  for (let j = fromIndex + 1; j < entries.length; j++) {
    const e = entries[j];
    if (!e) continue;
    if (e.type === 'system') {
      if (e.subtype !== 'local_command' || typeof e.content !== 'string') continue;
      if (isLocalCommandWrapped(e.content)) return true;
      continue;
    }
    if (e.type !== 'user' || e.isSidechain) continue;
    const c = e.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c)
      ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n')
      : '';
    if (!text) continue;
    if (isLocalCommandWrapped(text)) return true;
  }
  return false;
}

// sidechainOnly=false：只看主链；true：只看子链（isSidechain）。
// lastChainEntrypoint：链尾那条记录【自报】的写入方（CLI 写 'cli'、本项目 SDK 写 'sdk-ts'）。判「这条
// pending 是谁留下的」用它——磁盘上的硬证据，比注册表可靠（旧版 CLI 不写注册表）。见 mirrorEntryLock。
function classifyChainTail(entries, sidechainOnly) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    // SS-002：跳过 isMeta 与 CLI 系统噪音行（与 getSessionHistory / lastMessageActivityMs 对齐）。
    if (!e || (e.type !== 'user' && e.type !== 'assistant') || e.isMeta) continue;
    if (sidechainOnly) {
      if (!e.isSidechain) continue;
    } else if (e.isSidechain) {
      continue;
    }
    const lastChainTs = e.timestamp ? (Date.parse(e.timestamp) || null) : null;
    const lastChainEntrypoint = typeof e.entrypoint === 'string' ? e.entrypoint : null;
    const c = e.message?.content;
    const blocks = Array.isArray(c) ? c : null;
    if (e.type === 'assistant') {
      if (blocks?.some(b => b?.type === 'tool_use')) return { verdict: 'pending', lastChainTs, lastChainEntrypoint };
      if (blocks ? blocks.some(b => b?.type === 'text') : typeof c === 'string') {
        const text = typeof c === 'string' ? c : (blocks || []).filter(b => b?.type === 'text').map(b => b.text).join('\n');
        if (isCliSystemLine(text)) continue; // "No response requested." 等助手噪音：跳过继续往前找真链
        return { verdict: 'settled', lastChainTs, lastChainEntrypoint };
      }
      return { verdict: 'pending', lastChainTs, lastChainEntrypoint }; // 只有 thinking / 空内容：流式中间态
    }
    // user
    if (blocks?.some(b => b?.type === 'tool_result')) return { verdict: 'pending', lastChainTs, lastChainEntrypoint };
    const text = typeof c === 'string' ? c : (blocks || []).filter(b => b?.type === 'text').map(b => b.text).join('\n');
    if (/^\[Request interrupted by user[^\]]*\]$/.test(text.trim())) return { verdict: 'settled', lastChainTs, lastChainEntrypoint };
    if (isCliSystemLine(text)) continue; // local-command / bash / ide 噪音：不当链尾
    // 本地命令只存在于主链；子链不认这条收尾。收尾成立的前提是【链尾这条 user 自己就是那条 slash】——
    // 本地命令的输出只能给它自己的调用收尾，不能给任意一条 user 消息收尾，否则「终端发了真实请求、
    // assistant 还没回、期间用户又敲了个 /status」会被判成 settled → 解锁 → 双写分叉（真实反例见
    // hasLocalCommandStdoutAfter 上方注释）。放宽的只是【slash 的书写形态】，不是这个前提本身：
    //   · CLI 形态：<command-name>/foo</command-name> 包装 → reconstructSlashCommand
    //   · web 形态：裸文本 "/code-review max …"（SDK 原样落盘，无包装）→ WEB_BARE_SLASH_RE
    // 至于「普通消息（毫无 slash 特征）被上游 503 打断」——它与上面那个分叉场景在磁盘上完全同构，
    // 无法靠形态区分，故这里刻意【不】判 settled，改由 mirrorEntryLock 的 tailEntrypoint 判据兜底。
    if (!sidechainOnly && (reconstructSlashCommand(text) || WEB_BARE_SLASH_RE.test(text.trim()))
        && hasLocalCommandStdoutAfter(entries, i)) {
      return { verdict: 'settled', lastChainTs, lastChainEntrypoint };
    }
    return { verdict: 'pending', lastChainTs, lastChainEntrypoint };
  }
  return { verdict: 'settled', lastChainTs: null, lastChainEntrypoint: null };
}

// ── 自主循环误判为「终端驱动」的区分 ──────────────────────────────────────────
// ScheduleWakeup 的 <<autonomous-loop-dynamic>> / CronCreate 的 <<autonomous-loop>> 定时唤起本会话时，
// harness 会在 transcript 主链插一条 isMeta:true、文本以 "# Autonomous loop check" 开头的系统行，然后
// 自己继续跑一轮。此时尾部形态和「外部终端接管」在磁盘上完全同构（都是主链 tool_use 未落 tool_result），
// 但驱动方其实是本会话自己被定时唤起，不是外部终端——上层用这个字段挑更准确的文案，不改变是否上锁
// （即使能确定是自主循环，仍需要防两边并发写同一 JSONL，锁本身没错，错的只是「终端」这个措辞）。
// 只看「尾窗内是否存在这条 marker」，不追溯它与当前 pending 是否连续——2026-07-24 真机的已知取舍：
// 若尾窗内先有一次自主循环完整收尾、又被后来的真终端接过去也写出了 pending，会误标 autonomous=true；
// 这个组合概率低、代价小（只是文案不够精确，不影响锁本身），换取实现足够简单。
// 依赖 harness 固定注入的文案前缀，不是本仓库能控制的契约——文案格式变化时这里查不到 marker，静默
// 退化回旧判定（不报错、不误锁，只是少了这一种更精确的文案）。
const AUTONOMOUS_LOOP_MARKER_RE = /^#\s*Autonomous loop check\b/;
function isAutonomousLoopMarkerEntry(e) {
  if (!e || e.type !== 'user' || e.isMeta !== true) return false;
  const c = e.message?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c)
    ? c.filter(b => b?.type === 'text').map(b => b.text).join('\n')
    : '';
  return AUTONOMOUS_LOOP_MARKER_RE.test(text.trim());
}
export function hasAutonomousLoopMarker(entries) {
  return entries.some(isAutonomousLoopMarkerEntry);
}

export function classifyTailEntries(entries) {
  const main = classifyChainTail(entries, false);
  const side = classifyChainTail(entries, true);
  const autonomous = hasAutonomousLoopMarker(entries);
  if (main.verdict === 'pending') return { ...main, autonomous };
  if (side.verdict === 'pending') {
    // 主链已收尾但子 agent 仍在跑：维持 pending，stale 时钟取两者较新时间戳；entrypoint 取子链的
    // ——此时「谁在驾驶」由子 agent 那条记录自报，主链那条早已不是最后写盘的人。
    const times = [main.lastChainTs, side.lastChainTs].filter((t) => t != null);
    const lastChainTs = times.length ? Math.max(...times) : side.lastChainTs;
    return { verdict: 'pending', lastChainTs, lastChainEntrypoint: side.lastChainEntrypoint, autonomous };
  }
  return { ...main, autonomous }; // 主链 settled（子链无活动或也已 settled）
}

// IO 包装：读 transcript 尾窗 → 解析 → classifyTailEntries。尾窗/半行处理与 readLastPermissionMode 同款。
// 极端边界：若最后一条链条目距文件尾 >512KB（如超巨型子 agent 尾巴），尾窗里无链条目 → settled（不锁、
// 不误伤输入；镜像锁的兜底仍有 externalWrite 判据在）。
export async function classifyTranscriptTail(sessionId, cwd, { baseDir = CLAUDE_DIR, size = null } = {}) {
  if (!isSafeSessionId(sessionId)) return { verdict: 'settled', lastChainTs: null, lastChainEntrypoint: null, autonomous: false }; // SS-003
  const file = join(baseDir, getProjectDir(cwd), `${sessionId}.jsonl`);
  try {
    const fh = await open(file, 'r');
    try {
      if (size == null) ({ size } = await fh.stat());
      if (size === 0) return { verdict: 'settled', lastChainTs: null, lastChainEntrypoint: null, autonomous: false };
      const start = size > TAIL_READ_BYTES ? size - TAIL_READ_BYTES : 0;
      const buf = Buffer.allocUnsafe(size - start);
      const { bytesRead } = await fh.read(buf, 0, size - start, start);
      const entries = [];
      for (const line of buf.toString('utf-8', 0, bytesRead).split('\n')) {
        if (!line.trim()) continue;
        try { entries.push(JSON.parse(line)); } catch { /* 尾窗起点切中的半行/写入中的截断尾行：跳过 */ }
      }
      return classifyTailEntries(entries);
    } finally {
      await fh.close().catch(() => {});
    }
  } catch {
    return { verdict: 'settled', lastChainTs: null, lastChainEntrypoint: null, autonomous: false }; // 文件不存在/读失败：不锁
  }
}

// 会话归属校验：该 sessionId 的 jsonl 是否就在本 cwd 的 project 目录（server 用它把跨 cwd 的
// 全局指针/失效 id 当「不属于本 cwd」处理——比 sessions.json 的 cwd 字段更硬，直接以文件存在为准）。
export async function sessionFileExists(cwd, id, { baseDir = CLAUDE_DIR } = {}) {
  // id 必须是合法 session id 字符集（UUID 形态：仅 [0-9a-zA-Z_-]）——拒绝含 / \ . 的路径穿越。
  // session:switch 是纵深防御层：前端列表已按 cwd 过滤，但构造 payload（如 '../别的cwd/<id>'）不得
  // 借 join 规范化越出本 cwd 的 project 目录（/verify 2026-06-12 实测抓出）。空串也被 + 量词挡掉。
  if (!isSafeSessionId(id)) return false;
  try {
    await stat(join(baseDir, getProjectDir(cwd), `${id}.jsonl`));
    return true;
  } catch {
    return false;
  }
}

// transcript 当前字节大小（只读镜像锁的 keep-alive 判活用：文件在长=终端在写盘）。
// 单看 history 条数会漏「半行/写盘中」与极短增量，故 keepAlive 用字节 size 而不是 history len。
// id 同 sessionFileExists 做字符集校验防路径穿越；文件不存在/非法 id → -1（catchUpTick 据此本 tick 不判增长）。
export async function sessionFileSize(sessionId, cwd, { baseDir = CLAUDE_DIR } = {}) {
  if (!isSafeSessionId(sessionId)) return -1;
  try {
    const { size } = await stat(join(baseDir, getProjectDir(cwd), `${sessionId}.jsonl`));
    return size;
  } catch {
    return -1;
  }
}

// L2 删除的活跃会话保护②用（FR-20，承接 docs/design.md）：mtime 距今 < 静默阈值即视为"可能正被终端使用"——
// 纯终端进程正驱动的会话后端无法确证（同 AD-3 盲区），mtime 是文件系统元数据级的启发式护栏，非内容
// 解析，诚实登记非完备。id 同 sessionFileExists 做字符集校验防路径穿越；不存在/非法 id → -1。
export async function sessionFileMtime(sessionId, cwd, { baseDir = CLAUDE_DIR } = {}) {
  if (!isSafeSessionId(sessionId)) return -1;
  try {
    const { mtimeMs } = await stat(join(baseDir, getProjectDir(cwd), `${sessionId}.jsonl`));
    return mtimeMs;
  } catch {
    return -1;
  }
}

// localBusy 分支的外部写入判据（单驾驶员防分叉）。instanceState 的 'permission' 与 'busy' 语义不同：
//   permission = canUseTool 挂起等用户点审批，可长达 APPROVAL_TTL_MS（默认 30min），web 侧【根本不写盘】
//                → 这段时间磁盘长大，必然是终端写的；
//   busy       = 己方轮次/后台任务真在跑，自己也在写盘 → size 增长不能归给终端。
// 原实现把两者并进同一个 localBusy，一起抑制追平 + 上锁 + 标脏，于是「手机上弹着审批卡片、人走到电脑前
// 用终端继续同一会话」这 30 分钟里：终端的回合不上屏、手机没有只读横幅、externalDirty 也不置位 ——
// 下一条手机消息直接送进停在 30 分钟前的 SDK 子进程，从旧 parentUuid 写出第二条链（transcript 分叉）。
export function externalGrowthWhilePaused({ state, prevSize, curSize } = {}) {
  if (state !== 'permission') return false;
  return Number(prevSize) >= 0 && Number(curSize) >= 0 && Number(curSize) > Number(prevSize);
}

// ---- 子代理进度观察（本地 slash 命令的唯一可见来源）----
// CLI 执行 /code-review 这类本地命令时，整条命令跑在独立 fork 上下文里：主链 transcript 零条目、
// SDK 流也零消息（2026-08-05 隔离探针实测整轮 stream_event = 0，尽管 forwardSubagentText 已开）。
// 但执行过程完整落在 <sessionId>/subagents/agent-<agentId>.jsonl —— 真机 xhigh 档单文件 762KB、
// max 档 22~26 个文件。这是「命令跑到哪了」的唯一可观测来源。
//
// 【只取进度不取正文】返回每个子代理的身份 + 最近动作，不返回对话正文：762KB 推给手机端既挤爆
// 环形缓冲（emitTransient 存在的理由正是这个），也不是移动端该渲染的体量。调用方喂 bgTaskUpsert，
// 复用既有后台任务面板与 ⏳ 角标。
//
// 【尾窗读取】同 classifyTranscriptTail：只读末 TAIL_READ_BYTES，不整读——子代理文件可达数百 KB，
// 而我们只要最后一条 tool_use 的名字。起点切中的半行 JSON.parse 失败即跳过。
// opts.since：只认这个时刻【之后】还有活动的子代理（毫秒）。不传 = 全收。
// 用途：同一会话第二次跑 /code-review 时，上一轮已完成的 agent-*.jsonl 仍躺在目录里，
// 不过滤就会被当成本轮进度立刻「复活」成运行中（2026-08-05 review #5）。
export async function scanSubagents(sessionId, cwd, { baseDir = CLAUDE_DIR, since = 0 } = {}) {
  if (!isSafeSessionId(sessionId)) return []; // SS-003 同口径：拒绝路径穿越
  const dir = join(baseDir, getProjectDir(cwd), sessionId, 'subagents');
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return []; // 目录不存在 = 本轮没有子代理（绝大多数普通轮次），不是错误
  }
  const out = [];
  for (const name of names) {
    const m = /^agent-([0-9a-zA-Z_-]+)\.jsonl$/.exec(name); // 字符集同 isSafeSessionId，排除 .meta.json 与异物
    if (!m) continue;
    const agentId = m[1];
    const entry = { agentId, agentType: null, description: null, lastToolName: null, lastActivityMs: 0 };
    // meta.json：agentType 恒有，description 只有被 spawn 的子代理有（顶层编排 agent 没有）
    try {
      const meta = JSON.parse(await readFile(join(dir, `agent-${agentId}.meta.json`), 'utf-8'));
      if (meta && typeof meta === 'object') {
        if (typeof meta.agentType === 'string') entry.agentType = meta.agentType;
        if (typeof meta.description === 'string') entry.description = meta.description;
      }
    } catch { /* meta 缺失/损坏：仍按无描述的子代理报出，不整条丢弃 */ }
    try {
      const fh = await open(join(dir, name), 'r');
      try {
        const { size, mtimeMs } = await fh.stat();
        entry.lastActivityMs = mtimeMs;
        if (size > 0) {
          const start = size > TAIL_READ_BYTES ? size - TAIL_READ_BYTES : 0;
          const buf = Buffer.allocUnsafe(size - start);
          const { bytesRead } = await fh.read(buf, 0, size - start, start);
          for (const line of buf.toString('utf-8', 0, bytesRead).split('\n')) {
            if (!line.trim()) continue;
            let e;
            try { e = JSON.parse(line); } catch { continue; }
            const content = e?.message?.content;
            if (!Array.isArray(content)) continue;
            for (const b of content) {                       // 同一条 assistant 可含多个 tool_use，取最后一个
              if (b?.type === 'tool_use' && typeof b.name === 'string') entry.lastToolName = b.name;
            }
          }
        }
      } finally {
        await fh.close().catch(() => {});
      }
    } catch { /* 读失败（写入中/权限）：保留已有 meta 字段报出，下一拍再试 */ }
    // since 过滤放在 push 前（读完才知道 mtime）。宽限 5s：命令刚发出、子代理文件可能在起点
    // 前一瞬创建；宁可多显示一条真在跑的，不漏报本轮进度。
    if (since > 0 && entry.lastActivityMs > 0 && entry.lastActivityMs < since - 5_000) continue;
    out.push(entry);
  }
  // 最近活动优先：前端明细行按此序展示，正在动的排前面
  out.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  return out;
}
