// tests/unit/logic-file-links.test.mjs —— 消息里的 href 哪些算「本机文件」
// 样本的形态取自真实 transcript（2026-11-05 统计近 30 天 956 份的链接目标），项目名换成了占位。
import test from 'node:test';
import assert from 'node:assert/strict';
import { lineSpan, parseFileLink } from '../../app/public/js/logic/file-links.js';

const FILE_LINKS = [
  // 裸相对路径：这次事故的形态，相对会话 cwd
  ['demo-video/lesson-one/final/video.mp4', 'demo-video/lesson-one/final/video.mp4', null],
  ['test_tracer.py', 'test_tracer.py', null],
  // 冒号行号：DOMPurify 把 `foo.js:12` 当未知 scheme 剥掉 href，这里必须认得出来
  ['app/public/js/app.js:3801', 'app/public/js/app.js', 3801],
  ['code_visualization.html:140', 'code_visualization.html', 140],
  ['Makefile:12', 'Makefile', 12],
  ['app.js:12-20', 'app.js', 12],
  ['app.js:12:5', 'app.js', 12],
  // #L 行号
  ['web/app.js#L144-L158', 'web/app.js', 144],
  ['console.go#L216', 'console.go', 216],
  ['a.go#L10C3-L12C9', 'a.go', 10],
  // 绝对路径
  ['/Users/you/code/x/api.py#L68', '/Users/you/code/x/api.py', 68],
  ['/private/tmp/claude-501/p/s/scratchpad/1.mp3', '/private/tmp/claude-501/p/s/scratchpad/1.mp3', null],
  // 点开头相对路径、目录
  ['../sibling/tsconfig.json', '../sibling/tsconfig.json', null],
  ['./a.txt', './a.txt', null],
  ['.claude/skills/foo/evals/', '.claude/skills/foo/evals/', null],
  // file://（DOMPurify 同样会剥）
  ['file:///Users/you/a.png', '/Users/you/a.png', null],
  ['file://localhost/Users/you/a.png', '/Users/you/a.png', null],
  // 站点路径认作路径：判不出它不是文件，交给服务端回「找不到」，总好过落到 Cannot GET
  ['/blog/handbook/#card-004', '/blog/handbook/', null],
  // marked 已经 encodeURI 过，不解码的话中文、空格路径全错
  ['docs/%E8%AE%BE%E8%AE%A1.md', 'docs/设计.md', null],
  ['my%20video.mp4:7', 'my video.mp4', 7],
];

const NOT_FILE_LINKS = [
  'https://github.com/x/y/blob/fb5bce2/a.rs#L358-L365',
  'http://example.com:8080',
  'HTTPS://EXAMPLE.COM/a.png',
  'ftp://example.com/a.zip',
  'mailto:a@example.com',
  // 下面三条冒号后全是数字，形态上和 Makefile:12 一样，判成文件就弄坏了电话链接
  'tel:10086',
  'sms:10086',
  'mailto:10086',
  'javascript:alert(1)',
  'data:text/html,hi',
  'vbscript:x',
  'blob:abc',
  '//example.com/a.png',
  '#local_003a36d8-c5b7-4084-960d-73b7b84b5c92',
  '',
  '?x=1',
  null,
  undefined,
];

test('文件链接：解析出路径和行号', () => {
  for (const [href, path, line] of FILE_LINKS) {
    assert.deepEqual(parseFileLink(href), { path, line }, `${href} 应解析成本机文件，否则手机上点了还是打不开`);
  }
});

test('非文件链接：一律不接管，外链和电话照旧', () => {
  for (const href of NOT_FILE_LINKS) {
    assert.equal(parseFileLink(href), null, `${href} 被当成文件后，原本能打开的链接就失效了`);
  }
});

test('残缺的百分号编码不抛错，按原样当路径', () => {
  assert.deepEqual(parseFileLink('a%E4.txt'), { path: 'a%E4.txt', line: null }, '解码抛错会炸掉整条消息的渲染');
});

test('lineSpan：取出第 N 行，还没读到那一行时回 null', () => {
  const lineOf = (text, line) => {
    const span = lineSpan(text, line);
    return span && text.slice(span.start, span.end);
  };
  assert.equal(lineOf('one\ntwo\n\nfour', 1), 'one');
  assert.equal(lineOf('one\ntwo\n\nfour', 2), 'two');
  assert.equal(lineOf('one\ntwo\n\nfour', 3), '');
  assert.equal(lineOf('one\ntwo\n\nfour', 4), 'four');
  assert.equal(lineOf('one\ntwo\n\nfour', 5), null);
  // 截断的文件正好断在行尾时，下一行要等下一页；回空串的话调用方会当成找到了，续页就停了
  assert.equal(lineOf('one\n', 2), null);
  assert.equal(lineOf('one\n', 3), null);
});
