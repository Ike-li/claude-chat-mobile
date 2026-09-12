#!/usr/bin/env node
// tests/gates/check-shell-pitfalls.js —— 两个在本仓库真实咬过人的 shell 陷阱
//
// 【为什么需要机械闸】这两条都不是"写得不够仔细"，而是**症状与原因毫无关联、且本地验证会给出
// 反向信号**的那种。2026-09-12 一次发版里两条都踩了，第一条还是在刚修完它、并写下详细注释
// 解释它之后，紧接着的下一个函数里又踩了一次。靠注释和"注意点"挡不住，只能扫。
//
// ── 陷阱 1：pipefail 下的 `… | grep -q` ──────────────────────────────────
// grep -q 命中第一条就退出，上游命令随即收到 SIGPIPE 而非 0 退出。脚本若开了 `set -o pipefail`，
// 整个管道被判失败 —— **命中反而当没命中**，判据恒假。
// 实测后果：release.sh 的版本号推导把 23 个 feat 判成 patch；RESUMING 判据永不触发，
// 把一个已经推出去的版本反复 bump（1.8.0 → 1.8.1 → 1.9.0）。
// 两次都因为「在交互 shell 里手动验证」而看到了正确结果 —— 交互 shell 没有 pipefail。
// 改法：`X="$(… | grep -c … || true)"` 然后比较数量（grep -c 读完整个输入，不产生 SIGPIPE）。
//
// ── 陷阱 2：`$VAR` 后紧跟非 ASCII 字符 ───────────────────────────────────
// `"PR #$PR（更新）"` 里 bash 会把全角 `（` 的首字节并进变量名，查的是 `PR\xEF…`。
// 在 `set -u` 下直接 `unbound variable` 中止；没有 set -u 时则静默展开成空串。
// 本仓库的脚本注释、提示、错误文案全是中文，这个组合到处都是。
// 改法：`${VAR}` 显式界定。
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const files = execFileSync('git', ['ls-files', '*.sh'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean);

// `| grep -q` / `| grep -qxF` 等：短横线后的任意标志组合里含 q
const PIPED_GREP_Q = /\|\s*grep\b[^|;&\n]*?\s-[a-zA-Z]*q/;
// `$NAME` 紧跟一个非 ASCII 字符（中文标点/汉字都算）。`${NAME}` 形态不匹配，因为 } 是 ASCII。
// 用 \P{ASCII} 而不是 [^\x00-\x7F]：后者被 eslint 的 no-control-regex 拒（它含 \x00）。
const VAR_THEN_NONASCII = /\$[A-Za-z_][A-Za-z0-9_]*\P{ASCII}/u;

const problems = [];
for (const rel of files) {
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const hasPipefail = /set\s+-[a-zA-Z]*o\s+pipefail|set\s+-o\s+pipefail/.test(text);
  text.split('\n').forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    // 注释行不算：它们不会被执行
    if (/^\s*#/.test(line)) return;
    if (hasPipefail && PIPED_GREP_Q.test(line)) {
      problems.push(`${at} pipefail 下的 \`| grep -q\` —— 命中即 SIGPIPE，判据会恒假。`
        + `改用 \`X="$(… | grep -c … || true)"\` 再比数量。\n    ${line.trim()}`);
    }
    if (VAR_THEN_NONASCII.test(line)) {
      problems.push(`${at} \`$VAR\` 后紧跟非 ASCII —— bash 会把它并进变量名（set -u 下直接中止）。`
        + `改用 \${VAR}。\n    ${line.trim()}`);
    }
  });
}

if (problems.length > 0) {
  console.error(`shell 陷阱检查失败（${problems.length} 处）：\n` + problems.map(p => `- ${p}`).join('\n'));
  process.exit(1);
}
console.log(`shell 陷阱检查 OK（扫了 ${files.length} 个 .sh）`);
