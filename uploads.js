// uploads.js —— E17：附件落盘 + 路径注入 + 防穿越。
// 落盘方案（机主 2026-06-12 定）：完整文件字节写入 WORK_DIR/.ccm-uploads/，
// 把绝对路径注入 prompt 文本，claude 用 Read（白名单内、cwd 内免审批）读取——最贴终端等价。
// 缩略图（thumb）由前端 canvas 降采样生成、经 user_message 投送，此处只透传不生成（零图片依赖）。
import { mkdir, open } from 'node:fs/promises';
import { join, resolve, basename, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { rejectableSymlinkComponent } from './file-security.js';

export const UPLOAD_DIR = '.ccm-uploads';     // WORK_DIR 下的落盘子目录（点前缀，gitignore 友好）
const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;      // 单文件 10MB（解码后字节）
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;     // 总量 20MB（注：base64 上线 ~1.33x，见 server maxHttpBufferSize）

// 文件名收敛：只取 basename，去路径分隔/控制/危险字符，去前导点（防 . / .. / 隐藏覆盖），空则回退 file。
// basename 在 posix 不剥 Windows 反斜杠，故显式替换分隔字符——纵深防御，配合 saveAttachments 的落点校验。
export function sanitizeName(name) {
  const base = basename(String(name ?? '')).replace(/[\x00-\x1f\x7f]/g, '');
  const safe = base.replace(/[/\\:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
  return safe || 'file';
}

// 纯校验（零 IO，便于 smoke 单元）：返回错误字符串或 null（null=通过；空数组也返回 null，表示「无附件」）。
export function validateAttachments(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return null;
  if (attachments.length > MAX_FILES) return `附件过多（${attachments.length}，上限 ${MAX_FILES}）`;
  let total = 0;
  for (const a of attachments) {
    if (!a || typeof a.data !== 'string' || !a.data) return '附件缺少数据';
    if (typeof a.name !== 'string' || typeof a.mimeType !== 'string') return '附件缺少 name/mimeType';
    const bytes = Buffer.byteLength(a.data, 'base64');
    if (bytes > MAX_FILE_BYTES) return `附件「${a.name}」过大（${(bytes / 1048576).toFixed(1)}MB，单文件上限 10MB）`;
    total += bytes;
  }
  if (total > MAX_TOTAL_BYTES) return `附件总量过大（${(total / 1048576).toFixed(1)}MB，上限 20MB）`;
  return null;
}

// 落盘（假定已 validate）：写 WORK_DIR/.ccm-uploads/<ts>-<rand>-<safe>，resolve 校验落点不逃出该目录。
// 增强安全：symlink 检查 + O_NOFOLLOW 标志（POSIX 平台防 TOCTOU 攻击）。
// 返回 [{ absPath, name, mimeType, size, thumb? }]（含 absPath 供注入 prompt；thumb 原样透传给 user_message）。
export async function saveAttachments(workDir, attachments) {
  const dir = join(workDir, UPLOAD_DIR);
  await mkdir(dir, { recursive: true });

  // 新增：检查上传目录路径中是否包含可疑 symlink
  const symlink = rejectableSymlinkComponent(dir);
  if (symlink) {
    throw new Error(`上传目录路径包含可疑符号链接: ${symlink}`);
  }

  const dirResolved = resolve(dir);
  const saved = [];

  for (const a of attachments) {
    const fname = `${Date.now()}-${randomBytes(4).toString('hex')}-${sanitizeName(a.name)}`;
    const absPath = resolve(dir, fname);

    // 原有的路径穿越检查（保留，纵深防御）
    if (absPath !== join(dirResolved, fname) || !absPath.startsWith(dirResolved + sep)) {
      throw new Error(`非法附件路径：${a.name}`);
    }

    // 增强：使用 O_NOFOLLOW 防止 symlink 攻击（POSIX 平台）
    // O_NOFOLLOW 在 Windows 上值为 0（无效），但不影响功能（回退到路径检查）
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0);
    const fh = await open(absPath, flags, 0o600);  // 0600 = owner-only
    try {
      await fh.writeFile(Buffer.from(a.data, 'base64'));
      await fh.sync();  // fsync 确保落盘
    } finally {
      await fh.close();
    }

    saved.push({
      absPath, name: a.name, mimeType: a.mimeType,
      size: Buffer.byteLength(a.data, 'base64'), thumb: a.thumb
    });
  }
  return saved;
}

// 路径注入：原文末尾追加 [附件] 段（绝对路径逐行）。原文空（纯附件）时仅留附件段。
// 这是「告诉 claude 文件在哪」的静态标注，非中间层智能（§6）——等价终端里你说「看下 X 文件」。
export function buildPromptText(text, saved) {
  const base = (text || '').trim();
  if (!saved || saved.length === 0) return base;
  const block = '[附件] 已上传到工作目录，可用 FileRead / Read 读取：\n' + saved.map(s => s.absPath).join('\n');
  return base ? `${base}\n\n${block}` : block;
}

// 给 user_message 事件用的元数据（剥掉 absPath 与完整 data，仅留小 thumb——不污染环形缓冲，不泄服务端路径）。
export function toEventMeta(saved) {
  return saved.map(s => ({ name: s.name, mimeType: s.mimeType, size: s.size, thumb: s.thumb }));
}
