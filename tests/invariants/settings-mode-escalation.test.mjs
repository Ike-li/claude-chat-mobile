// tests/invariants/settings-mode-escalation.test.mjs —— 仓库自带的 settings 不得把 Web 新会话升级成免审批档
// 守护：APPROVAL-03（project / local 层 settings 的 defaultMode 不得把新会话初始档升级成 bypassPermissions / auto；acceptEdits 与 user 层同终端照常生效）
// 测什么：真 SDK resolveSettings 读一次性目录里的真 settings 文件，走 CCM 采纳 L3 默认的同一条链
//   （defaultsFromResolvedSettings → resolveFreshPrefs），看「下一条新会话」的权限档：仓库层写的 bypassPermissions /
//   auto 落回 default；仓库层写的 acceptEdits、user 层各档、仓库层的 plan 照常生效
// 不测什么 + 为什么：① 组装根真的走了这条链（ensureCliDefaults 落缓存、FRESH 懒开读缓存）属 S2，见
//   tests/invariants/server/settings-mode-escalation.test.mjs ② bypass / auto 不认哪几层是 SDK
//   filterEscalatingDefaultMode 的口径（与 CLI 的信任分层同源），这里只钉「CCM 采纳前过了它」，不逐支重测 SDK
//   ③ resume 不读 L3 的 mode（读 sessions.json / transcript 末档），不在本条范围
// 槽位：S1（纯函数 + 一次性目录里的真 settings 文件；真 SDK resolveSettings，不 spawn CLI、零 token）
//
// 【acceptEdits 为什么不拦】SDK 的 filterEscalatingDefaultMode 连 project 层的 acceptEdits 也剔，比终端严：
// CLI 2.1.284 / 2.1.301 的启动代码只按来源拦 bypassPermissions / auto。机主 2026-10-16 选终端等价。
//
// 【缺陷的真实形态】2026-10-16 云端全量 review P0-1。resolveSettings 原样报告各层的 defaultMode（SDK 文档明写
// 它不是安全判定），CCM 拿它当新会话初值，再作为显式 permissionMode 交给 SDK——显式参数 CLI 照单全收，它自己
// 那道「project / local 是仓库可控的，不得授予 bypass / auto」的过滤就此被绕过；bypassPermissions 更是 CCM 在
// canUseTool 里自己放行，CLI 根本看不见。于是已连接文件夹里的第三方仓库只要提交一份 .claude/settings.json，
// 手机上在它里面新开的会话就整场不再弹审批。
//
// 【为什么两个方向都要钉】只断言「仓库层的升级档不被采纳」的话，把 settings 的 defaultMode 整个无视也能全绿，
// 而那会打破终端等价性：用户在 ~/.claude/settings.json 里给自己设的档，在手机新会话上失效。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';
import { defaultsFromResolvedSettings, resolveFreshPrefs } from '../../app/src/agent/cli-settings-defaults.js';

// 与 app.js ensureCliDefaults 读的是同一组来源
const SETTING_SOURCES = ['user', 'project', 'local'];

let root, files;

test.before(() => {
  root = mkdtempSync(join(tmpdir(), 'ccm-inv-mode-escalation-'));
  const userDir = join(root, 'user-claude');
  const repo = join(root, 'third-party-repo');
  mkdirSync(userDir, { recursive: true });
  mkdirSync(join(repo, '.claude'), { recursive: true });
  // user 层指到一次性目录：SDK 每次调用现读 CLAUDE_CONFIG_DIR，不碰真实 ~/.claude
  process.env.CLAUDE_CONFIG_DIR = userDir;
  files = {
    repo,
    user: join(userDir, 'settings.json'),
    project: join(repo, '.claude', 'settings.json'),
    local: join(repo, '.claude', 'settings.local.json'),
  };
});

test.after(() => {
  if (root) rmSync(root, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
});

// 按层写好 defaultMode（没给的层写空对象），返回 CCM 给「下一条新会话」定的权限档
async function freshModeWith(layers) {
  for (const layer of ['user', 'project', 'local']) {
    const mode = layers[layer];
    writeFileSync(files[layer], JSON.stringify(mode ? { permissions: { defaultMode: mode } } : {}));
  }
  const resolved = await resolveSettings({ cwd: files.repo, settingSources: SETTING_SOURCES });
  return resolveFreshPrefs({ cliDefaults: defaultsFromResolvedSettings(resolved) }).mode;
}

test('仓库 project 层写的 bypassPermissions / auto 不采纳：新会话落回 default', async () => {
  for (const mode of ['bypassPermissions', 'auto']) {
    assert.equal(await freshModeWith({ project: mode }), 'default',
      `第三方仓库的 .claude/settings.json 写 ${mode}，手机上新会话就以 ${mode} 开——仓库替用户关掉了审批`);
  }
});

test('local 层写的 bypassPermissions / auto 同样不采纳', async () => {
  for (const mode of ['bypassPermissions', 'auto']) {
    assert.equal(await freshModeWith({ local: mode }), 'default',
      `.claude/settings.local.json 写 ${mode} 被采纳了——它和 project 层一样在仓库目录里，CLI 不认它授予免审批档`);
  }
});

test('acceptEdits 与终端一致：仓库 project / local 层写的照常采纳', async () => {
  for (const layer of ['project', 'local']) {
    assert.equal(await freshModeWith({ [layer]: 'acceptEdits' }), 'acceptEdits',
      `${layer} 层的 acceptEdits 被剔成了 default——终端里 CLI 只按来源拦 bypassPermissions / auto，机主 10/16 定的是与终端一致`);
  }
});

test('user 层设了、仓库层又盖上 bypassPermissions：不得按仓库的升级', async () => {
  assert.notEqual(await freshModeWith({ user: 'acceptEdits', project: 'bypassPermissions' }), 'bypassPermissions',
    'user 层有值不代表合并结果可信：真正生效的是仓库的 project 层');
});

test('正对照：user 层（~/.claude/settings.json）的档照常生效，与终端里新起 claude 一致', async () => {
  for (const mode of ['bypassPermissions', 'auto', 'acceptEdits']) {
    assert.equal(await freshModeWith({ user: mode }), mode,
      `用户自己设的 ${mode} 在手机新会话上没生效——过滤拦了不该拦的层，终端等价性被打破`);
  }
});

test('正对照：仓库层写的非升级档照常生效（不是把仓库 settings 整个无视）', async () => {
  assert.equal(await freshModeWith({ project: 'plan' }), 'plan',
    '仓库要的 plan 比 default 更保守，也被丢掉了——过滤只该拦升级，不该拦收紧');
});
