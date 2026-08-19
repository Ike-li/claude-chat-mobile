// tests/unit/render-plist.test.mjs —— scripts/render-plist.js 单测（审计 TC-009）
// 覆盖：XML 转义、字面量占位符替换对 sed 特殊字符（&/#）与空格的免疫、CLI 参数解析。
import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeXml, parseKeyValueArgs, renderTemplate, stripLeadingComment } from '../../scripts/render-plist.js';
// 转义与解析必须成对验证：只测渲染侧看不出「解析回来多了几个反斜杠」这种恒久漂移。
import { diffUnitSemantics, extractUnitFacts } from '../../src/ops/service-units.js';

test.describe('escapeXml', () => {
  test('转义 & < >', () => {
    assert.equal(escapeXml('AT&T <repo>'), 'AT&amp;T &lt;repo&gt;');
  });

  test('无特殊字符原样返回', () => {
    assert.equal(escapeXml('/Users/you/code/repo'), '/Users/you/code/repo');
  });

  test('非字符串值先转字符串', () => {
    assert.equal(escapeXml(123), '123');
  });
});

test.describe('parseKeyValueArgs', () => {
  test('解析 KEY=VALUE 列表', () => {
    assert.deepEqual(
      parseKeyValueArgs(['LABEL=com.you.ccm-server', 'REPO=/Users/you/code/repo']),
      { LABEL: 'com.you.ccm-server', REPO: '/Users/you/code/repo' }
    );
  });

  test('VALUE 本身含 = 时只按第一个 = 切分', () => {
    assert.deepEqual(parseKeyValueArgs(['LOG=/path/a=b.log']), { LOG: '/path/a=b.log' });
  });

  test('缺少 = 的参数抛错', () => {
    assert.throws(() => parseKeyValueArgs(['NOTKEYVALUE']), /KEY=VALUE/);
  });
});

