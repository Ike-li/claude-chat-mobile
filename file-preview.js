// file-preview.js —— 工具卡片文件预览（③）的纯逻辑 + 有界读盘。
// 安全红线：attributePath 是唯一闸门——预览的 diff 与 snippet 都必须在它之后，绝不能变成任意文件读。
import { resolve, relative, sep, basename } from 'node:path';
import { openSync, readSync, closeSync, statSync } from 'node:fs';

// 路径归属 + 安全裁决（零 IO，只 path.resolve）。相对 filePath 锚 instance.cwd。
// 返回 { workDir, relPath, resolved } 表示属于某白名单工作目录；null = 不属任何 → 调用方一律拒绝。
// 与 uploads.js 的穿越防护同源：resolve 规范化后按 `dir` 或 `dir + sep` 前缀判定
// （+sep 防 /home/u/repoX 被误判为 /home/u/repo 的子项）。
export function attributePath(filePath, workDirs, cwd) {
  if (!filePath || !Array.isArray(workDirs)) return null;
  const resolved = resolve(cwd || '/', filePath);
  for (const dir of workDirs) {
    if (resolved === dir || resolved.startsWith(dir + sep)) {
      return { workDir: dir, relPath: relative(dir, resolved) || basename(resolved), resolved };
    }
  }
  return null;
}

// 变更摘要（不读盘，来自缓存的完整 tool input）。Read 返回 null（input 无内容，走 readPreview 读盘）。
export function buildDiff(name, input = {}) {
  switch (name) {
    case 'Edit':
      return { kind: 'edit', hunks: [{ old: input.old_string ?? '', new: input.new_string ?? '' }] };
    case 'MultiEdit':
      return { kind: 'multiedit', hunks: (input.edits || []).map(e => ({ old: e.old_string ?? '', new: e.new_string ?? '' })) };
    case 'Write':
      return { kind: 'write', added: input.content ?? '' };
    case 'NotebookEdit':
      return { kind: 'notebook', added: input.new_source ?? '' };
    default:
      return null;
  }
}

// 有界读盘片段（Read 用）。按字节 + 行数双封顶，防大文件撑爆 socket；含 NUL 判二进制不回显。
// 调用方【必须】先过 attributePath（传入的 resolved 应已确认在白名单工作目录内）。
export function readPreview(resolved, { maxBytes = 64 * 1024, maxLines = 400 } = {}) {
  const NUL = String.fromCharCode(0);
  const size = statSync(resolved).size;
  const fd = openSync(resolved, 'r');
  try {
    const buf = Buffer.alloc(Math.min(size, maxBytes));
    const n = readSync(fd, buf, 0, buf.length, 0);
    const raw = buf.subarray(0, n).toString('utf8');
    if (raw.includes(NUL)) return { snippet: '（二进制内容，略）', truncated: false, size, binary: true };
    let truncated = size > maxBytes;
    const lines = raw.split('\n');
    let snippet = raw;
    if (lines.length > maxLines) { snippet = lines.slice(0, maxLines).join('\n'); truncated = true; }
    return { snippet, truncated, size };
  } finally {
    closeSync(fd);
  }
}
