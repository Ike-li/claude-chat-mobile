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
  describeSchedule,
  diffUnitSemantics,
  extractSchedule,
  extractUnitFacts,
  isSupervised,
  labelFor,
  willBeRespawned,
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

// 同一份配置，但走 desktop/launchd/server.plist.template + render-plist.js 的产物（路径带双引号）。
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
  // ★ 这里**不再产出 flapping**。早前用「最后一次退出码 ≠ 0」判它，而那是瞬时值：
  // 机主的隧道恒为 -9（自建看门狗每天按 DHCP 漂移 kickstart -k 一次），于是每天误报。
  // flapping 改由 service-events.js 按重启频率判定，见那个文件的测试。
  test('未安装：plist 不存在时压过一切', () => {
    assert.deepEqual(
      classifyState({ pid: null, lastExit: 0, plistExists: false }),
      { state: 'not-installed', lastExitAbnormal: false, loaded: null }
    );
  });

  test('running：有 PID', () => {
    assert.deepEqual(
      classifyState({ pid: 26867, lastExit: 0, plistExists: true }),
      { state: 'running', lastExitAbnormal: false, loaded: null }
    );
  });

  test('有 PID 且上次异常退出 → 仍是 running，只记下 lastExitAbnormal', () => {
    assert.deepEqual(
      classifyState({ pid: 62368, lastExit: -9, plistExists: true }),
      { state: 'running', lastExitAbnormal: true, loaded: null },
      '「在跑」与「上次怎么退出的」是两件事，后者不单独用来下告警结论'
    );
  });

  test('crashed：无 PID 且上次异常退出', () => {
    assert.deepEqual(
      classifyState({ pid: null, lastExit: 1, plistExists: true }),
      { state: 'crashed', lastExitAbnormal: true, loaded: null }
    );
  });

  test('stopped：无 PID 且上次正常退出（定时器 unit 的常态）', () => {
    assert.deepEqual(
      classifyState({ pid: null, lastExit: 0, plistExists: true }),
      { state: 'stopped', lastExitAbnormal: false, loaded: null }
    );
  });

  test('plist 存在但 launchctl 里查无此条 → stopped（已落盘未 bootstrap）', () => {
    assert.deepEqual(
      classifyState({ pid: null, lastExit: null, plistExists: true }),
      { state: 'stopped', lastExitAbnormal: false, loaded: null }
    );
  });

  // ★ plistExists=false 不只意味着「文件不在」：readPlistFile 在 plutil 非零退出**或 5s 超时**时
  // 也返回 null（且不发警告）。拿「没装」去解释一个明明有 pid 的进程是明显错的，而它会级联——
  // doctor D16 对着正在跑的 server 警告「桌面端服务未安装」，D4 因 resolveServicePortOwner
  // 要求 state==='running' 而把 3000 端口报成被外来进程占用（fail），菜单栏则藏掉启停项改显「安装」。
  // ★★ 「文件不在」与「plutil 读不出来」是两件事，不能给它们选同一个赢家。
  //   · 文件真被删了（git clean / 手滑）→ 开机自启已经死了。进程还在只是上次启动的残留，
  //     重启后就没了 —— 这个事实必须现在就说出来（doctor D16 warn、菜单栏给「安装」入口）。
  //     早前一版让 pid 压过一切，把这个 warn 变成了 ok，而且菜单栏会显示三个点了必然
  //     报错的按钮（guardControllable 仍要求 plist 在）。那正是 1158e7a 修的那类盲区。
  //   · 文件在、只是 plutil 非零退出或 5s 超时 → 那是读取故障，不是「没装」。有 pid 就是在跑。
  test('★★ plist 文件真的不在 → not-installed，即便进程还活着', () => {
    const r = classifyState({ pid: 4321, lastExit: 0, plistExists: false, plistFileExists: false });
    assert.equal(r.state, 'not-installed', '开机自启已死，不能因为残留进程还在就报绿');
  });

  test('★★ 文件在、只是 plutil 读不出来 → 有 pid 就是 running', () => {
    const r = classifyState({ pid: 4321, lastExit: 0, plistExists: false, plistFileExists: true });
    assert.equal(r.state, 'running', 'plutil 抽风不该让正在跑的服务被判成「未安装」');
  });

  test('文件在、读不出来、也没 pid → stopped 而不是 not-installed（文件在就不是没装）', () => {
    const r = classifyState({ pid: null, lastExit: 0, plistExists: false, plistFileExists: true });
    assert.equal(r.state, 'stopped');
  });

  test('调用方没传 plistFileExists（旧签名）→ 回落旧行为，不静默改判', () => {
    assert.equal(classifyState({ pid: 4321, plistExists: false }).state, 'not-installed');
    assert.equal(classifyState({ pid: null, plistExists: false }).state, 'not-installed');
  });

  // ★ 「plist 在磁盘上」与「launchd 域里还有这个 job」是两件事。被 bootout 之后定时器永远不会
  // 再触发，而旧实现和正常待机渲染成同一行「idle · 待机 · 每天 03:47」——日志轮转死了没人看得出来。
  test('★ 已 bootout 与「装着待机」必须可区分', () => {
    const bootedOut = classifyState({ pid: null, lastExit: null, plistExists: true, loaded: false });
    const idle = classifyState({ pid: null, lastExit: null, plistExists: true, loaded: true });
    assert.equal(bootedOut.loaded, false, '已从 launchd 卸载：定时不会再触发');
    assert.equal(idle.loaded, true);
    assert.notDeepEqual(bootedOut, idle, '两者不能塌成同一个判定');
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
        template: 'desktop/launchd/server.plist.template',
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
  const XPC = 'com.ccm.server';

  // macOS 需要**结构 + 形态**两个条件。两条单独用都被实测推翻过，见实现的头注。
  test('launchd 托管：ppid=1 且 XPC 是真实 service 名 → true', () => {
    assert.equal(isSupervised({ ppid: 1, platform: 'darwin', env: { XPC_SERVICE_NAME: XPC } }), true);
  });

  test('★ 孤儿进程：ppid=1 但 XPC 继承自终端 → false（nohup / disown / 关掉启动它的终端）', () => {
    assert.equal(
      isSupervised({ ppid: 1, platform: 'darwin', env: { XPC_SERVICE_NAME: '0' } }),
      false,
      'ppid=1 也可能是被 init 收养的孤儿，它根本没人拉起'
    );
    assert.equal(
      isSupervised({ ppid: 1, platform: 'darwin', env: { XPC_SERVICE_NAME: 'application.com.apple.Terminal.1.2' } }),
      false,
      'GUI app 的子进程会继承 application.*'
    );
    assert.equal(isSupervised({ ppid: 1, platform: 'darwin', env: {} }), false, '没有 XPC 标签同样不算');
  });

  test('★ 前台 npm start：XPC 像样但 ppid 不是 1 → false', () => {
    assert.equal(
      isSupervised({ ppid: 67233, platform: 'darwin', env: { XPC_SERVICE_NAME: XPC } }),
      false,
      '环境变量可继承，父进程不是 launchd 就不算受管'
    );
  });

  // Linux 完全不看 ppid：容器里入口是 shell wrapper 时 node 的 ppid 就是 1（实测）。
  test('Linux 容器：ppid=1 但无 systemd 信号 → false', () => {
    assert.equal(isSupervised({ ppid: 1, platform: 'linux', env: {} }), false);
  });

  test('Linux + systemd 信号 → true（systemctl --user 的 ppid 不是 1）', () => {
    assert.equal(isSupervised({ ppid: 900, platform: 'linux', env: { INVOCATION_ID: 'abc' } }), true);
    assert.equal(isSupervised({ ppid: 900, platform: 'linux', env: { JOURNAL_STREAM: '8:1' } }), true);
  });

  test('空串按未设置处理', () => {
    assert.equal(isSupervised({ ppid: 1, platform: 'darwin', env: { XPC_SERVICE_NAME: '   ' } }), false);
    assert.equal(isSupervised({ ppid: 900, platform: 'linux', env: { INVOCATION_ID: '  ' } }), false);
  });

  test('无参调用不抛错（读真实 process）', () => {
    assert.equal(typeof isSupervised(), 'boolean');
  });
});

