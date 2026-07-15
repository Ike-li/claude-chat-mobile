// workdir-scope-guard.js —— web 侧目录可达性的唯一裁决点（docs/design.md，承接 AD-12/FR-23）
// 与 workdirs.js 的 isWhitelisted 判断粒度不同：isWhitelisted 只判断 cwd 本身在不在白名单（精确匹配，
// 用于 session:new/switch 的 cwd——该值恒来自前端从 workDirs 列表本身选取，无子路径穿越面）；本函数判断
// cwd 内任意子路径是否越界（供文件浏览/附件等允许用户提供任意子路径的场景），必须 resolve 符号链接——
// 范围是权限边界，不 resolve 则 cwd 内一个指向范围外的 symlink 即逃逸（与 §5.5 canonicalize 刻意相反：
// 那是完整性层"所见即所批"的展示一致性抉择，不 resolve；此处权限层管真实落点，两者分工不同不可混用）。
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';

export function isInScope(candidate, scopeDirs) {
  if (typeof candidate !== 'string' || candidate === '') return false;
  if (!Array.isArray(scopeDirs) || scopeDirs.length === 0) return false;
  let real;
  try {
    real = realpathSync(candidate); // 绝对化 + 解析 ./ ../ + resolve 符号链接；不存在的路径在此抛错
  } catch {
    return false; // fail-closed：无法确认真实落点（不存在/不可达）一律拒绝，不假设安全
  }
  return scopeDirs.some(d => real === d || real.startsWith(d + sep));
}
