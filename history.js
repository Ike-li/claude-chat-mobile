// history.js —— 读取 CLI 会话历史用于前端展示（方案 2）
// CLI 历史文件：~/.claude/projects/<project>/<session_id>.jsonl
import { open, stat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CLAUDE_DIR = join(homedir(), '.claude', 'projects');
// 历史回显防爆上限：极端超大会话只回最近 N 条 user/assistant，避免一次性把手机 DOM 撑爆。
// 正常会话（几百条内）全量返回——与 CLI /resume 的完整历史一致（终端等价性）。不再按字节截断头部。
export const HISTORY_MAX_MESSAGES = 2000;
const HEAD_READ_BYTES = 64 * 1024;  // 列表元数据（标题/模型/来源）只需文件头部少量字节
// CLI 把 ai-title 流式追加到「标题生成完成时」的字节位置——首轮工具/思考很重的长会话里常 > 64KB 头窗。
// 头窗没抓到 ai-title 时补读文件尾部这一段取最新 ai-title（实测最坏「最后一个 ai-title 距文件尾」330KB，512KB 有余量）。
const TAIL_READ_BYTES = 512 * 1024;
const LIST_LIMIT = 50;              // 会话列表上限（按 mtime 取最近 N，避免大目录全量读 head）

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
export function catchUpStep(state, { messages, localBusy = false }) {
  const len = messages.length;
  if (localBusy) return { emit: [], state: { baseline: state.baseline, wasBusy: true } };
  if (state.wasBusy) return { emit: [], state: { baseline: len, wasBusy: false } }; // 吸收己方 turn 的写盘
  if (len > state.baseline) return { emit: messages.slice(state.baseline), state: { baseline: len, wasBusy: false } };
  return { emit: [], state: { baseline: state.baseline, wasBusy: false } };
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

// ---- 会话列表：与 CLI /resume 同源，直接扫 ~/.claude/projects/<编码cwd>/ ----
// 列出该 cwd 下所有会话（含终端 entrypoint:cli 建的），不依赖 sessions.json 注册表。
// baseDir 仅供单测注入临时夹具；生产用默认 CLAUDE_DIR。
// 返回 { sessions, hasMore }：hasMore=该目录会话总数 > limit（诚实计算，非 length===limit 猜测），
// 供前端决定是否显示「显示全部」。缓存键含 limit——否则 limit=6 结果会在 TTL 内污染 all(limit=50) 请求。
export async function listSessionsPage(cwd, { baseDir = CLAUDE_DIR, limit = LIST_LIMIT } = {}) {
  const dir = join(baseDir, getProjectDir(cwd));
  const cacheKey = `${dir}:${limit}`;

  // B2：TTL 缓存命中，直接返回（避免重复 readdir + N×stat + N×readHeadMeta）
  const cached = _listCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < LIST_CACHE_TTL) return cached.result;

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
