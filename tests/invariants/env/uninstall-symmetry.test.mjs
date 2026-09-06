// tests/invariants/env/uninstall-symmetry.test.mjs —— 卸载对称性：删干净【且】没多删
// 守护：DIST-01（uninstall 只删产品自己写下的白名单，永删不到 ~/.claude/projects、~/.cloudflared、manifest 外的 unit、工作区代码）
// 覆盖：整树快照差集（删除面 == 预期集）+ 幸存面逐字节相等 + 真 CLI 在复制出的仓库根上跑 --purge --yes
// 槽位：环境级（一次性 HOME + 一次性仓库根 + 一次性工作区）
//
// ⚠ 为什么必须进容器（`npm run test:invariants:env` 不在宿主机白名单里）：
//   本文件的隔离**依赖被测代码正确性**——`createUninstaller` 若不认注入的 home/root/appPath
//   而回落 `homedir()` / `REPO_ROOT` / `/Applications/CCM.app`，进程内的 rmSync 就打在真实家目录上。
//   这正是 2026-08-02 删树事故的形状：被改坏的恰恰是算删除路径的那段代码。
//   容器里 HOME 是一次性目录，这道防线不依赖任何代码正确性。
//
// 为什么用整树差集而不是逐项列「谁该活下来」：
//   列举式只能抓住我想到的那几项。一个「多删了 ~/Documents」的实现能让逐项断言全绿。
//   差集反过来——**任何**不在预期删除集里的消失或改动都算失败，包括我没想到的。
//   §12 原话：只断言删干净是半条测试，一个「什么都删」的实现能让它全绿。
//
// 不测什么 + 为什么：
//  ① launchd plist 的真实删除 —— 归 service.js，真跑会 bootout 宿主机生产 unit。
//     这里 stub 掉，只断言「orchestrator 点了哪些 unit 的名」（manifest 外的绝不点名）。
//  ② 桥的 settings.json 恢复细节 —— 归 statusline/hooks-bridge-setup 自己的测试；
//     本文件只钉「桥条目以外的内容没被动过」。
//  ③ 数据根白名单逐项删 / 漂移拒绝 / SIGTERM 语义 —— 已在 tests/unit/uninstall-cli.test.mjs。
//     本文件不重测那些，只补它缺的那一半：**没多删**。
//
// 变异现状（2026-09-05，两个文件合跑 scripts/uninstall.js：杀 55/76）。存活的 21 个已逐条看过，
// 分三类，都是**有意不追**——重跑变异看到它们时不必再判一遍：
//  · 等价变异：`force: true→false`（路径已 existsSync 过）、`?? → ||`（值非 array 即 null）、
//    safeSpawn 的防御性归一、`residueOkAll &&= → ||=`（只改一行报告，无文件系统差异）。
//  · 纯文案/非 darwin 分支：dry-run 的偏好域探测措辞、Linux 上报不报 desktop/build 产物、
//    Linux 上删 ~/Library/Logs（该目录不存在）、`.DS_Store` 清理。
//  · 要新夹具才够得着，damage 不匹配成本：桥 status「退出非 0 却吐了合法 JSON」的 fail-safe 分支
//    （需 stub 桥脚本，而本文件刻意跑真桥）；WORK_DIRS_FILE 这一档（旧路径）；`isTty` 需要 PTY。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  readlinkSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createUninstaller, DATA_FILE_WHITELIST } from '../../../scripts/uninstall.js';

const REPO = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

// ---------------------------------------------------------------------------
// 整树快照：路径 → 内容指纹。目录记成 `path/` 且值恒为 'DIR'（空目录的消失也要被看见）；
// symlink 记 link 目标而不 follow（follow 会把「删了链接」和「删了目标」混为一谈）。
// ---------------------------------------------------------------------------
function snapshot(root) {
  const out = new Map();
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = join(dir, e.name);
      const key = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out.set(key, `LINK:${readlinkSync(abs)}`);
      else if (e.isDirectory()) { out.set(`${key}/`, 'DIR'); walk(abs, key); }
      else out.set(key, createHash('sha256').update(readFileSync(abs)).digest('hex'));
    }
  };
  walk(root, '');
  return out;
}

