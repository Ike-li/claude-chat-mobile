#!/usr/bin/env node
// tests/gates/check-shell-pitfalls.js —— 两个在本仓库真实咬过人的 shell 陷阱
//
// 【为什么需要机械闸】这两条都不是"写得不够仔细"，而是**症状与原因毫无关联、且本地验证会给出
// 反向信号**的那种。2026-09-12 一次发版里两条都踩了，第一条还是在刚修完它、并写下详细注释
// 解释它之后，紧接着的下一个函数里又踩了一次。靠注释和"注意点"挡不住，只能扫。
//
// ── 陷阱 1：pipefail 下「读够就退出」的下游命令 ──────────────────────────
// 下游读够了就退出，上游命令随即收到 SIGPIPE 而非 0 退出。脚本若开了 `set -o pipefail`，
// 整个管道被判失败。
// 实测后果：release.sh 的版本号推导把 23 个 feat 判成 patch；RESUMING 判据永不触发，
// 把一个已经推出去的版本反复 bump（1.8.0 → 1.8.1 → 1.9.0）。
// 两次都因为「在交互 shell 里手动验证」而看到了正确结果 —— 交互 shell 没有 pipefail。
//
// 这一类有两个入口，**症状相同但改法相反**，所以分开扫：
//   ① `grep -q` —— 只用退出码、不产出。症状是**命中反而当没命中**，判据恒假。
//      改法：`X="$(… | grep -c … || true)"` 再比数量。
//      ★ 这一类**不豁免** `|| true`：补上它只会让判据恒真，从"永远不命中"变成"永远命中"。
//   ② `head` / `grep -m` —— 取的是输出。
//      改法：补 `|| true` 就够了（命令替换照样拿得到 stdout），或换成读完整个输入的
//      写法（`awk 'NR==1'`）。所以这一类**豁免**已经写了 `|| true` 的行。
// tail 不在此列：它必须读到 EOF 才知道最后一行是什么，不会提前退出（已实测）。
// 2026-09-13 扩到 ② —— 此前只认 grep -q，而 `| head -1` 的后果与它一模一样。
//
// ── 陷阱 2：`$VAR` 后紧跟非 ASCII 字符 ───────────────────────────────────
// `"PR #$PR（更新）"` 里 bash 会把全角 `（` 的首字节并进变量名，查的是 `PR\xEF…`。
// 在 `set -u` 下直接 `unbound variable` 中止；没有 set -u 时则静默展开成空串。
// 本仓库的脚本注释、提示、错误文案全是中文，这个组合到处都是。
// 改法：`${VAR}` 显式界定。
//
// ── 扫描面 2026-09：GitHub Actions workflow 的 `run:` 块 ──────────────────
// 此前只扫 *.sh，.github/workflows/*.yml 里的 `run:` 步骤完全不在扫描面内——而 GHA 默认
// shell 是 `bash --noprofile --norc -eo pipefail {0}`，**pipefail 是隐式默认值**，不会像
// .sh 脚本那样以 `set -o pipefail` 字面量出现在文本里；本仓两个 workflow 文件都没有任何
// `shell:` 覆盖（已核实），所以所有 run 块一律按 pipefail=true 检查，不需要（也无法用简单
// 正则）判断 shell 覆盖。陷阱 2（$VAR 紧跟非 ASCII）与 pipefail 无关，同一套判据直接复用。
//
// 不引入 YAML 依赖（与 check-container-config-isolation.js 的既有原则一致）：手写一个只认
// 两种形态的小型提取器——单行 `run: <cmd>` 与块标量 `run: |`（含 chomping 修饰符 -/+ 与
// `>` 折叠形态），够覆盖本仓两个 workflow 文件的实际写法。
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 从 GHA workflow YAML 文本里提取所有 `run:` 步骤的命令原文。
 * @returns {{startLine: number, text: string}[]} startLine 是命令文本第一行在原文件里的
 *   行号（1-based）——单行形式就是 `run:` 那一行；块标量形式是内容的第一行，不是 `run: |` 那行。
 */
export function extractWorkflowRunBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:-\s+)?run:\s*(.*)$/);
    if (!m) continue;
    const rest = m[1];
    if (!/^[|>][-+]?\s*(#.*)?$/.test(rest.trim())) {
      // 单行形式：run: <cmd>（可能带 # 行内注释，这里不剥——命令字符串里出现 # 很少见，
      // 剥注释要处理引号内 # 不算注释这种复杂度，超出这个小工具的必要性）
      if (rest.trim()) blocks.push({ startLine: i + 1, text: rest });
      continue;
    }
    // 块标量：内容首行确定缩进基准，后续行只要缩进 ≥ 基准（或是空行）就算内容的一部分
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;
    if (j >= lines.length) break;
    const baseIndent = lines[j].match(/^\s*/)[0].length;
    const bodyLines = [];
    const bodyStartLine = j + 1;
    while (j < lines.length) {
      const line = lines[j];
      if (line.trim() !== '' && line.match(/^\s*/)[0].length < baseIndent) break;
      bodyLines.push(line.length >= baseIndent ? line.slice(baseIndent) : line);
      j++;
    }
    blocks.push({ startLine: bodyStartLine, text: bodyLines.join('\n') });
    i = j - 1;
  }
  return blocks;
}

