// file-browse.js —— FileBrowseHandler（docs/design.md，承接 AD-12/FR-07"浏览项目文件"）
// 授权目录内的只读文件树与文件内容读取。请求-响应型，不进事件信封/RingBuffer——非会话进展，
// 断线重来即可，无"错过"概念（server.js 侧以普通 ack 回调接线，不走 broadcast）。
// 只读铁律：本模块无写/删/改接口；web 侧改文件的唯一路径是"会话内让 claude 改"（经审批链）。
// 透明性权衡（显式抉择，承接 docs/design.md）：范围内内容不做敏感过滤（.env 等照读）——机主即 root +
// 终端 TUI 语义等同，防线在范围门（WorkdirScopeGuard）不在内容审查，本模块不自作主张加过滤。
import { readdirSync, lstatSync, fstatSync, openSync, readSync, closeSync, constants } from 'node:fs';
import { join } from 'node:path';
import { isInScope } from './workdir-scope-guard.js';

// docs/design.md 建议值（256KB/片、500 条/页）：本模块把它们同时当默认值与硬顶——弱网上限的含义是"每次最多这么多"，
// 客户端可请求更小的页（省流量），但不能请求更大的页绕过分页语义；不做成可无限调大的可配置项。
export const MAX_BROWSE_ENTRIES = 500;
export const MAX_BROWSE_BYTES = 256 * 1024;

// relPath 拼到 cwd 后必须仍在 scopeDirs 内——isInScope 兜底 symlink 逃逸/../ 越界。
// 返回 realpath 后的绝对路径，或 null（越界/不存在，调用方 fail-closed 拒绝 + 记审计，见 server.js）。
function resolveInScope(cwd, relPath, scopeDirs) {
  const candidate = join(cwd, relPath || '.');
  return isInScope(candidate, scopeDirs) ? candidate : null;
}

// 按固定字节数分片读取文本文件时，分片边界可能恰好切在一个多字节 UTF-8 字符中间（中文/emoji 等）——
// 若直接 toString('utf8')，被切断的尾字符会解码成替换字符（U+FFFD）或丢字节，且下一片从这个已损坏的
// 边界续读也接不回去。修：非最后一片时，从末尾回退到最近的合法字符边界，把不完整的尾字节挪给下一片。
function trimIncompleteUtf8Tail(buf) {
  const len = buf.length;
  if (len === 0) return 0;
  let i = len - 1, back = 0;
  while (i >= 0 && back < 3 && (buf[i] & 0xC0) === 0x80) { i--; back++; } // 跳过续接字节（10xxxxxx）
  if (i < 0) return 0; // 末 3 字节全是续接字节但找不到起始字节：不是合法 UTF-8，保守整片挪给下一次
  const lead = buf[i];
  let seqLen;
  if ((lead & 0x80) === 0x00) seqLen = 1;      // 0xxxxxxx ASCII
  else if ((lead & 0xE0) === 0xC0) seqLen = 2; // 110xxxxx
  else if ((lead & 0xF0) === 0xE0) seqLen = 3; // 1110xxxx
  else if ((lead & 0xF8) === 0xF0) seqLen = 4; // 11110xxx
  else return len; // 起始字节本身不合法 UTF-8 模式：不是本函数要处理的场景，不裁剪
  return (len - i) >= seqLen ? len : i; // 序列已完整不裁剪；不完整则裁到起始字节之前
}