function diff(before, after) {
  const removed = [], changed = [], added = [];
  for (const [k, v] of before) {
    if (!after.has(k)) removed.push(k);
    else if (after.get(k) !== v) changed.push(k);
  }
  for (const k of after.keys()) if (!before.has(k)) added.push(k);
  return { removed: removed.sort(), changed: changed.sort(), added: added.sort() };
}

const w = (p, body) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };

// ---------------------------------------------------------------------------
// 沙箱：一棵包含「产品的东西」与「绝不能碰的东西」的完整树。
// 三者（home / root / work）同在一个 mkdtemp 下，所以一次快照就覆盖全部伤害域。
// ---------------------------------------------------------------------------
function makeSandbox() {
  const box = mkdtempSync(join(tmpdir(), 'ccm-uninstall-sym-'));
  const home = join(box, 'home');
  const root = join(box, 'root');
  const work = join(box, 'work', 'repo-a');       // 经内联 WORKDIRS 声明
  const primary = join(box, 'work', 'primary');   // 经 env.WORK_DIR 声明
  const fromConfig = join(box, 'work', 'cfg-wd'); // 经 ccm.config.json 的 WORK_DIR 声明（装机向导写的就是它）
  const viaEnvList = join(box, 'work', 'env-list'); // 经 WORK_DIRS env 声明（优先级最高的那一档）
  const data = join(root, 'data');            // 不设 CCM_DATA_DIR，走 join(root,'data') 的生产默认
  const appPath = join(box, 'Applications', 'CCM.app');

  // —— 绝不能碰的：CLI transcript、隧道凭据、别人的 launchd unit 与日志 ——
  w(join(home, '.claude', 'projects', 'ccm-proj', 'session-1.jsonl'), '{"type":"user"}\n');
  w(join(home, '.claude', 'projects', 'other-proj', 'deep', 'nested.jsonl'), '{"type":"assistant"}\n');
  w(join(home, '.cloudflared', 'config.yml'), 'tunnel: abc\n');
  w(join(home, '.cloudflared', 'abc.json'), '{"AccountTag":"x"}\n');
  w(join(home, 'Library', 'LaunchAgents', 'com.ccm.tunnel.plist'), '<plist/>');   // 手工装的，不在 manifest
  w(join(home, 'Library', 'LaunchAgents', 'com.other.app.plist'), '<plist/>');
  w(join(home, 'Library', 'Logs', 'ccm-tunnel.log'), 'tunnel log\n');             // 同上，不是产品装的
  w(join(home, 'Library', 'Logs', 'SomeOtherApp', 'app.log'), 'other\n');
  w(join(work, 'src', 'index.js'), 'export const a = 1;\n');
  w(join(work, '.ccm-uploads', 'photo.png'), 'PNG-BYTES');                        // 只报不删
  w(join(primary, 'src', 'main.js'), 'export const b = 2;\n');
  w(join(primary, '.ccm-uploads', 'shot.png'), 'PNG-BYTES-2');                    // 同上，走 env.WORK_DIR
  w(join(fromConfig, '.ccm-uploads', 'cfg.png'), 'PNG-BYTES-3');                  // 同上，走文件里的 WORK_DIR
  w(join(viaEnvList, '.ccm-uploads', 'env.png'), 'PNG-BYTES-4');                  // 同上，走 WORK_DIRS env
  w(join(root, 'package.json'), '{"name":"fake-repo","type":"module"}\n');        // 仓库自己的文件
  w(join(root, 'app', 'src', 'keep.js'), '// 仓库代码\n');

  // —— 产品自己写下的：purge 该删的 ——
  for (const f of DATA_FILE_WHITELIST) w(join(data, f), '{}');
  w(join(data, 'service-install.json'), JSON.stringify({
    schemaVersion: 1, labelPrefix: 'com.ccm', units: { server: { label: 'com.ccm.server' } },
  }));
  w(join(data, 'worktree-settings', 'aa.json'), '{}');
  w(join(root, 'ccm.config.json'), JSON.stringify({ AUTH_TOKEN: 'x', WORK_DIR: fromConfig, WORKDIRS: [work] }));
  w(join(root, '.env'), 'AUTH_TOKEN=x\n');
  w(join(root, 'workdirs.json'), JSON.stringify([work]));
  w(join(home, 'Library', 'Logs', 'ccm-server.log'), 'server log\n');             // manifest 内 unit 的日志
  w(join(home, 'Library', 'Logs', 'ccm-server.log.0.gz'), 'rotated');
  w(join(appPath, 'Contents', 'MacOS', 'ccm-menubar'), 'MACH-O');
  w(join(root, 'desktop', 'build', 'CCM.app', 'Contents', 'Info.plist'), '<plist/>'); // 只报不删

  // —— 数据根里用户自己放的：不在白名单 ⇒ 必须保留 ——
  w(join(data, 'approval-requests.json.bak-手动备份'), '{"mine":true}');
  w(join(data, '我的备注.md'), '# 别删我\n');

  return { box, home, root, work, primary, fromConfig, viaEnvList, data, appPath };
}

