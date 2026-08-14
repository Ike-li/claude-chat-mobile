// tests/unit/service-units.test.mjs —— src/ops/service-units.js 单测（LaunchAgent 服务管理纯逻辑）
//
// 本文件的核心是「语义等价 ≠ 字节相等」那一组用例：手写的 plist 与模板渲染结果**必然**字节不同
// （模板正文有行内注释、给路径加了双引号），若漂移判定用 sha256 就会把正在跑的生产 unit 判成陌生
// unit —— 那正是最该避免的失败模式。见 describe('diffUnitSemantics') 的说明。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LABEL_PREFIX,
  SERVICE_UNIT_NAMES,
  classifyOwnership,
  classifyState,
  diffUnitSemantics,
  extractUnitFacts,
  isSupervised,
  labelFor,
  parseLaunchctlList,
  renderVarsFor,
  unitFromLabel,
  validateManifest,
} from '../../src/ops/service-units.js';

// 机主机器上实测的 plutil -convert json 输出形状（路径已换成 /Users/you，见 identity 清洗纪律）。
// 关键特征：ProgramArguments[2] 里的路径**没有**双引号，而模板渲染出来的**有**。
const HANDWRITTEN_SERVER_PLIST = {
  Label: 'com.ccm.server',
  ProgramArguments: [
    '/bin/zsh',
    '-lc',
    'cd /Users/you/code/claude-chat-mobile && exec /opt/homebrew/bin/node server.js',
  ],
  RunAtLoad: true,
  KeepAlive: true,
  StandardOutPath: '/Users/you/Library/Logs/ccm-server.log',
  StandardErrorPath: '/Users/you/Library/Logs/ccm-server.log',
};

// 同一份配置，但走 deploy/server.plist.template + render-plist.js 的产物（路径带双引号）。
const RENDERED_SERVER_PLIST = {
  ...HANDWRITTEN_SERVER_PLIST,
  ProgramArguments: [
    '/bin/zsh',
    '-lc',
    'cd "/Users/you/code/claude-chat-mobile" && exec "/opt/homebrew/bin/node" server.js',
  ],
};

const CTX = {
  repo: '/Users/you/code/claude-chat-mobile',
  node: '/opt/homebrew/bin/node',
  home: '/Users/you',
  labelPrefix: DEFAULT_LABEL_PREFIX,
};

test.describe('label 计算', () => {
  test('默认前缀是 com.ccm（机主既有安装用的就是它，换前缀会认不出来）', () => {
    assert.equal(DEFAULT_LABEL_PREFIX, 'com.ccm');
  });

  test('labelFor 拼接 unit 名', () => {
    assert.equal(labelFor('server', 'com.ccm'), 'com.ccm.server');
    assert.equal(labelFor('logrotate', 'com.ccm'), 'com.ccm.logrotate');
  });

  test('unitFromLabel 反解析已知 unit', () => {
    assert.equal(unitFromLabel('com.ccm.server', 'com.ccm'), 'server');
    assert.equal(unitFromLabel('com.ccm.tunnel', 'com.ccm'), 'tunnel');
  });

  test('前缀命中但不是已知 unit → null（如机主自建的 tunnel-watch）', () => {
    assert.equal(unitFromLabel('com.ccm.tunnel-watch', 'com.ccm'), null);
  });

  test('前缀不命中 → null', () => {
    assert.equal(unitFromLabel('io.beszel.hub', 'com.ccm'), null);
  });

  test('已知 unit 集合含四个', () => {
    assert.deepEqual([...SERVICE_UNIT_NAMES].sort(), ['logrotate', 'menubar', 'server', 'tunnel']);
  });
});

test.describe('parseLaunchctlList', () => {
  // 实测格式：PID \t LastExitStatus \t Label，首行是表头，未运行的 PID 是 '-'
  const TSV = [
    'PID\tStatus\tLabel',
    '26867\t0\tcom.ccm.server',
    '62368\t-9\tcom.ccm.tunnel',
    '-\t0\tcom.ccm.logrotate',
    '-\t0\tcom.ccm.tunnel-watch',
    '750\t0\tio.beszel.tunnel.mac-mini',
  ].join('\n');

  test('解析出 pid 与 lastExit', () => {
    const map = parseLaunchctlList(TSV);
    assert.deepEqual(map.get('com.ccm.server'), { pid: 26867, lastExit: 0 });
    assert.deepEqual(map.get('com.ccm.tunnel'), { pid: 62368, lastExit: -9 });
  });

  test('未运行的 - 解析成 pid=null', () => {
    const map = parseLaunchctlList(TSV);
    assert.deepEqual(map.get('com.ccm.logrotate'), { pid: null, lastExit: 0 });
  });

  test('跳过表头行', () => {
    assert.equal(parseLaunchctlList(TSV).has('Label'), false);
  });

  test('空输入返回空 Map 而非抛错', () => {
    assert.equal(parseLaunchctlList('').size, 0);
    assert.equal(parseLaunchctlList(null).size, 0);
  });
});