export function listDir(cwd, relPath, scopeDirs, opts = {}) {
  const real = resolveInScope(cwd, relPath, scopeDirs);
  if (real === null) return null;
  const offset = Math.max(0, opts.offset || 0);
  const maxEntries = Math.min(opts.maxEntries > 0 ? opts.maxEntries : MAX_BROWSE_ENTRIES, MAX_BROWSE_ENTRIES);
  let names;
  try {
    names = readdirSync(real).sort(); // 稳定排序：分页 offset 语义依赖跨调用顺序一致
  } catch {
    return null; // 不是目录 / 已被删除等：一律拒绝，不是有效的 list 目标
  }
  // FILES-1：readdir 后再校一次 scope——dir→symlink 越界窗口内若已换，fail-closed 整页拒绝。
  if (!isInScope(real, scopeDirs)) return null;
  const page = names.slice(offset, offset + maxEntries);
  // FI-001：单条 lstat 失败（readdir↔lstat 竞态删除/不可读）跳过该名，不抛炸整页；
  // 否则 createSocketEventRegistrar catch 只 emit error、browse:list 永不 ack。
  const entries = [];
  for (const name of page) {
    try {
      // lstat 不 follow：symlink 条目如实标注自身（kind:'symlink'），不解析成其指向的类型——
      // 递归进入 symlink 走用户下一次 listDir 调用，届时 isInScope 会重新校验真实落点。
      const st = lstatSync(join(real, name));
      const kind = st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file';
      entries.push({ name, kind, size: st.size, mtime: st.mtimeMs });
    } catch {
      /* skip vanished/unreadable entry */
    }
  }
  return { entries, truncated: offset + maxEntries < names.length, totalCount: names.length };
}

export function readFile(cwd, relPath, scopeDirs, opts = {}) {
  const real = resolveInScope(cwd, relPath, scopeDirs);
  if (real === null) return null;
  const offset = Math.max(0, opts.offset || 0);
  const maxBytes = Math.min(opts.maxBytes > 0 ? opts.maxBytes : MAX_BROWSE_BYTES, MAX_BROWSE_BYTES);
  // E18 附件预览：base64 模式——按字节精确分页返回该片 base64（二进制不拒绝、不做 UTF-8 尾裁剪，
  // 拼装方是前端 Uint8Array，切在哪都无损）。范围门/硬顶与文本模式完全同权，模式只改编码不改安全。
  const wantBase64 = opts.encoding === 'base64';
  // TOCTOU 缓解（docs/design.md 登记为残余风险、非绝对防护）：O_NOFOLLOW 挡开时刻叶节点被替换为
  // symlink（ELOOP 直接拒绝）；读后再用 isInScope 复核一次真实落点，缓解 scope 校验与 open 之间的窗口替换。
  const NOFOLLOW = constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = openSync(real, constants.O_RDONLY | NOFOLLOW);
  } catch {
    return null;
  }
  try {
    if (!isInScope(real, scopeDirs)) return null; // 读后复核
    const stat = fstatSync(fd);
    if (stat.isDirectory()) return null; // 目录走 listDir，不是 readFile 的有效目标
    const totalSize = stat.size;
    const len = Math.max(0, Math.min(maxBytes, totalSize - offset));
    const buf = Buffer.alloc(len);
    const n = len > 0 ? readSync(fd, buf, 0, len, offset) : 0;
    const binary = buf.subarray(0, n).includes(0); // 二进制判定用完整读取字节，不受下方 UTF-8 边界裁剪影响
    if (wantBase64) {
      return {
        content: buf.subarray(0, n).toString('base64'),
        truncated: offset + n < totalSize,
        totalSize,
        binary,
        bytesRead: n
      };
    }
    // 非二进制且非最后一片时，把切在字符中间的尾字节挪给下一片（trimIncompleteUtf8Tail 头注）；
    // 是最后一片（offset+n>=totalSize）则不裁剪——文件本就到此为止，没有"下一片"接住裁掉的字节。
    const isFinalChunk = offset + n >= totalSize;
    const sliceEnd = (!binary && !isFinalChunk) ? trimIncompleteUtf8Tail(buf.subarray(0, n)) : n;
    const slice = buf.subarray(0, sliceEnd);
    return {
      content: binary ? '' : slice.toString('utf8'),
      truncated: offset + sliceEnd < totalSize,
      totalSize,
      binary,
      // 供分页续读定位下一片起点：不能用 content.length（JS 字符串长度=字符数，多字节 UTF-8 下与
      // 字节数不等）；调用方应以 offset + bytesRead 作为下一次 readFile 的 offset。
      bytesRead: sliceEnd
    };
  } finally {
    closeSync(fd);
  }
}
