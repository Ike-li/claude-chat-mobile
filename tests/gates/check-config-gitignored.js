#!/usr/bin/env node
// tests/gates/check-config-gitignored.js —— 凭据文件必须被 .gitignore 覆盖
// 守护：CONFIG-03（存放凭据的配置文件必须被 .gitignore 覆盖）
//
// 【为什么有这条闸】docs/hard-rules.md §4.6 一直写着这个缺口：ccm.config.json 里装着
// AUTH_TOKEN、VAPID 私钥、ntfy 令牌，而本仓是 **public** 的，可是删掉 .gitignore 里那三行
// 不会让任何东西变红。失效是静默的——删掉之后一切照常，直到某次 `git add -A` 把它收进来。
//
// 【为什么是门禁而不是 tests/invariants/ 下的用例】它要跑 git。而 `npm run test:docker` 会跑
// `test:invariants`，容器里从 **linked worktree**（维护者的常驻检出位是 `../claude-chat-mobile-<分支>`）
// 启动时，`.git` 是一个指向宿主机路径的指针文件，容器内解析不到，`git check-ignore` 直接 128。
// 那会让整个容器全量档在测到任何代码之前就失败。CLAUDE.md 已经为 `inventory:check` 记过同型的坑
// （「test:docker 不含 check：inventory:check 要 git ls-files……」），这里是同一条纪律：
// **依赖 git 元数据的检查只能待在 check 链上**，而 check 本来就只在宿主机跑。
//
// 「守护：CONFIG-03」声明行放在文件头部而非 tests/invariants/ 下的用例里，正是
// tests/gates/check-invariant-ids.js 头注里「有些不变量由门禁守而非用例守」的那种情况。
//
// 【gitleaks 不是替代品】那道 pre-commit 钩子扫的是「**内容**像不像凭据」，这条管的是
// 「**路径**会不会被收进来」。一个 AUTH_TOKEN 恰好没命中 gitleaks 任何规则的配置文件，
// 照样会被提交。两道闸判据不同，不能互顶。

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// 三个形态都要查：`.env` 靠 `.env.*` 天然盖住兄弟名，而 ccm.config.json 不行——
// `ccm.config.json.bak`（编辑器备份、手改配置时最容易冒出来的那个）不在 `ccm.config.*.json`
// 的覆盖面内，需要单独一条规则。三条各有各的必要性，合并成一条断言就看不出是哪条被删了。
const MUST_IGNORE = [
  'ccm.config.json',        // 主文件：AUTH_TOKEN / VAPID 私钥 / ntfy 令牌都在里面
  'ccm.config.local.json',  // ccm.config.*.json
  'ccm.config.json.bak',    // ccm.config.json.*
  '.env',                   // 旧格式，同等敏感
  '.env.local',
  '.env.production',
  'workdirs.json',          // 旧版工作区列表：泄露的是本机目录结构
];

// 反向锚点：证明这个判据不是恒真。少了它，一个恒返回 0 的 git 环境会让整条闸全绿而毫无保护力。
const MUST_NOT_IGNORE = ['app/server.js', 'package.json', '.gitignore'];

// check-ignore 的退出码：0 = 被忽略，1 = 未被忽略，其它 = git 自己出错。
// 「git 出错」与「未被忽略」必须分开报：前者是环境问题，后者才是缺陷，混成一句会让
// 环境问题看起来像安全回归。
function ignoreStatus(path) {
  const r = spawnSync('git', ['check-ignore', '-q', '--', path], { cwd: REPO, encoding: 'utf8' });
  if (r.error) return { err: `git 无法执行：${r.error.message}` };
  if (r.status === 0) return { ignored: true };
  if (r.status === 1) return { ignored: false };
  return { err: `git check-ignore 异常退出 ${r.status}：${(r.stderr || '').trim()}` };
}

const problems = [];

for (const path of MUST_IGNORE) {
  const s = ignoreStatus(path);
  if (s.err) problems.push(`${path}：${s.err}`);
  else if (!s.ignored) {
    problems.push(`${path} 没有被 .gitignore 覆盖——本仓是 public 的，一次 \`git add -A\` 就会把凭据推上去。`
      + `规则在仓库根 .gitignore，别删。`);
  }
}

for (const path of MUST_NOT_IGNORE) {
  const s = ignoreStatus(path);
  if (s.err) problems.push(`${path}：${s.err}`);
  else if (s.ignored) {
    problems.push(`${path} 是被跟踪的源文件，却被判成已忽略——判据失真了，上面那几条的绿不可信`);
  }
}

if (problems.length) {
  console.error('❌ CONFIG-03：凭据文件的 gitignore 覆盖面检查未通过\n');
  for (const p of problems) console.error(`  · ${p}`);
  process.exit(1);
}

console.log(`凭据文件 gitignore 覆盖 OK（CONFIG-03：必忽略 ${MUST_IGNORE.length} 项 · 反向锚点 ${MUST_NOT_IGNORE.length} 项）`);