// settings.json 里【用户自己的】条目：桥装完再卸之后必须原样还在。
function seedSettings(home) {
  const p = join(home, '.claude', 'settings.json');
  w(p, JSON.stringify({
    statusLine: { type: 'command', command: 'bash /tmp/my-own-statusline.sh', refreshInterval: 60 },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo my-own-hook' }] }] },
    model: 'opus',
  }, null, 2));
  return p;
}

function installBridges(home, env) {
  for (const script of ['statusline-bridge-setup.js', 'hooks-bridge-setup.js']) {
    const r = spawnSync(process.execPath, [join(REPO, 'scripts', script), 'install'], { encoding: 'utf8', env });
    assert.equal(r.status, 0, `${script} install 应成功：${r.stderr}${r.stdout}`);
  }
}

// spawn 路由：桥脚本真跑（HOME 已隔离），service.js / defaults / pgrep 一律 stub
// ——真跑前者会 launchctl bootout 宿主机生产 unit，后者会动真实偏好域、并 SIGTERM 到真实进程。
function makeSpawn(env, seenUnits) {
  return (cmd, args) => {
    if (cmd === 'defaults' || cmd === 'pgrep') return { status: 1, stdout: '', stderr: '' };
    if (basename(String(args?.[0] ?? '')) === 'service.js') {
      const rest = args.slice(1);
      seenUnits.push(rest.join(' '));
      return { status: 0, stdout: `${JSON.stringify({ ok: true, unit: rest[1], action: 'uninstalled' })}\n`, stderr: '' };
    }
    return spawnSync(cmd, args, { encoding: 'utf8', env });
  };
}

function runPurge(sb, { purge = true, dryRun = false, bare = false, envOverrides = {} } = {}) {
  const env = { ...process.env, HOME: sb.home, USERPROFILE: sb.home };
  delete env.CCM_DATA_DIR;   // 让 dataDir 走 join(root,'data') 的生产默认解析
  // 先把三个工作区 env 全清掉，再按 overrides 显式设——继承宿主机/preload 的残留值会让
  // 「无 env 时回落到文件」那几条用例静默失效（env 里本来就有值，压根没走回落分支）。
  for (const k of ['WORK_DIR', 'WORK_DIRS', 'WORK_DIRS_FILE']) delete env[k];
  for (const [k, v] of Object.entries({ WORK_DIR: sb.primary, ...envOverrides })) {
    if (v !== undefined) env[k] = v;
  }
  const settingsPath = seedSettings(sb.home);
  installBridges(sb.home, env);

  const before = snapshot(sb.box);
  const seenUnits = [];
  const lines = [];
  const u = createUninstaller({
    home: sb.home, root: sb.root, platform: 'darwin', env,
    spawn: makeSpawn(env, seenUnits), appPath: sb.appPath,
    kill: () => { throw new Error('pgrep 已 stub 成无进程，不该走到 kill'); },
    sleep: () => {},
    out: line => lines.push(line),
  });
  const result = bare ? u.run() : u.run({ purge, dryRun });   // bare 专测「一个参数都不传」的缺省方向
  return { before, after: snapshot(sb.box), result, seenUnits, lines, settingsPath, env };
}

// ---------------------------------------------------------------------------

let sb;
test.beforeEach(() => { sb = makeSandbox(); });
test.afterEach(() => rmSync(sb.box, { recursive: true, force: true })); // safe-rm: mkdtemp 一次性目录

