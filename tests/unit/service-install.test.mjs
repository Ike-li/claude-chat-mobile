// tests/unit/service-install.test.mjs —— scripts/service.js 的写路径（install / adopt / uninstall）
//
// 核心不变量：**只对 manifest 里记着的 unit 做写操作**。机主机器上有四个手工装的 unit，
// 其中 com.ccm.tunnel 用的是自写包装脚本、com.ccm.tunnel-watch 模板里压根没有 —— 它们必须
// 只读。这里的用例大半是在证明「我们没碰不该碰的东西」。
//
// 用内存 fs mock 而不是 mkdtemp：① 跨平台可跑（真实实现依赖 macOS 的 plutil）；
// ② 能精确断言「adopt 前后 plist 字节完全没变」这类字节级性质。plist 渲染仍走真实模板文件。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { createServiceManager, pickNodePath, resolveManifestPath, resolveUninstallConfirm } from '../../scripts/service.js';

const HOME = '/Users/you';
const REPO = '/Users/you/code/claude-chat-mobile';
const NODE = '/opt/homebrew/bin/node';
const AGENTS = `${HOME}/Library/LaunchAgents`;
const SERVER_PLIST = `${AGENTS}/com.ccm.server.plist`;

const sha = (s) => createHash('sha256').update(s).digest('hex');

// 手写的 server plist：与模板渲染结果字节不同（无行内注释、路径无引号），但语义等价。
const HANDWRITTEN_XML = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ccm.server</string>
  <key>ProgramArguments</key>
  <array><string>/bin/zsh</string><string>-lc</string><string>cd ${REPO} &amp;&amp; exec ${NODE} app/server.js</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${HOME}/Library/Logs/ccm-server.log</string>
  <key>StandardErrorPath</key><string>${HOME}/Library/Logs/ccm-server.log</string>