// ── 调度形态：stopped 到底是故障还是待机 ──────────────────────────────────
//
// launchd 眼里「此刻没有进程」只有一个词 —— stopped。但那对 KeepAlive 常驻服务是故障信号，
// 对定时器/打火即退任务是**健康待机**。同一个枚举值承载两种相反含义，UI 只能靠 unit 名字猜，
// 于是 default 分支必然漏掉没被硬编码的 unit：机主自建的 com.ccm.tunnel-watch 每 30s 救一次
// 隧道，面板照样标「已停止」，机主本人因此来问过「这个要启用吗」。
//
// 判据不该是名字表，而是 plist 里本来就写着的事实。**刻意不走 extractUnitFacts**：那个函数
// 对不在 UNITS 表里的 unit 直接抛错，而最需要这个判断的恰恰是 unknown unit。
test.describe('extractSchedule —— 从 plist 读「它期望常驻吗」', () => {
  test('KeepAlive true → resident（这种 stopped 是真故障）', () => {
    assert.deepEqual(extractSchedule({ KeepAlive: true }), { kind: 'resident' });
  });

  test('KeepAlive 是字典（launchd 允许 {SuccessfulExit:false}）同样算 resident', () => {
    assert.deepEqual(extractSchedule({ KeepAlive: { SuccessfulExit: false } }), { kind: 'resident' });
  });

  test('StartInterval → periodic 并带上秒数（tunnel-watch 就是 30）', () => {
    assert.deepEqual(extractSchedule({ StartInterval: 30, RunAtLoad: true }), { kind: 'periodic', everySeconds: 30 });
  });

  test('StartCalendarInterval → periodic 并带上时刻（logrotate 每天 03:47）', () => {
    assert.deepEqual(
      extractSchedule({ StartCalendarInterval: { Hour: 3, Minute: 47 } }),
      { kind: 'periodic', calendar: { Hour: 3, Minute: 47 } },
    );
  });

  test('只有 RunAtLoad → on-demand（menubar：登录时打一枪即退）', () => {
    assert.deepEqual(extractSchedule({ RunAtLoad: true, KeepAlive: false }), { kind: 'on-demand' });
  });

  test('什么都没有 → unknown，绝不擅自说成待机', () => {
    assert.deepEqual(extractSchedule({}), { kind: 'unknown' });
    assert.deepEqual(extractSchedule(null), { kind: 'unknown' });
  });

  // KeepAlive 与 StartInterval 同时写时以 KeepAlive 为准：launchd 会一直保活，
  // 那个 interval 实际不起作用，报成 periodic 会把真故障说成待机。
  test('KeepAlive 优先于 StartInterval（真常驻的 stopped 不能被说成待机）', () => {
    assert.equal(extractSchedule({ KeepAlive: true, StartInterval: 30 }).kind, 'resident');
  });
});