test.describe('classifyState', () => {
  test('未安装：plist 不存在时压过一切', () => {
    assert.deepEqual(
      classifyState({ pid: null, lastExit: 0, plistExists: false }),
      { state: 'not-installed', flapping: false }
    );
  });

  test('running：有 PID 且上次正常退出', () => {
    assert.deepEqual(
      classifyState({ pid: 26867, lastExit: 0, plistExists: true }),
      { state: 'running', flapping: false }
    );
  });

  // 这一档最容易漏：机主的 com.ccm.tunnel 就在这里 —— 有 PID（KeepAlive 拉起来了）
  // 但 LastExitStatus=-9（被 SIGKILL 过）。只看 PID 会一直显绿灯，而它其实在反复崩溃重启。
  test('running + flapping：有 PID 但上次异常退出（崩过又被 KeepAlive 拉起）', () => {
    assert.deepEqual(
      classifyState({ pid: 62368, lastExit: -9, plistExists: true }),
      { state: 'running', flapping: true }
    );
  });

  test('crashed：无 PID 且上次异常退出', () => {
    assert.deepEqual(
      classifyState({ pid: null, lastExit: 1, plistExists: true }),
      { state: 'crashed', flapping: false }
    );
  });

  test('stopped：无 PID 且上次正常退出（定时器 unit 的常态）', () => {
    assert.deepEqual(
      classifyState({ pid: null, lastExit: 0, plistExists: true }),
      { state: 'stopped', flapping: false }
    );
  });

  test('plist 存在但 launchctl 里查无此条 → stopped（已落盘未 bootstrap）', () => {
    assert.deepEqual(
      classifyState({ pid: null, lastExit: null, plistExists: true }),
      { state: 'stopped', flapping: false }
    );
  });
});

test.describe('extractUnitFacts', () => {
  test('server：从 zsh -lc 命令串里提取 repo 与 node（无引号形态）', () => {
    const facts = extractUnitFacts('server', HANDWRITTEN_SERVER_PLIST);
    assert.equal(facts.repo, '/Users/you/code/claude-chat-mobile');
    assert.equal(facts.node, '/opt/homebrew/bin/node');
  });

  test('server：带双引号形态提取出**相同**的值（引号是 shell 语法不是路径的一部分）', () => {
    const facts = extractUnitFacts('server', RENDERED_SERVER_PLIST);
    assert.equal(facts.repo, '/Users/you/code/claude-chat-mobile');
    assert.equal(facts.node, '/opt/homebrew/bin/node');
  });

  test('server：路径含空格且带引号时不被切断', () => {
    const facts = extractUnitFacts('server', {
      ...HANDWRITTEN_SERVER_PLIST,
      ProgramArguments: ['/bin/zsh', '-lc', 'cd "/Users/you/My Code/repo" && exec "/opt/homebrew/bin/node" server.js'],
    });
    assert.equal(facts.repo, '/Users/you/My Code/repo');
  });

  test('server：提取 RunAtLoad / KeepAlive / 日志路径', () => {
    const facts = extractUnitFacts('server', HANDWRITTEN_SERVER_PLIST);
    assert.equal(facts.runAtLoad, true);
    assert.equal(facts.keepAlive, true);
    assert.equal(facts.log, '/Users/you/Library/Logs/ccm-server.log');
  });

  test('logrotate：从 /bin/bash <repo>/scripts/rotate-logs.sh 提取 repo', () => {
    const facts = extractUnitFacts('logrotate', {
      Label: 'com.ccm.logrotate',
      ProgramArguments: ['/bin/bash', '/Users/you/code/claude-chat-mobile/scripts/rotate-logs.sh'],
      RunAtLoad: false,
      StandardOutPath: '/Users/you/Library/Logs/ccm-logrotate.log',
      StandardErrorPath: '/Users/you/Library/Logs/ccm-logrotate.log',
    });
    assert.equal(facts.repo, '/Users/you/code/claude-chat-mobile');
  });

  test('tunnel：从 cloudflared tunnel run <name> 提取二进制与隧道名', () => {
    const facts = extractUnitFacts('tunnel', {
      Label: 'com.ccm.tunnel',
      ProgramArguments: ['/opt/homebrew/bin/cloudflared', 'tunnel', 'run', 'my-tunnel'],
      RunAtLoad: true,
      KeepAlive: true,
      StandardOutPath: '/Users/you/Library/Logs/ccm-tunnel.log',
      StandardErrorPath: '/Users/you/Library/Logs/ccm-tunnel.log',
    });
    assert.equal(facts.cloudflared, '/opt/homebrew/bin/cloudflared');
    assert.equal(facts.tunnel, 'my-tunnel');
  });

  test('形态对不上（用户整个换掉了 ProgramArguments）→ 事实为 null 而非抛错', () => {
    const facts = extractUnitFacts('server', {
      Label: 'com.ccm.server',
      ProgramArguments: ['/usr/local/bin/pm2', 'start', 'server.js'],
    });
    assert.equal(facts.repo, null);
    assert.equal(facts.node, null);
  });

  test('plist 对象为空 → 全 null，不抛错', () => {
    const facts = extractUnitFacts('server', null);
    assert.equal(facts.repo, null);
  });
});

