// file-browse.js —— FileBrowseHandler（docs/design.md，承接 AD-12/FR-07"浏览项目文件"）
// 授权目录内的文件树浏览、内容读取，以及（2026-07 起）CodeMirror 编辑器的直写回。请求-响应型，
// 不进事件信封/RingBuffer——非会话进展，断线重来即可，无"错过"概念（server.js 侧以普通 ack 回调接线，不走 broadcast）。
// 写路径唯一入口 writeFileInScope（socket 层 files:write）：只改【已存在】的文件（不带 O_CREAT，不新建
// 不删）、≤MAX_BROWSE_BYTES、baseHash 与磁盘现状不符即拒（防覆盖 Claude 并发改动）、写前后都过范围门，
// 落盘即审计（server.js audit.recordAudit file_write）；这是机主本人在编辑器里的显式操作，语义等同
// ssh+vim，不走 agent 行为的审批链（approval-store 是给 canUseTool 设计的，不是给人)。部署方仍可用
// .env FILE_EDIT=off 整体回到只读（server.js 读取，见其头注）。
// 透明性权衡（显式抉择，承接 docs/design.md）：范围内内容不做敏感过滤（.env 等照读）——机主即 root +
// 终端 TUI 语义等同，防线在范围门（WorkdirScopeGuard）不在内容审查，本模块不自作主张加过滤。
import { readdirSync, lstatSync, fstatSync, openSync, readSync, closeSync, renameSync, unlinkSync, writeFileSync, chmodSync, fsyncSync, constants } from 'node:fs';
import { isUtf8 } from 'node:buffer';
import { join, dirname, basename } from 'node:path';
import { createHash } from 'node:crypto';
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

// 特殊文件闸，必须在 open 【之前】跑。POSIX 下 open(FIFO, O_RDONLY) 在没有 writer 时【无限阻塞】，
// O_NOFOLLOW 不改变这一点，也没有任何超时；而下方 fstat 的类型检查在 open 之后才执行，救不了。
// 单进程 Node 一旦卡在这个同步调用上，所有会话、socket、statusline、catchUpTick、/health 全部停摆，
// 无自愈路径，只能人工上机杀进程重启。触发不需要攻击者——工作目录里存在一个 mkfifo 出来的管道，
// 用户在文件浏览器里点一下即可（listDir 此前把它归类成普通 file）。字符设备与 unix socket 同理。
// lstat 不跟随 symlink：symlink 目标仍由 O_NOFOLLOW 负责拒绝，此处只放行 symlink 自身与常规文件。
function isOpenableTarget(real) {
  try {
    const st = lstatSync(real);
    return st.isFile() || st.isSymbolicLink();
  } catch {
    return false;
  }
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
      // 'special' = FIFO / 字符设备 / unix socket：它们不是可读文件，读它们会卡死整个服务（见
      // isOpenableTarget）。前端对未知 kind 显示 ❔ 且不进入可点读分支，天然不可达。
      const kind = st.isSymbolicLink() ? 'symlink'
        : st.isDirectory() ? 'dir'
          : st.isFile() ? 'file' : 'special';
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
  if (!isOpenableTarget(real)) return null; // FIFO/设备/socket：open 会永久阻塞，必须在 open 前挡
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
    const truncated = offset + sliceEnd < totalSize;
    // contentHash 只在"一次性读全"（offset=0 且未截断）且合法 UTF-8 时给：CodeMirror 编辑器据此判定
    // 该文件是否整份在手、可开编辑态；写回（writeFileInScope）拿它当 baseHash 冲突检测基线。分页读取
    // 的中间页不给——半份内容不构成有效编辑基线。非法 UTF-8（如 Latin-1/GBK 编码、无 NUL 字节故
    // binary=false）也不给：toString('utf8') 会把非法字节序列静默换成 U+FFFD，若据此开编辑态再写回，
    // Buffer.from(content,'utf8') 会把原始字节永久替换掉且哈希校验拦不住（哈希基于原始字节算，換字节
    // 发生在字符串表示层）——不给编辑基线，仍可只读预览（content 里的 U+FFFD 只是显示层近似）。
    const contentHash = (!binary && offset === 0 && !truncated && isUtf8(slice))
      ? createHash('sha256').update(slice).digest('hex')
      : undefined;
    return {
      content: binary ? '' : slice.toString('utf8'),
      truncated,
      totalSize,
      binary,
      // 供分页续读定位下一片起点：不能用 content.length（JS 字符串长度=字符数，多字节 UTF-8 下与
      // 字节数不等）；调用方应以 offset + bytesRead 作为下一次 readFile 的 offset。
      bytesRead: sliceEnd,
      ...(contentHash ? { contentHash } : {}),
    };
  } finally {
    closeSync(fd);
  }
}

