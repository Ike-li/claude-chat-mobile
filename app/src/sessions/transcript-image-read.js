// transcript-image-read.js —— 按引用从 transcript 取回一张图（image:get 的读盘一侧）。
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
import { parseImageRef, nthImageBlock, checkImagePayload } from '../shared/transcript-image.js';

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
async function findInFile(file, ref) {
  let input;
  try {
    input = (await openRegularFile(file)).fh.createReadStream({ encoding: 'utf-8' });
    const rl = createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes(ref.id)) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; } // 末行可能是写入中途的半行
      const block = blockFromEntry(entry, ref);
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
  let block = await findInFile(join(projectDir, `${sessionId}.jsonl`), parsed);
  // 新版 CLI 把子代理写在 <sessionId>/subagents/agent-*.jsonl，主 transcript 里只有那次 Agent 调用。
  if (!block && parsed.kind === 'tool' && parsed.agent) {
    const hit = await findSubagentByToolUseId(join(projectDir, sessionId, 'subagents'), parsed.agent);
    if (hit) block = await findInFile(join(projectDir, sessionId, 'subagents', `agent-${hit.agentId}.jsonl`), parsed);
  }
  if (!block) return { ok: false, code: 'not_found' };
  const check = checkImagePayload(block);
  if (!check.ok) return { ok: false, code: check.code };
  return { ok: true, mediaType: block.mediaType, data: block.data, bytes: check.bytes };
}