</dict>
</plist>
`;

const HANDWRITTEN_OBJ = {
  Label: 'com.ccm.server',
  ProgramArguments: ['/bin/zsh', '-lc', `cd ${REPO} && exec ${NODE} app/server.js`],
  RunAtLoad: true,
  KeepAlive: true,
  StandardOutPath: `${HOME}/Library/Logs/ccm-server.log`,
  StandardErrorPath: `${HOME}/Library/Logs/ccm-server.log`,
};

// 用户自写包装脚本的隧道（机主真实形态：/bin/bash ~/.cloudflared/xxx.sh）
const CUSTOM_TUNNEL_OBJ = {
  Label: 'com.ccm.tunnel',
  ProgramArguments: ['/bin/bash', `${HOME}/.cloudflared/ccm-tunnel-run.sh`],
  RunAtLoad: true,
  KeepAlive: true,
  StandardOutPath: `${HOME}/Library/Logs/ccm-tunnel.log`,
  StandardErrorPath: `${HOME}/Library/Logs/ccm-tunnel.log`,
};

function setup({ files = {}, objs = {}, manifest = null, launchctlFails = false, tsv = 'PID\tStatus\tLabel', portListenerPid = () => null } = {}) {
  const fs = new Map(Object.entries(files));
  const plists = { ...objs };
  const calls = [];
  const writes = []; // 写操作顺序 —— 「先 manifest 后 plist」是中断可恢复的前提，要能断言
  let stored = manifest;
  let failNow = launchctlFails;
  // bootstrap 成功后 launchctl 里就该查得到这个 unit —— 不模拟这一步的话，
  // 「install 完了 launchctl 却不认识它」这种只在 bootstrap 失败时才该出现的状态会变成常态。
  const loaded = new Set(
    tsv.split('\n').slice(1).map((l) => l.split('\t')[2]).filter(Boolean)
  );

  const mgr = createServiceManager({
    platform: 'darwin',
    home: HOME,
    repo: REPO,
    node: NODE,
    now: () => 1786000000000,
    execLaunchctl: (args) => {
      calls.push(args);
      if (args[0] === 'list') {
        const rows = [...loaded].map((label) => `-\t0\t${label}`);
        return { status: 0, stdout: ['PID\tStatus\tLabel', ...rows].join('\n'), stderr: '' };
      }
      if (failNow) return { status: 1, stdout: '', stderr: 'Load failed: 5: Input/output error' };
      if (args[0] === 'bootstrap') loaded.add(args[2]?.split('/').pop()?.replace(/\.plist$/, ''));
      if (args[0] === 'bootout') loaded.delete(args[1]?.split('/').pop());
      return { status: 0, stdout: '', stderr: '' };
    },
    readPlistFile: (p) => plists[p] ?? null,
    readFileRaw: (p) => fs.get(p) ?? null,
    writeFile: (p, c) => { writes.push(`file:${p}`); fs.set(p, c); },
    deleteFile: (p) => { fs.delete(p); },
    fileExists: (p) => fs.has(p),
    readManifest: () => stored,
    writeManifest: (m) => { writes.push('manifest'); stored = m; },
    readEnv: () => ({ PORT: '3000' }),
    envFileExists: () => true,
    tcpProbe: () => false,
    portListenerPid,
    lanIp: () => null,
    realpath: (p) => p,
  });

  return {
    mgr, fs, plists, calls, writes,
    manifestNow: () => stored,
    setLaunchctlFail: (v) => { failNow = v; },
  };
}

// 升级把模板本身改了（运行时入口 server.js → app/server.js）而安装参数一个都没变的情况。
// 这一档此前完全漏网：install 只比 vars，vars 一致就早退回 already，plist 纹丝不动。
// 用户的实际体验是「命令说成功了，服务还是起不来」，比直接报错更难排查。
test.describe('install —— 模板升级后盘上那份过期了', () => {
  // 旧模板渲染的形态：ProgramArguments 里还写着仓库根的 server.js
  const STALE_SERVER_OBJ = {
    ...HANDWRITTEN_OBJ,
    ProgramArguments: ['/bin/zsh', '-lc', `cd "${REPO}" && exec "${NODE}" server.js`],
  };

  test('vars 没变但 plist 是旧模板渲染的 → 不得回「已是目标状态」，要指出重装路径', () => {
    const h = setup();
    const first = h.mgr.install('server');
    assert.equal(first.ok, true, '前置：先正常装一次');

    // 模拟升级：仓库里的模板已经变了，而 ~/Library/LaunchAgents 里那份还是旧的
    h.plists[SERVER_PLIST] = STALE_SERVER_OBJ;

    const r = h.mgr.install('server');
    assert.notEqual(r.action, 'already', '报「已是目标状态」= 用户跑了命令、看到成功、问题依旧');
    assert.equal(r.ok, false);
    assert.match(r.error, /uninstall/, '要给出唯一的出路，而不只是说不行');
  });

  test('plist 与当前模板语义等价时仍走原来的 already 早退（不制造假报错）', () => {
    const h = setup();
    h.mgr.install('server');
    const r = h.mgr.install('server');
    assert.equal(r.ok, true);
    assert.equal(r.action, 'already');
  });
});

test.describe('install —— 全新安装', () => {
  test('渲染 plist 落盘 + 写 manifest + bootstrap，三步都做', () => {
    const { mgr, fs, calls, manifestNow } = setup();
    const r = mgr.install('server');

    assert.equal(r.ok, true);
    assert.equal(r.action, 'installed');
    assert.ok(fs.has(SERVER_PLIST), 'plist 应落盘');
    assert.ok(manifestNow().units.server, 'manifest 应记录');
    assert.ok(calls.some((a) => a[0] === 'bootstrap'), '应 bootstrap');
  });

  test('落盘的 plist 内容是真渲染的（含真实 repo 与 node 路径，且无占位符残留）', () => {
    const { mgr, fs } = setup();
    mgr.install('server');
    const xml = fs.get(SERVER_PLIST);
    assert.ok(xml.includes(REPO), '应含仓库路径');
    assert.ok(xml.includes(NODE), '应含 node 路径');
    assert.ok(!xml.includes('__REPO__'), '不该有未替换的占位符');
    assert.ok(!xml.includes('__LABEL__'));
  });

  test('manifest 记的 sha256 与落盘字节一致（卸载 CAS 的前提）', () => {
    const { mgr, fs, manifestNow } = setup();
    mgr.install('server');
    assert.equal(manifestNow().units.server.sha256, sha(fs.get(SERVER_PLIST)));
  });

  // 写序：manifest 先落盘 → 渲染 plist → bootstrap。反过来的话，中断在「plist 已写、manifest 未写」
  // 时会留下一个孤儿 plist —— 下次 status 判它 adoptable、install 让你去 adopt，用户一头雾水。
  test('先写 manifest 再写 plist（中断可恢复的前提）', () => {
    const { mgr, writes } = setup();
    mgr.install('server');
    const mi = writes.indexOf('manifest');
    const pi = writes.findIndex((w) => w === `file:${SERVER_PLIST}`);
    assert.ok(mi >= 0, '应写过 manifest');
    assert.ok(pi >= 0, '应写过 plist');
    assert.ok(mi < pi, 'manifest 必须先落盘，中断在此之后靠 recovered 分支补齐');
  });

  test('重复 install 幂等：不重复 bootstrap，返回 already', () => {
    const { mgr, calls } = setup();
    mgr.install('server');
    const before = calls.filter((a) => a[0] === 'bootstrap').length;
    const r = mgr.install('server');
    assert.equal(r.action, 'already');
    assert.equal(calls.filter((a) => a[0] === 'bootstrap').length, before, '已装好就别再 bootstrap');
  });

  test('manifest 有记录但 plist 不见了 → recovered 分支补渲染（中断在 manifest 之后）', () => {
    const { mgr, fs } = setup({
      manifest: {
        schemaVersion: 1,
        labelPrefix: 'com.ccm',
        units: {
          server: {
            label: 'com.ccm.server', plistPath: SERVER_PLIST,
            // template 故意保留 2026-08-17 搬移前的旧路径：机主生产机的 manifest 里就是这个值。
            // 它钉住「manifest 的 template 字段只做非空校验、绝不被拿去读文件」——recover 走
            // templateFor(unit) 重算路径，stale 值必须无害；若有人把它接进 readFileSync，此处即红。
            sha256: 'a'.repeat(64), template: 'deploy/server.plist.template',
          },
        },
      },
    });
    const r = mgr.install('server');
    assert.equal(r.action, 'recovered');
    assert.ok(fs.has(SERVER_PLIST), 'plist 应被补写');
  });

  // ★ recovered 分支此前从不读 manifest 记的 vars，只吃 CLI opts。而 adopt 那里写得清清楚楚
  // 「vars 是将来 recovered 分支要拿来重渲染的参数」，ACTION_TEXT.recovered 也告诉用户
  // 「已按 manifest 重建」—— 实际是死数据。plist 被删（git clean / 手滑）时用户并不会再带一次
  // --tunnel/--cloudflared/--app，于是恢复被自己的 precheck 拦下，要他手填工具已经存着的值。
  // server/logrotate 侥幸能恢复，只因它们的 vars 恰好都能从 ctx 推出来。
  test('★ tunnel 的 plist 被删 → 按 manifest 记的 vars 重建，不再要用户重打参数', () => {
    const { mgr, fs } = setup({
      files: { [`${HOME}/.cloudflared/config.yml`]: 'tunnel: home\n' },
      manifest: {
        schemaVersion: 1,
        labelPrefix: 'com.ccm',
        units: {
          tunnel: {
            label: 'com.ccm.tunnel',
            plistPath: `${AGENTS}/com.ccm.tunnel.plist`,
            sha256: 'b'.repeat(64),
            template: 'desktop/launchd/tunnel.plist.template',
            vars: { LABEL: 'com.ccm.tunnel', CLOUDFLARED: '/opt/homebrew/bin/cloudflared', TUNNEL: 'home', LOG: `${HOME}/Library/Logs/ccm-tunnel.log` },
          },
        },
      },
    });
    const r = mgr.install('tunnel');   // 注意：**不带**任何 --tunnel / --cloudflared
    assert.equal(r.ok, true, `不该再要求重打参数：${r.error}`);
    assert.equal(r.action, 'recovered');
    const written = fs.get(`${AGENTS}/com.ccm.tunnel.plist`);
    assert.match(written, /home/, '隧道名要从 manifest 里取回来');
    assert.match(written, /cloudflared/, 'cloudflared 路径同理');
  });

  test('CLI 显式给的参数压过 manifest 记的（用户想换隧道时得能换）', () => {
    const { mgr, fs } = setup({
      files: { [`${HOME}/.cloudflared/config.yml`]: 'tunnel: home\n' },
      manifest: {
        schemaVersion: 1,
        labelPrefix: 'com.ccm',
        units: {
          tunnel: {
            label: 'com.ccm.tunnel',
            plistPath: `${AGENTS}/com.ccm.tunnel.plist`,
            sha256: 'b'.repeat(64),
            template: 'desktop/launchd/tunnel.plist.template',
            vars: { LABEL: 'com.ccm.tunnel', CLOUDFLARED: '/old/cloudflared', TUNNEL: 'old-name', LOG: `${HOME}/Library/Logs/ccm-tunnel.log` },
          },
        },
      },
    });
    const r = mgr.install('tunnel', { tunnel: 'new-name', cloudflared: '/opt/homebrew/bin/cloudflared' });
    assert.equal(r.ok, true, r.error);
    const written = fs.get(`${AGENTS}/com.ccm.tunnel.plist`);
    assert.match(written, /new-name/);
    assert.doesNotMatch(written, /old-name/);
  });

  // ★ optsFromVars 只挂在 `!exists` 分支时，同一条命令会因为「plist 在不在」给出相反结果：
  // plist 还在 → 报「参数与当前配置不一致（CLOUDFLARED / TUNNEL）… 先卸载再装」，
  // 让用户为了「没重复输入工具已经存着的参数」去拆掉一条正常工作的隧道。
  test('★ plist 还在时不带参数跑 install → 认作「已是目标状态」，不是「参数不一致」', () => {
    const TUNNEL_PLIST = `${AGENTS}/com.ccm.tunnel.plist`;
    const vars = { LABEL: 'com.ccm.tunnel', CLOUDFLARED: '/opt/homebrew/bin/cloudflared', TUNNEL: 'home', LOG: `${HOME}/Library/Logs/ccm-tunnel.log` };
    const { mgr } = setup({
      files: { [`${HOME}/.cloudflared/config.yml`]: 'tunnel: home\n', [TUNNEL_PLIST]: '<plist/>' },
      objs: {
        [TUNNEL_PLIST]: {
          Label: 'com.ccm.tunnel',
          ProgramArguments: ['/opt/homebrew/bin/cloudflared', 'tunnel', 'run', 'home'],
          RunAtLoad: true, KeepAlive: true,
          StandardOutPath: vars.LOG, StandardErrorPath: vars.LOG,
        },
      },
      tsv: ['PID\tStatus\tLabel', '111\t0\tcom.ccm.tunnel'].join('\n'),
      manifest: {
        schemaVersion: 1, labelPrefix: 'com.ccm',
        units: { tunnel: { label: 'com.ccm.tunnel', plistPath: TUNNEL_PLIST, sha256: 'c'.repeat(64), template: 'desktop/launchd/tunnel.plist.template', vars } },
      },
    });
    const r = mgr.install('tunnel');   // 不带 --tunnel / --cloudflared
    assert.equal(r.ok, true, `不该要求重打工具已经存着的参数：${r.error}`);
    assert.equal(r.action, 'already');
  });

  // ★ 恢复 menubar 时若 manifest 记的 APP 已经被 git clean 掉了，重建出来的 plist 指向一个
  // 不存在的 bundle —— 「✓ 已修复安装」却什么都拉不起来。precheck 只判了 opts.app 真不真，
  // 没判它在不在。1158e7a 修的正是「自启指向仓库构建产物、三条自查路径全看不见」。
  test('★ 从 manifest 恢复 menubar：记录的 .app 已不存在 → 拒绝，不假装修好了', () => {
    const APP = `${REPO}/desktop/build/CCM.app`;
    const { mgr } = setup({
      manifest: {
        schemaVersion: 1, labelPrefix: 'com.ccm',
        units: { menubar: { label: 'com.ccm.menubar', plistPath: `${AGENTS}/com.ccm.menubar.plist`, sha256: 'd'.repeat(64), template: 'desktop/launchd/menubar.plist.template', vars: { LABEL: 'com.ccm.menubar', APP, LOG: `${HOME}/Library/Logs/ccm-menubar.log` } } },
      },
    });
    const r = mgr.install('menubar');  // files 里没有那个 .app
    assert.equal(r.ok, false, '指向不存在的 bundle 的「修复」等于没修');
    assert.match(r.error, /不存在|app:install/, `要说清是路径没了：${r.error}`);
  });

  test('launchctl bootstrap 失败 → ok:false 且如实报错（不假装成功）', () => {
    const { mgr } = setup({ launchctlFails: true });
    const r = mgr.install('server');
    assert.equal(r.ok, false);
    assert.match(r.error, /Load failed|bootstrap/i);
  });

  // ★ bootstrap 失败（macOS 上 "Load failed: 5: Input/output error" 很常见）时 plist 与 manifest
  // 都已落盘。早前第二次 install 命中 `inManifest && exists` 直接返回 already + exit 0，
  // **根本不再尝试 bootstrap** —— 用户只能先 uninstall 再 install 才出得来，而 CLI 毫无提示。
  test('bootstrap 失败后再次 install 会重试加载，而不是报 already', () => {
    const s = setup({ launchctlFails: true });
    const first = s.mgr.install('server');
    assert.equal(first.ok, false, '首次应如实报失败');

    s.setLaunchctlFail(false);
    const before = s.calls.filter((a) => a[0] === 'bootstrap').length;
    const second = s.mgr.install('server');
    assert.equal(second.ok, true);
    assert.ok(
      s.calls.filter((a) => a[0] === 'bootstrap').length > before,
      '第二次 install 必须重试 bootstrap，否则用户困在死路里'
    );
  });

  test('已装好且确实在跑 → 仍然返回 already，不做多余的 bootstrap', () => {
    const s = setup({ tsv: 'PID\tStatus\tLabel\n26867\t0\tcom.ccm.server' });
    s.mgr.install('server');
    const before = s.calls.filter((a) => a[0] === 'bootstrap').length;
    const r = s.mgr.install('server');
    assert.equal(r.action, 'already');
    assert.equal(s.calls.filter((a) => a[0] === 'bootstrap').length, before);
  });
});

test.describe('install —— 护栏：绝不覆写用户的配置', () => {
  test('foreign（用户自写启动方式）拒绝 install', () => {
    const { mgr, fs } = setup({
      objs: { [`${AGENTS}/com.ccm.tunnel.plist`]: CUSTOM_TUNNEL_OBJ },
      files: { [`${AGENTS}/com.ccm.tunnel.plist`]: '<custom/>' },
    });
    const r = mgr.install('tunnel');
    assert.equal(r.ok, false);
    assert.match(r.error, /自定义|foreign|不接管|adopt/);
    assert.equal(fs.get(`${AGENTS}/com.ccm.tunnel.plist`), '<custom/>', '原文件一个字节都不能变');
  });

  test('unknown unit（模板里没有）根本不能 install', () => {
    const { mgr } = setup();
    const r = mgr.install('tunnel-watch');
    assert.equal(r.ok, false);
    assert.match(r.error, /未知 unit|unknown/);
  });

  test('adoptable（手工装的但语义等价）也拒绝 install，引导先 adopt', () => {
    const { mgr, fs } = setup({
      objs: { [SERVER_PLIST]: HANDWRITTEN_OBJ },
      files: { [SERVER_PLIST]: HANDWRITTEN_XML },
    });
    const r = mgr.install('server');
    assert.equal(r.ok, false);
    assert.match(r.error, /adopt/, '应引导用 adopt 而不是默默覆盖');
    assert.equal(fs.get(SERVER_PLIST), HANDWRITTEN_XML, '手写的 plist 必须原样保留');
  });

  test('端口被前台 npm start 占着时拒绝 install，不 bootstrap', () => {
    const { mgr, calls, fs } = setup({ portListenerPid: () => 4242 });
    const r = mgr.install('server');
    assert.equal(r.ok, false);
    assert.match(r.error, /npm start|占用/);
    assert.ok(!calls.some((a) => a[0] === 'bootstrap'), '占用时不得 bootstrap（RunAtLoad 会立刻拉起）');
    assert.equal(fs.has(SERVER_PLIST), false, '拒绝时不能留下半份 plist');
  });

  test('tunnel 缺 ~/.cloudflared/config.yml 时拒绝安装（否则装出一个崩溃重启循环）', () => {
    const { mgr } = setup();
    const r = mgr.install('tunnel');
    assert.equal(r.ok, false);
    assert.match(r.error, /cloudflared|config\.yml/);
  });

  // ★ desktop/launchd/menubar.plist.template 的头注写着「node scripts/service.js install menubar 会渲染
  // 它并 bootstrap」，但 precheck 早前只校验 tunnel ⇒ APP 为 undefined 时 escapeXml 把它变成
  // 字面量 "undefined" 写进 plist，还报「✓ 已安装并加载」。且 menubar 的 driftFields 只有
  // log-path，status 会一直显示 managed 无漂移，用户无从发现。
  test('menubar 不带 --app 时拒绝安装（否则写出 /usr/bin/open undefined 并报成功）', () => {
    const { mgr, fs } = setup();
    const r = mgr.install('menubar');
    assert.equal(r.ok, false);
    assert.match(r.error, /app|APP|\.app/i);
    assert.equal(fs.has(`${AGENTS}/com.ccm.menubar.plist`), false, '拒绝时不能留下半份 plist');
  });

  test('menubar 带 --app 可以装，且 plist 里没有 undefined', () => {
    // .app 要真的在（内存 fs 里放一份）：precheck 现在除了「给没给」还判「在不在」，
    // 否则从 manifest 恢复时会拿一个被 git clean 掉的路径重建出「修好了」的假象。
    const APP = '/Users/you/code/repo/desktop/build/CCM.app';
    const { mgr, fs } = setup({ files: { [APP]: 'bundle' } });
    const r = mgr.install('menubar', { app: APP });
    assert.equal(r.ok, true);
    const xml = fs.get(`${AGENTS}/com.ccm.menubar.plist`);
    assert.ok(!xml.includes('undefined'), 'plist 里不能出现字面量 undefined');
    assert.ok(xml.includes('CCM.app'));
  });

  test('tunnel 有 config.yml 时可以装', () => {
    const { mgr } = setup({ files: { [`${HOME}/.cloudflared/config.yml`]: 'tunnel: abc' } });
    const r = mgr.install('tunnel', { tunnel: 'abc', cloudflared: '/opt/homebrew/bin/cloudflared' });
    assert.equal(r.ok, true);
  });
});

test.describe('adopt —— 接管手工安装', () => {
  test('只写 manifest，plist 字节完全不变（这是 adopt 零风险的全部依据）', () => {
    const { mgr, fs, manifestNow } = setup({
      objs: { [SERVER_PLIST]: HANDWRITTEN_OBJ },
      files: { [SERVER_PLIST]: HANDWRITTEN_XML },
    });
    const before = fs.get(SERVER_PLIST);
    const r = mgr.adopt('server');

    assert.equal(r.ok, true);
    assert.equal(fs.get(SERVER_PLIST), before, 'adopt 绝不能改动 plist');
    assert.equal(manifestNow().units.server.adopted, true);
  });

  test('adopt 后 manifest 记的是盘上那份的 sha（不是模板渲染结果的 sha）', () => {
    const { mgr, manifestNow } = setup({
      objs: { [SERVER_PLIST]: HANDWRITTEN_OBJ },
      files: { [SERVER_PLIST]: HANDWRITTEN_XML },
    });
    mgr.adopt('server');
    assert.equal(manifestNow().units.server.sha256, sha(HANDWRITTEN_XML),
      '记模板 sha 会让下次 uninstall 的 CAS 立刻误判');
  });

  test('adopt 后归属变 managed', () => {
    const { mgr } = setup({
      objs: { [SERVER_PLIST]: HANDWRITTEN_OBJ },
      files: { [SERVER_PLIST]: HANDWRITTEN_XML },
    });
    mgr.adopt('server');
    assert.equal(mgr.status().units.find((u) => u.unit === 'server').ownership, 'managed');
  });

  test('adopt 全程不调 launchctl（纯 manifest 操作，不触碰运行中的服务）', () => {
    const { mgr, calls } = setup({
      objs: { [SERVER_PLIST]: HANDWRITTEN_OBJ },
      files: { [SERVER_PLIST]: HANDWRITTEN_XML },
    });
    const before = calls.length;
    mgr.adopt('server');
    const after = calls.slice(before).filter((a) => a[0] !== 'list');
    assert.deepEqual(after, [], 'adopt 不该 bootstrap/bootout/kickstart 任何东西');
  });

  test('foreign（自定义启动方式）拒绝 adopt —— 接管了就意味着将来会被覆写', () => {
    const { mgr } = setup({
      objs: { [`${AGENTS}/com.ccm.tunnel.plist`]: CUSTOM_TUNNEL_OBJ },
      files: { [`${AGENTS}/com.ccm.tunnel.plist`]: '<custom/>' },
    });
    const r = mgr.adopt('tunnel');
    assert.equal(r.ok, false);
    assert.match(r.error, /自定义|不接管|foreign/);
  });

  test('未安装的 unit 无从 adopt', () => {
    const { mgr } = setup();
    const r = mgr.adopt('server');
    assert.equal(r.ok, false);
    assert.match(r.error, /未安装|不存在/);
  });

  test('已 managed 的重复 adopt 返回 already，不改 manifest', () => {
    const { mgr, manifestNow } = setup({
      objs: { [SERVER_PLIST]: HANDWRITTEN_OBJ },
      files: { [SERVER_PLIST]: HANDWRITTEN_XML },
    });
    mgr.adopt('server');
    const snapshot = JSON.stringify(manifestNow());
    const r = mgr.adopt('server');
    assert.equal(r.action, 'already');
    assert.equal(JSON.stringify(manifestNow()), snapshot);
  });
});

test.describe('uninstall —— CAS 保护', () => {
  function installed() {
    const s = setup();
    s.mgr.install('server');
    // install 后把 plist 对象也补上，让后续 status 能解析
    s.plists[SERVER_PLIST] = HANDWRITTEN_OBJ;
    return s;
  }

  test('正常卸载：bootout + 删 plist + 从 manifest 移除', () => {
    const { mgr, fs, calls, manifestNow } = installed();
    const r = mgr.uninstall('server', { confirmed: true });

    assert.equal(r.ok, true);
    assert.ok(calls.some((a) => a[0] === 'bootout'), '应 bootout');
    assert.equal(fs.has(SERVER_PLIST), false, 'plist 应被删');
    assert.equal(manifestNow().units.server, undefined, 'manifest 条目应移除');
  });

  test('用户手改过 plist → 拒绝删除（CAS 不匹配）', () => {
    const { mgr, fs } = installed();
    fs.set(SERVER_PLIST, `${fs.get(SERVER_PLIST)}<!-- 我改了点东西 -->`);

    const r = mgr.uninstall('server', { confirmed: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /改过|不一致|--force/);
    assert.ok(fs.has(SERVER_PLIST), '拒绝时绝不能删');
  });

  test('--force 可以越过 CAS（但要显式要求）', () => {
    const { mgr, fs } = installed();
    fs.set(SERVER_PLIST, '<!-- 改过 -->');
    const r = mgr.uninstall('server', { force: true, confirmed: true });
    assert.equal(r.ok, true);
    assert.equal(fs.has(SERVER_PLIST), false);
  });

  test('只删自己那条，manifest 里其它 unit 条目一字不动', () => {
    const { mgr, manifestNow } = installed();
    mgr.install('logrotate');
    const logrotateBefore = JSON.stringify(manifestNow().units.logrotate);

    mgr.uninstall('server', { confirmed: true });
    assert.equal(JSON.stringify(manifestNow().units.logrotate), logrotateBefore);
  });

  test('foreign / adoptable（不在 manifest 里）拒绝卸载', () => {
    const { mgr, fs } = setup({
      objs: { [SERVER_PLIST]: HANDWRITTEN_OBJ },
      files: { [SERVER_PLIST]: HANDWRITTEN_XML },
    });
    const r = mgr.uninstall('server', { confirmed: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /不是本工具安装|adopt|manifest/);
    assert.ok(fs.has(SERVER_PLIST), '不是我们装的，一个字节都不能碰');
  });

  test('unknown unit 拒绝卸载（机主自建的 tunnel-watch）', () => {
    const { mgr } = setup();
    const r = mgr.uninstall('tunnel-watch', { confirmed: true });
    assert.equal(r.ok, false);
  });

  // 标题曾写「未安装 → already，不报错」，与下面的断言直接矛盾：`already` 是 install/adopt
  // 的幂等语义（service.js:331 / :406 各返回 ok:true + action:'already'），uninstall 没有这一档。
  // 卸载一个不在 manifest 里的 unit 是**拒绝**——那正是「只对自己装的东西做写操作」这条纪律，
  // 不是幂等成功。标题按实际行为改正，顺便把拒绝的理由也断言上，防止将来退化成别的错误。
  test('未在 manifest 里 → 拒绝卸载（不是幂等 already）', () => {
    const { mgr } = setup();
    const r = mgr.uninstall('server', { confirmed: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /manifest|未安装|不是本工具/, `理由要说清为什么拒绝，实际：${r.error}`);
  });

  // bootout 对一个没在跑的 unit 会返回非零（"Could not find service"）——那不是失败，
  // 是"本来就没跑"。若据此中止，plist 和 manifest 会永远卸不掉。
  test('bootout 失败仍继续删 plist 与 manifest 条目（服务可能本来就没在跑）', () => {
    const { mgr, fs, manifestNow, setLaunchctlFail } = installed();
    setLaunchctlFail(true);
    const r = mgr.uninstall('server', { confirmed: true });
    assert.equal(r.ok, true, 'bootout 非零不该让整个卸载失败');
    assert.equal(fs.has(SERVER_PLIST), false, 'plist 必须删掉，否则永远卸不干净');
    assert.equal(manifestNow().units.server, undefined);
  });
});

// manifest 落在哪：必须与 server / doctor 解析出同一个 CCM_DATA_DIR。
// service.js 是独立 CLI、不走 app/server.js 的 loadRuntimeEnvironment，只读 process.env 会漏掉
// .env 里的 CCM_DATA_DIR —— 那样 manifest 写进仓库 data/，而生产状态在别处，两边对不上。
test.describe('resolveManifestPath', () => {
  const ROOT = '/repo';

  test('都没设 → 回落 <repo>/data（与 data-dir.js 同口径）', () => {
    assert.equal(resolveManifestPath({}, {}, ROOT), '/repo/data/service-install.json');
  });

  test('读 .env 里的 CCM_DATA_DIR（这正是漏掉会出事的那条）', () => {
    assert.equal(
      resolveManifestPath({}, { CCM_DATA_DIR: '/data/ccm' }, ROOT),
      '/data/ccm/service-install.json'
    );
  });

  test('shell 环境优先于 .env（与 dotenv 的不覆盖语义一致）', () => {
    assert.equal(
      resolveManifestPath({ CCM_DATA_DIR: '/from/shell' }, { CCM_DATA_DIR: '/from/envfile' }, ROOT),
      '/from/shell/service-install.json'
    );
  });

  test('空串按未设置处理（同 config.js 的 normalizeLoadedEnvironment）', () => {
    assert.equal(resolveManifestPath({ CCM_DATA_DIR: '' }, {}, ROOT), '/repo/data/service-install.json');
  });
});

// 写进 plist 的 node 路径该用哪个？
// process.execPath 是**解析过 symlink 的真身**（/opt/homebrew/Cellar/node/25.9.0_3/bin/node）——
// 写进 plist 后 `brew upgrade node` 版本号一变就指向不存在的二进制，服务再也起不来。
// 登录 shell 的 `command -v node` 给的是稳定 symlink（/opt/homebrew/bin/node），
// 且与 plist 自身的 `zsh -lc` 启动方式同源（终端等价性）。
test.describe('pickNodePath', () => {
  const EXEC = '/opt/homebrew/Cellar/node/25.9.0_3/bin/node';
  const LINK = '/opt/homebrew/bin/node';

  test('登录 shell 找到且存在 → 用它（稳定 symlink，brew upgrade 后自动跟上）', () => {
    assert.equal(pickNodePath(LINK, EXEC, (p) => p === LINK), LINK);
  });

  test('登录 shell 没找到 → 回落 execPath（总比没有强）', () => {
    assert.equal(pickNodePath('', EXEC, () => true), EXEC);
  });

  test('登录 shell 给的路径不存在 → 回落 execPath（nvm 卸载残留等）', () => {
    assert.equal(pickNodePath('/gone/node', EXEC, () => false), EXEC);
  });

  test('输出带换行/空白时先规整', () => {
    assert.equal(pickNodePath(`  ${LINK}\n`, EXEC, (p) => p === LINK), LINK);
  });

  test('多行输出只取第一行（某些 shell 的 command -v 会多吐东西）', () => {
    assert.equal(pickNodePath(`${LINK}\n/other/node\n`, EXEC, (p) => p === LINK), LINK);
  });
});

test.describe('uninstall —— 路径与 CAS 的加固（审查发现）', () => {
  // manifest 是磁盘上的 0600 JSON，能被篡改；validateManifest 只校验 plistPath 是非空字符串，
  // 不校验它的位置。所以删除目标必须用派生路径，manifest 里那个只能拿来做 CAS 与展示。
  test('删除目标用派生路径，manifest 里被篡改的 plistPath 不生效', () => {
    const evil = '/Users/you/.ssh/id_rsa';
    const s = setup({
      files: { [SERVER_PLIST]: HANDWRITTEN_XML, [evil]: 'PRIVATE KEY' },
      objs: { [SERVER_PLIST]: HANDWRITTEN_OBJ },
      manifest: {
        schemaVersion: 1,
        labelPrefix: 'com.ccm',
        units: {
          server: {
            label: 'com.ccm.server',
            plistPath: evil, // ← 被篡改
            sha256: sha(HANDWRITTEN_XML),
            template: 'desktop/launchd/server.plist.template',
          },
        },
      },
    });
    s.mgr.uninstall('server', { force: true, confirmed: true });
    assert.ok(s.fs.has(evil), '绝不能删 manifest 里指的那个无关文件');
    assert.equal(s.fs.has(SERVER_PLIST), false, '该删的是派生路径上的 plist');
  });

  // raw === null 有两种成因：文件不在（终态，放行）vs 文件在但读不出来（CAS 无从验证）。
  // 早前共用一个 null 分支，后者会让护栏静默失效 —— 而 unlink 只要父目录可写就能成。
  test('plist 在盘上却读不出来 → 拒绝删除（CAS 无从核对），除非 --force', () => {
    const s = setup({ objs: { [SERVER_PLIST]: HANDWRITTEN_OBJ } });
    s.mgr.install('server');
    // 文件存在但读不出：把 readFileRaw 的数据源清掉、fileExists 仍为真
    const seen = s.fs.get(SERVER_PLIST);
    s.fs.set(SERVER_PLIST, undefined); // Map.has 仍为 true，get 返回 undefined → readFileRaw 给 null
    assert.ok(seen !== undefined);

    const r = s.mgr.uninstall('server', { confirmed: true });
    assert.equal(r.ok, false);
    assert.match(r.error, /读不出来|--force/);
    assert.ok(s.fs.has(SERVER_PLIST), '拒绝时不能删');
  });

  test('文件本来就不在 → 照常放行（那就是我们要的终态）', () => {
    const s = setup({ objs: { [SERVER_PLIST]: HANDWRITTEN_OBJ } });
    s.mgr.install('server');
    s.fs.delete(SERVER_PLIST);
    assert.equal(s.mgr.uninstall('server', { confirmed: true }).ok, true);
  });
});

// ★ 2026-08-13 一次真实事故的产物：当时以「验证护栏会拒绝」为由在生产机器上跑了 uninstall，
// 而那个预期是错的（adopt 记的正是盘上那份的 sha，CAS 当然匹配），服务被真删了。
// 护栏放在 manager 层而不是 CLI 层：将来菜单栏 app 或任何调用方忘了确认也会被拒。
test.describe('uninstall —— 默认拒绝，必须显式确认', () => {
  test('不传 confirmed → 拒绝，且一个字节都不动', () => {
    const s = setup({ objs: { [SERVER_PLIST]: HANDWRITTEN_OBJ } });
    s.mgr.install('server');
    const before = s.fs.get(SERVER_PLIST);

    const r = s.mgr.uninstall('server');
    assert.equal(r.ok, false);
    assert.equal(r.needsConfirm, true);
    assert.match(r.error, /--yes|确认/);
    assert.equal(s.fs.get(SERVER_PLIST), before, 'plist 必须原样');
    assert.ok(s.manifestNow().units.server, 'manifest 条目也不能动');
  });

  test('confirmed: false 与不传等价（别让 falsy 值蒙混过去）', () => {
    const s = setup({ objs: { [SERVER_PLIST]: HANDWRITTEN_OBJ } });
    s.mgr.install('server');
    assert.equal(s.mgr.uninstall('server', { confirmed: false }).ok, false);
    assert.equal(s.mgr.uninstall('server', { confirmed: 'yes' }).ok, false, '只认严格 true');
    assert.equal(s.mgr.uninstall('server', { confirmed: 1 }).ok, false);
    assert.ok(s.fs.has(SERVER_PLIST));
  });

  test('--force 不能替代确认（两者管的是不同的事）', () => {
    const s = setup({ objs: { [SERVER_PLIST]: HANDWRITTEN_OBJ } });
    s.mgr.install('server');
    const r = s.mgr.uninstall('server', { force: true });
    assert.equal(r.ok, false, 'force 只越过 CAS，不代表用户确认了要卸载');
    assert.ok(s.fs.has(SERVER_PLIST));
  });
});

test.describe('resolveUninstallConfirm', () => {
  test('--yes → 确认', () => {
    assert.equal(resolveUninstallConfirm({ yes: true, isTty: false }).confirmed, true);
  });

  // 非 TTY 必须显式拒绝而不是回落到 readline：setup.js:10-14 记过那个坑 ——
  // agent shell 里 stdin 立刻 EOF，readline 的 promise 永不 settle，进程静默退出 0。
  test('非交互且无 --yes → 拒绝（不是静默通过，也不是挂住）', () => {
    const r = resolveUninstallConfirm({ yes: false, isTty: false });
    assert.equal(r.confirmed, false);
    assert.equal(r.reason, 'non-interactive');
  });

  test('交互终端里只有恰好答 y/yes 才算确认', () => {
    for (const a of ['y', 'Y', 'yes', 'YES', ' y \n']) {
      assert.equal(resolveUninstallConfirm({ isTty: true, answer: a }).confirmed, true, `应接受 ${JSON.stringify(a)}`);
    }
    for (const a of ['', 'n', 'no', '\n', 'yep', '是', null]) {
      assert.equal(resolveUninstallConfirm({ isTty: true, answer: a }).confirmed, false, `应拒绝 ${JSON.stringify(a)}`);
    }
  });
});

// ── install —— 已装但参数变了 ──────────────────────────────────────────────
//
// 2026-08-18 在机主真机上实测到的死循环：status 报「开机自启指向仓库构建产物」，照它给的
// 命令跑 `install menubar --app=/Applications/CCM.app`，CLI 回「已是目标状态，无需改动」，
// plist 纹丝不动，下一次 status 警告照旧。
//
// 根因：早退判据只看「manifest 有记录 + plist 在盘上 + launchd 认识它」三件事，完全不比对
// 内容，于是参数怎么变都判 already。这里不改成自动重写——那要连带 bootout + bootstrap，
// 风险面大于收益；按本文件既有风格（「盘上有、manifest 没有」那条分支）报错 + 指路。
test.describe('install —— 已装但参数变了', () => {
  const OLD_APP = `${REPO}/desktop/build/CCM.app`;

  // 让代码自己装一遍来生成 manifest，而不是手写一份结构（手写的会被 validateManifest 拒掉，
  // 于是测试实际测的是「不接管自定义启动方式」那条无关分支——同 148 行那条幂等用例的做法）。
  const installedMenubar = () => {
    // 两个候选路径都要在内存 fs 里：precheck 会判 .app 是否存在
    const env = setup({ files: { [OLD_APP]: 'bundle', '/Applications/CCM.app': 'bundle' } });
    const first = env.mgr.install('menubar', { app: OLD_APP });
    assert.equal(first.ok, true, `前置安装应成功：${first.error ?? ''}`);
    env.writes.length = 0; // 只关心第二次 install 有没有写
    return env;
  };

  test('--app 换成 /Applications → 不许报 already，要点名参数并给出出路', () => {
    const { mgr, manifestNow, writes } = installedMenubar();
    const r = mgr.install('menubar', { app: '/Applications/CCM.app' });

    assert.equal(r.ok, false, '参数变了却报成功，人会以为已经改好了');
    assert.match(r.error, /APP/, '要点名到底哪个参数不一致');
    assert.match(r.error, /uninstall/, '必须给出出路，否则就是死循环');
    assert.equal(manifestNow().units.menubar.vars.APP, OLD_APP, '报错路径一个字节都不该写');
    assert.deepEqual(writes, [], '报错路径不该有任何写操作');
  });

  test('参数完全相同 → 仍然 already（幂等不能被这条检查破坏）', () => {
    const { mgr } = installedMenubar();
    const r = mgr.install('menubar', { app: OLD_APP });
    assert.equal(r.ok, true);
    assert.equal(r.action, 'already');
  });
});