test('--purge 的删除面恰好等于预期集：多删一项就红', () => {
  const { before, after, result, lines } = runPurge(sb);
  assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2));

  const rel = p => p.slice(sb.box.length + 1);
  const expected = [
    // 数据根白名单（文件 + worktree-settings 整目录），目录本身因有未识别内容而保留
    ...DATA_FILE_WHITELIST.map(f => rel(join(sb.data, f))),
    rel(join(sb.data, 'worktree-settings')) + '/',
    rel(join(sb.data, 'worktree-settings', 'aa.json')),
    // 仓库根配置文件
    ...['ccm.config.json', '.env', 'workdirs.json'].map(f => rel(join(sb.root, f))),
    // 受管 unit 的日志（含轮转产物）
    ...['ccm-server.log', 'ccm-server.log.0.gz'].map(f => rel(join(sb.home, 'Library', 'Logs', f))),
    // /Applications/CCM.app（注入到沙箱内）
    rel(sb.appPath) + '/',
    rel(join(sb.appPath, 'Contents')) + '/',
    rel(join(sb.appPath, 'Contents', 'MacOS')) + '/',
    rel(join(sb.appPath, 'Contents', 'MacOS', 'ccm-menubar')),
  ].sort();

  const d = diff(before, after);
  // 桥装下的 ~/.claude/ccm 整棵在 before 里，卸载后应全部消失——它们由桥自己创建，
  // 逐个列名字等于把 fixture 焊死在桥的内部布局上，所以按前缀归并后再比。
  const bridgeResidue = d.removed.filter(p => p.startsWith('home/.claude/ccm'));
  assert.ok(bridgeResidue.includes('home/.claude/ccm/'), `~/.claude/ccm 应整目录移除，实际：${JSON.stringify(d.removed)}`);

  assert.deepEqual(
    d.removed.filter(p => !p.startsWith('home/.claude/ccm')),
    expected,
    '删除面与预期不符。多出来的项 = 越界删除（先确认那是不是产品自己写下的）；'
    + '少掉的项 = 该删没删。改这张表前先想清楚新增的那一项是谁写下的。',
  );
  assert.deepEqual(d.changed, ['home/.claude/settings.json'],
    'purge 只应改动 settings.json 一处（桥条目回收），别的文件被改写都是越界');
  assert.deepEqual(d.added, [], '卸载不该留下新文件（临时文件没清干净也算）');

  // .ccm-uploads 走「只报不删」，必须在输出里点名——不报的话用户以为已经卸干净了。
  // 两条声明路径都要报到：WORK_DIR（主工作区）与内联 WORKDIRS。
  // 用 includes 而不是拼正则：路径里有 mkdtemp 的随机段，手工转义出错时表现为「断言恒不匹配」，
  // 看起来和「功能真没实现」一模一样（本文件第一版就在这里绕了一圈）。
  const text = lines.join('\n');
  assert.ok(text.includes(join(sb.work, '.ccm-uploads')),
    `内联 WORKDIRS 里的工作区上传目录必须报告，实际输出：\n${text}`);
  assert.ok(text.includes(join(sb.primary, '.ccm-uploads')),
    'WORK_DIR 主工作区的上传目录必须报告——单工作区是最常见形态，漏它等于这段报告形同虚设');
});

test('~/.claude/projects 与 ~/.cloudflared 逐字节不变（不是「还在」，是「没被改过」）', () => {
  const { before, after } = runPurge(sb);
  for (const guarded of ['home/.claude/projects', 'home/.cloudflared']) {
    const keys = [...before.keys()].filter(k => k.startsWith(`${guarded}/`) || k === `${guarded}/`);
    assert.ok(keys.length >= 3, `夹具本身要有内容，否则这条断言在测空气：${guarded}`);
    for (const k of keys) {
      assert.equal(after.get(k), before.get(k),
        `${k} 被卸载改动或删除了——这是产品永不触碰的边界`);
    }
  }
});

