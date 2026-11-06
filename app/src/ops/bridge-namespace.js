// bridge-namespace.js —— 卸载一座 CLI 桥时，清掉它在 ~/.claude/ccm 下自己的命名空间（验收 O35）
//
// 两座桥各自在 ~/.claude/ccm/<桥>-v1 下放安装清单与运行期产物（hooks：默认 events / acks 与 verify 回执；
// statusline：快照）。单独卸载桥此前只恢复 settings.json、删 manifest，这些目录原样留着，只有整体
// `npm run uninstall` 才清（scripts/uninstall.js 的 residue 步骤）。
//
// 只认两座桥的字面量目录名：路径各段都不来自外部输入。用户把 CLI_HOOKS_DIR 指到命名空间外的自定义目录，
// 那不是我们建的，绝不碰。~/.claude/ccm 只剩空目录（或 macOS 的 .DS_Store）时一并移除，有别的东西就留着。

//
// 两座桥的运行期代码和安装器还共用下面几个文件操作，写法要求一致：symlink 一律拒绝，
// 写入走 O_EXCL 建的点前缀临时文件再 rename。

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { claudeHome, ccmUnderClaudeHome } from '../shared/claude-home.js';

const BRIDGE_NAMESPACES = new Set(['hooks-v1', 'statusline-v1']);

export function removeBridgeNamespace(home, name) {
  if (!BRIDGE_NAMESPACES.has(name)) throw new Error(`unknown bridge namespace: ${name}`);
  // HOME 为空串时 os.homedir() 原样返回 ""，join 出来是相对当前目录的路径——递归删除会打到别处。
  // 删除点自己守住，不指望每个调用方都给对。
  if (typeof home !== 'string' || !isAbsolute(home)) throw new Error(`bridge namespace home must be an absolute path: ${JSON.stringify(home)}`);
  // safe-rm: name 只能是上面两个字面量之一，路径是调用方注入的 home（生产为 homedir()）+ '.claude/ccm/<name>'，
  // 各段都不来自外部输入；两个调用方（桥的 uninstall）只在 settings 已按 manifest 恢复、manifest 已删之后才调用
  rmSync(ccmUnderClaudeHome(home, name), { recursive: true, force: true });

  const ccmDir = ccmUnderClaudeHome(home);
  let entries;
  try { entries = readdirSync(ccmDir); } catch { return; }
  if (entries.length === 1 && entries[0] === '.DS_Store') {
    unlinkSync(join(ccmDir, '.DS_Store')); // safe-path: 字面量文件名，目录为 ccmUnderClaudeHome(home)
    entries = [];
  }
  if (!entries.length) rmdirSync(ccmDir); // safe-path: 非递归 rmdir，只删空目录，路径各段为字面量 + 注入 home
}

export function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export function assertNoInstallerSymlinks(home, paths, namespace, label) {
  const candidates = [
    claudeHome(home),
    ccmUnderClaudeHome(home),
    ccmUnderClaudeHome(home, namespace),
    paths.settings,
    paths.manifest,
  ];
  for (const path of candidates) {
    if (lstatIfPresent(path)?.isSymbolicLink()) {
      throw new Error(`${label} refused symbolic link path: ${path}`);
    }
  }
}

export function ensurePrivateDirectory(dir, label) {
  const resolved = resolve(dir);
  mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} directory must be a real directory`);
  }
  if (process.platform !== 'win32') chmodSync(resolved, 0o700);
  return resolved;
}

// 不并进 file-security.js 的 writeOwnerOnlyFile：它在 Windows 降级成直接写，
// hooks inbox 可能读到半截 JSON。
export function atomicWriteFile(path, text) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  let renamed = false;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(fd, text, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
    renamed = true;
    if (process.platform !== 'win32') chmodSync(path, 0o600);
    return path;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the original write error */ }
    }
    if (!renamed) {
      try { unlinkSync(temporary); } catch { /* absent / already cleaned */ }
    }
  }
}

export function atomicWriteInstallerJson(path, value, { privateParent = false } = {}) {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: privateParent ? 0o700 : 0o755 });
  if (privateParent && process.platform !== 'win32') chmodSync(parent, 0o700);
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
