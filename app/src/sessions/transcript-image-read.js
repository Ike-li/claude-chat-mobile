// transcript-image-read.js —— 按引用从 transcript 取回一张图（image:get 的读盘一侧），以及按 toolUseId 取回
// 一条工具结果的全文（tool:full 给历史卡片「展开全文」的读盘一侧，见文件末尾）。
//
// 引用由 history.js / agent.js 发出（文法见 shared/transcript-image.js）：t:<toolUseId>:<n>[:<子代理提示>]、
// u:<uuid>:<n>。这里只在【被请求的那个会话文件】里找——cwd 范围门与「这个会话属于这个 cwd」由 server
// 的 image:get 在调用前裁决，本函数不扩大可读范围：路径只由 sessionId + cwd 算出，引用里的 id 只用来匹配行。
//
// 逐行流式读、先按 id 子串预筛再 JSON.parse：transcript 最大见过 22MB，绝大多数行不含这个 id，
// 不预筛的话每取一张图都要把整份会话解析一遍。
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { getProjectDir, isSafeSessionId, findSubagentByToolUseId } from './history.js';
import { CLAUDE_PROJECTS_DIR } from '../shared/claude-home.js';
import { openRegularFile } from '../shared/regular-file.js';
import { parseImageRef, nthImageBlock, checkImagePayload, stripImageBlocks } from '../shared/transcript-image.js';
import { stringify, redactBase64 } from '../shared/tool-summary.js';

// undefined = 这一行不是被引用的那条（预筛只看子串，id 也会出现在 parentUuid / tool_use 行里）；
// null = 就是这条，但那个序号上没有 base64 图片块；否则返回 {mediaType, data}。
function blockFromEntry(entry, ref) {
  const content = entry?.message?.content;
  if (ref.kind === 'user') {
    if (entry?.uuid !== ref.id || entry.type !== 'user') return undefined;
    return nthImageBlock(content, ref.index);
  }
  if (!Array.isArray(content)) return undefined;
  for (const b of content) {
    if (b?.type === 'tool_result' && b.tool_use_id === ref.id) return nthImageBlock(b.content, ref.index);
  }
  return undefined;
}

// 找到对应条目就停（同 uuid 重复落盘时取第一条，与历史回放的去重口径一致）。
// needle 只用来预筛（子串），pick 判这一行是不是要找的那条：undefined = 不是，继续往下读。
async function findInFile(file, needle, pick) {
  let input;
  try {
    input = (await openRegularFile(file)).fh.createReadStream({ encoding: 'utf-8' });
    const rl = createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes(needle)) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; } // 末行可能是写入中途的半行
      const block = pick(entry);
      if (block !== undefined) return block;
    }
  } catch {
    return undefined; // 文件不存在 / 不是普通文件 / 读失败：当作没有
  } finally {
    input?.destroy();
  }
  return undefined;
}

export async function readTranscriptImage(sessionId, cwd, ref, { baseDir = CLAUDE_PROJECTS_DIR } = {}) {
  if (!isSafeSessionId(sessionId)) return { ok: false, code: 'bad_session' };
  const parsed = parseImageRef(ref);
  if (!parsed) return { ok: false, code: 'bad_ref' };
  const projectDir = join(baseDir, getProjectDir(cwd));
  const pick = entry => blockFromEntry(entry, parsed);
  let block = await findInFile(join(projectDir, `${sessionId}.jsonl`), parsed.id, pick);
  // 新版 CLI 把子代理写在 <sessionId>/subagents/agent-*.jsonl，主 transcript 里只有那次 Agent 调用。
  if (!block && parsed.kind === 'tool' && parsed.agent) block = await findInSubagent(projectDir, sessionId, parsed.agent, parsed.id, pick);
  if (!block) return { ok: false, code: 'not_found' };
  const check = checkImagePayload(block);
  if (!check.ok) return { ok: false, code: check.code };
  return { ok: true, mediaType: block.mediaType, data: block.data, bytes: check.bytes };
}

async function findInSubagent(projectDir, sessionId, agentToolUseId, needle, pick) {
  const hit = await findSubagentByToolUseId(join(projectDir, sessionId, 'subagents'), agentToolUseId);
  return hit ? findInFile(join(projectDir, sessionId, 'subagents', `agent-${hit.agentId}.jsonl`), needle, pick) : undefined;
}

// 历史工具卡的「展开全文」（验收 O55）：历史回放只带截断后的摘要，live 卡片的全文在实例内存里、刷新或换台设备
// 就没了，完整内容却一直在 transcript 里。范围门与「这个会话属于这个 cwd」同 image:get，由 server 的 tool:full
// 在调用前裁决；这里同样只在被请求的那个会话文件里找，子代理里的卡带上那次 Agent 调用的 id 到子代理文件里找。
// 内容口径同历史摘要（block.content，有图时只留文字——图另有引用按需取），再同 live 的 getToolOutput 红线 base64。
export async function readTranscriptToolResult(sessionId, cwd, toolUseId, { agentToolUseId = null, baseDir = CLAUDE_PROJECTS_DIR } = {}) {
  if (!isSafeSessionId(sessionId)) return { ok: false, code: 'bad_session' };
  if (typeof toolUseId !== 'string' || !toolUseId) return { ok: false, code: 'bad_ref' };
  const projectDir = join(baseDir, getProjectDir(cwd));
  const pick = entry => {
    const content = entry?.message?.content;
    if (!Array.isArray(content)) return undefined;
    return content.find(b => b?.type === 'tool_result' && b.tool_use_id === toolUseId);
  };
  let block = await findInFile(join(projectDir, `${sessionId}.jsonl`), toolUseId, pick);
  if (!block && typeof agentToolUseId === 'string' && agentToolUseId) {
    block = await findInSubagent(projectDir, sessionId, agentToolUseId, toolUseId, pick);
  }
  if (!block) return { ok: false, code: 'not_found' };
  return { ok: true, text: stringify(redactBase64(stripImageBlocks(block.content ?? ''))) };
}