test.describe('diffUnitSemantics', () => {
  // 本方案最关键的一条：机主手写的 plist 与模板渲染结果**字节必然不同**（模板正文有行内注释、
  // 路径带双引号），任何基于 sha256 的判定都会把正在跑的生产 unit 判成陌生 unit。
  // 判据必须落在「提取出的路径值」这一层。
  test('手写 plist 对模板渲染结果判零漂移（引号差异不算漂移）', () => {
    const expected = extractUnitFacts('server', RENDERED_SERVER_PLIST);
    const actual = extractUnitFacts('server', HANDWRITTEN_SERVER_PLIST);
    assert.deepEqual(diffUnitSemantics('server', expected, actual), []);
  });

  test('仓库被移动 → repo-path 漂移', () => {
    const expected = extractUnitFacts('server', RENDERED_SERVER_PLIST);
    const actual = extractUnitFacts('server', {
      ...HANDWRITTEN_SERVER_PLIST,
      ProgramArguments: ['/bin/zsh', '-lc', 'cd /Users/you/old/repo && exec /opt/homebrew/bin/node server.js'],
    });
    assert.deepEqual(diffUnitSemantics('server', expected, actual), ['repo-path']);
  });

  test('node 换版本（nvm 切换）→ node-path 漂移', () => {
    const expected = extractUnitFacts('server', RENDERED_SERVER_PLIST);
    const actual = extractUnitFacts('server', {
      ...HANDWRITTEN_SERVER_PLIST,
      ProgramArguments: ['/bin/zsh', '-lc', 'cd /Users/you/code/claude-chat-mobile && exec /Users/you/.nvm/versions/node/v20.11.0/bin/node server.js'],
    });
    assert.deepEqual(diffUnitSemantics('server', expected, actual), ['node-path']);
  });

  test('用户关掉了 KeepAlive → keepalive 漂移（这是有意的配置改动，要报出来别默默覆盖）', () => {
    const expected = extractUnitFacts('server', RENDERED_SERVER_PLIST);
    const actual = extractUnitFacts('server', { ...HANDWRITTEN_SERVER_PLIST, KeepAlive: false });
    assert.deepEqual(diffUnitSemantics('server', expected, actual), ['keepalive']);
  });

  test('日志路径不同 → log-path 漂移', () => {
    const expected = extractUnitFacts('server', RENDERED_SERVER_PLIST);
    const actual = extractUnitFacts('server', {
      ...HANDWRITTEN_SERVER_PLIST,
      StandardOutPath: '/tmp/other.log',
      StandardErrorPath: '/tmp/other.log',
    });
    assert.deepEqual(diffUnitSemantics('server', expected, actual), ['log-path']);
  });

  test('多项同时漂移时全部列出（顺序稳定，便于断言与展示）', () => {
    const expected = extractUnitFacts('server', RENDERED_SERVER_PLIST);
    const actual = extractUnitFacts('server', {
      ...HANDWRITTEN_SERVER_PLIST,
      ProgramArguments: ['/bin/zsh', '-lc', 'cd /Users/you/old && exec /usr/bin/node server.js'],
      KeepAlive: false,
    });
    assert.deepEqual(diffUnitSemantics('server', expected, actual), ['repo-path', 'node-path', 'keepalive']);
  });

  test('形态完全不认识（提取不出事实）→ 报 shape 漂移，不假装零漂移', () => {
    const expected = extractUnitFacts('server', RENDERED_SERVER_PLIST);
    const actual = extractUnitFacts('server', { Label: 'com.ccm.server', ProgramArguments: ['/usr/local/bin/pm2', 'start'] });
    assert.deepEqual(diffUnitSemantics('server', expected, actual), ['shape']);
  });
});

