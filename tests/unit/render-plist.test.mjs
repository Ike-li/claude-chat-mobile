// tests/unit/render-plist.test.mjs —— scripts/render-plist.js 单测（审计 TC-009）
// 覆盖：XML 转义、字面量占位符替换对 sed 特殊字符（&/#）与空格的免疫、CLI 参数解析。
import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeXml, parseKeyValueArgs, renderTemplate, stripLeadingComment } from '../../scripts/render-plist.js';

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