// `| grep -q` / `| grep -qxF` 等：短横线后的任意标志组合里含 q
const PIPED_GREP_Q = /\|\s*grep\b[^|;&\n]*?\s-[a-zA-Z]*q/;
// 同一个 SIGPIPE 陷阱的另一批入口（取输出型）：`| head`、`| grep -m1`、`| grep --max-count=1`
const PIPED_EARLY_EXIT = /\|\s*head\b|\|\s*grep\b[^|;&\n]*?(\s-[a-zA-Z]*m|\s--max-count)/;
// 取输出型已经接住了管道退出码就不算问题 —— 见文件头 ② 的说明
const HAS_PIPE_FALLBACK = /\|\|\s*(true|:|echo)\b/;
// `$NAME` 紧跟一个非 ASCII 字符（中文标点/汉字都算）。`${NAME}` 形态不匹配，因为 } 是 ASCII。
// 用 \P{ASCII} 而不是 [^\x00-\x7F]：后者被 eslint 的 no-control-regex 拒（它含 \x00）。
const VAR_THEN_NONASCII = /\$[A-Za-z_][A-Za-z0-9_]*\P{ASCII}/u;

/** 对一段已知起始行号、已知是否 pipefail 的 shell 文本逐行跑三条判据，problems 里追加发现。 */
function scanShellText({ problems, at, text, hasPipefail }) {
  text.split('\n').forEach((line, i) => {
    const loc = typeof at === 'function' ? at(i) : `${at}:${i + 1}`;
    // 注释行不算：它们不会被执行
    if (/^\s*#/.test(line)) return;
    if (hasPipefail && PIPED_GREP_Q.test(line)) {
      problems.push(`${loc} pipefail 下的 \`| grep -q\` —— 命中即 SIGPIPE，判据会恒假。`
        + `改用 \`X="$(… | grep -c … || true)"\` 再比数量。\n    ${line.trim()}`);
    }
    if (hasPipefail && PIPED_EARLY_EXIT.test(line) && !HAS_PIPE_FALLBACK.test(line)) {
      problems.push(`${loc} pipefail 下的 \`| head\` / \`| grep -m\` —— 读够就退出，上游收 SIGPIPE，`
        + `整条管道判失败。这一类取的是输出，补 \`|| true\` 就够了（命令替换照样拿得到 stdout），`
        + `或换成读完整个输入的写法（\`awk 'NR==1'\`）。\n    ${line.trim()}`);
    }
    if (VAR_THEN_NONASCII.test(line)) {
      problems.push(`${loc} \`$VAR\` 后紧跟非 ASCII —— bash 会把它并进变量名（set -u 下直接中止）。`
        + `改用 \${VAR}。\n    ${line.trim()}`);
    }
  });
}

// rootDir 缺省不传：单测传临时目录夹具（含一份 mini git 仓库），CLI 入口用真实 ROOT。
// git ls-files 需要一个真实仓库——单测夹具因此各自 git init + add，见测试文件说明。
export function checkShellPitfalls({ rootDir = ROOT } = {}) {
  const shFiles = execFileSync('git', ['ls-files', '*.sh'], { cwd: rootDir, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const workflowFiles = execFileSync('git', ['ls-files', '.github/workflows/*.yml'], { cwd: rootDir, encoding: 'utf8' })
    .split('\n').filter(Boolean);

  const problems = [];
  for (const rel of shFiles) {
    const text = readFileSync(join(rootDir, rel), 'utf8');
    const hasPipefail = /set\s+-[a-zA-Z]*o\s+pipefail|set\s+-o\s+pipefail/.test(text);
    scanShellText({ problems, at: rel, text, hasPipefail });
  }

  let workflowRunSteps = 0;
  for (const rel of workflowFiles) {
    const text = readFileSync(join(rootDir, rel), 'utf8');
    for (const block of extractWorkflowRunBlocks(text)) {
      workflowRunSteps += 1;
      // GHA 默认 shell 隐式 -eo pipefail（已核实本仓两个 workflow 均无 shell: 覆盖），恒 true。
      scanShellText({
        problems, text: block.text, hasPipefail: true,
        at: i => `${rel}:${block.startLine + i}`,
      });
    }
  }

  return { rootDir, shFiles, workflowFiles, workflowRunSteps, problems };
}

export function formatShellPitfalls(result) {
  if (result.problems.length > 0) {
    return `shell 陷阱检查失败（${result.problems.length} 处）：\n`
      + result.problems.map(p => `- ${p}`).join('\n');
  }
  return `shell 陷阱检查 OK（扫了 ${result.shFiles.length} 个 .sh · `
    + `${result.workflowFiles.length} 个 workflow（${result.workflowRunSteps} 个 run 步骤））`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = checkShellPitfalls();
  const output = formatShellPitfalls(result);
  if (result.problems.length > 0) {
    console.error(output);
    process.exit(1);
  }
  console.log(output);
}