test.describe('renderVarsFor', () => {
  test('server 需要 LABEL/REPO/NODE/LOG', () => {
    const vars = renderVarsFor('server', CTX);
    assert.deepEqual(Object.keys(vars).sort(), ['LABEL', 'LOG', 'NODE', 'REPO']);
    assert.equal(vars.LABEL, 'com.ccm.server');
    assert.equal(vars.REPO, '/Users/you/code/claude-chat-mobile');
    assert.equal(vars.NODE, '/opt/homebrew/bin/node');
    assert.equal(vars.LOG, '/Users/you/Library/Logs/ccm-server.log');
  });

  test('logrotate 不需要 NODE（模板里没有该占位符）', () => {
    const vars = renderVarsFor('logrotate', CTX);
    assert.deepEqual(Object.keys(vars).sort(), ['LABEL', 'LOG', 'REPO']);
  });

  test('未知 unit 抛错（防止拼错 unit 名静默渲染出半份 plist）', () => {
    assert.throws(() => renderVarsFor('nope', CTX), /未知 unit/);
  });
});

test.describe('classifyOwnership', () => {
  test('manifest 有记录且无漂移 → managed', () => {
    assert.equal(
      classifyOwnership({ knownUnit: true, plistExists: true, inManifest: true, drift: [] }),
      'managed'
    );
  });

  test('manifest 有记录但已漂移 → 仍是 managed（漂移是正交维度，不改归属）', () => {
    assert.equal(
      classifyOwnership({ knownUnit: true, plistExists: true, inManifest: true, drift: ['repo-path'] }),
      'managed'
    );
  });

  // 机主的 com.ccm.server / tunnel / logrotate 都落在这一档：手工装的、语义等价、可安全接管。
  test('无 manifest 但语义等价 → adoptable', () => {
    assert.equal(
      classifyOwnership({ knownUnit: true, plistExists: true, inManifest: false, drift: [] }),
      'adoptable'
    );
  });

  test('无 manifest 且语义不等价 → foreign（用户自己改过，绝不覆写）', () => {
    assert.equal(
      classifyOwnership({ knownUnit: true, plistExists: true, inManifest: false, drift: ['keepalive'] }),
      'foreign'
    );
  });

  // 机主的 com.ccm.tunnel-watch：前缀命中但模板里没这个 unit。
  test('前缀命中但不是已知 unit → unknown', () => {
    assert.equal(
      classifyOwnership({ knownUnit: false, plistExists: true, inManifest: false, drift: [] }),
      'unknown'
    );
  });

  test('plist 不存在 → managed 记录也降级为 adoptable 之外的 not-installed 语义由 state 表达，归属仍看 manifest', () => {
    assert.equal(
      classifyOwnership({ knownUnit: true, plistExists: false, inManifest: true, drift: [] }),
      'managed'
    );
  });
});

test.describe('validateManifest', () => {
  const VALID = {
    schemaVersion: 1,
    labelPrefix: 'com.ccm',
    units: {
      server: {
        label: 'com.ccm.server',
        plistPath: '/Users/you/Library/LaunchAgents/com.ccm.server.plist',
        sha256: 'a'.repeat(64),
        template: 'deploy/server.plist.template',
        vars: { LABEL: 'com.ccm.server', REPO: '/Users/you/code/repo', NODE: '/opt/homebrew/bin/node', LOG: '/x.log' },
        installedAt: 1786000000000,
        adopted: false,
      },
    },
  };

  test('合法 manifest 原样通过', () => {
    assert.deepEqual(validateManifest(VALID), VALID);
  });

  test('非对象 / 坏 JSON 结果 → 返回空 manifest 而非抛错（读不懂就当没装过，不阻断 status）', () => {
    assert.deepEqual(validateManifest(null), { schemaVersion: 1, labelPrefix: 'com.ccm', units: {} });
    assert.deepEqual(validateManifest('nope'), { schemaVersion: 1, labelPrefix: 'com.ccm', units: {} });
  });

  test('未知 schemaVersion → 丢弃 units（宁可退回 adoptable 也不按错格式解读）', () => {
    const out = validateManifest({ ...VALID, schemaVersion: 99 });
    assert.deepEqual(out.units, {});
  });

  test('丢弃形状不合法的条目，保留合法的', () => {
    const out = validateManifest({
      ...VALID,
      units: { ...VALID.units, tunnel: { label: 123 } },
    });
    assert.ok(out.units.server, '合法条目应保留');
    assert.equal(out.units.tunnel, undefined, '非法条目应丢弃');
  });
});