test('manifest 外的 unit 从不被点名，它的 plist 与日志原样留下', () => {
  const { before, after, seenUnits } = runPurge(sb);
  assert.deepEqual(seenUnits, ['uninstall server --yes --json'],
    'manifest 里只有 server；点到别的 unit 就是在替用户卸他手工装的东西');
  for (const survivor of [
    'home/Library/LaunchAgents/com.ccm.tunnel.plist',
    'home/Library/LaunchAgents/com.other.app.plist',
    'home/Library/Logs/ccm-tunnel.log',
    'home/Library/Logs/SomeOtherApp/app.log',
  ]) {
    assert.equal(after.get(survivor), before.get(survivor), `${survivor} 不是产品装的，不得触碰`);
  }
});

test('工作区代码与 .ccm-uploads 不变；仓库里的构建产物只报不删', () => {
  const { before, after, lines } = runPurge(sb);
  for (const k of [...before.keys()].filter(k => k.startsWith('work/'))) {
    assert.equal(after.get(k), before.get(k), `工作区内容被动了：${k}`);
  }
  assert.equal(after.get('root/desktop/build/CCM.app/Contents/Info.plist'),
    before.get('root/desktop/build/CCM.app/Contents/Info.plist'),
    'desktop/build 里的中间产物属仓库，伸手删它与永不碰 ~/.claude/projects 是同一条线');
  assert.match(lines.join('\n'), /desktop\/build\/CCM\.app/, '留下的构建产物必须报告，否则用户会以为没卸干净');
});

test('settings.json 里用户自己的条目原样保留（只回收桥自己写的那部分）', () => {
  const { settingsPath } = runPurge(sb);
  const s = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.equal(s.statusLine.command, 'bash /tmp/my-own-statusline.sh', '用户原本的 statusLine 必须还原');
  assert.equal(s.model, 'opus', '与桥无关的键不得被改');
  assert.deepEqual(s.hooks?.SessionStart, [{ hooks: [{ type: 'command', command: 'echo my-own-hook' }] }],
    '用户自己的 hook 条目必须原样留下（桥只回收自己创建的容器）');
});

test('默认档（不带 --purge）完全不碰数据面：数据根、配置、日志一项不少', () => {
  const { before, after } = runPurge(sb, { purge: false });
  const d = diff(before, after);
  const touchedDataFace = [...d.removed, ...d.changed].filter(p =>
    p.startsWith('root/data/')
    || ['root/ccm.config.json', 'root/.env', 'root/workdirs.json'].includes(p)
    || p.startsWith('home/Library/Logs/'));
  assert.deepEqual(touchedDataFace, [],
    '不带 --purge 只卸安装面。数据/配置/日志被动了 = 用户按文档做了「先只卸载看看」却丢了数据');
});