test.describe('describeSchedule —— 待机说明由事实算出，不是硬编码时刻', () => {
  test('秒级间隔', () => {
    assert.equal(describeSchedule({ kind: 'periodic', everySeconds: 30 }), '待机 · 每 30 秒触发');
  });

  test('分钟级间隔换算成分钟，别让人读「每 3600 秒」', () => {
    assert.equal(describeSchedule({ kind: 'periodic', everySeconds: 300 }), '待机 · 每 5 分钟触发');
    assert.equal(describeSchedule({ kind: 'periodic', everySeconds: 3600 }), '待机 · 每 60 分钟触发');
  });

  // 硬编码「每天 03:47」的问题：模板改了时刻，文案不会跟着变。从 plist 算就不会漂。
  test('日历时刻补零成 HH:MM', () => {
    assert.equal(describeSchedule({ kind: 'periodic', calendar: { Hour: 3, Minute: 47 } }), '待机 · 每天 03:47');
    assert.equal(describeSchedule({ kind: 'periodic', calendar: { Hour: 0, Minute: 5 } }), '待机 · 每天 00:05');
  });

  test('日历只给了小时 → 只说小时那一档，不编造分钟', () => {
    assert.equal(describeSchedule({ kind: 'periodic', calendar: { Hour: 3 } }), '待机 · 每天 03:00');
    assert.equal(describeSchedule({ kind: 'periodic', calendar: { Minute: 15 } }), '待机 · 每小时第 15 分');
  });

  test('on-demand / resident / unknown', () => {
    assert.equal(describeSchedule({ kind: 'on-demand' }), '随登录自启');
    assert.equal(describeSchedule({ kind: 'resident' }), null, 'resident 的 stopped 是故障，没有待机说法');
    assert.equal(describeSchedule({ kind: 'unknown' }), null);
    assert.equal(describeSchedule(null), null);
  });
});

test('willBeRespawned：判据是「退出后有人拉起」——托管或 npm run dev 的 watch；DEV_MODE 不算数', () => {
  // launchd 托管：KeepAlive 拉起
  assert.equal(willBeRespawned({ supervised: true, npmLifecycleEvent: 'start' }), true);
  // npm run dev：node --watch 拉起（watch 无法从子进程自证，认 npm_lifecycle_event）
  assert.equal(willBeRespawned({ supervised: false, npmLifecycleEvent: 'dev' }), true);
  // 前台 npm start：退出即死——2026-08-19 真机上 DEV_MODE=1 时假成功真死亡的那条路
  assert.equal(willBeRespawned({ supervised: false, npmLifecycleEvent: 'start' }), false);
  assert.equal(willBeRespawned({ supervised: false, npmLifecycleEvent: undefined }), false);
});
