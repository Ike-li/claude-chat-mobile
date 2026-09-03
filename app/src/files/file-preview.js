// file-preview.js —— 工具卡片文件预览（③）的纯逻辑 + 有界读盘。
// 安全红线：attributePath 是唯一闸门——预览的 diff 与 snippet 都必须在它之后，绝不能变成任意文件读。
import { resolve, relative, sep, basename } from 'node:path';
import { openSync, readSync, closeSync, fstatSync, constants } from 'node:fs';

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
      // Array.isArray 而非 `|| []`：只挡 falsy 挡不住 truthy 但非数组的 edits（如字符串/对象），仍会在 .map 处炸。
      return { kind: 'multiedit', hunks: (Array.isArray(input.edits) ? input.edits : []).map(e => ({ old: e.old_string ?? '', new: e.new_string ?? '' })) };
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
// FILES-3：O_NOFOLLOW 打开——叶节点在 realpath 与 open 之间被换成外向 symlink 时 ELOOP 拒绝，不跟出 scope。
// 图片：按魔数识别常见格式，体积未超 maxBytes 时回 image{mimeType,base64} 供前端 <img>；
// 超大图片不回完整 base64（同样防 socket 撑爆），只给可读占位。
export function readPreview(resolved, { maxBytes = 64 * 1024, maxLines = 400 } = {}) {
  const NUL = String.fromCharCode(0);
  const NOFOLLOW = constants.O_NOFOLLOW || 0;
  // FILES-3：O_NOFOLLOW——叶节点在 realpath 与 open 之间被换成外向 symlink 时 ELOOP，不跟出 scope。
  const fd = openSync(resolved, constants.O_RDONLY | NOFOLLOW);
  try {
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(size, maxBytes));
    const n = readSync(fd, buf, 0, buf.length, 0);
    const head = buf.subarray(0, n);
    const mime = detectImageMime(head);
    if (mime) {
      // 图片整文件未读完（size > maxBytes）→ 不回 base64，只给占位
      if (size > maxBytes || n < size) {
        return {
          snippet: `（图片 ${mime}，约 ${Math.ceil(size / 1024)}KB，过大略；请在本机打开原文件）`,
          truncated: true,
          size,
          binary: true,
        };
      }
      return {
        snippet: `（图片 ${mime}，${size} bytes）`,
        truncated: false,
        size,
        binary: true,
        image: { mimeType: mime, base64: head.toString('base64') },
      };
    }
    const raw = head.toString('utf8');
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

// 魔数嗅探（不依赖扩展名：工具 Read 的路径可能无后缀 / 后缀撒谎）。
// 只认常见网页可展示格式；未知二进制继续走「（二进制内容，略）」。
function detectImageMime(buf) {
  if (!buf || buf.length < 3) return null;
  // PNG: 89 50 4E 47
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  // GIF: GIF87a / GIF89a
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
  // WEBP: RIFF....WEBP
  if (buf.length >= 12
    && buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
  return null;
}