// 「这个进程是不是被进程管理器托管的」——决定 web 端能否触发重启。
//
// 现状 (app.js:2594) 只认 DEV_MODE=1，同时**太紧也太松**：
//   太紧：生产常驻部署改完配置没法从手机重启，「手机上改配置」这条路断在最后一步
//   太松：DEV_MODE=1 时前台 npm start 也能被停掉，然后**永远起不来**（没有 KeepAlive 拉它）
// 判据实测（2026-08-13，ps eww 26867）：launchd 会给托管进程注入 XPC_SERVICE_NAME=com.ccm.server。
test.describe('isSupervised', () => {
  // 判据是**结构性**的：launchd 托管时 plist 用 `exec node server.js`（zsh 被替换掉），
  // 所以 node 的父进程直接是 launchd(1)。实测本机 server 进程 ppid 确为 1。
  //
  // ★ 为什么不用 XPC_SERVICE_NAME：早前那版判「非空且 !== '0'」是错的。实测扫全机 82 个进程，
  //   GUI app（LaunchServices 启动）的子进程继承的是 application.<bundleid>.<n>.<n> 并原样往下传，
  //   不会被改写成 "0"（Chrome / 网易云 / codex 三个独立样本）。也就是说从 Terminal.app 手动
  //   npm start，node 会拿到 application.com.apple.Terminal.* → 被误判成受管 → web 端能停掉一个
  //   没有 KeepAlive 会拉它的进程。当初那次「实测」只在 ccm server 自己 spawn 的 shell 上取过样，
  //   而那条链恰好会被重写成 "0" —— 单点采样得出的分布结论。
  test('ppid=1 → true（launchd 直属；本机 server 进程实测 ppid=1）', () => {
    assert.equal(isSupervised({ ppid: 1, platform: 'darwin' }), true);
  });

  test('前台 npm start → false（ppid 是 npm/shell，停了就再也起不来）', () => {
    assert.equal(isSupervised({ ppid: 67233, platform: 'darwin' }), false);
  });

  test('★ 从 Terminal.app 启动、继承了 application.* 的进程 → false', () => {
    assert.equal(
      isSupervised({ ppid: 500, platform: 'darwin', env: { XPC_SERVICE_NAME: 'application.com.apple.Terminal.123.456' } }),
      false,
      'GUI app 的子进程会继承 application.*，绝不能据此判受管'
    );
  });

  test('★ macOS 上任何 XPC_SERVICE_NAME 都不足以判受管（含 agent label 形态）', () => {
    assert.equal(
      isSupervised({ ppid: 500, platform: 'darwin', env: { XPC_SERVICE_NAME: 'com.ccm.server' } }),
      false,
      'ppid 不是 1 就不是 launchd 直属，环境变量可继承、不可作数'
    );
  });

  // systemd --user（docs/deployment.md:30 推荐的 Linux 形态）的 ppid 是 systemd --user 而非 1，
  // 只能靠 systemd 自己注入的信号。
  test('Linux + INVOCATION_ID → true（systemd --user，ppid 不是 1）', () => {
    assert.equal(isSupervised({ ppid: 900, platform: 'linux', env: { INVOCATION_ID: 'abc' } }), true);
    assert.equal(isSupervised({ ppid: 900, platform: 'linux', env: { JOURNAL_STREAM: '8:1' } }), true);
  });

  test('Linux 前台跑 → false', () => {
    assert.equal(isSupervised({ ppid: 900, platform: 'linux', env: {} }), false);
  });

  test('空串按未设置处理', () => {
    assert.equal(isSupervised({ ppid: 900, platform: 'linux', env: { INVOCATION_ID: '  ' } }), false);
  });

  test('无参调用不抛错（读真实 process）', () => {
    assert.equal(typeof isSupervised(), 'boolean');
  });
});
