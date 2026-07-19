// file-security.js —— 文件安全守卫
// 功能：symlink 穿越防御 + owner-only 权限检查与修复。
// 用途：配置文件写入、doctor 权限检查、上传文件防护。
import { lstatSync, chmodSync, accessSync, constants, writeFileSync, openSync, closeSync, fsyncSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { platform } from 'node:os';

const isWindows = platform() === 'win32';

/**
 * 检查路径中是否包含可疑的 symlink（用户可写目录中的 symlink）
 * 返回可疑 symlink 路径，或 null（安全）
 *
 * 逻辑：遍历路径所有父级，若发现 symlink 且其父目录用户可写 → 危险
 * （用户可改 symlink 目标，导致穿越攻击）
 */
export function rejectableSymlinkComponent(path) {
  let current = resolve(path);
  while (true) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) {
        const parent = dirname(current);
        try {
          accessSync(parent, constants.W_OK);
          // 父目录用户可写 + symlink = 危险
          return current;
        } catch {
          // 父目录不可写，symlink 相对安全
        }
      }
    } catch {
      // 路径组件不存在，继续向上
    }
    const parent = dirname(current);
    if (parent === current) return null; // 到文件系统根，全程未发现可疑 symlink
    current = parent;
  }
}

/**
 * 检查文件权限是否为 owner-only (0600 文件 / 0700 目录)
 * Windows 平台总是返回 true（不支持 POSIX 权限位）
 */
export function isOwnerOnly(path, isDir = false) {
  if (isWindows) return true;  // Windows 降级：不检查

  try {
    const stat = lstatSync(path);
    const mode = stat.mode & 0o777;
    const expected = isDir ? 0o700 : 0o600;

    // 精确匹配（不仅检查 group/other 为 0，还要求 owner 为 rwx/rw-）
    return mode === expected;
  } catch {
    return false;
  }
}

/**
 * 修复文件权限为 owner-only
 * Windows 平台静默成功（不操作）
 */
export function fixPermissions(path, isDir = false) {
  if (isWindows) return true;  // Windows 降级：跳过

  const mode = isDir ? 0o700 : 0o600;
  try {
    chmodSync(path, mode);
    return true;
  } catch {
    return false;
  }
}

/**
 * 创建 owner-only 文件（0600 权限），真原子写：
 * 0600 写 <path>.tmp → fsync → rename 顶替——任何瞬间读 path 都是完整旧版或完整新版，
 * 写一半被杀/磁盘满不会留下半截文件（sessions.json/init-cache.json 的损坏防线）。
 * tmp 固定名在单进程、调用方串行写入下无竞态；rename 失败残留的 .tmp 无害（下次覆盖）。
 *
 * 注意：Node.js 的 fs.writeFileSync(path, data, {mode}) 在某些平台上
 * mode 参数会被 umask 影响，不可靠。这里用 fs.openSync 显式设置。
 */
export function writeOwnerOnlyFile(path, content) {
  if (isWindows) {
    // Windows 降级：直接写（无权限位；rename 顶替已存在文件在 Windows 语义不保证，维持现状）
    writeFileSync(path, content);
    return;
  }

  const tmp = `${path}.tmp`;
  let fd;
  try {
    // mode 0o600 = rw-------（umask 只能清权限位，0600 不受影响）
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o600);
    writeFileSync(fd, content);
    fsyncSync(fd); // 先落盘再 rename，防掉电后 rename 先于数据持久化
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  renameSync(tmp, path);

  // 二次确认权限（某些文件系统可能忽略 mode）
  fixPermissions(path, false);
}

/**
 * 检查路径列表的权限，返回有问题的路径
 * 用于 doctor 批量检查
 */
export function checkPermissions(paths, isDir = false) {
  const problems = [];
  for (const path of paths) {
    try {
      lstatSync(path);  // 不存在会抛 → 下面 catch 跳过
    } catch {
      continue;
    }

    if (!isOwnerOnly(path, isDir)) {
      problems.push(path);
    }
  }
  return problems;
}