// 每个 case 要一棵新沙箱：runPurge 是破坏性的，同一棵跑第二遍时配置文件已经没了。
function freshRun(overrides) {
  const box = makeSandbox();
  try {
    return { box, text: runPurge(box, { envOverrides: overrides }).lines.join('\n') };
  } finally {
    // 断言在 rm 之后跑：text 已经取出来了，路径字符串不依赖目录还在
    rmSync(box.box, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
}

test('工作区来源与 server/doctor 同一优先级：文件里的 WORK_DIR 认，env 压过文件', () => {
  // 装机向导把 WORK_DIR 写进 ccm.config.json，所以「文件里那个」才是最常见形态；
  // 而「环境变量始终压过文件」是全仓硬规则。两条一起钉，才不会退化成只认其中一条。
  const a = freshRun({ WORK_DIR: undefined });
  assert.ok(a.text.includes(join(a.box.fromConfig, '.ccm-uploads')),
    'env.WORK_DIR 缺失时必须回落到配置文件里的 WORK_DIR');

  const b = freshRun({});   // runPurge 默认注入 env.WORK_DIR = primary
  assert.ok(b.text.includes(join(b.box.primary, '.ccm-uploads')), 'env.WORK_DIR 必须生效');
  assert.ok(!b.text.includes(join(b.box.fromConfig, '.ccm-uploads')),
    'env 存在时不得再取文件里的 WORK_DIR——报出一个用户已经改掉的旧目录会误导排障');
});

test('工作区列表：WORK_DIRS env 压过内联 WORKDIRS（与 pickWorkdirSource 同一档序）', () => {
  // 这里验的是【接线】不是判定本身：判定在 workdirs.js 的 pickWorkdirSource（有自己的单测）。
  // 接错槽位（把 inline 传进 envList，或反过来）不会报错，只会静默换掉整份工作区名单。
  const { box, text } = freshRun({ WORK_DIRS: undefined });   // 先确认内联那档本来是生效的
  assert.ok(text.includes(join(box.work, '.ccm-uploads')), '无 env 时内联 WORKDIRS 生效');

  const c = makeSandbox();
  try {
    const withList = runPurge(c, { envOverrides: { WORK_DIRS: c.viaEnvList } }).lines.join('\n');
    assert.ok(withList.includes(join(c.viaEnvList, '.ccm-uploads')), 'WORK_DIRS env 必须生效');
    assert.ok(!withList.includes(join(c.work, '.ccm-uploads')),
      'WORK_DIRS 存在时内联 WORKDIRS 整档让位（不是合并）——合并语义会让用户以为旧名单还在用');
  } finally {
    rmSync(c.box, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
  }
});

test('--purge --dry-run：计划与真跑列同一批未识别文件，且盘上零改动', () => {
  const { before, after, lines } = runPurge(sb, { dryRun: true });
  assert.deepEqual(diff(before, after), { removed: [], changed: [], added: [] },
    'dry-run 的契约就是「不动任何东西」，动了一个字节这个开关就不能信');
  const text = lines.join('\n');
  for (const kept of ['approval-requests.json.bak-手动备份', '我的备注.md']) {
    assert.ok(text.includes(kept),
      `计划里必须列出会被保留的未识别文件 ${kept}——计划漏报「保留」就等于谎报「将全删」，`
      + '而用户正是看着这份计划按下确认的');
  }
  // 反向同样要钉：白名单文件不得被列进「未识别，保留」。只查正向的话，一个把所有文件
  // 都当成未识别的实现照样全绿，而它给用户的计划是「14 项将删除；16 项保留」——自相矛盾。
  const preserved = text.split('\n').filter(l => l.includes('未识别，保留'));
  for (const f of DATA_FILE_WHITELIST) {
    assert.ok(!preserved.some(l => l.endsWith(`/${f}`)),
      `白名单文件 ${f} 被计划列成「未识别，保留」，与同一份计划里的「将删除」互相打架`);
  }
});

test('run() 不带参数时默认不 purge：破坏性开关的缺省方向必须是安全的那一侧', () => {
  const { before, after } = runPurge(sb, { bare: true });
  const d = diff(before, after);
  assert.deepEqual(d.removed.filter(p => p.startsWith('root/data/')), [],
    'purge 的默认值一旦翻成 true，任何忘记传参的调用方都会静默删掉整个数据面');
});

// ---------------------------------------------------------------------------
// 真 CLI：createUninstaller() 走生产默认值（home=homedir()、root=脚本上一层、appPath 字面量）。
// 上面所有用例都注入了这三项，天然测不到「默认值指向哪」，也测不到 main() 的确认门。
// 这里把仓库复制到一次性目录，让 REPO_ROOT 落在沙箱里，再用 HOME 环境变量改写 homedir()。
//
// darwin 跳过：CLI 的 appPath 恒为字面量 /Applications/CCM.app，注入不进去——在装了 CCM 的
// macOS 上真跑会删掉用户的 app。`defaults delete` 与 pgrep+SIGTERM 同理。容器（linux）里
// 这三段按 platform 整段跳过，才是安全的执行位。
// ---------------------------------------------------------------------------
const SKIP_ON_DARWIN = process.platform === 'darwin'
  ? 'darwin 上 CLI 会碰真实 /Applications/CCM.app 与偏好域，改跑 npm run test:invariants:env（容器）'
  : false;

function makeFakeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'ccm-uninstall-cli-'));
  // uninstall.js 的运行时闭包：scripts/ + app/src/{ops,sessions,shared} + package.json（type:module）+ 依赖
  for (const d of ['scripts', 'app']) cpSync(join(REPO, d), join(repo, d), { recursive: true });
  cpSync(join(REPO, 'package.json'), join(repo, 'package.json'));
  symlinkSync(join(REPO, 'node_modules'), join(repo, 'node_modules'), 'dir');

  const home = join(repo, 'home');
  w(join(home, '.claude', 'projects', 'p', 's.jsonl'), '{"keep":true}\n');
  const data = join(repo, 'data');
  for (const f of DATA_FILE_WHITELIST) w(join(data, f), '{}');
  rmSync(join(data, 'service-install.json'));   // 无 manifest ⇒ 不 spawn service.js ⇒ 不碰 launchctl
  w(join(repo, 'ccm.config.json'), '{"AUTH_TOKEN":"x"}');
  w(join(repo, '.env'), 'AUTH_TOKEN=x\n');

  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.CCM_DATA_DIR;   // 必须删：preload-env 注入过它，留着就测不到 join(root,'data') 的默认解析
  const run = args => spawnSync(process.execPath, [join(repo, 'scripts', 'uninstall.js'), ...args], {
    encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'],   // stdin 非 TTY = 非交互环境
  });
  return { repo, home, data, env, run };
}

