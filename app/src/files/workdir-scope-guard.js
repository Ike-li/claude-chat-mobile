// workdir-scope-guard.js —— web 侧目录可达性的唯一裁决点
// 与 sessions/folder-access.js 的 resolveAuthorizedCwd 分工不同：那边判「这个 cwd 能不能当会话目录」
// （session:new/switch 的 cwd）；本函数判断 cwd 内任意子路径是否越界（供文件浏览/附件等允许用户提供
// 任意子路径的场景），必须 resolve 符号链接——
// 范围是权限边界，不 resolve 则 cwd 内一个指向范围外的 symlink 即逃逸（与 canonicalize 刻意相反：
// 那是完整性层"所见即所批"的展示一致性抉择，不 resolve；此处权限层管真实落点，两者分工不同不可混用）。
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

export function isInScope(candidate, scopeDirs) {
  if (typeof candidate !== 'string' || candidate === '') return false;
  if (!Array.isArray(scopeDirs) || scopeDirs.length === 0) return false;
  let real;
  try {
    real = realpathSync.native(candidate); // 绝对化 + 解析 ./ ../ + resolve 符号链接；不存在的路径在此抛错。.native 同 folder-access.js
  } catch {
    return false; // fail-closed：无法确认真实落点（不存在/不可达）一律拒绝，不假设安全
  }
  return scopeDirs.some(d => real === d || real.startsWith(d + sep));
}

// 「范围内一个已经不在的东西」（验收 O80）：叶子 lstat 不存在，且最近一个存在的祖先 realpath 之后仍在范围内。
// 只供调用方在 isInScope 已经拒绝之后分清「不存在」与「越界」——决定审计记不记 scope_violation、报错怎么说，
// 不放行任何访问。悬空 symlink 不算（它存在，只是指向的东西不在）；祖先是指出去的 symlink、或经 ../ 走出去的，
// 祖先 realpath 落在范围外，同样不算。
export function isMissingInScope(candidate, scopeDirs) {
  if (typeof candidate !== 'string' || candidate === '') return false;
  try {
    lstatSync(candidate);
    return false;
  } catch (err) {
    if (err?.code !== 'ENOENT') return false;
  }
  let ancestor = dirname(candidate);
  for (;;) {
    try {
      lstatSync(ancestor);
      break;
    } catch { /* 叶子已是 ENOENT，祖先只会同样不存在：再往上 */ }
    const up = dirname(ancestor);
    if (up === ancestor) return false;
    ancestor = up;
  }
  return isInScope(ancestor, scopeDirs);
}

// 「已连接、但整个从磁盘消失的文件夹」：isMissingInScope 的另一半。连接根自己被删掉（常连同父目录）时，
// 最近一个存在的祖先已在范围外，isMissingInScope 判不出来。这里只认 candidate 词法上（resolve 掉 ../ 之后）
// 落在某个根之下、且那个根本身 lstat 是 ENOENT——根不在，它底下就什么都不可能在，不需要 realpath。
// 根被换成 symlink 的（lstat 存在）不算。同样只决定审计记不记 scope_violation，不放行任何访问。
export function isUnderVanishedRoot(candidate, roots) {
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) return false;
  if (!Array.isArray(roots)) return false;
  const target = resolve(candidate);
  return roots.some(root => {
    if (target !== root && !target.startsWith(root + sep)) return false;
    try {
      lstatSync(root);
      return false;
    } catch (err) {
      return err?.code === 'ENOENT';
    }
  });
}