// ★ escapeXml 管的是 XML 层。而 server 模板里那一行是 `/bin/zsh -lc 'cd "__REPO__" && …'`
// —— 占位符落在 **zsh 双引号串**里，那里 `$`、反引号、`\` 仍然会被 shell 解释。
// 后果不是报错而是静默走偏：`/Users/x/code/my$proj` 渲染出去，zsh 执行的是 `cd "/Users/x/code/my"`，
// bootstrap 照样成功（launchctl 只管加载 plist），然后 node 起不来、KeepAlive 无限重启循环，
// 而 CLI 只会说一句「重启后未能确认新进程」。
// 这与本文件开头那条 TC-009 是同一个错误的下一层：sed 那层修好了，shell 这层还漏着。
test.describe('__SHQ_KEY__ —— shell 双引号上下文的占位符', () => {
  const tpl = '<string>cd "__SHQ_REPO__" &amp;&amp; exec "__SHQ_NODE__" server.js</string>';

  test('普通路径恒等 —— 不能因为加了转义就让既有安装判成漂移', () => {
    const out = renderTemplate(tpl, { REPO: '/Users/you/code/repo', NODE: '/opt/homebrew/bin/node' });
    assert.match(out, /cd "\/Users\/you\/code\/repo"/);
    assert.match(out, /exec "\/opt\/homebrew\/bin\/node"/);
  });

  test('★ 路径含 $ → 转义掉，不再被 zsh 展开成空', () => {
    const out = renderTemplate(tpl, { REPO: '/Users/x/code/my$proj', NODE: '/n' });
    assert.match(out, /cd "\/Users\/x\/code\/my\\\$proj"/, '$ 必须带上反斜杠');
  });

  test('★ 路径含反引号 → 转义掉，不再被当成命令替换', () => {
    const out = renderTemplate(tpl, { REPO: '/tmp/`whoami`', NODE: '/n' });
    assert.match(out, /\\`whoami\\`/);
  });

  test('路径含双引号与反斜杠也各自转义（否则引号提前闭合）', () => {
    const out = renderTemplate(tpl, { REPO: '/tmp/a"b\\c', NODE: '/n' });
    assert.match(out, /\\"/, '双引号要转义');
    assert.match(out, /\\\\c/, '反斜杠要转义，且必须排在最前面做，否则会把别人加的反斜杠再转一次');
  });

  test('XML 转义仍然照做（两层都要，顺序是先 shell 后 XML）', () => {
    const out = renderTemplate(tpl, { REPO: '/tmp/a&b', NODE: '/n' });
    assert.match(out, /a&amp;b/);
  });

  test('普通 __KEY__ 不做 shell 转义 —— 它们是独立 argv 项，不经 shell', () => {
    const out = renderTemplate('<string>__APP__</string>', { APP: '/Applications/My$App.app' });
    assert.match(out, /My\$App\.app/, '加了反斜杠反而会把路径改坏');
  });

  // ★★ 转义必须与解析成对。渲染侧加了反斜杠，而 parseServerCommand 若只 stripQuotes 不反转义，
  // 解析出的 repo 就比期望值多几个反斜杠 → diffUnitSemantics 判 repo-path 漂移 →
  // doctor D16 恒亮 warn。那等于给这个修复要服务的那批用户换了个新毛病。
  test('★★ 渲染→解析往返：含 shell 元字符的路径不能被判成漂移', () => {
    for (const repo of ['/Users/you/code/my$proj', '/tmp/`whoami`/repo', '/tmp/a"b/repo', '/tmp/a\\b/repo', '/Users/John Doe/code/repo', '/Users/you/code/ccm']) {
      const xml = renderTemplate('<string>cd "__SHQ_REPO__" &amp;&amp; exec "__SHQ_NODE__" server.js</string>',
        { REPO: repo, NODE: '/opt/homebrew/bin/node' });
      const cmd = xml.replace(/<\/?string>/g, '').replace(/&amp;/g, '&');
      const facts = extractUnitFacts('server', {
        Label: 'com.ccm.server',
        ProgramArguments: ['/bin/zsh', '-lc', cmd],
      });
      assert.equal(facts.repo, repo, `往返必须还原：${JSON.stringify(repo)}`);
      assert.equal(facts.node, '/opt/homebrew/bin/node');
      const drift = diffUnitSemantics('server',
        { repo, node: '/opt/homebrew/bin/node', log: null, keepAlive: false, runAtLoad: false, label: 'com.ccm.server' },
        { ...facts, log: null, keepAlive: false, runAtLoad: false, label: 'com.ccm.server' });
      assert.deepEqual(drift, [], `不该漂移：${JSON.stringify(repo)} → ${JSON.stringify(drift)}`);
    }
  });

  test('手写的 plist（没转义、也没引号）照旧解析得出 —— 反转义对它们是恒等的', () => {
    const facts = extractUnitFacts('server', {
      Label: 'com.ccm.server',
      ProgramArguments: ['/bin/zsh', '-lc', 'cd /Users/you/code/repo && exec /opt/homebrew/bin/node server.js'],
    });
    assert.equal(facts.repo, '/Users/you/code/repo');
    assert.equal(facts.node, '/opt/homebrew/bin/node');
  });
});

test.describe('stripLeadingComment', () => {
  test('剥离 <?xml?> 声明后紧跟的说明性注释块', () => {
    const input = '<?xml version="1.0" encoding="UTF-8"?>\n<!--\n  占位符 __LABEL__ ...\n-->\n<plist>\n</plist>\n';
    assert.equal(stripLeadingComment(input), '<?xml version="1.0" encoding="UTF-8"?>\n<plist>\n</plist>\n');
  });

  test('不影响正文里其余的行内注释', () => {
    const input = '<?xml version="1.0"?>\n<!-- 头部 -->\n<array>\n  <!-- 行内注释 -->\n  <string>x</string>\n</array>\n';
    const out = stripLeadingComment(input);
    assert.ok(out.includes('<!-- 行内注释 -->'), '正文行内注释应保留');
    assert.ok(!out.includes('头部'), '头部说明性注释应被剥离');
  });

  test('没有头部注释时原样返回', () => {
    const input = '<?xml version="1.0"?>\n<plist>\n</plist>\n';
    assert.equal(stripLeadingComment(input), input);
  });

  test('renderTemplate 前先 stripLeadingComment，占位符字面量不会污染说明文字残留（因为说明文字已被剥离）', () => {
    const input = '<?xml version="1.0"?>\n<!--\n  __LABEL__ 是标签\n-->\n<string>__LABEL__</string>\n';
    const out = renderTemplate(stripLeadingComment(input), { LABEL: 'com.you.ccm-server' });
    assert.equal(out, '<?xml version="1.0"?>\n<string>com.you.ccm-server</string>\n');
  });
});

test.describe('renderTemplate', () => {
  test('sed 定界符 # 出现在路径里不会破坏替换（曾经 sed -e "s#X#value#" 的坑）', () => {
    const out = renderTemplate('cd "__REPO__"', { REPO: '/Users/you/code/repo#1' });
    assert.equal(out, 'cd "/Users/you/code/repo#1"');
  });

  test('sed 替换特殊字符 & 出现在路径里不会插入匹配串（曾经 sed 替换语义的坑）', () => {
    const out = renderTemplate('cd "__REPO__"', { REPO: '/Users/you/AT&T backup/repo' });
    assert.equal(out, 'cd "/Users/you/AT&amp;T backup/repo"');
  });

  test('路径含空格：模板已加双引号，替换后仍是单个 shell token', () => {
    const out = renderTemplate('cd "__REPO__" &amp;&amp; exec "__NODE__" server.js', {
      REPO: '/Users/John Doe/code/repo',
      NODE: '/opt/homebrew/bin/node',
    });
    assert.equal(out, 'cd "/Users/John Doe/code/repo" &amp;&amp; exec "/opt/homebrew/bin/node" server.js');
  });

  test('多个占位符各自独立替换', () => {
    const out = renderTemplate('__A__-__B__-__A__', { A: '1', B: '2' });
    assert.equal(out, '1-2-1');
  });

  test('XML 元字符替换值生成合法转义（不产出裸 & < >）', () => {
    const out = renderTemplate('<string>__TUNNEL__</string>', { TUNNEL: 'a&b<c>d' });
    assert.equal(out, '<string>a&amp;b&lt;c&gt;d</string>');
    assert.ok(!/&(?!amp;|lt;|gt;)/.test(out), '不应有未转义的裸 &');
  });
});