test('真 CLI --purge --yes：默认路径解析落在沙箱内，删配置而不碰 ~/.claude/projects',
  { skip: SKIP_ON_DARWIN }, () => {
    const fr = makeFakeRepo();
    try {
      const r = fr.run(['--purge', '--yes']);
      assert.equal(r.status, 0, `CLI 应成功退出：${r.stderr}\n${r.stdout}`);
      assert.ok(r.stdout.includes(`数据根：${fr.data}`),
        `CLI 报的数据根必须是沙箱里那个，否则默认解析没落在 REPO_ROOT/data：\n${r.stdout}`);

      assert.equal(existsSync(join(fr.repo, 'ccm.config.json')), false, 'purge 该删仓库根配置');
      assert.equal(existsSync(join(fr.repo, '.env')), false);
      assert.equal(existsSync(fr.data), false, '白名单删净后数据根整目录移除');
      assert.equal(readFileSync(join(fr.home, '.claude', 'projects', 'p', 's.jsonl'), 'utf8'), '{"keep":true}\n',
        '真 CLI 跑完 ~/.claude/projects 必须逐字节还在——这是 DIST-01 的最后一道');
      assert.equal(existsSync(join(fr.repo, 'package.json')), true, '仓库自身文件不在卸载范围');
      assert.equal(existsSync(join(fr.repo, 'app', 'src', 'ops', 'config-file.js')), true);
    } finally {
      rmSync(fr.repo, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
    }
  });

test('真 CLI 非交互下不带 --yes：拒绝执行，且盘上一个字节都没动',
  { skip: SKIP_ON_DARWIN }, () => {
    // 「默认拒绝、须显式确认」不能只测 resolveUninstallConfirm 那个纯函数——接线断了照样全绿。
    // 这里测的是「用户在服务器上手敲 npm run uninstall -- --purge，会不会没问一声就把数据删了」。
    const fr = makeFakeRepo();
    try {
      const before = snapshot(fr.repo);   // node_modules 是 symlink，只记 link 目标不递归
      const r = fr.run(['--purge']);
      assert.equal(r.status, 1, '未确认必须以非 0 退出，否则脚本化调用会把"取消"当成"成功"');
      assert.ok(r.stderr.includes('未确认'), `应明确告知已取消：${r.stderr}`);
      assert.deepEqual(diff(before, snapshot(fr.repo)), { removed: [], changed: [], added: [] },
        '未确认却动了盘 = 一次不可逆的误删。dry-run 预演打印是允许的，落盘不允许');
    } finally {
      rmSync(fr.repo, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
    }
  });

test('真 CLI --yes 但不带 --purge：只卸安装面，数据与配置一项不少',
  { skip: SKIP_ON_DARWIN }, () => {
    const fr = makeFakeRepo();
    try {
      const r = fr.run(['--yes']);
      assert.equal(r.status, 0, `${r.stderr}\n${r.stdout}`);
      assert.equal(existsSync(join(fr.repo, 'ccm.config.json')), true,
        '没写 --purge 就删配置 = 用户想"先只卸载看看"，结果配置没了');
      assert.equal(existsSync(join(fr.repo, '.env')), true);
      for (const f of DATA_FILE_WHITELIST) {
        if (f === 'service-install.json') continue;   // 夹具里刻意不放
        assert.equal(existsSync(join(fr.data, f)), true, `${f} 属数据面，非 --purge 不得删`);
      }
    } finally {
      rmSync(fr.repo, { recursive: true, force: true }); // safe-rm: mkdtemp 一次性目录
    }
  });