// 写回既有文件（不带 O_CREAT——不新建、不改名、不删；新建/删文件仍只能"会话内让 claude 改"）。
// baseHash 必填：用同一 fd 先读出磁盘现状算 sha256 比对，不符（= 落盘后被外部改过，多半是 Claude
// 并发在写）即拒并回 conflict，不静默覆盖。O_RDWR 而非分开"读一次、开一次写"，收窄 TOCTOU 窗口
// （fd 一旦拿到，读到的现状与即将写入的目标是同一个 inode 的同一时刻）；仍非绝对防护——见
// readFile 头注同款免责声明，另一个进程用不同 fd 仍可能与本次写交错，无 flock。
export function writeFileInScope(cwd, relPath, content, scopeDirs, { baseHash } = {}) {
  if (typeof content !== 'string') return { ok: false, code: 'bad_content', error: '内容不合法' };
  if (typeof baseHash !== 'string' || !baseHash) return { ok: false, code: 'bad_base_hash', error: '缺少基线哈希' };
  // 范围门必须先于内容大小检查：越界 relPath 配超大 content 时，socket-files.js 只认 code==='scope'
  // 记 scope_violation 审计（这是无 approval-store 的写路径唯一事后可追溯记录），too_large 抢先会让
  // 一次真实越界尝试被记成普通 file_write/denied，漏掉本该报警的那条。
  const real = resolveInScope(cwd, relPath, scopeDirs);
  if (real === null) return { ok: false, code: 'scope', error: '路径不在授权范围内，或不是文件' };
  // 写路径同样要在 open 前挡特殊文件：O_RDWR 打开 FIFO 一样会阻塞；且此前只有 isDirectory 一道闸，
  // FIFO/socket 的 size 恒 0（基线哈希= 空串 sha256），能被 rename 顶替成普通文件、销毁正在用的管道。
  if (!isOpenableTarget(real)) return { ok: false, code: 'not_file', error: '目标不是常规文件' };
  const contentBuf = Buffer.from(content, 'utf8');
  if (contentBuf.length > MAX_BROWSE_BYTES) {
    return { ok: false, code: 'too_large', error: `内容超过 ${MAX_BROWSE_BYTES} 字节上限` };
  }

  const NOFOLLOW = constants.O_NOFOLLOW || 0;
  let fd;
  try {
    fd = openSync(real, constants.O_RDWR | NOFOLLOW); // 无 O_CREAT：目标不存在时按下方 catch 走 not_found
  } catch (err) {
    // ENOENT：resolveInScope 通过后、open 前的窗口里文件被删（TOCTOU race，resolveInScope 本身对
    // 「从未存在」的路径已 fail-closed 判 scope，不会走到这里）。EISDIR：目标是目录——O_RDWR 打开
    // 目录在 POSIX 上 open() 本身就拒绝（不像 O_RDONLY 那样能开成功再靠 fstat 判断），故在此处兜底；
    // 下方 fstat 的 isDirectory 检查是跨平台（Windows 语义可能不同）防御，非本条件唯一防线。
    if (err?.code === 'ENOENT') return { ok: false, code: 'not_found', error: '文件不存在（编辑器仅支持改写已存在的文件）' };
    if (err?.code === 'EISDIR') return { ok: false, code: 'not_file', error: '目标是目录，不是文件' };
    return { ok: false, code: 'open_failed', error: err.message || '打开文件失败' };
  }
  try {
    if (!isInScope(real, scopeDirs)) return { ok: false, code: 'scope', error: '路径不在授权范围内' }; // 开后复核
    const stat = fstatSync(fd);
    if (stat.isDirectory()) return { ok: false, code: 'not_file', error: '目标是目录，不是文件' };
    if (stat.size > MAX_BROWSE_BYTES) return { ok: false, code: 'too_large', error: '文件超出可编辑大小上限，无法核对基线' };
    const existing = Buffer.alloc(stat.size);
    if (stat.size > 0) readSync(fd, existing, 0, stat.size, 0);
    const currentHash = createHash('sha256').update(existing).digest('hex');
    if (currentHash !== baseHash) {
      return { ok: false, code: 'conflict', error: '文件已被修改（可能是 Claude 正在改），请刷新后重试' };
    }
    // 先写同目录临时文件再 rename：避免 ftruncate(0) 后 write 失败把已有内容清空（I4）。
    // 仍先 O_RDWR|O_NOFOLLOW 打开目标做 scope/类型/baseHash 校验；临时文件不带 O_CREAT 到目标 inode。
    const tmp = join(dirname(real), `.ccm-edit-${basename(real)}.${process.pid}.${Date.now()}.tmp`);
    // 保留原文件权限位：rename 是「新 inode 顶替」，不显式给 mode 就落成 0o666 & ~umask（通常 0644）——
    // 手机上改一行 shell 脚本/git hook，保存后静默丢掉 +x（0755→0644）；0600 的敏感文件被放宽到 0644，
    // 且 tmp 在 rename 前就已用 0644 承载明文。同仓 writeOwnerOnlyFile 一直做对了，这条写回路径漏了。
    // umask 只能清位不能加位，故 open 的 mode 之外再显式 chmod 一次，保证精确保留。
    const prevMode = stat.mode & 0o777;
    try {
      let tfd;
      try {
        tfd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, prevMode); // EXCL≙wx
        writeFileSync(tfd, contentBuf);
        fsyncSync(tfd); // 先落盘再 rename：否则掉电后 rename 可能先于数据持久化，留下空/截断文件
      } finally {
        if (tfd !== undefined) closeSync(tfd);
      }
      chmodSync(tmp, prevMode);
      renameSync(tmp, real); // 同卷原子替换
    } catch (err) {
      try { unlinkSync(tmp); } catch { /* tmp 可能未创建或已 rename */ }
      return { ok: false, code: 'write_failed', error: err?.message || '写入失败' };
    }
    return { ok: true, contentHash: createHash('sha256').update(contentBuf).digest('hex'), bytesWritten: contentBuf.length };
  } finally {
    closeSync(fd);
  }
}
