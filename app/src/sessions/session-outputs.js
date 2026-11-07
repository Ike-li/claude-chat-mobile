// session-outputs.js —— 从 transcript 算「这个会话产出了哪些文件」，给工作区 sheet 的「产出」tab 用。
//
// 收两类：Write 新建的文件（toolUseResult.type === 'create'），助手正文里的本地文件链接。Bash 生成的文件
// 没有结构化记录，助手贴了链接才进得来。
// 不收 Edit 和覆盖写：改动 tab 已经列了，收进来会淹没列表。不收带行号的链接：那是代码引用，不是成果
// （最近 60 个会话里这类有 88 条，不带行号的 56 条）。
//
// 逐行流式读、先按子串预筛再 JSON.parse，同 transcript-image-read.js：transcript 最大见过 22MB。
// 本函数只认 sessionId + cwd 算出的那一个文件，范围门与会话归属由调用方（socket-files.js）裁决。
import { createInterface } from 'node:readline';
import { isAbsolute, join } from 'node:path';
import { CLAUDE_PROJECTS_DIR } from '../shared/claude-home.js';
import { openRegularFile } from '../shared/regular-file.js';
import { getProjectDir, isSafeSessionId } from './history.js';

export const MAX_SESSION_OUTPUTS = 200;

const FENCED_CODE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE = /`[^`\n]*`/g;
// 裸写的目标可以带成对括号和反斜杠转义（clip(final).mp4），同 marked：只认一层嵌套，再深的模型也不这么写
const MARKDOWN_LINK = /\]\(\s*(?:<([^>\n]+)>|((?:\\.|\([^()\s]*\)|[^()\s\\])+))/g;
const LOCAL_FILE_URL = /^file:\/\/(?:localhost)?(?=\/)/i;
// 判据与前端 logic/file-links.js 对齐（前后端互不 import，tests/unit/session-outputs.test.mjs 用同一张表防漂移）。
// `foo.js:12` 形似 scheme，这里不用区分：它是代码引用，和外部协议一样都不算产出。
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LINE_SUFFIX = /:\d+(?:-\d+)?(?::\d+)?$/;

function decodePath(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

// 这个 href 指向的本地文件绝对路径；不是本地文件、或是代码引用时回 null
function linkedFile(href, cwd) {
  if (href.startsWith('//')) return null;
  const target = href.replace(LOCAL_FILE_URL, '');
  if (SCHEME.test(target)) return null;
  const [, path, fragment = ''] = /^([^?#]*)(?:\?[^#]*)?(?:#(.*))?$/s.exec(target);
  if (!path || LINE_SUFFIX.test(path) || /^L\d/.test(fragment)) return null;
  const decoded = decodePath(path);
  if (isAbsolute(decoded)) return decoded;
  return cwd ? join(cwd, decoded) : null;
}

function linkedFiles(text, cwd) {
  const prose = text.replace(FENCED_CODE, '').replace(INLINE_CODE, '');
  const files = [];
  for (const [, bracketed, bare] of prose.matchAll(MARKDOWN_LINK)) {
    const file = linkedFile(bracketed ?? bare.replace(/\\([()])/g, '$1'), cwd);
    if (file) files.push(file);
  }
  return files;
}

// 一条 transcript 记录带来的产出：[{ path, at }]
export function outputsFromEntry(entry) {
  if (entry?.isSidechain) return [];
  const at = Date.parse(entry?.timestamp) || 0;
  const result = entry?.toolUseResult;
  if (result?.type === 'create' && typeof result.filePath === 'string') {
    return [{ path: result.filePath, at }];
  }
  const content = entry?.message?.content;
  if (entry?.type !== 'assistant' || !Array.isArray(content)) return [];
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .flatMap(block => linkedFiles(block.text, entry.cwd))
    .map(path => ({ path, at }));
}

// 同一文件留最近一次，按时间倒序，超过上限留最新的
export async function readSessionOutputs(sessionId, cwd, { baseDir = CLAUDE_PROJECTS_DIR } = {}) {
  if (!isSafeSessionId(sessionId)) return [];
  const latest = new Map();
  let input;
  try {
    const file = join(baseDir, getProjectDir(cwd), `${sessionId}.jsonl`);
    input = (await openRegularFile(file)).fh.createReadStream({ encoding: 'utf-8' });
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (!line.includes('"type":"create"') && !line.includes('](')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; } // 末行可能是写入中途的半行
      for (const { path, at } of outputsFromEntry(entry)) {
        if (at >= (latest.get(path) ?? 0)) latest.set(path, at);
      }
    }
  } catch {
    return []; // 文件不存在 / 不是普通文件 / 读失败：当作没有
  } finally {
    input?.destroy();
  }
  return [...latest]
    .map(([path, at]) => ({ path, at }))
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_SESSION_OUTPUTS);
}
