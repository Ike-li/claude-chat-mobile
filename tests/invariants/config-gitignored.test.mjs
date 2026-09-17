// tests/invariants/config-gitignored.test.mjs —— 控制面凭据文件不得进版本库
// 守护：CONFIG-03（存放凭据的配置文件必须被 .gitignore 覆盖；本仓是 public 的）
// 测什么：ccm.config.json 与它的两个兄弟形态、以及 .env 系列、workdirs.json，逐个过
//         `git check-ignore`；外加一条反向断言证明这个判据不是恒真
// 不测什么 + 为什么：① 文件内容里有没有真凭据 —— 那是 gitleaks pre-commit 钩子的活，
//         与「这个路径会不会被 git 收进来」是两道独立的闸 ② 历史提交里有没有泄露过 ——
//         那要扫全历史，属一次性审计不属回归测试 ③ 0600 权限 —— 另一条红线（FILE-03）
// 槽位：S1（只读地跑一次 git check-ignore，不写盘）
//
// 【为什么值得一条不变量】docs/hard-rules.md §4.6 自己写着这个缺口：
//   「**没有任何测试或门禁锁住这一条**——config-file.test.mjs 守的是 CONFIG-01/02
//    （源选择与可表达性），全仓无 git check-ignore 类断言。删掉那三行 .gitignore
//    不会让任何东西变红。」
// 三个条件同时成立才配一个编号，这条都占了：① 后果严重——AUTH_TOKEN / VAPID 私钥 /
// ntfy 令牌都在 ccm.config.json 里，而本仓是 public 的；② 失效是静默的——删掉规则之后
// 一切照常，直到某次 `git add -A` 把它收进来；③ 没有别的东西在管它。
//
// 【gitleaks 不是替代品】那道钩子扫的是**内容像不像凭据**，而这里管的是**路径会不会被
// 收进来**。一个 AUTH_TOKEN 恰好没命中 gitleaks 任何规则的配置文件，照样会被提交。
// 两道闸的判据不同，不能互相顶替。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// check-ignore 的退出码：0 = 被忽略，1 = 未被忽略，其它 = git 自己出错。
// 把「git 出错」与「未被忽略」分开报：前者是测试环境坏了，后者才是缺陷，
// 混成一句 assert 会让环境问题看起来像安全回归。
function ignoreStatus(path) {
  const r = spawnSync('git', ['check-ignore', '-q', '--', path], { cwd: REPO, encoding: 'utf8' });
  if (r.error) return { ok: false, reason: `git 无法执行：${r.error.message}` };
  if (r.status === 0) return { ignored: true };
  if (r.status === 1) return { ignored: false };
  return { ok: false, reason: `git check-ignore 异常退出 ${r.status}：${r.stderr}` };
}

test.describe('CONFIG-03: 凭据文件必须被 gitignore 覆盖', () => {
  // 三个形态都要：`.env` 靠 `.env.*` 天然盖住兄弟名，而 ccm.config.json 不行——
  // `ccm.config.json.bak` 不在 `ccm.config.*.json` 的覆盖面内，需要单独一条规则。
  // 这三条正是 hard-rules §4.6 点名的那三行。
  const mustIgnore = [
    'ccm.config.json',        // 主文件：AUTH_TOKEN / VAPID 私钥 / ntfy 令牌都在里面
    'ccm.config.local.json',  // ccm.config.*.json
    'ccm.config.json.bak',    // ccm.config.json.*（编辑器备份、手动改配置时最容易冒出来的那个）
    '.env',                   // 旧格式，同等敏感
    '.env.local',
    '.env.production',
    'workdirs.json',          // 旧版工作区列表：泄露的是本机目录结构
  ];

  for (const path of mustIgnore) {
    test(`${path} 被 .gitignore 覆盖`, () => {
      const r = ignoreStatus(path);
      assert.notEqual(r.ok, false, r.reason);
      assert.equal(r.ignored, true,
        `${path} 没有被 .gitignore 覆盖——本仓是 public 的，一次 git add -A 就会把凭据推上去。`
        + `规则在仓库根 .gitignore，别删。`);
    });
  }

  // 反向锚点：证明上面那些绿不是因为 `git check-ignore` 对什么都返回 0。
  // 缺了这条，一个恒判「已忽略」的环境会让整组测试全绿而毫无保护力。
  test('反向：被跟踪的源文件不得被判成已忽略（证明这个判据不是恒真）', () => {
    for (const tracked of ['app/server.js', 'package.json', '.gitignore']) {
      const r = ignoreStatus(tracked);
      assert.notEqual(r.ok, false, r.reason);
      assert.equal(r.ignored, false, `${tracked} 是被跟踪的源文件，不该判成已忽略`);
    }
  });
});
