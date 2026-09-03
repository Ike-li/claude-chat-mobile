// tests/helpers/worktree-tree.mjs —— 把【当前工作区】写成一个临时 git tree 对象。
//
// 【为什么需要】分发裁剪的验证要跑 `git archive`，而 archive 的输入是一个 commit/tree。
// 直接用 HEAD 的话，**未提交的改动不在其中**：改了 .gitattributes、移动了文件、加了新门禁，
// 测试照样绿——它验的是上一次提交的文件树配这一次的裁剪规则，两边不同源。
// 2026-09-03 实测：把 12 个门禁从 scripts/ 移进 tests/gates/ 后，`git archive HEAD` 仍报
// 「scripts/ 保留 29 个」，因为 HEAD 里那些文件还在老位置。
//
// 解法是用一个**临时 index**（GIT_INDEX_FILE）把工作区 add 进去再 write-tree，
// 全程不碰仓库真实的 index，也不产生提交。CI 上工作区恒等于 HEAD，行为与直接用 HEAD 一致。
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * @param {string} root 仓库根
 * @returns {string} 代表当前工作区的 tree 对象 SHA（可直接喂给 git archive）
 */
export function worktreeTree(root) {
  const indexFile = join(tmpdir(), `ccm-verify-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: indexFile };
  const run = (args) => {
    const r = spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败: ${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    run(['read-tree', 'HEAD']);
    run(['add', '-A']);
    return run(['write-tree']);
  } finally {
    // tree 对象此时已落进 .git/objects，删掉临时 index 不影响它。
    rmSync(indexFile, { force: true }); // safe-path: 路径由本文件用 tmpdir + pid + 时间戳拼出，非递归删除
  }
}

/** 直接返回该 tree 下 git archive 会打包的文件清单（不含目录条目）。 */
export function shippedFiles(root) {
  const tree = worktreeTree(root);
  const r = spawnSync('sh', ['-c', `git archive --worktree-attributes --format=tar ${tree} | tar t`], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`git archive 失败: ${r.stderr}`);
  return new Set(r.stdout.trim().split('\n').filter((f) => f && !f.endsWith('/')));
}
